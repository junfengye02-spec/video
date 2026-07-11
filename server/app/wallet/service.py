from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from server.app.billing.models import GenerationJob
from server.app.wallet.models import WalletAccount, WalletEntry, WalletHold


class WalletNotFound(RuntimeError):
    pass


class InvalidHoldOwner(RuntimeError):
    pass


class InvalidChargeableJob(RuntimeError):
    pass


class HoldConflict(RuntimeError):
    pass


class InsufficientBalance(RuntimeError):
    pass


class InvalidHoldState(RuntimeError):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _require_positive_units(value: int, *, label: str) -> None:
    if type(value) is not int or value <= 0:
        raise ValueError(f"{label} must be a positive integer")


def _has_complete_positive_quote(job: GenerationJob) -> bool:
    positive_values = (
        job.multiplier_bps,
        job.quote_estimated_quota,
        job.quote_estimated_provider_cost_micro,
        job.quote_quota_per_unit,
    )
    required_strings = (
        job.token_kind,
        job.token_alias,
        job.model,
        job.quote_id,
        job.quote_pricing_version,
        job.quote_other_ratios_json,
        job.quote_billing_fingerprint,
    )
    return (
        job.chargeable is True
        and job.quote_expires_at is not None
        and all(value is not None and value > 0 for value in positive_values)
        and all(isinstance(value, str) and bool(value) for value in required_strings)
    )


def _insert_credit_entry_once(
    db: Session,
    *,
    entry_id: str,
    wallet: WalletAccount,
    user_id: str,
    amount_units: int,
    kind: str,
    source_id: str,
    idempotency_key: str,
) -> bool:
    dialect_name = db.get_bind().dialect.name
    if dialect_name == "postgresql":
        insert_statement = postgresql_insert(WalletEntry)
    elif dialect_name == "sqlite":
        insert_statement = sqlite_insert(WalletEntry)
    else:
        raise RuntimeError(f"unsupported wallet database dialect: {dialect_name}")

    statement = (
        insert_statement.values(
            id=entry_id,
            wallet_id=wallet.id,
            user_id=user_id,
            amount_units=amount_units,
            balance_after_units=wallet.balance_units + amount_units,
            kind=kind,
            source_type="payment_order" if kind == "topup" else kind,
            source_id=source_id,
            idempotency_key=idempotency_key,
        )
        .on_conflict_do_nothing(index_elements=[WalletEntry.idempotency_key])
        .returning(WalletEntry.id)
    )
    return db.scalar(statement) == entry_id


def create_hold(
    db: Session,
    *,
    user_id: str,
    job_id: str,
    amount_units: int,
    expires_at: datetime,
) -> WalletHold:
    _require_positive_units(amount_units, label="hold")

    job = db.scalar(
        select(GenerationJob)
        .where(GenerationJob.id == job_id)
        .with_for_update()
    )
    if job is None or job.user_id != user_id:
        raise InvalidHoldOwner("hold job does not belong to wallet owner")
    if not _has_complete_positive_quote(job):
        raise InvalidChargeableJob("hold requires a chargeable job with a positive quote")

    existing = db.scalar(
        select(WalletHold).where(WalletHold.job_id == job_id).with_for_update()
    )
    if existing is not None:
        if (
            existing.user_id == user_id
            and existing.status == "active"
            and existing.amount_units == amount_units
        ):
            return existing
        raise HoldConflict("job already has a different wallet hold")

    wallet = db.scalar(
        select(WalletAccount)
        .where(WalletAccount.user_id == user_id)
        .with_for_update()
    )
    if wallet is None or wallet.balance_units - wallet.held_units < amount_units:
        raise InsufficientBalance("wallet has insufficient available units")

    wallet.held_units += amount_units
    hold = WalletHold(
        id=uuid.uuid4().hex,
        user_id=user_id,
        job_id=job_id,
        job_chargeable=True,
        amount_units=amount_units,
        status="active",
        expires_at=expires_at,
    )
    db.add(hold)
    db.flush()
    return hold


def resize_active_hold(
    db: Session, *, job_id: str, amount_units: int
) -> Literal["resized", "insufficient_funds"]:
    _require_positive_units(amount_units, label="hold")
    job = db.scalar(
        select(GenerationJob)
        .where(GenerationJob.id == job_id)
        .with_for_update()
    )
    if job is None:
        raise InvalidHoldState("wallet hold job does not exist")

    hold = db.scalar(
        select(WalletHold).where(WalletHold.job_id == job_id).with_for_update()
    )
    if (
        hold is None
        or hold.user_id != job.user_id
        or hold.status != "active"
    ):
        raise InvalidHoldState("resize requires an active hold")

    wallet = db.scalar(
        select(WalletAccount)
        .where(WalletAccount.user_id == job.user_id)
        .with_for_update()
    )
    if wallet is None:
        raise WalletNotFound(f"wallet not found for user {job.user_id}")

    delta = amount_units - hold.amount_units
    if delta > wallet.balance_units - wallet.held_units:
        return "insufficient_funds"

    hold.amount_units = amount_units
    wallet.held_units += delta
    db.flush()
    return "resized"


