from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Literal

from sqlalchemy import exists, func, or_, select
from sqlalchemy.orm import Session

from server.app.billing.models import (
    BillingReconciliation,
    CostReceipt,
    GenerationJob,
)
from server.app.billing.lease import (
    FencedReconciliationClaim,
    ReconciliationClaimLost,
    claim_reconciliation,
    reschedule_claim,
    resolve_claim,
)
from server.app.billing.service import BillingService, InvalidBillingState
from server.app.core.config import get_settings
from server.app.payments.models import PaymentOrder
from server.app.provider.newapi import (
    CapabilityAliasUnavailable,
    NewApiClient,
    NewApiError,
    ReceiptNotFound,
    UsageReceipt,
)
from server.app.provider.video_recovery import (
    InvalidVideoArtifact,
    publish_billed_video_result,
    reduce_video_parent_for_child,
    resume_billed_video_job,
)
from server.app.settings import DEFAULT_PROJECTS_ROOT
from server.app.storage import WorkbenchStore
from server.app.tasks.service import TaskService
from server.app.wallet.models import WalletHold


_MACHINE_REASONS = {
    "reference_recovery",
    "provider_completion",
    "receipt_pending",
    "upstream_refund_pending",
}
_RETRY_SECONDS = (5, 15, 30, 60)
_CLAIM_LEASE_SECONDS = 300
_SECRET_PATTERN = re.compile(
    r"(?i)(?:bearer|token|key|secret|authorization)(?:\s+|\s*[:=]\s*)[^\s,;]+"
)


@dataclass(frozen=True, slots=True)
class JobSnapshot:
    id: str
    status: str
    capability: str
    token_kind: str
    token_alias: str
    quote_id: str
    provider_reference_type: str | None
    provider_reference_id: str | None
    reference_deadline: datetime
    receipt_deadline: datetime
    result_staged: bool
    model: str
    quote_quota_per_unit: Decimal
    quote_pricing_version: str


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _snapshot_job(db: Session, job_id: str) -> JobSnapshot:
    job = db.get(GenerationJob, job_id)
    if (
        job is None
        or not job.chargeable
        or job.capability is None
        or job.token_kind is None
        or job.token_alias is None
        or job.quote_id is None
        or job.reference_deadline is None
        or job.receipt_deadline is None
        or job.model is None
        or job.quote_quota_per_unit is None
        or job.quote_pricing_version is None
    ):
        db.rollback()
        raise InvalidBillingState("reconciliation job is invalid")
    snapshot = JobSnapshot(
        id=job.id,
        status=job.status,
        capability=job.capability,
        token_kind=job.token_kind,
        token_alias=job.token_alias,
        quote_id=job.quote_id,
        provider_reference_type=job.provider_reference_type,
        provider_reference_id=job.provider_reference_id,
        reference_deadline=_aware(job.reference_deadline),
        receipt_deadline=_aware(job.receipt_deadline),
        result_staged=job.result_staged,
        model=job.model,
        quote_quota_per_unit=job.quote_quota_per_unit,
        quote_pricing_version=job.quote_pricing_version,
    )
    db.commit()
    return snapshot


