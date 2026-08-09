from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from tools.base_tool import resolve_command_path


class MediaProbeError(RuntimeError):
    pass


def probe_media(path: str | Path, *, require_video: bool = True) -> dict[str, Any]:
    media_path = Path(path)
    if not media_path.is_file() or media_path.stat().st_size <= 0:
        raise MediaProbeError("media file is missing or empty")

    ffprobe = resolve_command_path("ffprobe")
    if ffprobe is None:
        raise MediaProbeError("ffprobe is unavailable")

    try:
        result = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(media_path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
            check=True,
        )
        payload = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        raise MediaProbeError("media could not be probed") from exc

    streams = payload.get("streams") or []
    video_stream = next(
        (stream for stream in streams if stream.get("codec_type") == "video"),
        None,
    )
    audio_stream = next(
        (stream for stream in streams if stream.get("codec_type") == "audio"),
        None,
    )
    if require_video and not isinstance(video_stream, dict):
        raise MediaProbeError("media has no video stream")
    if not isinstance(video_stream, dict) and not isinstance(audio_stream, dict):
        raise MediaProbeError("media has no audio or video stream")

    duration = _positive_float((payload.get("format") or {}).get("duration"))
    if duration is None:
        duration = _positive_float(
            (video_stream or audio_stream or {}).get("duration")
        )
    if duration is None:
        raise MediaProbeError("media duration is unavailable")

    frame_rate = (
        _parse_frame_rate(video_stream.get("avg_frame_rate"))
        if isinstance(video_stream, dict)
        else None
    )
    if frame_rate is None and isinstance(video_stream, dict):
        frame_rate = _parse_frame_rate(video_stream.get("r_frame_rate"))
    return {
        "path": str(media_path),
        "file_size_bytes": media_path.stat().st_size,
        "duration_seconds": duration,
        "has_video": isinstance(video_stream, dict),
        "video_width": int((video_stream or {}).get("width") or 0),
        "video_height": int((video_stream or {}).get("height") or 0),
        "video_codec": str((video_stream or {}).get("codec_name") or ""),
        "fps": frame_rate,
        "has_audio": audio_stream is not None,
        "audio_codec": (
            str(audio_stream.get("codec_name") or "")
            if isinstance(audio_stream, dict)
            else None
        ),
        "audio_channels": (
            int(audio_stream.get("channels") or 0)
            if isinstance(audio_stream, dict)
            else 0
        ),
        "audio_sample_rate": (
            int(audio_stream.get("sample_rate") or 0)
            if isinstance(audio_stream, dict)
            else 0
        ),
    }


def _positive_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _parse_frame_rate(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    numerator, separator, denominator = value.partition("/")
    try:
        if separator:
            denominator_value = float(denominator)
            if denominator_value == 0:
                return None
            parsed = float(numerator) / denominator_value
        else:
            parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None
