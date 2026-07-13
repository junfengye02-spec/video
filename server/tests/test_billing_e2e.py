from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import create_engine, event, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from server.app.auth.models import User
from server.app.billing.execution import (
    ProviderResultPending,
    StagedProviderResult,
    execute_billed_provider_call,
    finalize_billed_sync_result,
)
from server.app.billing.models import BillingReconciliation, BillingSetting, CostReceipt, GenerationJob
from server.app.billing.reconciliation import reconcile_due_jobs
from server.app.billing.service import BillingService
from server.app.db.base import Base
from server.app.payments.epay import sign_epay
from server.app.payments.models import PaymentOrder
from server.app.payments.service import create_epay_order, settle_epay_notify
from server.app.projects.models import ProjectRecord
from server.app.provider.newapi import (
    AmbiguousNewApiResult,
    PreparedNewApiRequest,
    QuotedExecutionResult,
    TokenScopedQuote,
    UsageQuote,
    UsageQuoteStatus,
    UsageReceipt,
    VideoTaskStatus,
)
from server.app.storage import WorkbenchStore
from server.app.wallet.models import WalletAccount, WalletEntry, WalletHold


NOW = datetime(2026, 7, 12, 8, 9, 10, tzinfo=timezone.utc)
USER_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaae2e1"
PROJECT_ID = "1111111111114111811111111111e2e1"
WALLET_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbee21"
PRICING_VERSION = "sha256:e2e-pricing"
FINGERPRINT = "sha256:e2e-fingerprint"
QUOTA_PER_UNIT = Decimal("500000")


def quote_id(index: int) -> str:
    return f"uq_{index:032d}"


def task_id() -> str:
    return f"task_{uuid.uuid4().hex}"


def request_id(index: int) -> str:
    return f"20260712080910000000000{index:016x}"


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def provider_route(kind: str) -> str:
    return {
        "video": "/v1/videos",
        "image": "/v1/images/generations",
        "text": "/v1/chat/completions",
    }[kind]


def relay_format(kind: str) -> str:
    return {"video": "task", "image": "openai_image", "text": "openai"}[kind]


@dataclass
class QuoteConfig:
    kind: str
    estimated_cost_micro: int
    estimated_quota: int
    alias: str | None = None


@dataclass
class ExecutionConfig:
    kind: str
    reference_id: str
    ambiguous: bool = False


