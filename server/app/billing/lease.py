from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import uuid

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from server.app.billing.models import BillingReconciliation, GenerationJob


_MACHINE_REASONS = {
    "reference_recovery",
    "provider_completion",
    "receipt_pending",
    "upstream_refund_pending",
}


@dataclass(frozen=True, slots=True)
class FencedReconciliationClaim:
    row_id: str
    job_id: str
    reason: str
    generation: int


class ReconciliationClaimLost(RuntimeError):
    pass


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def database_now(db: Session) -> datetime:
    value = db.scalar(select(func.current_timestamp()))
    if not isinstance(value, datetime):
        raise RuntimeError("database clock is unavailable")
    return _aware(value)


def claim_reconciliation(
    db: Session,
    *,
    job_id: str,
    reason: str,
    lease_seconds: int = 300,
    require_due: bool = True,
) -> FencedReconciliationClaim | None:
    if type(lease_seconds) is not int or lease_seconds <= 0:
        raise ValueError("reconciliation lease must be positive")
    try:
        job = db.scalar(
            select(GenerationJob)
            .where(GenerationJob.id == job_id)
            .with_for_update()
        )
        if job is None or not job.chargeable:
            raise ValueError("reconciliation job is invalid")
        reasons = _MACHINE_REASONS if reason in _MACHINE_REASONS else {reason}
        rows = db.scalars(
            select(BillingReconciliation)
            .where(
                BillingReconciliation.job_id == job_id,
                BillingReconciliation.reason.in_(reasons),
            )
            .with_for_update()
        ).all()
        row = next((item for item in rows if item.status == "open"), None)
        if row is None:
            row = next((item for item in rows if item.reason == reason), None)
        if row is None and rows:
            row = rows[0]
        for duplicate in rows:
            if duplicate is not row and duplicate.status == "open":
                duplicate.status = "resolved"
                duplicate.next_retry_at = None
                duplicate.last_error = None
        if row is None:
            row = BillingReconciliation(
                id=uuid.uuid4().hex,
                job_id=job_id,
                reason=reason,
                status="open",
                attempts=0,
            )
            db.add(row)
            db.flush()
        now = database_now(db)
        if row.status == "resolved":
            row.status = "open"
            row.next_retry_at = None
        elif row.status != "open":
            db.commit()
            return None
        if (
            require_due
            and row.next_retry_at is not None
            and _aware(row.next_retry_at) > now
        ):
            db.commit()
            return None
        row.attempts += 1
        row.next_retry_at = now + timedelta(seconds=lease_seconds)
        row.last_error = None
        claim = FencedReconciliationClaim(
            row.id, row.job_id, row.reason, row.attempts
        )
        db.commit()
        return claim
    except Exception:
        db.rollback()
        raise


def _cas_claim(
    db: Session,
    claim: FencedReconciliationClaim,
    values: dict,
) -> bool:
    result = db.execute(
        update(BillingReconciliation)
        .where(
            BillingReconciliation.id == claim.row_id,
            BillingReconciliation.job_id == claim.job_id,
            BillingReconciliation.reason == claim.reason,
            BillingReconciliation.status == "open",
            BillingReconciliation.attempts == claim.generation,
            BillingReconciliation.next_retry_at.is_not(None),
            BillingReconciliation.next_retry_at > func.current_timestamp(),
        )
        .values(**values)
    )
    db.commit()
    return result.rowcount == 1


def heartbeat_claim(
    db: Session,
    claim: FencedReconciliationClaim,
    *,
    lease_seconds: int = 300,
) -> bool:
    if type(lease_seconds) is not int or lease_seconds <= 0:
        raise ValueError("reconciliation lease must be positive")
    now = database_now(db)
    return _cas_claim(
        db,
        claim,
        {"next_retry_at": now + timedelta(seconds=lease_seconds)},
    )


def reschedule_claim(
    db: Session,
    claim: FencedReconciliationClaim,
    *,
    delay_seconds: int,
    last_error: str | None = None,
) -> bool:
    if type(delay_seconds) is not int or delay_seconds < 0:
        raise ValueError("reconciliation retry delay cannot be negative")
    now = database_now(db)
    retry_at = (
        now - timedelta(microseconds=1)
        if delay_seconds == 0
        else now + timedelta(seconds=delay_seconds)
    )
    return _cas_claim(
        db,
        claim,
        {
            "next_retry_at": retry_at,
            "last_error": last_error,
        },
    )


def resolve_claim(db: Session, claim: FencedReconciliationClaim) -> bool:
    return _cas_claim(
        db,
        claim,
        {"status": "resolved", "next_retry_at": None, "last_error": None},
    )


def claim_is_owned(db: Session, claim: FencedReconciliationClaim) -> bool:
    owned = db.scalar(
        select(BillingReconciliation.id).where(
            BillingReconciliation.id == claim.row_id,
            BillingReconciliation.job_id == claim.job_id,
            BillingReconciliation.reason == claim.reason,
            BillingReconciliation.status == "open",
            BillingReconciliation.attempts == claim.generation,
            BillingReconciliation.next_retry_at.is_not(None),
            BillingReconciliation.next_retry_at > func.current_timestamp(),
        )
    )
    db.commit()
    return owned is not None
