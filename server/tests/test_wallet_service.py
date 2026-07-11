from __future__ import annotations

import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from threading import Barrier, Lock

import pytest
from sqlalchemy import Engine, create_engine, event, func, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from server.app.auth.models import User
from server.app.billing.models import GenerationJob
from server.app.db.base import Base
from server.app.projects.models import ProjectRecord
from server.app.wallet import service as wallet_service
from server.app.wallet.models import WalletAccount, WalletEntry, WalletHold
from server.app.wallet.provisioning import WalletProvisioner
from server.app.wallet.service import credit


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def make_child(
    *, user_id: str, project_id: str, job_id: str, quote_id: str
) -> GenerationJob:
    now = utcnow()
    return GenerationJob(
        id=job_id,
        user_id=user_id,
        project_id=project_id,
        chargeable=True,
        operation=f"shot:{job_id}",
        capability="video",
        token_kind="video",
        token_alias="video-v1",
        model="video-model",
        multiplier_bps=15_000,
        provider_method="POST",
        provider_route="/v1/videos",
        reference_deadline=now + timedelta(days=1),
        receipt_deadline=now + timedelta(days=1),
        quote_id=quote_id,
        quote_expires_at=now + timedelta(seconds=120),
        quote_estimated_quota=1_449_000,
        quote_estimated_provider_cost_micro=2_898_000,
        quote_quota_per_unit=Decimal("500000"),
        quote_pricing_version="sha256:p",
        quote_other_ratios_json='{"seconds":10}',
        quote_billing_fingerprint="sha256:f",
        status="reserved",
        result_staged=False,
        result_visible=False,
    )


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
def user(db_session: Session) -> User:
    record = User(
        id="u000000000000000000000000000001",
        email="wallet-service@example.com",
        password_hash="hash",
        role="user",
        status="active",
    )
    db_session.add(record)
    db_session.commit()
    return record


@pytest.fixture
def wallet(db_session: Session, user: User) -> WalletAccount:
    record = WalletAccount(
        id="w000000000000000000000000000001",
        user_id=user.id,
        balance_units=0,
        held_units=0,
    )
    db_session.add(record)
    db_session.commit()
    return record


@pytest.fixture
def project(db_session: Session, user: User) -> ProjectRecord:
    record = ProjectRecord(
        id="p000000000000000000000000000001",
        owner_user_id=user.id,
        title="Wallet service project",
        mode="short_drama",
        project_type="single_video",
    )
    db_session.add(record)
    db_session.commit()
    return record


@pytest.fixture
def child_job(
    db_session: Session, user: User, project: ProjectRecord
) -> GenerationJob:
    record = make_child(
        user_id=user.id,
        project_id=project.id,
        job_id="c000000000000000000000000000001",
        quote_id="uq_wallet_service_1",
    )
    db_session.add(record)
    db_session.commit()
    return record


@pytest.fixture
def funded_wallet(wallet: WalletAccount, db_session: Session) -> WalletAccount:
    wallet.balance_units = 150_000
    db_session.commit()
    return wallet


@pytest.fixture
def postgres_engine():
    database_url = os.getenv("OPENMONTAGE_TEST_POSTGRES_URL")
    if not database_url:
        pytest.skip("OPENMONTAGE_TEST_POSTGRES_URL is not configured")

    schema_name = f"wallet_task5_{uuid.uuid4().hex}"
    admin_engine = create_engine(database_url)
    engine = None
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema_name}"'))
        engine = create_engine(
            database_url,
            connect_args={"options": f"-csearch_path={schema_name}"},
        )
        Base.metadata.create_all(engine)
        yield engine
    finally:
        if engine is not None:
            engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema_name}" CASCADE'))
        admin_engine.dispose()


def seed_postgres_wallet_graph(
    engine: Engine, *, balance_units: int, job_count: int
) -> tuple[str, list[str]]:
    suffix = uuid.uuid4().hex[:12]
    user_id = f"u{suffix}"
    project_id = f"p{suffix}"
    job_ids = [f"j{index}{suffix}" for index in range(job_count)]
    with Session(engine) as db:
        db.add(
            User(
                id=user_id,
                email=f"wallet-{suffix}@example.com",
                password_hash="hash",
                role="user",
                status="active",
            )
        )
        db.flush()
        db.add(
            ProjectRecord(
                id=project_id,
                owner_user_id=user_id,
                title="PostgreSQL wallet race",
                mode="short_drama",
                project_type="single_video",
            )
        )
        db.flush()
        db.add_all(
            make_child(
                user_id=user_id,
                project_id=project_id,
                job_id=job_id,
                quote_id=f"uq_{job_id}",
            )
            for job_id in job_ids
        )
        db.add(
            WalletAccount(
                id=f"w{suffix}",
                user_id=user_id,
                balance_units=balance_units,
                held_units=0,
            )
        )
        db.commit()
    return user_id, job_ids