class FakeNewApi:
    def __init__(self) -> None:
        self.current_aliases = {
            "text": "text-v1",
            "image": "image-v1",
            "video": "video-v1",
        }
        self.quote_configs: list[QuoteConfig] = []
        self.execution_configs: list[ExecutionConfig] = []
        self.quotes: dict[str, TokenScopedQuote] = {}
        self.quote_references: dict[str, tuple[str, str]] = {}
        self.receipts: dict[str, UsageReceipt] = {}
        self.quote_counter = 0
        self.upstream_accept_count = 0
        self.execute_calls: list[tuple[str, str, str]] = []
        self.quote_status_calls: list[tuple[str, str, str]] = []
        self.task_receipt_calls: list[tuple[str, str, str]] = []
        self.request_receipt_calls: list[tuple[str, str, str]] = []
        self.video_task_calls: list[tuple[str, str]] = []
        self.download_calls: list[tuple[str, str]] = []
        self.last_quote_id: str | None = None

    def queue_quote(
        self,
        *,
        kind: str,
        estimated_cost_micro: int,
        estimated_quota: int = 1_449_000,
        alias: str | None = None,
    ) -> None:
        self.quote_configs.append(
            QuoteConfig(
                kind=kind,
                estimated_cost_micro=estimated_cost_micro,
                estimated_quota=estimated_quota,
                alias=alias,
            )
        )

    def queue_execution(
        self,
        *,
        kind: str,
        reference_id: str,
        ambiguous: bool = False,
    ) -> None:
        self.execution_configs.append(
            ExecutionConfig(kind=kind, reference_id=reference_id, ambiguous=ambiguous)
        )

    def quote(
        self,
        kind: str,
        request: PreparedNewApiRequest,
        token_alias: str | None = None,
    ) -> TokenScopedQuote:
        config = self.quote_configs.pop(0) if self.quote_configs else None
        assert config is None or config.kind == kind
        self.quote_counter += 1
        generated_quote_id = quote_id(self.quote_counter)
        alias = token_alias or (config.alias if config and config.alias else self.current_aliases[kind])
        cost_micro = config.estimated_cost_micro if config else 2_898_000
        estimated_quota = config.estimated_quota if config else 1_449_000
        scoped = TokenScopedQuote(
            token_alias=alias,
            quote=UsageQuote(
                quote_id=generated_quote_id,
                status="quoted",
                model=request.model,
                fixed_group=f"openmontage-{kind}",
                relay_format=relay_format(kind),
                estimated_quota=estimated_quota,
                quota_per_unit=QUOTA_PER_UNIT,
                cost_currency="USD",
                estimated_cost_amount_micro=cost_micro,
                pricing_version=PRICING_VERSION,
                billing_fingerprint=FINGERPRINT,
                other_ratios={"seconds": Decimal("10")},
                expires_at=int((NOW + timedelta(minutes=30)).timestamp()),
            ),
        )
        self.quotes[generated_quote_id] = scoped
        self.last_quote_id = generated_quote_id
        return scoped

    def execute_quoted(
        self,
        kind: str,
        token_alias: str,
        request: PreparedNewApiRequest,
        quote_id_value: str,
    ) -> QuotedExecutionResult:
        config = self.execution_configs.pop(0) if self.execution_configs else None
        assert config is None or config.kind == kind
        reference_type = "task" if kind == "video" else "request"
        reference_id = config.reference_id if config else (
            task_id() if reference_type == "task" else request_id(len(self.execute_calls) + 1)
        )
        self.execute_calls.append((kind, token_alias, quote_id_value))
        self.quote_references[quote_id_value] = (reference_type, reference_id)
        self.upstream_accept_count += 1
        if config and config.ambiguous:
            raise AmbiguousNewApiResult("accepted response was lost")
        response = (
            httpx.Response(200, json={"id": reference_id})
            if reference_type == "task"
            else httpx.Response(
                200,
                content=b'{"created":true}',
                headers={"X-Oneapi-Request-Id": reference_id},
            )
        )
        return QuotedExecutionResult(reference_type, reference_id, response)

    def get_quote_status(
        self, kind: str, token_alias: str, quote_id_value: str
    ) -> UsageQuoteStatus:
        self.quote_status_calls.append((kind, token_alias, quote_id_value))
        reference = self.quote_references.get(quote_id_value)
        return UsageQuoteStatus(
            quote_id=quote_id_value,
            status="accepted" if reference else "quoted",
            reference_type=None if reference is None else reference[0],
            reference_id=None if reference is None else reference[1],
            created_at=int(NOW.timestamp()),
            expires_at=int((NOW + timedelta(minutes=30)).timestamp()),
            consumed_at=int(NOW.timestamp()) if reference else None,
            updated_at=int(NOW.timestamp()),
        )

    def set_receipt(self, receipt: UsageReceipt) -> None:
        self.receipts[receipt.reference_id] = receipt

    def get_task_receipt(
        self, kind: str, token_alias: str, reference_id: str
    ) -> UsageReceipt:
        self.task_receipt_calls.append((kind, token_alias, reference_id))
        return self.receipts[reference_id]

    def get_request_receipt(
        self, kind: str, token_alias: str, reference_id: str
    ) -> UsageReceipt:
        self.request_receipt_calls.append((kind, token_alias, reference_id))
        return self.receipts[reference_id]

    def get_video_task(self, token_alias: str, reference_id: str) -> VideoTaskStatus:
        self.video_task_calls.append((token_alias, reference_id))
        return VideoTaskStatus(id=reference_id, status="completed")

    def download_video_content(self, token_alias: str, reference_id: str, path, **_kwargs) -> None:
        self.download_calls.append((token_alias, reference_id))
        path.write_bytes(b"e2e-video")


