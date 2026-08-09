from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from server.app.rendering.models import (
    RenderAudioPlan,
    RenderClip,
    RenderMusicTrack,
    RenderOutputSpec,
    RenderPlan,
    RenderSourceAudio,
    RenderTimedAudioTrack,
    RenderTransition,
    SourceAudioPolicy,
)
from server.app.rendering.probe import probe_media


class RenderPlanCompileError(RuntimeError):
    pass


MediaProbe = Callable[[str | Path], dict[str, Any]]


def generation_unit_timeline_assets(
    *,
    storyboard: dict[str, Any],
    asset_manifest: dict[str, Any],
) -> list[dict[str, Any]] | None:
    """Return ordered active unit assets, or None for a legacy shot timeline."""
    ordered_shots = sorted(
        (shot for shot in storyboard.get("shots", []) if isinstance(shot, dict)),
        key=lambda shot: int(shot.get("index", 0)),
    )
    shot_ids = [str(shot.get("id") or "") for shot in ordered_shots]
    if not shot_ids or any(not shot_id for shot_id in shot_ids):
        raise RenderPlanCompileError("storyboard has no valid shots")
    positions = {shot_id: index for index, shot_id in enumerate(shot_ids)}
    assets = [
        asset for asset in asset_manifest.get("assets", []) if isinstance(asset, dict)
    ]
    manifest_metadata = asset_manifest.get("metadata")
    unit_mode = bool(
        isinstance(manifest_metadata, dict)
        and manifest_metadata.get("generation_units_v2") is True
    ) or any(
        isinstance(asset.get("metadata"), dict)
        and asset["metadata"].get("generation_unit_id")
        for asset in assets
    )
    if not unit_mode:
        return None

    selected: list[dict[str, Any]] = []
    covered_shots: set[str] = set()
    covered_segments: set[str] = set()
    seen_units: set[str] = set()
    for asset in assets:
        metadata = asset.get("metadata")
        if not isinstance(metadata, dict) or not metadata.get("generation_unit_id"):
            continue
        source_ids = [str(value) for value in metadata.get("source_shot_ids") or []]
        intersecting = [shot_id for shot_id in source_ids if shot_id in positions]
        if not intersecting:
            continue
        if len(intersecting) != len(source_ids):
            raise RenderPlanCompileError(
                "render selection splits an active generation unit"
            )
        if (
            metadata.get("active") is not True
            or metadata.get("status", "complete") != "complete"
        ):
            continue
        unit_id = str(metadata["generation_unit_id"])
        if unit_id in seen_units:
            raise RenderPlanCompileError(
                f"generation unit {unit_id} has more than one active video asset"
            )
        source_segment_ids = [
            str(value) for value in metadata.get("source_segment_ids") or []
        ]
        if source_segment_ids:
            overlap = covered_segments.intersection(source_segment_ids)
            if overlap:
                raise RenderPlanCompileError(
                    "active generation unit assets overlap generation segments"
                )
            covered_segments.update(source_segment_ids)
        else:
            overlap = covered_shots.intersection(source_ids)
            if overlap:
                raise RenderPlanCompileError(
                    "legacy active generation unit assets overlap storyboard shots"
                )
        expected_positions = list(
            range(positions[source_ids[0]], positions[source_ids[0]] + len(source_ids))
        )
        if [positions[shot_id] for shot_id in source_ids] != expected_positions:
            raise RenderPlanCompileError(
                f"generation unit {unit_id} source shots are not ordered and contiguous"
            )
        seen_units.add(unit_id)
        covered_shots.update(source_ids)
        selected.append(asset)

    missing = [shot_id for shot_id in shot_ids if shot_id not in covered_shots]
    if missing:
        raise RenderPlanCompileError(
            f"active generation units do not cover storyboard shot {missing[0]}"
        )
    selected.sort(key=lambda asset: _generation_unit_asset_order(asset, positions))
    return selected


def _generation_unit_asset_order(
    asset: dict[str, Any], positions: dict[str, int]
) -> tuple[int, int, str]:
    metadata = asset.get("metadata") or {}
    source_ids = [str(value) for value in metadata.get("source_shot_ids") or []]
    sequences = [
        int(value)
        for value in metadata.get("segment_sequences") or []
        if isinstance(value, (int, float)) or str(value).isdigit()
    ]
    return (
        positions[source_ids[0]],
        min(sequences) if sequences else 0,
        str(metadata.get("generation_unit_id") or ""),
    )


