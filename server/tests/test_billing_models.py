from __future__ import annotations

import importlib
import inspect
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from server.app.auth.models import User
from server.app.billing.bootstrap import ensure_billing_settings
from server.app.billing.models import (
    BillingReconciliation,
    BillingSetting,
    CostReceipt,
    GenerationJob,
)
from server.app.db.base import Base
from server.app.payments.models import PaymentOrder, TopupProduct
from server.app.projects.models import ProjectRecord
from server.app.wallet.models import WalletAccount, WalletEntry, WalletHold
from server.app.wallet.provisioning import WalletProvisioner

def utcnow() -> datetime:
    return datetime.now(timezone.utc)


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(dbapi_connection, _connection_record):
        dbapi_connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        yield db
    engine.dispose()


@pytest.fixture
def user(db_session) -> User:
    record = User(
        id="u000000000000000000000000000001",
        email="billing@example.com",
        password_hash="hash",
        role="user",
        status="active",
    )
    db_session.add(record)
    db_session.commit()
    return record


@pytest.fixture
def project(db_session, user) -> ProjectRecord:
    record = ProjectRecord(
        id="p000000000000000000000000000001",
        owner_user_id=user.id,
        title="Billing project",
        mode="short_drama",
        project_type="single_video",
    )
    db_session.add(record)
    db_session.commit()
    return record


def child_values(*, user_id: str, project_id: str, id: str = "c1") -> dict[str, object]:
    now = utcnow()
    return {
        "id": id,
        "user_id": user_id,
        "project_id": project_id,
        "chargeable": True,
        "operation": "shot:s1",
        "capability": "video",
        "token_kind": "video",
        "token_alias": "video-v1",
        "model": "video-model",
        "multiplier_bps": 15_000,
        "provider_method": "POST",
        "provider_route": "/v1/videos",
        "reference_deadline": now + timedelta(days=1),
        "receipt_deadline": now + timedelta(days=1),
        "quote_id": f"uq_{id}",
        "quote_expires_at": now + timedelta(seconds=120),
        "quote_estimated_quota": 1_449_000,
        "quote_estimated_provider_cost_micro": 2_898_000,
        "quote_quota_per_unit": Decimal("500000"),
        "quote_pricing_version": "sha256:p",
        "quote_other_ratios_json": '{"seconds":10}',
        "quote_billing_fingerprint": "sha256:f",
        "status": "reserved",
        "result_staged": False,
        "result_visible": False,
    }


def commit_raises_integrity(db_session: Session, record) -> None:
    db_session.add(record)
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_wallet_account_is_unique_per_user(db_session, user):
    db_session.add(
        WalletAccount(
            id="w1", user_id=user.id, balance_units=0, held_units=0, version=0
        )
    )
    db_session.commit()

    commit_raises_integrity(
        db_session,
        WalletAccount(
            id="w2", user_id=user.id, balance_units=0, held_units=0, version=0
        ),
    )


@pytest.mark.parametrize(
    ("balance_units", "held_units", "version"),
    [(-1, 0, 0), (10, -1, 0), (10, 11, 0), (10, 0, -1)],
)
def test_wallet_account_rejects_invalid_cached_balances(
    db_session, user, balance_units, held_units, version
):
    commit_raises_integrity(
        db_session,
        WalletAccount(
            id="w1",
            user_id=user.id,
            balance_units=balance_units,
            held_units=held_units,
            version=version,
        ),
    )


def test_wallet_entry_is_signed_append_only_and_idempotent(db_session, user):
    wallet = WalletAccount(
        id="w1", user_id=user.id, balance_units=100, held_units=0, version=0
    )
    entry = WalletEntry(
        id="e1",
        wallet_id=wallet.id,
        user_id=user.id,
        amount_units=-40,
        balance_after_units=60,
        kind="consume",
        source_type="generation_job",
        source_id="c1",
        idempotency_key="consume:c1",
    )
    db_session.add_all([wallet, entry])
    db_session.commit()
    assert "updated_at" not in WalletEntry.__table__.columns

    commit_raises_integrity(
        db_session,
        WalletEntry(
            id="e2",
            wallet_id=wallet.id,
            user_id=user.id,
            amount_units=-40,
            balance_after_units=20,
            kind="consume",
            source_type="generation_job",
            source_id="c1",
            idempotency_key="consume:c1",
        ),
    )


