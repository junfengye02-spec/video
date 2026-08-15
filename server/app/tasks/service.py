from __future__ import annotations

import hashlib
import json
import uuid
from collections import Counter, defaultdict
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import case, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased

from server.app.billing.models import GenerationJob
from server.app.events import EventBus
from server.app.tasks.models import TaskBatch, TaskDependency, TaskItem
from server.app.tasks.schemas import (
    TaskBatchResponse,
    TaskDependencyResponse,
    TaskItemResponse,
    TaskSubmitRequest,
)


class TaskNotFound(Exception):
    pass


class TaskConflict(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class TaskStateError(TaskConflict):
    pass


ITEM_TRANSITIONS: dict[str, set[str]] = {
    "queued": {"running", "waiting_dependency", "awaiting_payment", "cancelled"},
    "running": {
        "queued",
        "waiting_provider",
        "complete",
        "failed",
        "awaiting_payment",
        "cancelled",
    },
    "waiting_provider": {"queued", "failed", "cancelled"},
    "waiting_dependency": {"queued", "failed", "cancelled"},
    "awaiting_payment": {"queued", "failed", "cancelled"},
    "failed": {"queued", "waiting_dependency"},
    "complete": set(),
    "cancelled": set(),
}

SHOT_VIDEO_TASK_TYPE = "shot_video.generate"
GENERATION_UNIT_VIDEO_TASK_TYPE = "generation_unit_video.generate"
VIDEO_TASK_TYPES = {SHOT_VIDEO_TASK_TYPE, GENERATION_UNIT_VIDEO_TASK_TYPE}
PREVIOUS_SHOT_MISSING_CODE = "previous_shot_missing"
PREVIOUS_SHOT_MISSING_MESSAGE = "上一个分镜未生成，暂时无法生成当前分镜。"
PREVIOUS_GENERATION_UNIT_MISSING_CODE = "previous_generation_unit_missing"
PREVIOUS_GENERATION_UNIT_MISSING_MESSAGE = (
    "上一个视频生成单元尚未完成，暂时无法生成当前单元。"
)
SHOT_FRAME_DEPENDENCIES_MISSING_CODE = "shot_frame_dependencies_missing"
SHOT_FRAME_DEPENDENCIES_MISSING_MESSAGE = (
    "二次生成需要当前镜头的首帧和尾帧，请先完成画面依赖准备。"
)
ACTIVE_GENERATION_ITEM_STATUSES = {
    "queued",
    "running",
    "waiting_provider",
    "waiting_dependency",
    "awaiting_payment",
}
ACTIVE_BILLING_JOB_STATUSES = {
    "reserved",
    "submitted_ambiguous",
    "reference_recovery_pending",
    "receipt_pending",
    "result_pending",
    "payment_required_quote",
    "payment_required",
}
RETRYABLE_NO_CHARGE_STATUSES = {
    "provider_pricing_unstable_no_charge",
    "provider_quote_rate_limited_no_charge",
    "provider_pricing_unavailable_no_charge",
    "provider_not_submitted_no_charge",
    "provider_rejected_no_charge",
    "provider_reference_missing_no_charge",
    "provider_result_missing_no_charge",
    "receipt_missing_no_charge",
    "failed_no_charge",
}


@dataclass(frozen=True, slots=True)
class TaskClaim:
    item_id: str
    batch_id: str
    owner_user_id: str
    project_id: str
    task_type: str
    input_snapshot: dict[str, Any]
    reference_snapshot: list[dict[str, Any]]
    model: str | None
    project_version: int
    snapshot_version: int
    target_entity_type: str | None
    target_entity_id: str | None
    target_entity_version: int | None
    attempt_count: int
    billing_job_id: str | None
    settlement_key: str
    generation_key: str | None
    claimed_by: str
    # The immutable parent snapshot carries batch-level inputs that should not
    # be copied into every child item (for example a frozen composition plan).
    batch_snapshot: dict[str, Any] = field(default_factory=dict)


class TaskService:
    def __init__(self, db: Session, events: EventBus | None = None):
        self.db = db
        self.events = events

    def submit(
        self,
        *,
        owner_user_id: str,
        project_id: str,
        request: TaskSubmitRequest,
    ) -> tuple[TaskBatch, bool]:
        request_hash = _request_hash(request)
        existing = self._batch_by_idempotency(
            owner_user_id, project_id, request.idempotency_key
        )
        if existing is not None:
            return self._deduplicated(existing, request_hash)

        conflict = self._generation_conflict(
            owner_user_id,
            project_id,
            [item.generation_key for item in request.items if item.generation_key],
        )
        if conflict is not None:
            raise conflict

        self._validate_billing_links(owner_user_id, project_id, request)
        batch_id = uuid.uuid4().hex
        batch = TaskBatch(
            id=batch_id,
            owner_user_id=owner_user_id,
            project_id=project_id,
            task_type=request.task_type,
            status=(
                "waiting_dependency"
                if all(item.depends_on for item in request.items)
                else "queued"
            ),
            idempotency_key=request.idempotency_key,
            request_hash=request_hash,
            snapshot_version=request.snapshot_version,
            project_version=request.project_version,
            request_snapshot=request.model_dump(mode="json"),
            progress=0,
            total_items=len(request.items),
            completed_items=0,
            failed_items=0,
            billing_job_id=request.billing_job_id,
        )
        self.db.add(batch)

        ids_by_key: dict[str, str] = {}
        for position, submitted in enumerate(request.items):
            item_id = uuid.uuid4().hex
            ids_by_key[submitted.idempotency_key] = item_id
            self.db.add(
                TaskItem(
                    id=item_id,
                    batch_id=batch_id,
                    position=position,
                    task_type=submitted.task_type or request.task_type,
                    status=("waiting_dependency" if submitted.depends_on else "queued"),
                    idempotency_key=submitted.idempotency_key,
                    snapshot_version=request.snapshot_version,
                    project_version=request.project_version,
                    input_snapshot=submitted.input,
                    reference_snapshot=submitted.references,
                    model=submitted.model,
                    target_entity_type=submitted.target_entity_type,
                    target_entity_id=submitted.target_entity_id,
                    target_entity_version=submitted.target_entity_version,
                    attempt_count=0,
                    max_attempts=submitted.max_attempts,
                    progress=0,
                    retryable=True,
                    billing_job_id=submitted.billing_job_id,
                    settlement_key=submitted.settlement_key or f"task:{item_id}",
                    generation_key=submitted.generation_key,
                    generation_revision=submitted.generation_revision,
                    provider_poll_count=0,
                )
            )
        self.db.flush()
        for submitted in request.items:
            for dependency_key in submitted.depends_on:
                self.db.add(
                    TaskDependency(
                        batch_id=batch_id,
                        task_item_id=ids_by_key[submitted.idempotency_key],
                        depends_on_item_id=ids_by_key[dependency_key],
                        failure_policy="fail",
                    )
                )
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            existing = self._batch_by_idempotency(
                owner_user_id, project_id, request.idempotency_key
            )
            if existing is None:
                conflict = self._generation_conflict(
                    owner_user_id,
                    project_id,
                    [
                        item.generation_key
                        for item in request.items
                        if item.generation_key
                    ],
                )
                if conflict is not None:
                    raise conflict from None
                raise
            return self._deduplicated(existing, request_hash)
        self.db.refresh(batch)
        self._emit_batch(batch, "Task accepted")
        for item in self._items(batch.id):
            self._emit_item(batch, item, "Task item accepted")
        return batch, False

    def list_owned(
        self, owner_user_id: str, project_id: str, *, limit: int = 50
    ) -> list[TaskBatch]:
        return list(
            self.db.scalars(
                select(TaskBatch)
                .where(
                    TaskBatch.owner_user_id == owner_user_id,
                    TaskBatch.project_id == project_id,
                )
                .order_by(TaskBatch.created_at.desc(), TaskBatch.id.desc())
                .limit(limit)
            )
        )

    def find_owned_by_idempotency(
        self,
        owner_user_id: str,
        project_id: str,
        idempotency_key: str,
    ) -> TaskBatch | None:
        return self._batch_by_idempotency(
            owner_user_id,
            project_id,
            idempotency_key,
        )

    def next_generation_revision(
        self,
        *,
        owner_user_id: str,
        project_id: str,
        target_entity_type: str,
        target_entity_id: str,
        target_entity_version: int,
        model: str,
    ) -> int:
        rows = list(
            self.db.execute(
                select(TaskItem, TaskBatch)
                .join(TaskBatch, TaskBatch.id == TaskItem.batch_id)
                .where(
                    TaskBatch.owner_user_id == owner_user_id,
                    TaskBatch.project_id == project_id,
                    TaskItem.target_entity_type == target_entity_type,
                    TaskItem.target_entity_id == target_entity_id,
                    TaskItem.target_entity_version == target_entity_version,
                )
                .order_by(TaskItem.created_at.desc(), TaskItem.id.desc())
            )
        )
        for item, batch in rows:
            job = self._generation_job_for_item(item)
            recoverable_billed = (
                job is not None
                and job.status == "billed"
                and job.result_visible
                and item.status != "complete"
            )
            if (
                item.status in ACTIVE_GENERATION_ITEM_STATUSES
                or (job is not None and job.status in ACTIVE_BILLING_JOB_STATUSES)
                or recoverable_billed
            ):
                raise TaskConflict(
                    "provider_generation_in_progress",
                    "An active or recoverable provider generation already exists",
                    {
                        "task_id": batch.id,
                        "task_item_id": item.id,
                        "billing_job_id": job.id if job is not None else item.billing_job_id,
                        "model": item.model,
                        "parameters_match": item.model == model,
                    },
                )
        return (
            max((item.generation_revision for item, _batch in rows), default=-1) + 1
        )

    def require_owned_batch(
        self, batch_id: str, owner_user_id: str, project_id: str
    ) -> TaskBatch:
        batch = self.db.scalar(
            select(TaskBatch).where(
                TaskBatch.id == batch_id,
                TaskBatch.owner_user_id == owner_user_id,
                TaskBatch.project_id == project_id,
            )
        )
        if batch is None:
            raise TaskNotFound
        return batch

    def retry_owned_item(
        self,
        *,
        batch_id: str,
        item_id: str,
        owner_user_id: str,
        project_id: str,
    ) -> TaskItem:
        batch = self.require_owned_batch(batch_id, owner_user_id, project_id)
        item = self.db.scalar(
            select(TaskItem)
            .where(TaskItem.id == item_id, TaskItem.batch_id == batch.id)
            .with_for_update()
        )
        if item is None:
            raise TaskNotFound
        external_dependency_retry = (
            item.status == "waiting_dependency"
            and item.error_code == PREVIOUS_SHOT_MISSING_CODE
        )
        if item.status not in {"failed", "awaiting_payment"} and not external_dependency_retry:
            raise TaskStateError(
                "task_not_retryable_state",
                "Only failed, payment-blocked, or externally blocked task items can be retried",
            )
        if item.status == "awaiting_payment":
            billing_job = self._owned_item_billing_job(item, batch)
            if billing_job is None and item.task_type not in {
                "resource_image.generate",
                "storyboard.plan",
                *VIDEO_TASK_TYPES,
            }:
                raise TaskStateError(
                    "task_billing_job_invalid",
                    "Payment-blocked task does not have an owned billing job",
                )
            if billing_job is not None and billing_job.status not in {
                "payment_required_quote",
                "payment_required",
                "billed",
            }:
                raise TaskStateError(
                    "task_payment_not_retryable",
                    "Billing job cannot be retried from its current state",
                )
        # A failed item remains manually retryable until the hard attempt cap;
        # automatic recovery may have already marked retryable false.
        if not item.retryable and item.status != "failed":
            raise TaskStateError("task_not_retryable", "Task item is not retryable")

        billing_job = self._generation_job_for_item(item)
        fresh_generation_execution = self._rotate_failed_generation_unit_execution(
            item=item,
            batch=batch,
            billing_job=billing_job,
        )
        if item.attempt_count >= 10 and not fresh_generation_execution:
            raise TaskStateError("task_retry_limit", "Task item retry limit reached")
        if not fresh_generation_execution and item.attempt_count >= item.max_attempts:
            item.max_attempts = item.attempt_count + 1

        if (
            item.status == "failed"
            and item.task_type == "resource_image.generate"
            and billing_job is not None
            and billing_job.user_id == batch.owner_user_id
            and billing_job.project_id == batch.project_id
            and billing_job.chargeable
            and billing_job.capability == "image"
            and billing_job.status in RETRYABLE_NO_CHARGE_STATUSES
        ):
            item.settlement_key = uuid.uuid4().hex
            item.billing_job_id = None

        dependencies = self._dependency_statuses([item.id]).get(item.id, [])
        item.status = (
            "queued"
            if all(status == "complete" for _, status in dependencies)
            else "waiting_dependency"
        )
        item.error_code = None
        item.error_message = None
        item.result_snapshot = None
        item.progress = 0
        item.retryable = True
        item.next_attempt_at = None
        item.claimed_by = None
        item.lease_expires_at = None
        item.completed_at = None

        dependent_ids = self._dependency_descendant_ids(item.batch_id, item.id)
        reopened: list[TaskItem] = []
        if dependent_ids:
            dependents = list(
                self.db.scalars(
                    select(TaskItem).where(
                        TaskItem.batch_id == item.batch_id,
                        TaskItem.id.in_(dependent_ids),
                        TaskItem.status == "failed",
                        TaskItem.error_code.in_(
                            {"dependency_failed", "dependency_cancelled"}
                        ),
                    ).with_for_update()
                )
            )
            for dependent in dependents:
                dependent.status = "waiting_dependency"
                dependent.error_code = None
                dependent.error_message = None
                dependent.completed_at = None
                dependent.progress = 0
                dependent.retryable = True
                reopened.append(dependent)

        self._refresh_batch_fields(batch)
        self.db.commit()
        self._emit_item(batch, item, "Task item queued for retry")
        for dependent in reopened:
            self._emit_item(batch, dependent, "Task dependency reopened for retry")
        self._emit_batch(batch, "Task retry accepted")
        return item

    def _rotate_failed_generation_unit_execution(
        self,
        *,
        item: TaskItem,
        batch: TaskBatch,
        billing_job: GenerationJob | None,
    ) -> bool:
        unit = self._rotatable_failed_generation_unit(
            item=item,
            batch=batch,
            billing_job=billing_job,
            lock=True,
            strict=True,
        )
        if unit is None:
            return False
        assert billing_job is not None
        assert item.generation_key is not None

        previous_generation_key = item.generation_key
        previous_settlement_key = item.settlement_key
        diagnostics = deepcopy(unit.diagnostics_json or {})
        retry_history = diagnostics.get("execution_retries")
        if not isinstance(retry_history, list):
            retry_history = []
        retry_history.append(
            {
                "execution_cycle": len(retry_history) + 1,
                "generation_key": previous_generation_key,
                "settlement_key": previous_settlement_key,
                "billing_job_id": billing_job.id,
                "billing_status": billing_job.status,
                "attempt_count": item.attempt_count,
                "error_code": item.error_code,
                "retired_at": _now().isoformat(),
            }
        )
        diagnostics["execution_retries"] = retry_history

        new_generation_key = hashlib.sha256(
            json.dumps(
                {
                    "previous_generation_key": previous_generation_key,
                    "previous_billing_job_id": billing_job.id,
                    "execution_cycle": len(retry_history),
                    "nonce": uuid.uuid4().hex,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        unit.execution_key = new_generation_key
        unit.billing_job_id = None
        unit.status = "queued"
        unit.output_asset_id = None
        unit.output_path = None
        unit.source_duration_seconds = None
        unit.diagnostics_json = diagnostics

        item.generation_key = new_generation_key
        item.settlement_key = new_generation_key[:32]
        item.billing_job_id = None
        item.attempt_count = 0
        item.max_attempts = 9
        item.provider_wait_started_at = None
        item.provider_next_poll_at = None
        item.provider_poll_count = 0
        return True

    def _rotatable_failed_generation_unit(
        self,
        *,
        item: TaskItem,
        batch: TaskBatch,
        billing_job: GenerationJob | None,
        lock: bool,
        strict: bool,
    ) -> Any | None:
        if (
            item.status != "failed"
            or item.task_type != GENERATION_UNIT_VIDEO_TASK_TYPE
            or billing_job is None
            or billing_job.status not in RETRYABLE_NO_CHARGE_STATUSES
        ):
            return None
        if (
            item.target_entity_type != "generation_unit"
            or item.target_entity_id is None
            or item.target_entity_version is None
            or item.generation_key is None
            or billing_job.id != item.billing_job_id
            or billing_job.id != item.settlement_key
            or billing_job.user_id != batch.owner_user_id
            or billing_job.project_id != batch.project_id
            or not billing_job.chargeable
            or billing_job.capability != "video"
            or billing_job.operation
            != (
                f"generation_unit:{item.target_entity_id}:"
                f"v{item.target_entity_version}"
            )
            or billing_job.model != item.model
            or billing_job.provider_method != "POST"
            or billing_job.provider_route != "/v1/videos"
            or billing_job.result_visible
        ):
            if strict:
                raise TaskStateError(
                    "generation_unit_retry_identity_invalid",
                    "Failed generation unit billing identity cannot be replaced safely",
                )
            return None

        from server.app.generation_units.models import VideoGenerationUnit

        query = (
            select(VideoGenerationUnit)
            .where(
                VideoGenerationUnit.project_id == batch.project_id,
                VideoGenerationUnit.id == item.target_entity_id,
                VideoGenerationUnit.revision == item.target_entity_version,
            )
        )
        unit = self.db.scalar(query.with_for_update() if lock else query)
        if (
            unit is None
            or unit.task_item_id != item.id
            or unit.execution_key != item.generation_key
            or unit.billing_job_id != billing_job.id
            or unit.status != "failed"
            or unit.active
        ):
            if strict:
                raise TaskStateError(
                    "generation_unit_retry_identity_invalid",
                    "Failed generation unit execution ledger cannot be replaced safely",
                )
            return None
        return unit

    def transition_item(
        self,
        item_id: str,
        new_status: str,
        *,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> TaskItem:
        item = self.db.scalar(
            select(TaskItem).where(TaskItem.id == item_id).with_for_update()
        )
        if item is None:
            raise TaskNotFound
        if new_status not in ITEM_TRANSITIONS.get(item.status, set()):
            raise TaskStateError(
                "invalid_task_transition",
                f"Task item cannot transition from {item.status} to {new_status}",
            )
        item.status = new_status
        item.error_code = error_code
        item.error_message = error_message
        now = _now()
        if new_status == "running":
            item.started_at = item.started_at or now
        if new_status == "complete":
            item.progress = 100
        if new_status in {"complete", "failed", "cancelled"}:
            item.completed_at = now
        batch = self.db.get(TaskBatch, item.batch_id)
        if batch is None:
            raise TaskNotFound
        self._refresh_batch_fields(batch)
        self.db.commit()
        self._emit_item(batch, item, f"Task item {new_status}")
        self._emit_batch(batch, f"Task {batch.status}")
        return item

    def recover_orphaned(self, worker_id: str) -> int:
        del worker_id
        orphaned, batch_ids = self._recover_expired_claims_in_transaction(_now())
        changed_dependencies = self._resolve_dependencies_in_transaction()
        batch_ids.update(changed_dependencies)
        batches = [self.db.get(TaskBatch, batch_id) for batch_id in batch_ids]
        for batch in batches:
            if batch is not None:
                self._refresh_batch_fields(batch)
        self.db.commit()
        for batch in batches:
            if batch is not None:
                self._emit_dependency_changes(
                    batch, "Task recovered after worker lease expired"
                )
        return len(orphaned)

    def resolve_dependencies(self) -> int:
        batch_ids = self._resolve_dependencies_in_transaction()
        batches = [self.db.get(TaskBatch, batch_id) for batch_id in batch_ids]
        for batch in batches:
            if batch is not None:
                self._refresh_batch_fields(batch)
        self.db.commit()
        for batch in batches:
            if batch is not None:
                self._emit_dependency_changes(batch, "Task dependencies updated")
        return len(batch_ids)

    def claim_next(
        self,
        *,
        worker_id: str,
        supported_task_types: set[str],
        lease_seconds: float,
    ) -> TaskClaim | None:
        if not supported_task_types:
            return None
        now = _now()
        _, recovered_batch_ids = self._recover_expired_claims_in_transaction(now)
        changed_batch_ids = (
            self._resolve_dependencies_in_transaction() | recovered_batch_ids
        )
        candidate = aliased(TaskItem, name="candidate_task_item")
        candidate_id = (
            select(candidate.id)
            .where(
                candidate.status == "queued",
                candidate.task_type.in_(supported_task_types),
                candidate.attempt_count < candidate.max_attempts,
                or_(
                    candidate.next_attempt_at.is_(None), candidate.next_attempt_at <= now
                ),
            )
            .order_by(candidate.created_at, candidate.position, candidate.id)
            .limit(1)
            .scalar_subquery()
        )
        claimed_id = self.db.scalar(
            update(TaskItem)
            .where(
                TaskItem.id == candidate_id,
                TaskItem.status == "queued",
                TaskItem.attempt_count < TaskItem.max_attempts,
            )
            .values(
                status="running",
                attempt_count=TaskItem.attempt_count + 1,
                claimed_by=worker_id,
                lease_expires_at=now + timedelta(seconds=lease_seconds),
                started_at=func.coalesce(TaskItem.started_at, now),
                completed_at=None,
                next_attempt_at=None,
                error_code=None,
                error_message=None,
            )
            .returning(TaskItem.id)
            .execution_options(synchronize_session=False)
        )
        if claimed_id is None:
            for changed_batch_id in changed_batch_ids:
                changed_batch = self.db.get(TaskBatch, changed_batch_id)
                if changed_batch is not None:
                    self._refresh_batch_fields(changed_batch)
            self.db.commit()
            for changed_batch_id in changed_batch_ids:
                changed_batch = self.db.get(TaskBatch, changed_batch_id)
                if changed_batch is not None:
                    self._emit_dependency_changes(
                        changed_batch, "Task dependencies updated"
                    )
            return None
        item = self.db.get(TaskItem, claimed_id, populate_existing=True)
        if item is None:
            self.db.rollback()
            raise TaskNotFound
        batch = self.db.get(TaskBatch, item.batch_id)
        if batch is None:
            raise TaskNotFound
        self._refresh_batch_fields(batch)
        self.db.commit()
        for changed_batch_id in changed_batch_ids:
            changed_batch = self.db.get(TaskBatch, changed_batch_id)
            if changed_batch is not None:
                self._emit_dependency_changes(
                    changed_batch, "Task dependencies updated"
                )
        self._emit_item(batch, item, "Task item running")
        self._emit_batch(batch, "Task running")
        return _claim_from(item, batch, worker_id)

    def update_progress(
        self,
        item_id: str,
        worker_id: str,
        attempt_count: int,
        progress: int,
        lease_seconds: float,
    ) -> bool:
        bounded_progress = min(99, max(0, progress))
        batch_id = self.db.scalar(
            update(TaskItem)
            .where(
                TaskItem.id == item_id,
                TaskItem.status == "running",
                TaskItem.claimed_by == worker_id,
                TaskItem.attempt_count == attempt_count,
            )
            .values(
                progress=case(
                    (TaskItem.progress < bounded_progress, bounded_progress),
                    else_=TaskItem.progress,
                ),
                lease_expires_at=_now() + timedelta(seconds=lease_seconds),
            )
            .returning(TaskItem.batch_id)
            .execution_options(synchronize_session=False)
        )
        if batch_id is None:
            self.db.rollback()
            return False
        batch = self.db.get(TaskBatch, batch_id, populate_existing=True)
        if batch is None:
            self.db.rollback()
            return False
        self._refresh_batch_fields(batch)
        item = self.db.get(TaskItem, item_id, populate_existing=True)
        if item is None:
            self.db.rollback()
            return False
        self.db.commit()
        self._emit_item(batch, item, "Task item progress updated")
        return True

    def renew_claim(
        self,
        item_id: str,
        worker_id: str,
        attempt_count: int,
        lease_seconds: float,
    ) -> bool:
        renewed_id = self.db.scalar(
            update(TaskItem)
            .where(
                TaskItem.id == item_id,
                TaskItem.status == "running",
                TaskItem.claimed_by == worker_id,
                TaskItem.attempt_count == attempt_count,
            )
            .values(
                lease_expires_at=_now() + timedelta(seconds=lease_seconds),
            )
            .returning(TaskItem.id)
            .execution_options(synchronize_session=False)
        )
        if renewed_id is None:
            self.db.rollback()
            return False
        self.db.commit()
        return True

    def claim_is_current(
        self, item_id: str, worker_id: str, attempt_count: int
    ) -> bool:
        return (
            self.db.scalar(
                select(TaskItem.id).where(
                    TaskItem.id == item_id,
                    TaskItem.status == "running",
                    TaskItem.claimed_by == worker_id,
                    TaskItem.attempt_count == attempt_count,
                )
            )
            is not None
        )

    def complete_claim(
        self,
        item_id: str,
        worker_id: str,
        attempt_count: int,
        result: dict[str, Any],
    ) -> bool:
        item = self._owned_running_item(item_id, worker_id, attempt_count)
        if item is None:
            self.db.rollback()
            return False
        item.status = "complete"
        item.progress = 100
        item.result_snapshot = result
        item.claimed_by = None
        item.lease_expires_at = None
        item.completed_at = _now()
        batch = self.db.get(TaskBatch, item.batch_id)
        if batch is None:
            self.db.rollback()
            return False
        self._refresh_batch_fields(batch)
        self.db.commit()
        self._emit_item(batch, item, "Task item complete")
        self._emit_batch(batch, f"Task {batch.status}")
        return True

    def bind_claim_billing_job(
        self,
        item_id: str,
        worker_id: str,
        attempt_count: int,
        billing_job_id: str,
    ) -> bool:
        """Attach the stable provider job once it exists without weakening claim fencing."""
        item = self._owned_running_item(item_id, worker_id, attempt_count)
        if item is None:
            self.db.rollback()
            return False
        batch = self.db.get(TaskBatch, item.batch_id)
        if batch is None:
            self.db.rollback()
            return False
        self._validate_claim_billing_job(item, batch, billing_job_id)
        item.billing_job_id = billing_job_id
        self._sync_generation_unit_item(item)
        self.db.commit()
        return True

    def pause_claim_for_provider(
        self,
        item_id: str,
        worker_id: str,
        attempt_count: int,
        *,
        billing_job_id: str,
        next_poll_at: datetime,
    ) -> bool:
        item = self._owned_running_item(item_id, worker_id, attempt_count)
        if item is None:
            self.db.rollback()
            return False
        batch = self.db.get(TaskBatch, item.batch_id)
        if batch is None:
            self.db.rollback()
            return False
        self._validate_claim_billing_job(item, batch, billing_job_id)
        now = _now()
        item.billing_job_id = billing_job_id
        item.status = "waiting_provider"
        item.progress = max(5, item.progress)
        item.retryable = False
        item.error_code = None
        item.error_message = None
        item.claimed_by = None
        item.lease_expires_at = None
        item.next_attempt_at = None
        item.provider_wait_started_at = item.provider_wait_started_at or now
        item.provider_next_poll_at = next_poll_at
        self._refresh_batch_fields(batch)
        self.db.commit()
        self._emit_item(batch, item, "Task item waiting for provider")
        self._emit_batch(batch, "Task waiting for provider")
        return True

    def record_provider_poll(
        self,
        billing_job_id: str,
        *,
        next_poll_at: datetime | None,
    ) -> int:
        items = list(
            self.db.scalars(
                select(TaskItem)
                .where(
                    TaskItem.billing_job_id == billing_job_id,
                    TaskItem.status == "waiting_provider",
                )
                .with_for_update(skip_locked=True)
            )
        )
        for item in items:
            item.provider_poll_count += 1
            item.provider_next_poll_at = next_poll_at
        self.db.commit()
        return len(items)

    def resume_provider_result(self, billing_job_id: str) -> int:
        items = list(
            self.db.scalars(
                select(TaskItem)
                .where(
                    TaskItem.billing_job_id == billing_job_id,
                    TaskItem.status == "waiting_provider",
                )
                .with_for_update(skip_locked=True)
            )
        )
        batch_ids: set[str] = set()
        for item in items:
            item.status = "queued"
            # The next claim resumes local publication and is not a provider retry.
            item.attempt_count = max(0, item.attempt_count - 1)
            item.retryable = True
            item.error_code = None
            item.error_message = None
            item.next_attempt_at = None
            item.provider_next_poll_at = None
            item.completed_at = None
            batch_ids.add(item.batch_id)
        batches = [self.db.get(TaskBatch, batch_id) for batch_id in batch_ids]
        for batch in batches:
            if batch is not None:
                self._refresh_batch_fields(batch)
        self.db.commit()
        for item in items:
            batch = next((value for value in batches if value and value.id == item.batch_id), None)
            if batch is not None:
                self._emit_item(batch, item, "Provider result is ready for publication")
        return len(items)

    def fail_provider_wait(
        self,
        billing_job_id: str,
        *,
        error_code: str = "provider_generation_failed",
        error_message: str = "Video provider generation failed",
    ) -> int:
        items = list(
            self.db.scalars(
                select(TaskItem)
                .where(
                    TaskItem.billing_job_id == billing_job_id,
                    TaskItem.status == "waiting_provider",
                )
                .with_for_update(skip_locked=True)
            )
        )
        batch_ids: set[str] = set()
        for item in items:
            item.status = "failed"
            item.retryable = False
            item.error_code = error_code
            item.error_message = error_message
            item.provider_next_poll_at = None
            item.completed_at = _now()
            batch_ids.add(item.batch_id)
        batch_ids.update(self._resolve_dependencies_in_transaction())
        batches = [self.db.get(TaskBatch, batch_id) for batch_id in batch_ids]
        for batch in batches:
            if batch is not None:
                self._refresh_batch_fields(batch)
        self.db.commit()
        return len(items)

    def fail_claim(
        self,
        item_id: str,
        worker_id: str,
        attempt_count: int,
        *,
        error_code: str,
        error_message: str,
        retryable: bool,
        retry_delay_seconds: float,
        result: dict[str, Any] | None = None,
    ) -> bool:
        item = self._owned_running_item(item_id, worker_id, attempt_count)
        if item is None:
            self.db.rollback()
            return False
        item.error_code = error_code
        item.error_message = error_message
        item.retryable = retryable and item.attempt_count < 10
        if result is not None:
            item.result_snapshot = result
        item.claimed_by = None
        item.lease_expires_at = None
        if item.retryable and item.attempt_count < item.max_attempts:
            item.status = "queued"
            item.next_attempt_at = _now() + timedelta(seconds=retry_delay_seconds)
            message = "Task item scheduled for retry"
        else:
            item.status = "failed"
            item.next_attempt_at = None
            item.completed_at = _now()
            message = "Task item failed"
        batch = self.db.get(TaskBatch, item.batch_id)
        if batch is None:
            self.db.rollback()
            return False
        self._refresh_batch_fields(batch)
        self.db.commit()
        self._emit_item(batch, item, message)
        self._emit_batch(batch, f"Task {batch.status}")
        return True

    def pause_claim_for_payment(
        self,
        item_id: str,
        worker_id: str,
        attempt_count: int,
        *,
        billing_job_id: str | None,
    ) -> bool:
        item = self._owned_running_item(item_id, worker_id, attempt_count)
        if item is None:
            self.db.rollback()
            return False
        batch = self.db.get(TaskBatch, item.batch_id)
        if batch is None:
            self.db.rollback()
            return False
        effective_billing_job_id = billing_job_id or item.billing_job_id
        billing_job = (
            self.db.scalar(
                select(GenerationJob).where(
                    GenerationJob.id == effective_billing_job_id,
                    GenerationJob.user_id == batch.owner_user_id,
                    GenerationJob.project_id == batch.project_id,
                    GenerationJob.chargeable.is_(True),
                )
            )
            if effective_billing_job_id is not None
            else None
        )
        payment_can_precede_reservation = (
            effective_billing_job_id is None
            and item.task_type in {"resource_image.generate", *VIDEO_TASK_TYPES}
        )
        if billing_job is None and not payment_can_precede_reservation:
            self.db.rollback()
            raise TaskStateError(
                "task_billing_job_invalid",
                "Awaiting-payment task requires an owned chargeable billing job",
            )
        if billing_job is not None and item.task_type in VIDEO_TASK_TYPES:
            self._validate_claim_billing_job(item, batch, billing_job.id)
        item.status = "awaiting_payment"
        item.billing_job_id = billing_job.id if billing_job is not None else None
        item.claimed_by = None
        item.lease_expires_at = None
        item.error_code = "awaiting_payment"
        item.error_message = "Payment is required before task execution can continue"
        self._refresh_batch_fields(batch)
        self.db.commit()
        self._emit_item(batch, item, "Task item awaiting payment")
        self._emit_batch(batch, "Task awaiting payment")
        return True

    def pause_claim_for_dependency(
        self,
        item_id: str,
        worker_id: str,
        attempt_count: int,
        *,
        error_code: str,
        error_message: str,
    ) -> bool:
        item = self._owned_running_item(item_id, worker_id, attempt_count)
        if item is None:
            self.db.rollback()
            return False
        item.status = "waiting_dependency"
        item.claimed_by = None
        item.lease_expires_at = None
        item.next_attempt_at = None
        item.error_code = error_code
        item.error_message = error_message
        item.retryable = True
        batch = self.db.get(TaskBatch, item.batch_id)
        if batch is None:
            self.db.rollback()
            return False
        self._refresh_batch_fields(batch)
        self.db.commit()
        self._emit_item(batch, item, "Task item waiting for dependency")
        self._emit_batch(batch, "Task waiting for dependency")
        return True

    def mark_external_dependency_waiting(
        self,
        *,
        batch_id: str,
        item_ids: set[str],
    ) -> int:
        if not item_ids:
            return 0
        items = list(
            self.db.scalars(
                select(TaskItem)
                .where(
                    TaskItem.batch_id == batch_id,
                    TaskItem.id.in_(item_ids),
                    TaskItem.status == "queued",
                )
                .with_for_update()
            )
        )
        for item in items:
            item.status = "waiting_dependency"
            item.error_code = PREVIOUS_SHOT_MISSING_CODE
            item.error_message = PREVIOUS_SHOT_MISSING_MESSAGE
            item.retryable = True
        batch = self.db.get(TaskBatch, batch_id)
        if batch is None:
            raise TaskNotFound
        self._refresh_batch_fields(batch)
        self.db.commit()
        for item in items:
            self._emit_item(batch, item, "Task item waiting for previous shot")
        if items:
            self._emit_batch(batch, "Task waiting for dependency")
        return len(items)

    def release_external_shot_dependencies(
        self,
        *,
        project_id: str,
        previous_shot_id: str,
        previous_shot_version: int,
    ) -> int:
        items = list(
            self.db.scalars(
                select(TaskItem)
                .join(TaskBatch, TaskBatch.id == TaskItem.batch_id)
                .where(
                    TaskBatch.project_id == project_id,
                    TaskItem.task_type == SHOT_VIDEO_TASK_TYPE,
                    TaskItem.status == "waiting_dependency",
                    TaskItem.error_code == PREVIOUS_SHOT_MISSING_CODE,
                )
                .with_for_update()
            )
        )
        released: list[TaskItem] = []
        batch_ids: set[str] = set()
        for item in items:
            dependency = item.input_snapshot.get("dependency")
            if not isinstance(dependency, dict):
                continue
            if (
                dependency.get("previous_shot_id") != previous_shot_id
                or dependency.get("previous_shot_version") != previous_shot_version
            ):
                continue
            item.status = "queued"
            item.error_code = None
            item.error_message = None
            item.completed_at = None
            item.next_attempt_at = None
            released.append(item)
            batch_ids.add(item.batch_id)
        batches = [self.db.get(TaskBatch, batch_id) for batch_id in batch_ids]
        for batch in batches:
            if batch is not None:
                self._refresh_batch_fields(batch)
        self.db.commit()
        batches_by_id = {batch.id: batch for batch in batches if batch is not None}
        for item in released:
            batch = batches_by_id.get(item.batch_id)
            if batch is not None:
                self._emit_item(batch, item, "Previous shot dependency is ready")
        for batch in batches_by_id.values():
            self._emit_batch(batch, "Task dependency is ready")
        return len(released)

    def release_external_generation_unit_dependencies(
        self,
        *,
        project_id: str,
        previous_generation_unit_id: str,
        previous_generation_unit_revision: int,
    ) -> int:
        items = list(
            self.db.scalars(
                select(TaskItem)
                .join(TaskBatch, TaskBatch.id == TaskItem.batch_id)
                .where(
                    TaskBatch.project_id == project_id,
                    TaskItem.task_type == GENERATION_UNIT_VIDEO_TASK_TYPE,
                    TaskItem.status == "waiting_dependency",
                    TaskItem.error_code == PREVIOUS_GENERATION_UNIT_MISSING_CODE,
                )
                .with_for_update()
            )
        )
        released: list[TaskItem] = []
        batch_ids: set[str] = set()
        for item in items:
            dependency = item.input_snapshot.get("dependency")
            if not isinstance(dependency, dict):
                continue
            if (
                dependency.get("previous_generation_unit_id")
                != previous_generation_unit_id
                or dependency.get("previous_generation_unit_revision")
                != previous_generation_unit_revision
            ):
                continue
            item.status = "queued"
            item.error_code = None
            item.error_message = None
            item.completed_at = None
            item.next_attempt_at = None
            released.append(item)
            batch_ids.add(item.batch_id)
        batches = [self.db.get(TaskBatch, batch_id) for batch_id in batch_ids]
        for batch in batches:
            if batch is not None:
                self._refresh_batch_fields(batch)
        self.db.commit()
        return len(released)

    def batch_response(
        self, batch: TaskBatch, *, include_items: bool
    ) -> TaskBatchResponse:
        items = self._items(batch.id) if include_items else []
        dependency_map = (
            self._dependency_statuses([item.id for item in items]) if items else {}
        )
        return TaskBatchResponse(
            id=batch.id,
            project_id=batch.project_id,
            task_type=batch.task_type,
            status=batch.status,
            idempotency_key=batch.idempotency_key,
            snapshot_version=batch.snapshot_version,
            project_version=batch.project_version,
            snapshot=batch.request_snapshot,
            progress=batch.progress,
            total_items=batch.total_items,
            completed_items=batch.completed_items,
            failed_items=batch.failed_items,
            billing_job_id=batch.billing_job_id,
            error_code=batch.error_code,
            error_message=batch.error_message,
            created_at=batch.created_at,
            updated_at=batch.updated_at,
            items=(
                [self._item_response(item, dependency_map) for item in items]
                if include_items
                else None
            ),
        )

    def _deduplicated(
        self, existing: TaskBatch, request_hash: str
    ) -> tuple[TaskBatch, bool]:
        if existing.request_hash != request_hash:
            raise TaskConflict(
                "idempotency_conflict",
                "Idempotency key was already used for a different task submission",
            )
        return existing, True

    def _batch_by_idempotency(
        self, owner_user_id: str, project_id: str, idempotency_key: str
    ) -> TaskBatch | None:
        return self.db.scalar(
            select(TaskBatch).where(
                TaskBatch.owner_user_id == owner_user_id,
                TaskBatch.project_id == project_id,
                TaskBatch.idempotency_key == idempotency_key,
            )
        )

    def _validate_billing_links(
        self, owner_user_id: str, project_id: str, request: TaskSubmitRequest
    ) -> None:
        job_ids = {
            job_id
            for job_id in [
                request.billing_job_id,
                *(item.billing_job_id for item in request.items),
            ]
            if job_id is not None
        }
        if not job_ids:
            return
        jobs = {
            job.id: job
            for job in self.db.scalars(
                select(GenerationJob).where(
                    GenerationJob.id.in_(job_ids),
                    GenerationJob.user_id == owner_user_id,
                    GenerationJob.project_id == project_id,
                )
            )
        }
        if set(jobs) != job_ids:
            raise TaskConflict(
                "billing_job_not_found",
                "Billing job does not belong to this project and user",
            )
        if request.billing_job_id is not None and jobs[
            request.billing_job_id
        ].chargeable:
            raise TaskConflict(
                "billing_parent_job_invalid",
                "Batch billing job must be a non-chargeable parent job",
            )
        for item in request.items:
            if item.billing_job_id is None:
                continue
            job = jobs[item.billing_job_id]
            if not job.chargeable:
                raise TaskConflict(
                    "billing_child_job_invalid",
                    "Task item billing job must be chargeable",
                )
            if (
                request.billing_job_id is not None
                and job.parent_job_id != request.billing_job_id
            ):
                raise TaskConflict(
                    "billing_job_parent_mismatch",
                    "Task item billing job does not belong to the batch billing job",
                )

    def _generation_conflict(
        self,
        owner_user_id: str,
        project_id: str,
        generation_keys: list[str],
    ) -> TaskConflict | None:
        if not generation_keys:
            return None
        row = self.db.execute(
            select(TaskItem, TaskBatch)
            .join(TaskBatch, TaskBatch.id == TaskItem.batch_id)
            .where(
                TaskBatch.owner_user_id == owner_user_id,
                TaskBatch.project_id == project_id,
                TaskItem.generation_key.in_(generation_keys),
            )
            .order_by(TaskItem.created_at.desc(), TaskItem.id.desc())
            .limit(1)
        ).first()
        if row is None:
            return None
        item, batch = row
        job = self._generation_job_for_item(item)
        return TaskConflict(
            "provider_generation_in_progress",
            "An active provider generation already exists",
            {
                "task_id": batch.id,
                "task_item_id": item.id,
                "billing_job_id": job.id if job is not None else item.billing_job_id,
            },
        )

    def _generation_job_for_item(self, item: TaskItem) -> GenerationJob | None:
        job_id = item.billing_job_id
        if job_id is None and len(item.settlement_key) == 32 and all(
            value in "0123456789abcdef" for value in item.settlement_key
        ):
            job_id = item.settlement_key
        return self.db.get(GenerationJob, job_id) if job_id is not None else None

    def _owned_item_billing_job(
        self, item: TaskItem, batch: TaskBatch
    ) -> GenerationJob | None:
        if item.billing_job_id is None:
            return None
        return self.db.scalar(
            select(GenerationJob).where(
                GenerationJob.id == item.billing_job_id,
                GenerationJob.user_id == batch.owner_user_id,
                GenerationJob.project_id == batch.project_id,
                GenerationJob.chargeable.is_(True),
            )
        )

    def _recover_expired_claims_in_transaction(
        self, now: datetime
    ) -> tuple[list[TaskItem], set[str]]:
        expired = list(
            self.db.scalars(
                select(TaskItem)
                .where(
                    TaskItem.status == "running",
                    or_(
                        TaskItem.claimed_by.is_(None),
                        TaskItem.lease_expires_at.is_(None),
                        TaskItem.lease_expires_at <= now,
                    ),
                )
                .with_for_update(skip_locked=True)
            )
        )
        batch_ids: set[str] = set()
        for item in expired:
            item.claimed_by = None
            item.lease_expires_at = None
            item.next_attempt_at = None
            job = self._generation_job_for_item(item)
            if job is not None and (
                job.status in ACTIVE_BILLING_JOB_STATUSES
                or (job.status == "billed" and job.result_visible)
            ):
                item.billing_job_id = job.id
                item.error_code = None
                item.error_message = None
                item.completed_at = None
                if job.status == "billed" and job.result_visible:
                    item.status = "queued"
                    item.attempt_count = max(0, item.attempt_count - 1)
                    item.retryable = True
                    item.provider_next_poll_at = None
                else:
                    item.status = "waiting_provider"
                    item.retryable = False
                    item.progress = max(5, item.progress)
                    item.provider_wait_started_at = item.provider_wait_started_at or now
                    item.provider_next_poll_at = now
                batch_ids.add(item.batch_id)
                continue
            item.error_code = "worker_lease_expired"
            item.error_message = "Task worker lease expired before completion"
            if item.attempt_count < item.max_attempts:
                item.status = "queued"
                item.completed_at = None
            else:
                item.status = "failed"
                item.retryable = True
                item.completed_at = now
            batch_ids.add(item.batch_id)
        return expired, batch_ids

    def _resolve_dependencies_in_transaction(self) -> set[str]:
        changed_batches: set[str] = set()
        while True:
            waiting = list(
                self.db.scalars(
                    select(TaskItem)
                    .where(TaskItem.status == "waiting_dependency")
                    .with_for_update(skip_locked=True)
                )
            )
            statuses = self._dependency_statuses([item.id for item in waiting])
            changed = False
            for item in waiting:
                dependencies = statuses.get(item.id, [])
                if any(
                    status in {"failed", "cancelled"}
                    for _, status in dependencies
                ):
                    failed_id = next(
                        dependency_id
                        for dependency_id, status in dependencies
                        if status in {"failed", "cancelled"}
                    )
                    failed_item = self.db.get(TaskItem, failed_id)
                    item.status = "failed"
                    item.retryable = True
                    if item.task_type == SHOT_VIDEO_TASK_TYPE:
                        upstream_status = (
                            failed_item.status if failed_item is not None else "failed"
                        )
                        item.error_code = (
                            "dependency_cancelled"
                            if upstream_status == "cancelled"
                            else "dependency_failed"
                        )
                        item.error_message = PREVIOUS_SHOT_MISSING_MESSAGE
                    else:
                        item.error_code = "dependency_failed"
                        item.error_message = f"Dependency {failed_id} did not complete"
                    item.completed_at = _now()
                    changed_batches.add(item.batch_id)
                    changed = True
                elif dependencies and all(
                    status == "complete" for _, status in dependencies
                ):
                    item.status = "queued"
                    item.error_code = None
                    item.error_message = None
                    item.completed_at = None
                    changed_batches.add(item.batch_id)
                    changed = True
            if not changed:
                break
            self.db.flush()
        return changed_batches

    def _owned_running_item(
        self, item_id: str, worker_id: str, attempt_count: int
    ) -> TaskItem | None:
        return self.db.scalar(
            select(TaskItem)
            .where(
                TaskItem.id == item_id,
                TaskItem.status == "running",
                TaskItem.claimed_by == worker_id,
                TaskItem.attempt_count == attempt_count,
            )
            .with_for_update()
        )

    def _refresh_batch_fields(self, batch: TaskBatch) -> None:
        items = self._items(batch.id)
        if not items:
            return
        for item in items:
            self._sync_generation_unit_item(item)
        counts = Counter(item.status for item in items)
        batch.total_items = len(items)
        batch.completed_items = counts["complete"]
        batch.failed_items = counts["failed"]
        batch.progress = sum(item.progress for item in items) // len(items)
        terminal = counts["complete"] + counts["failed"] + counts["cancelled"]
        now = _now()

        if counts["running"]:
            status = "running"
        elif counts["queued"]:
            status = "running" if terminal or batch.started_at else "queued"
        elif counts["waiting_provider"]:
            status = "waiting_provider"
        elif counts["awaiting_payment"]:
            status = "awaiting_payment"
        elif counts["waiting_dependency"]:
            status = "waiting_dependency"
        elif counts["complete"] == len(items):
            status = "complete"
        elif counts["cancelled"] == len(items):
            status = "cancelled"
        elif counts["complete"] and terminal == len(items):
            status = "partial_failure"
        elif terminal == len(items):
            status = "failed"
        else:
            status = "running"

        batch.status = status
        if status == "running":
            batch.started_at = batch.started_at or now
        if status in {"complete", "failed", "cancelled", "partial_failure"}:
            batch.completed_at = now
            if status in {"failed", "partial_failure"}:
                batch.error_code = "child_task_failed"
                batch.error_message = "One or more task items did not complete"
            else:
                batch.error_code = None
                batch.error_message = None
        else:
            batch.completed_at = None
            batch.error_code = None
            batch.error_message = None

    def _items(self, batch_id: str) -> list[TaskItem]:
        return list(
            self.db.scalars(
                select(TaskItem)
                .where(TaskItem.batch_id == batch_id)
                .order_by(TaskItem.position, TaskItem.id)
            )
        )

    def _dependency_statuses(
        self, item_ids: list[str]
    ) -> dict[str, list[tuple[str, str]]]:
        if not item_ids:
            return {}
        dependency = aliased(TaskItem)
        rows = self.db.execute(
            select(
                TaskDependency.task_item_id,
                TaskDependency.depends_on_item_id,
                dependency.status,
            )
            .join(
                dependency,
                (dependency.id == TaskDependency.depends_on_item_id)
                & (dependency.batch_id == TaskDependency.batch_id),
            )
            .where(TaskDependency.task_item_id.in_(item_ids))
            .order_by(TaskDependency.created_at, TaskDependency.depends_on_item_id)
        )
        result: dict[str, list[tuple[str, str]]] = defaultdict(list)
        for item_id, dependency_id, status in rows:
            result[item_id].append((dependency_id, status))
        return result

    def _dependency_descendant_ids(self, batch_id: str, item_id: str) -> list[str]:
        descendants: list[str] = []
        frontier = [item_id]
        seen = {item_id}
        while frontier:
            child_ids = list(
                self.db.scalars(
                    select(TaskDependency.task_item_id).where(
                        TaskDependency.batch_id == batch_id,
                        TaskDependency.depends_on_item_id.in_(frontier),
                    )
                )
            )
            frontier = [child_id for child_id in child_ids if child_id not in seen]
            seen.update(frontier)
            descendants.extend(frontier)
        return descendants

    def _item_response(
        self,
        item: TaskItem,
        dependency_map: dict[str, list[tuple[str, str]]],
    ) -> TaskItemResponse:
        fresh_generation_retry = False
        if (
            item.status == "failed"
            and item.task_type == GENERATION_UNIT_VIDEO_TASK_TYPE
        ):
            batch = self.db.get(TaskBatch, item.batch_id)
            billing_job = self._generation_job_for_item(item)
            fresh_generation_retry = bool(
                batch is not None
                and self._rotatable_failed_generation_unit(
                    item=item,
                    batch=batch,
                    billing_job=billing_job,
                    lock=False,
                    strict=False,
                )
            )
        return TaskItemResponse(
            id=item.id,
            batch_id=item.batch_id,
            position=item.position,
            task_type=item.task_type,
            status=item.status,
            idempotency_key=item.idempotency_key,
            snapshot_version=item.snapshot_version,
            project_version=item.project_version,
            input=item.input_snapshot,
            references=item.reference_snapshot,
            model=item.model,
            target_entity_type=item.target_entity_type,
            target_entity_id=item.target_entity_id,
            target_entity_version=item.target_entity_version,
            attempt_count=item.attempt_count,
            max_attempts=item.max_attempts,
            progress=item.progress,
            retryable=(item.retryable and item.attempt_count < 10)
            or fresh_generation_retry,
            error_code=item.error_code,
            error_message=item.error_message,
            result=item.result_snapshot,
            billing_job_id=item.billing_job_id,
            settlement_key=item.settlement_key,
            generation_key=item.generation_key,
            generation_revision=item.generation_revision,
            provider_wait_started_at=item.provider_wait_started_at,
            provider_next_poll_at=item.provider_next_poll_at,
            provider_poll_count=item.provider_poll_count,
            dependencies=[
                TaskDependencyResponse(item_id=dependency_id, status=status)
                for dependency_id, status in dependency_map.get(item.id, [])
            ],
            created_at=item.created_at,
            updated_at=item.updated_at,
        )

    def _emit_batch(self, batch: TaskBatch, message: str) -> None:
        if self.events is not None:
            self.events.emit_task(
                batch.project_id,
                task_id=batch.id,
                status=batch.status,
                progress=batch.progress,
                message=message,
            )

    def _emit_item(self, batch: TaskBatch, item: TaskItem, message: str) -> None:
        if self.events is not None:
            self.events.emit_task(
                batch.project_id,
                task_id=batch.id,
                item_id=item.id,
                status=item.status,
                progress=item.progress,
                message=message,
            )

    def _emit_dependency_changes(self, batch: TaskBatch, message: str) -> None:
        self._emit_batch(batch, message)
        for item in self._items(batch.id):
            if item.status in {"queued", "failed"}:
                self._emit_item(batch, item, message)

    def _validate_claim_billing_job(
        self,
        item: TaskItem,
        batch: TaskBatch,
        billing_job_id: str,
    ) -> GenerationJob:
        if item.billing_job_id is not None and item.billing_job_id != billing_job_id:
            self.db.rollback()
            raise TaskStateError(
                "task_billing_job_conflict",
                "Task item is already bound to another billing job",
            )
        job = self.db.scalar(
            select(GenerationJob).where(
                GenerationJob.id == billing_job_id,
                GenerationJob.user_id == batch.owner_user_id,
                GenerationJob.project_id == batch.project_id,
                GenerationJob.chargeable.is_(True),
            )
        )
        expected_operation = None
        if item.task_type == SHOT_VIDEO_TASK_TYPE and item.target_entity_id:
            expected_operation = f"shot:{item.target_entity_id}"
        elif (
            item.task_type == GENERATION_UNIT_VIDEO_TASK_TYPE
            and item.target_entity_id
            and item.target_entity_version is not None
        ):
            expected_operation = (
                f"generation_unit:{item.target_entity_id}:"
                f"v{item.target_entity_version}"
            )
        if (
            job is None
            or (item.model is not None and job.model != item.model)
            or (expected_operation is not None and job.operation != expected_operation)
            or (item.task_type in VIDEO_TASK_TYPES and job.capability != "video")
            or (
                item.task_type in VIDEO_TASK_TYPES
                and (job.provider_method != "POST" or job.provider_route != "/v1/videos")
            )
        ):
            self.db.rollback()
            raise TaskStateError(
                "task_billing_job_invalid",
                "Task billing job does not match the task owner, project, operation, model, and route",
            )
        claimed_elsewhere = self.db.scalar(
            select(TaskItem.id).where(
                TaskItem.billing_job_id == billing_job_id,
                TaskItem.id != item.id,
            )
        )
        if claimed_elsewhere is not None:
            self.db.rollback()
            raise TaskStateError(
                "task_billing_job_claimed",
                "Billing job is already bound to another task item",
            )
        return job

    def _sync_generation_unit_item(self, item: TaskItem) -> None:
        if (
            item.task_type != GENERATION_UNIT_VIDEO_TASK_TYPE
            or item.target_entity_type != "generation_unit"
            or item.target_entity_id is None
            or item.target_entity_version is None
        ):
            return
        from server.app.generation_units.models import VideoGenerationUnit

        unit = self.db.get(
            VideoGenerationUnit,
            (
                self.db.scalar(
                    select(TaskBatch.project_id).where(TaskBatch.id == item.batch_id)
                ),
                item.target_entity_id,
                item.target_entity_version,
            ),
        )
        if unit is None:
            return
        if item.generation_key != unit.execution_key:
            raise TaskStateError(
                "generation_unit_execution_key_mismatch",
                "Task generation key does not match the generation unit revision",
            )
        unit.task_item_id = item.id
        if item.billing_job_id is not None:
            unit.billing_job_id = item.billing_job_id
        if unit.status == "complete" and unit.active and item.status != "complete":
            return
        unit.status = {
            "running": "running",
            "waiting_provider": "waiting_provider",
            "complete": "complete",
            "failed": "failed",
            "cancelled": "failed",
        }.get(item.status, "queued")


def _request_hash(request: TaskSubmitRequest) -> str:
    encoded = json.dumps(
        request.model_dump(mode="json"),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _claim_from(item: TaskItem, batch: TaskBatch, worker_id: str) -> TaskClaim:
    return TaskClaim(
        item_id=item.id,
        batch_id=item.batch_id,
        owner_user_id=batch.owner_user_id,
        project_id=batch.project_id,
        task_type=item.task_type,
        input_snapshot=item.input_snapshot,
        reference_snapshot=item.reference_snapshot,
        model=item.model,
        project_version=item.project_version,
        snapshot_version=item.snapshot_version,
        target_entity_type=item.target_entity_type,
        target_entity_id=item.target_entity_id,
        target_entity_version=item.target_entity_version,
        attempt_count=item.attempt_count,
        billing_job_id=item.billing_job_id,
        settlement_key=item.settlement_key,
        generation_key=item.generation_key,
        claimed_by=worker_id,
        batch_snapshot=dict(batch.request_snapshot.get("snapshot") or {}),
    )


def _now() -> datetime:
    return datetime.now(timezone.utc)
