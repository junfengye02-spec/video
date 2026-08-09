from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from server.app.billing.models import BillingWorkerHeartbeat


class BillingReconciliationUnavailable(RuntimeError):
    pass


class BillingWorkerAlreadyRunning(RuntimeError):
    pass


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def record_worker_heartbeat(
    db: Session,
    *,
    worker_id: str,
    now: datetime,
    ttl_seconds: int,
) -> None:
    if not worker_id or len(worker_id) > 64:
        raise ValueError("billing worker identifier is invalid")
    if type(ttl_seconds) is not int or ttl_seconds <= 0:
        raise ValueError("billing worker heartbeat TTL must be positive")
    current = db.scalar(
        select(BillingWorkerHeartbeat)
        .where(BillingWorkerHeartbeat.id == 1)
        .with_for_update()
    )
    normalized_now = _aware(now)
    if (
        current is not None
        and current.worker_id != worker_id
        and _aware(current.lease_expires_at) > normalized_now
    ):
        db.rollback()
        raise BillingWorkerAlreadyRunning("another billing worker owns the active lease")
    if current is None:
        current = BillingWorkerHeartbeat(
            id=1,
            worker_id=worker_id,
            started_at=normalized_now,
            heartbeat_at=normalized_now,
            lease_expires_at=normalized_now + timedelta(seconds=ttl_seconds),
        )
        db.add(current)
    else:
        if current.worker_id != worker_id:
            current.started_at = normalized_now
        current.worker_id = worker_id
        current.heartbeat_at = normalized_now
        current.lease_expires_at = normalized_now + timedelta(seconds=ttl_seconds)
    db.commit()


def release_worker_heartbeat(db: Session, *, worker_id: str, now: datetime) -> bool:
    current = db.scalar(
        select(BillingWorkerHeartbeat)
        .where(BillingWorkerHeartbeat.id == 1)
        .with_for_update()
    )
    if current is None or current.worker_id != worker_id:
        db.rollback()
        return False
    current.heartbeat_at = _aware(now)
    current.lease_expires_at = _aware(now)
    db.commit()
    return True


def billing_worker_is_healthy(db: Session, *, now: datetime | None = None) -> bool:
    current = db.get(BillingWorkerHeartbeat, 1)
    if current is None:
        return False
    checked_at = _aware(now or datetime.now(timezone.utc))
    return _aware(current.lease_expires_at) > checked_at


def require_billing_worker_healthy(db: Session, settings) -> None:
    # Unit and integration tests run reconciliation deterministically in-process.
    if getattr(settings, "environment", None) == "test":
        return
    if not billing_worker_is_healthy(db):
        raise BillingReconciliationUnavailable(
            "billing reconciliation worker heartbeat is missing or stale"
        )
