from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import and_, literal, or_, select
from sqlalchemy.orm import Session

from server.app.billing.models import GenerationJob
from server.app.storage import WorkbenchStore
from server.app.tasks.models import TaskBatch, TaskDependency, TaskItem
from server.app.tasks.service import (
    GENERATION_UNIT_VIDEO_TASK_TYPE,
    PREVIOUS_SHOT_MISSING_CODE,
    PREVIOUS_SHOT_MISSING_MESSAGE,
    SHOT_VIDEO_TASK_TYPE,
    VIDEO_TASK_TYPES,
    TaskService,
)


_RECOVERABLE_JOB_STATUSES = {
    "reserved",
    "submitted_ambiguous",
    "reference_recovery_pending",
    "receipt_pending",
    "result_pending",
    "payment_required_quote",
    "payment_required",
    "billed",
}


def recover_provider_waits(
    db: Session,
    media_store: WorkbenchStore,
    *,
    project_id: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Repair legacy provider-pending task rows without submitting new work."""
    query = (
        select(TaskItem, TaskBatch)
        .join(TaskBatch, TaskBatch.id == TaskItem.batch_id)
        .where(
            TaskItem.task_type.in_(VIDEO_TASK_TYPES),
            or_(
                and_(
                    TaskItem.status == "failed",
                    TaskItem.error_code == "provider_result_pending",
                ),
                and_(
                    TaskItem.status.in_({"running", "waiting_provider"}),
                    TaskItem.settlement_key
                    == literal("task:").concat(TaskItem.id),
                ),
            ),
        )
        .order_by(TaskItem.created_at, TaskItem.id)
        .with_for_update()
    )
    if project_id is not None:
        query = query.where(TaskBatch.project_id == project_id)
    rows = list(db.execute(query))

    report: dict[str, Any] = {
        "dry_run": dry_run,
        "scanned_items": len(rows),
        "reused_jobs": 0,
        "published_results": 0,
        "still_waiting": 0,
        "duplicate_jobs": 0,
        "confirmed_charges": 0,
        "restored_dependencies": 0,
        "manual_audit": [],
        "unresolved": [],
    }
    recovered: list[tuple[TaskItem, GenerationJob]] = []
    affected_batch_ids: set[str] = set()
    now = datetime.now(timezone.utc)

    for item, batch in rows:
        job, reason = _exact_recovery_job(db, media_store, item, batch)
        if job is None:
            report["unresolved"].append(
                {"task_item_id": item.id, "reason": reason}
            )
            continue

        duplicates = _accepted_intent_duplicates(
            db, media_store, item=item, batch=batch, matched_job=job
        )
        if duplicates:
            report["duplicate_jobs"] += len(duplicates)
            report["manual_audit"].append(
                {
                    "task_item_id": item.id,
                    "matched_billing_job_id": job.id,
                    "duplicate_billing_job_ids": duplicates,
                }
            )

        item.billing_job_id = job.id
        item.status = "waiting_provider"
        item.attempt_count = min(item.attempt_count, max(0, item.max_attempts - 1))
        item.progress = max(5, item.progress)
        item.retryable = False
        item.error_code = None
        item.error_message = None
        item.claimed_by = None
        item.lease_expires_at = None
        item.next_attempt_at = None
        item.completed_at = None
        item.provider_wait_started_at = item.provider_wait_started_at or now
        item.provider_next_poll_at = now
        affected_batch_ids.add(item.batch_id)
        recovered.append((item, job))
        report["reused_jobs"] += 1
        if job.status == "billed":
            report["confirmed_charges"] += 1
        if job.status == "billed" and job.result_visible:
            report["published_results"] += 1
        else:
            report["still_waiting"] += 1

    restored, restored_batches = _restore_dependency_failures(db, recovered)
    report["restored_dependencies"] = restored
    affected_batch_ids.update(restored_batches)
    service = TaskService(db)
    for batch_id in affected_batch_ids:
        batch = db.get(TaskBatch, batch_id)
        if batch is not None:
            service._refresh_batch_fields(batch)

    if dry_run:
        db.rollback()
        return report
    db.commit()

    for _item, job in recovered:
        if job.status == "billed" and job.result_visible:
            service.resume_provider_result(job.id)
    return report


def _exact_recovery_job(
    db: Session,
    media_store: WorkbenchStore,
    item: TaskItem,
    batch: TaskBatch,
) -> tuple[GenerationJob | None, str]:
    legacy_settlement_key = f"task:{item.id}"
    job_id = item.id if item.settlement_key == legacy_settlement_key else item.settlement_key
    if item.billing_job_id is not None and item.billing_job_id != job_id:
        return None, "billing_job_conflict"
    job = db.get(GenerationJob, job_id)
    if job is None:
        return None, "settlement_job_not_found"
    if item.status == "running" and job.provider_reference_id is None:
        return None, "provider_not_accepted"
    expected_operation = None
    if item.task_type == SHOT_VIDEO_TASK_TYPE and item.target_entity_id:
        expected_operation = f"shot:{item.target_entity_id}"
    elif (
        item.task_type == GENERATION_UNIT_VIDEO_TASK_TYPE
        and item.target_entity_id
        and item.target_entity_version is not None
    ):
        expected_operation = (
            f"generation_unit:{item.target_entity_id}:v{item.target_entity_version}"
        )
    if (
        not job.chargeable
        or job.user_id != batch.owner_user_id
        or job.project_id != batch.project_id
        or job.capability != "video"
        or expected_operation is None
        or job.operation != expected_operation
        or (item.model is not None and job.model != item.model)
        or job.provider_method != "POST"
        or job.provider_route != "/v1/videos"
    ):
        return None, "billing_job_mismatch"
    if job.status not in _RECOVERABLE_JOB_STATUSES:
        return None, f"billing_job_terminal:{job.status}"
    claimed_item = db.scalar(
        select(TaskItem.id).where(
            TaskItem.billing_job_id == job.id,
            TaskItem.id != item.id,
        )
    )
    if claimed_item is not None:
        return None, "billing_job_claimed_by_another_item"
    try:
        intent = media_store.read_video_generation_intent(job.project_id, job.id)
    except ValueError:
        return None, "video_intent_missing_or_invalid"
    if (
        intent.target_entity_type != item.target_entity_type
        or intent.target_entity_id != item.target_entity_id
        or intent.target_entity_version != item.target_entity_version
        or (
            item.task_type == GENERATION_UNIT_VIDEO_TASK_TYPE
            and intent.generation_key != item.generation_key
        )
    ):
        return None, "video_intent_mismatch"
    if job.status == "billed" and not job.result_visible:
        return None, "billed_result_not_visible"
    return job, "matched"


def _accepted_intent_duplicates(
    db: Session,
    media_store: WorkbenchStore,
    *,
    item: TaskItem,
    batch: TaskBatch,
    matched_job: GenerationJob,
) -> list[str]:
    jobs = db.scalars(
        select(GenerationJob)
        .where(
            GenerationJob.id != matched_job.id,
            GenerationJob.chargeable.is_(True),
            GenerationJob.user_id == batch.owner_user_id,
            GenerationJob.project_id == batch.project_id,
            GenerationJob.capability == "video",
            GenerationJob.operation == matched_job.operation,
            GenerationJob.provider_reference_id.is_not(None),
        )
        .order_by(GenerationJob.created_at, GenerationJob.id)
    ).all()
    duplicates: list[str] = []
    for job in jobs:
        try:
            intent = media_store.read_video_generation_intent(job.project_id, job.id)
        except ValueError:
            continue
        if (
            intent.target_entity_type == item.target_entity_type
            and intent.target_entity_id == item.target_entity_id
            and intent.target_entity_version == item.target_entity_version
            and (
                item.task_type != GENERATION_UNIT_VIDEO_TASK_TYPE
                or intent.generation_key == item.generation_key
            )
        ):
            duplicates.append(job.id)
    return duplicates


def _restore_dependency_failures(
    db: Session,
    recovered: list[tuple[TaskItem, GenerationJob]],
) -> tuple[int, set[str]]:
    if not recovered:
        return 0, set()
    recovered_ids = {item.id for item, _job in recovered}
    batch_ids = {item.batch_id for item, _job in recovered}
    items = list(
        db.scalars(select(TaskItem).where(TaskItem.batch_id.in_(batch_ids)))
    )
    items_by_id = {item.id: item for item in items}
    dependencies: dict[str, list[str]] = defaultdict(list)
    children: dict[str, list[str]] = defaultdict(list)
    for dependency in db.scalars(
        select(TaskDependency).where(TaskDependency.batch_id.in_(batch_ids))
    ):
        dependencies[dependency.task_item_id].append(dependency.depends_on_item_id)
        children[dependency.depends_on_item_id].append(dependency.task_item_id)

    descendants: set[str] = set()
    frontier = list(recovered_ids)
    while frontier:
        parent_id = frontier.pop()
        for child_id in children.get(parent_id, []):
            if child_id not in descendants:
                descendants.add(child_id)
                frontier.append(child_id)

    restored = 0
    affected_batches: set[str] = set()
    while True:
        changed = False
        for item_id in descendants:
            item = items_by_id.get(item_id)
            if (
                item is None
                or item.status != "failed"
                or item.error_code != "dependency_failed"
            ):
                continue
            dependency_items = [
                items_by_id.get(dependency_id)
                for dependency_id in dependencies.get(item_id, [])
            ]
            if not dependency_items or any(
                dependency is None
                or dependency.status in {"failed", "cancelled"}
                for dependency in dependency_items
            ):
                continue
            item.status = "waiting_dependency"
            item.retryable = True
            item.error_code = PREVIOUS_SHOT_MISSING_CODE
            item.error_message = PREVIOUS_SHOT_MISSING_MESSAGE
            item.next_attempt_at = None
            item.claimed_by = None
            item.lease_expires_at = None
            item.completed_at = None
            restored += 1
            affected_batches.add(item.batch_id)
            changed = True
        if not changed:
            break
        db.flush()
    return restored, affected_batches
