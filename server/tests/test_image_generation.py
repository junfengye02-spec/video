from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from server.app.auth.models import User
from server.app.billing.execution import (
    PaymentRequiredQuote,
    ProviderPricingUnstable,
    ProviderResultPending,
    ProviderResultUnavailable,
    StagedProviderResult,
    execute_billed_provider_call,
    finalize_billed_sync_result,
    retry_payment_required_quote,
)
from server.app.billing.models import BillingReconciliation, BillingSetting, GenerationJob
from server.app.billing.service import (
    BillingService,
    ExistingProviderOperation,
    ProviderPricingUnavailable,
    StagedArtifact,
)
from server.app.db.base import Base
from server.app.projects.models import ProjectRecord
from server.app.provider.image_generation import (
    generate_billed_project_image,
    prepare_image_generation_request,
)
from server.app.provider.newapi import (
    AmbiguousNewApiResult,
    NewApiRateLimited,
    QuotedExecutionResult,
    QuoteStale,
    TokenScopedQuote,
    UsageQuote,
    UsageQuoteStatus,
    UsageReceipt,
)
from server.app.wallet.models import WalletAccount, WalletEntry, WalletHold
from server.app.storage import WorkbenchStore


NOW = datetime(2026, 7, 12, 4, 5, 6, tzinfo=timezone.utc)
USER_ID = "u000000000000000000000000000001"
PROJECT_ID = "10000000000040008000000000000001"
REQUEST_ID = "20260712123456000000000deadbeefABC12345"
PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="


def quote(quote_id: str, *, cost_micro: int = 1_000_000) -> TokenScopedQuote:
    return TokenScopedQuote(
        token_alias="image-v1",
        quote=UsageQuote(
            quote_id=quote_id,
            status="quoted",
            model="gpt-image-2",
            fixed_group="openmontage-image",
            relay_format="openai_image",
            estimated_quota=500_000,
            quota_per_unit=Decimal("500000"),
            cost_currency="USD",
            estimated_cost_amount_micro=cost_micro,
            pricing_version="sha256:pricing-v1",
            billing_fingerprint="sha256:fingerprint-v1",
            other_ratios={"count": Decimal("2")},
            expires_at=int((NOW + timedelta(seconds=120)).timestamp()),
        ),
    )


def quote_status(quote_id: str, status: str, *, accepted: bool = False) -> UsageQuoteStatus:
    return UsageQuoteStatus(
        quote_id=quote_id,
        status=status,
        reference_type="request" if accepted else None,
        reference_id=REQUEST_ID if accepted else None,
        created_at=int(NOW.timestamp()),
        expires_at=int((NOW + timedelta(seconds=120)).timestamp()),
        consumed_at=int(NOW.timestamp()) if accepted else None,
        updated_at=int(NOW.timestamp()),
    )


class FakeNewApi:
    def __init__(self) -> None:
        self.quotes = [quote("uq_" + "A" * 32)]
        self.execute_effects: list[object] = []
        self.status = quote_status("uq_" + "A" * 32, "quoted")
        self.quote_effects: list[object] = []
        self.events: list[tuple[object, ...]] = []
        self.requests: list[object] = []

    def quote(self, kind, request, token_alias=None):
        self.events.append(("quote", kind, request.path, token_alias))
        self.requests.append(request)
        if self.quote_effects:
            effect = self.quote_effects.pop(0)
            if isinstance(effect, Exception):
                raise effect
        return self.quotes.pop(0)

    def execute_quoted(self, kind, token_alias, request, quote_id):
        self.events.append(("execute", kind, request.path, quote_id))
        self.requests.append(request)
        if self.execute_effects:
            effect = self.execute_effects.pop(0)
            if isinstance(effect, Exception):
                raise effect
        response = httpx.Response(
            200,
            headers={"X-Oneapi-Request-Id": REQUEST_ID},
            json={"data": [{"b64_json": PNG_BASE64}, {"b64_json": PNG_BASE64}]},
        )
        return QuotedExecutionResult("request", REQUEST_ID, response)

    def get_quote_status(self, kind, token_alias, quote_id):
        self.events.append(("quote_status", kind, quote_id))
        return self.status

    def get_request_receipt(self, kind, token_alias, request_id):
        self.events.append(("receipt", kind, request_id))
        return UsageReceipt(
            reference_type="request",
            reference_id=request_id,
            status="settled",
            model="gpt-image-2",
            quota=500_000,
            refunded_quota=0,
            quota_per_unit=Decimal("500000"),
            pricing_version="sha256:pricing-v1",
            cost_currency="USD",
            cost_amount_micro=800_000,
            settled_at=int(NOW.timestamp()),
        )