def recover_provider_reference(
    db: Session,
    client: NewApiClient,
    job_id: str,
    now: datetime,
    *,
    settings=None,
    claim: FencedReconciliationClaim | None = None,
) -> Literal["pending", "recovered", "undeliverable", "terminal"]:
    settings = settings or get_settings()
    snapshot = _snapshot_job(db, job_id)
    if snapshot.provider_reference_id is not None:
        return "recovered"
    if snapshot.status not in {
        "reserved",
        "submitted_ambiguous",
        "reference_recovery_pending",
    }:
        raise InvalidBillingState("job is not awaiting reference recovery")
    try:
        quote_status = client.get_quote_status(
            snapshot.token_kind,
            snapshot.token_alias,
            snapshot.quote_id,
        )
    except CapabilityAliasUnavailable as exc:
        if _aware(now) > snapshot.reference_deadline:
            BillingService(db, settings, _unavailable_artifact).fail_unsubmitted(
                snapshot.id,
                "provider_reference_missing_no_charge",
                operator_error=_sanitize_error(exc),
                claim=claim,
            )
            return "terminal"
        raise
    except NewApiError:
        if _aware(now) > snapshot.reference_deadline:
            BillingService(db, settings, _unavailable_artifact).fail_unsubmitted(
                snapshot.id,
                "provider_reference_missing_no_charge",
                claim=claim,
            )
            return "terminal"
        raise

    service = BillingService(db, settings, _unavailable_artifact)
    reference = (quote_status.reference_type, quote_status.reference_id)
    if quote_status.status in {"quoted", "expired"}:
        if reference != (None, None):
            raise InvalidBillingState("unconsumed quote exposed a reference")
        if (
            quote_status.status == "quoted"
            and _aware(now).timestamp() < quote_status.expires_at
        ):
            return "pending"
        service.fail_unsubmitted(
            snapshot.id, "provider_not_submitted_no_charge", claim=claim
        )
        return "terminal"
    if quote_status.status == "failed":
        if reference != (None, None):
            if _aware(now) > snapshot.reference_deadline:
                service.fail_unsubmitted(
                    snapshot.id,
                    "provider_reference_missing_no_charge",
                    claim=claim,
                )
                return "terminal"
            raise InvalidBillingState("failed quote exposed a reference")
        service.fail_unsubmitted(
            snapshot.id, "provider_rejected_no_charge", claim=claim
        )
        return "terminal"
    expected_type = "task" if snapshot.capability == "video" else "request"
    if (
        quote_status.status not in {"consuming", "accepted"}
        or quote_status.reference_type != expected_type
        or quote_status.reference_id is None
    ):
        if _aware(now) > snapshot.reference_deadline:
            service.fail_unsubmitted(
                snapshot.id,
                "provider_reference_missing_no_charge",
                claim=claim,
            )
            return "terminal"
        raise InvalidBillingState("provider quote status is inconsistent")
    if snapshot.capability == "video":
        service.bind_provider_reference(
            snapshot.id,
            quote_status.reference_type,
            quote_status.reference_id,
            claim=claim,
        )
        service.mark_receipt_pending(snapshot.id, claim=claim)
        return "recovered"
    service.fail_undeliverable_sync_call(
        snapshot.id,
        quote_status.reference_type,
        quote_status.reference_id,
        claim=claim,
    )
    return "undeliverable"


def _unavailable_artifact(_locator: str):
    raise ValueError("artifact inspection is unavailable")


def _receipt_for(client: NewApiClient, snapshot: JobSnapshot) -> UsageReceipt:
    if snapshot.provider_reference_type == "task":
        return client.get_task_receipt(
            snapshot.token_kind,
            snapshot.token_alias,
            snapshot.provider_reference_id,
        )
    if snapshot.provider_reference_type == "request":
        return client.get_request_receipt(
            snapshot.token_kind,
            snapshot.token_alias,
            snapshot.provider_reference_id,
        )
    raise InvalidBillingState("receipt polling requires a provider reference")


def _validate_delayed_refund(snapshot: JobSnapshot, receipt: UsageReceipt) -> None:
    if (
        receipt.status not in {"refunded", "not_chargeable"}
        or receipt.reference_type != snapshot.provider_reference_type
        or receipt.reference_id != snapshot.provider_reference_id
        or receipt.model != snapshot.model
        or receipt.quota_per_unit != snapshot.quote_quota_per_unit
        or receipt.pricing_version != snapshot.quote_pricing_version
        or receipt.cost_amount_micro != 0
        or receipt.settled_at is None
    ):
        raise InvalidBillingState("delayed refund receipt is inconsistent")