class BillingE2E:
    def __init__(self, db: Session, store: WorkbenchStore, settings: SimpleNamespace) -> None:
        self.db = db
        self.store = store
        self.settings = settings
        self.newapi = FakeNewApi()
        self.service = BillingService(
            db,
            settings,
            store.inspect_staged_artifact,
            now=lambda: NOW,
        )

    def wallet(self) -> SimpleNamespace:
        self.db.expire_all()
        wallet = self.db.scalar(select(WalletAccount).where(WalletAccount.user_id == USER_ID))
        assert wallet is not None
        return SimpleNamespace(
            balance_units=wallet.balance_units,
            held_units=wallet.held_units,
            available_units=wallet.balance_units - wallet.held_units,
        )

    def receipt(
        self,
        *,
        reference_type: str,
        reference_id: str,
        model: str,
        status: str = "settled",
        quota: int = 1_449_000,
        refunded_quota: int = 0,
        cost_micro: int = 2_898_000,
    ) -> UsageReceipt:
        return UsageReceipt(
            reference_type=reference_type,
            reference_id=reference_id,
            status=status,
            model=model,
            quota=quota,
            refunded_quota=refunded_quota,
            quota_per_unit=QUOTA_PER_UNIT,
            pricing_version=PRICING_VERSION,
            cost_currency="USD",
            cost_amount_micro=cost_micro,
            settled_at=int(NOW.timestamp()),
        )

    def video_request(self) -> PreparedNewApiRequest:
        return PreparedNewApiRequest.json(
            "POST",
            "/v1/videos",
            {"model": "video-model", "prompt": "billing e2e video"},
        )

    def image_request(self) -> PreparedNewApiRequest:
        return PreparedNewApiRequest.json(
            "POST",
            "/v1/images/generations",
            {"model": "image-model", "prompt": "billing e2e image"},
        )

    def create_and_notify_topup(self, amount_cny_fen: int) -> PaymentOrder:
        order, _action_url, _fields = create_epay_order(
            self.db,
            user_id=USER_ID,
            amount_cny_fen=amount_cny_fen,
            settings=self.settings,
            now=NOW,
        )
        self.notify_order(order)
        return order

    def notify_order(self, order: PaymentOrder, *, trade_no: str | None = None) -> None:
        fields = {
            "pid": self.settings.epay_id,
            "type": "alipay",
            "out_trade_no": order.merchant_order_no,
            "trade_no": trade_no or f"trade_{order.id}",
            "name": order.product_title,
            "money": f"{Decimal(order.price_cny_fen) / Decimal(100):.2f}",
            "trade_status": "TRADE_SUCCESS",
            "sign_type": "MD5",
        }
        fields["sign"] = sign_epay(fields, self.settings.epay_key.get_secret_value())
        settle_epay_notify(self.db, fields=fields, settings=self.settings, now=NOW)
        self.db.commit()

    def count_entries(self, idempotency_key: str) -> int:
        return self.db.scalar(
            select(func.count(WalletEntry.id)).where(WalletEntry.idempotency_key == idempotency_key)
        )

    def consumption_for(self, job_id: str) -> WalletEntry | None:
        return self.db.scalar(
            select(WalletEntry).where(
                WalletEntry.idempotency_key == f"consume:{job_id}",
                WalletEntry.kind == "consume",
            )
        )

    def stage_video(self, job: GenerationJob, reference_id: str) -> None:
        content = b"e2e-video"
        with self.store.hidden_video_destination(
            PROJECT_ID,
            job.operation,
            artifact_id=job.id,
        ) as destination:
            destination.temporary_path.write_bytes(content)
            artifact = destination.commit(
                sha256=sha256_bytes(content),
                source_reference=reference_id,
            )
        self.service.stage_result(job.id, artifact.locator, artifact.sha256)

    def generate_video(
        self,
        *,
        status: str,
        quota: int = 1_449_000,
        task_quota: int | None = None,
        refund_log_quota: int | None = None,
        quote_cost_micro: int = 2_898_000,
        receipt_cost_micro: int | None = None,
    ) -> SimpleNamespace:
        reference_id = task_id()
        request = self.video_request()
        self.newapi.queue_quote(
            kind="video",
            estimated_cost_micro=quote_cost_micro,
            estimated_quota=quota,
        )
        self.newapi.queue_execution(kind="video", reference_id=reference_id)
        context = execute_billed_provider_call(
            db=self.db,
            newapi=self.newapi,
            settings=self.settings,
            artifact_inspector=self.store.inspect_staged_artifact,
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=None,
            capability="video",
            operation=f"shot:{uuid.uuid4().hex[:8]}",
            request=request,
            now=NOW,
        )
        job = self.db.get(GenerationJob, context.job_id)
        assert job is not None
        if status == "SUCCESS":
            self.stage_video(job, reference_id)
            self.service.settle_job(
                job.id,
                self.receipt(
                    reference_type="task",
                    reference_id=reference_id,
                    model=job.model,
                    quota=quota,
                    cost_micro=receipt_cost_micro or quote_cost_micro,
                ),
            )
        elif status == "FAILURE":
            self.service.fail_job(
                job.id,
                self.receipt(
                    reference_type="task",
                    reference_id=reference_id,
                    model=job.model,
                    status="refunded",
                    quota=task_quota or quota,
                    refunded_quota=refund_log_quota or task_quota or quota,
                    cost_micro=0,
                ),
            )
        else:
            raise ValueError("unsupported video status")
        return SimpleNamespace(job_id=job.id, reference_id=reference_id)

    def job_for_quote(self, quote_id_value: str) -> GenerationJob:
        job = self.db.scalar(select(GenerationJob).where(GenerationJob.quote_id == quote_id_value))
        assert job is not None
        return job

    def force_due(self, job_id: str) -> None:
        rows = self.db.scalars(
            select(BillingReconciliation).where(
                BillingReconciliation.job_id == job_id,
                BillingReconciliation.status == "open",
            )
        ).all()
        for row in rows:
            row.next_retry_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.db.commit()


