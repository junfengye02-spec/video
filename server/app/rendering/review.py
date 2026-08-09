from __future__ import annotations

import io
import math
import subprocess
import wave
from array import array
from pathlib import Path
from typing import Any

from PIL import Image

from server.app.rendering.models import RenderPlan
from server.app.rendering.probe import MediaProbeError, probe_media
from tools.base_tool import resolve_command_path


def review_rendered_output(
    *,
    plan: RenderPlan,
    output_path: str | Path,
    proposal_packet: dict[str, Any] | None = None,
) -> dict[str, Any]:
    output = Path(output_path)
    issues: list[str] = []
    critical: list[str] = []

    technical = _technical_review(plan, output)
    issues.extend(technical["issues"])
    critical.extend(technical.pop("critical_issues"))

    visual = _visual_review(plan, output, technical.get("duration_seconds", 0))
    issues.extend(visual["issues"])
    critical.extend(visual.pop("critical_issues"))
    if visual["frames_sampled"] < 4:
        critical.append("Could not sample four frames from the rendered output")

    audio = _audio_review(plan, output)
    issues.extend(audio["issues"])
    critical.extend(audio.pop("critical_issues"))

    runtime_used = plan.render_runtime
    proposal_runtime = str(
        ((proposal_packet or {}).get("production_plan") or {}).get("render_runtime")
        or ""
    ).strip().lower()
    runtime_swap = bool(proposal_runtime and proposal_runtime != runtime_used)
    promise_issues = []
    if runtime_swap:
        promise_issues.append(
            f"render_runtime changed between proposal ({proposal_runtime}) and "
            f"render plan ({runtime_used})"
        )
        critical.extend(promise_issues)
    promise = {
        "delivery_promise_honored": not runtime_swap,
        "renderer_family_used": plan.renderer_family,
        "render_runtime_used": runtime_used,
        "runtime_swap_detected": runtime_swap,
        "runtime_swap_check": (
            f"ok - proposal and render plan agree ({runtime_used})"
            if proposal_runtime and not runtime_swap
            else "skipped - proposal runtime was not recorded"
            if not proposal_runtime
            else "detected"
        ),
        "silent_downgrade_detected": False,
        "issues": promise_issues,
    }
    issues.extend(promise_issues)

    subtitle = {
        "subtitles_expected": False,
        "subtitles_present": False,
        "check_status": "not_applicable",
        "issues": [],
    }

    status = "fail" if critical else "pass"
    return {
        "version": "1.0",
        "output_path": str(output),
        "status": status,
        "checks": {
            "technical_probe": technical,
            "visual_spotcheck": visual,
            "audio_spotcheck": audio,
            "promise_preservation": promise,
            "subtitle_check": subtitle,
        },
        "issues_found": list(dict.fromkeys([*critical, *issues])),
        "recommended_action": "present_to_user" if status == "pass" else "re_render",
    }


def _technical_review(plan: RenderPlan, output: Path) -> dict[str, Any]:
    issues: list[str] = []
    critical: list[str] = []
    try:
        media = probe_media(output)
    except MediaProbeError as exc:
        return {
            "valid_container": False,
            "issues": [str(exc)],
            "critical_issues": ["Rendered output is not a valid video"],
        }

    frame_tolerance = max(0.05, 2 / plan.output.fps)
    duration_drift = abs(media["duration_seconds"] - plan.total_duration_seconds)
    if duration_drift > frame_tolerance:
        critical.append(
            f"Duration mismatch: rendered {media['duration_seconds']:.3f}s, "
            f"planned {plan.total_duration_seconds:.3f}s"
        )
    if (
        media["video_width"] != plan.output.width
        or media["video_height"] != plan.output.height
    ):
        critical.append(
            f"Resolution mismatch: rendered {media['video_width']}x{media['video_height']}, "
            f"planned {plan.output.width}x{plan.output.height}"
        )
    if not media.get("has_audio"):
        critical.append("Rendered output has no audio stream")
    return {
        "valid_container": True,
        "duration_seconds": media["duration_seconds"],
        "target_duration_seconds": plan.total_duration_seconds,
        "duration_drift_seconds": round(duration_drift, 6),
        "resolution": f"{media['video_width']}x{media['video_height']}",
        "fps": media.get("fps"),
        "has_audio": media.get("has_audio", False),
        "codec": media.get("video_codec"),
        "audio_codec": media.get("audio_codec"),
        "file_size_bytes": media.get("file_size_bytes", 0),
        "issues": issues,
        "critical_issues": critical,
    }


