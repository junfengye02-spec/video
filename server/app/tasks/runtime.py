from __future__ import annotations

from collections.abc import Callable, Iterator

from fastapi import FastAPI
from sqlalchemy.orm import Session, sessionmaker

from server.app.db.session import SessionLocal, get_db
from server.app.events import EventBus
from server.app.tasks.worker import TaskWorker


def configure_task_runtime(
    app: FastAPI,
    events: EventBus,
    *,
    max_concurrency: int = 4,
) -> TaskWorker:
    worker = TaskWorker(
        SessionLocal,
        events,
        max_concurrency=max_concurrency,
    )
    app.state.task_worker = worker

    def startup() -> None:
        worker.session_factory = _session_factory_for_app(app)
        worker.start()

    def shutdown() -> None:
        app.state.task_worker_stopped_cleanly = worker.stop(timeout=30)

    app.router.add_event_handler("startup", startup)
    app.router.add_event_handler("shutdown", shutdown)
    return worker


def _session_factory_for_app(app: FastAPI) -> Callable[[], Session]:
    configured = getattr(app.state, "task_session_factory", None)
    if configured is not None:
        return configured
    override = app.dependency_overrides.get(get_db)
    if override is None:
        return SessionLocal
    supplied = override()
    if isinstance(supplied, Session):
        bind = supplied.get_bind()
    elif isinstance(supplied, Iterator):
        try:
            yielded = next(supplied)
            if not isinstance(yielded, Session):
                raise RuntimeError(
                    "Task worker requires a SQLAlchemy Session dependency"
                )
            bind = yielded.get_bind()
        finally:
            close = getattr(supplied, "close", None)
            if close is not None:
                close()
    else:
        raise RuntimeError("Task worker requires a SQLAlchemy Session dependency")
    return sessionmaker(bind=bind, expire_on_commit=False)