def test_parent_job_has_no_billing_snapshot_or_provider_reference(
    db_session, project, user
):
    parent = GenerationJob.parent(
        id="p1", user_id=user.id, project_id=project.id, operation="render"
    )
    db_session.add(parent)
    db_session.commit()

    assert parent.chargeable is False
    assert parent.parent_job_id is None
    assert parent.token_alias is None
    assert parent.multiplier_bps is None
    assert parent.provider_reference_id is None
    assert parent.quote_id is None
    parent.status = "partial_failure"
    db_session.commit()
    assert parent.status == "partial_failure"


def test_chargeable_child_requires_complete_positive_quote_snapshot(
    db_session, project, user
):
    child = GenerationJob(**child_values(user_id=user.id, project_id=project.id))
    db_session.add(child)
    db_session.commit()

    assert child.quote_billing_fingerprint == "sha256:f"
    assert child.quote_quota_per_unit == Decimal("500000")


def test_brief_chargeable_child_constructor_is_supported(db_session, project, user):
    child = GenerationJob(
        id="c1",
        user_id=user.id,
        project_id=project.id,
        chargeable=True,
        token_kind="video",
        token_alias="video-v1",
        model="video-model",
        multiplier_bps=15_000,
        quote_id="uq_1",
        quote_expires_at=utcnow() + timedelta(seconds=120),
        quote_estimated_quota=1_449_000,
        quote_estimated_provider_cost_micro=2_898_000,
        quote_quota_per_unit=Decimal("500000"),
        quote_pricing_version="sha256:p",
        quote_other_ratios_json='{"seconds":10}',
        quote_billing_fingerprint="sha256:f",
        status="reserved",
        result_visible=False,
    )
    db_session.add(child)
    db_session.commit()

    assert child.operation == "provider_call"


@pytest.mark.parametrize(
    ("field", "invalid_value"),
    [
        ("token_alias", None),
        ("model", None),
        ("multiplier_bps", 0),
        ("quote_id", None),
        ("quote_expires_at", None),
        ("quote_estimated_quota", 0),
        ("quote_estimated_provider_cost_micro", 0),
        ("quote_quota_per_unit", Decimal("0")),
        ("quote_pricing_version", None),
        ("quote_other_ratios_json", None),
        ("quote_billing_fingerprint", None),
    ],
)
def test_incomplete_or_free_child_quote_is_rejected(
    db_session, project, user, field, invalid_value
):
    values = child_values(user_id=user.id, project_id=project.id)
    values[field] = invalid_value
    commit_raises_integrity(db_session, GenerationJob(**values))


def test_parent_and_child_states_cannot_cross(db_session, project, user):
    parent = GenerationJob.parent(
        id="p1", user_id=user.id, project_id=project.id, operation="render"
    )
    parent.status = "reserved"
    commit_raises_integrity(db_session, parent)

    values = child_values(user_id=user.id, project_id=project.id)
    values["status"] = "running"
    commit_raises_integrity(db_session, GenerationJob(**values))


def test_parent_cannot_store_child_billing_fields(db_session, project, user):
    parent = GenerationJob.parent(
        id="p1", user_id=user.id, project_id=project.id, operation="render"
    )
    parent.quote_id = "uq_parent"
    commit_raises_integrity(db_session, parent)


def test_visible_result_requires_staged_billed_metadata(db_session, project, user):
    values = child_values(user_id=user.id, project_id=project.id)
    values.update(result_visible=True, result_staged=False, status="billed")
    commit_raises_integrity(db_session, GenerationJob(**values))

    values = child_values(user_id=user.id, project_id=project.id, id="c2")
    values.update(
        result_visible=True,
        result_staged=True,
        result_locator="projects/p1/hidden/video.mp4",
        result_sha256="a" * 64,
        status="billed",
    )
    db_session.add(GenerationJob(**values))
    db_session.commit()


