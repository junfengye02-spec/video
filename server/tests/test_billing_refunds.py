from __future__ import annotations

import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy import Engine, create_engine, event, func, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from server.app.auth.models import User
from server.app.billing.models import (
    BillingReconciliation,
    BillingSetting,
    CostReceipt,
    GenerationJob,
)
from server.app.billing.reconciliation import (
    reconcile_due_jobs,
    recover_provider_reference,
)
from server.app.billing.service import BillingService
from server.app.db.base import Base
from server.app.payments.models import PaymentOrder
from server.app.projects.models import ProjectRecord
from server.app.provider.newapi import (
    CapabilityAliasUnavailable,
    NewApiCallError,
    QuoteNotFound,
    ReceiptNotFound,
    UsageQuote,
    UsageQuoteStatus,
    UsageReceipt,
    VideoTaskStatus,
    TokenScopedQuote,
)
from server.app.storage import WorkbenchStore
from server.app.wallet.models import WalletAccount, WalletEntry, WalletHold


NOW = datetime(2026, 7, 12, 4, 5, 6, tzinfo=timezone.utc)
SETTINGS = SimpleNamespace(
    billing_reference_recovery_seconds=86_400,
    billing_receipt_deadline_seconds=86_400,
    billing_hold_timeout_seconds=86_400,
)


def quote(*, alias: str = "video-original", capability: str = "video"):
    return TokenScopedQuote(
        token_alias=alias,
        quote=UsageQuote(
            quote_id=f"uq_{uuid.uuid4().hex}",
            status="quoted",
            model=f"{capability}-model",
            fixed_group=f"openmontage-{capability}",
            relay_format="task" if capability == "video" else "openai",
            estimated_quota=1_000_000,
            quota_per_unit=Decimal("500000"),
            cost_currency="USD",
            estimated_cost_amount_micro=2_000_000,
            pricing_version="sha256:pricing",
            billing_fingerprint="sha256:fingerprint",
            other_ratios={"seconds": Decimal("10")},
            expires_at=int((NOW + timedelta(minutes=2)).timestamp()),
        ),
    )


def receipt(reference_id: str, *, status: str = "settled") -> UsageReceipt:
    return UsageReceipt(
        reference_type="task" if reference_id.startswith("task") else "request",
        reference_id=reference_id,
        status=status,
        model="video-model" if reference_id.startswith("task") else "text-model",
        quota=15_834_000,
        refunded_quota=15_834_000 if status == "refunded" else 0,
        quota_per_unit=Decimal("500000"),
        pricing_version="sha256:pricing",
        cost_currency="USD",
        cost_amount_micro=2_000_000 if status == "settled" else 0,
        settled_at=int(NOW.timestamp()),
    )


def pending_receipt(reference_id: str) -> UsageReceipt:
    return UsageReceipt(
        reference_type="task" if reference_id.startswith("task") else "request",
        reference_id=reference_id,
        status="pending",
        model="video-model" if reference_id.startswith("task") else "text-model",
        quota=0,
        refunded_quota=0,
        quota_per_unit=Decimal("500000"),
        pricing_version="sha256:pricing",
        cost_currency="USD",
        cost_amount_micro=0,
        settled_at=None,
    )


@pytest.fixture
def billing_context(tmp_path):
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    project_id = uuid.uuid4().hex
    user_id = uuid.uuid4().hex
    store = WorkbenchStore(projects_root=tmp_path / "projects")
    with Session(engine, expire_on_commit=False) as db:
        db.add(
            User(
                id=user_id,
                email="refunds@example.com",
                password_hash="hash",
                role="user",
                status="active",
            )
        )
        db.flush()
        db.add_all(
            [
                ProjectRecord(
                    id=project_id,
                    owner_user_id=user_id,
                    title="Refund recovery",
                    mode="short_drama",
                    project_type="single_video",
                ),
                WalletAccount(
                    id=uuid.uuid4().hex,
                    user_id=user_id,
                    balance_units=100_000_000,
                    held_units=0,
                ),
                BillingSetting(id=1, multiplier_bps=15_000, version=0),
            ]
        )
        db.commit()
        service = BillingService(
            db, SETTINGS, store.inspect_staged_artifact, now=lambda: NOW
        )
        yield db, service, store, user_id, project_id
    engine.dispose()