def compile_render_plan(
    *,
    project_id: str,
    project_dir: str | Path,
    storyboard: dict[str, Any],
    asset_manifest: dict[str, Any],
    edit_decisions: dict[str, Any],
    output: RenderOutputSpec | dict[str, Any],
    media_probe: MediaProbe = probe_media,
) -> RenderPlan:
    project_path = Path(project_dir).resolve()
    assets = {
        str(asset.get("id")): asset
        for asset in asset_manifest.get("assets", [])
        if isinstance(asset, dict) and asset.get("id")
    }
    cuts = [cut for cut in edit_decisions.get("cuts", []) if isinstance(cut, dict)]
    cuts_by_id = {str(cut.get("id")): cut for cut in cuts if cut.get("id")}
    cuts_by_source = {str(cut.get("source")): cut for cut in cuts if cut.get("source")}
    audio_plan = _compile_audio_plan(edit_decisions, assets, project_path)

    ordered_shots = sorted(
        (shot for shot in storyboard.get("shots", []) if isinstance(shot, dict)),
        key=lambda shot: int(shot.get("index", 0)),
    )
    if not ordered_shots:
        raise RenderPlanCompileError("storyboard has no shots")

    unit_assets = generation_unit_timeline_assets(
        storyboard=storyboard,
        asset_manifest=asset_manifest,
    )
    if unit_assets is None:
        primary_sources = [
            {
                "entity_id": str(shot.get("id") or ""),
                "shot_id": str(shot.get("id") or ""),
                "generation_unit_id": None,
                "generation_unit_revision": None,
                "source_shot_ids": [str(shot.get("id") or "")],
                "source_beat_ids": [str(shot.get("beat_id") or shot.get("id") or "")],
                "source_segment_ids": [],
                "shot": shot,
                "asset_id": f"{shot.get('id')}-video",
                "asset": None,
            }
            for shot in ordered_shots
        ]
    else:
        primary_sources = []
        for asset in unit_assets:
            metadata = dict(asset.get("metadata") or {})
            source_ids = [str(value) for value in metadata["source_shot_ids"]]
            primary_sources.append(
                {
                    "entity_id": str(metadata["generation_unit_id"]),
                    "shot_id": source_ids[0],
                    "generation_unit_id": str(metadata["generation_unit_id"]),
                    "generation_unit_revision": int(metadata["revision"]),
                    "source_shot_ids": source_ids,
                    "source_beat_ids": [
                        str(value) for value in metadata.get("source_beat_ids") or []
                    ],
                    "source_segment_ids": [
                        str(value) for value in metadata.get("source_segment_ids") or []
                    ],
                    "shot": {},
                    "asset_id": str(asset.get("id") or ""),
                    "asset": asset,
                }
            )

    compiled_clips: list[RenderClip] = []
    timeline_cursor = 0.0
    for source in primary_sources:
        entity_id = source["entity_id"]
        shot_id = source["shot_id"]
        if not entity_id or not shot_id:
            raise RenderPlanCompileError("primary video source is missing an id")
        asset_id = source["asset_id"]
        cut = cuts_by_id.get(f"cut-{entity_id}") or cuts_by_source.get(asset_id) or {}
        asset = (
            source["asset"]
            or assets.get(str(cut.get("source") or asset_id))
            or assets.get(asset_id)
            or {}
        )
        shot = source["shot"]
        source_path_value = (
            asset.get("path") or shot.get("output_path") or cut.get("source_path")
        )
        if not source_path_value:
            raise RenderPlanCompileError(f"video source {entity_id} has no media path")
        source_path = _resolve_project_path(project_path, source_path_value)
        try:
            media = media_probe(source_path)
        except Exception as exc:
            raise RenderPlanCompileError(
                f"shot {shot_id} media could not be probed"
            ) from exc
        source_duration = _positive_float(media.get("duration_seconds"))
        if source_duration is None:
            raise RenderPlanCompileError(f"shot {shot_id} has no source duration")

        duration_policy = str(cut.get("duration_policy") or "full_source")
        if duration_policy not in {"full_source", "explicit_trim", "explicit_retime"}:
            raise RenderPlanCompileError(
                f"shot {shot_id} has an invalid duration policy"
            )
        if duration_policy == "full_source":
            source_in = 0.0
            source_out = source_duration
            timeline_duration = source_duration
            timeline_start = timeline_cursor
            playback_rate = 1.0
        else:
            timeline_duration = _positive_float(cut.get("timeline_duration_seconds"))
            if timeline_duration is None:
                raise RenderPlanCompileError(
                    f"shot {shot_id} explicit edit has no timeline duration"
                )
            timeline_start = _nonnegative_float(
                cut.get("timeline_start_seconds"), default=timeline_cursor
            )
            source_in = _nonnegative_float(
                cut.get("source_in_seconds", cut.get("in_seconds", 0)),
                default=0,
            )
            explicit_source_out = cut.get("source_out_seconds")
            if explicit_source_out is None and cut.get("in_seconds") is not None:
                explicit_source_out = cut.get("out_seconds")
            source_out = _positive_float(explicit_source_out)
            if source_out is None:
                raise RenderPlanCompileError(
                    f"shot {shot_id} explicit edit has no source out point"
                )
            if source_out > source_duration + 0.001:
                raise RenderPlanCompileError(
                    f"shot {shot_id} source range exceeds available media"
                )
            source_window = source_out - source_in
            if source_window <= 0:
                raise RenderPlanCompileError(
                    f"shot {shot_id} explicit source range is invalid"
                )
            if duration_policy == "explicit_trim":
                if abs(source_window - timeline_duration) > 0.001:
                    raise RenderPlanCompileError(
                        f"shot {shot_id} trim cannot change playback speed"
                    )
                playback_rate = 1.0
            else:
                playback_rate = source_window / timeline_duration
        if source_out > source_duration + 0.001:
            raise RenderPlanCompileError(
                f"shot {shot_id} source range exceeds available media"
            )

        source_audio = _compile_source_audio(cut, audio_plan)
        compiled_clips.append(
            RenderClip(
                id=str(cut.get("id") or f"clip-{shot_id}"),
                shot_id=shot_id,
                generation_unit_id=source["generation_unit_id"],
                generation_unit_revision=source["generation_unit_revision"],
                source_shot_ids=source["source_shot_ids"],
                source_beat_ids=source["source_beat_ids"],
                source_segment_ids=source["source_segment_ids"],
                source_path=str(source_path),
                source_duration_seconds=source_duration,
                source_has_audio=bool(media.get("has_audio")),
                source_width=int(media.get("video_width") or 0),
                source_height=int(media.get("video_height") or 0),
                source_in_seconds=source_in,
                source_out_seconds=source_out,
                timeline_start_seconds=timeline_start,
                timeline_duration_seconds=timeline_duration,
                duration_policy=duration_policy,
                playback_rate=playback_rate,
                transition_in=_compile_transition(
                    cut.get("transition_in"),
                    cut.get("transition_duration"),
                ),
                transition_out=_compile_transition(
                    cut.get("transition_out"),
                    cut.get("transition_duration"),
                ),
                source_audio=source_audio,
            )
        )
        timeline_cursor = max(timeline_cursor, timeline_start + timeline_duration)

    total_duration = max(
        clip.timeline_start_seconds + clip.timeline_duration_seconds
        for clip in compiled_clips
    )
    revision = _storyboard_revision(storyboard)
    return RenderPlan(
        project_id=project_id,
        storyboard_revision=revision,
        total_duration_seconds=total_duration,
        output=(
            output
            if isinstance(output, RenderOutputSpec)
            else RenderOutputSpec.model_validate(output)
        ),
        clips=compiled_clips,
        audio=audio_plan,
        renderer_family=str(
            edit_decisions.get("renderer_family") or "cinematic-trailer"
        ),
        render_runtime=str(edit_decisions.get("render_runtime") or "remotion"),
    )