def run_threaded(count: int, operation):
    barrier = Barrier(count)

    def synchronized(index: int):
        barrier.wait(timeout=10)
        return operation(index)

    with ThreadPoolExecutor(max_workers=count) as executor:
        return list(executor.map(synchronized, range(count)))


@pytest.fixture
def active_hold(
    db_session: Session,
    funded_wallet: WalletAccount,
    child_job: GenerationJob,
):
    return wallet_service.create_hold(
        db_session,
        user_id=funded_wallet.user_id,
        job_id=child_job.id,
        amount_units=80_000,
        expires_at=utcnow() + timedelta(hours=1),
    )


def test_duplicate_credit_is_applied_once(
    db_session: Session, wallet: WalletAccount
) -> None:
    first = credit(
        db_session,
        wallet.user_id,
        100_000,
        kind="topup",
        source_id="o1",
        idempotency_key="topup:o1",
    )
    second = credit(
        db_session,
        wallet.user_id,
        100_000,
        kind="topup",
        source_id="o1",
        idempotency_key="topup:o1",
    )
    db_session.commit()
    db_session.refresh(wallet)

    assert second.id == first.id
    assert wallet.balance_units == 100_000
    assert (
        first.amount_units,
        first.balance_after_units,
        first.kind,
        first.source_type,
        first.source_id,
    ) == (100_000, 100_000, "topup", "payment_order", "o1")
    assert db_session.scalar(
        select(func.count(WalletEntry.id)).where(
            WalletEntry.idempotency_key == "topup:o1"
        )
    ) == 1


def test_wallet_provisioner_is_idempotent_in_callers_transaction(
    db_session: Session, user: User
) -> None:
    provisioner = WalletProvisioner()
    provisioner.provision(db_session, user.id)
    provisioner.provision(db_session, user.id)
    db_session.flush()

    wallets = db_session.scalars(
        select(WalletAccount).where(WalletAccount.user_id == user.id)
    ).all()
    assert len(wallets) == 1
    assert (
        wallets[0].balance_units,
        wallets[0].held_units,
        wallets[0].version,
    ) == (0, 0, 0)


def test_duplicate_same_job_hold_returns_existing_without_rechecking_its_own_funds(
    db_session: Session,
    funded_wallet: WalletAccount,
    child_job: GenerationJob,
) -> None:
    first = wallet_service.create_hold(
        db_session,
        user_id=funded_wallet.user_id,
        job_id=child_job.id,
        amount_units=80_000,
        expires_at=utcnow() + timedelta(hours=1),
    )
    second = wallet_service.create_hold(
        db_session,
        user_id=funded_wallet.user_id,
        job_id=child_job.id,
        amount_units=80_000,
        expires_at=utcnow() + timedelta(hours=2),
    )

    assert second.id == first.id
    assert funded_wallet.held_units == 80_000


def test_resize_hold_changes_only_the_locked_delta(
    db_session: Session,
    funded_wallet: WalletAccount,
    active_hold,
) -> None:
    assert wallet_service.resize_active_hold(
        db_session, job_id=active_hold.job_id, amount_units=120_000
    ) == "resized"
    assert funded_wallet.held_units == 120_000

    assert wallet_service.resize_active_hold(
        db_session, job_id=active_hold.job_id, amount_units=90_000
    ) == "resized"
    assert funded_wallet.held_units == 90_000


def test_resize_hold_insufficient_keeps_original_hold(
    db_session: Session,
    funded_wallet: WalletAccount,
    active_hold,
) -> None:
    original_amount = active_hold.amount_units
    original_held = funded_wallet.held_units

    assert wallet_service.resize_active_hold(
        db_session, job_id=active_hold.job_id, amount_units=10_000_000
    ) == "insufficient_funds"

    assert active_hold.status == "active"
    assert active_hold.amount_units == original_amount
    assert funded_wallet.held_units == original_held