def reserve(
    service, user_id, project_id, *, capability="video", alias=None, recovery=True
):
    scoped = quote(alias=alias or f"{capability}-original", capability=capability)
    child = service.reserve_provider_call(
        user_id=user_id,
        project_id=project_id,
        parent_job_id=None,
        capability=capability,
        operation="shot:s1",
        provider_method="POST",
        provider_route="/v1/videos" if capability == "video" else "/v1/chat/completions",
        quote=scoped,
    )
    if recovery:
        service.mark_reference_recovery_pending(child.id)
    return child


def valid_request_id() -> str:
    return "20260712040506000000000abcdefghijklmnop"


def fake_client() -> Mock:
    client = Mock()
    client.quote = Mock()
    client.execute_quoted = Mock()
    return client


def test_accepted_video_reference_recovers_downloads_stages_and_bills(
    billing_context, monkeypatch
):
    db, service, store, user_id, project_id = billing_context
    child = reserve(service, user_id, project_id)
    task_id = f"task_{uuid.uuid4().hex}"
    client = fake_client()
    client.get_quote_status.return_value = UsageQuoteStatus(
        quote_id=child.quote_id,
        status="accepted",
        reference_type="task",
        reference_id=task_id,
        created_at=int(NOW.timestamp()),
        expires_at=int((NOW + timedelta(minutes=2)).timestamp()),
        consumed_at=int(NOW.timestamp()),
        updated_at=int(NOW.timestamp()),
    )
    client.get_video_task.return_value = VideoTaskStatus(id=task_id, status="completed")
    client.download_video_content.side_effect = (
        lambda _alias, _task, path: path.write_bytes(b"video")
    )
    client.get_task_receipt.return_value = receipt(task_id)
    monkeypatch.setattr(
        "server.app.provider.video_recovery.probe_output",
        lambda path: {"file_size_bytes": path.stat().st_size, "video_width": 16},
    )

    assert reconcile_due_jobs(
        db, client, NOW, 100, settings=SETTINGS, media_store=store
    ) == 1

    job = db.get(GenerationJob, child.id)
    assert job is not None and job.status == "billed"
    assert job.provider_reference_id == task_id
    assert job.result_staged is True and job.result_visible is True
    assert store.exists(job.result_locator, sha256=job.result_sha256)
    client.get_quote_status.assert_called_once_with("video", "video-original", child.quote_id)
    client.quote.assert_not_called()
    client.execute_quoted.assert_not_called()


def test_recovered_sync_reference_is_undeliverable_no_charge(billing_context):
    db, service, store, user_id, project_id = billing_context
    child = reserve(service, user_id, project_id, capability="text")
    request_id = valid_request_id()
    client = fake_client()
    client.get_quote_status.return_value = UsageQuoteStatus(
        quote_id=child.quote_id,
        status="consuming",
        reference_type="request",
        reference_id=request_id,
        created_at=int(NOW.timestamp()),
        expires_at=int((NOW + timedelta(minutes=2)).timestamp()),
        consumed_at=int(NOW.timestamp()),
        updated_at=int(NOW.timestamp()),
    )
    client.get_request_receipt.return_value = receipt(request_id)

    reconcile_due_jobs(db, client, NOW, 100, settings=SETTINGS, media_store=store)

    job = db.get(GenerationJob, child.id)
    hold = db.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    assert job is not None and job.status == "provider_result_missing_no_charge"
    assert job.provider_reference_id == request_id and not job.result_visible
    assert hold is not None and hold.status == "released"
    assert db.scalar(
        select(func.count(WalletEntry.id)).where(WalletEntry.source_id == child.id)
    ) == 0
    assert db.scalar(
        select(func.count(CostReceipt.id)).where(CostReceipt.job_id == child.id)
    ) == 1
    client.get_request_receipt.assert_called_once_with(
        "text", "text-original", request_id
    )
    client.quote.assert_not_called()
    client.execute_quoted.assert_not_called()


