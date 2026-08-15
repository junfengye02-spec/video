from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.auth.models import User
from server.app.billing.models import CostReceipt, GenerationJob
from server.app.db.base import Base
from server.app.db.session import get_db
from server.app.events import EventBus, _format_sse
from server.app.generation_units.models import VideoGenerationUnit
from server.app.main import create_app
from server.app.projects.models import ProjectRecord
from server.app.tasks.models import TaskBatch, TaskDependency, TaskItem
from server.app.tasks.schemas import TaskSubmitRequest
from server.app.tasks.service import TaskConflict, TaskStateError, TaskService
from server.app.tasks.worker import (
    PublishOutcome,
    RetryableTaskError,
    TaskAwaitingPayment,
    TaskExecutionContext,
    TaskWaitingProvider,
    TaskWorker,
)


ALICE = CurrentUser(
    id="task-alice0000000000000000001",
    email="task-alice@example.com",
    role="user",
)
BOB = CurrentUser(
    id="task-bob000000000000000000003",
    email="task-bob@example.com",
    role="user",
)
PROJECT_ID = "1" * 32
TERMINAL_STATUSES = {"complete", "failed", "cancelled", "partial_failure"}


@pytest.fixture
def task_store(tmp_path):
    database = tmp_path / "tasks.db"
    engine = create_engine(
        f"sqlite+pysqlite:///{database.as_posix()}",
        connect_args={"check_same_thread": False},
    )
    event.listen(
        engine,
        "connect",
        lambda connection, _record: connection.execute("PRAGMA foreign_keys=ON"),
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        db.add_all(
            [
                User(
                    id=ALICE.id,
                    email=ALICE.email,
                    password_hash="hash",
                    role="user",
                    status="active",
                ),
                User(
                    id=BOB.id,
                    email=BOB.email,
                    password_hash="hash",
                    role="user",
                    status="active",
                ),
                ProjectRecord(
                    id=PROJECT_ID,
                    owner_user_id=ALICE.id,
                    title="Async tasks",
                    mode="general_video",
                    project_type="single_video",
                ),
            ]
        )
        db.commit()
    try:
        yield factory
    finally:
        engine.dispose()


@pytest.fixture
def shared_connection_task_store():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    event.listen(
        engine,
        "connect",
        lambda connection, _record: connection.execute("PRAGMA foreign_keys=ON"),
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as db:
        db.add_all(
            [
                User(
                    id=ALICE.id,
                    email=ALICE.email,
                    password_hash="hash",
                    role="user",
                    status="active",
                ),
                User(
                    id=BOB.id,
                    email=BOB.email,
                    password_hash="hash",
                    role="user",
                    status="active",
                ),
                ProjectRecord(
                    id=PROJECT_ID,
                    owner_user_id=ALICE.id,
                    title="Async tasks",
                    mode="general_video",
                    project_type="single_video",
                ),
            ]
        )
        db.commit()
    try:
        yield factory, engine
    finally:
        engine.dispose()


def _request(
    *,
    key: str = "batch-1",
    task_type: str = "test.echo",
    items: list[dict] | None = None,
) -> TaskSubmitRequest:
    return TaskSubmitRequest.model_validate(
        {
            "idempotency_key": key,
            "task_type": task_type,
            "project_version": 3,
            "snapshot_version": 1,
            "snapshot": {"project_title": "snapshot"},
            "items": items
            or [
                {
                    "idempotency_key": "item-1",
                    "input": {"value": 1},
                    "max_attempts": 3,
                }
            ],
        }
    )


def _submit(factory, request: TaskSubmitRequest, events: EventBus | None = None):
    with factory() as db:
        batch, deduplicated = TaskService(db, events).submit(
            owner_user_id=ALICE.id,
            project_id=PROJECT_ID,
            request=request,
        )
        return batch.id, deduplicated


def _items(factory, batch_id: str) -> list[TaskItem]:
    with factory() as db:
        return list(
            db.scalars(
                select(TaskItem)
                .where(TaskItem.batch_id == batch_id)
                .order_by(TaskItem.position)
            )
        )


def _add_billing_parent_and_child(factory) -> tuple[str, str]:
    billing_job_id = "b" * 32
    billing_child_id = "c" * 32
    with factory() as db:
        db.add_all(
            [
                GenerationJob.parent(
                    id=billing_job_id,
                    user_id=ALICE.id,
                    project_id=PROJECT_ID,
                    operation="async-test",
                ),
                GenerationJob(
                    id=billing_child_id,
                    parent_job_id=billing_job_id,
                    chargeable=True,
                    user_id=ALICE.id,
                    project_id=PROJECT_ID,
                    operation="async-test-item",
                    capability="image",
                    token_kind="image",
                    token_alias="async-test-image",
                    model="test-model",
                    multiplier_bps=10_000,
                    status="reserved",
                    quote_id="async-test-quote",
                    quote_expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
                    quote_estimated_quota=1,
                    quote_estimated_provider_cost_micro=1,
                    quote_quota_per_unit=Decimal("1"),
                    quote_pricing_version="test-v1",
                    quote_other_ratios_json="{}",
                    quote_billing_fingerprint="async-test-fingerprint",
                    result_staged=False,
                    result_visible=False,
                ),
            ]
        )
        db.commit()
    return billing_job_id, billing_child_id


def _add_video_billing_job(
    factory,
    *,
    job_id: str,
    shot_id: str,
    owner_user_id: str = ALICE.id,
    project_id: str = PROJECT_ID,
    model: str = "video-model",
    operation: str | None = None,
    provider_method: str = "POST",
    provider_route: str = "/v1/videos",
) -> str:
    with factory() as db:
        db.add(
            GenerationJob(
                id=job_id,
                parent_job_id=None,
                chargeable=True,
                user_id=owner_user_id,
                project_id=project_id,
                operation=operation or f"shot:{shot_id}",
                capability="video",
                token_kind="video",
                token_alias=f"video-{job_id[:8]}",
                model=model,
                multiplier_bps=10_000,
                provider_method=provider_method,
                provider_route=provider_route,
                status="result_pending",
                quote_id=f"quote-{job_id}",
                quote_expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
                quote_estimated_quota=1,
                quote_estimated_provider_cost_micro=1,
                quote_quota_per_unit=Decimal("1"),
                quote_pricing_version="test-v1",
                quote_other_ratios_json="{}",
                quote_billing_fingerprint=f"fingerprint-{job_id}",
                result_staged=False,
                result_visible=False,
            )
        )
        db.commit()
    return job_id


def _wait_for_batch(
    factory,
    batch_id: str,
    *,
    statuses: set[str] = TERMINAL_STATUSES,
    timeout: float = 8,
) -> TaskBatch:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with factory() as db:
            batch = db.get(TaskBatch, batch_id)
            if batch is not None and batch.status in statuses:
                db.expunge(batch)
                return batch
        time.sleep(0.02)
    with factory() as db:
        batch = db.get(TaskBatch, batch_id)
        status = batch.status if batch is not None else "missing"
    raise AssertionError(f"task {batch_id} did not reach {statuses}; status={status}")


def test_state_machine_aggregates_parent_partial_failure(task_store):
    batch_id, _ = _submit(
        task_store,
        _request(
            items=[
                {"idempotency_key": "one", "input": {}},
                {"idempotency_key": "two", "input": {}},
            ]
        ),
    )
    first, second = _items(task_store, batch_id)
    with task_store() as db:
        service = TaskService(db)
        service.transition_item(first.id, "running")
        service.transition_item(first.id, "complete")
        service.transition_item(second.id, "running")
        service.transition_item(
            second.id,
            "failed",
            error_code="test_failure",
            error_message="Task failed in test",
        )
        batch = db.get(TaskBatch, batch_id)
        assert batch is not None
        assert (batch.status, batch.progress) == ("partial_failure", 50)
        assert (batch.completed_items, batch.failed_items) == (1, 1)
        with pytest.raises(TaskStateError):
            service.transition_item(first.id, "running")
        service.retry_owned_item(
            batch_id=batch_id,
            item_id=second.id,
            owner_user_id=ALICE.id,
            project_id=PROJECT_ID,
        )
        batch = db.get(TaskBatch, batch_id)
        assert batch is not None
        assert (batch.status, batch.error_code, batch.error_message) == (
            "running",
            None,
            None,
        )
        service.transition_item(second.id, "running")
        service.transition_item(second.id, "complete")
        batch = db.get(TaskBatch, batch_id)
        assert batch is not None
        assert (batch.status, batch.error_code, batch.error_message) == (
            "complete",
            None,
            None,
        )


def test_manual_retry_uses_reserved_final_attempt_and_hides_exhausted_retry(
    task_store,
):
    batch_id, _ = _submit(
        task_store,
        _request(
            items=[
                {
                    "idempotency_key": "manual-retry",
                    "input": {},
                    "max_attempts": 9,
                }
            ]
        ),
    )
    item = _items(task_store, batch_id)[0]
    with task_store() as db:
        stored = db.get(TaskItem, item.id)
        assert stored is not None
        stored.status = "failed"
        stored.attempt_count = 9
        stored.retryable = False
        db.commit()

        service = TaskService(db)
        retried = service.retry_owned_item(
            batch_id=batch_id,
            item_id=item.id,
            owner_user_id=ALICE.id,
            project_id=PROJECT_ID,
        )
        assert (retried.status, retried.max_attempts) == ("queued", 10)

        retried.status = "failed"
        retried.attempt_count = 10
        retried.retryable = True
        db.commit()
        response = service.batch_response(
            service.require_owned_batch(batch_id, ALICE.id, PROJECT_ID),
            include_items=True,
        )
        assert response.items[0].retryable is False


def test_failed_resource_image_retry_rotates_terminal_no_charge_settlement(
    task_store,
):
    old_job_id = "d" * 32
    batch_id, _ = _submit(
        task_store,
        _request(
            key="resource-image-no-charge-retry",
            task_type="resource_image.generate",
            items=[
                {
                    "idempotency_key": "resource-image",
                    "input": {"prompt": "frame"},
                    "settlement_key": old_job_id,
                }
            ],
        ),
    )
    item = _items(task_store, batch_id)[0]

    with task_store() as db:
        stored = db.get(TaskItem, item.id)
        assert stored is not None
        stored.status = "failed"
        stored.error_code = "provider_result_pending"
        stored.attempt_count = 1
        stored.billing_job_id = old_job_id
        db.add(
            GenerationJob(
                id=old_job_id,
                parent_job_id=None,
                chargeable=True,
                user_id=ALICE.id,
                project_id=PROJECT_ID,
                operation="image_generation",
                capability="image",
                token_kind="image",
                token_alias="image-v1",
                model="gpt-image-2",
                multiplier_bps=10_000,
                status="provider_result_missing_no_charge",
                quote_id="quote-resource-image-no-charge",
                quote_expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
                quote_estimated_quota=1,
                quote_estimated_provider_cost_micro=1,
                quote_quota_per_unit=Decimal("1"),
                quote_pricing_version="test-v1",
                quote_other_ratios_json="{}",
                quote_billing_fingerprint="resource-image-no-charge-fingerprint",
                result_staged=False,
                result_visible=False,
            )
        )
        db.commit()

        retried = TaskService(db).retry_owned_item(
            batch_id=batch_id,
            item_id=item.id,
            owner_user_id=ALICE.id,
            project_id=PROJECT_ID,
        )

        assert retried.status == "queued"
        assert retried.billing_job_id is None
        assert retried.settlement_key != old_job_id
        assert len(retried.settlement_key) == 32
        assert all(value in "0123456789abcdef" for value in retried.settlement_key)
        assert db.get(GenerationJob, old_job_id).status == (
            "provider_result_missing_no_charge"
        )


def test_failed_generation_unit_retry_rotates_refunded_execution_at_hard_limit(
    task_store,
):
    old_generation_key = "e" * 64
    old_job_id = old_generation_key[:32]
    unit_id = "unit-refunded-retry"
    batch_id, _ = _submit(
        task_store,
        _request(
            key="generation-unit-no-charge-retry",
            task_type="generation_unit_video.generate",
            items=[
                {
                    "idempotency_key": "generation-unit",
                    "input": {},
                    "model": "omni_flash-10s",
                    "target_entity_type": "generation_unit",
                    "target_entity_id": unit_id,
                    "target_entity_version": 1,
                    "max_attempts": 10,
                    "settlement_key": old_job_id,
                    "generation_key": old_generation_key,
                    "generation_revision": 1,
                }
            ],
        ),
    )
    item = _items(task_store, batch_id)[0]

    with task_store() as db:
        stored = db.get(TaskItem, item.id)
        assert stored is not None
        stored.status = "failed"
        stored.error_code = "provider_call_failed"
        stored.error_message = "Video provider call failed"
        stored.attempt_count = 10
        stored.max_attempts = 10
        stored.retryable = False
        stored.billing_job_id = old_job_id
        db.add_all(
            [
                GenerationJob(
                    id=old_job_id,
                    parent_job_id=None,
                    chargeable=True,
                    user_id=ALICE.id,
                    project_id=PROJECT_ID,
                    operation=f"generation_unit:{unit_id}:v1",
                    capability="video",
                    token_kind="video",
                    token_alias="video-v1",
                    model="omni_flash-10s",
                    multiplier_bps=10_000,
                    provider_method="POST",
                    provider_route="/v1/videos",
                    status="failed_no_charge",
                    quote_id="quote-generation-unit-no-charge",
                    quote_expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
                    quote_estimated_quota=1,
                    quote_estimated_provider_cost_micro=1,
                    quote_quota_per_unit=Decimal("1"),
                    quote_pricing_version="test-v1",
                    quote_other_ratios_json="{}",
                    quote_billing_fingerprint="generation-unit-no-charge-fingerprint",
                    result_staged=False,
                    result_visible=False,
                ),
                VideoGenerationUnit(
                    project_id=PROJECT_ID,
                    id=unit_id,
                    revision=1,
                    plan_id="f" * 64,
                    status="failed",
                    active=False,
                    source_shot_ids_json=["shot-1"],
                    source_shot_versions_json={"shot-1": 1},
                    source_beat_ids_json=["beat-1"],
                    source_segment_ids_json=["segment-1"],
                    prompt_segments_json=[],
                    provider="newapi",
                    model_id="omni_flash-10s",
                    operation="text_to_video",
                    profile_revision="profile-v1",
                    profile_json={},
                    requested_duration_seconds=10,
                    source_duration_seconds=None,
                    timeline_duration_seconds=10,
                    output_asset_id=None,
                    output_path=None,
                    task_item_id=stored.id,
                    billing_job_id=old_job_id,
                    replaces_unit_id=None,
                    execution_key=old_generation_key,
                    diagnostics_json={},
                ),
            ]
        )
        db.commit()

        service = TaskService(db)
        response = service.batch_response(
            service.require_owned_batch(batch_id, ALICE.id, PROJECT_ID),
            include_items=True,
        )
        assert response.items[0].retryable is True

        retried = service.retry_owned_item(
            batch_id=batch_id,
            item_id=item.id,
            owner_user_id=ALICE.id,
            project_id=PROJECT_ID,
        )

        unit = db.get(VideoGenerationUnit, (PROJECT_ID, unit_id, 1))
        old_job = db.get(GenerationJob, old_job_id)
        assert unit is not None and old_job is not None
        assert retried.status == "queued"
        assert retried.attempt_count == 0
        assert retried.max_attempts == 9
        assert retried.billing_job_id is None
        assert retried.generation_key != old_generation_key
        assert retried.settlement_key == retried.generation_key[:32]
        assert unit.execution_key == retried.generation_key
        assert unit.billing_job_id is None
        assert unit.status == "queued"
        assert unit.diagnostics_json["execution_retries"] == [
            {
                "execution_cycle": 1,
                "generation_key": old_generation_key,
                "settlement_key": old_job_id,
                "billing_job_id": old_job_id,
                "billing_status": "failed_no_charge",
                "attempt_count": 10,
                "error_code": "provider_call_failed",
                "retired_at": unit.diagnostics_json["execution_retries"][0][
                    "retired_at"
                ],
            }
        ]
        assert old_job.status == "failed_no_charge"
        assert old_job.result_visible is False


def test_parent_aggregates_cancelled_and_mixed_terminal_items(task_store):
    cancelled_id, _ = _submit(
        task_store,
        _request(
            key="all-cancelled",
            items=[
                {"idempotency_key": "one", "input": {}},
                {"idempotency_key": "two", "input": {}},
            ],
        ),
    )
    mixed_id, _ = _submit(
        task_store,
        _request(
            key="mixed-cancelled",
            items=[
                {"idempotency_key": "one", "input": {}},
                {"idempotency_key": "two", "input": {}},
            ],
        ),
    )
    with task_store() as db:
        service = TaskService(db)
        for item in _items(task_store, cancelled_id):
            service.transition_item(item.id, "cancelled")
        complete, cancelled = _items(task_store, mixed_id)
        service.transition_item(complete.id, "running")
        service.transition_item(complete.id, "complete")
        service.transition_item(cancelled.id, "cancelled")
        assert db.get(TaskBatch, cancelled_id).status == "cancelled"
        assert db.get(TaskBatch, mixed_id).status == "partial_failure"


def test_submission_is_idempotent_and_rejects_key_reuse_with_new_payload(task_store):
    request = _request()
    first_id, first_deduplicated = _submit(task_store, request)
    second_id, second_deduplicated = _submit(task_store, request)

    assert first_deduplicated is False
    assert second_deduplicated is True
    assert second_id == first_id
    assert len(_items(task_store, first_id)) == 1

    changed = _request()
    changed.items[0].input["value"] = 2
    with pytest.raises(TaskConflict, match="different task submission"):
        _submit(task_store, changed)


def test_dependencies_block_unlock_and_propagate_failure(task_store):
    successful_id, _ = _submit(
        task_store,
        _request(
            key="deps-success",
            items=[
                {"idempotency_key": "first", "input": {}},
                {
                    "idempotency_key": "second",
                    "input": {},
                    "depends_on": ["first"],
                },
            ],
        ),
    )
    first, second = _items(task_store, successful_id)
    assert second.status == "waiting_dependency"
    with task_store() as db:
        service = TaskService(db)
        service.transition_item(first.id, "running")
        service.transition_item(first.id, "complete")
        assert service.resolve_dependencies() == 1
        assert db.get(TaskItem, second.id).status == "queued"

    failed_id, _ = _submit(
        task_store,
        _request(
            key="deps-failure",
            items=[
                {"idempotency_key": "upstream", "input": {}},
                {
                    "idempotency_key": "downstream",
                    "input": {},
                    "depends_on": ["upstream"],
                },
            ],
        ),
    )
    upstream, downstream = _items(task_store, failed_id)
    with task_store() as db:
        service = TaskService(db)
        service.transition_item(upstream.id, "running")
        service.transition_item(
            upstream.id,
            "failed",
            error_code="upstream_failed",
            error_message="Upstream failed",
        )
        service.resolve_dependencies()
        downstream = db.get(TaskItem, downstream.id)
        batch = db.get(TaskBatch, failed_id)
        assert downstream is not None and batch is not None
        assert downstream.status == "failed"
        assert downstream.attempt_count == 0
        assert downstream.error_code == "dependency_failed"
        assert batch.status == "failed"


def test_retry_reopens_transitive_dependency_failures(task_store):
    batch_id, _ = _submit(
        task_store,
        _request(
            key="dependency-retry-chain",
            items=[
                {"idempotency_key": "first", "input": {}},
                {
                    "idempotency_key": "second",
                    "input": {},
                    "depends_on": ["first"],
                },
                {
                    "idempotency_key": "third",
                    "input": {},
                    "depends_on": ["second"],
                },
            ],
        ),
    )
    first, second, third = _items(task_store, batch_id)
    with task_store() as db:
        service = TaskService(db)
        service.transition_item(first.id, "running")
        service.transition_item(
            first.id,
            "failed",
            error_code="upstream_failed",
            error_message="Upstream failed",
        )
        assert service.resolve_dependencies() == 1
        assert [db.get(TaskItem, item.id).status for item in (second, third)] == [
            "failed",
            "failed",
        ]

        service.retry_owned_item(
            batch_id=batch_id,
            item_id=first.id,
            owner_user_id=ALICE.id,
            project_id=PROJECT_ID,
        )
        assert [db.get(TaskItem, item.id).status for item in (first, second, third)] == [
            "queued",
            "waiting_dependency",
            "waiting_dependency",
        ]
        service.transition_item(first.id, "running")
        service.transition_item(first.id, "complete")
        service.resolve_dependencies()
        assert db.get(TaskItem, second.id).status == "queued"
        service.transition_item(second.id, "running")
        service.transition_item(second.id, "complete")
        service.resolve_dependencies()
        assert db.get(TaskItem, third.id).status == "queued"


def test_task_dependency_foreign_keys_reject_cross_batch_edges(task_store):
    first_batch_id, _ = _submit(task_store, _request(key="first-batch"))
    second_batch_id, _ = _submit(task_store, _request(key="second-batch"))
    first_item = _items(task_store, first_batch_id)[0]
    second_item = _items(task_store, second_batch_id)[0]

    with task_store() as db:
        db.add(
            TaskDependency(
                batch_id=second_batch_id,
                task_item_id=second_item.id,
                depends_on_item_id=first_item.id,
                failure_policy="fail",
            )
        )
        with pytest.raises(IntegrityError):
            db.commit()


def test_atomic_claim_allows_only_one_sqlite_worker(task_store):
    batch_id, _ = _submit(task_store, _request(key="atomic-claim"))
    barrier = threading.Barrier(2)
    claims = []
    failures = []

    def claim(worker_id: str):
        try:
            barrier.wait(timeout=3)
            with task_store() as db:
                claimed = TaskService(db).claim_next(
                    worker_id=worker_id,
                    supported_task_types={"test.echo"},
                    lease_seconds=30,
                )
                claims.append(claimed)
        except Exception as exc:  # pragma: no cover - assertion below reports it
            failures.append(exc)

    first = threading.Thread(target=claim, args=("worker-one",))
    second = threading.Thread(target=claim, args=("worker-two",))
    first.start()
    second.start()
    first.join(5)
    second.join(5)

    assert not failures
    successful = [claim for claim in claims if claim is not None]
    assert len(successful) == 1
    assert successful[0].batch_id == batch_id
    item = _items(task_store, batch_id)[0]
    assert item.status == "running"
    assert item.attempt_count == 1


def test_attempt_fencing_rejects_stale_same_worker_completion(task_store):
    batch_id, _ = _submit(task_store, _request(key="attempt-fencing"))
    with task_store() as db:
        service = TaskService(db)
        first = service.claim_next(
            worker_id="same-worker",
            supported_task_types={"test.echo"},
            lease_seconds=0,
        )
        assert first is not None
        second = service.claim_next(
            worker_id="same-worker",
            supported_task_types={"test.echo"},
            lease_seconds=30,
        )
        assert second is not None
        assert (first.item_id, first.attempt_count) == (second.item_id, 1)
        assert second.attempt_count == 2
        assert not service.complete_claim(
            first.item_id,
            "same-worker",
            first.attempt_count,
            {"stale": True},
        )
        assert service.complete_claim(
            second.item_id,
            "same-worker",
            second.attempt_count,
            {"current": True},
        )
    item = _items(task_store, batch_id)[0]
    assert item.result_snapshot == {"current": True}


def test_progress_update_is_atomically_fenced_when_lease_is_reclaimed(
    shared_connection_task_store,
):
    factory, engine = shared_connection_task_store
    batch_id, _ = _submit(factory, _request(key="progress-fencing"))
    with factory() as db:
        first = TaskService(db).claim_next(
            worker_id="worker-one",
            supported_task_types={"test.echo"},
            lease_seconds=0,
        )
    assert first is not None

    mutation_ready = threading.Event()
    release_mutation = threading.Event()
    progress_thread_id: list[int] = []

    def wait_before_atomic_update(
        _connection,
        _cursor,
        statement,
        _parameters,
        _context,
        _executemany,
    ):
        if (
            progress_thread_id == [threading.get_ident()]
            and statement.lstrip().upper().startswith("UPDATE TASK_ITEMS")
            and "progress" in statement.lower()
        ):
            mutation_ready.set()
            assert release_mutation.wait(5)

    def wait_after_legacy_select(
        _connection,
        _cursor,
        statement,
        _parameters,
        _context,
        _executemany,
    ):
        if (
            progress_thread_id == [threading.get_ident()]
            and statement.lstrip().upper().startswith("SELECT")
            and "task_items.claimed_by" in statement
            and not mutation_ready.is_set()
        ):
            mutation_ready.set()
            assert release_mutation.wait(5)

    event.listen(engine, "before_cursor_execute", wait_before_atomic_update)
    event.listen(engine, "after_cursor_execute", wait_after_legacy_select)
    results: list[bool] = []
    failures: list[Exception] = []

    def report_progress():
        progress_thread_id.append(threading.get_ident())
        try:
            with factory() as db:
                results.append(
                    TaskService(db).update_progress(
                        first.item_id,
                        "worker-one",
                        first.attempt_count,
                        25,
                        30,
                    )
                )
        except Exception as exc:  # pragma: no cover - assertion below reports it
            failures.append(exc)

    progress = threading.Thread(target=report_progress)
    progress.start()
    try:
        assert mutation_ready.wait(5)
        with factory() as db:
            second = TaskService(db).claim_next(
                worker_id="worker-two",
                supported_task_types={"test.echo"},
                lease_seconds=30,
            )
        assert second is not None
        assert second.item_id == first.item_id
        assert second.attempt_count == first.attempt_count + 1
    finally:
        release_mutation.set()
        progress.join(5)
        event.remove(engine, "before_cursor_execute", wait_before_atomic_update)
        event.remove(engine, "after_cursor_execute", wait_after_legacy_select)

    assert not progress.is_alive()
    assert not failures
    assert results == [False]
    item = _items(factory, batch_id)[0]
    assert (item.status, item.claimed_by, item.attempt_count, item.progress) == (
        "running",
        "worker-two",
        2,
        0,
    )


def test_worker_stops_old_execution_when_progress_detects_a_lost_claim(task_store):
    batch_id, _ = _submit(task_store, _request(key="lost-progress-claim"))
    continued = threading.Event()
    worker = TaskWorker(task_store, EventBus(), max_concurrency=1)

    def execute(context: TaskExecutionContext):
        context.report_progress(10)
        continued.set()
        return {"stale": True}

    worker.register("test.echo", execute)
    with task_store() as db:
        first = TaskService(db).claim_next(
            worker_id=worker.worker_id,
            supported_task_types={"test.echo"},
            lease_seconds=0,
        )
    assert first is not None
    with task_store() as db:
        second = TaskService(db).claim_next(
            worker_id="replacement-worker",
            supported_task_types={"test.echo"},
            lease_seconds=30,
        )
    assert second is not None and second.attempt_count == 2

    worker._execute(first)

    assert not continued.is_set()
    item = _items(task_store, batch_id)[0]
    assert (item.status, item.claimed_by, item.attempt_count, item.progress) == (
        "running",
        "replacement-worker",
        2,
        0,
    )


def test_worker_enforces_concurrency_limit(task_store):
    batch_id, _ = _submit(
        task_store,
        _request(
            key="concurrency",
            items=[
                {"idempotency_key": f"item-{index}", "input": {"index": index}}
                for index in range(6)
            ],
        ),
    )
    lock = threading.Lock()
    active = 0
    maximum = 0

    def execute(_context: TaskExecutionContext):
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
        time.sleep(0.08)
        with lock:
            active -= 1
        return {"ok": True}

    worker = TaskWorker(
        task_store,
        EventBus(),
        max_concurrency=2,
        poll_interval_seconds=0.01,
    )
    worker.register("test.echo", execute)
    worker.start()
    try:
        batch = _wait_for_batch(task_store, batch_id)
    finally:
        assert worker.stop(timeout=5)

    assert batch.status == "complete"
    assert maximum == 2


def test_worker_heartbeat_keeps_long_running_claim_exclusive(task_store):
    batch_id, _ = _submit(task_store, _request(key="lease-heartbeat"))
    started = threading.Event()
    release = threading.Event()
    calls: list[str] = []

    def first_execute(_context: TaskExecutionContext):
        calls.append("first")
        started.set()
        assert release.wait(5)
        return {"worker": "first"}

    first = TaskWorker(
        task_store,
        EventBus(),
        max_concurrency=1,
        poll_interval_seconds=0.01,
        lease_seconds=0.12,
    )
    second = TaskWorker(
        task_store,
        EventBus(),
        max_concurrency=1,
        poll_interval_seconds=0.01,
        lease_seconds=0.12,
    )
    first.register("test.echo", first_execute)
    second.register("test.echo", lambda _context: calls.append("second") or {})
    first.start()
    try:
        assert started.wait(3)
        second.start()
        time.sleep(0.35)
        assert calls == ["first"]
        release.set()
        assert _wait_for_batch(task_store, batch_id).status == "complete"
    finally:
        release.set()
        assert first.stop(timeout=5)
        assert second.stop(timeout=5)


def test_worker_does_not_steal_live_claim_and_recovers_expired_lease(task_store):
    batch_id, _ = _submit(
        task_store,
        _request(
            key="recovery",
            items=[
                {"idempotency_key": "running", "input": {}},
                {"idempotency_key": "queued", "input": {}},
            ],
        ),
    )
    with task_store() as db:
        claim = TaskService(db).claim_next(
            worker_id="dead-worker",
            supported_task_types={"test.echo"},
            lease_seconds=3600,
        )
        assert claim is not None

    calls: list[str] = []

    def execute(context: TaskExecutionContext):
        calls.append(context.item_id)
        return {"recovered": True}

    worker = TaskWorker(
        task_store,
        EventBus(),
        max_concurrency=2,
        poll_interval_seconds=0.01,
    )
    worker.register("test.echo", execute)
    worker.start()
    try:
        deadline = time.monotonic() + 3
        while len(calls) < 1 and time.monotonic() < deadline:
            time.sleep(0.02)
        assert len(calls) == 1
        assert calls[0] != claim.item_id
        with task_store() as db:
            running = db.get(TaskItem, claim.item_id)
            assert running is not None and running.status == "running"
            running.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            db.commit()
        worker.notify()
        batch = _wait_for_batch(task_store, batch_id)
    finally:
        assert worker.stop(timeout=5)

    assert batch.status == "complete"
    assert len(calls) == 2
    recovered = _items(task_store, batch_id)
    assert sorted(item.attempt_count for item in recovered) == [1, 2]


def test_worker_shutdown_drains_running_work_without_claiming_more(task_store):
    batch_id, _ = _submit(
        task_store,
        _request(
            key="shutdown",
            items=[
                {"idempotency_key": "in-flight", "input": {"index": 1}},
                {"idempotency_key": "still-queued", "input": {"index": 2}},
            ],
        ),
    )
    started = threading.Event()
    release = threading.Event()
    calls: list[int] = []

    def execute(context: TaskExecutionContext):
        calls.append(context.input_snapshot["index"])
        started.set()
        assert release.wait(5)
        return {"ok": True}

    worker = TaskWorker(
        task_store,
        EventBus(),
        max_concurrency=1,
        poll_interval_seconds=0.01,
    )
    worker.register("test.echo", execute)
    worker.start()
    assert started.wait(3)
    stopped: list[bool] = []
    stopper = threading.Thread(target=lambda: stopped.append(worker.stop(timeout=4)))
    stopper.start()
    time.sleep(0.05)
    assert calls == [1]
    assert [item.status for item in _items(task_store, batch_id)] == [
        "running",
        "queued",
    ]
    release.set()
    stopper.join(5)
    assert stopped == [True]
    assert [item.status for item in _items(task_store, batch_id)] == [
        "complete",
        "queued",
    ]

    resumed = TaskWorker(
        task_store,
        EventBus(),
        max_concurrency=1,
        poll_interval_seconds=0.01,
    )
    resumed.register("test.echo", lambda _context: {"resumed": True})
    resumed.start()
    try:
        assert _wait_for_batch(task_store, batch_id).status == "complete"
    finally:
        assert resumed.stop(timeout=5)


def test_retry_reuses_settlement_key_and_does_not_duplicate_completion(task_store):
    billing_job_id, billing_child_id = _add_billing_parent_and_child(task_store)
    request = _request(
        key="retry",
        items=[
            {
                "idempotency_key": "retry-item",
                "input": {},
                "max_attempts": 2,
                "billing_job_id": billing_child_id,
            }
        ],
    )
    request.billing_job_id = billing_job_id
    batch_id, _ = _submit(
        task_store,
        request,
    )
    attempts = 0
    settlement_keys: list[str] = []

    def execute(context: TaskExecutionContext):
        nonlocal attempts
        attempts += 1
        settlement_keys.append(context.settlement_key)
        if attempts == 1:
            raise RetryableTaskError(retry_delay_seconds=0)
        return {"attempt": attempts}

    worker = TaskWorker(
        task_store,
        EventBus(),
        max_concurrency=1,
        poll_interval_seconds=0.01,
        retry_base_seconds=0,
    )
    worker.register("test.echo", execute)
    worker.start()
    try:
        batch = _wait_for_batch(task_store, batch_id)
    finally:
        assert worker.stop(timeout=5)

    item = _items(task_store, batch_id)[0]
    assert batch.status == "complete"
    assert item.attempt_count == 2
    assert item.result_snapshot == {"attempt": 2}
    assert item.billing_job_id == billing_child_id
    assert len(set(settlement_keys)) == 1
    with task_store() as db:
        billing_job = db.get(GenerationJob, billing_child_id)
        assert billing_job is not None and billing_job.status == "reserved"
        assert db.scalar(select(CostReceipt)) is None


def test_awaiting_payment_requires_owned_chargeable_job_and_can_resume(task_store):
    billing_job_id, billing_child_id = _add_billing_parent_and_child(task_store)
    request = _request(
        key="awaiting-payment",
        items=[
            {
                "idempotency_key": "payment-item",
                "input": {},
                "billing_job_id": billing_child_id,
            }
        ],
    )
    request.billing_job_id = billing_job_id
    batch_id, _ = _submit(task_store, request)
    calls = 0

    def execute(_context: TaskExecutionContext):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise TaskAwaitingPayment(billing_child_id)
        return {"resumed": True}

    worker = TaskWorker(
        task_store,
        EventBus(),
        max_concurrency=1,
        poll_interval_seconds=0.01,
    )
    worker.register("test.echo", execute)
    worker.start()
    try:
        assert _wait_for_batch(
            task_store, batch_id, statuses={"awaiting_payment"}
        ).status == "awaiting_payment"
        item = _items(task_store, batch_id)[0]
        assert item.status == "awaiting_payment"
        with task_store() as db:
            billing_job = db.get(GenerationJob, billing_child_id)
            assert billing_job is not None
            billing_job.status = "payment_required_quote"
            db.commit()
            TaskService(db).retry_owned_item(
                batch_id=batch_id,
                item_id=item.id,
                owner_user_id=ALICE.id,
                project_id=PROJECT_ID,
            )
        worker.notify()
        assert _wait_for_batch(task_store, batch_id).status == "complete"
    finally:
        assert worker.stop(timeout=5)

    item = _items(task_store, batch_id)[0]
    assert item.attempt_count == 2
    assert item.result_snapshot == {"resumed": True}


def test_waiting_provider_binds_job_without_spending_attempts_and_resumes(
    task_store,
):
    billing_job_id = "d" * 32
    batch_id, _ = _submit(
        task_store,
        _request(
            key="waiting-provider",
            task_type="shot_video.generate",
            items=[
                {
                    "idempotency_key": "shot-one",
                    "input": {},
                    "model": "video-model",
                    "target_entity_type": "shot_video",
                    "target_entity_id": "shot-1",
                    "target_entity_version": 1,
                    "max_attempts": 3,
                },
                {
                    "idempotency_key": "shot-two",
                    "input": {},
                    "model": "video-model",
                    "target_entity_type": "shot_video",
                    "target_entity_id": "shot-2",
                    "target_entity_version": 1,
                    "depends_on": ["shot-one"],
                    "max_attempts": 3,
                },
            ],
        ),
    )
    calls: list[tuple[str | None, str | None]] = []

    def execute(context: TaskExecutionContext):
        calls.append((context.target_entity_id, context.billing_job_id))
        if context.target_entity_id == "shot-1" and context.billing_job_id is None:
            _add_video_billing_job(
                task_store,
                job_id=billing_job_id,
                shot_id="shot-1",
            )
            raise TaskWaitingProvider(billing_job_id, poll_delay_seconds=30)
        return {
            "billing_job_id": context.billing_job_id,
            "shot_id": context.target_entity_id,
        }

    worker = TaskWorker(
        task_store,
        EventBus(),
        max_concurrency=1,
        poll_interval_seconds=0.01,
    )
    worker.register(
        "shot_video.generate",
        execute,
        publish=lambda *_args: PublishOutcome.PUBLISHED,
    )
    worker.start()
    try:
        assert _wait_for_batch(
            task_store, batch_id, statuses={"waiting_provider"}
        ).status == "waiting_provider"
        upstream, downstream = _items(task_store, batch_id)
        assert upstream.status == "waiting_provider"
        assert upstream.billing_job_id == billing_job_id
        assert upstream.retryable is False
        assert upstream.error_code is None
        assert upstream.error_message is None
        assert upstream.progress >= 5
        assert upstream.attempt_count == 1
        assert downstream.status == "waiting_dependency"
        assert downstream.attempt_count == 0

        with task_store() as db:
            service = TaskService(db)
            for index in range(12):
                assert service.record_provider_poll(
                    billing_job_id,
                    next_poll_at=datetime.now(timezone.utc)
                    + timedelta(seconds=index + 1),
                ) == 1
            polled = db.get(TaskItem, upstream.id)
            assert polled is not None
            assert polled.provider_poll_count == 12
            assert polled.attempt_count == 1
            assert service.resume_provider_result(billing_job_id) == 1
            resumed = db.get(TaskItem, upstream.id)
            assert resumed is not None
            assert resumed.status == "queued"
            assert resumed.attempt_count == 0

        worker.notify()
        assert _wait_for_batch(task_store, batch_id).status == "complete"
    finally:
        assert worker.stop(timeout=5)

    upstream, downstream = _items(task_store, batch_id)
    assert upstream.attempt_count == 1
    assert downstream.attempt_count == 1
    assert upstream.result_snapshot == {
        "billing_job_id": billing_job_id,
        "shot_id": "shot-1",
    }
    assert calls == [
        ("shot-1", None),
        ("shot-1", billing_job_id),
        ("shot-2", None),
    ]


def test_video_billing_job_binding_validates_identity_and_route(task_store):
    other_project_id = "2" * 32
    with task_store() as db:
        db.add(
            ProjectRecord(
                id=other_project_id,
                owner_user_id=ALICE.id,
                title="Other project",
                mode="general_video",
                project_type="single_video",
            )
        )
        db.commit()

    invalid_jobs = [
        ("01" * 16, {"owner_user_id": BOB.id}),
        ("02" * 16, {"project_id": other_project_id}),
        ("03" * 16, {"model": "other-model"}),
        ("04" * 16, {"operation": "shot:other-shot"}),
        ("05" * 16, {"provider_method": "GET"}),
        ("06" * 16, {"provider_route": "/v1/chat/completions"}),
    ]
    for index, (job_id, overrides) in enumerate(invalid_jobs):
        _add_video_billing_job(
            task_store,
            job_id=job_id,
            shot_id="shot-1",
            **overrides,
        )
        batch_id, _ = _submit(
            task_store,
            _request(
                key=f"invalid-video-job-{index}",
                task_type="shot_video.generate",
                items=[
                    {
                        "idempotency_key": "shot",
                        "input": {},
                        "model": "video-model",
                        "target_entity_type": "shot_video",
                        "target_entity_id": "shot-1",
                        "target_entity_version": 1,
                    }
                ],
            ),
        )
        with task_store() as db:
            service = TaskService(db)
            claim = service.claim_next(
                worker_id=f"invalid-worker-{index}",
                supported_task_types={"shot_video.generate"},
                lease_seconds=30,
            )
            assert claim is not None and claim.batch_id == batch_id
            with pytest.raises(TaskStateError) as error:
                service.bind_claim_billing_job(
                    claim.item_id,
                    claim.claimed_by,
                    claim.attempt_count,
                    job_id,
                )
            assert error.value.code == "task_billing_job_invalid"


def test_video_billing_job_cannot_be_claimed_by_two_task_items(task_store):
    billing_job_id = _add_video_billing_job(
        task_store,
        job_id="e" * 32,
        shot_id="shared-shot",
    )
    batch_id, _ = _submit(
        task_store,
        _request(
            key="duplicate-video-job-claim",
            task_type="shot_video.generate",
            items=[
                {
                    "idempotency_key": "first",
                    "input": {},
                    "model": "video-model",
                    "target_entity_type": "shot_video",
                    "target_entity_id": "shared-shot",
                    "target_entity_version": 1,
                },
                {
                    "idempotency_key": "second",
                    "input": {},
                    "model": "video-model",
                    "target_entity_type": "shot_video",
                    "target_entity_id": "shared-shot",
                    "target_entity_version": 1,
                },
            ],
        ),
    )
    with task_store() as db:
        service = TaskService(db)
        first = service.claim_next(
            worker_id="first-worker",
            supported_task_types={"shot_video.generate"},
            lease_seconds=30,
        )
        assert first is not None and first.batch_id == batch_id
        assert service.bind_claim_billing_job(
            first.item_id,
            first.claimed_by,
            first.attempt_count,
            billing_job_id,
        )
        second = service.claim_next(
            worker_id="second-worker",
            supported_task_types={"shot_video.generate"},
            lease_seconds=30,
        )
        assert second is not None and second.batch_id == batch_id
        with pytest.raises(TaskStateError) as error:
            service.bind_claim_billing_job(
                second.item_id,
                second.claimed_by,
                second.attempt_count,
                billing_job_id,
            )
        assert error.value.code == "task_billing_job_claimed"


def test_version_guard_prevents_stale_result_publication(task_store):
    batch_id, _ = _submit(
        task_store,
        _request(
            key="stale-version",
            items=[
                {
                    "idempotency_key": "versioned",
                    "input": {"generated": "old"},
                    "target_entity_type": "shot",
                    "target_entity_id": "shot-1",
                    "target_entity_version": 1,
                    "max_attempts": 1,
                }
            ],
        ),
    )
    entity = {"version": 2, "value": "new"}

    def publish(
        _context: TaskExecutionContext, result: dict, expected_version: int
    ) -> PublishOutcome:
        if entity["version"] != expected_version:
            return PublishOutcome.STALE
        entity["value"] = result["generated"]
        return PublishOutcome.PUBLISHED

    worker = TaskWorker(
        task_store,
        EventBus(),
        max_concurrency=1,
        poll_interval_seconds=0.01,
    )
    worker.register(
        "test.echo",
        lambda context: context.input_snapshot,
        publish=publish,
    )
    worker.start()
    try:
        batch = _wait_for_batch(task_store, batch_id)
    finally:
        assert worker.stop(timeout=5)

    item = _items(task_store, batch_id)[0]
    assert batch.status == "failed"
    assert item.error_code == "stale_entity_version"
    assert item.result_snapshot == {"generated": "old"}
    assert entity == {"version": 2, "value": "new"}


def test_task_api_202_queries_retry_ownership_and_sse_contract(task_store, tmp_path):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )

    def database_dependency():
        with task_store() as db:
            yield db

    current = {"user": ALICE}
    app.dependency_overrides[get_db] = database_dependency
    app.dependency_overrides[require_user] = lambda: current["user"]
    app.dependency_overrides[require_csrf] = lambda: current["user"]
    app.state.task_session_factory = task_store

    should_fail = {"value": True}

    def execute(context: TaskExecutionContext):
        if should_fail["value"]:
            raise RetryableTaskError(retry_delay_seconds=60)
        return {"echo": context.input_snapshot}

    app.state.task_worker.register(
        "test.echo",
        execute,
        client_input_validator=lambda _item: None,
    )
    app.state.task_worker.register("test.internal", lambda _context: {"ok": True})
    payload = _request(
        key="api-contract",
        items=[
            {
                "idempotency_key": "api-item",
                "input": {"value": "hello"},
                "max_attempts": 1,
            }
        ],
    ).model_dump(mode="json")

    with TestClient(app) as client:
        submitted = client.post(f"/api/projects/{PROJECT_ID}/tasks", json=payload)
        assert submitted.status_code == 202, submitted.text
        body = submitted.json()
        task_id = body["task_id"]
        item_id = body["task"]["items"][0]["id"]
        settlement_key = body["task"]["items"][0]["settlement_key"]

        duplicate = client.post(f"/api/projects/{PROJECT_ID}/tasks", json=payload)
        assert duplicate.status_code == 202
        assert duplicate.json()["task_id"] == task_id
        assert duplicate.json()["deduplicated"] is True

        internal_payload = _request(key="internal", task_type="test.internal").model_dump(
            mode="json"
        )
        internal = client.post(
            f"/api/projects/{PROJECT_ID}/tasks", json=internal_payload
        )
        assert internal.status_code == 422
        assert internal.json()["detail"]["code"] == "task_type_not_client_submittable"

        _wait_for_batch(task_store, task_id, statuses={"failed"})
        should_fail["value"] = False
        retry = client.post(
            f"/api/projects/{PROJECT_ID}/tasks/{task_id}/items/{item_id}/retry"
        )
        assert retry.status_code == 202, retry.text
        completed = _wait_for_batch(task_store, task_id, statuses={"complete"})
        assert completed.status == "complete"

        listing = client.get(f"/api/projects/{PROJECT_ID}/tasks")
        detail = client.get(f"/api/projects/{PROJECT_ID}/tasks/{task_id}")
        assert listing.status_code == detail.status_code == 200
        assert listing.json()["tasks"][0]["id"] == task_id
        assert detail.json()["items"][0]["settlement_key"] == settlement_key
        assert detail.json()["items"][0]["attempt_count"] == 2

        task_events = [
            event
            for event in app.state.events.history(PROJECT_ID)
            if event.get("task_id") == task_id
        ]
        assert {event["event_type"] for event in task_events} == {
            "task",
            "task_item",
        }
        assert any(event["status"] == "complete" for event in task_events)
        assert all("progress" in event for event in task_events)
        assert all(
            _format_sse(event).startswith("event: job\ndata: ") for event in task_events
        )

        current["user"] = BOB
        assert client.get(f"/api/projects/{PROJECT_ID}/tasks").status_code == 404
        assert (
            client.get(f"/api/projects/{PROJECT_ID}/tasks/{task_id}").status_code == 404
        )
