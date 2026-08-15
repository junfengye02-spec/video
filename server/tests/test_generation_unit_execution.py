from __future__ import annotations

import hashlib
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import func, select

from server.app.billing.models import BillingReconciliation, GenerationJob
from server.app.billing.reconciliation import resume_reconcile_publish_job
from server.app.core.config import get_settings
from server.app.continuity_frames import TailFrameExtraction
from server.app.generation_units.models import VideoGenerationUnit
from server.app.generation_units.prompt import (
    compile_generation_unit_prompt,
    generation_unit_prompt_contract,
)
from server.app.generation_units.service import execution_key
from server.app.provider.newapi import UsageReceipt, VideoTaskStatus
from server.app.tasks.models import TaskDependency, TaskItem
from server.tests.test_api import _wait_project_task
from server.tests.test_generation_units import _project, _v2_app


def test_prompt_contract_preserves_every_ordered_beat_and_shared_lock():
    unit = {
        "id": "unit-a",
        "revision": 2,
        "source_shot_ids": ["s1", "s2"],
        "prompt_segments": [
            {
                "shot_id": "s1",
                "beat_id": "b1",
                "prompt": "Lin raises the sealed letter.",
                "transition": "continuous",
            },
            {
                "shot_id": "s2",
                "beat_id": "b2",
                "prompt": "Chen reaches for it as Lin pulls away.",
                "transition": "match_cut",
            },
        ],
    }
    shots = [
        {
            "id": "s1",
            "characters": ["lin"],
            "asset_ids": ["letter"],
            "scene_id": "alley",
            "location": "rainy alley",
            "props": ["sealed letter"],
            "must_complete_action": True,
            "shot_language": {"shot_size": "close_up"},
        },
        {
            "id": "s2",
            "characters": ["lin", "chen"],
            "asset_ids": ["letter"],
            "scene_id": "alley",
            "location": "rainy alley",
            "props": ["sealed letter"],
            "must_preserve_emotion": True,
            "shot_language": {"camera_movement": "tracking_right"},
        },
    ]
    bible = {
        "style_lock": "rainy neon realism",
        "characters": [
            {"id": "lin", "name": "Lin", "visual_lock": "red coat"},
            {"id": "chen", "name": "Chen", "visual_lock": "silver glasses"},
        ],
        "assets": [
            {"id": "letter", "label": "sealed letter", "kind": "prop"}
        ],
    }

    contract = generation_unit_prompt_contract(unit, shots, series_bible=bible)
    prompt = compile_generation_unit_prompt(unit, shots, series_bible=bible)

    assert contract["source_shot_ids"] == ["s1", "s2"]
    assert contract["source_beat_ids"] == ["b1", "b2"]
    assert [segment["prompt"] for segment in contract["segments"]] == [
        "Lin raises the sealed letter.",
        "Chen reaches for it as Lin pulls away.",
    ]
    assert contract["shared_locks"]["style"] == "rainy neon realism"
    assert [item["id"] for item in contract["shared_locks"]["characters"]] == [
        "lin",
        "chen",
    ]
    assert prompt.index("Lin raises the sealed letter.") < prompt.index(
        "Chen reaches for it as Lin pulls away."
    )
    assert "complete this beat's action" in prompt
    assert "preserve the emotional state" in prompt
    assert "motivated match cut" in prompt
    assert "observable physical action in chronological order" in prompt
    assert "do not add subjects or props" in prompt


def _six_mergeable_shots(app, project_id: str, storyboard: dict) -> dict:
    shots = [deepcopy(shot) for shot in storyboard["shots"]]
    while len(shots) < 6:
        shots.append(deepcopy(shots[len(shots) % 2]))
    for index, shot in enumerate(shots[:6], start=1):
        shot["id"] = f"s{index}"
        shot["index"] = index
        shot["beat_id"] = f"beat-{index}"
        shot["beat"] = f"Beat {index}"
        shot["prompt"] = f"Frozen prompt segment {index}."
        shot["scene_id"] = "shared-scene"
        shot["location"] = "shared location"
        shot["recommended_duration_seconds"] = 5
        shot["duration_range_seconds"] = [4, 6]
        shot["can_merge_with_next"] = index < 6
        shot["must_complete_action"] = False
        shot["must_preserve_emotion"] = False
        shot["continuity"] = {
            "mode": "cut",
            "inherit_previous_tail": False,
        }
    storyboard["shots"] = shots[:6]
    app.state.store.write_artifact(
        project_id, "episode_storyboard.json", storyboard
    )
    workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
    workflow["brief"] = {**workflow["brief"], "duration_seconds": 30}
    app.state.store.write_artifact(
        project_id, "creative_workflow.json", workflow
    )
    return storyboard