def test_failed_job_release_is_idempotent_and_creates_no_entry(
    db_session: Session,
    funded_wallet: WalletAccount,
    active_hold,
) -> None:
    first = wallet_service.release_hold(
        db_session, active_hold.job_id, reason="provider_failed"
    )
    second = wallet_service.release_hold(
        db_session, active_hold.job_id, reason="provider_failed"
    )
    db_session.commit()

    assert second.id == first.id == active_hold.id
    assert active_hold.status == "released"
    assert active_hold.reason == "provider_failed"
    assert active_hold.released_at is not None
    assert funded_wallet.held_units == 0
    assert db_session.scalar(select(func.count(WalletEntry.id))) == 0


def test_capture_hold_charges_once_and_appends_one_consumption(
    db_session: Session,
    funded_wallet: WalletAccount,
    active_hold,
) -> None:
    first = wallet_service.capture_hold(
        db_session, active_hold.job_id, amount_units=90_000
    )
    second = wallet_service.capture_hold(
        db_session, active_hold.job_id, amount_units=90_000
    )
    db_session.commit()

    entry = db_session.scalar(
        select(WalletEntry).where(
            WalletEntry.idempotency_key == f"consume:{active_hold.job_id}"
        )
    )
    assert first == second == "captured"
    assert active_hold.status == "captured"
    assert active_hold.captured_at is not None
    assert funded_wallet.balance_units == 60_000
    assert funded_wallet.held_units == 0
    assert entry is not None
    assert (
        entry.amount_units,
        entry.balance_after_units,
        entry.kind,
        entry.source_type,
        entry.source_id,
    ) == (-90_000, 60_000, "consume", "generation_job", active_hold.job_id)
    assert db_session.scalar(
        select(func.count(WalletEntry.id)).where(
            WalletEntry.idempotency_key == f"consume:{active_hold.job_id}"
        )
    ) == 1


def test_capture_overrun_returns_payment_required_without_mutation(
    db_session: Session,
    funded_wallet: WalletAccount,
    active_hold,
) -> None:
    original_balance = funded_wallet.balance_units
    original_held = funded_wallet.held_units

    assert wallet_service.capture_hold(
        db_session, active_hold.job_id, amount_units=200_000
    ) == "payment_required"

    assert active_hold.status == "active"
    assert active_hold.captured_at is None
    assert funded_wallet.balance_units == original_balance
    assert funded_wallet.held_units == original_held
    assert db_session.scalar(select(func.count(WalletEntry.id))) == 0


def test_available_units_excludes_active_holds(
    db_session: Session,
    funded_wallet: WalletAccount,
    active_hold,
) -> None:
    assert wallet_service.available_units(db_session, funded_wallet.user_id) == 70_000


@pytest.mark.parametrize("operation", ["credit", "create", "resize", "capture"])
def test_wallet_mutators_reject_noninteger_units(
    db_session: Session,
    funded_wallet: WalletAccount,
    child_job: GenerationJob,
    operation: str,
) -> None:
    with pytest.raises(ValueError, match="positive integer"):
        if operation == "credit":
            credit(
                db_session,
                funded_wallet.user_id,
                1.5,
                kind="topup",
                source_id="float-order",
                idempotency_key="topup:float-order",
            )
        elif operation == "create":
            wallet_service.create_hold(
                db_session,
                user_id=funded_wallet.user_id,
                job_id=child_job.id,
                amount_units=1.5,
                expires_at=utcnow() + timedelta(hours=1),
            )
        else:
            hold = wallet_service.create_hold(
                db_session,
                user_id=funded_wallet.user_id,
                job_id=child_job.id,
                amount_units=80_000,
                expires_at=utcnow() + timedelta(hours=1),
            )
            if operation == "resize":
                wallet_service.resize_active_hold(
                    db_session, job_id=hold.job_id, amount_units=1.5
                )
            else:
                wallet_service.capture_hold(
                    db_session, hold.job_id, amount_units=1.5
                )


def test_create_hold_rejects_wrong_owner_before_wallet_mutation(
    db_session: Session,
    funded_wallet: WalletAccount,
    child_job: GenerationJob,
) -> None:
    with pytest.raises(wallet_service.InvalidHoldOwner):
        wallet_service.create_hold(
            db_session,
            user_id="u000000000000000000000000000099",
            job_id=child_job.id,
            amount_units=80_000,
            expires_at=utcnow() + timedelta(hours=1),
        )

    assert funded_wallet.held_units == 0
    assert db_session.scalar(select(func.count(WalletHold.id))) == 0


