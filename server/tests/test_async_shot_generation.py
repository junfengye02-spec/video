from __future__ import annotations

import threading
import time
from contextlib import nullcontext
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from server.app.auth.models import User
from server.app.db.base import Base
from server.app.keyframe_service import TailFrameBinding
from server.app.projects.models import ProjectRecord
from server.app.storage import WorkbenchStore
from server.app.tasks.service import PREVIOUS_SHOT_MISSING_MESSAGE, TaskService
from server.app.tasks.shot_videos import execute_shot_video
from server.app.tasks.worker import (
    PermanentTaskError,
    PublishOutcome,
    TaskAwaitingPayment,
    TaskExecutionContext,
)
from server.tests import test_api as api_tests


def _app(tmp_path, monkeypatch, execute):
    from server.app import main as main_module

    original_build_generation_plan = main_module.build_generation_plan

    def build_supported_generation_plan(**kwargs):
        plan = original_build_generation_plan(**kwargs)
        return plan.model_copy(
            update={"can_generate": True, "requires_confirmation": False}
        )

    tmp_path.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr("server.app.main.execute_shot_video", execute)
    monkeypatch.setattr(
        "server.app.main.publish_shot_video",
        lambda *_args, **_kwargs: PublishOutcome.PUBLISHED,
    )
    monkeypatch.setattr(
        "server.app.main._project_asset_reference_is_available",
        lambda **_kwargs: True,
    )
    monkeypatch.setattr(
        "server.app.main.build_generation_plan",
        build_supported_generation_plan,
    )
    app = api_tests.create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    app.state.task_worker.max_concurrency = 4
    return app


def _project(client: TestClient, app, *, continuity: str = "carry") -> tuple[str, list[str]]:
    created = api_tests._create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    storyboard = app.state.store.read_artifact(project_id, "episode_storyboard.json")
    for index, shot in enumerate(storyboard["shots"]):
        shot_continuity = "cut" if index == 0 else continuity
        shot["continuity"] = {
            "mode": shot_continuity,
            "inherit_previous_tail": shot_continuity == "carry",
        }
    app.state.store.write_artifact(project_id, "episode_storyboard.json", storyboard)
    return project_id, [str(shot["id"]) for shot in storyboard["shots"]]


def _submit(client: TestClient, project_id: str, shot_ids: list[str], key: str):
    response = client.post(
        f"/api/projects/{project_id}/shots/generate",
        json={"shot_ids": shot_ids, "idempotency_key": key},
    )
    assert response.status_code == 202, response.text
    return response.json()


def _wait_item(client: TestClient, project_id: str, task_id: str, shot_id: str, statuses: set[str]):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get(f"/api/projects/{project_id}/tasks/{task_id}")
        assert response.status_code == 200, response.text
        item = next(
            value
            for value in response.json()["items"]
            if value["target_entity_id"] == shot_id
        )
        if item["status"] in statuses:
            return item
        time.sleep(0.02)
    raise AssertionError(f"shot {shot_id} did not reach {statuses}")


def test_full_episode_runs_in_order_and_duplicate_submission_is_idempotent(
    tmp_path, monkeypatch
):
    calls: list[str] = []

    def execute(context, **_kwargs):
        calls.append(str(context.target_entity_id))
        return {"shot_id": context.target_entity_id}

    app = _app(tmp_path, monkeypatch, execute)
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app)
        accepted = _submit(client, project_id, list(reversed(shot_ids)), "episode-all")
        completed = api_tests._wait_project_task(
            client, project_id, accepted["task_id"], {"complete"}
        )

        assert calls == shot_ids
        assert [item["target_entity_id"] for item in completed["items"]] == shot_ids
        for previous, current in zip(completed["items"], completed["items"][1:]):
            assert current["dependencies"] == [
                {"item_id": previous["id"], "status": "complete"}
            ]
        repeated = _submit(client, project_id, shot_ids, "episode-all")
        assert repeated["deduplicated"] is True
        assert repeated["task_id"] == accepted["task_id"]
        assert calls == shot_ids
        conflict = client.post(
            f"/api/projects/{project_id}/shots/generate",
            json={"shot_ids": shot_ids[:1], "idempotency_key": "episode-all"},
        )
        assert conflict.status_code == 409
        assert conflict.json()["detail"]["code"] == "idempotency_conflict"