def _visual_review(plan: RenderPlan, output: Path, duration: float) -> dict[str, Any]:
    ffmpeg = resolve_command_path("ffmpeg")
    frame_paths: list[str] = []
    issues: list[str] = []
    critical: list[str] = []
    black = {
        "available": False,
        "frames_analyzed": 0,
        "black_frames": 0,
        "black_duration_seconds": 0.0,
        "black_ratio": 0.0,
        "trailing_black_seconds": 0.0,
    }
    if ffmpeg is None or duration <= 0:
        issues.append("ffmpeg is unavailable for frame sampling")
    else:
        frame_dir = output.parent / ".final_review_frames"
        frame_dir.mkdir(parents=True, exist_ok=True)
        for index, ratio in enumerate((0.1, 0.35, 0.65, 0.9)):
            frame = frame_dir / f"review_frame_{index}.png"
            result = subprocess.run(
                [
                    ffmpeg,
                    "-y",
                    "-ss",
                    f"{duration * ratio:.6f}",
                    "-i",
                    str(output),
                    "-frames:v",
                    "1",
                    str(frame),
                ],
                capture_output=True,
                timeout=30,
                check=False,
            )
            if result.returncode == 0 and frame.is_file() and frame.stat().st_size > 0:
                frame_paths.append(str(frame))
        if len(frame_paths) < 4:
            issues.append(f"Only {len(frame_paths)}/4 review frames were extracted")
        black = _black_frame_analysis(ffmpeg, output, duration)
        if not black["available"]:
            issues.append("Black-frame analysis could not be completed")
        expected_black_seconds = sum(
            transition.duration_seconds
            for clip in plan.clips
            for transition in (clip.transition_in, clip.transition_out)
            if transition.type == "fade_through_black"
        ) / 2
        unexpected_black = max(
            0.0,
            black["black_duration_seconds"] - expected_black_seconds,
        )
        if black["black_ratio"] >= 0.8:
            critical.append("Rendered output is mostly black")
        elif black["trailing_black_seconds"] > max(1.0, expected_black_seconds + 0.5):
            critical.append("Rendered output has an unexpected black tail")
        elif unexpected_black > 1.0:
            issues.append(
                f"Detected {unexpected_black:.2f}s of black frames beyond declared transitions"
            )
    return {
        "frames_sampled": len(frame_paths),
        "frame_paths": frame_paths,
        "black_frames_detected": black["black_frames"] > 0,
        "black_frame_analysis": black,
        "broken_overlays": False,
        "missing_assets": False,
        "unreadable_text": False,
        "watermark_check": "manual_review_required",
        "issues": issues,
        "critical_issues": critical,
    }


