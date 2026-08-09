from __future__ import annotations

import threading
import time
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from server.app.assets.models import MediaAsset
from server.app.wallet.models import WalletAccount
from server.tests import test_api as api_tests


PURPOSE = "inspiration_end_frames"


def _app(tmp_path):
    app = api_tests.create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    # The API test fixture uses one in-memory SQLite connection. Serial task
    # execution avoids testing StaticPool write contention instead of task behavior.
    app.state.task_worker.max_concurrency = 1
    return app


def _confirmed_draft(client: TestClient, *, enabled: bool | None = None) -> str:
    draft = client.post(
        "/api/projects",
        json={"title": "Controlled ending", "project_type": "single_video"},
    )
    assert draft.status_code == 200, draft.text
    project_id = draft.json()["project"]["id"]
    developed = client.post(
        f"/api/projects/{project_id}/inspiration/chat",
        json={"messages": [{"role": "user", "content": "A rainy suspense short."}]},
    )
    assert developed.status_code == 200, developed.text
    if enabled is not None:
        updated = client.patch(
            f"/api/projects/{project_id}/inspiration/intent",
            json={"control_end_frames": enabled},
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["creative_workflow"]["control_end_frames"] is enabled
    return project_id


def _plan(client: TestClient, project_id: str, **payload):
    response = client.post(
        f"/api/projects/{project_id}/storyboard/plan",
        json={"prompt": "A rainy suspense short.", **payload},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _end_frame_tasks(client: TestClient, project_id: str) -> list[dict]:
    response = client.get(
        f"/api/projects/{project_id}/tasks",
        params={"include_items": "true"},
    )
    assert response.status_code == 200, response.text
    tasks = response.json()["tasks"]
    return [
        task
        for task in tasks
        if task["snapshot"].get("snapshot", {}).get("purpose") == PURPOSE
    ]


def _wait_for_item_status(
    client: TestClient,
    project_id: str,
    task_id: str,
    item_id: str,
    expected: set[str],
) -> dict:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get(f"/api/projects/{project_id}/tasks/{task_id}")
        assert response.status_code == 200, response.text
        item = next(
            value for value in response.json()["items"] if value["id"] == item_id
        )
        if item["status"] in expected:
            return item
        time.sleep(0.02)
    raise AssertionError(f"task item {item_id} did not reach {expected}")


@pytest.mark.parametrize("explicit", [None, False])
def test_end_frame_control_defaults_off_and_explicit_off_create_no_image_tasks(
    tmp_path,
    explicit,
):
    app = _app(tmp_path)
    with TestClient(app) as client:
        project_id = _confirmed_draft(client, enabled=explicit)
        planned = _plan(
            client,
            project_id,
            **({"control_end_frames": False} if explicit is False else {}),
        )

        assert planned["storyboard"]["shots"]
        assert planned["creative_workflow"]["control_end_frames"] is False
        assert _end_frame_tasks(client, project_id) == []
        assert [kind for kind, _quote in app.state.fake_newapi.execute_calls].count("image") == 0


def test_enabled_multi_shot_plan_creates_exactly_first_and_last_tasks_and_deduplicates(
    tmp_path,
):
    app = _app(tmp_path)
    with TestClient(app) as client:
        project_id = _confirmed_draft(client, enabled=True)
        planned = _plan(client, project_id, control_end_frames=True)
        shot_ids = [shot["id"] for shot in planned["storyboard"]["shots"]]
        tasks = _end_frame_tasks(client, project_id)

        assert len(tasks) == 1
        assert tasks[0]["total_items"] == 2
        targets = {
            (item["target_entity_id"], item["input"]["frame_target"])
            for item in tasks[0]["items"]
        }
        assert targets == {(shot_ids[0], "first"), (shot_ids[-1], "last")}
        assert not targets.intersection({(shot_id, "first") for shot_id in shot_ids[1:-1]})
        assert not targets.intersection({(shot_id, "last") for shot_id in shot_ids[1:-1]})

        complete = api_tests._wait_project_task(
            client, project_id, tasks[0]["id"], {"complete"}
        )
        assert {item["input"]["frame_target"] for item in complete["items"]} == {
            "first",
            "last",
        }
        storyboard = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        assert storyboard["shots"][0]["continuity"]["first_frame"]["asset_id"]
        assert storyboard["shots"][-1]["continuity"]["last_frame"]["asset_id"]
        assert all(
            not shot.get("continuity", {}).get("first_frame")
            and not shot.get("continuity", {}).get("last_frame")
            for shot in storyboard["shots"][1:-1]
        )

        repeated = _plan(client, project_id, control_end_frames=True)
        assert repeated["storyboard"] == client.get(
            f"/api/projects/{project_id}"
        ).json()["storyboard"]
        assert len(_end_frame_tasks(client, project_id)) == 1
        assert [kind for kind, _quote in app.state.fake_newapi.execute_calls].count("image") == 2


def test_enabled_single_shot_sequences_first_then_last_with_incremented_cas(
    tmp_path,
    monkeypatch,
):
    original = api_tests._fake_storyboard_result

    def single_shot_result():
        result = deepcopy(original())
        result["storyboard"]["shots"] = result["storyboard"]["shots"][:1]
        return result

    monkeypatch.setattr(api_tests, "_fake_storyboard_result", single_shot_result)
    app = _app(tmp_path)
    with TestClient(app) as client:
        project_id = _confirmed_draft(client, enabled=True)
        planned = _plan(client, project_id)
        assert len(planned["storyboard"]["shots"]) == 1
        task = _end_frame_tasks(client, project_id)[0]
        first, last = task["items"]

        assert first["input"]["frame_target"] == "first"
        assert first["target_entity_version"] == 1
        assert last["input"]["frame_target"] == "last"
        assert last["target_entity_version"] == 2
        assert last["dependencies"] == [{"item_id": first["id"], "status": first["status"]}]

        complete = api_tests._wait_project_task(
            client, project_id, task["id"], {"complete"}
        )
        assert all(item["status"] == "complete" for item in complete["items"])
        shot = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )["shots"][0]
        assert shot["continuity"]["first_frame"]["asset_id"]
        assert shot["continuity"]["last_frame"]["asset_id"]
        assert shot["version"] == 3


def test_payment_wait_failure_and_refresh_keep_planned_storyboard_intact(tmp_path):
    app = _app(tmp_path)
    db = app.state.test_db
    original_quote = app.state.fake_newapi.quote

    def empty_wallet_before_image_quote(kind, request, token_alias=None):
        quoted = original_quote(kind, request, token_alias)
        if kind == "image":
            with Session(app.state.test_db_engine) as wallet_db:
                wallet = wallet_db.scalar(
                    select(WalletAccount).where(
                        WalletAccount.user_id == api_tests.TEST_USER.id
                    )
                )
                wallet.balance_units = 0
                wallet_db.commit()
        return quoted

    app.state.fake_newapi.quote = empty_wallet_before_image_quote
    with TestClient(app) as client:
        project_id = _confirmed_draft(client, enabled=True)
        planned = _plan(client, project_id)
        task = _end_frame_tasks(client, project_id)[0]
        waiting = api_tests._wait_project_task(
            client, project_id, task["id"], {"awaiting_payment"}
        )
        waiting_item = next(
            item for item in waiting["items"] if item["status"] == "awaiting_payment"
        )
        assert planned["storyboard"]["shots"]
        assert app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )["shots"]

    with TestClient(app, raise_server_exceptions=False) as refreshed_client:
        restored = _end_frame_tasks(refreshed_client, project_id)[0]
        assert any(item["status"] == "awaiting_payment" for item in restored["items"])
        wallet = db.scalar(
            select(WalletAccount).where(WalletAccount.user_id == api_tests.TEST_USER.id)
        )
        wallet.balance_units = 1_000_000_000
        db.commit()
        app.state.fake_newapi.quote = original_quote
        app.state.fake_newapi.quote_failure = True
        retry = refreshed_client.post(
            f"/api/projects/{project_id}/tasks/{restored['id']}/items/{waiting_item['id']}/retry",
            json={},
        )
        assert retry.status_code == 202, retry.text
        failed = _wait_for_item_status(
            refreshed_client,
            project_id,
            restored["id"],
            waiting_item["id"],
            {"failed"},
        )
        assert failed["error_code"] == "provider_call_failed"
        snapshot = refreshed_client.get(f"/api/projects/{project_id}").json()
        assert snapshot["storyboard"]["shots"]
        assert db.scalar(select(func.count(MediaAsset.id))) == 0


