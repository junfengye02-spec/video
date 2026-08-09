from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from server.app.assets.service import MediaAssetRepository, compatible_asset_record
from server.app.continuity_frames import (
    extract_tail_frame,
    invalidate_inherited_frames,
    plan_tail_frame_extraction,
    resolve_continuity,
)
from server.app.media_files import relative_project_path, safe_project_media_file
from server.app.projects.models import ProjectRecord
from server.app.rendering.probe import probe_media
from server.app.storage import WorkbenchStore


@dataclass(frozen=True, slots=True)
class TailFrameBinding:
    asset_id: str
    path: str
    media_sha256: str
    sample_time_seconds: float
    frame_version: int
    reused: bool
    stale_frames: int
    provider_cost_units: int = 0


class TailFrameVersionConflict(ValueError):
    pass


def ensure_shot_tail_frame(
    *,
    db: Session,
    media_store: WorkbenchStore,
    owner_user_id: str,
    project_id: str,
    shot_id: str,
    expected_shot_version: int | None = None,
) -> TailFrameBinding:
    storyboard = media_store.read_artifact(project_id, "episode_storyboard.json")
    series_bible = media_store.read_artifact(project_id, "series_bible.json")
    if not isinstance(storyboard, dict) or not isinstance(series_bible, dict):
        raise ValueError("tail-frame project artifacts are unavailable")
    shots = storyboard.get("shots")
    if not isinstance(shots, list):
        raise ValueError("tail-frame storyboard is unavailable")
    shot_index = next(
        (
            index
            for index, item in enumerate(shots)
            if isinstance(item, dict) and str(item.get("id")) == shot_id
        ),
        None,
    )
    if shot_index is None:
        raise ValueError("tail-frame shot is unavailable")
    shot = shots[shot_index]
    video_version = int(shot.get("version") or 1)
    if expected_shot_version is not None and video_version != expected_shot_version:
        raise TailFrameVersionConflict("tail-frame shot version changed")
    source = safe_project_media_file(
        media_store.project_dir(project_id),
        str(shot.get("output_path") or ""),
    )
    if not source.is_file():
        raise ValueError("tail-frame source video is unavailable")

    output_dir = media_store.project_dir(project_id) / "assets" / "images" / "keyframes"
    plan = plan_tail_frame_extraction(
        video_path=source,
        output_dir=output_dir,
        shot_id=shot_id,
        video_version=video_version,
    )
    project_dir = media_store.project_dir(project_id)
    output_relative = relative_project_path(project_dir, plan.path)
    metadata_relative = relative_project_path(project_dir, plan.metadata_path)
    changed_paths = [
        "artifacts/episode_storyboard.json",
        "artifacts/series_bible.json",
        "artifacts/asset_library.json",
        "artifacts/asset_manifest.json",
        "artifacts/edit_decisions.json",
        "artifacts/generation_plan.json",
        output_relative,
        metadata_relative,
    ]
    journal = media_store.begin_project_mutation(
        project_id,
        operation="tail_frame_extract",
        changed_paths=changed_paths,
    )
    committed = False
    try:
        extraction = extract_tail_frame(
            video_path=source,
            output_dir=output_dir,
            shot_id=shot_id,
            video_version=video_version,
        )
        latest_storyboard = media_store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        latest_series_bible = media_store.read_artifact(project_id, "series_bible.json")
        latest_shots = (
            latest_storyboard.get("shots")
            if isinstance(latest_storyboard, dict)
            else None
        )
        latest_index = next(
            (
                index
                for index, item in enumerate(latest_shots or [])
                if isinstance(item, dict) and str(item.get("id")) == shot_id
            ),
            None,
        )
        if (
            latest_index is None
            or not isinstance(latest_series_bible, dict)
            or int(latest_shots[latest_index].get("version") or 1) != video_version
        ):
            raise TailFrameVersionConflict("tail-frame shot version changed")
        storyboard = latest_storyboard
        series_bible = latest_series_bible
        shots = latest_shots
        shot_index = latest_index
        shot = shots[shot_index]
        repository = MediaAssetRepository(db, media_store)
        asset = repository.create_video_frame(
            owner_user_id=owner_user_id,
            origin_project_id=project_id,
            shot_id=shot_id,
            video_version=video_version,
            media_sha256=extraction.video_sha256,
            sample_time_seconds=extraction.sample_time_seconds,
            storage_path=output_relative,
        )
        stale_frames = repository.mark_video_frames_stale(
            origin_project_id=project_id,
            shot_id=shot_id,
            current_video_version=video_version,
            current_media_sha256=extraction.video_sha256,
        )

        continuity = resolve_continuity(shot)
        previous_tail = continuity.get("last_frame")
        previous_frame_version = (
            int(previous_tail.get("version") or 1)
            if isinstance(previous_tail, dict)
            else 0
        )
        same_tail = (
            isinstance(previous_tail, dict)
            and previous_tail.get("asset_id") == asset.id
        )
        frame_version = previous_frame_version if same_tail else previous_frame_version + 1
        continuity.update(
            {
                "last_frame_asset_id": asset.id,
                "last_frame": {
                    "asset_id": asset.id,
                    "version": max(1, frame_version),
                    "status": "ready",
                    "source": "video_extract",
                },
                "stale": False,
            }
        )
        shot["continuity"] = continuity
        generation_plan = media_store.read_artifact(
            project_id, "generation_plan.json"
        )
        generation_unit = next(
            (
                unit
                for unit in (generation_plan or {}).get("generation_units", [])
                if isinstance(unit, dict)
                and unit.get("shot_ids") == [shot_id]
            ),
            None,
        )
        if isinstance(generation_unit, dict):
            requested_duration = generation_unit.get(
                "requested_duration_seconds"
            )
            if requested_duration is not None:
                shot["requested_duration_seconds"] = requested_duration
            generation_unit["source_duration_seconds"] = extraction.duration_seconds
            generation_unit["timeline_duration_seconds"] = extraction.duration_seconds
        shot["source_duration_seconds"] = extraction.duration_seconds
        shot["timeline_duration_seconds"] = extraction.duration_seconds
        invalidate_inherited_frames(
            shots,
            upstream_shot_id=shot_id,
            upstream_version=video_version,
            upstream_frame_version=max(1, frame_version),
        )
        if shot_index + 1 < len(shots) and isinstance(shots[shot_index + 1], dict):
            next_shot = shots[shot_index + 1]
            next_continuity = resolve_continuity(next_shot)
            if (
                next_continuity.get("mode") == "carry"
                and next_continuity.get("inherit_previous_tail")
                and not next_continuity.get("explicit_user_first_frame_asset_id")
                and not next_continuity.get("inherited_first_frame_asset_id")
            ):
                next_shot["continuity"] = resolve_continuity(next_shot, shot)

        asset_library = media_store.read_asset_library(project_id)
        for record in asset_library:
            provenance = record.get("provenance") if isinstance(record, dict) else None
            if not isinstance(provenance, dict) or provenance.get("shot_id") != shot_id:
                continue
            is_current = (
                provenance.get("video_version") == video_version
                and provenance.get("media_sha256") == extraction.video_sha256
            )
            if record.get("source_type") == "video_frame" and not is_current:
                record["status"] = "stale"
        current_record = compatible_asset_record(
            asset,
            project_id=project_id,
            storage_path=output_relative,
        )
        records_by_id = {
            str(record.get("id")): index
            for index, record in enumerate(asset_library)
            if isinstance(record, dict) and record.get("id")
        }
        existing_index = records_by_id.get(asset.id)
        if existing_index is None:
            asset_library.append(current_record)
        else:
            asset_library[existing_index] = current_record
        series_bible["assets"] = asset_library
        media_store.write_asset_library(project_id, asset_library)
        media_store.write_artifact(project_id, "series_bible.json", series_bible)
        media_store.write_artifact(project_id, "episode_storyboard.json", storyboard)
        _synchronize_video_duration_artifacts(
            media_store=media_store,
            project_id=project_id,
            shot_id=shot_id,
            source_duration_seconds=extraction.duration_seconds,
            requested_duration_seconds=shot.get("requested_duration_seconds"),
        )
        if isinstance(generation_plan, dict):
            generation_plan["timeline_total_duration_seconds"] = sum(
                float(unit.get("timeline_duration_seconds") or 0)
                for unit in generation_plan.get("generation_units", [])
                if isinstance(unit, dict)
            ) or generation_plan.get("timeline_total_duration_seconds")
            media_store.write_artifact(
                project_id, "generation_plan.json", generation_plan
            )
        project = db.get(ProjectRecord, project_id)
        if project is not None:
            project.updated_at = datetime.now(timezone.utc)
        db.commit()
        committed = True
    except BaseException:
        if not committed:
            journal.restore()
        db.rollback()
        raise
    journal.complete()
    return TailFrameBinding(
        asset_id=asset.id,
        path=output_relative,
        media_sha256=extraction.video_sha256,
        sample_time_seconds=extraction.sample_time_seconds,
        frame_version=max(1, frame_version),
        reused=extraction.reused,
        stale_frames=stale_frames,
    )