def test_non_contiguous_selection_does_not_add_missing_previous_shot_or_call_it(
    tmp_path, monkeypatch
):
    calls: list[str] = []

    def execute(context, **_kwargs):
        calls.append(str(context.target_entity_id))
        return {"shot_id": context.target_entity_id}

    app = _app(tmp_path, monkeypatch, execute)
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app)
        accepted = _submit(
            client, project_id, [shot_ids[0], shot_ids[2]], "non-contiguous"
        )
        first = _wait_item(
            client, project_id, accepted["task_id"], shot_ids[0], {"complete"}
        )
        blocked = _wait_item(
            client,
            project_id,
            accepted["task_id"],
            shot_ids[2],
            {"waiting_dependency"},
        )

        assert first["status"] == "complete"
        assert blocked["error_code"] == "previous_shot_missing"
        assert blocked["error_message"] == PREVIOUS_SHOT_MISSING_MESSAGE
        assert accepted["task"]["snapshot"]["snapshot"]["selected_shot_ids"] == [
            shot_ids[0],
            shot_ids[2],
        ]
        assert calls == [shot_ids[0]]

        storyboard = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        previous = storyboard["shots"][1]
        tail_path = Path("assets/images/keyframes/recovered-s2.png")
        absolute_tail = app.state.store.project_dir(project_id) / tail_path
        absolute_tail.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (8, 8), (40, 60, 80)).save(absolute_tail)
        previous["continuity"]["last_frame_asset_id"] = "recovered-tail-s2"
        previous["continuity"]["last_frame"] = {
            "asset_id": "recovered-tail-s2",
            "version": 1,
            "status": "ready",
            "source": "video_extract",
        }
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )
        app.state.store.write_asset_library(
            project_id,
            [
                {
                    "id": "recovered-tail-s2",
                    "kind": "scene",
                    "label": "tail",
                    "reference_images": [tail_path.as_posix()],
                    "source_type": "video_frame",
                    "status": "ready",
                    "provenance": {
                        "shot_id": shot_ids[1],
                        "video_version": 1,
                        "media_sha256": "c" * 64,
                        "sample_time_seconds": 1.0,
                    },
                }
            ],
        )
        with app.state.task_worker.session_factory() as db:
            assert TaskService(
                db, app.state.events
            ).release_external_shot_dependencies(
                project_id=project_id,
                previous_shot_id=shot_ids[1],
                previous_shot_version=1,
            ) == 1
        app.state.task_worker.notify()
        recovered = _wait_item(
            client,
            project_id,
            accepted["task_id"],
            shot_ids[2],
            {"complete"},
        )
        assert recovered["status"] == "complete"
        assert calls == [shot_ids[0], shot_ids[2]]


def test_existing_previous_video_and_tail_allow_partial_generation(
    tmp_path, monkeypatch
):
    calls: list[str] = []

    def execute(context, **_kwargs):
        calls.append(str(context.target_entity_id))
        return {"shot_id": context.target_entity_id}

    app = _app(tmp_path, monkeypatch, execute)
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app)
        store = app.state.store
        storyboard = store.read_artifact(project_id, "episode_storyboard.json")
        previous = storyboard["shots"][1]
        tail_path = Path("assets/images/keyframes/s2-tail.png")
        absolute_tail = store.project_dir(project_id) / tail_path
        absolute_tail.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (8, 8), (30, 80, 120)).save(absolute_tail)
        previous["continuity"]["last_frame_asset_id"] = "tail-s2"
        previous["continuity"]["last_frame"] = {
            "asset_id": "tail-s2",
            "version": 1,
            "status": "ready",
            "source": "video_extract",
        }
        previous["status"] = "complete"
        previous["output_path"] = "assets/video/s2.mp4"
        video_path = store.project_dir(project_id) / previous["output_path"]
        video_path.parent.mkdir(parents=True, exist_ok=True)
        video_path.write_bytes(b"existing-video")
        store.write_artifact(project_id, "episode_storyboard.json", storyboard)
        store.write_asset_library(
            project_id,
            [
                {
                    "id": "tail-s2",
                    "kind": "scene",
                    "label": "tail",
                    "reference_images": [tail_path.as_posix()],
                    "source_type": "video_frame",
                    "status": "ready",
                    "provenance": {
                        "shot_id": shot_ids[1],
                        "video_version": 1,
                        "media_sha256": "a" * 64,
                        "sample_time_seconds": 1.0,
                    },
                }
            ],
        )

        accepted = _submit(client, project_id, [shot_ids[2]], "existing-tail")
        completed = api_tests._wait_project_task(
            client, project_id, accepted["task_id"], {"complete"}
        )

        assert calls == [shot_ids[2]]
        dependency = completed["items"][0]["input"]["dependency"]
        assert dependency["source"] == "existing_tail"
        assert dependency["previous_shot_id"] == shot_ids[1]