class ArtifactStore:
    def __init__(self) -> None:
        self.items: dict[str, StagedArtifact] = {}

    def inspect(self, locator: str) -> StagedArtifact:
        return self.items[locator]

    def stage(self, job_id: str, response: httpx.Response) -> StagedProviderResult:
        locator = f"hidden-image:{job_id}"
        digest = "a" * 64
        self.items[locator] = StagedArtifact(
            locator=locator,
            sha256=digest,
            source_reference=REQUEST_ID,
            capability="image",
        )
        return StagedProviderResult(locator=locator, sha256=digest, value=response.json())


@pytest.fixture
def billing_context():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        db.add(User(id=USER_ID, email="image@example.com", password_hash="hash", role="user", status="active"))
        db.add(ProjectRecord(id=PROJECT_ID, owner_user_id=USER_ID, title="Image", mode="short_drama", project_type="single_video"))
        db.add(WalletAccount(id="w" * 32, user_id=USER_ID, balance_units=20_000_000, held_units=0))
        db.add(BillingSetting(id=1, multiplier_bps=15_000, version=0))
        db.commit()
        settings = SimpleNamespace(
            billing_reference_recovery_seconds=86_400,
            billing_receipt_deadline_seconds=86_400,
            billing_hold_timeout_seconds=86_400,
            billing_quote_stale_retries=2,
        )
        yield db, settings
    engine.dispose()


def test_prepare_image_generation_request_is_exact_immutable_provider_payload():
    request = prepare_image_generation_request(
        model="gpt-image-2",
        prompt="frame",
        count=2,
        size="1024x1024",
        quality="standard",
    )

    assert request.method == "POST"
    assert request.path == "/v1/images/generations"
    assert request.content == (
        b'{"model":"gpt-image-2","n":2,"prompt":"frame",'
        b'"quality":"standard","response_format":"b64_json","size":"1024x1024"}'
    )
    assert isinstance(request.content, bytes)
    assert b"key" not in request.content.lower()
    assert b"price" not in request.content.lower()


def test_quote_precedes_child_and_execution_reuses_exact_request(billing_context):
    db, settings = billing_context
    client = FakeNewApi()
    artifacts = ArtifactStore()
    request = prepare_image_generation_request("gpt-image-2", "frame", 2, "1024x1024", "standard")

    context = execute_billed_provider_call(
        db=db,
        newapi=client,
        settings=settings,
        artifact_inspector=artifacts.inspect,
        user_id=USER_ID,
        project_id=PROJECT_ID,
        parent_job_id=None,
        capability="image",
        operation="image_generation",
        request=request,
        now=NOW,
    )

    assert client.events[:2] == [
        ("quote", "image", "/v1/images/generations", None),
        ("execute", "image", "/v1/images/generations", "uq_" + "A" * 32),
    ]
    assert client.requests == [request, request]
    assert context.execution.reference_id == REQUEST_ID
    assert context.claim.job_id == context.job_id
    assert context.claim.reason == "provider_completion"
    job = db.get(GenerationJob, context.job_id)
    assert job.status == "receipt_pending"
    reconciliation = db.get(BillingReconciliation, context.claim.row_id)
    assert reconciliation.status == "open"
    assert reconciliation.attempts == context.claim.generation
    hold = db.scalar(select(WalletHold).where(WalletHold.job_id == context.job_id))
    assert hold is not None and hold.amount_units == 1_500_000


