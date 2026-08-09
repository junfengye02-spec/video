from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

os.environ.setdefault("AUTH_HMAC_SECRET", "x" * 32)

from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.auth.models import AdminAuditLog, User
from server.app.billing.models import BillingReconciliation, BillingSetting, GenerationJob
from server.app.core.config import AppSettings, get_settings
from server.app.db.base import Base
from server.app.db.session import get_db
from server.app.main import create_app
from server.app.payments.models import PaymentOrder
from server.app.projects.models import ProjectRecord
from server.app.wallet.models import WalletAccount, WalletEntry


ADMIN = CurrentUser(
    id="a000000000000000000000000000001",
    email="admin@example.com",
    role="admin",
)
USER = CurrentUser(
    id="u000000000000000000000000000001",
    email="user@example.com",
    role="user",
)
PROJECT_ID = "10000000000040008000000000000001"
NOW = datetime(2026, 7, 12, 4, 5, 6, tzinfo=timezone.utc)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as session:
        session.add_all(
            [
                User(
                    id=ADMIN.id,
                    email=ADMIN.email,
                    password_hash="hash",
                    role="admin",
                    status="active",
                ),
                User(
                    id=USER.id,
                    email=USER.email,
                    password_hash="hash",
                    role="user",
                    status="active",
                ),
                ProjectRecord(
                    id=PROJECT_ID,
                    owner_user_id=USER.id,
                    title="Billing",
                    mode="short_drama",
                    project_type="single_video",
                ),
                BillingSetting(id=1, multiplier_bps=15_000, version=0),
                WalletAccount(
                    id="w000000000000000000000000000001",
                    user_id=USER.id,
                    balance_units=10_000_000,
                    held_units=0,
                ),
            ]
        )
        session.flush()
        session.add_all(
            [
                PaymentOrder(
                    id="po000000000000000000000000000001",
                    user_id=USER.id,
                    product_id="prod_basic",
                    product_title="Starter snapshot",
                    price_cny_fen=1_200,
                    credit_units=50_000,
                    merchant_order_no="MERCHANT-SECRET-123456",
                    payment_provider="epay",
                    payment_method="alipay",
                    provider_trade_no="PROVIDER-TRADE-SECRET",
                    status="paid",
                    expires_at=NOW + timedelta(hours=1),
                    paid_at=NOW,
                ),
                WalletEntry(
                    id="we000000000000000000000000000001",
                    wallet_id="w000000000000000000000000000001",
                    user_id=USER.id,
                    amount_units=50_000,
                    balance_after_units=50_000,
                    kind="topup",
                    source_type="payment_order",
                    source_id="po000000000000000000000000000001",
                    idempotency_key="idem-secret-key",
                    created_at=NOW,
                ),
            ]
        )
        child = GenerationJob(
            id="gj000000000000000000000000000001",
            parent_job_id=None,
            chargeable=True,
            user_id=USER.id,
            project_id=PROJECT_ID,
            operation="image_generation",
            capability="image",
            token_kind="image",
            token_alias="image-v1",
            model="gpt-image-2",
            multiplier_bps=15_000,
            provider_method="POST",
            provider_route="/v1/images/generations",
            provider_reference_type="request",
            provider_reference_id="provider_reference_secret",
            reference_deadline=NOW + timedelta(days=1),
            receipt_deadline=NOW + timedelta(days=1),
            status="receipt_pending",
            result_locator="result_locator_secret",
            result_sha256="f" * 64,
            result_staged=True,
            result_visible=False,
            quote_id="quote_id_secret",
            quote_expires_at=NOW + timedelta(minutes=2),
            quote_estimated_quota=500_000,
            quote_estimated_provider_cost_micro=1_000_000,
            quote_quota_per_unit=Decimal("500000"),
            quote_pricing_version="sha256:pricing-v1",
            quote_other_ratios_json='{"count":"2"}',
            quote_billing_fingerprint="billing_fingerprint_secret",
        )
        session.add(child)
        session.flush()
        reconciliation = BillingReconciliation(
            id="br000000000000000000000000000001",
            job_id=child.id,
            reason="receipt_pending",
            status="open",
            attempts=2,
            next_retry_at=NOW + timedelta(minutes=5),
            last_error="RuntimeError: token_key merchant_key raw callback leaked",
        )
        session.add(reconciliation)
        session.commit()
        yield session
    engine.dispose()


