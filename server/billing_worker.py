from __future__ import annotations

import signal
import threading
import uuid
from datetime import datetime, timezone

# The isolated worker must register User before ORM flushes resolve foreign keys.
from server.app.auth import models as _auth_models  # noqa: F401
from server.app.billing.reconciliation import reconcile_due_jobs
from server.app.billing.health import record_worker_heartbeat, release_worker_heartbeat
from server.app.core.config import get_settings
from server.app.provider.newapi import NewApiClient
from server.app.settings import DEFAULT_PROJECTS_ROOT
from server.app.storage import WorkbenchStore


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def install_signal_handlers(stop: threading.Event) -> None:
    def request_stop(_signum, _frame) -> None:
        stop.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)


def run_worker(
    stop,
    *,
    session_factory,
    client,
    settings,
    media_store,
    now=utcnow,
) -> int:
    worker_id = uuid.uuid4().hex
    heartbeat_ttl_seconds = int(
        getattr(settings, "billing_worker_heartbeat_ttl_seconds", 15)
    )
    heartbeat_stop = threading.Event()
    heartbeat_failures: list[Exception] = []

    def maintain_heartbeat() -> None:
        interval = max(1.0, heartbeat_ttl_seconds / 3)
        while not heartbeat_stop.wait(interval):
            try:
                with session_factory() as db:
                    record_worker_heartbeat(
                        db,
                        worker_id=worker_id,
                        now=now(),
                        ttl_seconds=heartbeat_ttl_seconds,
                    )
            except Exception as exc:
                heartbeat_failures.append(exc)
                stop.set()
                return

    with session_factory() as db:
        record_worker_heartbeat(
            db,
            worker_id=worker_id,
            now=now(),
            ttl_seconds=heartbeat_ttl_seconds,
        )
    heartbeat = threading.Thread(
        target=maintain_heartbeat,
        name="openmontage-billing-heartbeat",
        daemon=True,
    )
    heartbeat.start()
    try:
        while not stop.is_set():
            if heartbeat_failures:
                raise heartbeat_failures[0]
            with session_factory() as db:
                reconcile_due_jobs(
                    db,
                    client,
                    now(),
                    100,
                    settings=settings,
                    media_store=media_store,
                )
            stop.wait(5)
        if heartbeat_failures:
            raise heartbeat_failures[0]
    finally:
        heartbeat_stop.set()
        heartbeat.join(timeout=max(1.0, heartbeat_ttl_seconds))
        with session_factory() as db:
            release_worker_heartbeat(db, worker_id=worker_id, now=now())
        client.close()
    return 0


def main() -> int:
    from server.app.db.session import SessionLocal

    settings = get_settings()
    stop = threading.Event()
    install_signal_handlers(stop)
    return run_worker(
        stop,
        session_factory=SessionLocal,
        client=NewApiClient(settings),
        settings=settings,
        media_store=WorkbenchStore(projects_root=DEFAULT_PROJECTS_ROOT),
    )


if __name__ == "__main__":
    raise SystemExit(main())