def test_prepare_reservation_persists_exact_job_id_before_locked_validation(
    billing_context,
):
    db, settings = billing_context
    client = FakeNewApi()
    artifacts = ArtifactStore()
    prepared: list[str] = []

    def prepare(job_id: str) -> None:
        assert db.get(GenerationJob, job_id) is None
        prepared.append(job_id)

    def validate(job_id: str) -> None:
        assert prepared == [job_id]

    context = execute_billed_provider_call(
        db=db,
        newapi=client,
        settings=settings,
        artifact_inspector=artifacts.inspect,
        user_id=USER_ID,
        project_id=PROJECT_ID,
        parent_job_id=None,
        capability="image",
        operation="image_generation",
        request=prepare_image_generation_request(
            "gpt-image-2", "frame", 2, "1024x1024", "standard"
        ),
        prepare_reservation=prepare,
        reservation_validator=validate,
        now=NOW,
    )

    assert prepared == [context.job_id]
    assert db.get(GenerationJob, context.job_id) is not None


def test_existing_parent_operation_discards_losing_pre_reserve_intent(
    billing_context,
):
    db, settings = billing_context
    client = FakeNewApi()
    artifacts = ArtifactStore()
    parent = BillingService(db, settings, artifacts.inspect, now=lambda: NOW).create_parent_job(
        user_id=USER_ID,
        project_id=PROJECT_ID,
        operation="render",
    )
    request = prepare_image_generation_request(
        "gpt-image-2", "frame", 2, "1024x1024", "standard"
    )
    winner = execute_billed_provider_call(
        db=db,
        newapi=client,
        settings=settings,
        artifact_inspector=artifacts.inspect,
        user_id=USER_ID,
        project_id=PROJECT_ID,
        parent_job_id=parent.id,
        capability="image",
        operation="shot:s1",
        request=request,
        now=NOW,
    )
    client.quotes = [quote("uq_" + "B" * 32)]
    pending_intents: set[str] = set()
    discarded: list[str] = []

    def prepare(job_id: str) -> None:
        pending_intents.add(job_id)

    def discard(job_id: str) -> None:
        pending_intents.remove(job_id)
        discarded.append(job_id)

    with pytest.raises(ExistingProviderOperation) as caught:
        execute_billed_provider_call(
            db=db,
            newapi=client,
            settings=settings,
            artifact_inspector=artifacts.inspect,
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=parent.id,
            capability="image",
            operation="shot:s1",
            request=request,
            prepare_reservation=prepare,
            discard_reservation=discard,
            now=NOW,
        )

    assert caught.value.job_id == winner.job_id
    assert len(discarded) == 1
    assert pending_intents == set()
    assert [event[0] for event in client.events].count("execute") == 1
    assert db.scalar(select(func.count(GenerationJob.id))) == 2
    assert db.scalar(select(func.count(WalletHold.id))) == 1


def test_accepted_ambiguous_sync_call_is_durable_zero_charge_and_never_replayed(billing_context):
    db, settings = billing_context
    client = FakeNewApi()
    client.execute_effects = [AmbiguousNewApiResult("ambiguous")]
    client.status = quote_status("uq_" + "A" * 32, "accepted", accepted=True)
    artifacts = ArtifactStore()
    request = prepare_image_generation_request("gpt-image-2", "frame", 2, "1024x1024", "standard")

    with pytest.raises(ProviderResultUnavailable):
        execute_billed_provider_call(
            db=db,
            newapi=client,
            settings=settings,
            artifact_inspector=artifacts.inspect,
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=None,
            capability="image",
            operation="image_generation",
            request=request,
            now=NOW,
        )

    child = db.scalar(select(GenerationJob))
    hold = db.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    assert child.status == "provider_result_missing_no_charge"
    assert child.provider_reference_id == REQUEST_ID
    assert hold.status == "released"
    assert db.scalar(select(func.count(WalletEntry.id))) == 0
    assert [event[0] for event in client.events].count("execute") == 1
    assert [event[0] for event in client.events].count("quote") == 1