@pytest.fixture
def e2e(tmp_path) -> BillingE2E:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(dbapi_connection, _connection_record):
        dbapi_connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    settings = SimpleNamespace(
        billing_reference_recovery_seconds=86_400,
        billing_receipt_deadline_seconds=86_400,
        billing_hold_timeout_seconds=86_400,
        billing_quote_stale_retries=2,
        billing_max_video_bytes=64 * 1024 * 1024,
        epay_pay_address="https://pay.example.test/submit",
        epay_id="test-merchant",
        epay_key=SecretStr("test-epay-merchant-key"),
        public_origin="https://openmontage.example.test",
    )
    store = WorkbenchStore(projects_root=tmp_path / "projects")
    with Session(engine, expire_on_commit=False) as db:
        db.add(
            User(
                id=USER_ID,
                email="billing-e2e@example.com",
                password_hash="hash",
                role="user",
                status="active",
            )
        )
        db.flush()
        db.add_all(
            [
                ProjectRecord(
                    id=PROJECT_ID,
                    owner_user_id=USER_ID,
                    title="Billing E2E",
                    mode="short_drama",
                    project_type="single_video",
                ),
                WalletAccount(
                    id=WALLET_ID,
                    user_id=USER_ID,
                    balance_units=20_000_000,
                    held_units=0,
                ),
                BillingSetting(id=1, multiplier_bps=15_000, version=0),
            ]
        )
        db.commit()
        yield BillingE2E(db, store, settings)
    engine.dispose()


