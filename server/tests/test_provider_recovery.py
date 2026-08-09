from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker

from server.app.auth.models import User
from server.app.billing.models import BillingReconciliation, GenerationJob
from server.app.billing.reconciliation import resume_reconcile_publish_job
from server.app.db.base import Base
from server.app.projects.models import ProjectRecord
from server.app.storage import WorkbenchStore
from server.app.tasks.models import TaskBatch, TaskDependency, TaskItem
from server.app.tasks.recovery import recover_provider_waits
from server.manage import run_manage


OWNER_ID = "a" * 32
PROJECT_ID = "bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb"


@pytest.fixture
def recovery_context(tmp_path):
    database = tmp_path / "provider-recovery.db"
    engine = create_engine(f"sqlite+pysqlite:///{database.as_posix()}")
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
                    id=OWNER_ID,
                    email="provider-recovery@example.com",
                    password_hash="hash",
                    role="user",
                    status="active",
                ),
                ProjectRecord(
                    id=PROJECT_ID,
                    owner_user_id=OWNER_ID,
                    title="Provider recovery",
                    mode="general_video",
                    project_type="single_video",
                ),
            ]
        )
        db.commit()
    store = WorkbenchStore(projects_root=tmp_path / "projects")
    try:
        yield factory, store
    finally:
        engine.dispose()


def _job(
    job_id: str,
    *,
    status: str = "result_pending",
    shot_id: str = "s01",
    result_visible: bool = False,
    provider_reference_id: str | None = "provider-task-1",
) -> GenerationJob:
    return GenerationJob(
        id=job_id,
        parent_job_id=None,
        chargeable=True,
        user_id=OWNER_ID,
        project_id=PROJECT_ID,
        operation=f"shot:{shot_id}",
        capability="video",
        token_kind="video",
        token_alias=f"video-{job_id[:8]}",
        model="video-model",
        multiplier_bps=10_000,
        provider_method="POST",
        provider_route="/v1/videos",
        provider_reference_type=(
            "task" if provider_reference_id is not None else None
        ),
        provider_reference_id=provider_reference_id,
        reference_deadline=datetime.now(timezone.utc) + timedelta(hours=1),
        receipt_deadline=datetime.now(timezone.utc) + timedelta(hours=1),
        status=status,
        result_locator=("hidden:video" if result_visible else None),
        result_sha256=("c" * 64 if result_visible else None),
        result_staged=result_visible,
        result_visible=result_visible,
        quote_id=f"quote-{job_id}",
        quote_expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
        quote_estimated_quota=1,
        quote_estimated_provider_cost_micro=1,
        quote_quota_per_unit=Decimal("1"),
        quote_pricing_version="test-v1",
        quote_other_ratios_json="{}",
        quote_billing_fingerprint=f"fingerprint-{job_id}",
    )


def _batch(batch_id: str, *, total_items: int = 1) -> TaskBatch:
    return TaskBatch(
        id=batch_id,
        owner_user_id=OWNER_ID,
        project_id=PROJECT_ID,
        task_type="shot_video.generate",
        status="waiting_provider",
        idempotency_key=f"batch-{batch_id}",
        request_hash="d" * 64,
        snapshot_version=1,
        project_version=1,
        request_snapshot={},
        progress=5,
        total_items=total_items,
        completed_items=0,
        failed_items=0,
    )


def _item(
    item_id: str,
    batch_id: str,
    job_id: str,
    *,
    status: str = "waiting_provider",
    error_code: str | None = None,
    position: int = 0,
    shot_id: str = "s01",
    billing_job_id: str | None = None,
) -> TaskItem:
    return TaskItem(
        id=item_id,
        batch_id=batch_id,
        position=position,
        task_type="shot_video.generate",
        status=status,
        idempotency_key=f"item-{item_id}",
        snapshot_version=1,
        project_version=1,
        input_snapshot={},
        reference_snapshot=[],
        model="video-model",
        target_entity_type="shot_video",
        target_entity_id=shot_id,
        target_entity_version=1,
        attempt_count=4,
        max_attempts=9,
        progress=5,
        retryable=status != "waiting_provider",
        error_code=error_code,
        error_message="legacy failure" if error_code else None,
        billing_job_id=billing_job_id,
        settlement_key=job_id,
        generation_revision=0,
        provider_poll_count=0,
    )


