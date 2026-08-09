from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from copy import deepcopy
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable, Literal, Mapping, Sequence

from PIL import Image

from server.app.media_files import atomic_write_text, create_atomic_output, replace_atomic_output
from tools.base_tool import resolve_command_path


ContinuityMode = Literal["carry", "cut", "match_cut"]
FrameStatus = Literal["ready", "generating", "failed", "stale"]
FrameSource = Literal["user", "video_extract", "ai_generated", "inherited"]
VideoFrameOperation = Literal[
    "text_to_video",
    "image_to_video",
    "reference_to_video",
    "first_last_frame_to_video",
]

_FRAME_STATUSES = {"ready", "generating", "failed", "stale"}
_FRAME_SOURCES = {"user", "video_extract", "ai_generated", "inherited"}
_CONTINUITY_MODES = {"carry", "cut", "match_cut"}
_SHOT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def normalize_frame_reference(
    value: Any,
    *,
    default_source: FrameSource = "user",
) -> dict[str, Any] | None:
    frame = _as_mapping(value)
    asset_id = frame.get("asset_id")
    if not isinstance(asset_id, str) or not asset_id.strip():
        return None

    source = {"explicit": "user", "generated": "ai_generated"}.get(
        frame.get("source"), frame.get("source")
    )
    status = frame.get("status")
    version = frame.get("version")
    normalized: dict[str, Any] = {
        "asset_id": asset_id.strip(),
        "version": version if isinstance(version, int) and version > 0 else 1,
        "status": status if status in _FRAME_STATUSES else "ready",
        "source": source if source in _FRAME_SOURCES else default_source,
    }
    for key in (
        "generation_job_id",
        "origin_shot_id",
        "origin_shot_version",
        "origin_frame_version",
    ):
        item = frame.get(key)
        if isinstance(item, str) and item.strip():
            normalized[key] = item.strip()
        elif isinstance(item, int) and item > 0:
            normalized[key] = item
    return normalized