def test_recovered_sync_receipt_accounting_survives_pending_passes_and_restart(
    billing_context,
):
    db, service, store, user_id, project_id = billing_context
    child = reserve(service, user_id, project_id, capability="text")
    request_id = valid_request_id()
    client = fake_client()
    client.get_quote_status.return_value = UsageQuoteStatus(
        quote_id=child.quote_id,
        status="accepted",
        reference_type="request",
        reference_id=request_id,
        created_at=int(NOW.timestamp()),
        expires_at=int((NOW + timedelta(minutes=2)).timestamp()),
        consumed_at=int(NOW.timestamp()),
        updated_at=int(NOW.timestamp()),
    )

    assert recover_provider_reference(
        db, client, child.id, NOW, settings=SETTINGS
    ) == "undeliverable"
    machine = db.scalar(
        select(BillingReconciliation).where(
            BillingReconciliation.job_id == child.id,
            BillingReconciliation.reason == "receipt_pending",
        )
    )
    assert machine is not None and machine.status == "open"

    client.get_request_receipt.side_effect = [
        pending_receipt(request_id),
        pending_receipt(request_id),
        receipt(request_id),
    ]
    current = NOW
    for _pass in range(2):
        with Session(db.get_bind(), expire_on_commit=False) as restarted:
            assert reconcile_due_jobs(
                restarted,
                client,
                current,
                100,
                settings=SETTINGS,
                media_store=store,
            ) == 1
            row = restarted.get(BillingReconciliation, machine.id)
            assert row is not None and row.status == "open"
            current = row.next_retry_at.replace(tzinfo=timezone.utc)

    with Session(db.get_bind(), expire_on_commit=False) as restarted:
        assert reconcile_due_jobs(
            restarted,
            client,
            current,
            100,
            settings=SETTINGS,
            media_store=store,
        ) == 1
        assert restarted.get(BillingReconciliation, machine.id).status == "resolved"
        assert restarted.scalar(
            select(CostReceipt).where(CostReceipt.job_id == child.id)
        ) is not None
        operator = restarted.scalar(
            select(BillingReconciliation).where(
                BillingReconciliation.job_id == child.id,
                BillingReconciliation.reason == "provider_result_missing",
            )
        )
        assert operator is not None and operator.status == "open"
        assert restarted.scalar(
            select(func.count(WalletEntry.id)).where(
                WalletEntry.source_id == child.id
            )
        ) == 0


def test_worker_recovered_sync_hands_off_to_one_receipt_machine(
    billing_context,
):
    db, service, store, user_id, project_id = billing_context
    child = reserve(service, user_id, project_id, capability="text")
    request_id = valid_request_id()
    client = fake_client()
    client.get_quote_status.return_value = UsageQuoteStatus(
        quote_id=child.quote_id,
        status="accepted",
        reference_type="request",
        reference_id=request_id,
        created_at=int(NOW.timestamp()),
        expires_at=int((NOW + timedelta(minutes=2)).timestamp()),
        consumed_at=int(NOW.timestamp()),
        updated_at=int(NOW.timestamp()),
    )
    client.get_request_receipt.return_value = pending_receipt(request_id)

    assert reconcile_due_jobs(
        db, client, NOW, 1, settings=SETTINGS, media_store=store
    ) == 1

    machines = db.scalars(
        select(BillingReconciliation).where(
            BillingReconciliation.job_id == child.id,
            BillingReconciliation.status == "open",
            BillingReconciliation.reason.in_(
                {"reference_recovery", "receipt_pending"}
            ),
        )
    ).all()
    assert [row.reason for row in machines] == ["receipt_pending"]
    client.get_request_receipt.assert_called_once()