def _compile_audio_plan(
    edit_decisions: dict[str, Any],
    assets: dict[str, dict[str, Any]],
    project_path: Path,
) -> RenderAudioPlan:
    audio = edit_decisions.get("audio") or {}
    source = audio.get("source") or {}
    default_policy = _audio_policy(source.get("default_policy"), "preserve")
    music_config = audio.get("music") or edit_decisions.get("music") or {}
    music = None
    music_asset_id = music_config.get("asset_id")
    music_source = music_config.get("source_path")
    if music_asset_id:
        asset = assets.get(str(music_asset_id))
        if not asset or not asset.get("path"):
            raise RenderPlanCompileError("music asset could not be resolved")
        music_source = asset["path"]
    if music_source:
        music = RenderMusicTrack(
            source_path=str(_resolve_project_path(project_path, music_source)),
            volume=float(music_config.get("volume", 0.15)),
            source_in_seconds=float(music_config.get("source_in_seconds", 0)),
            fade_in_seconds=float(music_config.get("fade_in_seconds", 0.3)),
            fade_out_seconds=float(music_config.get("fade_out_seconds", 0.8)),
            ducking=music_config.get("ducking", True),
        )
    dialogue = _compile_timed_audio_tracks(
        _audio_segment_entries(audio.get("dialogue")),
        assets,
        project_path,
        kind="dialogue",
    )
    narration = _compile_timed_audio_tracks(
        _audio_segment_entries(audio.get("narration")),
        assets,
        project_path,
        kind="narration",
    )
    sfx = _compile_timed_audio_tracks(
        _audio_segment_entries(audio.get("sfx")),
        assets,
        project_path,
        kind="sfx",
    )
    ambience = _compile_timed_audio_tracks(
        _audio_segment_entries(audio.get("ambience")),
        assets,
        project_path,
        kind="ambience",
    )
    return RenderAudioPlan(
        source_audio_default=default_policy,
        source_audio_volume=float(source.get("default_volume", 1.0)),
        source_audio_transition_seconds=float(source.get("transition_seconds", 0.08)),
        music=music,
        dialogue=dialogue,
        narration=narration,
        sfx=sfx,
        ambience=ambience,
        target_lufs=float(audio.get("target_lufs", -14)),
        true_peak_db=float(audio.get("true_peak_db", -1.5)),
        loudness_range_lu=float(audio.get("loudness_range_lu", 11)),
    )