def resolve_continuity(
    shot: Mapping[str, Any],
    previous_shot: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    raw = dict(_as_mapping(shot.get("continuity")))
    mode_value = raw.get("mode")
    mode: ContinuityMode = mode_value if mode_value in _CONTINUITY_MODES else "cut"
    inherit = bool(raw.get("inherit_previous_tail"))
    first_frame = normalize_frame_reference(raw.get("first_frame"))
    last_frame = normalize_frame_reference(
        raw.get("last_frame"), default_source="video_extract"
    )
    last_frame_asset_id = _opaque_asset_id(raw.get("last_frame_asset_id"))
    if last_frame is not None:
        last_frame_asset_id = last_frame_asset_id or last_frame["asset_id"]
    elif last_frame_asset_id:
        last_frame = {
            "asset_id": last_frame_asset_id,
            "version": 1,
            "status": "ready",
            "source": "video_extract",
        }
    explicit_asset_id = _opaque_asset_id(
        raw.get("explicit_user_first_frame_asset_id")
    )
    inherited_asset_id = _opaque_asset_id(
        raw.get("inherited_first_frame_asset_id")
    )
    if first_frame is not None:
        if first_frame.get("source") == "inherited":
            inherited_asset_id = inherited_asset_id or first_frame["asset_id"]
        else:
            explicit_asset_id = explicit_asset_id or first_frame["asset_id"]

    if explicit_asset_id:
        if first_frame is None or first_frame.get("asset_id") != explicit_asset_id:
            first_frame = {
                "asset_id": explicit_asset_id,
                "version": 1,
                "status": "ready",
                "source": "user",
            }
        elif first_frame.get("source") == "inherited":
            first_frame["source"] = "user"
    elif mode != "carry" or not inherit:
        first_frame = None
    elif inherited_asset_id:
        if first_frame is None or first_frame.get("asset_id") != inherited_asset_id:
            first_frame = {
                "asset_id": inherited_asset_id,
                "version": 1,
                "status": "ready",
                "source": "inherited",
            }
    else:
        first_frame = None

    if first_frame is None and mode == "carry" and inherit and previous_shot is not None:
        previous_continuity = _as_mapping(previous_shot.get("continuity"))
        previous_tail = normalize_frame_reference(
            previous_continuity.get("last_frame"),
            default_source="video_extract",
        )
        if previous_tail is not None and previous_tail["status"] == "ready":
            previous_id = previous_shot.get("id")
            previous_version = previous_shot.get("version")
            if isinstance(previous_id, str) and previous_id and isinstance(previous_version, int):
                first_frame = {
                    "asset_id": previous_tail["asset_id"],
                    "version": previous_tail["version"],
                    "status": "ready",
                    "source": "inherited",
                    "origin_shot_id": previous_id,
                    "origin_shot_version": previous_version,
                    "origin_frame_version": previous_tail["version"],
                }
                inherited_asset_id = previous_tail["asset_id"]

    resolved = {
        **raw,
        "mode": mode,
        "inherit_previous_tail": inherit,
        "explicit_user_first_frame_asset_id": explicit_asset_id,
        "inherited_first_frame_asset_id": inherited_asset_id,
        "last_frame_asset_id": last_frame_asset_id,
        "first_frame": first_frame,
        "last_frame": last_frame,
        "stale": bool(first_frame and first_frame.get("status") == "stale"),
    }
    return resolved


def _opaque_asset_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def invalidate_inherited_frames(
    shots: list[dict[str, Any]],
    *,
    upstream_shot_id: str,
    upstream_version: int,
    upstream_frame_version: int,
) -> int:
    invalidated = 0
    for shot in shots:
        continuity = dict(_as_mapping(shot.get("continuity")))
        first_frame = normalize_frame_reference(continuity.get("first_frame"))
        if first_frame is None or first_frame.get("source") != "inherited":
            continue
        if first_frame.get("origin_shot_id") != upstream_shot_id:
            continue
        if (
            first_frame.get("origin_shot_version") == upstream_version
            and first_frame.get("origin_frame_version") == upstream_frame_version
        ):
            continue
        first_frame["status"] = "stale"
        continuity["first_frame"] = first_frame
        continuity["stale"] = True
        shot["continuity"] = continuity
        invalidated += 1
    return invalidated


def mark_shot_continuity_stale(
    shots: list[dict[str, Any]],
    *,
    shot_id: str,
) -> int:
    shot = next(
        (item for item in shots if isinstance(item, dict) and str(item.get("id")) == shot_id),
        None,
    )
    if shot is None:
        return 0
    continuity = resolve_continuity(shot)
    last_frame = continuity.get("last_frame")
    if isinstance(last_frame, dict):
        last_frame["status"] = "stale"
        continuity["last_frame"] = last_frame
    continuity["stale"] = bool(last_frame)
    shot["continuity"] = continuity
    current_version = int(shot.get("version") or 1)
    next_frame_version = (
        int(last_frame.get("version") or 1) + 1
        if isinstance(last_frame, dict)
        else 1
    )
    return invalidate_inherited_frames(
        shots,
        upstream_shot_id=shot_id,
        upstream_version=current_version,
        upstream_frame_version=next_frame_version,
    )


def build_continuity_prompt(continuity: Mapping[str, Any] | None) -> str:
    value = _as_mapping(continuity)
    if value.get("mode") != "carry":
        return ""

    labels = (
        ("composition", "Composition"),
        ("subject_pose", "Subject pose"),
        ("gaze", "Gaze"),
        ("motion_direction", "Motion direction"),
        ("lighting", "Lighting"),
        ("scene_state", "Scene state"),
    )
    locks = [
        f"{label}: {value[key]}"
        for key, label in labels
        if isinstance(value.get(key), str) and value[key].strip()
    ]
    if not locks:
        return "Maintain the established subject, scene state, lighting, and screen direction."
    return (
        "Continuity locks: "
        + "; ".join(locks)
        + ". The shot may change framing or camera position, but it must preserve these facts. "
        "Do not reverse the established motion direction."
    )


def _provider_value(provider: Any, key: str, default: Any) -> Any:
    if isinstance(provider, Mapping):
        return provider.get(key, default)
    return getattr(provider, key, default)


def provider_supports_operation(provider: Any, operation: str) -> bool:
    supports = _provider_value(provider, "supports", {})
    if isinstance(supports, Mapping) and supports.get(operation) is True:
        return True

    schema = _provider_value(provider, "input_schema", {})
    properties = _as_mapping(_as_mapping(schema).get("properties"))
    operation_schema = _as_mapping(properties.get("operation"))
    operations = operation_schema.get("enum")
    if isinstance(operations, Sequence) and not isinstance(operations, (str, bytes)):
        return operation in operations
    return False


def resolve_video_frame_operation(
    first_frame: Any,
    last_frame: Any,
    providers: Sequence[Any],
) -> VideoFrameOperation:
    if not first_frame and not last_frame:
        return "text_to_video"
    if first_frame and last_frame and any(
        provider_supports_operation(provider, "first_last_frame_to_video")
        for provider in providers
    ):
        return "first_last_frame_to_video"
    if first_frame and not last_frame and any(
        provider_supports_operation(provider, "image_to_video")
        for provider in providers
    ):
        return "image_to_video"
    if any(
        provider_supports_operation(provider, "reference_to_video")
        for provider in providers
    ):
        return "reference_to_video"
    return "text_to_video"


@dataclass(frozen=True, slots=True)
class TailFrameExtraction:
    path: Path
    metadata_path: Path
    status: Literal["ready"]
    shot_id: str
    video_version: int
    video_sha256: str
    sample_time_seconds: float
    duration_seconds: float
    fps: float
    width: int
    height: int
    backtrack_frames: int
    reused: bool
    provider_cost_units: int = 0


@dataclass(frozen=True, slots=True)
class ShotGenerationFrameRequirements:
    continuity: dict[str, Any]
    first_frame_ready: bool
    last_frame_ready: bool
    regeneration: bool
    requires_previous_tail: bool

    @property
    def regeneration_frames_ready(self) -> bool:
        return self.first_frame_ready and self.last_frame_ready


def resolve_shot_generation_frame_requirements(
    shot: Mapping[str, Any],
    previous_shot: Mapping[str, Any] | None = None,
    *,
    regeneration: bool | None = None,
) -> ShotGenerationFrameRequirements:
    continuity = resolve_continuity(shot)
    first_frame = continuity.get("first_frame")
    last_frame = continuity.get("last_frame")
    first_ready = bool(
        isinstance(first_frame, Mapping) and first_frame.get("status") == "ready"
    )
    last_ready = bool(
        isinstance(last_frame, Mapping) and last_frame.get("status") == "ready"
    )
    is_regeneration = (
        bool(regeneration)
        if regeneration is not None
        else shot.get("status") == "complete"
    )
    explicit_first = bool(continuity.get("explicit_user_first_frame_asset_id"))
    requires_previous = bool(
        not is_regeneration
        and previous_shot is not None
        and continuity.get("mode") == "carry"
        and continuity.get("inherit_previous_tail")
        and not explicit_first
    )
    return ShotGenerationFrameRequirements(
        continuity=continuity,
        first_frame_ready=first_ready,
        last_frame_ready=last_ready,
        regeneration=is_regeneration,
        requires_previous_tail=requires_previous,
    )


@dataclass(frozen=True, slots=True)
class TailFramePlan:
    path: Path
    metadata_path: Path
    video_sha256: str


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def plan_tail_frame_extraction(
    *,
    video_path: str | Path,
    output_dir: str | Path,
    shot_id: str,
    video_version: int,
) -> TailFramePlan:
    source = Path(video_path)
    if not source.is_file():
        raise ValueError("video could not be probed")
    if _SHOT_ID.fullmatch(shot_id) is None or video_version < 1:
        raise ValueError("tail-frame provenance is invalid")
    video_sha256 = _sha256_file(source)
    destination_dir = Path(output_dir)
    output = destination_dir / (
        f"{shot_id}-v{video_version}-{video_sha256[:16]}-tail.png"
    )
    return TailFramePlan(
        path=output,
        metadata_path=output.with_suffix(".json"),
        video_sha256=video_sha256,
    )


def _parse_rate(value: Any) -> float | None:
    if not isinstance(value, str) or not value or value == "0/0":
        return None
    try:
        rate = float(Fraction(value))
    except (ValueError, ZeroDivisionError):
        return None
    return rate if rate > 0 else None


def _probe_frame_source(path: Path) -> dict[str, float | int]:
    ffprobe = resolve_command_path("ffprobe")
    if ffprobe is None:
        raise ValueError("video could not be probed: ffprobe is unavailable")
    process = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
        check=False,
    )
    if process.returncode != 0:
        raise ValueError("video could not be probed")
    try:
        payload = json.loads(process.stdout or "{}")
        stream = next(
            item for item in payload.get("streams", []) if item.get("codec_type") == "video"
        )
        duration = float(stream.get("duration") or payload["format"]["duration"])
        width = int(stream["width"])
        height = int(stream["height"])
    except (KeyError, StopIteration, TypeError, ValueError):
        raise ValueError("video could not be probed") from None
    fps = (
        _parse_rate(stream.get("avg_frame_rate"))
        or _parse_rate(stream.get("r_frame_rate"))
        or 30.0
    )
    if duration <= 0 or width <= 0 or height <= 0:
        raise ValueError("video could not be probed")
    return {
        "duration_seconds": duration,
        "fps": fps,
        "width": width,
        "height": height,
    }


