from fastapi.testclient import TestClient

from schemas.artifacts import validate_artifact
from server.app.billing.models import GenerationJob
from server.app.video_model_settings.service import VideoModelDurationService
from server.tests.test_api import _create_project_with_fake_generator, create_app


def _project_with_target(tmp_path, target: int = 20):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
    workflow["brief"] = {
        **(workflow.get("brief") or {}),
        "duration_seconds": target,
    }
    app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)
    return app, client, project_id


def test_video_model_catalog_exposes_operation_profiles(tmp_path):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    response = TestClient(app).get(
        "/api/generation/models", params={"capability": "video"}
    )

    assert response.status_code == 200
    profiles = response.json()["profiles"]
    omni_text = next(
        profile
        for profile in profiles
        if profile["model_id"] == "omni_flash-10s"
        and profile["operation"] == "text_to_video"
    )
    kling = next(profile for profile in profiles if profile["model_id"] == "kling-v2")
    assert omni_text["duration_mode"] == "fixed"
    assert omni_text["duration_configuration_status"] == "configured"
    assert omni_text["fixed_duration_seconds"] == 10
    assert omni_text["supports_sequential_beats"] is True
    assert omni_text["max_narrative_beats_per_unit"] == 2
    assert omni_text["profile_revision"]
    assert kling["duration_mode"] == "unknown"
    assert kling["duration_configuration_status"] == "unconfigured"


def test_database_only_new_model_configuration_builds_a_fixed_plan(tmp_path):
    app, client, project_id = _project_with_target(tmp_path, target=10)
    service = VideoModelDurationService(app.state.test_db)
    service.update(
        provider="newapi",
        model_id="provider-added-model",
        call_duration_seconds=10,
        expected_version=0,
        updated_by="api-test-user0000000000000000001",
        reason="test verification",
    )
    app.state.test_db.commit()
    storyboard = app.state.store.read_artifact(project_id, "episode_storyboard.json")
    shot_id = storyboard["shots"][0]["id"]

    response = client.post(
        f"/api/projects/{project_id}/generation-plan/preview",
        json={"video_model": "provider-added-model", "shot_ids": [shot_id]},
    )

    assert response.status_code == 200, response.text
    plan = response.json()
    assert plan["can_generate"] is True
    assert plan["generation_units"][0]["requested_duration_seconds"] == 10
    profile = plan["generation_units"][0]["profile"]
    assert profile["duration_mode"] == "fixed"
    assert profile["contract_source"] == "admin_configuration"


def test_generation_plan_preview_is_versioned_and_does_not_rewrite_storyboard(tmp_path):
    app, client, project_id = _project_with_target(tmp_path)
    storyboard = app.state.store.read_artifact(project_id, "episode_storyboard.json")
    shot_ids = [storyboard["shots"][0]["id"]]

    response = client.post(
        f"/api/projects/{project_id}/generation-plan/preview",
        json={"video_model": "omni_flash-10s", "shot_ids": shot_ids},
    )

    assert response.status_code == 200, response.text
    plan = response.json()
    assert plan["native_total_duration_seconds"] == 10
    assert plan["target_duration_seconds"] == 20
    assert plan["requires_confirmation"] is True
    assert plan["can_generate"] is False
    assert "accept_longer_duration" in plan["adaptation_options"]
    assert [unit["shot_ids"] for unit in plan["generation_units"]] == [[shot_ids[0]]]
    validate_artifact("generation_plan", plan)
    persisted_storyboard = app.state.store.read_artifact(
        project_id, "episode_storyboard.json"
    )
    assert all(
        "requested_duration_seconds" not in shot
        for shot in persisted_storyboard["shots"]
    )


def test_incompatible_duration_requires_explicit_native_duration_confirmation(tmp_path):
    app, client, project_id = _project_with_target(tmp_path)
    storyboard = app.state.store.read_artifact(project_id, "episode_storyboard.json")
    shot_ids = [storyboard["shots"][0]["id"]]
    preview = client.post(
        f"/api/projects/{project_id}/generation-plan/preview",
        json={"video_model": "omni_flash-10s", "shot_ids": shot_ids},
    ).json()

    blocked = client.post(
        f"/api/projects/{project_id}/shots/generate",
        json={
            "shot_ids": shot_ids,
            "video_model": "omni_flash-10s",
            "generation_plan_id": preview["id"],
            "idempotency_key": "duration-blocked",
        },
    )
    accepted = client.post(
        f"/api/projects/{project_id}/shots/generate",
        json={
            "shot_ids": shot_ids,
            "video_model": "omni_flash-10s",
            "generation_plan_id": preview["id"],
            "duration_strategy": "accept_model_duration",
            "idempotency_key": "duration-accepted",
        },
    )

    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "generation_plan_confirmation_required"
    assert accepted.status_code == 202, accepted.text
    snapshot = accepted.json()["task"]["snapshot"]["snapshot"]
    assert snapshot["generation_plan_id"] == preview["id"]
    assert [
        unit["requested_duration_seconds"] for unit in snapshot["generation_units"]
    ] == [10]


def test_unknown_model_contract_blocks_before_billed_task_creation(tmp_path):
    app, client, project_id = _project_with_target(tmp_path)
    storyboard = app.state.store.read_artifact(project_id, "episode_storyboard.json")
    shot_id = storyboard["shots"][0]["id"]

    response = client.post(
        f"/api/projects/{project_id}/shots/generate",
        json={
            "shot_ids": [shot_id],
            "video_model": "provider-added-model",
            "duration_strategy": "accept_model_duration",
            "idempotency_key": "unknown-contract",
        },
    )

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "generation_plan_blocked"
    assert (
        detail["generation_plan"]["issues"][0]["code"] == "video_model_contract_unknown"
    )


def test_unconfigured_model_blocks_render_before_job_creation(tmp_path):
    app, client, project_id = _project_with_target(tmp_path)
    jobs_before = app.state.test_db.query(GenerationJob).count()

    response = client.post(
        f"/api/projects/{project_id}/render",
        json={"video_model": "provider-added-model"},
    )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "video_model_contract_unknown"
    assert detail["duration_configuration_status"] == "unconfigured"
    assert detail["model_id"] == "provider-added-model"
    assert app.state.test_db.query(GenerationJob).count() == jobs_before


def test_duration_configuration_update_makes_old_preview_stale(tmp_path):
    app, client, project_id = _project_with_target(tmp_path, target=10)
    storyboard = app.state.store.read_artifact(project_id, "episode_storyboard.json")
    shot_id = storyboard["shots"][0]["id"]
    preview = client.post(
        f"/api/projects/{project_id}/generation-plan/preview",
        json={"video_model": "omni_flash-10s", "shot_ids": [shot_id]},
    ).json()
    service = VideoModelDurationService(app.state.test_db)
    service.update(
        provider="newapi",
        model_id="omni_flash-10s",
        call_duration_seconds=10,
        expected_version=1,
        updated_by="api-test-user0000000000000000001",
        reason="reverified contract",
    )
    app.state.test_db.commit()

    response = client.post(
        f"/api/projects/{project_id}/shots/generate",
        json={
            "shot_ids": [shot_id],
            "video_model": "omni_flash-10s",
            "generation_plan_id": preview["id"],
            "idempotency_key": "stale-duration-profile",
        },
    )

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "generation_plan_stale"
    assert detail["generation_plan"]["id"] != preview["id"]