def test_reconciliation_discovery_excludes_covered_jobs_before_limit(
    billing_context,
):
    db, service, store, user_id, project_id = billing_context
    wallet = db.scalar(
        select(WalletAccount).where(WalletAccount.user_id == user_id)
    )
    wallet.balance_units = 1_000_000_000
    db.commit()
    for index in range(100):
        covered = reserve(service, user_id, project_id, capability="text")
        covered.created_at = NOW + timedelta(microseconds=index)
        db.add(
            BillingReconciliation(
                id=uuid.uuid4().hex,
                job_id=covered.id,
                reason="reference_recovery",
                status="open",
                attempts=0,
                next_retry_at=NOW + timedelta(days=1),
            )
        )
    eligible = reserve(service, user_id, project_id, capability="text")
    eligible.created_at = NOW + timedelta(minutes=1)
    db.commit()

    reconcile_due_jobs(
        db,
        fake_client(),
        NOW,
        100,
        settings=SETTINGS,
        media_store=store,
    )

    assert db.scalar(
        select(BillingReconciliation.id).where(
            BillingReconciliation.job_id == eligible.id,
            BillingReconciliation.reason == "reference_recovery",
        )
    ) is not None


def test_retired_alias_retries_then_leaves_durable_operator_reconciliation(
    billing_context,
):
    db, service, store, user_id, project_id = billing_context
    child = reserve(
        service,
        user_id,
        project_id,
        capability="text",
        alias="text-retired",
    )
    client = fake_client()
    client.get_quote_status.side_effect = CapabilityAliasUnavailable(
        "NewAPI capability token is unavailable"
    )

    reconcile_due_jobs(
        db, client, NOW, 100, settings=SETTINGS, media_store=store
    )
    machine = db.scalar(
        select(BillingReconciliation).where(
            BillingReconciliation.job_id == child.id,
            BillingReconciliation.reason == "reference_recovery",
        )
    )
    assert db.get(GenerationJob, child.id).status == "reference_recovery_pending"
    assert machine is not None and machine.status == "open"
    assert "CapabilityAliasUnavailable" in machine.last_error

    reconcile_due_jobs(
        db,
        client,
        child.reference_deadline.replace(tzinfo=timezone.utc)
        + timedelta(seconds=1),
        100,
        settings=SETTINGS,
        media_store=store,
    )

    assert db.get(GenerationJob, child.id).status == (
        "provider_reference_missing_no_charge"
    )
    assert db.get(BillingReconciliation, machine.id).status == "resolved"
    operator = db.scalar(
        select(BillingReconciliation).where(
            BillingReconciliation.job_id == child.id,
            BillingReconciliation.reason == "provider_configuration_unavailable",
        )
    )
    assert operator is not None and operator.status == "open"
    assert "CapabilityAliasUnavailable" in operator.last_error
    assert "text-retired" not in operator.last_error


def test_reference_and_result_deadlines_release_without_charge(
    billing_context, monkeypatch
):
    db, service, store, user_id, project_id = billing_context
    missing_reference = reserve(service, user_id, project_id)
    client = fake_client()
    client.get_quote_status.side_effect = QuoteNotFound("missing")
    reconcile_due_jobs(
        db,
        client,
        missing_reference.reference_deadline + timedelta(seconds=1),
        100,
        settings=SETTINGS,
        media_store=store,
    )
    assert db.get(GenerationJob, missing_reference.id).status == (
        "provider_reference_missing_no_charge"
    )

    result_child = reserve(service, user_id, project_id)
    task_id = f"task_{uuid.uuid4().hex}"
    service.bind_provider_reference(result_child.id, "task", task_id)
    service.mark_receipt_pending(result_child.id)
    client.get_video_task.side_effect = NewApiCallError("download token=secret")
    monkeypatch.setattr("server.app.provider.video_recovery.probe_output", lambda path: {})
    reconcile_due_jobs(
        db,
        client,
        result_child.receipt_deadline + timedelta(seconds=1),
        100,
        settings=SETTINGS,
        media_store=store,
    )
    assert db.get(GenerationJob, result_child.id).status == "provider_result_missing_no_charge"