def test_recharge_then_successful_video_charge(e2e: BillingE2E) -> None:
    order = e2e.create_and_notify_topup(amount_cny_fen=1_000)
    before = e2e.wallet()
    result = e2e.generate_video(status="SUCCESS", quota=1_449_000)
    after = e2e.wallet()

    assert order.status == "paid"
    assert before.balance_units - after.balance_units == 4_347_000
    assert after.held_units == 0
    assert e2e.count_entries(f"consume:{result.job_id}") == 1
    assert e2e.newapi.upstream_accept_count == 1


def test_failed_refunded_video_keeps_full_balance(e2e: BillingE2E) -> None:
    before = e2e.wallet()
    result = e2e.generate_video(
        status="FAILURE",
        task_quota=15_834_000,
        refund_log_quota=15_834_000,
    )
    after = e2e.wallet()
    hold = e2e.db.scalar(select(WalletHold).where(WalletHold.job_id == result.job_id))

    assert after.balance_units == before.balance_units
    assert after.held_units == 0
    assert hold is not None and hold.status == "released"
    assert e2e.consumption_for(result.job_id) is None


def test_duplicate_payment_notify_credits_topup_once(e2e: BillingE2E) -> None:
    order, _action_url, _fields = create_epay_order(
        e2e.db,
        user_id=USER_ID,
        amount_cny_fen=1_000,
        settings=e2e.settings,
        now=NOW,
    )
    e2e.notify_order(order, trade_no="trade_duplicate_notify")
    e2e.notify_order(order, trade_no="trade_duplicate_notify")
    paid = e2e.db.get(PaymentOrder, order.id)

    assert paid is not None and paid.status == "paid"
    assert e2e.count_entries(f"topup:{order.id}") == 1
    assert e2e.wallet().balance_units == 30_000_000


def test_accepted_response_loss_recovers_without_replaying_provider(
    e2e: BillingE2E, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "server.app.provider.video_recovery.probe_output",
        lambda path: {"file_size_bytes": path.stat().st_size, "video_width": 16},
    )
    reference_id = task_id()
    e2e.newapi.queue_quote(kind="video", estimated_cost_micro=2_000_000)
    e2e.newapi.queue_execution(
        kind="video",
        reference_id=reference_id,
        ambiguous=True,
    )

    with pytest.raises(ProviderResultPending):
        execute_billed_provider_call(
            db=e2e.db,
            newapi=e2e.newapi,
            settings=e2e.settings,
            artifact_inspector=e2e.store.inspect_staged_artifact,
            user_id=USER_ID,
            project_id=PROJECT_ID,
            parent_job_id=None,
            capability="video",
            operation="shot:accepted-loss",
            request=e2e.video_request(),
            now=NOW,
        )

    assert e2e.newapi.last_quote_id is not None
    job = e2e.job_for_quote(e2e.newapi.last_quote_id)
    e2e.newapi.set_receipt(
        e2e.receipt(
            reference_type="task",
            reference_id=reference_id,
            model=job.model,
            cost_micro=2_000_000,
        )
    )
    e2e.force_due(job.id)

    assert reconcile_due_jobs(
        e2e.db,
        e2e.newapi,
        NOW,
        10,
        settings=e2e.settings,
        media_store=e2e.store,
    ) == 1
    billed = e2e.db.get(GenerationJob, job.id)

    assert billed is not None and billed.status == "billed"
    assert e2e.newapi.execute_calls == [("video", "video-v1", job.quote_id)]
    assert e2e.newapi.upstream_accept_count == 1
    assert e2e.newapi.download_calls == [("video-v1", reference_id)]


def test_receipt_cost_overrides_quote_estimate(e2e: BillingE2E) -> None:
    before = e2e.wallet()
    result = e2e.generate_video(
        status="SUCCESS",
        quota=1_000_000,
        quote_cost_micro=1_000_000,
        receipt_cost_micro=3_100_000,
    )
    after = e2e.wallet()
    receipt = e2e.db.scalar(select(CostReceipt).where(CostReceipt.job_id == result.job_id))

    assert before.balance_units - after.balance_units == 4_650_000
    assert receipt is not None and receipt.cost_amount_micro == 3_100_000
    assert e2e.count_entries(f"consume:{result.job_id}") == 1