def test_submission_rejects_shots_outside_the_active_episode(tmp_path, monkeypatch):
    app = _app(
        tmp_path,
        monkeypatch,
        lambda context, **_kwargs: {"shot_id": context.target_entity_id},
    )
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app, continuity="cut")
        project = app.state.test_db.get(ProjectRecord, project_id)
        project.project_type = "mini_series"
        app.state.test_db.commit()
        storyboard = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        for index, shot in enumerate(storyboard["shots"]):
            shot["episode_number"] = 1 if index < 2 else 2
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )
        plan = app.state.store.read_artifact(project_id, "continuity_plan.json")
        plan["active_episode_number"] = 1
        plan["episodes"] = [
            {"episode_number": 1, "title": "one"},
            {"episode_number": 2, "title": "two"},
        ]
        app.state.store.write_artifact(project_id, "continuity_plan.json", plan)

        response = client.post(
            f"/api/projects/{project_id}/shots/generate",
            json={"shot_ids": [shot_ids[2]], "idempotency_key": "wrong-episode"},
        )

        assert response.status_code == 422
        assert response.json()["detail"] == {
            "code": "selected_shots_outside_generation_scope",
            "shot_ids": [shot_ids[2]],
        }


def test_first_shot_of_an_episode_does_not_depend_on_previous_episode(
    tmp_path, monkeypatch
):
    calls: list[str] = []

    def execute(context, **_kwargs):
        calls.append(str(context.target_entity_id))
        return {"shot_id": context.target_entity_id}

    app = _app(tmp_path, monkeypatch, execute)
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app, continuity="cut")
        project = app.state.test_db.get(ProjectRecord, project_id)
        project.project_type = "mini_series"
        app.state.test_db.commit()
        storyboard = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        for index, shot in enumerate(storyboard["shots"]):
            shot["episode_number"] = 1 if index < 2 else 2
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )
        plan = app.state.store.read_artifact(project_id, "continuity_plan.json")
        plan["active_episode_number"] = 2
        plan["episodes"] = [
            {"episode_number": 1, "title": "one"},
            {"episode_number": 2, "title": "two"},
        ]
        app.state.store.write_artifact(project_id, "continuity_plan.json", plan)

        accepted = _submit(client, project_id, [shot_ids[2]], "episode-two-root")
        completed = api_tests._wait_project_task(
            client, project_id, accepted["task_id"], {"complete"}
        )

        assert calls == [shot_ids[2]]
        assert completed["items"][0]["dependencies"] == []
        assert completed["items"][0]["input"]["dependency"] == {
            "required": False
        }


def test_shot_batch_submission_enforces_project_ownership(tmp_path, monkeypatch):
    calls: list[str] = []

    def execute(context, **_kwargs):
        calls.append(str(context.target_entity_id))
        return {"shot_id": context.target_entity_id}

    app = _app(tmp_path, monkeypatch, execute)
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app, continuity="cut")
        app.state.test_db.add(
            User(
                id="9" * 32,
                email="other-owner@example.com",
                password_hash="hash",
                role="user",
                status="active",
            )
        )
        project = app.state.test_db.get(ProjectRecord, project_id)
        project.owner_user_id = "9" * 32
        app.state.test_db.commit()

        response = client.post(
            f"/api/projects/{project_id}/shots/generate",
            json={"shot_ids": [shot_ids[0]], "idempotency_key": "not-owned"},
        )

        assert response.status_code == 404
        assert calls == []