def test_confirmed_unconsumed_stale_quote_requotes_resizes_and_executes_once(billing_context):
    db, settings = billing_context
    client = FakeNewApi()
    client.quotes.append(quote("uq_" + "B" * 32, cost_micro=2_000_000))
    client.execute_effects = [QuoteStale(), object()]
    artifacts = ArtifactStore()
    request = prepare_image_generation_request("gpt-image-2", "frame", 2, "1024x1024", "standard")

    context = execute_billed_provider_call(
        db=db,
        newapi=client,
        settings=settings,
        artifact_inspector=artifacts.inspect,
        user_id=USER_ID,
        project_id=PROJECT_ID,
        parent_job_id=None,
        capability="image",
        operation="image_generation",
        request=request,
        now=NOW,
    )

    assert client.requests == [request, request, request, request]
    assert [event[0] for event in client.events] == ["quote", "execute", "quote_status", "quote", "execute"]
    job = db.get(GenerationJob, context.job_id)
    hold = db.scalar(select(WalletHold).where(WalletHold.job_id == context.job_id))
    assert job.quote_id == "uq_" + "B" * 32
    assert hold.amount_units == 3_000_000


def test_requote_takeover_fences_stale_actor_before_quote_replace_or_reexecute(
    billing_context,
):
    db, settings = billing_context

    class TakeoverDuringRequote(FakeNewApi):
        def quote(self, kind, request, token_alias=None):
            scoped = super().quote(kind, request, token_alias=token_alias)
            if len([event for event in self.events if event[0] == "quote"]) == 2:
                row = db.scalar(
                    select(BillingReconciliation).where(
                        BillingReconciliation.status == "open"
                    )
                )
                row.attempts += 1
                row.next_retry_at = datetime.now(timezone.utc) + timedelta(minutes=5)
                db.commit()
            return scoped

    client = TakeoverDuringRequote()
    client.quotes.append(quote("uq_" + "B" * 32, cost_micro=2_000_000))
    client.execute_effects = [QuoteStale()]
    artifacts = ArtifactStore()

    with pytest.raises(ProviderResultPending, match="ownership"):
        execute_billed_provider_call(
            db=db,
            newapi=client,
            settings=settings,
            artifact_inspector=artifacts.inspect,
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=None,
            capability="image",
            operation="image_generation",
            request=prepare_image_generation_request(
                "gpt-image-2", "frame", 2, "1024x1024", "standard"
            ),
            now=NOW,
        )

    job = db.scalar(select(GenerationJob))
    assert job.quote_id == "uq_" + "A" * 32
    assert [event[0] for event in client.events].count("execute") == 1


def test_sync_result_is_staged_before_final_receipt_unlocks_visibility(billing_context):
    db, settings = billing_context
    client = FakeNewApi()
    artifacts = ArtifactStore()
    request = prepare_image_generation_request("gpt-image-2", "frame", 2, "1024x1024", "standard")
    context = execute_billed_provider_call(
        db=db,
        newapi=client,
        settings=settings,
        artifact_inspector=artifacts.inspect,
        user_id=USER_ID,
        project_id=PROJECT_ID,
        parent_job_id=None,
        capability="image",
        operation="image_generation",
        request=request,
        now=NOW,
    )

    staged = finalize_billed_sync_result(
        db=db,
        newapi=client,
        settings=settings,
        artifact_inspector=artifacts.inspect,
        context=context,
        persist_hidden=artifacts.stage,
        now=NOW,
    )

    job = db.get(GenerationJob, context.job_id)
    assert staged.locator == f"hidden-image:{context.job_id}"
    assert job.result_staged is True and job.result_visible is True
    assert job.status == "billed"
    reconciliation = db.get(BillingReconciliation, context.claim.row_id)
    assert reconciliation.status == "resolved"
    assert client.events[-1] == ("receipt", "image", REQUEST_ID)


