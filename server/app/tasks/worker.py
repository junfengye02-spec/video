from __future__ import annotations

import logging
import threading
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sqlalchemy.orm import Session

from server.app.events import EventBus
from server.app.tasks.schemas import TaskItemSubmit, TaskSubmitRequest
from server.app.tasks.service import TaskClaim, TaskService, TaskStateError


logger = logging.getLogger("server.app.tasks.worker")


class _TaskClaimLost(Exception):
    pass


class PublishOutcome(str, Enum):
    PUBLISHED = "published"
    ALREADY_PUBLISHED = "already_published"
    STALE = "stale"


class RetryableTaskError(Exception):
    def __init__(
        self,
        code: str = "task_execution_failed",
        message: str = "Task execution failed",
        *,
        retry_delay_seconds: float | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.public_message = message
        self.retry_delay_seconds = retry_delay_seconds


class PermanentTaskError(Exception):
    def __init__(
        self,
        code: str = "task_execution_failed",
        message: str = "Task execution failed",
    ):
        super().__init__(message)
        self.code = code
        self.public_message = message


class TaskAwaitingPayment(Exception):
    def __init__(self, billing_job_id: str | None = None):
        super().__init__("Task is awaiting payment")
        self.billing_job_id = billing_job_id


class TaskWaitingDependency(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.public_message = message


class TaskWaitingProvider(Exception):
    def __init__(
        self,
        billing_job_id: str,
        *,
        next_poll_at: datetime | None = None,
        poll_delay_seconds: float = 5,
    ):
        super().__init__("Task is waiting for the provider")
        self.billing_job_id = billing_job_id
        self.next_poll_at = next_poll_at or (
            datetime.now(timezone.utc) + timedelta(seconds=max(0, poll_delay_seconds))
        )


@dataclass(frozen=True, slots=True)
class TaskExecutionResult:
    result: dict[str, Any]


@dataclass(frozen=True, slots=True)
class TaskExecutionContext:
    item_id: str
    batch_id: str
    owner_user_id: str
    project_id: str
    task_type: str
    input_snapshot: dict[str, Any]
    reference_snapshot: list[dict[str, Any]]
    model: str | None
    project_version: int
    snapshot_version: int
    target_entity_type: str | None
    target_entity_id: str | None
    target_entity_version: int | None
    attempt_count: int
    billing_job_id: str | None
    settlement_key: str
    report_progress: Callable[[int], bool]
    generation_key: str | None = None
    batch_snapshot: dict[str, Any] = field(default_factory=dict)


TaskExecutor = Callable[[TaskExecutionContext], TaskExecutionResult | dict[str, Any]]
TaskPublisher = Callable[
    [TaskExecutionContext, dict[str, Any], int | None], PublishOutcome
]
TaskInputValidator = Callable[[TaskItemSubmit], None]


@dataclass(frozen=True, slots=True)
class TaskHandler:
    """A blocking executor plus an optional idempotent compare-and-swap publisher.

    Publishers must use the context settlement key to recognize an
    already-published result and, when a target version is supplied, compare it
    atomically before publishing.
    """

    execute: TaskExecutor
    publish: TaskPublisher | None = None
    client_input_validator: TaskInputValidator | None = None


class TaskWorker:
    """Single-process durable dispatcher with bounded blocking worker threads."""

    def __init__(
        self,
        session_factory: Callable[[], Session],
        events: EventBus,
        *,
        max_concurrency: int = 4,
        poll_interval_seconds: float = 0.2,
        lease_seconds: float = 300,
        retry_base_seconds: float = 1,
    ):
        if max_concurrency < 1:
            raise ValueError("task worker concurrency must be positive")
        if lease_seconds <= 0:
            raise ValueError("task worker lease must be positive")
        self.session_factory = session_factory
        self.events = events
        self.max_concurrency = max_concurrency
        self.poll_interval_seconds = poll_interval_seconds
        self.lease_seconds = lease_seconds
        self.retry_base_seconds = retry_base_seconds
        self.worker_id = uuid.uuid4().hex
        self._handlers: dict[str, TaskHandler] = {}
        self._state_lock = threading.RLock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._executor: ThreadPoolExecutor | None = None

    @property
    def running(self) -> bool:
        with self._state_lock:
            return self._thread is not None and self._thread.is_alive()

    @property
    def supported_task_types(self) -> set[str]:
        with self._state_lock:
            return set(self._handlers)

    def register(
        self,
        task_type: str,
        execute: TaskExecutor,
        *,
        publish: TaskPublisher | None = None,
        client_input_validator: TaskInputValidator | None = None,
    ) -> None:
        if not task_type or len(task_type) > 64:
            raise ValueError("task type is invalid")
        with self._state_lock:
            if self.running:
                raise RuntimeError(
                    "task handlers must be registered before worker start"
                )
            if task_type in self._handlers:
                raise ValueError(f"task handler already registered: {task_type}")
            self._handlers[task_type] = TaskHandler(
                execute=execute,
                publish=publish,
                client_input_validator=client_input_validator,
            )

    def supports(self, task_type: str) -> bool:
        with self._state_lock:
            return task_type in self._handlers

    def supports_client_submission(self, task_type: str) -> bool:
        with self._state_lock:
            handler = self._handlers.get(task_type)
            return handler is not None and handler.client_input_validator is not None

    def validate_client_submission(self, request: TaskSubmitRequest) -> None:
        with self._state_lock:
            handlers = dict(self._handlers)
        for item in request.items:
            task_type = item.task_type or request.task_type
            handler = handlers.get(task_type)
            if handler is None or handler.client_input_validator is None:
                raise ValueError(f"task type is not client-submittable: {task_type}")
            handler.client_input_validator(item)

    def start(self) -> None:
        with self._state_lock:
            if self.running:
                return
            self._stop.clear()
            self._wake.clear()
            with self.session_factory() as db:
                TaskService(db, self.events).recover_orphaned(self.worker_id)
            self._executor = ThreadPoolExecutor(
                max_workers=self.max_concurrency,
                thread_name_prefix="openmontage-task",
            )
            self._thread = threading.Thread(
                target=self._dispatch,
                name="openmontage-task-dispatcher",
                daemon=True,
            )
            self._thread.start()

    def notify(self) -> None:
        self._wake.set()

    def stop(self, timeout: float = 30) -> bool:
        with self._state_lock:
            thread = self._thread
            if thread is None:
                return True
            self._stop.set()
            self._wake.set()
        thread.join(timeout=max(0, timeout))
        stopped = not thread.is_alive()
        if stopped:
            with self._state_lock:
                self._thread = None
                self._executor = None
        return stopped

    def _dispatch(self) -> None:
        executor = self._executor
        if executor is None:
            return
        futures: set[Future[None]] = set()
        try:
            while True:
                done = {future for future in futures if future.done()}
                for future in done:
                    futures.remove(future)
                    try:
                        future.result()
                    except Exception:
                        logger.exception("Task worker future failed unexpectedly")

                if self._stop.is_set():
                    if not futures:
                        break
                    self._wake.wait(self.poll_interval_seconds)
                    self._wake.clear()
                    continue

                claimed = False
                while len(futures) < self.max_concurrency and not self._stop.is_set():
                    try:
                        with self.session_factory() as db:
                            claim = TaskService(db, self.events).claim_next(
                                worker_id=self.worker_id,
                                supported_task_types=self.supported_task_types,
                                lease_seconds=self.lease_seconds,
                            )
                    except Exception:
                        logger.exception("Task worker could not claim queued work")
                        self._wake.wait(self.poll_interval_seconds)
                        self._wake.clear()
                        break
                    if claim is None:
                        break
                    claimed = True
                    futures.add(executor.submit(self._execute, claim))
                if not claimed:
                    self._wake.wait(self.poll_interval_seconds)
                    self._wake.clear()
        finally:
            executor.shutdown(wait=True, cancel_futures=False)

    def _execute(self, claim: TaskClaim) -> None:
        handler = self._handlers.get(claim.task_type)
        if handler is None:
            self._fail(
                claim,
                code="task_handler_unavailable",
                message="Task handler is unavailable",
                retryable=True,
            )
            return
        with self.session_factory() as db:
            current = TaskService(db, self.events).renew_claim(
                claim.item_id,
                self.worker_id,
                claim.attempt_count,
                self.lease_seconds,
            )
        if not current:
            return
        context = _context_from_claim(
            claim,
            lambda progress: self._report_progress(claim, progress),
        )
        heartbeat_stop = threading.Event()
        heartbeat = threading.Thread(
            target=self._heartbeat_claim,
            args=(claim, heartbeat_stop),
            name=f"openmontage-task-heartbeat-{claim.item_id[:8]}",
            daemon=True,
        )
        heartbeat.start()
        try:
            executed = handler.execute(context)
            result = (
                executed.result
                if isinstance(executed, TaskExecutionResult)
                else executed
            )
            if not isinstance(result, dict):
                raise PermanentTaskError(
                    "invalid_task_result", "Task handler returned an invalid result"
                )
            billing_job_id = result.get("billing_job_id")
            if billing_job_id is not None:
                if not isinstance(billing_job_id, str) or len(billing_job_id) != 32:
                    raise PermanentTaskError(
                        "invalid_billing_job", "Task handler returned an invalid billing job"
                    )
                with self.session_factory() as db:
                    if not TaskService(db, self.events).bind_claim_billing_job(
                        claim.item_id,
                        self.worker_id,
                        claim.attempt_count,
                        billing_job_id,
                    ):
                        return
            if handler.publish is None:
                if claim.target_entity_version is not None:
                    raise PermanentTaskError(
                        "version_guard_missing",
                        "Versioned task result requires an atomic publisher",
                    )
            else:
                if not self._claim_is_current(claim):
                    return
                outcome = handler.publish(context, result, claim.target_entity_version)
                if outcome == PublishOutcome.STALE:
                    self._fail(
                        claim,
                        code="stale_entity_version",
                        message=(
                            "Task result was not published because the target changed"
                        ),
                        retryable=False,
                        result=result,
                    )
                    return
                if outcome not in {
                    PublishOutcome.PUBLISHED,
                    PublishOutcome.ALREADY_PUBLISHED,
                }:
                    raise PermanentTaskError(
                        "invalid_publish_outcome",
                        "Task publisher returned an invalid outcome",
                    )
            with self.session_factory() as db:
                TaskService(db, self.events).complete_claim(
                    claim.item_id,
                    self.worker_id,
                    claim.attempt_count,
                    result,
                )
        except TaskAwaitingPayment as exc:
            try:
                with self.session_factory() as db:
                    TaskService(db, self.events).pause_claim_for_payment(
                        claim.item_id,
                        self.worker_id,
                        claim.attempt_count,
                        billing_job_id=exc.billing_job_id,
                    )
            except TaskStateError as state_error:
                self._fail(
                    claim,
                    code=state_error.code,
                    message=state_error.message,
                    retryable=False,
                )
        except TaskWaitingProvider as exc:
            try:
                with self.session_factory() as db:
                    TaskService(db, self.events).pause_claim_for_provider(
                        claim.item_id,
                        self.worker_id,
                        claim.attempt_count,
                        billing_job_id=exc.billing_job_id,
                        next_poll_at=exc.next_poll_at,
                    )
            except TaskStateError as state_error:
                self._fail(
                    claim,
                    code=state_error.code,
                    message=state_error.message,
                    retryable=False,
                )
        except TaskWaitingDependency as exc:
            try:
                with self.session_factory() as db:
                    TaskService(db, self.events).pause_claim_for_dependency(
                        claim.item_id,
                        self.worker_id,
                        claim.attempt_count,
                        error_code=exc.code,
                        error_message=exc.public_message,
                    )
            except TaskStateError as state_error:
                self._fail(
                    claim,
                    code=state_error.code,
                    message=state_error.message,
                    retryable=False,
                )
        except _TaskClaimLost:
            return
        except RetryableTaskError as exc:
            self._fail(
                claim,
                code=exc.code,
                message=exc.public_message,
                retryable=True,
                retry_delay_seconds=exc.retry_delay_seconds,
            )
        except PermanentTaskError as exc:
            self._fail(
                claim,
                code=exc.code,
                message=exc.public_message,
                retryable=False,
            )
        except Exception:
            logger.exception(
                "Task execution failed",
                extra={"task_id": claim.batch_id, "task_item_id": claim.item_id},
            )
            self._fail(
                claim,
                code="task_execution_failed",
                message="Task execution failed",
                retryable=True,
            )
        finally:
            heartbeat_stop.set()
            heartbeat.join(timeout=max(1.0, self.poll_interval_seconds * 2))

    def _heartbeat_claim(
        self, claim: TaskClaim, heartbeat_stop: threading.Event
    ) -> None:
        interval = max(0.01, self.lease_seconds / 3)
        while not heartbeat_stop.wait(interval):
            try:
                with self.session_factory() as db:
                    current = TaskService(db, self.events).renew_claim(
                        claim.item_id,
                        self.worker_id,
                        claim.attempt_count,
                        self.lease_seconds,
                    )
            except Exception:
                logger.exception(
                    "Task worker could not renew claim",
                    extra={"task_id": claim.batch_id, "task_item_id": claim.item_id},
                )
                continue
            if not current:
                return

    def _report_progress(self, claim: TaskClaim, progress: int) -> bool:
        with self.session_factory() as db:
            current = TaskService(db, self.events).update_progress(
                claim.item_id,
                self.worker_id,
                claim.attempt_count,
                progress,
                self.lease_seconds,
            )
        if not current:
            raise _TaskClaimLost
        return True

    def _claim_is_current(self, claim: TaskClaim) -> bool:
        with self.session_factory() as db:
            return TaskService(db, self.events).claim_is_current(
                claim.item_id, self.worker_id, claim.attempt_count
            )

    def _fail(
        self,
        claim: TaskClaim,
        *,
        code: str,
        message: str,
        retryable: bool,
        retry_delay_seconds: float | None = None,
        result: dict[str, Any] | None = None,
    ) -> None:
        delay = (
            retry_delay_seconds
            if retry_delay_seconds is not None
            else self.retry_base_seconds * (2 ** max(0, claim.attempt_count - 1))
        )
        with self.session_factory() as db:
            TaskService(db, self.events).fail_claim(
                claim.item_id,
                self.worker_id,
                claim.attempt_count,
                error_code=code,
                error_message=message,
                retryable=retryable,
                retry_delay_seconds=max(0, delay),
                result=result,
            )


def _context_from_claim(
    claim: TaskClaim, report_progress: Callable[[int], bool]
) -> TaskExecutionContext:
    return TaskExecutionContext(
        item_id=claim.item_id,
        batch_id=claim.batch_id,
        owner_user_id=claim.owner_user_id,
        project_id=claim.project_id,
        task_type=claim.task_type,
        input_snapshot=claim.input_snapshot,
        reference_snapshot=claim.reference_snapshot,
        model=claim.model,
        project_version=claim.project_version,
        snapshot_version=claim.snapshot_version,
        target_entity_type=claim.target_entity_type,
        target_entity_id=claim.target_entity_id,
        target_entity_version=claim.target_entity_version,
        attempt_count=claim.attempt_count,
        billing_job_id=claim.billing_job_id,
        settlement_key=claim.settlement_key,
        generation_key=claim.generation_key,
        report_progress=report_progress,
        batch_snapshot=claim.batch_snapshot,
    )
