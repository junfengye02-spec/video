from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from server.app.billing.health import (
    BillingReconciliationUnavailable,
    BillingWorkerAlreadyRunning,
    billing_worker_is_healthy,
    record_worker_heartbeat,
    release_worker_heartbeat,
    require_billing_worker_healthy,
)
from server.app.billing.models import BillingWorkerHeartbeat


@pytest.fixture
def heartbeat_store():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    BillingWorkerHeartbeat.__table__.create(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    try:
        yield factory
    finally:
        engine.dispose()


def test_billing_worker_heartbeat_enforces_single_live_lease(heartbeat_store):
    started_at = datetime(2026, 7, 23, 12, 0, tzinfo=timezone.utc)
    with heartbeat_store() as db:
        assert billing_worker_is_healthy(db, now=started_at) is False
        record_worker_heartbeat(
            db,
            worker_id="worker-one",
            now=started_at,
            ttl_seconds=30,
        )
        assert billing_worker_is_healthy(
            db, now=started_at + timedelta(seconds=29)
        )
        with pytest.raises(BillingWorkerAlreadyRunning):
            record_worker_heartbeat(
                db,
                worker_id="worker-two",
                now=started_at + timedelta(seconds=10),
                ttl_seconds=30,
            )
        current = db.get(BillingWorkerHeartbeat, 1)
        assert current is not None
        assert current.worker_id == "worker-one"

        record_worker_heartbeat(
            db,
            worker_id="worker-two",
            now=started_at + timedelta(seconds=30),
            ttl_seconds=15,
        )
        current = db.get(BillingWorkerHeartbeat, 1)
        assert current is not None
        assert current.worker_id == "worker-two"
        assert release_worker_heartbeat(
            db,
            worker_id="worker-one",
            now=started_at + timedelta(seconds=31),
        ) is False
        assert release_worker_heartbeat(
            db,
            worker_id="worker-two",
            now=started_at + timedelta(seconds=31),
        ) is True
        assert billing_worker_is_healthy(
            db, now=started_at + timedelta(seconds=31)
        ) is False


def test_billing_health_gate_rejects_missing_or_stale_worker(heartbeat_store):
    production = SimpleNamespace(environment="production")
    tests = SimpleNamespace(environment="test")
    now = datetime.now(timezone.utc)
    with heartbeat_store() as db:
        with pytest.raises(BillingReconciliationUnavailable):
            require_billing_worker_healthy(db, production)
        require_billing_worker_healthy(db, tests)

        record_worker_heartbeat(
            db,
            worker_id="worker",
            now=now,
            ttl_seconds=30,
        )
        require_billing_worker_healthy(db, production)

        heartbeat = db.get(BillingWorkerHeartbeat, 1)
        assert heartbeat is not None
        heartbeat.lease_expires_at = now - timedelta(seconds=1)
        db.commit()
        with pytest.raises(BillingReconciliationUnavailable):
            require_billing_worker_healthy(db, production)
