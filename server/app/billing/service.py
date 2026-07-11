from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Protocol

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from server.app.billing.models import (
    BillingReconciliation,
    BillingSetting,
    CostReceipt,
    GenerationJob,
)
from server.app.billing.money import provider_micro_to_charge_units
from server.app.projects.models import ProjectRecord
from server.app.provider.newapi import (
    TokenKind,
    TokenScopedQuote,
    UsageQuote,
    UsageReceipt,
    _validate_quote_id,
    _validate_request_id,
    _validate_task_id,
)
from server.app.wallet.service import (
    capture_hold,
    create_hold,
    release_hold,
    resize_active_hold,
)


class ProviderPricingUnavailable(RuntimeError):
    pass


class InvalidBillingState(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class StagedArtifact:
    locator: str
    sha256: str
    source_reference: str
    capability: TokenKind


class ArtifactInspector(Protocol):
    def __call__(self, locator: str) -> StagedArtifact: ...


class _BillingSettings(Protocol):
    billing_reference_recovery_seconds: int
    billing_receipt_deadline_seconds: int
    billing_hold_timeout_seconds: int


_CAPABILITY_ROUTES = {
    "text": {"/v1/chat/completions": "openai", "/v1/responses": "openai_responses"},
    "image": {"/v1/images/generations": "openai_image"},
    "video": {"/v1/videos": "task"},
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _canonical_decimal(value: Decimal) -> str:
    normalized = value.normalize()
    return format(normalized, "f")


def _canonical_ratios(ratios: dict[str, Decimal]) -> str:
    return "{" + ",".join(
        f"{json.dumps(name, ensure_ascii=False)}:{_canonical_decimal(ratios[name])}"
        for name in sorted(ratios)
    ) + "}"


def _canonical_json(value: object) -> str:
    if value is None:
        return "null"
    if type(value) is str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if type(value) is int:
        return str(value)
    if type(value) is Decimal:
        if not value.is_finite():
            raise InvalidBillingState("receipt contains a non-finite decimal")
        return _canonical_decimal(value)
    if type(value) is dict:
        mapping = value
        if any(type(key) is not str for key in mapping):
            raise InvalidBillingState("receipt contains an invalid JSON name")
        return "{" + ",".join(
            f"{_canonical_json(key)}:{_canonical_json(mapping[key])}"
            for key in sorted(mapping)
        ) + "}"
    raise InvalidBillingState("receipt contains an unsupported JSON value")


def _receipt_payload(receipt: UsageReceipt) -> dict[str, object]:
    return {
        "reference_type": receipt.reference_type,
        "reference_id": receipt.reference_id,
        "status": receipt.status,
        "model": receipt.model,
        "quota": receipt.quota,
        "refunded_quota": receipt.refunded_quota,
        "quota_per_unit": receipt.quota_per_unit,
        "pricing_version": receipt.pricing_version,
        "cost_currency": receipt.cost_currency,
        "cost_amount_micro": receipt.cost_amount_micro,
        "settled_at": receipt.settled_at,
    }


_NO_CHARGE_TERMINALS = {
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
_TERMINALS = _NO_CHARGE_TERMINALS | {"billed"}
_UNSUBMITTED_TERMINALS = {
    "provider_pricing_unstable_no_charge",
    "provider_quote_rate_limited_no_charge",
    "provider_pricing_unavailable_no_charge",
    "provider_not_submitted_no_charge",
    "provider_rejected_no_charge",
    "provider_reference_missing_no_charge",
}


def _validate_nonempty(value: object, *, label: str, maximum: int) -> str:
    if type(value) is not str or not value or len(value) > maximum:
        raise InvalidBillingState(f"invalid {label}")
    return value


def _validate_quote(
    scoped_quote: TokenScopedQuote,
    *,
    capability: TokenKind,
    provider_method: str,
    provider_route: str,
    now: datetime,
    enforce_quote_context: bool = True,
) -> UsageQuote:
    if provider_method != "POST":
        raise InvalidBillingState("invalid provider method")
    expected_format = _CAPABILITY_ROUTES.get(capability, {}).get(provider_route)
    if expected_format is None:
        raise InvalidBillingState("provider route does not match capability")
    if (
        not isinstance(scoped_quote, TokenScopedQuote)
        or not isinstance(scoped_quote.quote, UsageQuote)
    ):
        raise ProviderPricingUnavailable("provider quote is incomplete")
    quote = scoped_quote.quote
    required_strings = (
        scoped_quote.token_alias,
        quote.quote_id,
        quote.model,
        quote.fixed_group,
        quote.relay_format,
        quote.pricing_version,
        quote.billing_fingerprint,
    )
    ratios_are_valid = type(quote.other_ratios) is dict and all(
        type(name) is str
        and bool(name)
        and len(name) <= 100
        and type(value) is Decimal
        and value.is_finite()
        and value > 0
        for name, value in quote.other_ratios.items()
    )
    try:
        quote_expires_at = datetime.fromtimestamp(quote.expires_at, timezone.utc)
    except (OSError, OverflowError, TypeError, ValueError):
        raise ProviderPricingUnavailable("provider quote is incomplete") from None
    if (
        quote.status != "quoted"
        or quote.cost_currency != "USD"
        or any(type(value) is not str or not value for value in required_strings)
        or type(quote.estimated_quota) is not int
        or quote.estimated_quota <= 0
        or type(quote.estimated_cost_amount_micro) is not int
        or quote.estimated_cost_amount_micro <= 0
        or type(quote.quota_per_unit) is not Decimal
        or not quote.quota_per_unit.is_finite()
        or quote.quota_per_unit <= 0
        or type(quote.expires_at) is not int
        or not ratios_are_valid
        or (enforce_quote_context and quote.relay_format != expected_format)
        or (
            enforce_quote_context
            and quote.fixed_group != f"openmontage-{capability}"
        )
        or quote_expires_at <= now
        or len(scoped_quote.token_alias) > 64
    ):
        raise ProviderPricingUnavailable("paid calls require a complete positive quote")
    return quote


def _apply_quote_snapshot(job: GenerationJob, quote: UsageQuote) -> None:
    job.model = quote.model
    job.quote_id = quote.quote_id
    job.quote_expires_at = datetime.fromtimestamp(quote.expires_at, timezone.utc)
    job.quote_estimated_quota = quote.estimated_quota
    job.quote_estimated_provider_cost_micro = quote.estimated_cost_amount_micro
    job.quote_quota_per_unit = quote.quota_per_unit
    job.quote_pricing_version = quote.pricing_version
    job.quote_other_ratios_json = _canonical_ratios(quote.other_ratios)
    job.quote_billing_fingerprint = quote.billing_fingerprint


class BillingService:
    def __init__(
        self,
        db: Session,
        settings: _BillingSettings,
        artifact_inspector: ArtifactInspector,
        *,
        now: Callable[[], datetime] = _utcnow,
    ) -> None:
        self.db = db
        self.settings = settings
        self.artifact_inspector = artifact_inspector
        self._now = now

    def create_parent_job(
        self, *, user_id: str, project_id: str, operation: str
    ) -> GenerationJob:
        try:
            _validate_nonempty(operation, label="operation", maximum=191)
            project = self.db.scalar(
                select(ProjectRecord).where(ProjectRecord.id == project_id)
            )
            if project is None or project.owner_user_id != user_id:
                raise InvalidBillingState("project does not belong to user")
            job = GenerationJob.parent(
                id=uuid.uuid4().hex,
                user_id=user_id,
                project_id=project_id,
                operation=operation,
            )
            self.db.add(job)
            self.db.commit()
            return job
        except Exception:
            self.db.rollback()
            raise

    def _lock_chargeable_job(self, job_id: str) -> GenerationJob:
        job = self.db.scalar(
            select(GenerationJob)
            .where(GenerationJob.id == job_id)
            .with_for_update()
        )
        if job is None or not job.chargeable:
            raise InvalidBillingState("billing job not found")
        return job

    def _open_reconciliation(
        self,
        job: GenerationJob,
        reason: str,
        *,
        last_error: str | None = None,
    ) -> None:
        existing = self.db.scalar(
            select(BillingReconciliation).where(
                BillingReconciliation.job_id == job.id,
                BillingReconciliation.reason == reason,
            )
        )
        if existing is None:
            self.db.add(
                BillingReconciliation(
                    id=uuid.uuid4().hex,
                    job_id=job.id,
                    reason=reason,
                    status="open",
                    attempts=0,
                    last_error=last_error,
                )
            )

    def _validate_receipt_identity(
        self, job: GenerationJob, receipt: UsageReceipt
    ) -> None:
        if (
            job.provider_reference_type is None
            or job.provider_reference_id is None
            or receipt.reference_type != job.provider_reference_type
            or receipt.reference_id != job.provider_reference_id
        ):
            raise InvalidBillingState("receipt identity does not match billing job")
        if receipt.model != job.model:
            raise InvalidBillingState("receipt model does not match billing job")

    def _validate_terminal_receipt(
        self, job: GenerationJob, receipt: UsageReceipt
    ) -> None:
        self._validate_receipt_identity(job, receipt)
        if (
            receipt.status == "pending"
            or receipt.settled_at is None
            or receipt.quota_per_unit <= 0
            or not receipt.pricing_version
            or receipt.quota_per_unit != job.quote_quota_per_unit
            or receipt.pricing_version != job.quote_pricing_version
        ):
            raise InvalidBillingState("receipt snapshot does not match billing quote")
        if receipt.status == "settled" and (
            receipt.quota <= 0 or receipt.cost_amount_micro <= 0
        ):
            raise InvalidBillingState(
                "settled receipt must contain positive quota and cost"
            )
        if receipt.status != "settled" and receipt.cost_amount_micro != 0:
            raise InvalidBillingState("no-charge receipt contains a provider cost")

    def _store_terminal_receipt_locked(
        self, job: GenerationJob, receipt: UsageReceipt
    ) -> CostReceipt:
        self._validate_terminal_receipt(job, receipt)
        raw = _canonical_json(_receipt_payload(receipt))
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        existing = self.db.scalar(
            select(CostReceipt)
            .where(CostReceipt.job_id == job.id)
            .with_for_update()
        )
        if existing is not None:
            if existing.raw_sha256 == digest and existing.raw_canonical_json == raw:
                return existing
            raise InvalidBillingState("conflicting provider receipt")
        stored = CostReceipt(
            id=uuid.uuid4().hex,
            job_id=job.id,
            reference_type=receipt.reference_type,
            reference_id=receipt.reference_id,
            status=receipt.status,
            model=receipt.model,
            quota=receipt.quota,
            refunded_quota=receipt.refunded_quota,
            quota_per_unit=receipt.quota_per_unit,
            pricing_version=receipt.pricing_version,
            cost_currency=receipt.cost_currency,
            cost_amount_micro=receipt.cost_amount_micro,
            settled_at=datetime.fromtimestamp(receipt.settled_at, timezone.utc),
            raw_canonical_json=raw,
            raw_sha256=digest,
        )
        self.db.add(stored)
        self.db.flush()
        return stored

    def _capture_settled_receipt_locked(
        self, job: GenerationJob, receipt: CostReceipt
    ) -> str:
        if receipt.status != "settled" or not job.result_staged:
            raise InvalidBillingState(
                "capture requires a settled receipt and staged result"
            )
        charge_units = provider_micro_to_charge_units(
            receipt.cost_amount_micro, job.multiplier_bps
        )
        outcome = capture_hold(self.db, job.id, amount_units=charge_units)
        if outcome == "payment_required":
            job.status = "payment_required"
            job.result_visible = False
            return "payment_required"
        job.status = "billed"
        job.result_visible = True
        return "billed"

    def reserve_provider_call(
        self,
        *,
        user_id: str,
        project_id: str,
        parent_job_id: str | None,
        capability: TokenKind,
        operation: str,
        provider_method: str,
        provider_route: str,
        quote: TokenScopedQuote,
    ) -> GenerationJob:
        now = self._now()
        provider_quote = _validate_quote(
            quote,
            capability=capability,
            provider_method=provider_method,
            provider_route=provider_route,
            now=now,
        )
        try:
            _validate_nonempty(operation, label="operation", maximum=191)
            project = self.db.scalar(
                select(ProjectRecord).where(ProjectRecord.id == project_id)
            )
            if project is None or project.owner_user_id != user_id:
                raise InvalidBillingState("project does not belong to user")
            if parent_job_id is not None:
                parent = self.db.scalar(
                    select(GenerationJob)
                    .where(GenerationJob.id == parent_job_id)
                    .with_for_update()
                )
                if (
                    parent is None
                    or parent.chargeable
                    or parent.parent_job_id is not None
                    or parent.user_id != user_id
                    or parent.project_id != project_id
                ):
                    raise InvalidBillingState("invalid parent billing job")
            setting = self.db.scalar(
                select(BillingSetting)
                .where(BillingSetting.id == 1)
                .with_for_update()
            )
            if setting is None:
                raise InvalidBillingState("billing setting is unavailable")
            job = GenerationJob(
                id=uuid.uuid4().hex,
                parent_job_id=parent_job_id,
                chargeable=True,
                user_id=user_id,
                project_id=project_id,
                operation=operation,
                capability=capability,
                token_kind=capability,
                token_alias=quote.token_alias,
                multiplier_bps=setting.multiplier_bps,
                provider_method=provider_method,
                provider_route=provider_route,
                reference_deadline=now
                + timedelta(seconds=self.settings.billing_reference_recovery_seconds),
                receipt_deadline=now
                + timedelta(seconds=self.settings.billing_receipt_deadline_seconds),
                status="reserved",
                result_staged=False,
                result_visible=False,
            )
            _apply_quote_snapshot(job, provider_quote)
            self.db.add(job)
            self.db.flush()
            create_hold(
                self.db,
                user_id=user_id,
                job_id=job.id,
                amount_units=provider_micro_to_charge_units(
                    provider_quote.estimated_cost_amount_micro,
                    setting.multiplier_bps,
                ),
                expires_at=now
                + timedelta(seconds=self.settings.billing_hold_timeout_seconds),
            )
            self.db.commit()
            return job
        except IntegrityError:
            self.db.rollback()
            raise InvalidBillingState("provider quote is already bound") from None
        except Exception:
            self.db.rollback()
            raise

    def load_job(self, job_id: str) -> GenerationJob:
        try:
            job = self.db.scalar(
                select(GenerationJob)
                .where(GenerationJob.id == job_id)
                .execution_options(populate_existing=True)
            )
            if job is None:
                raise InvalidBillingState("billing job not found")
            self.db.expunge(job)
            self.db.commit()
            return job
        except Exception:
            self.db.rollback()
            raise

    def load_owned_payment_required_quote(
        self, job_id: str, *, user_id: str, project_id: str
    ) -> GenerationJob:
        try:
            job = self.db.scalar(
                select(GenerationJob).where(
                    GenerationJob.id == job_id,
                    GenerationJob.user_id == user_id,
                    GenerationJob.project_id == project_id,
                    GenerationJob.chargeable.is_(True),
                    GenerationJob.status == "payment_required_quote",
                )
            )
            if job is None:
                raise InvalidBillingState("billing job not found")
            self.db.expunge(job)
            self.db.commit()
            return job
        except Exception:
            self.db.rollback()
            raise

    def replace_job_quote(
        self,
        job_id: str,
        fresh_quote: TokenScopedQuote,
        *,
        expected_quote_id: str,
    ) -> str:
        try:
            try:
                _validate_quote_id(expected_quote_id)
            except ValueError:
                raise InvalidBillingState("invalid expected quote identifier") from None
            job = self.db.scalar(
                select(GenerationJob)
                .where(GenerationJob.id == job_id)
                .with_for_update()
            )
            if job is None or not job.chargeable:
                raise InvalidBillingState("billing job not found")
            if job.quote_id != expected_quote_id:
                raise InvalidBillingState("expected quote does not match current job")
            if job.status == "provider_pricing_unavailable_no_charge":
                self.db.commit()
                return "provider_pricing_unavailable_no_charge"
            if job.status not in {"reserved", "payment_required_quote"}:
                raise InvalidBillingState("quote cannot be replaced in current state")
            try:
                provider_quote = _validate_quote(
                    fresh_quote,
                    capability=job.capability,
                    provider_method=job.provider_method,
                    provider_route=job.provider_route,
                    now=self._now(),
                    enforce_quote_context=False,
                )
            except ProviderPricingUnavailable:
                release_hold(
                    self.db, job.id, reason="provider_pricing_unavailable_no_charge"
                )
                job.status = "provider_pricing_unavailable_no_charge"
                job.result_visible = False
                self.db.commit()
                return "provider_pricing_unavailable_no_charge"
            if fresh_quote.token_alias != job.token_alias:
                raise InvalidBillingState("fresh quote token alias changed")
            if provider_quote.model != job.model:
                raise InvalidBillingState("fresh quote model changed")
            expected_format = _CAPABILITY_ROUTES.get(job.capability, {}).get(
                job.provider_route
            )
            if provider_quote.relay_format != expected_format:
                raise InvalidBillingState("fresh quote provider route changed")
            if provider_quote.fixed_group != f"openmontage-{job.capability}":
                raise InvalidBillingState("fresh quote capability group changed")
            duplicate = self.db.scalar(
                select(GenerationJob.id).where(
                    GenerationJob.quote_id == provider_quote.quote_id,
                    GenerationJob.token_alias == job.token_alias,
                    GenerationJob.id != job.id,
                )
            )
            if duplicate is not None:
                raise InvalidBillingState("provider quote is already bound")
            _apply_quote_snapshot(job, provider_quote)
            outcome = resize_active_hold(
                self.db,
                job_id=job.id,
                amount_units=provider_micro_to_charge_units(
                    provider_quote.estimated_cost_amount_micro,
                    job.multiplier_bps,
                ),
            )
            if outcome == "insufficient_funds":
                job.status = "payment_required_quote"
                result = "payment_required_quote"
            else:
                job.status = "reserved"
                result = "ready"
            self.db.commit()
            return result
        except IntegrityError:
            self.db.rollback()
            raise InvalidBillingState("provider quote is already bound") from None
        except Exception:
            self.db.rollback()
            raise

    def bind_provider_reference(
        self, job_id: str, reference_type: str, reference_id: str
    ) -> None:
        try:
            job = self.db.scalar(
                select(GenerationJob)
                .where(GenerationJob.id == job_id)
                .with_for_update()
            )
            if job is None or not job.chargeable:
                raise InvalidBillingState("billing job not found")
            expected_type = "task" if job.capability == "video" else "request"
            if reference_type != expected_type:
                raise InvalidBillingState("provider reference type does not match capability")
            try:
                if reference_type == "task":
                    _validate_task_id(reference_id)
                else:
                    _validate_request_id(reference_id)
            except ValueError:
                raise InvalidBillingState("invalid provider reference identifier") from None
            existing_pair = (
                job.provider_reference_type,
                job.provider_reference_id,
            )
            if existing_pair != (None, None):
                if existing_pair == (reference_type, reference_id):
                    self.db.commit()
                    return
                raise InvalidBillingState("billing job already has another reference")
            if job.status not in {
                "reserved",
                "submitted_ambiguous",
                "reference_recovery_pending",
            }:
                raise InvalidBillingState("provider reference cannot be bound in current state")
            owner = self.db.scalar(
                select(GenerationJob).where(
                    GenerationJob.provider_reference_type == reference_type,
                    GenerationJob.provider_reference_id == reference_id,
                    GenerationJob.token_alias == job.token_alias,
                )
            )
            if owner is not None and owner.id != job.id:
                raise InvalidBillingState("provider reference is already bound")
            job.provider_reference_type = reference_type
            job.provider_reference_id = reference_id
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            raise InvalidBillingState("provider reference is already bound") from None
        except Exception:
            self.db.rollback()
            raise

    def stage_result(
        self, job_id: str, result_locator: str, result_sha256: str
    ) -> None:
        if (
            type(result_locator) is not str
            or not result_locator
            or len(result_locator) > 2048
            or any(ord(character) < 32 for character in result_locator)
        ):
            raise InvalidBillingState("invalid staged artifact locator")
        if (
            type(result_sha256) is not str
            or len(result_sha256) != 64
            or any(character not in "0123456789abcdef" for character in result_sha256)
        ):
            raise InvalidBillingState("invalid staged artifact hash")
        try:
            artifact = self.artifact_inspector(result_locator)
        except Exception:
            raise InvalidBillingState("staged artifact could not be inspected") from None
        if not isinstance(artifact, StagedArtifact) or artifact.locator != result_locator:
            raise InvalidBillingState("staged artifact locator does not match")
        if artifact.sha256 != result_sha256:
            raise InvalidBillingState("staged artifact hash does not match")
        try:
            job = self._lock_chargeable_job(job_id)
            if job.provider_reference_id is None:
                raise InvalidBillingState("staged artifact requires a provider reference")
            if artifact.source_reference != job.provider_reference_id:
                raise InvalidBillingState("staged artifact reference does not match")
            if artifact.capability != job.capability:
                raise InvalidBillingState("staged artifact capability does not match")
            if job.result_staged:
                if (
                    job.result_locator == result_locator
                    and job.result_sha256 == result_sha256
                ):
                    self.db.commit()
                    return
                raise InvalidBillingState("billing job already has a staged result")
            if job.status in _TERMINALS:
                raise InvalidBillingState("cannot stage a result for a terminal job")
            if job.status not in {"reserved", "receipt_pending", "result_pending"}:
                raise InvalidBillingState("result cannot be staged in current state")
            job.result_locator = result_locator
            job.result_sha256 = result_sha256
            job.result_staged = True
            stored_receipt = self.db.scalar(
                select(CostReceipt)
                .where(CostReceipt.job_id == job.id)
                .with_for_update()
            )
            if stored_receipt is not None:
                self._capture_settled_receipt_locked(job, stored_receipt)
            else:
                job.status = "receipt_pending"
                job.result_visible = False
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def mark_reference_recovery_pending(self, job_id: str) -> None:
        try:
            job = self._lock_chargeable_job(job_id)
            if job.status == "reference_recovery_pending":
                self.db.commit()
                return
            if job.status in _TERMINALS:
                raise InvalidBillingState("cannot transition a terminal billing job")
            if job.status not in {"reserved", "submitted_ambiguous"}:
                raise InvalidBillingState("invalid reference recovery predecessor")
            if job.provider_reference_id is not None:
                raise InvalidBillingState("provider reference is already bound")
            job.status = "reference_recovery_pending"
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def mark_receipt_pending(self, job_id: str) -> None:
        try:
            job = self._lock_chargeable_job(job_id)
            if job.status == "receipt_pending":
                self.db.commit()
                return
            if job.status in _TERMINALS:
                raise InvalidBillingState("cannot transition a terminal billing job")
            if job.provider_reference_id is None:
                raise InvalidBillingState("receipt polling requires a provider reference")
            if job.status not in {
                "reserved",
                "submitted_ambiguous",
                "reference_recovery_pending",
            }:
                raise InvalidBillingState("invalid receipt pending predecessor")
            job.status = "receipt_pending"
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def fail_unsubmitted(
        self,
        job_id: str,
        status: str,
        *,
        operator_error: str | None = None,
    ) -> None:
        if status not in _UNSUBMITTED_TERMINALS:
            raise InvalidBillingState("invalid unsubmitted terminal state")
        try:
            job = self._lock_chargeable_job(job_id)
            if job.status == status:
                if operator_error is not None:
                    self._open_reconciliation(
                        job,
                        "provider_configuration_unavailable",
                        last_error=operator_error,
                    )
                self.db.commit()
                return
            if job.status in _TERMINALS:
                raise InvalidBillingState("cannot transition a terminal billing job")
            if job.status not in {
                "reserved",
                "submitted_ambiguous",
                "reference_recovery_pending",
                "payment_required_quote",
            }:
                raise InvalidBillingState("invalid unsubmitted predecessor")
            if job.provider_reference_id is not None:
                raise InvalidBillingState("submitted provider call cannot fail unsubmitted")
            release_hold(self.db, job.id, reason=status)
            job.status = status
            job.result_visible = False
            if operator_error is not None:
                self._open_reconciliation(
                    job,
                    "provider_configuration_unavailable",
                    last_error=operator_error,
                )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def fail_missing_result(
        self, job_id: str, *, operator_error: str | None = None
    ) -> None:
        target = "provider_result_missing_no_charge"
        try:
            job = self._lock_chargeable_job(job_id)
            if job.status == target:
                if operator_error is not None:
                    self._open_reconciliation(
                        job,
                        "provider_configuration_unavailable",
                        last_error=operator_error,
                    )
                self.db.commit()
                return
            if job.status in _TERMINALS:
                raise InvalidBillingState("cannot transition a terminal billing job")
            if job.provider_reference_id is None:
                raise InvalidBillingState("missing result requires a provider reference")
            if job.status not in {
                "reserved",
                "receipt_pending",
                "result_pending",
                "reference_recovery_pending",
            }:
                raise InvalidBillingState("invalid missing result predecessor")
            release_hold(self.db, job.id, reason=target)
            job.status = target
            job.result_visible = False
            self._open_reconciliation(job, "provider_result_missing")
            if operator_error is not None:
                self._open_reconciliation(
                    job,
                    "provider_configuration_unavailable",
                    last_error=operator_error,
                )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def fail_undeliverable_sync_call(
        self, job_id: str, reference_type: str, reference_id: str
    ) -> None:
        target = "provider_result_missing_no_charge"
        try:
            job = self._lock_chargeable_job(job_id)
            if job.status == target:
                if (
                    job.provider_reference_type,
                    job.provider_reference_id,
                ) != (reference_type, reference_id):
                    raise InvalidBillingState("terminal reference does not match")
                self.db.commit()
                return
            if job.status in _TERMINALS:
                raise InvalidBillingState("cannot transition a terminal billing job")
            if job.status not in {
                "reserved",
                "submitted_ambiguous",
                "reference_recovery_pending",
            }:
                raise InvalidBillingState("invalid undeliverable sync predecessor")
            if job.result_staged:
                raise InvalidBillingState(
                    "staged provider result cannot become undeliverable no-charge"
                )
            stored_receipt = self.db.scalar(
                select(CostReceipt)
                .where(CostReceipt.job_id == job.id)
                .with_for_update()
            )
            if stored_receipt is not None:
                raise InvalidBillingState(
                    "received provider receipt cannot become undeliverable no-charge"
                )
            if job.capability not in {"text", "image"} or reference_type != "request":
                raise InvalidBillingState("undeliverable reference does not match capability")
            try:
                _validate_request_id(reference_id)
            except ValueError:
                raise InvalidBillingState("invalid provider reference identifier") from None
            current = (job.provider_reference_type, job.provider_reference_id)
            if current not in {(None, None), (reference_type, reference_id)}:
                raise InvalidBillingState("billing job already has another reference")
            owner = self.db.scalar(
                select(GenerationJob).where(
                    GenerationJob.provider_reference_type == reference_type,
                    GenerationJob.provider_reference_id == reference_id,
                    GenerationJob.token_alias == job.token_alias,
                    GenerationJob.id != job.id,
                )
            )
            if owner is not None:
                raise InvalidBillingState("provider reference is already bound")
            job.provider_reference_type = reference_type
            job.provider_reference_id = reference_id
            release_hold(self.db, job.id, reason=target)
            job.status = target
            job.result_visible = False
            self._open_reconciliation(job, "provider_result_missing")
            self._open_reconciliation(job, "receipt_pending")
            reference_rows = self.db.scalars(
                select(BillingReconciliation).where(
                    BillingReconciliation.job_id == job.id,
                    BillingReconciliation.reason == "reference_recovery",
                    BillingReconciliation.status == "open",
                )
            ).all()
            for row in reference_rows:
                row.status = "resolved"
                row.next_retry_at = None
                row.last_error = None
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            raise InvalidBillingState("provider reference is already bound") from None
        except Exception:
            self.db.rollback()
            raise

    def settle_job(self, job_id: str, receipt: UsageReceipt) -> None:
        if not isinstance(receipt, UsageReceipt):
            raise InvalidBillingState("invalid provider receipt")
        try:
            job = self._lock_chargeable_job(job_id)
            self._validate_receipt_identity(job, receipt)
            if receipt.status == "pending":
                if job.status in _TERMINALS:
                    raise InvalidBillingState("pending receipt cannot change a terminal job")
                existing = self.db.scalar(
                    select(CostReceipt).where(CostReceipt.job_id == job.id)
                )
                if existing is not None:
                    raise InvalidBillingState("conflicting provider receipt")
                job.status = "receipt_pending"
                job.result_visible = False
                self.db.commit()
                return
            stored = self._store_terminal_receipt_locked(job, receipt)
            if job.status in _NO_CHARGE_TERMINALS:
                self.db.commit()
                return
            if receipt.status == "settled":
                if not job.result_staged:
                    job.status = "result_pending"
                    job.result_visible = False
                else:
                    self._capture_settled_receipt_locked(job, stored)
            else:
                if job.status == "billed":
                    raise InvalidBillingState("conflicting provider receipt")
                release_hold(self.db, job.id, reason=receipt.status)
                job.status = "failed_no_charge"
                job.result_visible = False
                if receipt.status == "refund_pending":
                    self._open_reconciliation(job, "upstream_refund_pending")
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            raise InvalidBillingState("conflicting provider receipt") from None
        except Exception:
            self.db.rollback()
            raise

    def fail_job(self, job_id: str, receipt: UsageReceipt) -> None:
        if receipt.status not in {"refunded", "refund_pending", "not_chargeable"}:
            raise InvalidBillingState("failure settlement requires a no-charge receipt")
        self.settle_job(job_id, receipt)

    def fail_missing_receipt(
        self, job_id: str, *, operator_error: str | None = None
    ) -> None:
        target = "receipt_missing_no_charge"
        try:
            job = self._lock_chargeable_job(job_id)
            if job.status == target:
                if operator_error is not None:
                    self._open_reconciliation(
                        job,
                        "provider_configuration_unavailable",
                        last_error=operator_error,
                    )
                self.db.commit()
                return
            if job.status in _TERMINALS or job.status == "payment_required":
                raise InvalidBillingState("cannot transition a terminal billing job")
            if job.provider_reference_id is None:
                raise InvalidBillingState("missing receipt requires a provider reference")
            if job.status not in {
                "reserved",
                "reference_recovery_pending",
                "receipt_pending",
                "result_pending",
            }:
                raise InvalidBillingState("invalid missing receipt predecessor")
            stored_receipt = self.db.scalar(
                select(CostReceipt)
                .where(CostReceipt.job_id == job.id)
                .with_for_update()
            )
            if stored_receipt is not None:
                raise InvalidBillingState("received provider receipt cannot become missing")
            release_hold(self.db, job.id, reason=target)
            job.status = target
            job.result_visible = False
            self._open_reconciliation(job, "receipt_missing")
            if operator_error is not None:
                self._open_reconciliation(
                    job,
                    "provider_configuration_unavailable",
                    last_error=operator_error,
                )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def record_provider_configuration_unavailable(
        self, job_id: str, last_error: str
    ) -> None:
        try:
            job = self._lock_chargeable_job(job_id)
            self._open_reconciliation(
                job,
                "provider_configuration_unavailable",
                last_error=last_error,
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def retry_payment_required(self, job_id: str) -> None:
        try:
            job = self._lock_chargeable_job(job_id)
            if job.status == "billed":
                self.db.commit()
                return
            if job.status != "payment_required":
                if job.status in _TERMINALS:
                    raise InvalidBillingState("cannot retry a terminal billing job")
                raise InvalidBillingState("billing job is not payment required")
            receipt = self.db.scalar(
                select(CostReceipt)
                .where(CostReceipt.job_id == job.id)
                .with_for_update()
            )
            if receipt is None or receipt.status != "settled" or not job.result_staged:
                raise InvalidBillingState(
                    "payment retry requires a staged result and settled receipt"
                )
            self._capture_settled_receipt_locked(job, receipt)
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
