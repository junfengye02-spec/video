from __future__ import annotations

import json
import math
import re
import subprocess
from pathlib import Path
from typing import Any

from server.app.rendering.models import RenderPlan, RenderTimedAudioTrack
from tools.base_tool import resolve_command_path


class AudioRenderError(RuntimeError):
    pass


def boundary_transition_seconds(plan: RenderPlan) -> list[float]:
    """Return the transition before each clip, preserving exact timeline length."""

    transitions = [0.0]
    for index in range(1, len(plan.clips)):
        previous = plan.clips[index - 1]
        current = plan.clips[index]
        transition = current.transition_in
        if transition.type == "cut":
            transition = previous.transition_out
        duration = transition.duration_seconds if transition.type != "cut" else 0.0
        transitions.append(
            min(
                max(0.0, duration),
                previous.timeline_duration_seconds,
                current.timeline_duration_seconds,
                current.timeline_start_seconds,
            )
        )
    return transitions


def render_audio_master(plan: RenderPlan, output_path: str | Path) -> dict[str, Any]:
    ffmpeg = resolve_command_path("ffmpeg")
    if ffmpeg is None:
        raise AudioRenderError("ffmpeg is unavailable")

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    transitions = boundary_transition_seconds(plan)
    command = [ffmpeg, "-y"]
    filters: list[str] = []
    labels: list[str] = []
    input_index = 0
    preserved_source_tracks = 0
    ducking_intervals = _voice_intervals(plan)

    for index, clip in enumerate(plan.clips):
        if (
            clip.source_audio.policy not in {"preserve", "mix"}
            or not clip.source_has_audio
            or clip.source_audio.volume <= 0
        ):
            continue
        transition_in = transitions[index]
        transition_out = transitions[index + 1] if index + 1 < len(transitions) else 0.0
        handle_before = clip.source_handle_before_seconds
        handle_after = clip.source_handle_after_seconds
        local_duration = clip.timeline_duration_seconds + handle_before + handle_after
        source_start = clip.source_in_seconds - handle_before
        source_end = min(
            clip.source_duration_seconds,
            clip.source_out_seconds + handle_after,
        )
        timeline_start = max(0.0, clip.timeline_start_seconds - handle_before)
        command.extend(["-i", clip.source_path])
        volume = _volume_expression(
            base=clip.source_audio.volume,
            duration=local_duration,
            fade_in=transition_in,
            fade_out=transition_out,
        )
        label = f"source_audio_{index}"
        filters.append(
            f"[{input_index}:a:0]"
            f"atrim=start={source_start:.6f}:end={source_end:.6f},"
            "asetpts=PTS-STARTPTS,aresample=48000,"
            "aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"apad,atrim=0:{local_duration:.6f},"
            f"volume='{volume}':eval=frame,"
            f"adelay={round(timeline_start * 1000)}|{round(timeline_start * 1000)},"
            f"apad,atrim=0:{plan.total_duration_seconds:.6f}[{label}]"
        )
        labels.append(f"[{label}]")
        input_index += 1
        preserved_source_tracks += 1

    if plan.audio.music is not None:
        music = plan.audio.music
        command.extend(["-stream_loop", "-1", "-i", music.source_path])
        fade_out_start = max(
            music.fade_in_seconds,
            plan.total_duration_seconds - music.fade_out_seconds,
        )
        volume = (
            f"{music.volume:.6f}*"
            f"if(lt(t,{music.fade_in_seconds:.6f}),"
            f"t/{max(music.fade_in_seconds, 0.001):.6f},"
            f"if(gt(t,{fade_out_start:.6f}),"
            f"max(0,({plan.total_duration_seconds:.6f}-t)/"
            f"{max(music.fade_out_seconds, 0.001):.6f}),1))"
        )
        ducking_gain = _ducking_gain_expression(
            music.ducking,
            ducking_intervals,
        )
        if ducking_gain != "1":
            volume += f"*({ducking_gain})"
        label = "music"
        filters.append(
            f"[{input_index}:a:0]"
            f"atrim=start={music.source_in_seconds:.6f},asetpts=PTS-STARTPTS,"
            "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"volume='{volume}':eval=frame,"
            f"apad,atrim=0:{plan.total_duration_seconds:.6f}[{label}]"
        )
        labels.append(f"[{label}]")
        input_index += 1

    for kind, tracks in (
        ("dialogue", plan.audio.dialogue),
        ("narration", plan.audio.narration),
        ("sfx", plan.audio.sfx),
        ("ambience", plan.audio.ambience),
    ):
        for track_index, track in enumerate(tracks):
            command.extend(["-i", track.source_path])
            label = f"{kind}_{track_index}"
            filters.append(
                _timed_track_filter(
                    input_index=input_index,
                    label=label,
                    track=track,
                    total_duration=plan.total_duration_seconds,
                )
            )
            labels.append(f"[{label}]")
            input_index += 1

    if labels:
        mix_label = "audio_mix"
        filters.append(
            f"{''.join(labels)}amix=inputs={len(labels)}:duration=longest:normalize=0,"
            f"apad,atrim=0:{plan.total_duration_seconds:.6f}[{mix_label}]"
        )
    else:
        mix_label = "audio_mix"
        filters.append(
            "anullsrc=channel_layout=stereo:sample_rate=48000,"
            f"atrim=0:{plan.total_duration_seconds:.6f}[{mix_label}]"
        )

    premaster = output.with_name(f".{output.stem}.premaster.wav") if labels else output
    command.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            f"[{mix_label}]",
            "-c:a",
            "pcm_s16le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-t",
            f"{plan.total_duration_seconds:.6f}",
            str(premaster),
        ]
    )
    try:
        _run(command, timeout=600)
        normalization = _normalize_loudness_two_pass(
            ffmpeg=ffmpeg,
            input_path=premaster,
            output_path=output,
            target_lufs=plan.audio.target_lufs,
            true_peak_db=plan.audio.true_peak_db,
            loudness_range_lu=plan.audio.loudness_range_lu,
            duration=plan.total_duration_seconds,
        ) if labels else {"passes": 0, "reason": "silent master"}
    finally:
        if premaster != output:
            premaster.unlink(missing_ok=True)
    return {
        "path": str(output),
        "preserved_source_tracks": preserved_source_tracks,
        "music_tracks": 1 if plan.audio.music is not None else 0,
        "dialogue_tracks": len(plan.audio.dialogue),
        "narration_tracks": len(plan.audio.narration),
        "sfx_tracks": len(plan.audio.sfx),
        "ambience_tracks": len(plan.audio.ambience),
        "ducking_mode": (
            "timeline-envelope"
            if plan.audio.music is not None
            and _ducking_enabled(plan.audio.music.ducking)
            and ducking_intervals
            else "disabled"
        ),
        "loudness_normalization": normalization,
    }