def _seed_reconciliation(db, job: GenerationJob, item: TaskItem, batch: TaskBatch):
    db.add_all([job, batch])
    db.commit()
    db.add(item)
    db.commit()
    db.add(
        BillingReconciliation(
            id=f"r{job.id[1:]}",
            job_id=job.id,
            reason="provider_completion",
            status="open",
            attempts=0,
        )
    )
    db.commit()


def test_pending_reconciliation_records_poll_without_consuming_attempt(
    recovery_context, monkeypatch
):
    factory, store = recovery_context
    job_id = "1" * 32
    batch_id = "2" * 32
    item_id = "3" * 32
    with factory() as db:
        _seed_reconciliation(
            db,
            _job(job_id),
            _item(item_id, batch_id, job_id, billing_job_id=job_id),
            _batch(batch_id),
        )
        monkeypatch.setattr(
            "server.app.billing.reconciliation.reconcile_job_now",
            lambda *_args, **_kwargs: "pending",
        )

        outcome = resume_reconcile_publish_job(
            db,
            object(),
            job_id,
            datetime.now(timezone.utc),
            media_store=store,
            pending_delay_seconds=7,
        )

        item = db.get(TaskItem, item_id)
        assert outcome == "pending"
        assert item.status == "waiting_provider"
        assert item.attempt_count == 4
        assert item.provider_poll_count == 1
        assert item.provider_next_poll_at is not None


@pytest.mark.parametrize(
    ("job_status", "result_visible", "expected_status", "expected_error"),
    [
        ("billed", True, "queued", None),
        (
            "provider_rejected_no_charge",
            False,
            "failed",
            "provider_rejected_no_charge",
        ),
    ],
)
def test_completed_reconciliation_resumes_or_fails_provider_wait(
    recovery_context,
    monkeypatch,
    job_status,
    result_visible,
    expected_status,
    expected_error,
):
    factory, store = recovery_context
    job_id = "4" * 32
    batch_id = "5" * 32
    item_id = "6" * 32
    with factory() as db:
        _seed_reconciliation(
            db,
            _job(job_id, status=job_status, result_visible=result_visible),
            _item(item_id, batch_id, job_id, billing_job_id=job_id),
            _batch(batch_id),
        )
        monkeypatch.setattr(
            "server.app.billing.reconciliation.reconcile_job_now",
            lambda *_args, **_kwargs: "completed",
        )
        monkeypatch.setattr(
            "server.app.billing.reconciliation.reduce_video_parent_for_child",
            lambda *_args, **_kwargs: None,
        )

        resume_reconcile_publish_job(
            db,
            object(),
            job_id,
            datetime.now(timezone.utc),
            media_store=store,
        )

        item = db.get(TaskItem, item_id)
        assert item.status == expected_status
        assert item.error_code == expected_error


def test_legacy_provider_pending_recovery_matches_intent_and_restores_dependency(
    recovery_context,
):
    factory, store = recovery_context
    job_id = "7" * 32
    duplicate_id = "8" * 32
    batch_id = "9" * 32
    root_id = job_id
    child_id = "a" * 31 + "2"
    with factory() as db:
        root = _item(
            root_id,
            batch_id,
            job_id,
            status="failed",
            error_code="provider_result_pending",
        )
        root.settlement_key = f"task:{root_id}"
        root.attempt_count = root.max_attempts
        child = _item(
            child_id,
            batch_id,
            "f" * 32,
            status="failed",
            error_code="dependency_failed",
            position=1,
            shot_id="s02",
        )
        db.add_all(
            [
                _job(job_id),
                _job(
                    duplicate_id,
                    provider_reference_id="provider-task-duplicate",
                ),
                _batch(batch_id, total_items=2),
            ]
        )
        db.commit()
        db.add_all([root, child])
        db.commit()
        db.add(
            TaskDependency(
                batch_id=batch_id,
                task_item_id=child_id,
                depends_on_item_id=root_id,
                failure_policy="fail",
            )
        )
        db.commit()
        store.record_video_generation_intent(
            project_id=PROJECT_ID,
            job_id=job_id,
            shot_id="s01",
            shot_version=1,
        )
        store.record_video_generation_intent(
            project_id=PROJECT_ID,
            job_id=duplicate_id,
            shot_id="s01",
            shot_version=1,
        )

        report = recover_provider_waits(db, store)

        recovered_root = db.get(TaskItem, root_id)
        recovered_child = db.get(TaskItem, child_id)
        assert recovered_root.billing_job_id == job_id
        assert recovered_root.status == "waiting_provider"
        assert recovered_root.attempt_count == recovered_root.max_attempts - 1
        assert recovered_child.status == "waiting_dependency"
        assert report["reused_jobs"] == 1
        assert report["still_waiting"] == 1
        assert report["restored_dependencies"] == 1
        assert report["duplicate_jobs"] == 1
        assert report["manual_audit"][0]["duplicate_billing_job_ids"] == [
            duplicate_id
        ]