def test_explicit_first_frame_match_cut_and_hard_cut_keep_execution_dependencies(
    tmp_path, monkeypatch
):
    calls: list[str] = []

    def execute(context, **_kwargs):
        calls.append(str(context.target_entity_id))
        return {"shot_id": context.target_entity_id}

    app = _app(tmp_path, monkeypatch, execute)
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app)
        storyboard = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        storyboard["shots"][1]["continuity"].update(
            {
                "mode": "match_cut",
                "inherit_previous_tail": False,
                "explicit_user_first_frame_asset_id": "user-first",
                "first_frame": {
                    "asset_id": "user-first",
                    "version": 1,
                    "status": "ready",
                    "source": "user",
                },
            }
        )
        storyboard["shots"][2]["continuity"] = {
            "mode": "cut",
            # A model-authored visual cut does not disable execution ordering.
            "inherit_previous_tail": True,
        }
        storyboard["shots"][3]["continuity"] = {
            "mode": "cut",
            # The user hard cut disables frame inheritance only.
            "inherit_previous_tail": False,
        }
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )

        accepted = _submit(
            client, project_id, shot_ids, "overrides"
        )
        completed = api_tests._wait_project_task(
            client, project_id, accepted["task_id"], {"complete"}
        )

        assert calls == shot_ids
        assert completed["items"][0]["dependencies"] == []
        for previous, current in zip(
            completed["items"], completed["items"][1:]
        ):
            assert current["dependencies"] == [
                {"item_id": previous["id"], "status": "complete"}
            ]
        assert completed["items"][0]["input"]["dependency"]["required"] is False
        assert completed["items"][1]["input"]["dependency"]["required"] is False
        assert completed["items"][2]["input"]["dependency"]["required"] is False
        assert completed["items"][3]["input"]["dependency"]["required"] is False
        assert (
            completed["items"][1]["input"]["explicit_first_frame_asset_id"]
            == "user-first"
        )


def test_upstream_failure_tail_failure_and_payment_keep_downstream_unexecuted(
    tmp_path, monkeypatch
):
    modes = [
        ("provider_failed", PermanentTaskError("provider_failed", "failed"), "failed"),
        (
            "tail_frame_extraction_failed",
            PermanentTaskError("tail_frame_extraction_failed", "tail failed"),
            "failed",
        ),
        ("awaiting_payment", TaskAwaitingPayment(), "awaiting_payment"),
    ]
    calls: list[str] = []
    current_failure = [modes[0][1]]

    def execute(context, **_kwargs):
        calls.append(str(context.target_entity_id))
        if len(calls) == 1:
            raise current_failure[0]
        return {"shot_id": context.target_entity_id}

    app = _app(tmp_path, monkeypatch, execute)
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app)
        for key, failure, upstream_status in modes:
            calls.clear()
            current_failure[0] = failure
            accepted = _submit(
                client, project_id, shot_ids[:2], f"upstream-{key}"
            )
            upstream = _wait_item(
                client,
                project_id,
                accepted["task_id"],
                shot_ids[0],
                {upstream_status},
            )
            downstream_expected = (
                {"waiting_dependency"}
                if upstream_status == "awaiting_payment"
                else {"failed"}
            )
            downstream = _wait_item(
                client,
                project_id,
                accepted["task_id"],
                shot_ids[1],
                downstream_expected,
            )

            assert upstream["status"] == upstream_status
            assert calls == [shot_ids[0]]
            if downstream["status"] == "failed":
                assert downstream["error_message"] == PREVIOUS_SHOT_MISSING_MESSAGE


def test_cancelled_upstream_marks_dependent_shot_without_executing_it(
    tmp_path, monkeypatch
):
    entered = threading.Event()
    release = threading.Event()
    calls: list[str] = []

    def execute(context, **_kwargs):
        calls.append(str(context.target_entity_id))
        entered.set()
        release.wait(5)
        return {"shot_id": context.target_entity_id}

    app = _app(tmp_path, monkeypatch, execute)
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app)
        accepted = _submit(client, project_id, shot_ids[:2], "cancel-upstream")
        assert entered.wait(5)
        task = client.get(
            f"/api/projects/{project_id}/tasks/{accepted['task_id']}"
        ).json()
        upstream = next(
            item for item in task["items"] if item["target_entity_id"] == shot_ids[0]
        )
        with app.state.task_worker.session_factory() as db:
            TaskService(db, app.state.events).transition_item(
                upstream["id"], "cancelled"
            )
        release.set()
        downstream = _wait_item(
            client,
            project_id,
            accepted["task_id"],
            shot_ids[1],
            {"failed"},
        )

        assert downstream["error_code"] == "dependency_cancelled"
        assert downstream["error_message"] == PREVIOUS_SHOT_MISSING_MESSAGE
        assert calls == [shot_ids[0]]