def test_malformed_quote_status_stops_at_reference_deadline(billing_context):
    db, service, store, user_id, project_id = billing_context
    child = reserve(service, user_id, project_id)
    client = fake_client()
    client.get_quote_status.return_value = UsageQuoteStatus(
        quote_id=child.quote_id,
        status="failed",
        reference_type="task",
        reference_id=f"task_{uuid.uuid4().hex}",
        created_at=int(NOW.timestamp()),
        expires_at=int((NOW + timedelta(minutes=2)).timestamp()),
        consumed_at=int(NOW.timestamp()),
        updated_at=int(NOW.timestamp()),
    )

    reconcile_due_jobs(
        db,
        client,
        child.reference_deadline + timedelta(seconds=1),
        100,
        settings=SETTINGS,
        media_store=store,
    )

    assert db.get(GenerationJob, child.id).status == (
        "provider_reference_missing_no_charge"
    )


def test_invalid_receipt_identity_stops_at_receipt_deadline(billing_context):
    db, service, store, user_id, project_id = billing_context
    child = reserve(service, user_id, project_id, capability="text")
    expected_id = valid_request_id()
    service.bind_provider_reference(child.id, "request", expected_id)
    service.mark_receipt_pending(child.id)
    client = fake_client()
    client.get_request_receipt.return_value = receipt(
        "20260712040506000000000ponmlkjihgfedcba"
    )

    reconcile_due_jobs(
        db,
        client,
        child.receipt_deadline + timedelta(seconds=1),
        100,
        settings=SETTINGS,
        media_store=store,
    )

    assert db.get(GenerationJob, child.id).status == "receipt_missing_no_charge"


def test_missing_receipt_deadline_and_delayed_refund_are_zero_charge(billing_context):
    db, service, store, user_id, project_id = billing_context
    missing = reserve(service, user_id, project_id, capability="text")
    request_id = valid_request_id()
    service.bind_provider_reference(missing.id, "request", request_id)
    service.mark_receipt_pending(missing.id)
    client = fake_client()
    client.get_request_receipt.side_effect = ReceiptNotFound("missing")
    reconcile_due_jobs(
        db,
        client,
        missing.receipt_deadline + timedelta(seconds=1),
        100,
        settings=SETTINGS,
        media_store=store,
    )
    assert db.get(GenerationJob, missing.id).status == "receipt_missing_no_charge"

    refund_child = reserve(service, user_id, project_id)
    task_id = f"task_{uuid.uuid4().hex}"
    service.bind_provider_reference(refund_child.id, "task", task_id)
    service.fail_job(refund_child.id, receipt(task_id, status="refund_pending"))
    client.get_task_receipt.side_effect = None
    client.get_task_receipt.return_value = receipt(task_id, status="refunded")
    reconcile_due_jobs(db, client, NOW, 100, settings=SETTINGS, media_store=store)
    reconciliation = db.scalar(
        select(BillingReconciliation).where(
            BillingReconciliation.job_id == refund_child.id,
            BillingReconciliation.reason == "upstream_refund_pending",
        )
    )
    assert reconciliation is not None and reconciliation.status == "resolved"
    assert db.scalar(
        select(func.count(WalletEntry.id)).where(
            WalletEntry.source_id == refund_child.id
        )
    ) == 0


def test_retry_schedule_and_all_expired_payment_orders(billing_context):
    db, service, store, user_id, project_id = billing_context
    child = reserve(service, user_id, project_id, capability="text")
    request_id = valid_request_id()
    service.bind_provider_reference(child.id, "request", request_id)
    service.mark_receipt_pending(child.id)
    db.add_all(
        [
            PaymentOrder(
                id=uuid.uuid4().hex,
                user_id=user_id,
                product_id="credits",
                product_title="Credits",
                price_cny_fen=100,
                credit_units=1000,
                merchant_order_no=f"OM{uuid.uuid4().hex}",
                payment_provider="epay",
                payment_method="alipay",
                status="pending",
                expires_at=NOW - timedelta(seconds=1),
            ),
            PaymentOrder(
                id=uuid.uuid4().hex,
                user_id=user_id,
                product_id="credits",
                product_title="Credits",
                price_cny_fen=100,
                credit_units=1000,
                merchant_order_no=f"OM{uuid.uuid4().hex}",
                payment_provider="epay",
                payment_method="alipay",
                status="pending",
                expires_at=NOW - timedelta(minutes=30),
            ),
        ]
    )
    db.commit()
    client = fake_client()
    client.get_request_receipt.side_effect = ReceiptNotFound("missing bearer abc")

    current = NOW
    expected = [5, 15, 30, 60, 300]
    for delay in expected:
        reconcile_due_jobs(db, client, current, 100, settings=SETTINGS, media_store=store)
        row = db.scalar(
            select(BillingReconciliation).where(BillingReconciliation.job_id == child.id)
        )
        assert row is not None
        assert row.next_retry_at.replace(tzinfo=timezone.utc) == current + timedelta(seconds=delay)
        assert len(row.last_error) <= 500 and "abc" not in row.last_error
        current = row.next_retry_at.replace(tzinfo=timezone.utc)

    assert all(order.status == "expired" for order in db.scalars(select(PaymentOrder)).all())