@pytest.fixture
def seeded_billing(db):
    return SimpleNamespace(
        secret="merchant_key",
        child_id="gj000000000000000000000000000001",
        reconciliation_id="br000000000000000000000000000001",
        order_id="po000000000000000000000000000001",
    )


def _client(tmp_path, db: Session, user: CurrentUser, *, csrf: bool = True) -> TestClient:
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    settings = AppSettings(
        _env_file=None,
        environment="test",
        auth_hmac_secret="x" * 32,
        public_origin="https://studio.example.com",
    )
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[require_user] = lambda: user
    if csrf:
        app.dependency_overrides[require_csrf] = lambda: user
    else:
        app.dependency_overrides[require_csrf] = lambda: (_ for _ in ()).throw(
            HTTPException(status_code=403, detail="Invalid CSRF token")
        )
    return TestClient(
        app,
        base_url="https://studio.example.com",
        raise_server_exceptions=False,
    )


@pytest.fixture
def admin_client(tmp_path, db):
    with _client(tmp_path, db, ADMIN) as client:
        yield client


@pytest.fixture
def user_client(tmp_path, db):
    with _client(tmp_path, db, USER) as client:
        yield client


@pytest.fixture
def admin_no_csrf_client(tmp_path, db):
    with _client(tmp_path, db, ADMIN, csrf=False) as client:
        yield client


@pytest.fixture
def existing_child(db, seeded_billing):
    child = db.get(GenerationJob, seeded_billing.child_id)
    assert child is not None
    return child


def latest_audit(db: Session, action: str) -> AdminAuditLog:
    audit = db.scalar(
        select(AdminAuditLog)
        .where(AdminAuditLog.action == action)
        .order_by(AdminAuditLog.id.desc())
    )
    assert audit is not None
    return audit


def current_multiplier(db: Session) -> int:
    setting = db.get(BillingSetting, 1)
    assert setting is not None
    return setting.multiplier_bps


def count_wallet_entries(db: Session) -> int:
    return len(db.scalars(select(WalletEntry)).all())


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


@pytest.mark.parametrize(
    "path",
    [
        "/api/admin/billing/settings",
        "/api/admin/billing/summary",
        "/api/admin/users",
        "/api/admin/payment-orders",
        "/api/admin/wallet-entries",
        "/api/admin/billing-reconciliations",
    ],
)
def test_admin_billing_reads_require_admin(user_client, path):
    assert user_client.get(path).status_code == 403


def test_topup_product_admin_routes_are_not_exposed(admin_client):
    assert admin_client.get("/api/admin/topup-products").status_code == 404
    assert admin_client.post("/api/admin/topup-products", json={}).status_code == 404


def test_admin_billing_summary_uses_authoritative_aggregates(admin_client):
    response = admin_client.get("/api/admin/billing/summary")

    assert response.status_code == 200
    assert response.json() == {
        "gross_paid_cny_fen": 1_200,
        "total_orders": 1,
        "pending_orders": 0,
        "paid_orders": 1,
        "failed_orders": 0,
        "expired_orders": 0,
        "wallet_balance_units": 10_000_000,
        "wallet_held_units": 0,
        "wallet_available_units": 10_000_000,
    }


def test_admin_billing_reads_order_and_reconciliation_payloads_are_redacted(
    admin_client, seeded_billing
):
    reconciliation = admin_client.get("/api/admin/billing-reconciliations")
    orders = admin_client.get("/api/admin/payment-orders")

    assert reconciliation.status_code == 200
    assert orders.status_code == 200
    rendered = json.dumps(
        [reconciliation.json(), orders.json()],
        sort_keys=True,
        default=str,
    )
    assert "quote_id" not in rendered
    assert "billing_fingerprint" not in rendered
    assert "provider_reference" not in rendered
    assert "result_locator" not in rendered
    assert "result_sha256" not in rendered
    assert "token_key" not in rendered
    assert "provider_trade_no" not in rendered
    assert "MERCHANT-SECRET-123456" not in rendered
    assert seeded_billing.secret not in rendered
    assert reconciliation.json()[0]["last_error_code"] == "RuntimeError"


