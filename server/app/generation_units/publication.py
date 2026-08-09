from __future__ import annotations

import hashlib
import re
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from server.app.assets.service import MediaAssetRepository, compatible_asset_record
from server.app.billing.lease import FencedReconciliationClaim
from server.app.billing.models import GenerationJob
from server.app.billing.service import BillingService, InvalidBillingState
from server.app.continuity_frames import extract_tail_frame
from server.app.core.config import get_settings
from server.app.generation_units.models import VideoGenerationUnit
from server.app.generation_units.service import GenerationUnitService
from server.app.media_files import relative_project_path
from server.app.projects.models import ProjectRecord
from server.app.storage import WorkbenchStore
from server.app.tasks.service import TaskService


_UNIT_OPERATION = re.compile(
    r"^generation_unit:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):v([1-9][0-9]*)$"
)


class InvalidGenerationUnitPublication(RuntimeError):
    pass


def generation_unit_billing_operation(unit_id: str, revision: int) -> str:
    operation = f"generation_unit:{unit_id}:v{revision}"
    if _UNIT_OPERATION.fullmatch(operation) is None:
        raise ValueError("generation unit billing operation is invalid")
    return operation


def parse_generation_unit_billing_operation(
    operation: str,
) -> tuple[str, int] | None:
    match = _UNIT_OPERATION.fullmatch(operation)
    if match is None:
        return None
    return match.group(1), int(match.group(2))


