from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
import uuid

import httpx
from sqlalchemy.orm import Session

from server.app.billing.models import GenerationJob
from server.app.billing.health import require_billing_worker_healthy
from server.app.billing.bootstrap import ensure_billing_settings
from server.app.billing.lease import (
    FencedReconciliationClaim,
    claim_reconciliation,
    heartbeat_claim,
    resolve_claim,
)
from server.app.billing.reconciliation import resume_reconcile_publish_job
from server.app.billing.service import (
    ArtifactInspector,
    BillingService,
    InvalidBillingState,
    ProviderPricingUnavailable,
)
from server.app.provider.newapi import (
    AmbiguousNewApiResult,
    InvalidNewApiResponse,
    NewApiCallError,
    NewApiClient,
    NewApiRateLimited,
    PreparedNewApiRequest,
    QuoteNotFound,
    QuoteStale,
    QuotedExecutionResult,
    TokenKind,
    UsageQuoteStatus,
)


@dataclass(frozen=True, slots=True)
class ProviderCallContext:
    job_id: str
    token_kind: TokenKind
    execution: QuotedExecutionResult
    claim: FencedReconciliationClaim


@dataclass(frozen=True, slots=True)
class StagedProviderResult:
    locator: str
    sha256: str
    value: object


class ProviderResultPending(RuntimeError):
    def __init__(self, message: str, job_id: str | None = None):
        super().__init__(message)
        self.job_id = job_id


class ProviderResultUnavailable(RuntimeError):
    pass


class ProviderPricingUnstable(RuntimeError):
    pass


class PaymentRequiredQuote(RuntimeError):
    def __init__(self, job_id: str):
        super().__init__("payment required for provider quote")
        self.job_id = job_id


def _service(db, settings, artifact_inspector, now):
    if now is None:
        return BillingService(db, settings, artifact_inspector)
    return BillingService(db, settings, artifact_inspector, now=lambda: now)


def _heartbeat_or_pending(
    db: Session, claim: FencedReconciliationClaim
) -> None:
    if not heartbeat_claim(db, claim):
        raise ProviderResultPending(
            "provider reconciliation ownership was lost"
        )


def recover_accepted_reference(
    *, billing: BillingService, child: GenerationJob,
    capability: TokenKind, status: UsageQuoteStatus,
    claim: FencedReconciliationClaim,
) -> None:
    if status.reference_type is None or status.reference_id is None:
        billing.mark_reference_recovery_pending(child.id, claim=claim)
        raise ProviderResultPending("provider reference recovery is pending")
    if capability in {"text", "image"}:
        billing.fail_undeliverable_sync_call(
            child.id,
            status.reference_type,
            status.reference_id,
            claim=claim,
        )
        resolve_claim(billing.db, claim)
        raise ProviderResultUnavailable("provider result is unavailable")
    billing.bind_provider_reference(
        child.id,
        status.reference_type,
        status.reference_id,
        claim=claim,
    )
    billing.mark_receipt_pending(child.id, claim=claim)
    raise ProviderResultPending("provider result is pending")


def _load_status_or_defer(
    *, db, billing, newapi, child, capability, claim
):
    _heartbeat_or_pending(db, claim)
    try:
        status = newapi.get_quote_status(
            capability, child.token_alias, child.quote_id
        )
    except (QuoteNotFound, InvalidNewApiResponse):
        _heartbeat_or_pending(db, claim)
        billing.mark_reference_recovery_pending(child.id, claim=claim)
        raise ProviderResultPending("provider reference recovery is pending") from None
    _heartbeat_or_pending(db, claim)
    return status


def _proves_pre_acceptance(status: UsageQuoteStatus) -> bool:
    if status.status in {"quoted", "expired"}:
        return status.reference_type is None and status.reference_id is None
    if status.status == "failed":
        return status.reference_type is None and status.reference_id is None
    return False


def _replace_quote(
    *, db, billing, newapi, child, capability, request, claim
):
    previous_quote_id = child.quote_id
    _heartbeat_or_pending(db, claim)
    try:
        fresh = newapi.quote(
            capability, request, token_alias=child.token_alias
        )
    except NewApiRateLimited:
        _heartbeat_or_pending(db, claim)
        billing.fail_unsubmitted(
            child.id,
            "provider_quote_rate_limited_no_charge",
            claim=claim,
        )
        raise
    except InvalidNewApiResponse:
        _heartbeat_or_pending(db, claim)
        billing.fail_unsubmitted(
            child.id,
            "provider_pricing_unavailable_no_charge",
            claim=claim,
        )
        raise ProviderPricingUnavailable("provider pricing is unavailable") from None
    _heartbeat_or_pending(db, claim)
    outcome = billing.replace_job_quote(
        child.id,
        fresh,
        expected_quote_id=previous_quote_id,
        claim=claim,
    )
    if outcome == "provider_pricing_unavailable_no_charge":
        raise ProviderPricingUnavailable("provider pricing is unavailable")
    if outcome == "payment_required_quote":
        raise PaymentRequiredQuote(child.id)
    return billing.load_job(child.id)