def _fake_tail_extractor(**kwargs) -> TailFrameExtraction:
    source = kwargs["video_path"]
    output_dir = kwargs["output_dir"]
    shot_id = kwargs["shot_id"]
    revision = kwargs["video_version"]
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / f"v{revision}-tail.png"
    Image.new("RGB", (16, 16), (50, 90, 130)).save(path)
    metadata_path = output_dir / f"v{revision}-tail.json"
    metadata_path.write_text("{}", encoding="utf-8")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    return TailFrameExtraction(
        path=path,
        metadata_path=metadata_path,
        status="ready",
        shot_id=shot_id,
        video_version=revision,
        video_sha256=digest,
        sample_time_seconds=9.9,
        duration_seconds=10.0,
        fps=30.0,
        width=720,
        height=1280,
        backtrack_frames=1,
        reused=False,
    )


def test_generation_unit_revision_publish_is_immutable(tmp_path):
    app = _v2_app(tmp_path)
    project_id = "11111111111141118111111111111111"
    destination = (
        app.state.store.project_dir(project_id)
        / "assets"
        / "video"
        / "units"
        / "unit-a"
        / "v1.mp4"
    )

    first_content = b"first revision media"
    with app.state.store.hidden_video_destination(
        project_id,
        "generation_unit:unit-a:v1",
        artifact_id="a" * 32,
    ) as staged:
        staged.temporary_path.write_bytes(first_content)
        first = staged.commit(
            sha256=hashlib.sha256(first_content).hexdigest(),
            source_reference="provider-task-a",
        )
    app.state.store.publish_staged_video(
        first.locator,
        destination,
        replace_existing=False,
    )

    conflicting_content = b"conflicting retry media"
    with app.state.store.hidden_video_destination(
        project_id,
        "generation_unit:unit-a:v1",
        artifact_id="b" * 32,
    ) as staged:
        staged.temporary_path.write_bytes(conflicting_content)
        conflicting = staged.commit(
            sha256=hashlib.sha256(conflicting_content).hexdigest(),
            source_reference="provider-task-b",
        )

    with pytest.raises(
        ValueError,
        match="Published video revision conflicts with existing media",
    ):
        app.state.store.publish_staged_video(
            conflicting.locator,
            destination,
            replace_existing=False,
        )

    assert destination.read_bytes() == first_content
    assert not list(destination.parent.glob(f".{destination.name}.*.publish"))