def test_provider_reference_and_quote_are_unique_within_token_alias(
    db_session, project, user
):
    first_values = child_values(user_id=user.id, project_id=project.id, id="c1")
    first_values.update(
        provider_reference_type="task", provider_reference_id="task_1"
    )
    db_session.add(GenerationJob(**first_values))
    db_session.commit()

    reference_duplicate = child_values(
        user_id=user.id, project_id=project.id, id="c2"
    )
    reference_duplicate.update(
        provider_reference_type="task", provider_reference_id="task_1"
    )
    commit_raises_integrity(db_session, GenerationJob(**reference_duplicate))

    quote_duplicate = child_values(user_id=user.id, project_id=project.id, id="c3")
    quote_duplicate["quote_id"] = first_values["quote_id"]
    commit_raises_integrity(db_session, GenerationJob(**quote_duplicate))


def test_wallet_hold_is_positive_unique_per_chargeable_job(db_session, project, user):
    child = GenerationJob(**child_values(user_id=user.id, project_id=project.id))
    wallet = WalletAccount(
        id="w1", user_id=user.id, balance_units=100, held_units=10, version=0
    )
    db_session.add_all([child, wallet])
    db_session.commit()

    hold = WalletHold(
        id="h1",
        user_id=user.id,
        job_id=child.id,
        amount_units=10,
        status="active",
        expires_at=utcnow() + timedelta(hours=1),
    )
    db_session.add(hold)
    db_session.commit()

    commit_raises_integrity(
        db_session,
        WalletHold(
            id="h2",
            user_id=user.id,
            job_id=child.id,
            amount_units=10,
            status="active",
            expires_at=utcnow() + timedelta(hours=1),
        ),
    )

    commit_raises_integrity(
        db_session,
        WalletHold(
            id="h3",
            user_id=user.id,
            job_id="missing-job",
            amount_units=0,
            status="active",
            expires_at=utcnow() + timedelta(hours=1),
        ),
    )


def test_payment_order_uses_fixed_provider_method_and_integer_snapshots(
    db_session, user
):
    product = TopupProduct(
        id="prod1",
        title="100 credits",
        price_cny_fen=100,
        credit_units=100_000,
        enabled=True,
        sort_order=10,
    )
    order = PaymentOrder(
        id="o1",
        user_id=user.id,
        product_id=product.id,
        product_title=product.title,
        price_cny_fen=product.price_cny_fen,
        credit_units=product.credit_units,
        merchant_order_no="OM-1",
        payment_provider="epay",
        payment_method="alipay",
        status="pending",
        expires_at=utcnow() + timedelta(minutes=30),
    )
    db_session.add_all([product, order])
    db_session.commit()

    assert isinstance(order.price_cny_fen, int)
    assert isinstance(order.credit_units, int)
    duplicate_trade = PaymentOrder(
        id="o2",
        user_id=user.id,
        product_id=product.id,
        product_title=product.title,
        price_cny_fen=100,
        credit_units=100_000,
        merchant_order_no="OM-2",
        payment_provider="epay",
        payment_method="alipay",
        provider_trade_no="EPAY-1",
        status="paid",
        expires_at=utcnow() + timedelta(minutes=30),
    )
    order.provider_trade_no = "EPAY-1"
    db_session.add(duplicate_trade)
    with pytest.raises(IntegrityError):
        db_session.commit()


def test_cost_receipt_keeps_exact_decimal_and_canonical_raw_snapshot(
    db_session, project, user
):
    child = GenerationJob(**child_values(user_id=user.id, project_id=project.id))
    receipt = CostReceipt(
        id="r1",
        job_id=child.id,
        reference_type="task",
        reference_id="task_1",
        status="settled",
        model="video-model",
        quota=1_550_000,
        refunded_quota=0,
        quota_per_unit=Decimal("500000.5"),
        pricing_version="sha256:p",
        cost_currency="USD",
        cost_amount_micro=3_100_000,
        settled_at=utcnow(),
        raw_canonical_json='{"cost_amount_micro":3100000}',
        raw_sha256="b" * 64,
    )
    db_session.add(child)
    db_session.flush()
    db_session.add(receipt)
    db_session.commit()

    assert receipt.quota_per_unit == Decimal("500000.5")
    assert isinstance(receipt.cost_amount_micro, int)