def test_payment_required_quote_expires_without_provider_call(billing_context):
    db, service, store, user_id, project_id = billing_context
    child = reserve(service, user_id, project_id, recovery=False)
    wallet = db.scalar(select(WalletAccount).where(WalletAccount.user_id == user_id))
    wallet.balance_units = wallet.held_units
    db.commit()
    fresh = quote()
    fresh = TokenScopedQuote(
        token_alias=fresh.token_alias,
        quote=fresh.quote.model_copy(
            update={
                "quote_id": f"uq_{uuid.uuid4().hex}",
                "estimated_cost_amount_micro": 200_000_000,
            }
        ),
    )
    assert service.replace_job_quote(
        child.id, fresh, expected_quote_id=child.quote_id
    ) == "payment_required_quote"
    hold = db.scalar(select(WalletHold).where(WalletHold.job_id == child.id))
    client = fake_client()

    reconcile_due_jobs(
        db,
        client,
        hold.expires_at.replace(tzinfo=timezone.utc) + timedelta(seconds=1),
        100,
        settings=SETTINGS,
        media_store=store,
    )

    assert db.get(GenerationJob, child.id).status == "provider_not_submitted_no_charge"
    assert client.method_calls == []


def test_manage_reconcile_once_needs_no_session_store_or_redis(
    billing_context, monkeypatch
):
    from server import manage

    db, _service, store, _user_id, _project_id = billing_context
    client = fake_client()
    called = Mock(return_value=0)
    monkeypatch.setattr("server.app.billing.reconciliation.reconcile_due_jobs", called)

    assert manage.run_manage(
        ["reconcile-billing", "--once"],
        db_session=db,
        billing_client=client,
        media_store=store,
        settings=SETTINGS,
    ) == 0
    called.assert_called_once()


def test_worker_waits_five_seconds_uses_fresh_sessions_and_closes_client(monkeypatch):
    from server import billing_worker

    sessions = []

    class SessionContext:
        def __enter__(self):
            session = Mock()
            sessions.append(session)
            return session

        def __exit__(self, *_args):
            return None

    class Stop:
        def __init__(self):
            self.iterations = 0
            self.waits = []

        def is_set(self):
            return self.iterations >= 2

        def wait(self, seconds):
            self.waits.append(seconds)
            self.iterations += 1

    stop = Stop()
    client = Mock()
    reconcile = Mock(return_value=0)
    monkeypatch.setattr(billing_worker, "reconcile_due_jobs", reconcile)

    billing_worker.run_worker(
        stop,
        session_factory=SessionContext,
        client=client,
        settings=SETTINGS,
        media_store=Mock(),
        now=lambda: NOW,
    )

    assert len(sessions) == 2
    assert stop.waits == [5, 5]
    assert reconcile.call_count == 2
    client.close.assert_called_once_with()


@pytest.fixture
def postgres_engine() -> Engine:
    database_url = os.getenv("OPENMONTAGE_TEST_POSTGRES_URL")
    if not database_url:
        pytest.skip("OPENMONTAGE_TEST_POSTGRES_URL is not configured")
    schema_name = f"billing_task9_{uuid.uuid4().hex}"
    admin_engine = create_engine(database_url)
    engine = None
    try:
        with admin_engine.begin() as connection:
            version_num = int(connection.scalar(text("SHOW server_version_num")))
            assert version_num // 10_000 == 16
            connection.execute(text(f'CREATE SCHEMA "{schema_name}"'))
        engine = create_engine(
            database_url,
            connect_args={"options": f"-csearch_path={schema_name}"},
            pool_size=6,
        )
        Base.metadata.create_all(engine)
        yield engine
    finally:
        if engine is not None:
            engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema_name}" CASCADE'))
        admin_engine.dispose()