def test_admin_orders_support_status_search_and_pagination(admin_client):
    matched = admin_client.get(
        "/api/admin/payment-orders",
        params={"status": "paid", "search": "starter", "limit": 1, "offset": 0},
    )
    missed = admin_client.get(
        "/api/admin/payment-orders",
        params={"search": "not-present", "limit": 1, "offset": 0},
    )

    assert matched.status_code == 200
    assert [order["product_title"] for order in matched.json()] == ["Starter snapshot"]
    assert missed.json() == []


def test_admin_can_search_users_and_read_wallet_balances(admin_client):
    response = admin_client.get("/api/admin/users?search=USER%40EXAMPLE.COM")

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": USER.id,
            "email": USER.email,
            "role": "user",
            "status": "active",
            "wallet_id": "w000000000000000000000000000001",
            "balance_units": 10_000_000,
            "held_units": 0,
            "available_units": 10_000_000,
            "created_at": response.json()[0]["created_at"],
        }
    ]


def test_admin_balance_adjustment_appends_wallet_entry_and_audit(
    admin_client, db
):
    before_entries = count_wallet_entries(db)
    payload = {
        "amount_units": 250_000,
        "reason": "customer service credit",
        "request_id": "balance-adjustment-0001",
    }

    response = admin_client.post(
        f"/api/admin/users/{USER.id}/balance-adjustments",
        json=payload,
    )

    assert response.status_code == 200
    assert response.json()["balance_units"] == 10_250_000
    assert response.json()["available_units"] == 10_250_000
    assert response.json()["adjustment_amount_units"] == 250_000
    wallet = db.scalar(
        select(WalletAccount).where(WalletAccount.user_id == USER.id)
    )
    assert wallet is not None
    assert wallet.balance_units == 10_250_000
    entry = db.scalar(
        select(WalletEntry).where(
            WalletEntry.idempotency_key == "admin-adjust:balance-adjustment-0001"
        )
    )
    assert entry is not None
    assert entry.kind == "admin_credit"
    assert entry.source_type == "admin_adjustment"
    assert entry.balance_after_units == 10_250_000
    assert count_wallet_entries(db) == before_entries + 1
    audit = latest_audit(db, "wallet.balance.adjust")
    assert audit.admin_user_id == ADMIN.id
    assert audit.object_id == wallet.id
    assert json.loads(audit.before_json) == {
        "balance_units": 10_000_000,
        "held_units": 0,
    }
    assert json.loads(audit.after_json) == {
        "amount_units": 250_000,
        "balance_units": 10_250_000,
        "entry_id": entry.id,
        "held_units": 0,
        "reason": "customer service credit",
        "user_id": USER.id,
    }

    repeated = admin_client.post(
        f"/api/admin/users/{USER.id}/balance-adjustments",
        json=payload,
    )
    assert repeated.status_code == 200
    assert repeated.json()["entry_id"] == entry.id
    assert count_wallet_entries(db) == before_entries + 1


def test_admin_balance_deduction_cannot_reduce_balance_below_held_units(
    admin_client, db
):
    wallet = db.scalar(
        select(WalletAccount).where(WalletAccount.user_id == USER.id)
    )
    assert wallet is not None
    wallet.held_units = 8_000_000
    db.commit()
    before_entries = count_wallet_entries(db)

    response = admin_client.post(
        f"/api/admin/users/{USER.id}/balance-adjustments",
        json={
            "amount_units": -3_000_000,
            "reason": "manual correction",
            "request_id": "balance-adjustment-0002",
        },
    )

    assert response.status_code == 409
    db.refresh(wallet)
    assert wallet.balance_units == 10_000_000
    assert count_wallet_entries(db) == before_entries


@pytest.mark.parametrize(
    "payload",
    [
        {
            "amount_units": 0,
            "reason": "zero",
            "request_id": "balance-adjustment-0003",
        },
        {
            "amount_units": 100,
            "reason": "   ",
            "request_id": "balance-adjustment-0004",
        },
    ],
)
def test_admin_balance_adjustment_validates_amount_and_reason(admin_client, payload):
    response = admin_client.post(
        f"/api/admin/users/{USER.id}/balance-adjustments",
        json=payload,
    )
    assert response.status_code == 422