def test_create_hold_rejects_nonchargeable_job_before_wallet_mutation(
    db_session: Session,
    funded_wallet: WalletAccount,
    project: ProjectRecord,
) -> None:
    parent = GenerationJob.parent(
        id="j000000000000000000000000000001",
        user_id=funded_wallet.user_id,
        project_id=project.id,
        operation="render",
    )
    db_session.add(parent)
    db_session.commit()

    with pytest.raises(wallet_service.InvalidChargeableJob):
        wallet_service.create_hold(
            db_session,
            user_id=funded_wallet.user_id,
            job_id=parent.id,
            amount_units=80_000,
            expires_at=utcnow() + timedelta(hours=1),
        )

    assert funded_wallet.held_units == 0
    assert db_session.scalar(select(func.count(WalletHold.id))) == 0


def test_create_hold_rejects_incomplete_quote_before_wallet_mutation(
    db_session: Session,
    funded_wallet: WalletAccount,
    child_job: GenerationJob,
) -> None:
    child_job.quote_estimated_provider_cost_micro = 0
    with db_session.no_autoflush:
        with pytest.raises(wallet_service.InvalidChargeableJob):
            wallet_service.create_hold(
                db_session,
                user_id=funded_wallet.user_id,
                job_id=child_job.id,
                amount_units=80_000,
                expires_at=utcnow() + timedelta(hours=1),
            )

    db_session.rollback()
    assert db_session.scalar(select(func.count(WalletHold.id))) == 0
    reloaded = db_session.scalar(
        select(WalletAccount).where(WalletAccount.user_id == funded_wallet.user_id)
    )
    assert reloaded is not None and reloaded.held_units == 0


def test_caller_rollback_undoes_credit_hold_and_entry(
    db_session: Session,
    funded_wallet: WalletAccount,
    child_job: GenerationJob,
) -> None:
    credit(
        db_session,
        funded_wallet.user_id,
        10_000,
        kind="topup",
        source_id="rollback-order",
        idempotency_key="topup:rollback-order",
    )
    wallet_service.create_hold(
        db_session,
        user_id=funded_wallet.user_id,
        job_id=child_job.id,
        amount_units=80_000,
        expires_at=utcnow() + timedelta(hours=1),
    )

    db_session.rollback()
    db_session.expire_all()
    reloaded = db_session.scalar(
        select(WalletAccount).where(WalletAccount.user_id == funded_wallet.user_id)
    )
    assert reloaded is not None
    assert (reloaded.balance_units, reloaded.held_units) == (150_000, 0)
    assert db_session.scalar(select(func.count(WalletEntry.id))) == 0
    assert db_session.scalar(select(func.count(WalletHold.id))) == 0


@pytest.mark.parametrize("operation", ["resize", "release", "capture"])
def test_hold_mutators_lock_in_job_hold_wallet_order(
    db_session: Session,
    active_hold,
    operation: str,
) -> None:
    statements: list[str] = []

    def record_statement(_conn, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement.lower())

    event.listen(db_session.bind, "before_cursor_execute", record_statement)
    try:
        if operation == "resize":
            wallet_service.resize_active_hold(
                db_session, job_id=active_hold.job_id, amount_units=90_000
            )
        elif operation == "release":
            wallet_service.release_hold(
                db_session, active_hold.job_id, reason="lock-order"
            )
        else:
            wallet_service.capture_hold(
                db_session, active_hold.job_id, amount_units=80_000
            )
    finally:
        event.remove(db_session.bind, "before_cursor_execute", record_statement)

    locked_tables = [
        table
        for statement in statements
        for table in ("generation_jobs", "wallet_holds", "wallet_accounts")
        if f"from {table}" in statement
    ]
    assert locked_tables[:3] == [
        "generation_jobs",
        "wallet_holds",
        "wallet_accounts",
    ]


def test_create_hold_locks_in_job_hold_wallet_order(
    db_session: Session,
    funded_wallet: WalletAccount,
    child_job: GenerationJob,
) -> None:
    statements: list[str] = []

    def record_statement(_conn, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement.lower())

    event.listen(db_session.bind, "before_cursor_execute", record_statement)
    try:
        wallet_service.create_hold(
            db_session,
            user_id=funded_wallet.user_id,
            job_id=child_job.id,
            amount_units=80_000,
            expires_at=utcnow() + timedelta(hours=1),
        )
    finally:
        event.remove(db_session.bind, "before_cursor_execute", record_statement)

    locked_tables = [
        table
        for statement in statements
        for table in ("generation_jobs", "wallet_holds", "wallet_accounts")
        if f"from {table}" in statement
    ]
    assert locked_tables[:3] == [
        "generation_jobs",
        "wallet_holds",
        "wallet_accounts",
    ]