def _voice_intervals(plan: RenderPlan) -> list[tuple[float, float]]:
    intervals = [
        (
            max(0.0, clip.timeline_start_seconds),
            min(
                plan.total_duration_seconds,
                clip.timeline_start_seconds + clip.timeline_duration_seconds,
            ),
        )
        for clip in plan.clips
        if clip.source_has_audio
        and clip.source_audio.policy in {"preserve", "mix"}
        and clip.source_audio.volume > 0
    ]
    for track in [*plan.audio.dialogue, *plan.audio.narration]:
        intervals.append(
            (
                track.timeline_start_seconds,
                min(
                    plan.total_duration_seconds,
                    track.timeline_end_seconds or plan.total_duration_seconds,
                ),
            )
        )
    usable = sorted((start, end) for start, end in intervals if end > start)
    merged: list[tuple[float, float]] = []
    for start, end in usable:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _ducking_enabled(config: bool | dict) -> bool:
    return bool(config.get("enabled", True)) if isinstance(config, dict) else bool(config)


def _ducking_gain_expression(
    config: bool | dict,
    intervals: list[tuple[float, float]],
) -> str:
    if not _ducking_enabled(config) or not intervals:
        return "1"
    options = config if isinstance(config, dict) else {}
    reduction_db = max(0.0, float(options.get("reduction_db", 12)))
    gain = math.pow(10, -reduction_db / 20)
    attack = max(0.001, float(options.get("attack_ms", 120)) / 1000)
    release = max(0.001, float(options.get("release_ms", 350)) / 1000)
    terms = []
    for start, end in intervals:
        attack_start = max(0.0, start - attack)
        terms.append(
            f"if(lt(t,{attack_start:.6f}),1,"
            f"if(lt(t,{start:.6f}),1-(1-{gain:.6f})*"
            f"(t-{attack_start:.6f})/{attack:.6f},"
            f"if(lt(t,{end:.6f}),{gain:.6f},"
            f"if(lt(t,{end + release:.6f}),{gain:.6f}+"
            f"(1-{gain:.6f})*(t-{end:.6f})/{release:.6f},1))))"
        )
    return "*".join(f"({term})" for term in terms)