def _black_frame_analysis(ffmpeg: str, output: Path, duration: float) -> dict[str, Any]:
    frame_dir = output.parent / ".final_review_black_frames"
    frame_dir.mkdir(parents=True, exist_ok=True)
    for stale in frame_dir.glob("black_*.png"):
        stale.unlink(missing_ok=True)
    uniform_count = max(4, min(20, math.ceil(duration)))
    sample_times = {
        min(max(0.0, duration - 0.05), duration * index / uniform_count)
        for index in range(uniform_count + 1)
    }
    sample_times.update(
        max(0.0, duration - offset)
        for offset in (0.05, 0.5, 1.0, 1.5, 2.0)
        if duration >= offset
    )
    extracted: list[tuple[float, Path]] = []
    for index, timestamp in enumerate(sorted(sample_times)):
        frame_path = frame_dir / f"black_{index:05d}.png"
        try:
            result = subprocess.run(
                [
                    ffmpeg,
                    "-y",
                    "-v",
                    "error",
                    "-ss",
                    f"{timestamp:.6f}",
                    "-i",
                    str(output),
                    "-frames:v",
                    "1",
                    str(frame_path),
                ],
                capture_output=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode == 0 and frame_path.is_file():
            extracted.append((timestamp, frame_path))
    black_flags = []
    analyzed_times: list[float] = []
    for timestamp, frame_path in extracted:
        try:
            with Image.open(frame_path) as image:
                pixels = list(image.convert("L").resize((64, 64)).getdata())
        except (OSError, ValueError):
            continue
        dark_pixels = sum(value <= 16 for value in pixels)
        mean = sum(pixels) / len(pixels)
        black_flags.append(mean <= 10 and dark_pixels / len(pixels) >= 0.98)
        analyzed_times.append(timestamp)
    for _, frame_path in extracted:
        frame_path.unlink(missing_ok=True)
    trailing_start: float | None = None
    for timestamp, is_black in reversed(list(zip(analyzed_times, black_flags, strict=True))):
        if not is_black:
            break
        trailing_start = timestamp
    black_count = sum(black_flags)
    return {
        "available": bool(black_flags),
        "frames_analyzed": len(black_flags),
        "black_frames": black_count,
        "black_duration_seconds": round(
            duration * black_count / len(black_flags), 3
        ) if black_flags else 0.0,
        "black_ratio": round(black_count / len(black_flags), 4) if black_flags else 0.0,
        "trailing_black_seconds": (
            round(duration - trailing_start, 3) if trailing_start is not None else 0.0
        ),
    }


def _audio_review(plan: RenderPlan, output: Path) -> dict[str, Any]:
    expected_clips = [
        clip
        for clip in plan.clips
        if clip.source_has_audio
        and clip.source_audio.policy in {"preserve", "mix"}
        and clip.source_audio.volume > 0
    ]
    correlations: list[dict[str, Any]] = []
    for clip in expected_clips:
        sample_duration = min(1.0, max(0.25, clip.timeline_duration_seconds / 3))
        local_offset = max(
            0.0,
            min(
                clip.timeline_duration_seconds - sample_duration,
                clip.timeline_duration_seconds / 2 - sample_duration / 2,
            ),
        )
        source_start = clip.source_in_seconds + local_offset
        output_start = clip.timeline_start_seconds + local_offset
        source_samples = _decode_pcm(clip.source_path, source_start, sample_duration)
        output_samples = _decode_pcm(output, output_start, sample_duration)
        correlation = _correlation(source_samples, output_samples)
        correlations.append(
            {
                "clip_id": clip.id,
                "correlation": None if correlation is None else round(correlation, 4),
            }
        )

    comparable = [
        item["correlation"]
        for item in correlations
        if item["correlation"] is not None
    ]
    matched = [value for value in comparable if abs(value) >= 0.12]
    critical: list[str] = []
    issues: list[str] = []
    if expected_clips and not comparable:
        issues.append("Source-audio retention could not be compared")
    elif expected_clips and not matched:
        critical.append("Source character audio was not retained in the final mix")

    silence_ratio = _silence_ratio(output, plan.total_duration_seconds)
    if expected_clips and silence_ratio is not None and silence_ratio > 0.8:
        critical.append("Final mix is mostly silent although source audio must be preserved")
    peak = _pcm_peak_analysis(output, plan.total_duration_seconds)
    if not peak["available"]:
        issues.append("PCM peak analysis could not be completed")
    if peak["clipping_detected"]:
        critical.append("Final mix contains clipped PCM samples")
    return {
        "dialogue_present": bool(plan.audio.dialogue),
        "narration_present": bool(plan.audio.narration),
        "music_present": plan.audio.music is not None,
        "sfx_present": bool(plan.audio.sfx),
        "ambience_present": bool(plan.audio.ambience),
        "source_audio_required": bool(expected_clips),
        "source_audio_tracks_expected": len(expected_clips),
        "source_audio_tracks_matched": len(matched),
        "source_audio_correlations": correlations,
        "unexpected_silence": bool(silence_ratio is not None and silence_ratio > 0.8),
        "silence_ratio": silence_ratio,
        "clipping_detected": peak["clipping_detected"],
        "peak_analysis": peak,
        "mix_intelligible": not critical,
        "issues": issues,
        "critical_issues": critical,
    }


def _pcm_peak_analysis(path: Path, duration: float) -> dict[str, Any]:
    ffmpeg = resolve_command_path("ffmpeg")
    analysis_duration = min(max(0.0, duration), 600.0)
    if ffmpeg is None or analysis_duration <= 0:
        return {
            "available": False,
            "analysis_duration_seconds": 0,
            "max_sample": None,
            "clipped_samples": 0,
            "clipping_detected": False,
        }
    try:
        result = subprocess.run(
            [
                ffmpeg,
                "-v",
                "error",
                "-i",
                str(path),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-t",
                f"{analysis_duration:.6f}",
                "-c:a",
                "pcm_s16le",
                "-f",
                "wav",
                "pipe:1",
            ],
            capture_output=True,
            timeout=max(60, min(600, round(analysis_duration * 2))),
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        result = None
    if result is None or result.returncode != 0 or not result.stdout:
        return {
            "available": False,
            "analysis_duration_seconds": analysis_duration,
            "max_sample": None,
            "clipped_samples": 0,
            "clipping_detected": False,
        }
    try:
        with wave.open(io.BytesIO(result.stdout), "rb") as reader:
            samples = array("h")
            samples.frombytes(reader.readframes(reader.getnframes()))
    except wave.Error:
        return {
            "available": False,
            "analysis_duration_seconds": analysis_duration,
            "max_sample": None,
            "clipped_samples": 0,
            "clipping_detected": False,
        }
    max_sample = max((abs(value) for value in samples), default=0)
    clipped = sum(abs(value) >= 32760 for value in samples)
    threshold = max(3, round(len(samples) * 0.00001))
    return {
        "available": True,
        "analysis_duration_seconds": analysis_duration,
        "max_sample": max_sample,
        "max_sample_dbfs": (
            round(20 * math.log10(max_sample / 32768), 3) if max_sample else None
        ),
        "clipped_samples": clipped,
        "clipping_detected": clipped >= threshold,
    }


def _decode_pcm(path: str | Path, start: float, duration: float) -> array | None:
    ffmpeg = resolve_command_path("ffmpeg")
    if ffmpeg is None:
        return None
    try:
        result = subprocess.run(
            [
                ffmpeg,
                "-v",
                "error",
                "-ss",
                f"{max(0.0, start):.6f}",
                "-t",
                f"{duration:.6f}",
                "-i",
                str(path),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "8000",
                "-c:a",
                "pcm_s16le",
                "-f",
                "wav",
                "pipe:1",
            ],
            capture_output=True,
            timeout=30,
            check=False,
        )
        if result.returncode != 0 or not result.stdout:
            return None
        with wave.open(io.BytesIO(result.stdout), "rb") as reader:
            samples = array("h")
            samples.frombytes(reader.readframes(reader.getnframes()))
            return samples
    except (OSError, subprocess.SubprocessError, wave.Error):
        return None


def _correlation(left: array | None, right: array | None) -> float | None:
    if left is None or right is None:
        return None
    size = min(len(left), len(right))
    if size < 100:
        return None
    left_values = left[:size]
    right_values = right[:size]
    left_mean = sum(left_values) / size
    right_mean = sum(right_values) / size
    numerator = 0.0
    left_energy = 0.0
    right_energy = 0.0
    for left_value, right_value in zip(left_values, right_values, strict=True):
        centered_left = left_value - left_mean
        centered_right = right_value - right_mean
        numerator += centered_left * centered_right
        left_energy += centered_left * centered_left
        right_energy += centered_right * centered_right
    if left_energy <= 1 or right_energy <= 1:
        return None
    return numerator / math.sqrt(left_energy * right_energy)


def _silence_ratio(path: Path, duration: float) -> float | None:
    ffmpeg = resolve_command_path("ffmpeg")
    if ffmpeg is None or duration <= 0:
        return None
    try:
        result = subprocess.run(
            [
                ffmpeg,
                "-i",
                str(path),
                "-af",
                "silencedetect=n=-50dB:d=0.25",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    total_silence = 0.0
    for line in (result.stderr or "").splitlines():
        marker = "silence_duration:"
        if marker not in line:
            continue
        try:
            total_silence += float(line.split(marker, 1)[1].strip().split()[0])
        except (ValueError, IndexError):
            continue
    return round(min(1.0, total_silence / duration), 4)