def test_image_request_receipt_bills_sync_result(e2e: BillingE2E) -> None:
    reference_id = request_id(1)
    e2e.newapi.queue_quote(kind="image", estimated_cost_micro=1_200_000)
    e2e.newapi.queue_execution(kind="image", reference_id=reference_id)
    context = execute_billed_provider_call(
        db=e2e.db,
        newapi=e2e.newapi,
        settings=e2e.settings,
        artifact_inspector=e2e.store.inspect_staged_artifact,
        user_id=USER_ID,
        project_id=PROJECT_ID,
        parent_job_id=None,
        capability="image",
        operation="image:cover",
        request=e2e.image_request(),
        now=NOW,
    )
    job = e2e.db.get(GenerationJob, context.job_id)
    assert job is not None
    e2e.newapi.set_receipt(
        e2e.receipt(
            reference_type="request",
            reference_id=reference_id,
            model=job.model,
            quota=800_000,
            cost_micro=1_400_000,
        )
    )

    def persist_hidden(job_id: str, response: httpx.Response) -> StagedProviderResult:
        artifact = e2e.store.stage_sync_result(
            project_id=PROJECT_ID,
            job_id=job_id,
            operation="image:cover",
            capability="image",
            source_reference=reference_id,
            content=response.content,
        )
        return StagedProviderResult(artifact.locator, artifact.sha256, {"ok": True})

    finalize_billed_sync_result(
        db=e2e.db,
        newapi=e2e.newapi,
        settings=e2e.settings,
        artifact_inspector=e2e.store.inspect_staged_artifact,
        context=context,
        persist_hidden=persist_hidden,
        now=NOW,
    )
    billed = e2e.db.get(GenerationJob, context.job_id)

    assert billed is not None and billed.status == "billed"
    assert billed.result_visible is True
    assert e2e.newapi.request_receipt_calls == [("image", "image-v1", reference_id)]
    assert e2e.count_entries(f"consume:{context.job_id}") == 1


def test_old_token_alias_is_used_for_recovery_after_rotation(e2e: BillingE2E) -> None:
    e2e.newapi.current_aliases["video"] = "video-old"
    reference_id = task_id()
    e2e.newapi.queue_quote(kind="video", estimated_cost_micro=1_600_000)
    e2e.newapi.queue_execution(kind="video", reference_id=reference_id)
    context = execute_billed_provider_call(
        db=e2e.db,
        newapi=e2e.newapi,
        settings=e2e.settings,
        artifact_inspector=e2e.store.inspect_staged_artifact,
        user_id=USER_ID,
        project_id=PROJECT_ID,
        parent_job_id=None,
        capability="video",
        operation="shot:alias-rotation",
        request=e2e.video_request(),
        now=NOW,
    )
    job = e2e.db.get(GenerationJob, context.job_id)
    assert job is not None
    e2e.stage_video(job, reference_id)
    e2e.newapi.current_aliases["video"] = "video-new"
    e2e.newapi.set_receipt(
        e2e.receipt(
            reference_type="task",
            reference_id=reference_id,
            model=job.model,
            cost_micro=1_600_000,
        )
    )
    e2e.force_due(job.id)

    assert reconcile_due_jobs(
        e2e.db,
        e2e.newapi,
        NOW,
        10,
        settings=e2e.settings,
        media_store=e2e.store,
    ) == 1

    assert e2e.db.get(GenerationJob, job.id).status == "billed"
    assert e2e.newapi.execute_calls == [("video", "video-old", job.quote_id)]
    assert e2e.newapi.task_receipt_calls == [("video", "video-old", reference_id)]
    assert all(alias != "video-new" for _kind, alias, _ref in e2e.newapi.task_receipt_calls)