def _is_usable_frame(path: Path, *, width: int, height: int) -> bool:
    try:
        with Image.open(path) as image:
            image.load()
            if image.width != width or image.height != height:
                return False
            grayscale = image.convert("L")
            histogram = grayscale.histogram()
    except Exception:
        return False
    pixels = width * height
    near_black = sum(histogram[:4])
    return pixels > 0 and near_black / pixels < 0.995


def _candidate_sample_times(duration: float, fps: float) -> list[tuple[int, float]]:
    frame_period = 1.0 / fps
    candidates: list[tuple[int, float]] = []
    seen: set[int] = set()
    for backtrack in range(1, 13):
        sample = max(0.0, duration - frame_period * backtrack - 0.001)
        marker = round(sample * 1_000_000)
        if marker not in seen:
            candidates.append((backtrack, sample))
            seen.add(marker)
    for seconds_back in (0.5, 1.0, 2.0, 3.0):
        sample = max(0.0, duration - seconds_back)
        marker = round(sample * 1_000_000)
        if marker not in seen:
            candidates.append((max(1, round(seconds_back * fps)), sample))
            seen.add(marker)
    return candidates


def extract_tail_frame(
    *,
    video_path: str | Path,
    output_dir: str | Path,
    shot_id: str,
    video_version: int,
) -> TailFrameExtraction:
    source = Path(video_path)
    plan = plan_tail_frame_extraction(
        video_path=source,
        output_dir=output_dir,
        shot_id=shot_id,
        video_version=video_version,
    )
    probe = _probe_frame_source(source)
    video_sha256 = plan.video_sha256
    plan.path.parent.mkdir(parents=True, exist_ok=True)
    output = plan.path
    metadata_path = plan.metadata_path

    if output.is_file() and metadata_path.is_file():
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            metadata = {}
        if (
            metadata.get("video_sha256") == video_sha256
            and metadata.get("video_version") == video_version
            and _is_usable_frame(
                output,
                width=int(probe["width"]),
                height=int(probe["height"]),
            )
        ):
            return TailFrameExtraction(
                path=output,
                metadata_path=metadata_path,
                status="ready",
                shot_id=shot_id,
                video_version=video_version,
                video_sha256=video_sha256,
                sample_time_seconds=float(metadata["sample_time_seconds"]),
                duration_seconds=float(probe["duration_seconds"]),
                fps=float(probe["fps"]),
                width=int(probe["width"]),
                height=int(probe["height"]),
                backtrack_frames=int(metadata["backtrack_frames"]),
                reused=True,
            )

    ffmpeg = resolve_command_path("ffmpeg")
    if ffmpeg is None:
        raise ValueError("tail frame could not be extracted: ffmpeg is unavailable")
    descriptor, temporary, expected_parent = create_atomic_output(
        output,
        suffix=".extract.png",
    )
    os.close(descriptor)
    Path(temporary).unlink(missing_ok=True)
    try:
        for backtrack_frames, sample_time in _candidate_sample_times(
            float(probe["duration_seconds"]), float(probe["fps"])
        ):
            process = subprocess.run(
                [
                    ffmpeg,
                    "-y",
                    "-ss",
                    f"{sample_time:.6f}",
                    "-i",
                    str(source),
                    "-frames:v",
                    "1",
                    "-an",
                    str(temporary),
                ],
                capture_output=True,
                timeout=30,
                check=False,
            )
            if process.returncode != 0 or not _is_usable_frame(
                temporary,
                width=int(probe["width"]),
                height=int(probe["height"]),
            ):
                Path(temporary).unlink(missing_ok=True)
                continue
            replace_atomic_output(temporary, output, expected_parent)
            metadata = {
                "version": 1,
                "shot_id": shot_id,
                "video_version": video_version,
                "video_sha256": video_sha256,
                "sample_time_seconds": round(sample_time, 6),
                "duration_seconds": float(probe["duration_seconds"]),
                "fps": float(probe["fps"]),
                "width": int(probe["width"]),
                "height": int(probe["height"]),
                "backtrack_frames": backtrack_frames,
                "status": "ready",
                "provider_cost_units": 0,
            }
            atomic_write_text(
                metadata_path,
                json.dumps(metadata, ensure_ascii=True, indent=2),
                encoding="utf-8",
            )
            return TailFrameExtraction(
                path=output,
                metadata_path=metadata_path,
                status="ready",
                shot_id=shot_id,
                video_version=video_version,
                video_sha256=video_sha256,
                sample_time_seconds=sample_time,
                duration_seconds=float(probe["duration_seconds"]),
                fps=float(probe["fps"]),
                width=int(probe["width"]),
                height=int(probe["height"]),
                backtrack_frames=backtrack_frames,
                reused=False,
            )
    finally:
        Path(temporary).unlink(missing_ok=True)
    raise ValueError("tail frame could not be extracted from a valid non-black frame")