def test_billing_setting_bootstrap_requires_default_only_for_first_insert(db_session):
    with pytest.raises(RuntimeError, match="BILLING_DEFAULT_MULTIPLIER_BPS"):
        ensure_billing_settings(
            db_session, SimpleNamespace(billing_default_multiplier_bps=None)
        )

    setting = ensure_billing_settings(
        db_session, SimpleNamespace(billing_default_multiplier_bps=15_000)
    )
    db_session.commit()
    assert setting.id == 1
    assert setting.multiplier_bps == 15_000

    setting.multiplier_bps = 17_500
    setting.version += 1
    db_session.commit()
    same_setting = ensure_billing_settings(
        db_session, SimpleNamespace(billing_default_multiplier_bps=20_000)
    )
    db_session.commit()
    assert same_setting.id == 1
    assert same_setting.multiplier_bps == 17_500


@pytest.mark.parametrize("invalid_default", [True, 0, -1, 15_000.5])
def test_billing_setting_bootstrap_rejects_nonpositive_or_noninteger_default(
    db_session, invalid_default
):
    with pytest.raises(RuntimeError, match="positive integer"):
        ensure_billing_settings(
            db_session,
            SimpleNamespace(billing_default_multiplier_bps=invalid_default),
        )


def test_wallet_provisioner_adds_zero_wallet_to_callers_transaction(db_session, user):
    provisioner = WalletProvisioner()
    provisioner.provision(db_session, user.id)
    assert db_session.scalar(
        WalletAccount.__table__.select().where(WalletAccount.user_id == user.id)
    ) is not None
    wallet = db_session.query(WalletAccount).filter_by(user_id=user.id).one()
    assert (wallet.balance_units, wallet.held_units, wallet.version) == (0, 0, 0)


def test_billing_schema_has_no_forbidden_pricing_payload_or_secret_columns():
    forbidden_fragments = {
        "channel_id",
        "channel_key",
        "duration_factor",
        "media",
        "merchant_key",
        "model_price",
        "model_ratio",
        "prompt",
        "provider_key",
        "request_body",
        "resolution_factor",
        "tiered_expression",
        "token_key",
    }
    tables = (
        WalletAccount,
        WalletEntry,
        WalletHold,
        TopupProduct,
        PaymentOrder,
        GenerationJob,
        CostReceipt,
        BillingSetting,
        BillingReconciliation,
    )
    column_names = {column.name for table in tables for column in table.__table__.columns}
    assert forbidden_fragments.isdisjoint(column_names)


def test_migration_chain_is_explicit_and_environment_independent():
    revision_010 = importlib.import_module(
        "server.alembic.versions.010_wallet_payment_tables"
    )
    revision_011 = importlib.import_module(
        "server.alembic.versions.011_billing_job_tables"
    )
    revision_012 = importlib.import_module(
        "server.alembic.versions.012_billing_constraints"
    )

    assert revision_010.down_revision == "003"
    assert revision_011.down_revision == "010"
    assert revision_012.down_revision == "011"
    sources = "\n".join(
        inspect.getsource(module)
        for module in (revision_010, revision_011, revision_012)
    ).lower()
    assert "getenv" not in sources
    assert "environ" not in sources
    assert "merchant_key" not in sources
    assert "token_key" not in sources
    assert "model_price" not in sources


def test_generation_job_indexes_are_postgresql_partial_unique_indexes():
    indexes = {index.name: index for index in GenerationJob.__table__.indexes}
    reference_index = indexes["uq_generation_jobs_provider_reference_token"]
    quote_index = indexes["uq_generation_jobs_quote_token"]

    assert reference_index.unique is True
    assert quote_index.unique is True
    assert reference_index.dialect_options["postgresql"]["where"] is not None
    assert quote_index.dialect_options["postgresql"]["where"] is not None