def test_wallet_mutators_advance_optimistic_version_once(
    db_session: Session,
    funded_wallet: WalletAccount,
    child_job: GenerationJob,
) -> None:
    initial_version = funded_wallet.version
    hold = wallet_service.create_hold(
        db_session,
        user_id=funded_wallet.user_id,
        job_id=child_job.id,
        amount_units=80_000,
        expires_at=utcnow() + timedelta(hours=1),
    )
    assert funded_wallet.version == initial_version + 1

    wallet_service.resize_active_hold(
        db_session, job_id=hold.job_id, amount_units=90_000
    )
    assert funded_wallet.version == initial_version + 2

    wallet_service.capture_hold(db_session, hold.job_id, amount_units=90_000)
    assert funded_wallet.version == initial_version + 3


def test_postgres_two_holds_cannot_overbook_one_balance(
    postgres_engine: Engine,
) -> None:
    user_id, job_ids = seed_postgres_wallet_graph(
        postgres_engine, balance_units=100_000, job_count=2
    )

    def attempt(index: int) -> bool:
        with Session(postgres_engine, expire_on_commit=False) as db:
            try:
                wallet_service.create_hold(
                    db,
                    user_id=user_id,
                    job_id=job_ids[index],
                    amount_units=80_000,
                    expires_at=utcnow() + timedelta(hours=1),
                )
                db.commit()
                return True
            except wallet_service.InsufficientBalance:
                db.rollback()
                return False

    results = run_threaded(2, attempt)
    with Session(postgres_engine) as db:
        wallet = db.scalar(
            select(WalletAccount).where(WalletAccount.user_id == user_id)
        )
        assert sorted(results) == [False, True]
        assert wallet is not None and wallet.held_units == 80_000
        assert db.scalar(select(func.count(WalletHold.id))) == 1


def test_postgres_concurrent_same_job_creates_one_hold(
    postgres_engine: Engine,
) -> None:
    user_id, job_ids = seed_postgres_wallet_graph(
        postgres_engine, balance_units=100_000, job_count=1
    )

    def create(_index: int) -> str:
        with Session(postgres_engine, expire_on_commit=False) as db:
            hold = wallet_service.create_hold(
                db,
                user_id=user_id,
                job_id=job_ids[0],
                amount_units=80_000,
                expires_at=utcnow() + timedelta(hours=1),
            )
            db.commit()
            return hold.id

    hold_ids = run_threaded(8, create)
    with Session(postgres_engine) as db:
        wallet = db.scalar(
            select(WalletAccount).where(WalletAccount.user_id == user_id)
        )
        assert len(set(hold_ids)) == 1
        assert wallet is not None and wallet.held_units == 80_000
        assert db.scalar(select(func.count(WalletHold.id))) == 1


def test_postgres_concurrent_wallet_provisioning_is_idempotent(
    postgres_engine: Engine,
) -> None:
    suffix = uuid.uuid4().hex[:12]
    user_id = f"u{suffix}"
    with Session(postgres_engine) as db:
        db.add(
            User(
                id=user_id,
                email=f"provision-{suffix}@example.com",
                password_hash="hash",
                role="user",
                status="active",
            )
        )
        db.commit()

    start_barrier = Barrier(2)
    lookup_barrier = Barrier(2)

    def synchronize_prefixed_check_then_add(
        _conn, _cursor, statement, _parameters, _context, _many
    ) -> None:
        if (
            statement.lstrip().upper().startswith("SELECT")
            and "from wallet_accounts" in statement.lower()
        ):
            lookup_barrier.wait(timeout=10)

    def provision(_index: int) -> str:
        with Session(postgres_engine) as db:
            start_barrier.wait(timeout=10)
            WalletProvisioner().provision(db, user_id)
            loaded_user_id = db.scalar(
                select(User.id).where(User.id == user_id)
            )
            db.commit()
            assert db.scalar(select(func.count(User.id))) == 1
            return loaded_user_id

    event.listen(
        postgres_engine,
        "after_cursor_execute",
        synchronize_prefixed_check_then_add,
    )
    try:
        results = run_threaded(2, provision)
    finally:
        event.remove(
            postgres_engine,
            "after_cursor_execute",
            synchronize_prefixed_check_then_add,
        )

    with Session(postgres_engine) as db:
        wallets = db.scalars(
            select(WalletAccount).where(WalletAccount.user_id == user_id)
        ).all()
        assert results == [user_id, user_id]
        assert len(wallets) == 1
        assert (
            wallets[0].balance_units,
            wallets[0].held_units,
            wallets[0].version,
        ) == (0, 0, 0)
        assert wallets[0].created_at is not None
        assert wallets[0].updated_at is not None