def _normalize_loudness_two_pass(
    *,
    ffmpeg: str,
    input_path: Path,
    output_path: Path,
    target_lufs: float,
    true_peak_db: float,
    loudness_range_lu: float,
    duration: float,
) -> dict[str, Any]:
    base = (
        f"loudnorm=I={target_lufs:.2f}:TP={true_peak_db:.2f}:"
        f"LRA={loudness_range_lu:.2f}"
    )
    measurement = _run(
        [
            ffmpeg,
            "-hide_banner",
            "-i",
            str(input_path),
            "-af",
            f"{base}:print_format=json",
            "-f",
            "null",
            "-",
        ],
        timeout=600,
    )
    stats = _parse_loudnorm_stats(measurement.stderr or "")
    measured_keys = ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")
    if not all(_finite_number(stats.get(key)) for key in measured_keys):
        raise AudioRenderError("two-pass loudness measurement returned invalid statistics")
    second_pass = (
        f"{base}:measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
        f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:"
        f"offset={stats['target_offset']}:linear=true:print_format=summary,"
        f"apad,atrim=0:{duration:.6f}"
    )
    _run(
        [
            ffmpeg,
            "-y",
            "-i",
            str(input_path),
            "-af",
            second_pass,
            "-c:a",
            "pcm_s16le",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-t",
            f"{duration:.6f}",
            str(output_path),
        ],
        timeout=600,
    )
    return {
        "passes": 2,
        "target_lufs": target_lufs,
        "true_peak_db": true_peak_db,
        "loudness_range_lu": loudness_range_lu,
        "measured": {key: stats[key] for key in measured_keys},
    }


def _parse_loudnorm_stats(stderr: str) -> dict[str, Any]:
    matches = re.findall(r"\{\s*\"input_i\".*?\}", stderr, flags=re.DOTALL)
    if not matches:
        raise AudioRenderError("two-pass loudness measurement produced no JSON statistics")
    try:
        return json.loads(matches[-1])
    except json.JSONDecodeError as exc:
        raise AudioRenderError("two-pass loudness statistics were invalid") from exc


def _finite_number(value: Any) -> bool:
    try:
        return math.isfinite(float(value))
    except (TypeError, ValueError):
        return False


def _timed_track_filter(
    *,
    input_index: int,
    label: str,
    track: RenderTimedAudioTrack,
    total_duration: float,
) -> str:
    duration_filter = ""
    if track.timeline_end_seconds is not None:
        duration = track.timeline_end_seconds - track.timeline_start_seconds
        duration_filter = f",atrim=0:{duration:.6f}"
    delay = round(track.timeline_start_seconds * 1000)
    return (
        f"[{input_index}:a:0]atrim=start={track.source_in_seconds:.6f},"
        "asetpts=PTS-STARTPTS,aresample=48000,"
        "aformat=sample_fmts=fltp:channel_layouts=stereo"
        f"{duration_filter},volume={track.volume:.6f},"
        f"adelay={delay}|{delay},apad,atrim=0:{total_duration:.6f}[{label}]"
    )


def _volume_expression(
    *,
    base: float,
    duration: float,
    fade_in: float,
    fade_out: float,
) -> str:
    expression = f"{base:.6f}"
    if fade_in > 0:
        expression += f"*min(1,max(0,t/{fade_in:.6f}))"
    if fade_out > 0:
        fade_out_start = max(0.0, duration - fade_out)
        expression += (
            f"*if(gt(t,{fade_out_start:.6f}),"
            f"max(0,({duration:.6f}-t)/{fade_out:.6f}),1)"
        )
    return expression


def _run(command: list[str], *, timeout: int) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise AudioRenderError("audio render command failed") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[-2000:]
        raise AudioRenderError(f"audio render failed: {detail}")
    return result