def test_recovery_adopts_accepted_legacy_running_item(recovery_context):
    factory, store = recovery_context
    job_id = "b" * 32
    batch_id = "c" * 32
    with factory() as db:
        item = _item(job_id, batch_id, job_id, status="running")
        item.settlement_key = f"task:{job_id}"
        item.claimed_by = "legacy-worker"
        item.lease_expires_at = datetime.now(timezone.utc) + timedelta(minutes=5)
        db.add_all([_job(job_id, status="receipt_pending"), _batch(batch_id)])
        db.commit()
        db.add(item)
        db.commit()
        store.record_video_generation_intent(
            project_id=PROJECT_ID,
            job_id=job_id,
            shot_id="s01",
            shot_version=1,
        )

        report = recover_provider_waits(db, store)

        recovered = db.get(TaskItem, job_id)
        assert report["scanned_items"] == 1
        assert report["reused_jobs"] == 1
        assert recovered.status == "waiting_provider"
        assert recovered.billing_job_id == job_id
        assert recovered.claimed_by is None
        assert recovered.lease_expires_at is None


def test_recovery_dry_run_reports_mismatch_without_writing(recovery_context):
    factory, store = recovery_context
    job_id = "c" * 32
    batch_id = "d" * 32
    item_id = "e" * 32
    with factory() as db:
        item = _item(
            item_id,
            batch_id,
            job_id,
            status="failed",
            error_code="provider_result_pending",
        )
        db.add_all([_job(job_id, shot_id="other"), _batch(batch_id)])
        db.commit()
        db.add(item)
        db.commit()
        store.record_video_generation_intent(
            project_id=PROJECT_ID,
            job_id=job_id,
            shot_id="other",
            shot_version=1,
        )

        report = recover_provider_waits(db, store, dry_run=True)

        persisted = db.scalar(select(TaskItem).where(TaskItem.id == item_id))
        assert report["reused_jobs"] == 0
        assert report["unresolved"] == [
            {"task_item_id": item_id, "reason": "billing_job_mismatch"}
        ]
        assert persisted.billing_job_id is None
        assert persisted.status == "failed"


def test_recovery_management_command_outputs_structured_report(
    recovery_context, capsys
):
    factory, store = recovery_context
    job_id = "1a" * 16
    batch_id = "2a" * 16
    item_id = "3a" * 16
    with factory() as db:
        db.add_all([_job(job_id), _batch(batch_id)])
        db.commit()
        db.add(
            _item(
                item_id,
                batch_id,
                job_id,
                status="failed",
                error_code="provider_result_pending",
            )
        )
        db.commit()
        store.record_video_generation_intent(
            project_id=PROJECT_ID,
            job_id=job_id,
            shot_id="s01",
            shot_version=1,
        )

        code = run_manage(
            ["recover-provider-waits", "--project-id", PROJECT_ID],
            db_session=db,
            media_store=store,
        )

        report = json.loads(capsys.readouterr().out)
        assert code == 0
        assert report["reused_jobs"] == 1
        assert report["still_waiting"] == 1
        assert report["unresolved"] == []
