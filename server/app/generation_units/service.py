from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from server.app.billing.models import GenerationJob
from server.app.generation_units.models import VideoGenerationUnit
from server.app.generation_units.repository import GenerationUnitRepository
from server.app.generation_units.schemas import (
    GenerationExecutionSnapshot,
    GenerationExecutionUnit,
)
from server.app.rendering.probe import MediaProbeError, probe_media
from server.app.tasks.models import TaskBatch, TaskItem
from server.app.video_model_profiles import (
    GenerationPlan,
    GenerationUnit,
    VideoOperation,
    operation_for_shot,
    video_model_profile,
)


class GenerationUnitLedgerError(ValueError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def legacy_video_assets_by_shot(
    asset_manifest: Mapping[str, Any] | None,
    storyboard: Mapping[str, Any],
) -> dict[str, dict[str, Any]]:
    """Resolve legacy manifest video assets to their storyboard shot IDs.

    Older projects stored generated videos only in ``asset_manifest.json`` and
    left ``episode_storyboard.json`` output fields empty.  The exact
    ``shot_<n>-video`` identifier is authoritative; scene matching is only
    used when it identifies one unambiguous shot.
    """
    assets = asset_manifest.get("assets", []) if isinstance(asset_manifest, Mapping) else []
    shots = [
        shot
        for shot in storyboard.get("shots", [])
        if isinstance(shot, Mapping) and shot.get("id")
    ]
    shot_ids = {str(shot["id"]) for shot in shots}
    by_shot: dict[str, dict[str, Any]] = {}
    scene_candidates: dict[str, list[str]] = {}
    for shot in shots:
        scene_id = str(shot.get("scene_id") or "").strip()
        if scene_id:
            scene_candidates.setdefault(scene_id, []).append(str(shot["id"]))

    for value in assets:
        if not isinstance(value, Mapping) or value.get("type") != "video":
            continue
        path = str(value.get("path") or "").strip()
        if not path:
            continue
        asset = dict(value)
        asset_id = str(asset.get("id") or "").strip()
        exact_shot_id = (
            asset_id[:-6]
            if asset_id.endswith("-video") and asset_id[:-6] in shot_ids
            else None
        )
        metadata = asset.get("metadata")
        metadata_shot_ids = (
            [str(item) for item in metadata.get("source_shot_ids", []) if str(item) in shot_ids]
            if isinstance(metadata, Mapping) and isinstance(metadata.get("source_shot_ids"), list)
            else []
        )
        candidate_ids = [exact_shot_id] if exact_shot_id else metadata_shot_ids
        if not candidate_ids:
            scene_id = str(asset.get("scene_id") or "").strip()
            scene_ids = scene_candidates.get(scene_id, [])
            if len(scene_ids) == 1:
                candidate_ids = scene_ids
        if len(candidate_ids) != 1:
            continue
        by_shot.setdefault(candidate_ids[0], asset)
    return by_shot


class GenerationUnitService:
    def __init__(self, db: Session):
        self.db = db
        self.repository = GenerationUnitRepository(db)

    def protected_units(
        self,
        *,
        project_id: str,
        storyboard: Mapping[str, Any],
        selected_shot_ids: Sequence[str] | None = None,
        allow_stale_unit_ids: Sequence[str] = (),
    ) -> list[dict[str, Any]]:
        shots, positions = _storyboard_index(storyboard)
        records = self.repository.list_protected(project_id)
        allow_stale = {str(unit_id) for unit_id in allow_stale_unit_ids}
        in_flight_replacements = {
            record.replaces_unit_id
            for record in records
            if record.status in {"queued", "running", "waiting_provider"}
            and record.replaces_unit_id
        }
        selected_scope = (
            {str(shot_id) for shot_id in selected_shot_ids}
            if selected_shot_ids is not None
            else set(shots)
        )
        selected: list[VideoGenerationUnit] = []
        for record in records:
            source_ids = {str(value) for value in record.source_shot_ids_json}
            if source_ids.isdisjoint(selected_scope):
                continue
            if not source_ids.issubset(selected_scope):
                raise GenerationUnitLedgerError(
                    "generation_unit_selection_partial",
                    "Selected shots split an existing generation unit",
                    {
                        "generation_unit_id": record.id,
                        "source_shot_ids": list(record.source_shot_ids_json),
                    },
                )
            selected.append(record)
        selected = [
            record
            for record in selected
            if not (
                record.status == "complete"
                and record.active
                and record.id in in_flight_replacements
            )
            and (record.status != "complete" or record.active)
        ]
        payloads: list[dict[str, Any]] = []
        covered_segments: set[str] = set()
        for record in sorted(
            selected,
            key=lambda item: (
                positions.get(str(item.source_shot_ids_json[0]), 10**9),
                item.created_at,
                item.id,
                item.revision,
            ),
        ):
            self._validate_record_mapping(
                record,
                shots=shots,
                positions=positions,
                allow_stale=record.id in allow_stale,
            )
            segment_ids = _record_segment_ids(record)
            overlap = covered_segments.intersection(segment_ids)
            if overlap:
                raise GenerationUnitLedgerError(
                    "generation_unit_mapping_conflict",
                    "Protected generation units overlap on generation segments",
                    {"source_segment_ids": sorted(overlap)},
                )
            covered_segments.update(segment_ids)
            payloads.append(self.planner_payload(record))
        return payloads

    def active_units(
        self,
        *,
        project_id: str,
        storyboard: Mapping[str, Any] | None = None,
    ) -> list[VideoGenerationUnit]:
        records = self.repository.list_active(project_id)
        if storyboard is None:
            return records
        shots, positions = _storyboard_index(storyboard)
        covered_segments: set[str] = set()
        for record in records:
            self._validate_record_mapping(record, shots=shots, positions=positions)
            segment_ids = _record_segment_ids(record)
            overlap = covered_segments.intersection(segment_ids)
            if overlap:
                raise GenerationUnitLedgerError(
                    "generation_unit_mapping_conflict",
                    "Active generation units overlap on generation segments",
                    {"source_segment_ids": sorted(overlap)},
                )
            covered_segments.update(segment_ids)
        return records

    def stage_plan_units(
        self,
        *,
        project_id: str,
        plan: GenerationPlan,
        generation_unit_ids: Sequence[str],
        storyboard: Mapping[str, Any],
    ) -> list[VideoGenerationUnit]:
        shots, positions = _storyboard_index(storyboard)
        units_by_id = {
            unit.id: unit for unit in plan.generation_units if unit.status == "planned"
        }
        selected: list[GenerationUnit] = []
        for unit_id in generation_unit_ids:
            unit = units_by_id.get(unit_id)
            if unit is None:
                raise GenerationUnitLedgerError(
                    "generation_plan_selection_invalid",
                    "Generation unit selection does not match the plan",
                    {"generation_unit_id": unit_id},
                )
            selected.append(unit)
        expected = [
            unit.id for unit in plan.generation_units if unit.status == "planned"
        ]
        if list(generation_unit_ids) != expected:
            raise GenerationUnitLedgerError(
                "generation_plan_selection_invalid",
                "Generation unit selection must exactly match pending plan units",
                {"expected_generation_unit_ids": expected},
            )

        records: list[VideoGenerationUnit] = []
        for unit in selected:
            source_versions = {
                shot_id: _positive_int(shots[shot_id].get("version"), 1)
                for shot_id in unit.source_shot_ids
            }
            record = VideoGenerationUnit(
                project_id=project_id,
                id=unit.id,
                revision=unit.revision,
                plan_id=plan.id,
                status="planned",
                active=False,
                source_shot_ids_json=list(unit.source_shot_ids),
                source_shot_versions_json=source_versions,
                source_beat_ids_json=list(unit.source_beat_ids),
                source_segment_ids_json=list(unit.source_segment_ids),
                prompt_segments_json=[
                    segment.model_dump(mode="json") for segment in unit.prompt_segments
                ],
                provider=unit.provider,
                model_id=unit.model_id,
                operation=unit.operation,
                profile_revision=unit.profile.profile_revision,
                profile_json=unit.profile.model_dump(mode="json"),
                requested_duration_seconds=unit.requested_duration_seconds,
                source_duration_seconds=unit.source_duration_seconds,
                timeline_duration_seconds=unit.timeline_duration_seconds,
                output_asset_id=unit.output_asset_id,
                output_path=unit.output_path,
                task_item_id=None,
                billing_job_id=unit.billing_job_id,
                replaces_unit_id=unit.replaces_unit_id,
                execution_key=execution_key(
                    project_id,
                    unit.id,
                    unit.revision,
                    model_id=unit.model_id,
                    operation=unit.operation,
                ),
                diagnostics_json={},
            )
            self._validate_record_mapping(record, shots=shots, positions=positions)
            self.repository.add(record)
            records.append(record)
        return records

    def attach_task_items(
        self,
        *,
        project_id: str,
        task_items: Sequence[TaskItem],
    ) -> list[VideoGenerationUnit]:
        records: list[VideoGenerationUnit] = []
        for item in task_items:
            if (
                item.target_entity_type != "generation_unit"
                or item.target_entity_id is None
                or item.target_entity_version is None
            ):
                continue
            record = self.repository.get(
                project_id,
                item.target_entity_id,
                item.target_entity_version,
            )
            if record is None:
                raise GenerationUnitLedgerError(
                    "generation_unit_ledger_missing",
                    "Queued task does not have a generation unit ledger record",
                    {"task_item_id": item.id},
                )
            if record.execution_key != item.generation_key:
                raise GenerationUnitLedgerError(
                    "generation_unit_execution_key_mismatch",
                    "Task generation key does not match the ledger revision",
                    {"task_item_id": item.id, "generation_unit_id": record.id},
                )
            if record.task_item_id not in {None, item.id}:
                raise GenerationUnitLedgerError(
                    "generation_unit_task_conflict",
                    "Generation unit revision is already bound to another task",
                    {"generation_unit_id": record.id},
                )
            record.task_item_id = item.id
            record.status = (
                item.status
                if item.status
                in {
                    "queued",
                    "running",
                    "waiting_provider",
                    "complete",
                    "failed",
                }
                else "queued"
            )
            record.billing_job_id = item.billing_job_id
            records.append(record)
        self.db.flush()
        return records

    def backfill_legacy_shots(
        self,
        *,
        project_id: str,
        storyboard: Mapping[str, Any],
        project_dir: str | Path,
        asset_manifest: Mapping[str, Any] | None = None,
        include_storyboard_outputs: bool = True,
    ) -> list[VideoGenerationUnit]:
        shots, _positions = _storyboard_index(storyboard)
        project_path = Path(project_dir).resolve(strict=False)
        manifest_assets = legacy_video_assets_by_shot(asset_manifest, storyboard)
        existing_records = self.repository.list_project(project_id)
        represented_shots = {
            str(shot_id)
            for record in existing_records
            for shot_id in record.source_shot_ids_json
            if record.active and record.status == "complete"
        }
        legacy_shot_ids = {
            str(record.legacy_source_shot_id)
            for record in existing_records
            if record.legacy_source_shot_id
        }
        created: list[VideoGenerationUnit] = []
        plan_id = _sha256({"kind": "legacy_backfill", "project_id": project_id})
        for shot_id, shot in sorted(
            shots.items(),
            key=lambda item: (_positive_int(item[1].get("index"), 0), item[0]),
        ):
            manifest_asset = manifest_assets.get(shot_id, {})
            storyboard_path = (
                str(shot.get("output_path") or "").strip()
                if include_storyboard_outputs
                else ""
            )
            manifest_path = str(manifest_asset.get("path") or "").strip()
            output_path = storyboard_path or (
                manifest_path
                if _legacy_media_exists(project_path, manifest_path)
                else ""
            )
            if not output_path:
                continue
            if output_path != manifest_path:
                manifest_asset = {}
            if shot_id in legacy_shot_ids or shot_id in represented_shots:
                continue
            recovered = self._recover_legacy_execution(
                project_id=project_id,
                shot_id=shot_id,
                output_path=output_path,
            )
            operation = recovered["operation"] or operation_for_shot(shot)
            provider = (
                recovered["provider"]
                or str(manifest_asset.get("provider") or "").strip()
                or "legacy_unknown"
            )
            model_id = (
                recovered["model_id"]
                or str(manifest_asset.get("model") or "").strip()
                or "legacy_unknown"
            )
            profile = video_model_profile(
                model_id,
                operation,
                provider=provider,
                db=self.db,
            )
            duration, probe_diagnostic = _probe_legacy_duration(
                project_path=project_path,
                output_path=output_path,
            )
            manifest_duration = _positive_float(
                manifest_asset.get("source_duration_seconds")
                or manifest_asset.get("duration_seconds")
            )
            if duration is None and manifest_duration is not None:
                duration = manifest_duration
                probe_diagnostic = {
                    **probe_diagnostic,
                    "manifest_duration_seconds": manifest_duration,
                    "status": "manifest_fallback",
                }
            requested_duration = (
                recovered["requested_duration_seconds"]
                or _positive_float(manifest_asset.get("requested_duration_seconds"))
                or manifest_duration
            )
            unit_id = (
                "legacy-"
                + _sha256(
                    {
                        "project_id": project_id,
                        "shot_id": shot_id,
                        "output_path": output_path,
                    }
                )[:24]
            )
            record = VideoGenerationUnit(
                project_id=project_id,
                id=unit_id,
                revision=1,
                plan_id=plan_id,
                status="complete",
                active=True,
                source_shot_ids_json=[shot_id],
                source_shot_versions_json={
                    shot_id: _positive_int(shot.get("version"), 1)
                },
                source_beat_ids_json=[str(shot.get("beat_id") or shot_id)],
                source_segment_ids_json=[f"legacy-segment-{unit_id}"],
                prompt_segments_json=[
                    {
                        "shot_id": shot_id,
                        "beat_id": str(shot.get("beat_id") or shot_id),
                        "prompt": str(shot.get("prompt") or shot.get("beat") or ""),
                        "recommended_duration_seconds": shot.get(
                            "recommended_duration_seconds"
                        ),
                        "transition": "cut",
                    }
                ],
                provider=provider,
                model_id=model_id,
                operation=operation,
                profile_revision=profile.profile_revision,
                profile_json=profile.model_dump(mode="json"),
                requested_duration_seconds=requested_duration,
                source_duration_seconds=duration,
                timeline_duration_seconds=duration,
                output_asset_id=(
                    str(manifest_asset.get("id") or "").strip() or None
                ),
                output_path=output_path,
                task_item_id=recovered["task_item_id"],
                billing_job_id=recovered["billing_job_id"],
                replaces_unit_id=None,
                legacy_source_shot_id=shot_id,
                execution_key=execution_key(project_id, unit_id, 1),
                diagnostics_json={
                    "legacy_backfill": True,
                    "manifest_asset_id": str(manifest_asset.get("id") or "") or None,
                    "duration_probe": probe_diagnostic,
                    "execution_recovery": recovered["diagnostic"],
                },
            )
            self.repository.add(record)
            created.append(record)
        if created:
            self.db.flush()
        return created

    def snapshot(self, project_id: str) -> GenerationExecutionSnapshot:
        records = self.repository.list_project(project_id)
        updated_at = max(
            (_utc_datetime(record.updated_at) for record in records),
            default=datetime.now(timezone.utc),
        )
        return GenerationExecutionSnapshot(
            project_id=project_id,
            updated_at=updated_at,
            active_generation_unit_ids=[
                record.id for record in records if record.active
            ],
            generation_units=[self.execution_unit(record) for record in records],
        )

    def import_snapshot(
        self,
        *,
        project_id: str,
        snapshot: GenerationExecutionSnapshot,
        storyboard: Mapping[str, Any],
    ) -> list[VideoGenerationUnit]:
        if self.repository.count_project(project_id) > 0:
            raise GenerationUnitLedgerError(
                "generation_execution_import_conflict",
                "Project already has an execution ledger",
            )
        shots, positions = _storyboard_index(storyboard)
        active_unit_ids = set(snapshot.active_generation_unit_ids)
        inferred_active_keys = {
            (
                unit_id,
                max(
                    unit.revision
                    for unit in snapshot.generation_units
                    if unit.id == unit_id
                ),
            )
            for unit_id in active_unit_ids
            if any(unit.id == unit_id for unit in snapshot.generation_units)
        }
        created: list[VideoGenerationUnit] = []
        for imported in snapshot.generation_units:
            status = imported.status
            active = (
                imported.active
                if imported.active is not None
                else (imported.id, imported.revision) in inferred_active_keys
            )
            diagnostics = dict(imported.diagnostics)
            fallback_profile = video_model_profile(
                imported.model_id,
                imported.operation,
                provider=imported.provider,
                db=self.db,
            )
            profile = (
                dict(imported.profile)
                if imported.profile is not None
                else fallback_profile.model_dump(mode="json")
            )
            profile_revision = (
                imported.profile_revision
                or str(profile.get("profile_revision") or "")
                or fallback_profile.profile_revision
            )
            if status in {"planned", "queued", "running", "waiting_provider"}:
                status = "stale"
                active = False
                diagnostics["import_recovery"] = {
                    "status": "stale",
                    "code": "runtime_binding_not_imported",
                    "message": (
                        "Active provider/task state is not portable between server projects"
                    ),
                }
            record = VideoGenerationUnit(
                project_id=project_id,
                id=imported.id,
                revision=imported.revision,
                plan_id=imported.plan_id,
                status=status,
                active=active and status == "complete",
                source_shot_ids_json=list(imported.source_shot_ids),
                source_shot_versions_json=dict(imported.source_shot_versions),
                source_beat_ids_json=list(imported.source_beat_ids),
                source_segment_ids_json=list(imported.source_segment_ids),
                prompt_segments_json=list(imported.prompt_segments),
                provider=imported.provider,
                model_id=imported.model_id,
                operation=imported.operation,
                profile_revision=profile_revision,
                profile_json=profile,
                requested_duration_seconds=imported.requested_duration_seconds,
                source_duration_seconds=imported.source_duration_seconds,
                timeline_duration_seconds=imported.timeline_duration_seconds,
                output_asset_id=imported.output_asset_id,
                output_path=imported.output_path,
                task_item_id=None,
                billing_job_id=None,
                replaces_unit_id=imported.replaces_unit_id,
                legacy_source_shot_id=(
                    imported.source_shot_ids[0]
                    if imported.id.startswith("legacy-")
                    and len(imported.source_shot_ids) == 1
                    else None
                ),
                execution_key=execution_key(project_id, imported.id, imported.revision),
                diagnostics_json=diagnostics,
            )
            self._validate_record_mapping(record, shots=shots, positions=positions)
            self.repository.add(record)
            created.append(record)
        if created:
            self.db.flush()
        return created

    @staticmethod
    def execution_unit(record: VideoGenerationUnit) -> GenerationExecutionUnit:
        return GenerationExecutionUnit(
            id=record.id,
            plan_id=record.plan_id,
            revision=record.revision,
            status=record.status,
            active=record.active,
            source_shot_ids=list(record.source_shot_ids_json),
            source_shot_versions=dict(record.source_shot_versions_json),
            source_beat_ids=list(record.source_beat_ids_json),
            source_segment_ids=list(record.source_segment_ids_json or []),
            prompt_segments=list(record.prompt_segments_json),
            provider=record.provider,
            model_id=record.model_id,
            operation=record.operation,
            profile_revision=record.profile_revision,
            profile=dict(record.profile_json),
            requested_duration_seconds=record.requested_duration_seconds,
            source_duration_seconds=record.source_duration_seconds,
            timeline_duration_seconds=record.timeline_duration_seconds,
            output_asset_id=record.output_asset_id,
            output_path=record.output_path,
            task_item_id=record.task_item_id,
            billing_job_id=record.billing_job_id,
            replaces_unit_id=record.replaces_unit_id,
            diagnostics=dict(record.diagnostics_json or {}),
            created_at=record.created_at,
            updated_at=record.updated_at,
        )

    @staticmethod
    def planner_payload(record: VideoGenerationUnit) -> dict[str, Any]:
        return {
            "id": record.id,
            "revision": record.revision,
            "status": record.status,
            "source_shot_ids": list(record.source_shot_ids_json),
            "source_shot_versions": dict(record.source_shot_versions_json),
            "source_beat_ids": list(record.source_beat_ids_json),
            "source_segment_ids": list(record.source_segment_ids_json or []),
            "prompt_segments": list(record.prompt_segments_json),
            "provider": record.provider,
            "model_id": record.model_id,
            "operation": record.operation,
            "requested_duration_seconds": record.requested_duration_seconds,
            "source_duration_seconds": record.source_duration_seconds,
            "timeline_duration_seconds": record.timeline_duration_seconds,
            "output_asset_id": record.output_asset_id,
            "output_path": record.output_path,
            "billing_job_id": record.billing_job_id,
            "task_item_id": record.task_item_id,
            "replaces_unit_id": record.replaces_unit_id,
            "profile": dict(record.profile_json),
        }

    def _validate_record_mapping(
        self,
        record: VideoGenerationUnit,
        *,
        shots: Mapping[str, Mapping[str, Any]],
        positions: Mapping[str, int],
        allow_stale: bool = False,
    ) -> None:
        source_ids = [str(value) for value in record.source_shot_ids_json]
        if not source_ids or len(source_ids) != len(set(source_ids)):
            raise GenerationUnitLedgerError(
                "generation_unit_mapping_invalid",
                "Generation unit source shots must be non-empty and unique",
                {"generation_unit_id": record.id},
            )
        if any(shot_id not in shots for shot_id in source_ids):
            raise GenerationUnitLedgerError(
                "generation_unit_source_missing",
                "Generation unit references unavailable storyboard shots",
                {"generation_unit_id": record.id},
            )
        indexes = [positions[shot_id] for shot_id in source_ids]
        if indexes != list(range(indexes[0], indexes[0] + len(indexes))):
            raise GenerationUnitLedgerError(
                "generation_unit_mapping_invalid",
                "Generation unit source shots must be consecutive and ordered",
                {"generation_unit_id": record.id},
            )
        episodes = {shots[shot_id].get("episode_number") for shot_id in source_ids}
        if len(episodes) != 1:
            raise GenerationUnitLedgerError(
                "generation_unit_mapping_invalid",
                "Generation unit cannot cross episode boundaries",
                {"generation_unit_id": record.id},
            )
        versions = {
            str(key): _positive_int(value, 0)
            for key, value in record.source_shot_versions_json.items()
        }
        if set(versions) != set(source_ids):
            raise GenerationUnitLedgerError(
                "generation_unit_source_versions_invalid",
                "Generation unit source versions must cover every source shot",
                {"generation_unit_id": record.id},
            )
        stale = [
            shot_id
            for shot_id in source_ids
            if versions[shot_id] != _positive_int(shots[shot_id].get("version"), 1)
        ]
        if stale and not allow_stale:
            raise GenerationUnitLedgerError(
                "generation_unit_source_version_stale",
                "Generation unit references stale storyboard shot versions",
                {"generation_unit_id": record.id, "shot_ids": stale},
            )
        segment_ids = [str(value) for value in record.source_segment_ids_json or []]
        if segment_ids and len(segment_ids) != len(set(segment_ids)):
            raise GenerationUnitLedgerError(
                "generation_unit_segment_mapping_invalid",
                "Generation unit source segments must be unique",
                {"generation_unit_id": record.id},
            )

    def _recover_legacy_execution(
        self,
        *,
        project_id: str,
        shot_id: str,
        output_path: str,
    ) -> dict[str, Any]:
        rows = list(
            self.db.execute(
                select(TaskItem, TaskBatch)
                .join(TaskBatch, TaskBatch.id == TaskItem.batch_id)
                .where(
                    TaskBatch.project_id == project_id,
                    TaskItem.target_entity_type == "shot_video",
                    TaskItem.target_entity_id == shot_id,
                    TaskItem.status == "complete",
                )
                .order_by(TaskItem.updated_at.desc(), TaskItem.id.desc())
            )
        )
        item = next(
            (
                candidate
                for candidate, _batch in rows
                if _result_path_matches(candidate.result_snapshot, output_path)
            ),
            None,
        )
        generation_unit = (
            item.input_snapshot.get("generation_unit")
            if item is not None and isinstance(item.input_snapshot, dict)
            else None
        )
        generation_unit = (
            generation_unit if isinstance(generation_unit, Mapping) else {}
        )
        result = (
            item.result_snapshot
            if item is not None and isinstance(item.result_snapshot, dict)
            else {}
        )
        billing_job_id = (
            item.billing_job_id or result.get("billing_job_id")
            if item is not None
            else None
        )
        job = self.db.get(GenerationJob, billing_job_id) if billing_job_id else None
        if job is None and item is not None:
            job = self.db.scalar(
                select(GenerationJob)
                .where(
                    GenerationJob.project_id == project_id,
                    GenerationJob.operation == f"shot:{shot_id}",
                    GenerationJob.status == "billed",
                    GenerationJob.result_visible.is_(True),
                )
                .order_by(GenerationJob.updated_at.desc(), GenerationJob.id.desc())
            )
            billing_job_id = job.id if job is not None else billing_job_id
        model_id = (
            (item.model if item is not None and item.model else None)
            or generation_unit.get("model_id")
            or (job.model if job is not None else None)
        )
        operation = _operation_or_none(
            result.get("operation") or generation_unit.get("operation")
        )
        requested_duration = _positive_float(
            generation_unit.get("requested_duration_seconds")
        )
        return {
            "provider": generation_unit.get("provider"),
            "model_id": model_id,
            "operation": operation,
            "requested_duration_seconds": requested_duration,
            "task_item_id": item.id if item is not None else None,
            "billing_job_id": billing_job_id,
            "diagnostic": {
                "status": "recovered" if model_id else "unavailable",
                "task_item_id": item.id if item is not None else None,
                "billing_job_id": billing_job_id,
            },
        }


def execution_key(
    project_id: str,
    unit_id: str,
    revision: int,
    *,
    model_id: str | None = None,
    operation: str | None = None,
) -> str:
    payload: dict[str, Any] = {
        "project_id": project_id,
        "generation_unit_id": unit_id,
        "revision": revision,
    }
    if model_id is not None or operation is not None:
        if not model_id or not operation:
            raise ValueError(
                "generation unit execution key requires model and operation"
            )
        payload.update(model_id=model_id, operation=operation)
    return _sha256(payload)


def _record_segment_ids(record: VideoGenerationUnit) -> list[str]:
    values = [str(value) for value in record.source_segment_ids_json or []]
    if values:
        return values
    return [
        f"legacy:{record.id}:v{record.revision}:{shot_id}"
        for shot_id in record.source_shot_ids_json
    ]


def _storyboard_index(
    storyboard: Mapping[str, Any],
) -> tuple[dict[str, Mapping[str, Any]], dict[str, int]]:
    raw = storyboard.get("shots")
    if not isinstance(raw, list):
        raise GenerationUnitLedgerError(
            "storyboard_invalid", "Storyboard shots must be an array"
        )
    ordered = sorted(
        [shot for shot in raw if isinstance(shot, Mapping) and shot.get("id")],
        key=lambda shot: (
            _positive_int(shot.get("episode_number"), 0),
            _positive_int(shot.get("index"), 0),
            str(shot.get("id")),
        ),
    )
    shots = {str(shot["id"]): shot for shot in ordered}
    if len(shots) != len(ordered):
        raise GenerationUnitLedgerError(
            "storyboard_invalid", "Storyboard shot IDs must be unique"
        )
    return shots, {shot_id: index for index, shot_id in enumerate(shots)}


def _probe_legacy_duration(
    *, project_path: Path, output_path: str
) -> tuple[float | None, dict[str, Any]]:
    if output_path.startswith("local://"):
        return None, {
            "status": "unavailable",
            "code": "browser_local_media",
            "message": "Browser-local media cannot be probed by the server",
        }
    raw = Path(output_path)
    candidate = raw if raw.is_absolute() else project_path / raw
    resolved = candidate.resolve(strict=False)
    if resolved != project_path and project_path not in resolved.parents:
        return None, {
            "status": "failed",
            "code": "path_outside_project",
            "message": "Legacy output path is outside the project workspace",
        }
    try:
        duration = _positive_float(probe_media(resolved).get("duration_seconds"))
    except MediaProbeError as exc:
        return None, {
            "status": "failed",
            "code": "media_probe_failed",
            "message": str(exc),
        }
    if duration is None:
        return None, {
            "status": "failed",
            "code": "duration_unavailable",
            "message": "Media probe did not return a positive duration",
        }
    return duration, {"status": "complete", "duration_seconds": duration}


def _legacy_media_exists(project_path: Path, output_path: str) -> bool:
    if not output_path or output_path.startswith("local://"):
        return False
    raw = Path(output_path)
    candidate = raw if raw.is_absolute() else project_path / raw
    resolved = candidate.resolve(strict=False)
    if resolved != project_path and project_path not in resolved.parents:
        return False
    return resolved.is_file()


def _result_path_matches(result: Any, output_path: str) -> bool:
    if not isinstance(result, Mapping):
        return False
    result_path = str(result.get("output_path") or "")
    if not result_path:
        return False
    if result_path == output_path:
        return True
    return Path(result_path).name == Path(output_path).name


def _operation_or_none(value: Any) -> VideoOperation | None:
    normalized = str(value or "")
    if normalized == "reference_to_video":
        normalized = "image_to_video"
    if normalized in {
        "text_to_video",
        "image_to_video",
        "first_last_frame_to_video",
        "extend",
    }:
        return normalized  # type: ignore[return-value]
    return None


def _positive_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _positive_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


def _sha256(value: Mapping[str, Any]) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _utc_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)