def test_unverifiable_sync_result_releases_hold_and_returns_sanitized_unavailable(
    billing_context
):
    db, settings = billing_context
    client = FakeNewApi()
    artifacts = ArtifactStore()
    request = prepare_image_generation_request("gpt-image-2", "frame", 2, "1024x1024", "standard")
    context = execute_billed_provider_call(
        db=db,
        newapi=client,
        settings=settings,
        artifact_inspector=artifacts.inspect,
        user_id=USER_ID,
        project_id=PROJECT_ID,
        parent_job_id=None,
        capability="image",
        operation="image_generation",
        request=request,
        now=NOW,
    )

    with pytest.raises(ProviderResultUnavailable):
        finalize_billed_sync_result(
            db=db,
            newapi=client,
            settings=settings,
            artifact_inspector=artifacts.inspect,
            context=context,
            persist_hidden=lambda _job_id, _response: (_ for _ in ()).throw(
                ValueError("raw provider content")
            ),
            now=NOW,
        )

    child = db.get(GenerationJob, context.job_id)
    hold = db.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    assert child.status == "provider_result_missing_no_charge"
    assert hold.status == "released"
    assert db.scalar(select(func.count(WalletEntry.id))) == 0


def test_billed_image_service_returns_only_owned_media_urls_after_receipt(
    billing_context, tmp_path
):
    db, settings = billing_context
    client = FakeNewApi()
    store = WorkbenchStore(tmp_path / "projects")
    store._ensure_project_dirs(PROJECT_ID)

    result = generate_billed_project_image(
        db=db,
        newapi=client,
        settings=settings,
        media_store=store,
        user_id=USER_ID,
        project_id=PROJECT_ID,
        prompt="frame",
        model="gpt-image-2",
        count=2,
        size="1024x1024",
        quality="standard",
    )

    assert result.images == (
        f"/api/projects/{PROJECT_ID}/media/assets/images/generated/{result.job_id}-0.png",
        f"/api/projects/{PROJECT_ID}/media/assets/images/generated/{result.job_id}-1.png",
    )
    assert db.get(GenerationJob, result.job_id).result_visible is True
    assert "uq_" not in repr(result)
    assert REQUEST_ID not in repr(result)


def test_insufficient_stale_resize_keeps_same_child_hold_alias_and_multiplier_for_retry(
    billing_context
):
    db, settings = billing_context
    wallet = db.scalar(select(WalletAccount).where(WalletAccount.user_id == USER_ID))
    wallet.balance_units = 1_500_000
    db.commit()
    client = FakeNewApi()
    client.quotes.append(quote("uq_" + "B" * 32, cost_micro=2_000_000))
    client.execute_effects = [QuoteStale()]
    artifacts = ArtifactStore()
    request = prepare_image_generation_request("gpt-image-2", "frame", 2, "1024x1024", "standard")

    with pytest.raises(PaymentRequiredQuote) as caught:
        execute_billed_provider_call(
            db=db,
            newapi=client,
            settings=settings,
            artifact_inspector=artifacts.inspect,
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=None,
            capability="image",
            operation="image_generation",
            request=request,
            now=NOW,
        )

    original = db.get(GenerationJob, caught.value.job_id)
    hold = db.scalar(select(WalletHold).where(WalletHold.job_id == original.id))
    assert original.status == "payment_required_quote"
    assert original.token_alias == "image-v1" and original.multiplier_bps == 15_000
    assert hold.status == "active" and hold.amount_units == 1_500_000

    wallet.balance_units = 10_000_000
    db.commit()
    client.quotes = [quote("uq_" + "C" * 32, cost_micro=2_000_000)]
    context = retry_payment_required_quote(
        job_id=original.id,
        db=db,
        newapi=client,
        settings=settings,
        artifact_inspector=artifacts.inspect,
        user_id=USER_ID,
        project_id=PROJECT_ID,
        capability="image",
        operation="image_generation",
        request=request,
        now=NOW,
    )

    assert context.job_id == original.id
    assert db.scalar(select(func.count(GenerationJob.id))) == 1
    assert db.scalar(select(func.count(WalletHold.id))) == 1
    assert client.events[-2][3] == "image-v1"