def publish_generation_unit_video_result(
    db: Session,
    job_id: str,
    media_store: WorkbenchStore,
    *,
    claim: FencedReconciliationClaim | None = None,
) -> bool:
    job = db.get(GenerationJob, job_id)
    if job is None or job.capability != "video":
        db.rollback()
        raise InvalidBillingState("generation unit publication job is invalid")
    binding = parse_generation_unit_billing_operation(job.operation)
    if binding is None:
        db.rollback()
        raise InvalidBillingState("generation unit publication operation is invalid")
    if job.status != "billed" or not job.result_visible or job.result_locator is None:
        db.rollback()
        return False
    unit_id, revision = binding
    project_id = job.project_id
    user_id = job.user_id
    result_locator = job.result_locator
    expected_model = job.model
    db.commit()

    intent = media_store.read_video_generation_intent(project_id, job_id)
    record = db.get(VideoGenerationUnit, (project_id, unit_id, revision))
    if record is None:
        db.rollback()
        raise InvalidGenerationUnitPublication(
            "generation unit publication ledger entry is unavailable"
        )
    if not _intent_matches(intent, record):
        db.rollback()
        raise InvalidGenerationUnitPublication(
            "generation unit publication intent does not match the ledger"
        )
    if (
        record.billing_job_id not in {None, job_id}
        or record.model_id != expected_model
        or record.task_item_id is None
    ):
        db.rollback()
        raise InvalidGenerationUnitPublication(
            "generation unit publication binding is invalid"
        )
    if (
        record.status == "complete"
        and record.active
        and record.billing_job_id == job_id
        and record.output_path
        and (media_store.project_dir(project_id) / record.output_path).is_file()
    ):
        db.rollback()
        _synchronize_publication_artifacts(media_store, db, record)
        return True
    db.commit()

    staged_path = media_store.staged_video_path(result_locator)
    tail_dir = (
        media_store.project_dir(project_id)
        / "assets"
        / "images"
        / "keyframes"
        / "units"
        / unit_id
    )
    extraction = extract_tail_frame(
        video_path=staged_path,
        output_dir=tail_dir,
        shot_id=unit_id,
        video_version=revision,
    )
    relative_path = f"assets/video/units/{unit_id}/v{revision}.mp4"
    destination = media_store.project_dir(project_id) / relative_path
    media_store.publish_staged_video(
        result_locator,
        destination,
        replace_existing=False,
    )

    project = db.scalar(
        select(ProjectRecord).where(ProjectRecord.id == project_id).with_for_update()
    )
    current_job = db.scalar(
        select(GenerationJob).where(GenerationJob.id == job_id).with_for_update()
    )
    current = db.scalar(
        select(VideoGenerationUnit)
        .where(
            VideoGenerationUnit.project_id == project_id,
            VideoGenerationUnit.id == unit_id,
            VideoGenerationUnit.revision == revision,
        )
        .with_for_update()
    )
    if (
        project is None
        or current_job is None
        or current is None
        or project.owner_user_id != user_id
        or current_job.project_id != project_id
        or current_job.status != "billed"
        or not current_job.result_visible
        or current_job.result_locator != result_locator
        or current.model_id != expected_model
        or current.billing_job_id not in {None, job_id}
        or not _intent_matches(intent, current)
    ):
        db.rollback()
        raise InvalidGenerationUnitPublication(
            "generation unit publication state changed"
        )
    BillingService(
        db,
        get_settings(),
        media_store.inspect_staged_artifact,
    )._require_claim_locked(current_job, claim)

    repository = MediaAssetRepository(db, media_store)
    tail_path = relative_project_path(
        media_store.project_dir(project_id), extraction.path
    )
    tail_asset = repository.create_video_frame(
        owner_user_id=user_id,
        origin_project_id=project_id,
        shot_id=unit_id,
        video_version=revision,
        media_sha256=extraction.video_sha256,
        sample_time_seconds=extraction.sample_time_seconds,
        storage_path=tail_path,
    )
    repository.mark_video_frames_stale(
        origin_project_id=project_id,
        shot_id=unit_id,
        current_video_version=revision,
        current_media_sha256=extraction.video_sha256,
    )
    superseded_ids = {unit_id}
    if current.replaces_unit_id:
        superseded_ids.add(current.replaces_unit_id)
    old_active = list(
        db.scalars(
            select(VideoGenerationUnit)
            .where(
                VideoGenerationUnit.project_id == project_id,
                VideoGenerationUnit.id.in_(superseded_ids),
                VideoGenerationUnit.active.is_(True),
            )
            .with_for_update()
        )
    )
    for old in old_active:
        if (old.id, old.revision) != (unit_id, revision):
            old.active = False

    output_asset_id = _output_asset_id(project_id, unit_id, revision)
    diagnostics = dict(current.diagnostics_json or {})
    diagnostics["tail_frame"] = {
        "asset_id": tail_asset.id,
        "path": tail_path,
        "media_sha256": extraction.video_sha256,
        "sample_time_seconds": extraction.sample_time_seconds,
        "frame_version": revision,
    }
    diagnostics["publication"] = {
        "status": "published",
        "billing_job_id": job_id,
        "result_locator": result_locator,
        "published_at": datetime.now(timezone.utc).isoformat(),
    }
    current.status = "complete"
    current.active = True
    current.billing_job_id = job_id
    current.output_asset_id = output_asset_id
    current.output_path = relative_path
    current.source_duration_seconds = extraction.duration_seconds
    current.timeline_duration_seconds = extraction.duration_seconds
    current.diagnostics_json = diagnostics
    project.updated_at = datetime.now(timezone.utc)
    db.commit()

    _synchronize_tail_asset(
        media_store=media_store,
        project_id=project_id,
        unit=current,
        asset=compatible_asset_record(
            tail_asset,
            project_id=project_id,
            storage_path=tail_path,
        ),
    )
    _synchronize_publication_artifacts(media_store, db, current)
    TaskService(db).release_external_generation_unit_dependencies(
        project_id=project_id,
        previous_generation_unit_id=unit_id,
        previous_generation_unit_revision=revision,
    )
    return True


def _intent_matches(intent: Any, unit: VideoGenerationUnit) -> bool:
    return bool(
        intent.project_id == unit.project_id
        and intent.generation_unit_id == unit.id
        and intent.generation_unit_revision == unit.revision
        and intent.generation_key == unit.execution_key
    )


def _output_asset_id(project_id: str, unit_id: str, revision: int) -> str:
    digest = hashlib.sha256(
        f"{project_id}:{unit_id}:v{revision}".encode("utf-8")
    ).hexdigest()
    return f"unit-video-{digest[:32]}"