def test_postgres_skip_locked_lease_prevents_duplicate_network_and_holds_no_job_lock(
    postgres_engine: Engine, tmp_path
):
    user_id = uuid.uuid4().hex
    project_id = uuid.uuid4().hex
    store = WorkbenchStore(projects_root=tmp_path / "pg-projects")
    with Session(postgres_engine, expire_on_commit=False) as db:
        db.add(
            User(
                id=user_id,
                email="billing-task9-pg@example.com",
                password_hash="hash",
                role="user",
                status="active",
            )
        )
        db.flush()
        db.add_all(
            [
                ProjectRecord(
                    id=project_id,
                    owner_user_id=user_id,
                    title="Task 9 PostgreSQL",
                    mode="short_drama",
                    project_type="single_video",
                ),
                WalletAccount(
                    id=uuid.uuid4().hex,
                    user_id=user_id,
                    balance_units=100_000_000,
                    held_units=0,
                ),
                BillingSetting(id=1, multiplier_bps=15_000, version=0),
            ]
        )
        db.commit()
        service = BillingService(
            db, SETTINGS, store.inspect_staged_artifact, now=lambda: NOW
        )
        child = reserve(service, user_id, project_id, capability="text")

    entered_network = threading.Event()
    release_network = threading.Event()
    lock_probe_succeeded = threading.Event()
    calls = 0
    calls_lock = threading.Lock()
    statements = []

    class SlowClient:
        def get_quote_status(self, kind, alias, quote_id):
            nonlocal calls
            with calls_lock:
                calls += 1
            with Session(postgres_engine) as probe:
                probe.scalar(
                    select(GenerationJob)
                    .where(GenerationJob.id == child.id)
                    .with_for_update(nowait=True)
                )
                lock_probe_succeeded.set()
                probe.rollback()
            entered_network.set()
            assert release_network.wait(timeout=10)
            return UsageQuoteStatus(
                quote_id=quote_id,
                status="accepted",
                reference_type="request",
                reference_id=valid_request_id(),
                created_at=int(NOW.timestamp()),
                expires_at=int((NOW + timedelta(minutes=2)).timestamp()),
                consumed_at=int(NOW.timestamp()),
                updated_at=int(NOW.timestamp()),
            )

        def get_request_receipt(self, *_args):
            return receipt(valid_request_id())

    def capture_sql(_conn, _cursor, statement, *_args):
        if "skip locked" in statement.lower():
            statements.append(statement)

    event.listen(postgres_engine, "before_cursor_execute", capture_sql)
    client = SlowClient()
    try:
        def run_once():
            with Session(postgres_engine, expire_on_commit=False) as db:
                return reconcile_due_jobs(
                    db, client, NOW, 100, settings=SETTINGS, media_store=store
                )

        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(run_once)
            assert entered_network.wait(timeout=10)
            second = executor.submit(run_once)
            assert second.result(timeout=10) == 0
            release_network.set()
            assert first.result(timeout=10) == 2
    finally:
        event.remove(postgres_engine, "before_cursor_execute", capture_sql)
        release_network.set()

    assert calls == 1
    assert lock_probe_succeeded.is_set()
    assert statements and all("FOR UPDATE SKIP LOCKED" in sql.upper() for sql in statements)