def execute_billed_provider_call(
    *, db: Session, newapi: NewApiClient, settings,
    artifact_inspector: ArtifactInspector, user_id: str, project_id: str,
    parent_job_id: str | None, capability: TokenKind, operation: str,
    request: PreparedNewApiRequest, retry_job_id: str | None = None,
    job_id: str | None = None,
    prepare_reservation: Callable[[str], None] | None = None,
    reservation_validator: Callable[[str], None] | None = None,
    discard_reservation: Callable[[str], None] | None = None,
    now: datetime | None = None,
    stream_callback: Callable[[str], None] | None = None,
) -> ProviderCallContext:
    if capability == "video":
        require_billing_worker_healthy(db, settings)
    bootstrap_before_quote = db.get_bind().dialect.name == "postgresql"
    if bootstrap_before_quote:
        ensure_billing_settings(db, settings)
    billing = _service(db, settings, artifact_inspector, now)
    if retry_job_id is None:
        try:
            scoped_quote = newapi.quote(capability, request)
        except InvalidNewApiResponse:
            raise ProviderPricingUnavailable("provider pricing is unavailable") from None
        if not bootstrap_before_quote:
            ensure_billing_settings(db, settings)
        proposed_job_id = job_id or uuid.uuid4().hex
        if prepare_reservation is not None:
            prepare_reservation(proposed_job_id)
        try:
            child = billing.reserve_provider_call(
                user_id=user_id,
                project_id=project_id,
                parent_job_id=parent_job_id,
                capability=capability,
                operation=operation,
                provider_method=request.method,
                provider_route=request.path,
                quote=scoped_quote,
                job_id=proposed_job_id,
                reservation_validator=reservation_validator,
            )
        except Exception:
            if discard_reservation is not None:
                discard_reservation(proposed_job_id)
            raise
    else:
        child = billing.load_owned_payment_required_quote(
            retry_job_id, user_id=user_id, project_id=project_id
        )
        if (
            child.capability, child.operation, child.provider_method,
            child.provider_route,
        ) != (capability, operation, request.method, request.path):
            raise InvalidBillingState("quote retry does not match original operation")
        previous_quote_id = child.quote_id
        try:
            fresh = newapi.quote(
                capability, request, token_alias=child.token_alias
            )
        except InvalidNewApiResponse:
            billing.fail_unsubmitted(
                child.id, "provider_pricing_unavailable_no_charge"
            )
            raise ProviderPricingUnavailable("provider pricing is unavailable") from None
        if not bootstrap_before_quote:
            ensure_billing_settings(db, settings)
        outcome = billing.replace_job_quote(
            child.id, fresh, expected_quote_id=previous_quote_id
        )
        if outcome == "provider_pricing_unavailable_no_charge":
            raise ProviderPricingUnavailable("provider pricing is unavailable")
        if outcome == "payment_required_quote":
            raise PaymentRequiredQuote(child.id)
        child = billing.load_job(child.id)

    if retry_job_id is not None and reservation_validator is not None:
        billing.validate_reserved_provider_call(
            child.id,
            user_id=user_id,
            project_id=project_id,
            parent_job_id=parent_job_id,
            reservation_validator=reservation_validator,
        )

    claim = claim_reconciliation(
        db,
        job_id=child.id,
        reason="provider_completion",
    )
    if claim is None:
        raise ProviderResultPending("provider result reconciliation is already running")
    billing.mark_submitted_ambiguous(child.id, claim)

    stale_retries = 0
    while True:
        _heartbeat_or_pending(db, claim)
        try:
            if stream_callback is None:
                result = newapi.execute_quoted(
                    capability,
                    child.token_alias,
                    request,
                    child.quote_id,
                )
            else:
                try:
                    result = newapi.execute_quoted(
                        capability,
                        child.token_alias,
                        request,
                        child.quote_id,
                        stream_callback=stream_callback,
                    )
                except TypeError as exc:
                    if "stream_callback" not in str(exc):
                        raise
                    result = newapi.execute_quoted(
                        capability,
                        child.token_alias,
                        request,
                        child.quote_id,
                    )
            _heartbeat_or_pending(db, claim)
            billing.bind_provider_reference(
                child.id,
                result.reference_type,
                result.reference_id,
                claim=claim,
            )
            billing.mark_receipt_pending(child.id, claim=claim)
            return ProviderCallContext(child.id, capability, result, claim)
        except (QuoteStale, AmbiguousNewApiResult):
            _heartbeat_or_pending(db, claim)
            status = _load_status_or_defer(
                db=db, billing=billing, newapi=newapi, child=child,
                capability=capability, claim=claim,
            )
            if status.status in {"consuming", "accepted"}:
                recover_accepted_reference(
                    billing=billing, child=child,
                    capability=capability, status=status, claim=claim,
                )
            if not _proves_pre_acceptance(status):
                billing.mark_reference_recovery_pending(
                    child.id, claim=claim
                )
                raise ProviderResultPending("provider reference recovery is pending")
            if stale_retries >= settings.billing_quote_stale_retries:
                billing.fail_unsubmitted(
                    child.id,
                    "provider_pricing_unstable_no_charge",
                    claim=claim,
                )
                resolve_claim(db, claim)
                raise ProviderPricingUnstable("provider pricing is unstable")
            stale_retries += 1
            try:
                child = _replace_quote(
                    db=db, billing=billing, newapi=newapi, child=child,
                    capability=capability, request=request, claim=claim,
                )
            except PaymentRequiredQuote:
                resolve_claim(db, claim)
                raise
        except (NewApiCallError, NewApiRateLimited):
            _heartbeat_or_pending(db, claim)
            status = _load_status_or_defer(
                db=db, billing=billing, newapi=newapi, child=child,
                capability=capability, claim=claim,
            )
            if status.status in {"consuming", "accepted"}:
                recover_accepted_reference(
                    billing=billing, child=child,
                    capability=capability, status=status, claim=claim,
                )
            if _proves_pre_acceptance(status):
                billing.fail_unsubmitted(
                    child.id,
                    "provider_rejected_no_charge",
                    claim=claim,
                )
                resolve_claim(db, claim)
            else:
                billing.mark_reference_recovery_pending(
                    child.id, claim=claim
                )
            raise