def release_hold(db: Session, job_id: str, *, reason: str) -> WalletHold:
    job = db.scalar(
        select(GenerationJob)
        .where(GenerationJob.id == job_id)
        .with_for_update()
    )
    if job is None:
        raise InvalidHoldState("wallet hold job does not exist")

    hold = db.scalar(
        select(WalletHold).where(WalletHold.job_id == job_id).with_for_update()
    )
    if hold is None or hold.user_id != job.user_id:
        raise InvalidHoldState("wallet hold does not exist for job")
    if hold.status == "released":
        return hold
    if hold.status != "active":
        raise InvalidHoldState("only an active hold can be released")

    wallet = db.scalar(
        select(WalletAccount)
        .where(WalletAccount.user_id == job.user_id)
        .with_for_update()
    )
    if wallet is None:
        raise WalletNotFound(f"wallet not found for user {job.user_id}")

    wallet.held_units -= hold.amount_units
    hold.status = "released"
    hold.released_at = _utcnow()
    hold.reason = reason
    db.flush()
    return hold


def capture_hold(
    db: Session, job_id: str, *, amount_units: int
) -> Literal["captured", "payment_required"]:
    _require_positive_units(amount_units, label="charge")

    job = db.scalar(
        select(GenerationJob)
        .where(GenerationJob.id == job_id)
        .with_for_update()
    )
    if job is None:
        raise InvalidHoldState("wallet hold job does not exist")

    hold = db.scalar(
        select(WalletHold).where(WalletHold.job_id == job_id).with_for_update()
    )
    if hold is None or hold.user_id != job.user_id:
        raise InvalidHoldState("wallet hold does not exist for job")
    if hold.status == "captured":
        entry = db.scalar(
            select(WalletEntry).where(
                WalletEntry.idempotency_key == f"consume:{job_id}"
            )
        )
        if entry is None or entry.amount_units != -amount_units:
            raise HoldConflict("captured hold does not match final charge")
        return "captured"
    if hold.status != "active":
        raise InvalidHoldState("only an active hold can be captured")

    wallet = db.scalar(
        select(WalletAccount)
        .where(WalletAccount.user_id == job.user_id)
        .with_for_update()
    )
    if wallet is None:
        raise WalletNotFound(f"wallet not found for user {job.user_id}")

    other_held_units = wallet.held_units - hold.amount_units
    if wallet.balance_units - amount_units < other_held_units:
        return "payment_required"

    wallet.held_units = other_held_units
    wallet.balance_units -= amount_units
    hold.status = "captured"
    hold.captured_at = _utcnow()
    hold.reason = "captured"
    db.add(
        WalletEntry(
            id=uuid.uuid4().hex,
            wallet_id=wallet.id,
            user_id=job.user_id,
            amount_units=-amount_units,
            balance_after_units=wallet.balance_units,
            kind="consume",
            source_type="generation_job",
            source_id=job_id,
            idempotency_key=f"consume:{job_id}",
        )
    )
    db.flush()
    return "captured"


def credit(
    db: Session,
    user_id: str,
    amount_units: int,
    *,
    kind: str,
    source_id: str,
    idempotency_key: str,
) -> WalletEntry:
    _require_positive_units(amount_units, label="credit")

    wallet = db.scalar(
        select(WalletAccount)
        .where(WalletAccount.user_id == user_id)
        .with_for_update()
    )
    if wallet is None:
        raise WalletNotFound(f"wallet not found for user {user_id}")

    existing = db.scalar(
        select(WalletEntry).where(
            WalletEntry.idempotency_key == idempotency_key
        )
    )
    if existing is not None:
        return existing

    entry_id = uuid.uuid4().hex
    inserted = _insert_credit_entry_once(
        db,
        entry_id=entry_id,
        wallet=wallet,
        user_id=user_id,
        amount_units=amount_units,
        kind=kind,
        source_id=source_id,
        idempotency_key=idempotency_key,
    )
    if not inserted:
        existing = db.scalar(
            select(WalletEntry).where(
                WalletEntry.idempotency_key == idempotency_key
            )
        )
        if existing is None:
            raise RuntimeError("idempotent wallet entry disappeared")
        return existing

    wallet.balance_units += amount_units
    db.flush()
    entry = db.get(WalletEntry, entry_id)
    if entry is None:
        raise RuntimeError("inserted wallet entry could not be reloaded")
    return entry


def available_units(db: Session, user_id: str) -> int:
    wallet = db.scalar(
        select(WalletAccount).where(WalletAccount.user_id == user_id)
    )
    if wallet is None:
        raise WalletNotFound(f"wallet not found for user {user_id}")
    return wallet.balance_units - wallet.held_units