def _synchronize_tail_asset(
    *,
    media_store: WorkbenchStore,
    project_id: str,
    unit: VideoGenerationUnit,
    asset: dict[str, Any],
) -> None:
    provenance = dict(asset.get("provenance") or {})
    provenance.update(
        generation_unit_id=unit.id,
        generation_unit_revision=unit.revision,
        source_shot_ids=list(unit.source_shot_ids_json),
        source_beat_ids=list(unit.source_beat_ids_json),
        source_segment_ids=list(unit.source_segment_ids_json or []),
    )
    asset["provenance"] = provenance
    records = media_store.read_asset_library(project_id)
    for record in records:
        current_provenance = (
            record.get("provenance") if isinstance(record, dict) else None
        )
        if (
            isinstance(current_provenance, dict)
            and current_provenance.get("generation_unit_id") == unit.id
            and current_provenance.get("generation_unit_revision") != unit.revision
            and record.get("source_type") == "video_frame"
        ):
            record["status"] = "stale"
    by_id = {
        str(record.get("id")): index
        for index, record in enumerate(records)
        if isinstance(record, dict) and record.get("id")
    }
    if asset["id"] in by_id:
        records[by_id[asset["id"]]] = asset
    else:
        records.append(asset)
    media_store.write_asset_library(project_id, records)
    series_bible = media_store.read_artifact(project_id, "series_bible.json")
    if isinstance(series_bible, dict):
        series_bible["assets"] = records
        media_store.write_artifact(project_id, "series_bible.json", series_bible)


def _synchronize_publication_artifacts(
    media_store: WorkbenchStore,
    db: Session,
    unit: VideoGenerationUnit,
) -> None:
    from server.app.artifact_sync import write_generation_execution_snapshot

    manifest = media_store.read_artifact(unit.project_id, "asset_manifest.json")
    if not isinstance(manifest, dict):
        manifest = {"version": "1.0", "assets": [], "total_cost_usd": 0}
    assets = [
        deepcopy(item) for item in manifest.get("assets", []) if isinstance(item, dict)
    ]
    for item in assets:
        metadata = item.get("metadata")
        if isinstance(metadata, dict) and metadata.get("generation_unit_id") == unit.id:
            metadata["active"] = (
                metadata.get("revision") == unit.revision and unit.active
            )
    record = {
        "id": unit.output_asset_id,
        "type": "video",
        "path": unit.output_path,
        "source_tool": unit.provider,
        "scene_id": unit.id,
        "prompt": "\n".join(
            str(item.get("prompt") or "")
            for item in unit.prompt_segments_json
            if isinstance(item, dict)
        ),
        "model": unit.model_id,
        "cost_usd": 0,
        "requested_duration_seconds": unit.requested_duration_seconds,
        "source_duration_seconds": unit.source_duration_seconds,
        "duration_seconds": unit.source_duration_seconds,
        "format": "mp4",
        "provider": unit.provider,
        "generation_summary": "Generated as one authoritative video generation unit.",
        "metadata": {
            "generation_unit_id": unit.id,
            "source_shot_ids": list(unit.source_shot_ids_json),
            "source_beat_ids": list(unit.source_beat_ids_json),
            "source_segment_ids": list(unit.source_segment_ids_json or []),
            "segment_sequences": [
                int(segment.get("sequence") or index)
                for index, segment in enumerate(unit.prompt_segments_json, start=1)
                if isinstance(segment, dict)
            ],
            "revision": unit.revision,
            "provider": unit.provider,
            "model": unit.model_id,
            "operation": generation_unit_billing_operation(unit.id, unit.revision),
            "active": unit.active,
            "status": unit.status,
        },
    }
    assets = [item for item in assets if item.get("id") != unit.output_asset_id]
    assets.append(record)
    manifest["assets"] = assets
    metadata = dict(manifest.get("metadata") or {})
    metadata["generation_units_v2"] = True
    manifest["metadata"] = metadata
    media_store.write_artifact(unit.project_id, "asset_manifest.json", manifest)
    write_generation_execution_snapshot(
        workbench=media_store,
        snapshot=GenerationUnitService(db).snapshot(unit.project_id),
    )