def test_executor_extracts_and_registers_tail_before_next_shot_uses_it(
    tmp_path, monkeypatch
):
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    owner_id = "7" * 32
    project_id = "80000000000040008000000000000008"
    with factory() as db:
        db.add(User(id=owner_id, email="shots@example.com", password_hash="hash", role="user", status="active"))
        db.add(
            ProjectRecord(
                id=project_id,
                owner_user_id=owner_id,
                title="Shots",
                mode="short_drama",
                project_type="single_video",
            )
        )
        db.commit()
    store = WorkbenchStore(tmp_path / "executor-projects")
    store._ensure_project_dirs(project_id)
    shots = [
        {
            "id": "s1",
            "index": 1,
            "version": 1,
            "status": "ready",
            "prompt": "one",
            "characters": [],
            "asset_ids": [],
            "continuity": {"mode": "carry", "inherit_previous_tail": True},
        },
        {
            "id": "s2",
            "index": 2,
            "version": 1,
            "status": "ready",
            "prompt": "two",
            "characters": [],
            "asset_ids": [],
            "continuity": {"mode": "carry", "inherit_previous_tail": True},
        },
    ]
    store.write_artifact(project_id, "episode_storyboard.json", {"shots": shots})
    store.write_artifact(project_id, "series_bible.json", {"assets": [], "characters": []})
    store.write_asset_library(project_id, [])
    timeline: list[str] = []
    generated_inputs: list[dict] = []

    def fake_generate(**kwargs):
        shot = kwargs["shot"]
        timeline.append(f"generate:{shot['id']}")
        generated_inputs.append(shot)
        storyboard = store.read_artifact(project_id, "episode_storyboard.json")
        current = next(item for item in storyboard["shots"] if item["id"] == shot["id"])
        current["status"] = "complete"
        current["output_path"] = f"assets/video/{shot['id']}.mp4"
        store.write_artifact(project_id, "episode_storyboard.json", storyboard)
        return {
            "output_path": current["output_path"],
            "operation": "image_to_video" if shot["id"] == "s2" else "text_to_video",
            "referenced_asset_ids": [],
            "tool_result": {"billing_job_id": kwargs["settlement_key"]},
        }

    def fake_tail(**kwargs):
        shot_id = kwargs["shot_id"]
        timeline.append(f"tail:{shot_id}")
        asset_id = f"tail-{shot_id}"
        relative = f"assets/images/keyframes/{shot_id}.png"
        destination = store.project_dir(project_id) / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (8, 8), (10, 20, 30)).save(destination)
        storyboard = store.read_artifact(project_id, "episode_storyboard.json")
        current = next(item for item in storyboard["shots"] if item["id"] == shot_id)
        current["continuity"].update(
            {
                "last_frame_asset_id": asset_id,
                "last_frame": {
                    "asset_id": asset_id,
                    "version": 1,
                    "status": "ready",
                    "source": "video_extract",
                },
            }
        )
        store.write_artifact(project_id, "episode_storyboard.json", storyboard)
        assets = store.read_asset_library(project_id)
        assets.append(
            {
                "id": asset_id,
                "kind": "scene",
                "label": "tail",
                "reference_images": [relative],
                "source_type": "video_frame",
                "status": "ready",
                "provenance": {
                    "shot_id": shot_id,
                    "video_version": 1,
                    "media_sha256": "a" * 64,
                    "sample_time_seconds": 1.0,
                },
            }
        )
        store.write_asset_library(project_id, assets)
        return TailFrameBinding(
            asset_id=asset_id,
            path=relative,
            media_sha256="a" * 64,
            sample_time_seconds=1.0,
            frame_version=1,
            reused=False,
            stale_frames=0,
        )

    monkeypatch.setattr("server.app.tasks.shot_videos.generate_billed_shot", fake_generate)
    monkeypatch.setattr("server.app.tasks.shot_videos.ensure_shot_tail_frame", fake_tail)

    def context(shot, dependency):
        item_id = ("1" if shot["id"] == "s1" else "2") * 32
        return TaskExecutionContext(
            item_id=item_id,
            batch_id="3" * 32,
            owner_user_id=owner_id,
            project_id=project_id,
            task_type="shot_video.generate",
            input_snapshot={
                "shot": shot,
                "series_bible": {"assets": [], "characters": []},
                "video_model": "video-model",
                "aspect_ratio": "9:16",
                "dependency": dependency,
            },
            reference_snapshot=[],
            model="video-model",
            project_version=1,
            snapshot_version=1,
            target_entity_type="shot_video",
            target_entity_id=shot["id"],
            target_entity_version=1,
            attempt_count=1,
            billing_job_id=None,
            settlement_key=f"task:{item_id}",
            report_progress=lambda _progress: True,
        )

    execute_shot_video(
        context(shots[0], {"required": False}),
        session_factory=factory,
        media_store=store,
        settings_factory=lambda: object(),
        newapi_context=lambda _settings: nullcontext(object()),
    )
    execute_shot_video(
        context(
            shots[1],
            {
                "required": True,
                "source": "batch",
                "previous_shot_id": "s1",
                "previous_shot_version": 1,
            },
        ),
        session_factory=factory,
        media_store=store,
        settings_factory=lambda: object(),
        newapi_context=lambda _settings: nullcontext(object()),
    )

    assert timeline == ["generate:s1", "tail:s1", "generate:s2", "tail:s2"]
    assert generated_inputs[1]["continuity"]["first_frame"]["asset_id"] == "tail-s1"
    assert generated_inputs[1]["continuity"]["first_frame"]["source"] == "inherited"
    engine.dispose()