def test_postgres_video_file_io_keeps_job_unlocked_and_claim_exclusive(
    postgres_engine: Engine, tmp_path, monkeypatch
):
    user_id = uuid.uuid4().hex
    project_id = uuid.uuid4().hex
    task_id = f"task_{uuid.uuid4().hex}"
    store = WorkbenchStore(projects_root=tmp_path / "pg-video-projects")
    with Session(postgres_engine, expire_on_commit=False) as db:
        db.add(
            User(
                id=user_id,
                email="billing-task9-video-pg@example.com",
                password_hash="hash",
                role="user",
                status="active",
            )
        )
        db.flush()
        db.add_all(
            [
                ProjectRecord(
                    id=project_id,
                    owner_user_id=user_id,
                    title="Task 9 PostgreSQL video",
                    mode="short_drama",
                    project_type="single_video",
                ),
                WalletAccount(
                    id=uuid.uuid4().hex,
                    user_id=user_id,
                    balance_units=100_000_000,
                    held_units=0,
                ),
                BillingSetting(id=1, multiplier_bps=15_000, version=0),
            ]
        )
        db.commit()
        service = BillingService(
            db, SETTINGS, store.inspect_staged_artifact, now=lambda: NOW
        )
        child = reserve(service, user_id, project_id)
        service.bind_provider_reference(child.id, "task", task_id)
        service.mark_receipt_pending(child.id)

    entered_probe = threading.Event()
    release_probe = threading.Event()
    lock_probe_succeeded = threading.Event()
    statements = []
    calls = {"task": 0, "download": 0, "receipt": 0}
    calls_lock = threading.Lock()

    class SlowVideoClient:
        def get_video_task(self, alias, reference_id):
            assert (alias, reference_id) == ("video-original", task_id)
            with calls_lock:
                calls["task"] += 1
            return VideoTaskStatus(id=task_id, status="completed")

        def download_video_content(self, alias, reference_id, destination):
            assert (alias, reference_id) == ("video-original", task_id)
            with calls_lock:
                calls["download"] += 1
            destination.write_bytes(b"postgres-video")

        def get_task_receipt(self, kind, alias, reference_id):
            assert (kind, alias, reference_id) == (
                "video",
                "video-original",
                task_id,
            )
            with calls_lock:
                calls["receipt"] += 1
            return receipt(task_id)

    def slow_probe(path):
        assert path.read_bytes() == b"postgres-video"
        with Session(postgres_engine) as probe:
            probe.scalar(
                select(GenerationJob)
                .where(GenerationJob.id == child.id)
                .with_for_update(nowait=True)
            )
            lock_probe_succeeded.set()
            probe.rollback()
        entered_probe.set()
        assert release_probe.wait(timeout=10)
        return {"file_size_bytes": path.stat().st_size, "video_width": 16}

    def capture_sql(_conn, _cursor, statement, *_args):
        if "skip locked" in statement.lower():
            statements.append(statement)

    monkeypatch.setattr(
        "server.app.provider.video_recovery.probe_output", slow_probe
    )
    event.listen(postgres_engine, "before_cursor_execute", capture_sql)
    client = SlowVideoClient()
    try:
        def run_once():
            with Session(postgres_engine, expire_on_commit=False) as db:
                return reconcile_due_jobs(
                    db, client, NOW, 100, settings=SETTINGS, media_store=store
                )

        with ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(run_once)
            assert entered_probe.wait(timeout=10)
            second = executor.submit(run_once)
            assert second.result(timeout=10) == 0
            release_probe.set()
            assert first.result(timeout=10) == 1
    finally:
        event.remove(postgres_engine, "before_cursor_execute", capture_sql)
        release_probe.set()

    with Session(postgres_engine) as db:
        job = db.get(GenerationJob, child.id)
        assert job is not None and job.status == "billed"
        assert job.result_staged is True and job.result_visible is True
        assert store.exists(job.result_locator, sha256=job.result_sha256)
        artifact_id = job.result_locator.rsplit(":", 1)[-1]
        published = (
            store.project_dir(project_id)
            / "assets"
            / "video"
            / ".hidden"
            / artifact_id
        )
        assert {path.name for path in published.iterdir()} == {
            "metadata.json",
            "video.mp4",
        }

    assert calls == {"task": 1, "download": 1, "receipt": 1}
    assert lock_probe_succeeded.is_set()
    assert statements and all(
        "FOR UPDATE SKIP LOCKED" in sql.upper() for sql in statements
    )