def _synchronize_video_duration_artifacts(
    *,
    media_store: WorkbenchStore,
    project_id: str,
    shot_id: str,
    source_duration_seconds: float,
    requested_duration_seconds: object,
) -> None:
    asset_manifest = media_store.read_artifact(project_id, "asset_manifest.json")
    if isinstance(asset_manifest, dict):
        asset_id = f"{shot_id}-video"
        for asset in asset_manifest.get("assets", []):
            if not isinstance(asset, dict) or str(asset.get("id")) != asset_id:
                continue
            if requested_duration_seconds is not None:
                asset["requested_duration_seconds"] = requested_duration_seconds
            asset["source_duration_seconds"] = source_duration_seconds
            asset["duration_seconds"] = source_duration_seconds
        media_store.write_artifact(project_id, "asset_manifest.json", asset_manifest)

    edit_decisions = media_store.read_artifact(project_id, "edit_decisions.json")
    if not isinstance(edit_decisions, dict):
        return
    target_cut = None
    for cut in edit_decisions.get("cuts", []):
        if not isinstance(cut, dict):
            continue
        if cut.get("id") == f"cut-{shot_id}" or cut.get("source") == f"{shot_id}-video":
            target_cut = cut
            break
    if target_cut is None:
        return
    if requested_duration_seconds is not None:
        target_cut["requested_duration_seconds"] = requested_duration_seconds
    target_cut["source_duration_seconds"] = source_duration_seconds
    policy = str(target_cut.get("duration_policy") or "full_source")
    if policy in {"explicit_trim", "explicit_retime"}:
        try:
            invalid_window = float(
                target_cut.get("source_out_seconds", target_cut.get("out_seconds", 0))
            ) > source_duration_seconds + 0.001
        except (TypeError, ValueError):
            invalid_window = True
        target_cut["requires_timeline_replan"] = invalid_window
    else:
        legacy_duration = target_cut.get("timeline_duration_seconds")
        target_cut.update(
            {
                "duration_policy": "full_source",
                "in_seconds": 0,
                "out_seconds": source_duration_seconds,
                "source_in_seconds": 0,
                "source_out_seconds": source_duration_seconds,
                "timeline_duration_seconds": source_duration_seconds,
                "speed": 1,
                "requires_timeline_replan": False,
            }
        )
        try:
            if (
                legacy_duration is not None
                and abs(float(legacy_duration) - source_duration_seconds) > 0.001
            ):
                target_cut["timeline_replanned_from_legacy"] = True
        except (TypeError, ValueError):
            target_cut["timeline_replanned_from_legacy"] = True

    cursor = 0.0
    for cut in edit_decisions.get("cuts", []):
        if not isinstance(cut, dict):
            continue
        cut["timeline_start_seconds"] = cursor
        try:
            duration = float(
                cut.get("timeline_duration_seconds")
                or float(cut.get("out_seconds", 0))
                - float(cut.get("in_seconds", 0))
            )
        except (TypeError, ValueError):
            duration = 0
        cursor += max(0, duration)
    if cursor > 0:
        edit_decisions["total_duration_seconds"] = cursor
    media_store.write_artifact(project_id, "edit_decisions.json", edit_decisions)