def test_two_confirmed_stale_requotes_are_bounded_and_release_without_execution(
    billing_context
):
    db, settings = billing_context
    client = FakeNewApi()
    client.quotes.extend(
        [quote("uq_" + "B" * 32), quote("uq_" + "C" * 32)]
    )
    client.execute_effects = [QuoteStale(), QuoteStale(), QuoteStale()]
    artifacts = ArtifactStore()
    request = prepare_image_generation_request("gpt-image-2", "frame", 2, "1024x1024", "standard")

    with pytest.raises(ProviderPricingUnstable):
        execute_billed_provider_call(
            db=db,
            newapi=client,
            settings=settings,
            artifact_inspector=artifacts.inspect,
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=None,
            capability="image",
            operation="image_generation",
            request=request,
            now=NOW,
        )

    child = db.scalar(select(GenerationJob))
    hold = db.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    assert child.status == "provider_pricing_unstable_no_charge"
    assert hold.status == "released"
    assert [event[0] for event in client.events].count("quote") == 3
    assert [event[0] for event in client.events].count("execute") == 3


def test_initial_quote_rate_limit_creates_no_child_hold_or_execution(billing_context):
    db, settings = billing_context
    client = FakeNewApi()
    client.quote_effects = [NewApiRateLimited("limited")]
    artifacts = ArtifactStore()
    request = prepare_image_generation_request("gpt-image-2", "frame", 2, "1024x1024", "standard")

    with pytest.raises(NewApiRateLimited):
        execute_billed_provider_call(
            db=db,
            newapi=client,
            settings=settings,
            artifact_inspector=artifacts.inspect,
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=None,
            capability="image",
            operation="image_generation",
            request=request,
            now=NOW,
        )

    assert db.scalar(select(func.count(GenerationJob.id))) == 0
    assert db.scalar(select(func.count(WalletHold.id))) == 0
    assert [event[0] for event in client.events] == ["quote"]


def test_safe_requote_rate_limit_releases_existing_hold_without_upstream(billing_context):
    db, settings = billing_context
    client = FakeNewApi()
    client.quote_effects = [None, NewApiRateLimited("limited")]
    client.execute_effects = [QuoteStale()]
    artifacts = ArtifactStore()
    request = prepare_image_generation_request("gpt-image-2", "frame", 2, "1024x1024", "standard")

    with pytest.raises(NewApiRateLimited):
        execute_billed_provider_call(
            db=db,
            newapi=client,
            settings=settings,
            artifact_inspector=artifacts.inspect,
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=None,
            capability="image",
            operation="image_generation",
            request=request,
            now=NOW,
        )

    child = db.scalar(select(GenerationJob))
    hold = db.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    assert child.status == "provider_quote_rate_limited_no_charge"
    assert hold.status == "released"
    assert [event[0] for event in client.events].count("execute") == 1


def test_initial_zero_price_quote_creates_no_child_hold_or_execution(billing_context):
    db, settings = billing_context
    client = FakeNewApi()
    client.quotes = [quote("uq_" + "Z" * 32, cost_micro=0)]
    artifacts = ArtifactStore()
    request = prepare_image_generation_request("gpt-image-2", "frame", 2, "1024x1024", "standard")

    with pytest.raises(ProviderPricingUnavailable):
        execute_billed_provider_call(
            db=db,
            newapi=client,
            settings=settings,
            artifact_inspector=artifacts.inspect,
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=None,
            capability="image",
            operation="image_generation",
            request=request,
            now=NOW,
        )

    assert db.scalar(select(func.count(GenerationJob.id))) == 0
    assert db.scalar(select(func.count(WalletHold.id))) == 0
    assert [event[0] for event in client.events] == ["quote"]