def test_automatic_end_frame_cas_conflict_preserves_user_edits_and_media(tmp_path):
    app = _app(tmp_path)
    entered = threading.Event()
    release = threading.Event()
    original_execute = app.state.fake_newapi.execute_quoted

    def blocked_image_execute(kind, *args, **kwargs):
        if kind == "image":
            entered.set()
            assert release.wait(5)
        return original_execute(kind, *args, **kwargs)

    app.state.fake_newapi.execute_quoted = blocked_image_execute
    with TestClient(app) as client:
        project_id = _confirmed_draft(client, enabled=True)
        planned = _plan(client, project_id)
        assert entered.wait(5)
        task = _end_frame_tasks(client, project_id)[0]
        storyboard = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        storyboard["shots"][0]["version"] = 2
        storyboard["shots"][0]["prompt"] = "User changed the opening shot"
        storyboard["shots"][-1]["version"] = 2
        storyboard["shots"][-1]["prompt"] = "User changed the closing shot"
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )
        release.set()

        failed = api_tests._wait_project_task(
            client, project_id, task["id"], {"failed"}
        )
        assert all(
            item["error_code"] == "stale_entity_version"
            for item in failed["items"]
        )
        current = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )["shots"]
        assert current[0]["prompt"] == "User changed the opening shot"
        assert current[-1]["prompt"] == "User changed the closing shot"
        db_count = app.state.test_db.scalar(select(func.count(MediaAsset.id)))
        assert db_count == 2
        assert planned["storyboard"]["shots"]