def _audio_segment_entries(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        segments = value.get("segments")
        return segments if isinstance(segments, list) else []
    return []


def _compile_timed_audio_tracks(
    entries: list[Any],
    assets: dict[str, dict[str, Any]],
    project_path: Path,
    *,
    kind: str,
) -> list[RenderTimedAudioTrack]:
    tracks: list[RenderTimedAudioTrack] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        asset_id = entry.get("asset_id")
        source_path_value = entry.get("source_path")
        if asset_id:
            asset = assets.get(str(asset_id))
            if not asset or not asset.get("path"):
                raise RenderPlanCompileError(
                    f"{kind} asset {asset_id} could not be resolved"
                )
            source_path_value = asset["path"]
        if not source_path_value:
            raise RenderPlanCompileError(f"{kind} track has no source")
        source_path = _resolve_project_path(project_path, source_path_value)
        start_seconds = _nonnegative_float(
            entry.get("timeline_start_seconds", entry.get("start_seconds")),
            default=0,
        )
        raw_end = entry.get("timeline_end_seconds", entry.get("end_seconds"))
        end_seconds = _positive_float(raw_end) if raw_end is not None else None
        tracks.append(
            RenderTimedAudioTrack(
                id=str(entry.get("id") or asset_id or f"{kind}-{index + 1}"),
                source_path=str(source_path),
                timeline_start_seconds=start_seconds,
                timeline_end_seconds=end_seconds,
                source_in_seconds=_nonnegative_float(
                    entry.get("source_in_seconds"),
                    default=0,
                ),
                volume=float(entry.get("volume", 1.0)),
            )
        )
    return tracks


def _compile_source_audio(
    cut: dict[str, Any], audio_plan: RenderAudioPlan
) -> RenderSourceAudio:
    source_audio = cut.get("source_audio") or {}
    policy = _audio_policy(
        source_audio.get("policy") or cut.get("source_audio_policy"),
        audio_plan.source_audio_default,
    )
    return RenderSourceAudio(
        policy=policy,
        volume=float(source_audio.get("volume", audio_plan.source_audio_volume)),
    )


def _compile_transition(value: Any, duration: Any) -> RenderTransition:
    normalized = str(value or "cut").strip().lower().replace("-", "_")
    if normalized in {"fade", "dissolve", "crossfade"}:
        transition_type = "dissolve"
    elif normalized in {"fadeblack", "fade_through_black", "black"}:
        transition_type = "fade_through_black"
    else:
        transition_type = "cut"
    transition_duration = _nonnegative_float(duration, default=0.0)
    return RenderTransition(
        type=transition_type,
        duration_seconds=transition_duration if transition_type != "cut" else 0,
    )


def _audio_policy(value: Any, default: SourceAudioPolicy) -> SourceAudioPolicy:
    normalized = str(value or default).strip().lower()
    if normalized not in {"preserve", "mix", "replace", "mute"}:
        raise RenderPlanCompileError("source audio policy is invalid")
    return normalized  # type: ignore[return-value]


def _resolve_project_path(project_path: Path, value: Any) -> Path:
    candidate = Path(str(value))
    if not candidate.is_absolute():
        candidate = project_path / candidate
    resolved = candidate.resolve()
    if resolved != project_path and project_path not in resolved.parents:
        raise RenderPlanCompileError("media path escapes the project workspace")
    if not resolved.is_file():
        raise RenderPlanCompileError("media source is missing")
    return resolved


def _storyboard_revision(storyboard: dict[str, Any]) -> str:
    canonical = json.dumps(
        storyboard,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _positive_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _nonnegative_float(value: Any, *, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default