def retry_payment_required_quote(
    *, job_id: str, db: Session, newapi: NewApiClient, settings,
    artifact_inspector: ArtifactInspector, user_id: str, project_id: str,
    parent_job_id: str | None = None,
    capability: TokenKind, operation: str, request: PreparedNewApiRequest,
    prepare_reservation: Callable[[str], None] | None = None,
    reservation_validator: Callable[[str], None] | None = None,
    discard_reservation: Callable[[str], None] | None = None,
    now: datetime | None = None,
    stream_callback: Callable[[str], None] | None = None,
) -> ProviderCallContext:
    return execute_billed_provider_call(
        db=db, newapi=newapi, settings=settings,
        artifact_inspector=artifact_inspector, user_id=user_id,
        project_id=project_id, parent_job_id=parent_job_id, capability=capability,
        operation=operation, request=request, retry_job_id=job_id,
        prepare_reservation=prepare_reservation,
        reservation_validator=reservation_validator,
        discard_reservation=discard_reservation,
        now=now,
        stream_callback=stream_callback,
    )


def finalize_billed_sync_result(
    *, db: Session, newapi: NewApiClient, settings,
    artifact_inspector: ArtifactInspector, context: ProviderCallContext,
    persist_hidden: Callable[[str, httpx.Response], StagedProviderResult],
    now: datetime | None = None,
) -> StagedProviderResult:
    if context.token_kind not in {"text", "image"}:
        raise ValueError("sync finalization supports only text/image")
    billing = _service(db, settings, artifact_inspector, now)
    try:
        staged = persist_hidden(context.job_id, context.execution.response)
        billing.stage_result(
            context.job_id,
            staged.locator,
            staged.sha256,
            claim=context.claim,
        )
    except Exception:
        billing.fail_undeliverable_sync_call(
            context.job_id,
            context.execution.reference_type,
            context.execution.reference_id,
            claim=context.claim,
        )
        resolve_claim(db, context.claim)
        raise ProviderResultUnavailable("provider result is unavailable") from None
    resume_reconcile_publish_job(
        db, newapi, context.job_id, now or datetime.now(timezone.utc),
        settings=settings,
        claim=context.claim,
    )
    if not billing.load_job(context.job_id).result_visible:
        raise ProviderResultPending("provider result is pending")
    return staged