def test_balance_adjustment_requires_admin_and_csrf(
    user_client, admin_no_csrf_client
):
    payload = {
        "amount_units": 100,
        "reason": "support",
        "request_id": "balance-adjustment-0005",
    }
    path = f"/api/admin/users/{USER.id}/balance-adjustments"

    assert user_client.post(path, json=payload).status_code == 403
    assert admin_no_csrf_client.post(path, json=payload).status_code == 403


def test_normal_user_cannot_change_multiplier(user_client):
    response = user_client.put(
        "/api/admin/billing/settings",
        json={"multiplier_bps": 18_000, "reason": "pricing"},
    )
    assert response.status_code == 403


def test_admin_change_multiplier_is_audited_and_only_affects_new_jobs(
    admin_client, db, existing_child
):
    response = admin_client.put(
        "/api/admin/billing/settings",
        json={"multiplier_bps": 18_000, "reason": "cost review"},
    )

    assert response.status_code == 200
    db.refresh(existing_child)
    assert existing_child.multiplier_bps == 15_000
    assert current_multiplier(db) == 18_000
    audit = latest_audit(db, "billing.multiplier.update")
    assert audit.before_json == '{"multiplier_bps":15000}'
    assert audit.after_json == '{"multiplier_bps":18000}'


@pytest.mark.parametrize(
    "payload",
    [
        {"multiplier_bps": 18_000},
        {"multiplier_bps": 18_000, "reason": "   "},
        {"multiplier_bps": 9_999, "reason": "too low"},
        {"multiplier_bps": 100_001, "reason": "too high"},
    ],
)
def test_multiplier_update_rejects_missing_reason_and_bounds(
    admin_client, payload
):
    response = admin_client.put("/api/admin/billing/settings", json=payload)
    assert response.status_code == 422


def test_reconciliation_retry_missing_returns_404(admin_client):
    response = admin_client.post(
        "/api/admin/billing-reconciliations/missing/retry",
        json={"reason": "manual review"},
    )
    assert response.status_code == 404


def test_reconciliation_retry_closed_returns_409(
    admin_client, db, seeded_billing
):
    item = db.get(BillingReconciliation, seeded_billing.reconciliation_id)
    assert item is not None
    item.status = "resolved"
    db.commit()

    response = admin_client.post(
        f"/api/admin/billing-reconciliations/{item.id}/retry",
        json={"reason": "manual review"},
    )

    assert response.status_code == 409


def test_reconciliation_retry_requires_admin(user_client, seeded_billing):
    response = user_client.post(
        f"/api/admin/billing-reconciliations/{seeded_billing.reconciliation_id}/retry",
        json={"reason": "manual review"},
    )
    assert response.status_code == 403


def test_reconciliation_retry_requires_csrf(
    admin_no_csrf_client, seeded_billing
):
    response = admin_no_csrf_client.post(
        f"/api/admin/billing-reconciliations/{seeded_billing.reconciliation_id}/retry",
        json={"reason": "manual review"},
    )
    assert response.status_code == 403


def test_reconciliation_retry_schedules_open_row_without_wallet_debit(
    admin_client, db, seeded_billing
):
    item = db.get(BillingReconciliation, seeded_billing.reconciliation_id)
    assert item is not None
    before_entries = count_wallet_entries(db)
    before_attempts = item.attempts
    before_error = item.last_error

    response = admin_client.post(
        f"/api/admin/billing-reconciliations/{item.id}/retry",
        json={"reason": "manual review"},
    )

    assert response.status_code == 202
    db.refresh(item)
    retry_at = item.next_retry_at
    assert retry_at is not None
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=timezone.utc)
    assert retry_at <= utc_now()
    assert item.status == "open"
    assert item.attempts == before_attempts
    assert item.last_error == before_error
    assert count_wallet_entries(db) == before_entries
    audit = latest_audit(db, "billing.reconciliation.retry")
    assert audit.object_id == item.id
    assert json.loads(audit.after_json)["reason"] == "manual review"


def test_reconciliation_retry_rejects_missing_reason(admin_client, seeded_billing):
    response = admin_client.post(
        f"/api/admin/billing-reconciliations/{seeded_billing.reconciliation_id}/retry",
        json={"reason": "   "},
    )
    assert response.status_code == 422