def test_six_shots_execute_as_three_units_with_one_job_request_and_asset_each(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        "server.app.provider.video_recovery.probe_output",
        lambda path: {
            "file_size_bytes": path.stat().st_size,
            "video_width": 720,
            "video_height": 1280,
        },
    )
    monkeypatch.setattr(
        "server.app.generation_units.publication.extract_tail_frame",
        _fake_tail_extractor,
    )
    app = _v2_app(tmp_path)
    app.state.task_worker.max_concurrency = 1
    app.state.task_worker.retry_base_seconds = 0.01
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client, mergeable=True)
        storyboard = _six_mergeable_shots(app, project_id, storyboard)
        before_jobs = app.state.test_db.scalar(select(func.count(GenerationJob.id)))
        preview = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "video_model": "omni_flash-10s",
                "operation": "text_to_video",
                "shot_ids": [shot["id"] for shot in storyboard["shots"]],
            },
        )
        assert preview.status_code == 200, preview.text
        plan = preview.json()
        assert [len(unit["source_shot_ids"]) for unit in plan["generation_units"]] == [
            2,
            2,
            2,
        ]
        unit_ids = [unit["id"] for unit in plan["generation_units"]]

        submitted = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": plan["id"],
                "generation_unit_ids": unit_ids,
                "idempotency_key": "six-shots-three-units",
            },
        )
        assert submitted.status_code == 202, submitted.text
        try:
            completed = _wait_project_task(
                client, project_id, submitted.json()["task_id"], {"complete"}
            )
        except AssertionError as exc:
            current = client.get(
                f"/api/projects/{project_id}/tasks/{submitted.json()['task_id']}"
            ).json()
            raise AssertionError(
                [
                    (
                        item["target_entity_id"],
                        item["status"],
                        item["error_code"],
                        item["error_message"],
                    )
                    for item in current["items"]
                ]
            ) from exc

        assert len(completed["items"]) == 3
        assert len(
            [call for call in app.state.fake_newapi.execute_calls if call[0] == "video"]
        ) == 3
        assert (
            app.state.test_db.scalar(select(func.count(GenerationJob.id)))
            - before_jobs
            == 3
        )
        records = list(
            app.state.test_db.scalars(
                select(VideoGenerationUnit)
                .where(VideoGenerationUnit.project_id == project_id)
                .order_by(VideoGenerationUnit.created_at, VideoGenerationUnit.id)
            )
        )
        assert len(records) == 3
        assert all(record.status == "complete" and record.active for record in records)
        assert all(record.output_path and record.output_asset_id for record in records)
        assert all(
            (app.state.store.project_dir(project_id) / record.output_path).is_file()
            for record in records
        )

        items = list(
            app.state.test_db.scalars(
                select(TaskItem)
                .where(TaskItem.batch_id == submitted.json()["task_id"])
                .order_by(TaskItem.created_at, TaskItem.id)
            )
        )
        item_by_unit = {str(item.target_entity_id): item for item in items}
        dependencies = list(
            app.state.test_db.scalars(
                select(TaskDependency).where(
                    TaskDependency.batch_id == submitted.json()["task_id"]
                )
            )
        )
        assert {
            (dependency.depends_on_item_id, dependency.task_item_id)
            for dependency in dependencies
        } == {
            (item_by_unit[unit_ids[index - 1]].id, item_by_unit[unit_ids[index]].id)
            for index in range(1, len(unit_ids))
        }
        assert item_by_unit[unit_ids[0]].input_snapshot["dependency"] is None
        for index in range(1, len(unit_ids)):
            assert item_by_unit[unit_ids[index]].input_snapshot["dependency"] == {
                "previous_generation_unit_id": unit_ids[index - 1],
                "previous_generation_unit_revision": 1,
                "inherit_previous_tail": False,
            }
        jobs = {
            job.id: job
            for job in app.state.test_db.scalars(
                select(GenerationJob).where(
                    GenerationJob.id.in_([item.billing_job_id for item in items])
                )
            )
        }
        records_by_id = {record.id: record for record in records}
        for item in items:
            record = records_by_id[str(item.target_entity_id)]
            expected_key = execution_key(
                project_id,
                record.id,
                record.revision,
                model_id=record.model_id,
                operation=record.operation,
            )
            assert item.generation_key == expected_key
            assert item.settlement_key == expected_key[:32]
            assert item.billing_job_id == item.settlement_key
            assert jobs[item.billing_job_id].operation == (
                f"generation_unit:{record.id}:v{record.revision}"
            )
            prompts = [
                shot["prompt"] for shot in item.input_snapshot["source_shots"]
            ]
            assert all(prompt in item.input_snapshot["compiled_prompt"] for prompt in prompts)

        manifest = app.state.store.read_artifact(project_id, "asset_manifest.json")
        unit_assets = [
            asset
            for asset in manifest["assets"]
            if isinstance(asset.get("metadata"), dict)
            and asset["metadata"].get("generation_unit_id")
            and asset["metadata"].get("active") is True
        ]
        assert len(unit_assets) == 3
        assert [len(asset["metadata"]["source_shot_ids"]) for asset in unit_assets] == [
            2,
            2,
            2,
        ]

        repeated = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": plan["id"],
                "generation_unit_ids": unit_ids,
                "idempotency_key": "six-shots-three-units",
            },
        )
        assert repeated.status_code == 202
        assert repeated.json()["deduplicated"] is True
        assert len(
            [call for call in app.state.fake_newapi.execute_calls if call[0] == "video"]
        ) == 3