def synchronize_project_video_durations(
    *,
    media_store: WorkbenchStore,
    project_id: str,
) -> list[str]:
    """Re-probe reusable videos without generating media or touching billing."""
    storyboard = media_store.read_artifact(project_id, "episode_storyboard.json")
    if not isinstance(storyboard, dict):
        return []
    generation_plan = media_store.read_artifact(project_id, "generation_plan.json")
    units = (
        generation_plan.get("generation_units", [])
        if isinstance(generation_plan, dict)
        else []
    )
    changed: list[str] = []
    for shot in storyboard.get("shots", []):
        if (
            not isinstance(shot, dict)
            or shot.get("status") != "complete"
            or not shot.get("output_path")
        ):
            continue
        try:
            source = safe_project_media_file(
                media_store.project_dir(project_id), str(shot["output_path"])
            )
            duration = float(probe_media(source)["duration_seconds"])
        except Exception:
            continue
        shot_id = str(shot.get("id") or "")
        if not shot_id:
            continue
        unit = next(
            (
                item
                for item in units
                if isinstance(item, dict) and item.get("shot_ids") == [shot_id]
            ),
            None,
        )
        requested = (
            unit.get("requested_duration_seconds")
            if isinstance(unit, dict)
            else shot.get("requested_duration_seconds")
        )
        previous = shot.get("source_duration_seconds")
        try:
            already_current = abs(float(previous) - duration) <= 0.001
        except (TypeError, ValueError):
            already_current = False
        shot["source_duration_seconds"] = duration
        shot["timeline_duration_seconds"] = duration
        if requested is not None:
            shot["requested_duration_seconds"] = requested
        if isinstance(unit, dict):
            unit["source_duration_seconds"] = duration
            unit["timeline_duration_seconds"] = duration
        _synchronize_video_duration_artifacts(
            media_store=media_store,
            project_id=project_id,
            shot_id=shot_id,
            source_duration_seconds=duration,
            requested_duration_seconds=requested,
        )
        if not already_current:
            changed.append(shot_id)
    if changed:
        media_store.write_artifact(project_id, "episode_storyboard.json", storyboard)
    if isinstance(generation_plan, dict) and changed:
        total = sum(
            float(unit.get("timeline_duration_seconds") or 0)
            for unit in units
            if isinstance(unit, dict)
        )
        if total > 0:
            generation_plan["timeline_total_duration_seconds"] = total
        media_store.write_artifact(project_id, "generation_plan.json", generation_plan)
    return changed