def test_real_video_handler_uses_stable_billing_job_and_does_not_charge_twice(
    tmp_path, monkeypatch
):
    def fake_tail(**kwargs):
        store = kwargs["media_store"]
        project_id = kwargs["project_id"]
        shot_id = kwargs["shot_id"]
        storyboard = store.read_artifact(project_id, "episode_storyboard.json")
        shot = next(item for item in storyboard["shots"] if item["id"] == shot_id)
        asset_id = f"tail-{shot_id}"
        shot.setdefault("continuity", {}).update(
            {
                "last_frame_asset_id": asset_id,
                "last_frame": {
                    "asset_id": asset_id,
                    "version": 1,
                    "status": "ready",
                    "source": "video_extract",
                },
            }
        )
        store.write_artifact(project_id, "episode_storyboard.json", storyboard)
        return TailFrameBinding(
            asset_id=asset_id,
            path=f"assets/images/keyframes/{shot_id}.png",
            media_sha256="b" * 64,
            sample_time_seconds=1.0,
            frame_version=1,
            reused=False,
            stale_frames=0,
        )

    monkeypatch.setattr(
        "server.app.provider.video_recovery.probe_output",
        lambda path: {
            "file_size_bytes": path.stat().st_size,
            "video_width": 720,
            "video_height": 1280,
        },
    )
    monkeypatch.setattr(
        "server.app.openmontage_runner.probe_media",
        lambda _path: {"duration_seconds": 10.0},
    )
    monkeypatch.setattr(
        "server.app.provider.video_recovery.ensure_shot_tail_frame", fake_tail
    )
    monkeypatch.setattr(
        "server.app.tasks.shot_videos.ensure_shot_tail_frame", fake_tail
    )
    app = api_tests.create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    app.state.task_worker.max_concurrency = 1
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app)
        accepted = _submit(client, project_id, [shot_ids[0]], "real-handler")
        completed = api_tests._wait_project_task(
            client, project_id, accepted["task_id"], {"complete"}
        )
        item = completed["items"][0]
        video_calls = [
            call for call in app.state.fake_newapi.execute_calls if call[0] == "video"
        ]

        assert len(video_calls) == 1
        assert item["billing_job_id"] == item["settlement_key"]
        assert item["result"]["billing_job_id"] == item["settlement_key"]
        assert item["result"]["tail_frame"]["provider_cost_units"] == 0

        repeated = _submit(client, project_id, [shot_ids[0]], "real-handler")
        assert repeated["deduplicated"] is True
        assert len(
            [call for call in app.state.fake_newapi.execute_calls if call[0] == "video"]
        ) == 1


def test_missing_explicit_first_frame_never_degrades_to_provider_text_generation(
    tmp_path
):
    app = api_tests.create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    app.state.task_worker.max_concurrency = 1
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app)
        storyboard = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        storyboard["shots"][1]["continuity"].update(
            {
                "explicit_user_first_frame_asset_id": "missing-first-frame",
                "first_frame": {
                    "asset_id": "missing-first-frame",
                    "version": 1,
                    "status": "ready",
                    "source": "user",
                },
            }
        )
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )

        response = client.post(
            f"/api/projects/{project_id}/shots/generate",
            json={
                "shot_ids": [shot_ids[1]],
                "idempotency_key": "missing-explicit-first",
            },
        )

        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": "first_frame_unavailable",
            "message": "The explicitly selected first frame is unavailable",
            "shot_id": shot_ids[1],
        }
        assert [
            call for call in app.state.fake_newapi.execute_calls if call[0] == "video"
        ] == []