def test_postgres_concurrent_duplicate_credit_is_applied_once(
    postgres_engine: Engine,
) -> None:
    user_id, _job_ids = seed_postgres_wallet_graph(
        postgres_engine, balance_units=0, job_count=0
    )

    def apply(_index: int) -> str:
        with Session(postgres_engine, expire_on_commit=False) as db:
            entry = credit(
                db,
                user_id,
                100_000,
                kind="topup",
                source_id="postgres-order",
                idempotency_key="topup:postgres-order",
            )
            db.commit()
            return entry.id

    entry_ids = run_threaded(8, apply)
    with Session(postgres_engine) as db:
        wallet = db.scalar(
            select(WalletAccount).where(WalletAccount.user_id == user_id)
        )
        assert len(set(entry_ids)) == 1
        assert wallet is not None and wallet.balance_units == 100_000
        assert db.scalar(select(func.count(WalletEntry.id))) == 1


def test_postgres_unique_credit_race_rolls_back_losing_wallet_delta(
    postgres_engine: Engine,
) -> None:
    first_user_id, _ = seed_postgres_wallet_graph(
        postgres_engine, balance_units=0, job_count=0
    )
    second_user_id, _ = seed_postgres_wallet_graph(
        postgres_engine, balance_units=0, job_count=0
    )
    user_ids = (first_user_id, second_user_id)
    lookup_barrier = Barrier(2)
    lookup_lock = Lock()
    lookups_remaining = 2

    def synchronize_initial_lookup(
        _conn, _cursor, statement, _parameters, _context, _many
    ) -> None:
        nonlocal lookups_remaining
        if not (
            statement.lstrip().upper().startswith("SELECT")
            and "from wallet_entries" in statement.lower()
        ):
            return
        with lookup_lock:
            should_wait = lookups_remaining > 0
            if should_wait:
                lookups_remaining -= 1
        if should_wait:
            lookup_barrier.wait(timeout=10)

    def apply(index: int) -> str:
        with Session(postgres_engine, expire_on_commit=False) as db:
            entry = credit(
                db,
                user_ids[index],
                100_000,
                kind="topup",
                source_id="shared-key-order",
                idempotency_key="topup:shared-key-order",
            )
            db.commit()
            return entry.id

    event.listen(
        postgres_engine, "after_cursor_execute", synchronize_initial_lookup
    )
    try:
        entry_ids = run_threaded(2, apply)
    finally:
        event.remove(
            postgres_engine, "after_cursor_execute", synchronize_initial_lookup
        )
    with Session(postgres_engine) as db:
        balances = db.scalars(
            select(WalletAccount.balance_units).where(
                WalletAccount.user_id.in_(user_ids)
            )
        ).all()
        assert len(set(entry_ids)) == 1
        assert sorted(balances) == [0, 100_000]
        assert db.scalar(select(func.count(WalletEntry.id))) == 1


def test_postgres_concurrent_resizes_keep_hold_and_wallet_equal(
    postgres_engine: Engine,
) -> None:
    user_id, job_ids = seed_postgres_wallet_graph(
        postgres_engine, balance_units=150_000, job_count=1
    )
    with Session(postgres_engine) as db:
        wallet_service.create_hold(
            db,
            user_id=user_id,
            job_id=job_ids[0],
            amount_units=80_000,
            expires_at=utcnow() + timedelta(hours=1),
        )
        db.commit()

    target_amounts = (120_000, 140_000)

    def resize(index: int) -> str:
        with Session(postgres_engine) as db:
            outcome = wallet_service.resize_active_hold(
                db, job_id=job_ids[0], amount_units=target_amounts[index]
            )
            db.commit()
            return outcome

    outcomes = run_threaded(2, resize)
    with Session(postgres_engine) as db:
        wallet = db.scalar(
            select(WalletAccount).where(WalletAccount.user_id == user_id)
        )
        hold = db.scalar(select(WalletHold).where(WalletHold.job_id == job_ids[0]))
        assert outcomes == ["resized", "resized"]
        assert wallet is not None and hold is not None
        assert wallet.held_units == hold.amount_units
        assert hold.amount_units in target_amounts