def reconcile_job_now(
    db: Session,
    client: NewApiClient,
    job_id: str,
    now: datetime,
    *,
    settings=None,
    media_store: WorkbenchStore | None = None,
    claim: FencedReconciliationClaim | None = None,
) -> Literal["pending", "completed"]:
    settings = settings or get_settings()
    media_store = media_store or WorkbenchStore(projects_root=DEFAULT_PROJECTS_ROOT)
    snapshot = _snapshot_job(db, job_id)
    recovered_sync = False
    if snapshot.provider_reference_id is None:
        outcome = recover_provider_reference(
            db, client, job_id, now, settings=settings, claim=claim
        )
        if outcome == "pending":
            return "pending"
        if outcome == "terminal":
            return "completed"
        recovered_sync = outcome == "undeliverable"
        snapshot = _snapshot_job(db, job_id)

    stored_receipt_status = db.scalar(
        select(CostReceipt.status).where(CostReceipt.job_id == job_id)
    )
    db.commit()
    refund_pending = stored_receipt_status == "refund_pending"
    recovered_sync_accounting = (
        snapshot.status == "provider_result_missing_no_charge"
        and snapshot.provider_reference_type == "request"
        and stored_receipt_status is None
    )
    if snapshot.status in {
        "billed",
        "payment_required",
        "receipt_missing_no_charge",
        "provider_reference_missing_no_charge",
        "provider_not_submitted_no_charge",
        "provider_rejected_no_charge",
    }:
        if snapshot.status == "billed" and snapshot.capability == "video":
            publish_billed_video_result(
                db, snapshot.id, media_store, claim=claim
            )
        return "completed"
    if (
        snapshot.status.endswith("_no_charge")
        and not refund_pending
        and not recovered_sync
        and not recovered_sync_accounting
    ):
        return "completed"

    task_outcome = None
    if (
        snapshot.provider_reference_type == "task"
        and not snapshot.result_staged
        and not refund_pending
    ):
        try:
            task_outcome = resume_billed_video_job(
                db,
                client,
                snapshot.id,
                media_store,
                settings=settings,
                claim=claim,
            )
        except CapabilityAliasUnavailable as exc:
            if _aware(now) > snapshot.receipt_deadline:
                BillingService(
                    db, settings, media_store.inspect_staged_artifact
                ).fail_missing_result(
                    snapshot.id,
                    operator_error=_sanitize_error(exc),
                    claim=claim,
                )
                return "completed"
            raise
        except (NewApiError, InvalidVideoArtifact, OSError, ValueError):
            if _aware(now) > snapshot.receipt_deadline:
                BillingService(
                    db, settings, media_store.inspect_staged_artifact
                ).fail_missing_result(snapshot.id, claim=claim)
                return "completed"
            raise
        if task_outcome == "pending":
            return "pending"
        snapshot = _snapshot_job(db, job_id)

    try:
        final_receipt = _receipt_for(client, snapshot)
    except CapabilityAliasUnavailable as exc:
        if _aware(now) > snapshot.receipt_deadline:
            service = BillingService(
                db, settings, media_store.inspect_staged_artifact
            )
            if recovered_sync_accounting:
                service.record_provider_configuration_unavailable(
                    snapshot.id, _sanitize_error(exc)
                )
            else:
                service.fail_missing_receipt(
                    snapshot.id,
                    operator_error=_sanitize_error(exc),
                    claim=claim,
                )
            return "completed"
        raise
    except (ReceiptNotFound, NewApiError, ValueError):
        if recovered_sync_accounting:
            raise
        if _aware(now) > snapshot.receipt_deadline:
            BillingService(
                db, settings, media_store.inspect_staged_artifact
            ).fail_missing_receipt(snapshot.id, claim=claim)
            return "completed"
        raise

    if refund_pending:
        if final_receipt.status == "refund_pending":
            return "pending"
        _validate_delayed_refund(snapshot, final_receipt)
        return "completed"
    if final_receipt.status == "pending":
        if recovered_sync_accounting:
            return "pending"
        BillingService(
            db, settings, media_store.inspect_staged_artifact
        ).settle_job(snapshot.id, final_receipt, claim=claim)
        if _aware(now) > snapshot.receipt_deadline:
            BillingService(
                db, settings, media_store.inspect_staged_artifact
            ).fail_missing_receipt(snapshot.id, claim=claim)
            return "completed"
        return "pending"

    try:
        BillingService(
            db, settings, media_store.inspect_staged_artifact
        ).settle_job(snapshot.id, final_receipt, claim=claim)
    except InvalidBillingState:
        if _aware(now) > snapshot.receipt_deadline:
            BillingService(
                db, settings, media_store.inspect_staged_artifact
            ).fail_missing_receipt(snapshot.id, claim=claim)
            return "completed"
        raise
    if task_outcome == "failed" and final_receipt.status == "settled":
        if _aware(now) > snapshot.receipt_deadline:
            BillingService(
                db, settings, media_store.inspect_staged_artifact
            ).fail_missing_result(snapshot.id, claim=claim)
            return "completed"
        return "pending"
    if final_receipt.status == "settled" and snapshot.capability == "video":
        publish_billed_video_result(db, snapshot.id, media_store, claim=claim)
    return "pending" if final_receipt.status == "refund_pending" else "completed"


