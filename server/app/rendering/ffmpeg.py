from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from server.app.rendering.audio import boundary_transition_seconds
from server.app.rendering.models import RenderPlan
from server.app.rendering.remotion import render_remotion_visual
from tools.base_tool import resolve_command_path


class FfmpegRenderError(RuntimeError):
    pass


def render_ffmpeg_visual(plan: RenderPlan, output_path: str | Path) -> dict[str, Any]:
    """Render the pure-video quick path.

    A full FFmpeg build executes dissolve/fade transitions. When the compact
    bundled FFmpeg omits xfade, the existing Remotion renderer preserves the
    declared transitions instead of silently flattening them to cuts.
    """

    ffmpeg = resolve_command_path("ffmpeg")
    if ffmpeg is None:
        raise FfmpegRenderError("ffmpeg is unavailable")
    transitions = boundary_transition_seconds(plan)
    has_transitions = any(duration > 0 for duration in transitions)
    setsar_available = _filter_available(ffmpeg, "setsar")
    setpts_available = _filter_available(ffmpeg, "setpts")
    format_available = _filter_available(ffmpeg, "format")
    remotion_bundled = not setsar_available
    if has_transitions and not _filter_available(ffmpeg, "xfade"):
        # The bundled FFmpeg lacks xfade; preserve declared transitions through the
        # existing Remotion renderer instead of silently flattening them to cuts.
        return render_remotion_visual(plan, output_path)
    if any(
        _clip_needs_letterbox(clip, plan.output.width, plan.output.height)
        for clip in plan.clips
    ) and not _filter_available(ffmpeg, "pad"):
        # The compact bundled FFmpeg has scale but no pad/crop filters. Remotion
        # can contain mismatched sources without stretching or dropping content.
        return render_remotion_visual(plan, output_path)
    if any(clip.duration_policy == "explicit_retime" for clip in plan.clips) and not (
        setpts_available
    ):
        # Explicit retiming requires setpts. The compact Remotion binary omits it,
        # so preserve the requested speed through the existing Remotion renderer.
        return render_remotion_visual(plan, output_path)

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [ffmpeg, "-y"]
    for index, clip in enumerate(plan.clips):
        duration = clip.source_out_seconds - clip.source_in_seconds
        command.extend(["-ss", f"{clip.source_in_seconds:.6f}"])
        if clip.duration_policy != "full_source":
            command.extend(["-t", f"{duration:.6f}"])
        command.extend(["-i", clip.source_path])

    filters: list[str] = []
    labels: list[str] = []
    for index, _clip in enumerate(plan.clips):
        label = f"v{index}"
        filters.append(
            _video_filter(
                index,
                _clip,
                plan,
                label,
                bundled=remotion_bundled,
                setpts_available=setpts_available,
                format_available=format_available,
            )
        )
        labels.append(label)

    current_label = labels[0]
    current_duration = plan.clips[0].timeline_duration_seconds
    for index in range(1, len(labels)):
        transition = transitions[index]
        output_label = f"joined{index}"
        if transition > 0:
            transition_type = plan.clips[index].transition_in.type
            if transition_type == "cut":
                transition_type = plan.clips[index - 1].transition_out.type
            xfade_name = "fadeblack" if transition_type == "fade_through_black" else "fade"
            filters.append(
                f"[{current_label}][{labels[index]}]"
                f"xfade=transition={xfade_name}:duration={transition:.6f}:"
                f"offset={max(0.0, current_duration - transition):.6f}[{output_label}]"
            )
        else:
            filters.append(
                f"[{current_label}][{labels[index]}]concat=n=2:v=1:a=0[{output_label}]"
            )
        current_label = output_label
        current_duration += plan.clips[index].timeline_duration_seconds

    command.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            f"[{current_label}]",
            "-an",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-movflags",
            "+faststart",
            "-t",
            f"{plan.total_duration_seconds:.6f}",
            str(output),
        ]
    )
    _run(command)
    return {"path": str(output), "runtime": "ffmpeg"}


def _clip_needs_letterbox(clip: Any, output_width: int, output_height: int) -> bool:
    source_width = int(getattr(clip, "source_width", 0) or 0)
    source_height = int(getattr(clip, "source_height", 0) or 0)
    if source_width <= 0 or source_height <= 0:
        return True
    source_ratio = source_width / source_height
    output_ratio = output_width / output_height
    return abs(source_ratio - output_ratio) > 0.01


def _video_filter(
    index: int,
    clip: Any,
    plan: RenderPlan,
    label: str,
    *,
    bundled: bool,
    setpts_available: bool | None = None,
    format_available: bool | None = None,
) -> str:
    prefix = f"[{index}:v:0]"
    if setpts_available is None:
        setpts_available = not bundled
    if format_available is None:
        format_available = not bundled
    timing = (
        f"setpts=PTS/{clip.playback_rate:.6f},"
        if clip.duration_policy == "explicit_retime"
        else "setpts=PTS-STARTPTS," if setpts_available else ""
    )
    pixel_format = ",format=yuv420p" if format_available else ""
    width = plan.output.width
    height = plan.output.height
    if _clip_needs_letterbox(clip, width, height):
        return (
            f"{prefix}{timing}scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"setsar=1{pixel_format}[{label}]"
        )
    if bundled:
        return f"{prefix}{timing}scale={width}:{height}{pixel_format}[{label}]"
    return f"{prefix}{timing}scale={width}:{height},setsar=1{pixel_format}[{label}]"


def _filter_available(ffmpeg: str, name: str) -> bool:
    try:
        result = subprocess.run(
            [ffmpeg, "-hide_banner", "-filters"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return any(line.split()[1:2] == [name] for line in result.stdout.splitlines())


def _run(command: list[str]) -> None:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=900,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise FfmpegRenderError("FFmpeg render command failed") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[-3000:]
        raise FfmpegRenderError(f"FFmpeg render failed: {detail}")