def test_failed_replacement_keeps_old_active_and_retry_reuses_billed_job(
    tmp_path, monkeypatch
):
    from server.app import main as main_module

    failing_revisions: set[int] = set()
    original_request = main_module._generation_unit_task_request

    def one_attempt_request(**kwargs):
        request = original_request(**kwargs)
        return request.model_copy(
            update={
                "items": [
                    item.model_copy(update={"max_attempts": 1})
                    for item in request.items
                ]
            }
        )

    def extract(**kwargs):
        if kwargs["video_version"] in failing_revisions:
            raise ValueError("synthetic tail extraction failure")
        return _fake_tail_extractor(**kwargs)

    monkeypatch.setattr(
        "server.app.provider.video_recovery.probe_output",
        lambda path: {
            "file_size_bytes": path.stat().st_size,
            "video_width": 720,
            "video_height": 1280,
        },
    )
    monkeypatch.setattr(
        "server.app.generation_units.publication.extract_tail_frame",
        extract,
    )
    monkeypatch.setattr(
        "server.app.main._generation_unit_task_request",
        one_attempt_request,
    )
    app = _v2_app(tmp_path)
    app.state.task_worker.max_concurrency = 1
    app.state.task_worker.retry_base_seconds = 0.01
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client, mergeable=True)
        preview = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "video_model": "omni_flash-10s",
                "operation": "text_to_video",
                "shot_ids": [shot["id"] for shot in storyboard["shots"]],
            },
        ).json()
        unit_ids = [unit["id"] for unit in preview["generation_units"]]
        initial = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": preview["id"],
                "generation_unit_ids": unit_ids,
                "idempotency_key": "replacement-initial",
            },
        )
        assert initial.status_code == 202, initial.text
        _wait_project_task(client, project_id, initial.json()["task_id"], {"complete"})

        replaced_id = unit_ids[-1]
        app.state.test_db.expire_all()
        old = app.state.test_db.get(
            VideoGenerationUnit, (project_id, replaced_id, 1)
        )
        assert old is not None and old.active and old.status == "complete"
        old_path = old.output_path
        calls_before_replacement = len(
            [call for call in app.state.fake_newapi.execute_calls if call[0] == "video"]
        )

        replacement_plan_response = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "video_model": "omni_flash-10s",
                "operation": "text_to_video",
                "shot_ids": [shot["id"] for shot in storyboard["shots"]],
                "regenerate_unit_ids": [replaced_id],
            },
        )
        assert replacement_plan_response.status_code == 200, replacement_plan_response.text
        replacement_plan = replacement_plan_response.json()
        planned = [
            unit
            for unit in replacement_plan["generation_units"]
            if unit["status"] == "planned"
        ]
        assert [(unit["id"], unit["revision"]) for unit in planned] == [
            (replaced_id, 2)
        ]

        failing_revisions.add(2)
        replacement = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": replacement_plan["id"],
                "generation_unit_ids": [replaced_id],
                "idempotency_key": "replacement-v2",
            },
        )
        assert replacement.status_code == 202, replacement.text
        failed = _wait_project_task(
            client,
            project_id,
            replacement.json()["task_id"],
            {"failed", "partial_failure"},
        )
        replacement_item = app.state.test_db.get(TaskItem, failed["items"][0]["id"])
        assert replacement_item.input_snapshot["dependency"] == {
            "previous_generation_unit_id": unit_ids[-2],
            "previous_generation_unit_revision": 1,
            "inherit_previous_tail": True,
        }
        assert list(
            app.state.test_db.scalars(
                select(TaskDependency).where(
                    TaskDependency.batch_id == replacement.json()["task_id"]
                )
            )
        ) == []
        old = app.state.test_db.get(
            VideoGenerationUnit, (project_id, replaced_id, 1)
        )
        pending = app.state.test_db.get(
            VideoGenerationUnit, (project_id, replaced_id, 2)
        )
        assert old is not None and old.active and old.output_path == old_path
        assert pending is not None and not pending.active and pending.status == "failed"
        assert len(
            [call for call in app.state.fake_newapi.execute_calls if call[0] == "video"]
        ) == calls_before_replacement + 1

        billed_job_id = pending.billing_job_id
        assert billed_job_id is not None
        assert app.state.test_db.get(GenerationJob, billed_job_id).status == "billed"

        failing_revisions.clear()
        item = failed["items"][0]
        retried = client.post(
            f"/api/projects/{project_id}/tasks/{failed['id']}/items/{item['id']}/retry"
        )
        assert retried.status_code == 202, retried.text
        waiting = _wait_project_task(
            client, project_id, failed["id"], {"waiting_provider"}
        )
        app.state.test_db.expire_all()
        waiting = client.get(
            f"/api/projects/{project_id}/tasks/{failed['id']}"
        ).json()
        assert waiting["items"][0]["billing_job_id"] == billed_job_id
        with app.state.task_worker.session_factory() as recovery_db:
            reconciliation = recovery_db.scalar(
                select(BillingReconciliation).where(
                    BillingReconciliation.job_id == billed_job_id,
                    BillingReconciliation.status == "open",
                )
            )
            assert reconciliation is not None
            reconciliation.next_retry_at = datetime.now(timezone.utc) - timedelta(
                seconds=1
            )
            recovery_db.commit()
            assert resume_reconcile_publish_job(
                recovery_db,
                app.state.fake_newapi,
                billed_job_id,
                datetime.now(timezone.utc),
                settings=app.dependency_overrides[get_settings](),
                media_store=app.state.store,
                pending_delay_seconds=0,
            ) == "completed"
        app.state.task_worker.notify()
        try:
            completed = _wait_project_task(
                client, project_id, failed["id"], {"complete"}
            )
        except AssertionError as exc:
            current = client.get(
                f"/api/projects/{project_id}/tasks/{failed['id']}"
            ).json()
            raise AssertionError(
                [
                    (
                        value["status"],
                        value["attempt_count"],
                        value["max_attempts"],
                        value["error_code"],
                    )
                    for value in current["items"]
                ]
            ) from exc

        app.state.test_db.expire_all()
        old = app.state.test_db.get(
            VideoGenerationUnit, (project_id, replaced_id, 1)
        )
        current = app.state.test_db.get(
            VideoGenerationUnit, (project_id, replaced_id, 2)
        )
        assert old is not None and old.active is False and old.output_path == old_path
        assert current is not None and current.active and current.status == "complete"
        assert current.billing_job_id == billed_job_id
        assert completed["items"][0]["billing_job_id"] == billed_job_id
        assert len(
            [call for call in app.state.fake_newapi.execute_calls if call[0] == "video"]
        ) == calls_before_replacement + 1