def _reason_for(job: GenerationJob) -> str | None:
    if job.provider_reference_id is None and job.status == "reserved":
        return "provider_completion"
    if job.provider_reference_id is None and job.status in {
        "submitted_ambiguous",
        "reference_recovery_pending",
    }:
        return "reference_recovery"
    if job.provider_reference_id is None:
        return None
    if (
        job.status == "provider_result_missing_no_charge"
        and job.provider_reference_type == "request"
    ):
        return "receipt_pending"
    if job.status not in {
        "reserved",
        "reference_recovery_pending",
        "receipt_pending",
        "result_pending",
    }:
        return None
    if job.provider_reference_type == "task" and not job.result_staged:
        return "provider_completion"
    return "receipt_pending"


def _expire_non_network_work(
    db: Session,
    now: datetime,
    settings,
    media_store: WorkbenchStore,
) -> None:
    expired_orders = db.scalars(
        select(PaymentOrder)
        .where(PaymentOrder.status == "pending", PaymentOrder.expires_at <= now)
        .with_for_update(skip_locked=True)
    ).all()
    for order in expired_orders:
        order.status = "expired"
    expired_quotes = db.scalars(
        select(GenerationJob.id)
        .join(WalletHold, WalletHold.job_id == GenerationJob.id)
        .where(
            GenerationJob.status == "payment_required_quote",
            WalletHold.status == "active",
            WalletHold.expires_at <= now,
        )
        .with_for_update(skip_locked=True)
    ).all()
    db.commit()
    for job_id in expired_quotes:
        BillingService(db, settings, _unavailable_artifact).fail_unsubmitted(
            job_id, "provider_not_submitted_no_charge"
        )
        reduce_video_parent_for_child(db, job_id, media_store)
        db.commit()


def _ensure_reconciliations(db: Session, limit: int) -> None:
    has_open_machine_row = exists(
        select(BillingReconciliation.id).where(
            BillingReconciliation.job_id == GenerationJob.id,
            BillingReconciliation.status == "open",
            BillingReconciliation.reason.in_(_MACHINE_REASONS),
        )
    )
    has_stored_receipt = exists(
        select(CostReceipt.id).where(CostReceipt.job_id == GenerationJob.id)
    )
    jobs = db.scalars(
        select(GenerationJob)
        .where(
            GenerationJob.chargeable.is_(True),
            or_(
                GenerationJob.status.in_(
                    {
                        "submitted_ambiguous",
                        "reference_recovery_pending",
                        "reserved",
                        "receipt_pending",
                        "result_pending",
                    }
                ),
                (
                    (GenerationJob.status == "provider_result_missing_no_charge")
                    & (GenerationJob.provider_reference_type == "request")
                    & ~has_stored_receipt
                ),
            ),
            ~has_open_machine_row,
        )
        .order_by(GenerationJob.created_at, GenerationJob.id)
        .limit(limit)
        .with_for_update(skip_locked=True)
    ).all()
    for job in jobs:
        reason = _reason_for(job)
        if reason is None:
            continue
        existing = db.scalar(
            select(BillingReconciliation.id).where(
                BillingReconciliation.job_id == job.id,
                BillingReconciliation.status == "open",
                BillingReconciliation.reason.in_(_MACHINE_REASONS),
            )
        )
        if existing is None:
            db.add(
                BillingReconciliation(
                    id=uuid.uuid4().hex,
                    job_id=job.id,
                    reason=reason,
                    status="open",
                    attempts=0,
                    next_retry_at=None,
                )
            )
    db.commit()


def _sanitize_error(error: Exception) -> str:
    message = _SECRET_PATTERN.sub(
        "[redacted]", str(error).replace("\r", " ").replace("\n", " ")
    )
    return f"{type(error).__name__}: {message}"[:500]


def _retry_delay(attempts: int) -> int:
    return _RETRY_SECONDS[attempts - 1] if attempts <= len(_RETRY_SECONDS) else 300