def test_missing_unselected_previous_shot_makes_zero_provider_calls(tmp_path):
    app = api_tests.create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    app.state.task_worker.max_concurrency = 1
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app)
        response = client.post(
            f"/api/projects/{project_id}/shots/generate",
            json={
                "shot_ids": [shot_ids[2]],
                "idempotency_key": "actual-missing-previous",
            },
        )

        assert response.status_code == 409
        assert response.json()["detail"]["message"] == PREVIOUS_SHOT_MISSING_MESSAGE
        assert [
            call for call in app.state.fake_newapi.execute_calls if call[0] == "video"
        ] == []


def test_single_middle_shot_missing_previous_is_rejected_before_task_submission(
    tmp_path, monkeypatch
):
    app = _app(tmp_path, monkeypatch, lambda *_args, **_kwargs: None)
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app)
        response = client.post(
            f"/api/projects/{project_id}/shots/generate",
            json={"shot_ids": [shot_ids[2]], "idempotency_key": "single-missing"},
        )

        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": "previous_shot_missing",
            "message": PREVIOUS_SHOT_MISSING_MESSAGE,
            "previous_shot_id": shot_ids[1],
        }


def test_carry_batch_is_accepted_for_reference_frame_guidance(tmp_path):
    app = api_tests.create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app)
        response = client.post(
            f"/api/projects/{project_id}/shots/generate",
            json={"shot_ids": shot_ids, "idempotency_key": "unsupported-carry"},
        )

        assert response.status_code == 202
        body = response.json()
        assert body["task"]["snapshot"]["snapshot"]["selected_shot_ids"] == shot_ids
        assert [item["target_entity_id"] for item in body["task"]["items"]] == shot_ids


def test_batch_regeneration_requires_current_first_and_last_frames(
    tmp_path, monkeypatch
):
    calls: list[str] = []

    def execute(context, **_kwargs):
        calls.append(str(context.target_entity_id))
        return {"shot_id": context.target_entity_id}

    app = _app(tmp_path, monkeypatch, execute)
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app, continuity="cut")
        storyboard = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        storyboard["shots"][0]["status"] = "complete"
        storyboard["shots"][0]["continuity"] = {
            "mode": "cut",
            "inherit_previous_tail": False,
            "first_frame": None,
            "last_frame": None,
        }
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )

        response = client.post(
            f"/api/projects/{project_id}/shots/generate",
            json={"shot_ids": [shot_ids[0]], "idempotency_key": "regen-missing"},
        )

        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": "shot_frame_dependencies_missing",
            "message": "二次生成需要当前镜头的首帧和尾帧，请先完成画面依赖准备。",
            "shot_id": shot_ids[0],
        }
        assert calls == []


def test_paid_video_cas_conflict_preserves_newer_shot_and_visible_media(
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
    app = api_tests.create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    app.state.task_worker.max_concurrency = 1
    entered = threading.Event()
    release = threading.Event()
    with TestClient(app) as client:
        project_id, shot_ids = _project(client, app, continuity="cut")
        original_execute = app.state.fake_newapi.execute_quoted

        def blocked_execute(kind, *args, **kwargs):
            if kind == "video":
                entered.set()
                assert release.wait(5)
            return original_execute(kind, *args, **kwargs)

        app.state.fake_newapi.execute_quoted = blocked_execute
        accepted = _submit(client, project_id, [shot_ids[0]], "cas-conflict")
        assert entered.wait(5)
        edited = client.patch(
            f"/api/projects/{project_id}/shots/{shot_ids[0]}",
            json={"prompt": "newer user edit"},
        )
        assert edited.status_code == 200, edited.text
        release.set()
        failed = api_tests._wait_project_task(
            client, project_id, accepted["task_id"], {"failed"}
        )
        item = failed["items"][0]
        current = client.get(f"/api/projects/{project_id}").json()["storyboard"][
            "shots"
        ][0]
        billing = client.get(f"/api/billing/jobs/{item['billing_job_id']}")

        assert item["error_code"] == "stale_entity_version"
        assert current["prompt"] == "newer user edit"
        assert current["version"] == 2
        assert billing.status_code == 200
        assert billing.json()["result_visible"] is True
        assert len(
            [call for call in app.state.fake_newapi.execute_calls if call[0] == "video"]
        ) == 1
