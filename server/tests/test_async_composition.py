from __future__ import annotations

import threading
from pathlib import Path

from fastapi.testclient import TestClient

from server.app.tasks.worker import PermanentTaskError
from server.tests import test_api as api_tests


def _app(tmp_path, monkeypatch, renderer):
    monkeypatch.setattr("server.app.main.media_matches_aspect_ratio", lambda *_args, **_kwargs: True)
    monkeypatch.setattr("server.app.main.render_short_drama_project", renderer)
    return api_tests.create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )


def _ready_project(client: TestClient, app) -> tuple[str, list[str]]:
    created = api_tests._create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    storyboard = app.state.store.read_artifact(
        project_id, "episode_storyboard.json"
    )
    shot_ids: list[str] = []
    for shot in storyboard["shots"]:
        shot_id = str(shot["id"])
        shot_ids.append(shot_id)
        relative = f"assets/video/{shot_id}.mp4"
        output = app.state.store.project_dir(project_id) / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(f"shot:{shot_id}".encode())
        shot["status"] = "complete"
        shot["output_path"] = relative
    app.state.store.write_artifact(
        project_id, "episode_storyboard.json", storyboard
    )
    return project_id, shot_ids


def _fake_renderer(**kwargs):
    output = Path(kwargs["composition_output_path"])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"async-composition")
    return {
        "final_path": str(output),
        "render_report": {
            "version": "1.0",
            "outputs": [
                {
                    "path": str(output),
                    "format": "mp4",
                    "resolution": "720x1280",
                    "duration_seconds": 25,
                }
            ],
            "warnings": [],
            "verification_notes": ["fixed fake runtime"],
        },
        "storyboard": kwargs["storyboard"],
        "artifacts": {},
        "outputs": [],
        "edit_timeline": None,
        "render_plan": None,
        "final_review": None,
    }


def _submit(client: TestClient, project_id: str, shot_ids: list[str], key: str):
    response = client.post(
        f"/api/projects/{project_id}/composition",
        json={
            "selected_shot_ids": shot_ids,
            "render_runtime": "ffmpeg",
            "idempotency_key": key,
        },
    )
    assert response.status_code == 202, response.text
    return response.json()


def _seed_previous_render(app, project_id: str, payload: bytes = b"previous"):
    output = app.state.store.project_dir(project_id) / "renders" / "final.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(payload)
    app.state.store.write_artifact(
        project_id,
        "render_report.json",
        {
            "version": "1.0",
            "outputs": [
                {
                    "path": str(output),
                    "format": "mp4",
                    "resolution": "720x1280",
                    "duration_seconds": 25,
                }
            ],
            "warnings": [],
            "verification_notes": ["previous successful render"],
        },
    )
    return output


def test_prepare_reports_persisted_readiness_blockers(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch, _fake_renderer)
    with TestClient(app) as client:
        created = api_tests._create_project_with_fake_generator(client)
        project_id = created["project"]["id"]
        prepared = client.post(
            f"/api/projects/{project_id}/render/prepare", json={}
        )

        assert prepared.status_code == 200, prepared.text
        readiness = prepared.json()["readiness"]
        assert readiness["ready"] is False
        assert readiness["blockers"]
        assert {item["code"] for item in readiness["blockers"]} == {
            "shot_media_missing"
        }
        assert prepared.json()["estimated_units"] == 0


def test_composition_returns_202_freezes_inputs_and_is_idempotent(
    tmp_path, monkeypatch
):
    captured: list[dict] = []

    def renderer(**kwargs):
        captured.append(kwargs)
        return _fake_renderer(**kwargs)

    app = _app(tmp_path, monkeypatch, renderer)
    with TestClient(app) as client:
        project_id, shot_ids = _ready_project(client, app)
        accepted = _submit(client, project_id, shot_ids, "compose-once")
        completed = api_tests._wait_project_task(
            client, project_id, accepted["task_id"], {"complete"}
        )
        repeated = _submit(client, project_id, shot_ids, "compose-once")

        assert repeated["deduplicated"] is True
        assert repeated["task_id"] == accepted["task_id"]
        assert len(captured) == 1
        frozen = completed["snapshot"]["snapshot"]
        assert frozen["selected_shot_ids"] == shot_ids
        assert frozen["render_runtime"] == "ffmpeg"
        assert set(frozen["shot_versions"]) == set(shot_ids)
        assert [item["shot_id"] for item in frozen["media_references"]] == shot_ids

        project = client.get(f"/api/projects/{project_id}")
        assert project.status_code == 200
        assert project.json()["final_path"] == "renders/final.mp4"
        media = client.get(
            f"/api/projects/{project_id}/media/renders/final.mp4"
        )
        assert media.status_code == 200
        assert media.content == b"async-composition"


def test_failed_composition_keeps_previous_successful_video(tmp_path, monkeypatch):
    def fail_renderer(**_kwargs):
        raise PermanentTaskError("fake_render_failed", "Fixed fake render failed")

    app = _app(tmp_path, monkeypatch, fail_renderer)
    with TestClient(app) as client:
        project_id, shot_ids = _ready_project(client, app)
        old_output = _seed_previous_render(app, project_id)
        accepted = _submit(client, project_id, shot_ids, "compose-fails")
        failed = api_tests._wait_project_task(
            client, project_id, accepted["task_id"], {"failed"}
        )

        assert failed["items"][0]["error_code"] == "fake_render_failed"
        assert old_output.read_bytes() == b"previous"
        project = client.get(f"/api/projects/{project_id}").json()
        assert project["final_path"] == "renders/final.mp4"


def test_composition_cas_rejects_shot_edit_and_keeps_previous_video(
    tmp_path, monkeypatch
):
    started = threading.Event()
    release = threading.Event()

    def blocking_renderer(**kwargs):
        started.set()
        assert release.wait(5)
        return _fake_renderer(**kwargs)

    app = _app(tmp_path, monkeypatch, blocking_renderer)
    with TestClient(app) as client:
        project_id, shot_ids = _ready_project(client, app)
        old_output = _seed_previous_render(app, project_id, b"cas-previous")
        accepted = _submit(client, project_id, shot_ids, "compose-cas")
        assert started.wait(5)

        storyboard = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        storyboard["shots"][0]["version"] = int(
            storyboard["shots"][0].get("version") or 1
        ) + 1
        storyboard["shots"][0]["prompt"] = "edited while composing"
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )
        release.set()
        failed = api_tests._wait_project_task(
            client, project_id, accepted["task_id"], {"failed"}
        )

        assert failed["items"][0]["error_code"] == "stale_entity_version"
        assert old_output.read_bytes() == b"cas-previous"
        current = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        assert current["shots"][0]["prompt"] == "edited while composing"