def resume_reconcile_publish_job(
    db: Session,
    client: NewApiClient,
    job_id: str,
    now: datetime,
    *,
    settings=None,
    media_store: WorkbenchStore | None = None,
    claim: FencedReconciliationClaim | None = None,
    pending_delay_seconds: int | None = None,
) -> Literal["pending", "completed"]:
    settings = settings or get_settings()
    media_store = media_store or WorkbenchStore(
        projects_root=DEFAULT_PROJECTS_ROOT
    )
    claim = claim or claim_reconciliation(
        db,
        job_id=job_id,
        reason="provider_completion",
        lease_seconds=_CLAIM_LEASE_SECONDS,
    )
    if claim is None:
        return "pending"
    try:
        outcome = reconcile_job_now(
            db,
            client,
            job_id,
            now,
            settings=settings,
            media_store=media_store,
            claim=claim,
        )
    except Exception as exc:
        reschedule_claim(
            db,
            claim,
            delay_seconds=_retry_delay(claim.generation),
            last_error=_sanitize_error(exc),
        )
        raise
    if outcome == "completed":
        reduce_video_parent_for_child(db, job_id, media_store)
        db.commit()
    retry_delay = (
        _retry_delay(claim.generation)
        if pending_delay_seconds is None
        else pending_delay_seconds
    )
    updated = (
        resolve_claim(db, claim)
        if outcome == "completed"
        else reschedule_claim(db, claim, delay_seconds=retry_delay)
    )
    if not updated:
        raise ReconciliationClaimLost(
            "provider reconciliation ownership was lost"
        )
    _sync_provider_waiting_tasks(db, claim, outcome)
    return outcome


def _sync_provider_waiting_tasks(
    db: Session,
    claim: FencedReconciliationClaim,
    outcome: Literal["pending", "completed"],
) -> None:
    """Reflect a fenced reconciliation result after its claim update commits."""
    tasks = TaskService(db)
    if outcome == "pending":
        next_poll_at = db.scalar(
            select(BillingReconciliation.next_retry_at).where(
                BillingReconciliation.id == claim.row_id,
                BillingReconciliation.job_id == claim.job_id,
            )
        )
        db.commit()
        tasks.record_provider_poll(claim.job_id, next_poll_at=next_poll_at)
        return

    state = db.execute(
        select(GenerationJob.status, GenerationJob.result_visible).where(
            GenerationJob.id == claim.job_id
        )
    ).first()
    db.commit()
    if state is None:
        return
    if state.status == "billed" and state.result_visible:
        tasks.resume_provider_result(claim.job_id)
    elif state.status.endswith("_no_charge"):
        tasks.fail_provider_wait(
            claim.job_id,
            error_code=state.status,
            error_message="Video provider generation ended without a charge",
        )


def reconcile_due_jobs(
    db: Session,
    client: NewApiClient,
    now: datetime,
    limit: int,
    *,
    settings=None,
    media_store: WorkbenchStore | None = None,
) -> int:
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("reconciliation limit must be between 1 and 100")
    settings = settings or get_settings()
    media_store = media_store or WorkbenchStore(projects_root=DEFAULT_PROJECTS_ROOT)
    _expire_non_network_work(db, now, settings, media_store)
    _ensure_reconciliations(db, limit)

    processed = 0
    for _index in range(limit):
        candidate = db.execute(
            select(
                BillingReconciliation.job_id,
                BillingReconciliation.reason,
            )
            .where(
                BillingReconciliation.status == "open",
                BillingReconciliation.reason.in_(_MACHINE_REASONS),
                or_(
                    BillingReconciliation.next_retry_at.is_(None),
                    BillingReconciliation.next_retry_at
                    <= func.current_timestamp(),
                ),
            )
            .order_by(BillingReconciliation.next_retry_at, BillingReconciliation.id)
            .limit(1)
        ).first()
        db.commit()
        if candidate is None:
            break
        claim = claim_reconciliation(
            db,
            job_id=candidate.job_id,
            reason=candidate.reason,
            lease_seconds=_CLAIM_LEASE_SECONDS,
        )
        if claim is None:
            db.rollback()
            continue

        try:
            resume_reconcile_publish_job(
                db,
                client,
                claim.job_id,
                now,
                settings=settings,
                media_store=media_store,
                claim=claim,
            )
        except Exception:
            db.rollback()
        processed += 1
    return processed
