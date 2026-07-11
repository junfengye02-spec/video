from __future__ import annotations

import signal
import threading
from datetime import datetime, timezone

from server.app.billing.reconciliation import reconcile_due_jobs
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
    try:
        while not stop.is_set():
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
    finally:
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