def test_refunded_generation_unit_retry_starts_a_fresh_provider_execution(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(
        "server.app.provider.video_recovery.probe_output",
        lambda path: {
            "file_size_bytes": path.stat().st_size,
            "video_width": 720,
            "video_height": 1280,
        },
    )
    monkeypatch.setattr(
        "server.app.generation_units.publication.extract_tail_frame",
        _fake_tail_extractor,
    )
    app = _v2_app(tmp_path)
    app.state.task_worker.max_concurrency = 1
    app.state.task_worker.retry_base_seconds = 0.01

    failed_reference: list[str | None] = [None]
    original_execute = app.state.fake_newapi.execute_quoted
    original_receipt = app.state.fake_newapi.get_task_receipt

    def execute_quoted(kind, token_alias, request, quote_id):
        result = original_execute(kind, token_alias, request, quote_id)
        if kind == "video" and failed_reference[0] is None:
            failed_reference[0] = result.reference_id
        return result

    def get_video_task(token_alias, task_id):
        del token_alias
        if task_id == failed_reference[0]:
            return VideoTaskStatus.model_validate(
                {
                    "id": task_id,
                    "status": "failed",
                    "error": {
                        "code": "upstream_error",
                        "message": "video generation timed out",
                    },
                }
            )
        return VideoTaskStatus(id=task_id, status="completed")

    def get_task_receipt(kind, token_alias, task_id):
        if task_id != failed_reference[0]:
            return original_receipt(kind, token_alias, task_id)
        return UsageReceipt(
            reference_type="task",
            reference_id=task_id,
            status="refunded",
            model="omni_flash-10s",
            quota=500_000,
            refunded_quota=500_000,
            quota_per_unit=Decimal("500000"),
            pricing_version="sha256:test-pricing",
            cost_currency="USD",
            cost_amount_micro=0,
            settled_at=int(datetime.now(timezone.utc).timestamp()),
        )

    monkeypatch.setattr(app.state.fake_newapi, "execute_quoted", execute_quoted)
    monkeypatch.setattr(app.state.fake_newapi, "get_video_task", get_video_task)
    monkeypatch.setattr(app.state.fake_newapi, "get_task_receipt", get_task_receipt)

    with TestClient(app) as client:
        project_id, storyboard = _project(app, client, mergeable=True)
        preview = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "video_model": "omni_flash-10s",
                "operation": "text_to_video",
                "shot_ids": [shot["id"] for shot in storyboard["shots"]],
            },
        )
        assert preview.status_code == 200, preview.text
        plan = preview.json()
        unit_ids = [unit["id"] for unit in plan["generation_units"]]
        unit_id = unit_ids[0]
        submitted = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": plan["id"],
                "generation_unit_ids": unit_ids,
                "idempotency_key": "refunded-generation-unit",
            },
        )
        assert submitted.status_code == 202, submitted.text
        batch_id = submitted.json()["task_id"]
        failed = _wait_project_task(
            client,
            project_id,
            batch_id,
            {"failed", "partial_failure"},
        )
        assert failed_reference[0] is not None
        assert len(
            [call for call in app.state.fake_newapi.execute_calls if call[0] == "video"]
        ) == 1

        app.state.test_db.expire_all()
        item_id = failed["items"][0]["id"]
        item = app.state.test_db.get(TaskItem, item_id)
        unit = app.state.test_db.get(VideoGenerationUnit, (project_id, unit_id, 1))
        assert item is not None and unit is not None
        old_job_id = unit.billing_job_id
        assert old_job_id is not None
        assert item.billing_job_id == old_job_id
        old_generation_key = item.generation_key
        old_job = app.state.test_db.get(GenerationJob, old_job_id)
        assert old_job is not None
        assert old_job.status == "failed_no_charge"
        assert old_job.provider_reference_id == failed_reference[0]
        assert unit.status == "failed" and unit.billing_job_id == old_job_id

        item.attempt_count = 10
        item.max_attempts = 10
        item.retryable = False
        app.state.test_db.commit()

        retried = client.post(
            f"/api/projects/{project_id}/tasks/{batch_id}/items/{item_id}/retry"
        )
        assert retried.status_code == 202, retried.text
        completed = _wait_project_task(client, project_id, batch_id, {"complete"})

        app.state.test_db.expire_all()
        current_item = app.state.test_db.get(TaskItem, item_id)
        current_unit = app.state.test_db.get(
            VideoGenerationUnit, (project_id, unit_id, 1)
        )
        immutable_old_job = app.state.test_db.get(GenerationJob, old_job_id)
        assert current_item is not None and current_unit is not None
        assert immutable_old_job is not None
        assert len(
            [call for call in app.state.fake_newapi.execute_calls if call[0] == "video"]
        ) == len(unit_ids) + 1
        assert immutable_old_job.status == "failed_no_charge"
        assert immutable_old_job.provider_reference_id == failed_reference[0]
        assert current_item.generation_key != old_generation_key
        assert current_item.billing_job_id != old_job_id
        assert current_item.attempt_count == 1
        current_items = list(
            app.state.test_db.scalars(
                select(TaskItem)
                .where(TaskItem.batch_id == batch_id)
                .order_by(TaskItem.position)
            )
        )
        assert completed["status"] == "complete"
        assert all(stored.status == "complete" for stored in current_items)
        assert current_unit.status == "complete" and current_unit.active
        assert current_unit.billing_job_id == current_item.billing_job_id
        assert current_unit.diagnostics_json["execution_retries"][0][
            "billing_job_id"
        ] == old_job_id
        new_job = app.state.test_db.get(GenerationJob, current_item.billing_job_id)
        assert new_job is not None and new_job.status == "billed"