@dataclass(frozen=True, slots=True)
class KeyframeGenerationResult:
    request_key: str
    status: Literal["complete", "failed"]
    references: dict[str, Any]
    quote: Any = None
    error: str | None = None


class KeyframeGenerationCoordinator:
    """Small in-process duplicate guard around an independently quoted image call."""

    def __init__(self) -> None:
        self._results: dict[str, KeyframeGenerationResult] = {}

    @staticmethod
    def request_key(*, shot_id: str, shot_version: int, prompt: str) -> str:
        payload = f"{shot_id}\0{shot_version}\0{prompt}".encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def request(
        self,
        *,
        shot_id: str,
        shot_version: int,
        prompt: str,
        existing: Mapping[str, Any],
        quote: Callable[[], Any],
        generate: Callable[[Any], Mapping[str, Any]],
    ) -> KeyframeGenerationResult:
        key = self.request_key(
            shot_id=shot_id,
            shot_version=shot_version,
            prompt=prompt,
        )
        cached = self._results.get(key)
        if cached is not None:
            return cached

        old_references = deepcopy(dict(existing))
        quoted = quote()
        try:
            generated = deepcopy(dict(generate(quoted)))
        except Exception as exc:
            result = KeyframeGenerationResult(
                request_key=key,
                status="failed",
                references=old_references,
                quote=quoted,
                error=str(exc),
            )
        else:
            result = KeyframeGenerationResult(
                request_key=key,
                status="complete",
                references=generated,
                quote=quoted,
            )
        self._results[key] = result
        return result
