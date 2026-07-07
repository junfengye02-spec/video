import pytest
from fastapi.testclient import TestClient

from server.app.artifact_sync import rewrite_workflow_artifacts
from server.app.main import create_app


TEXT_TEST_KEY = "txt-test-key-1234567890abcdef"
IMAGE_TEST_KEY = "img-test-key-1234567890abcdef"
VIDEO_TEST_KEY = "vid-test-key-1234567890abcdef"

def _create_project_with_fake_generator(client):
    return client.post(
        "/api/projects/short-drama",
        json={
            "title": "Rain Alley",
            "prompt": "rain-night urban reversal short drama",
            "text_key": TEXT_TEST_KEY,
            "image_key": IMAGE_TEST_KEY,
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "image_model": "gpt-image-2",
            "video_model": "omni_flash-10s",
        },
    ).json()


def _fake_storyboard_result() -> dict:
    return {
        "series_bible": {
            "title": "Rain Alley",
            "mode": "short_drama",
            "style_lock": "rainy neon suspense",
            "characters": [
                {
                    "id": "c1",
                    "name": "Lin",
                    "role": "lead investigator",
                    "visual_lock": "red coat, short hair",
                    "voice": None,
                    "reference_images": [],
                    "locked": True,
                },
                {
                    "id": "c2",
                    "name": "Chen",
                    "role": "boss hiding the truth",
                    "visual_lock": "black suit, silver glasses",
                    "voice": None,
                    "reference_images": [],
                    "locked": True,
                },
            ],
        },
        "storyboard": {
            "shots": [
                {
                    "id": "s1",
                    "scene_id": "scene-1",
                    "index": 1,
                    "beat": "Hook",
                    "prompt": "Lin in red coat finds the envelope.",
                    "characters": ["c1"],
                    "location": "rainy alley",
                    "props": ["envelope"],
                    "shot_intent": "Reveal the clue.",
                    "shot_language": {"shot_size": "medium_close", "camera_movement": "dolly_in"},
                    "status": "ready",
                    "consistency_score": 100,
                    "output_url": None,
                    "output_path": None,
                    "asset_ids": [],
                    "version": 1,
                    "history": [],
                },
                {
                    "id": "s2",
                    "scene_id": "scene-1",
                    "index": 2,
                    "beat": "Confrontation",
                    "prompt": "Chen corners Lin at the elevator.",
                    "characters": ["c1", "c2"],
                    "location": "office elevator lobby",
                    "props": ["security badge"],
                    "shot_intent": "Show the antagonist applying pressure.",
                    "shot_language": {"shot_size": "medium", "camera_movement": "tracking_right"},
                    "status": "ready",
                    "consistency_score": 100,
                    "output_url": None,
                    "output_path": None,
                    "asset_ids": [],
                    "version": 1,
                    "history": [],
                },
                {
                    "id": "s3",
                    "scene_id": "scene-2",
                    "index": 3,
                    "beat": "Witness",
                    "prompt": "Aunt Mei reveals the recording.",
                    "characters": ["c1"],
                    "location": "tea shop doorway",
                    "props": ["phone"],
                    "shot_intent": "Deepen the conspiracy with a witness reveal.",
                    "shot_language": {"shot_size": "over_shoulder", "camera_movement": "rack_focus"},
                    "status": "ready",
                    "consistency_score": 100,
                    "output_url": None,
                    "output_path": None,
                    "asset_ids": [],
                    "version": 1,
                    "history": [],
                },
                {
                    "id": "s4",
                    "scene_id": "scene-2",
                    "index": 4,
                    "beat": "Reversal",
                    "prompt": "Lin confronts Chen under the billboard.",
                    "characters": ["c1", "c2"],
                    "location": "rainy alley",
                    "props": ["phone"],
                    "shot_intent": "Flip the power dynamic.",
                    "shot_language": {"shot_size": "medium_wide", "camera_movement": "handheld"},
                    "status": "ready",
                    "consistency_score": 100,
                    "output_url": None,
                    "output_path": None,
                    "asset_ids": [],
                    "version": 1,
                    "history": [],
                },
            ]
        },
    }


def _fake_valid_gateway(**kwargs):
    return {"valid": True, "errors": []}


@pytest.fixture(autouse=True)
def stub_storyboard_generator(monkeypatch):
    monkeypatch.setattr(
        "server.app.main.generate_short_drama_storyboard",
        lambda **kwargs: _fake_storyboard_result(),
    )


def test_key_session_returns_masked_key(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    monkeypatch.setattr("server.app.main.validate_gateway_models", _fake_valid_gateway)

    response = client.post(
        "/api/session/key",
        json={
            "text_key": TEXT_TEST_KEY,
            "image_key": IMAGE_TEST_KEY,
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "image_model": "gpt-image-2",
            "video_model": "veo_3_1-lite",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True
    assert body["masked_keys"]["text"] == "txt-...cdef"
    assert body["masked_keys"]["image"] == "img-...cdef"
    assert body["masked_keys"]["video"] == "vid-...cdef"
    assert body["models"] == {
        "text": "gpt-5.5",
        "image": "gpt-image-2",
        "video": "veo_3_1-lite",
    }


def test_key_session_returns_validation_failure(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    monkeypatch.setattr(
        "server.app.main.validate_gateway_models",
        lambda **kwargs: {"valid": False, "errors": ["video model 'omni_flash-10s' was not returned"]},
    )

    response = client.post(
        "/api/session/key",
        json={
            "text_key": TEXT_TEST_KEY,
            "image_key": IMAGE_TEST_KEY,
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "image_model": "gpt-image-2",
            "video_model": "omni_flash-10s",
        },
    )

    assert response.status_code == 400
    assert "video model" in response.json()["detail"]


def test_create_short_drama_project_returns_storyboard(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    response = client.post(
        "/api/projects/short-drama",
        json={
            "title": "Rain Alley",
            "prompt": "rain-night urban reversal short drama",
            "text_key": TEXT_TEST_KEY,
            "image_key": IMAGE_TEST_KEY,
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "image_model": "gpt-image-2",
            "video_model": "omni_flash-10s",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["project"]["title"] == "Rain Alley"
    assert len(body["series_bible"]["characters"]) >= 2
    assert len(body["storyboard"]["shots"]) >= 4


def test_create_short_drama_project_uses_text_model_storyboard_generator(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    calls = []

    def fake_generate_short_drama_storyboard(**kwargs):
        calls.append(kwargs)
        return _fake_storyboard_result()

    monkeypatch.setattr("server.app.main.generate_short_drama_storyboard", fake_generate_short_drama_storyboard)

    response = client.post(
        "/api/projects/short-drama",
        json={
            "title": "Rain Alley",
            "prompt": "rain-night urban reversal short drama",
            "text_key": TEXT_TEST_KEY,
            "image_key": IMAGE_TEST_KEY,
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "image_model": "gpt-image-2",
            "video_model": "omni_flash-10s",
        },
    )

    assert response.status_code == 200
    assert calls[0]["model"] == "gpt-5.5"
    assert calls[0]["api_key"] == TEXT_TEST_KEY
    assert response.json()["storyboard"]["shots"][0]["shot_language"]["shot_size"] == "medium_close"


def test_create_short_drama_project_returns_502_without_persisting_partial_project(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    def failing_generate_short_drama_storyboard(**kwargs):
        raise RuntimeError("upstream timeout")

    monkeypatch.setattr("server.app.main.generate_short_drama_storyboard", failing_generate_short_drama_storyboard)

    response = client.post(
        "/api/projects/short-drama",
        json={
            "title": "Rain Alley",
            "prompt": "rain-night urban reversal short drama",
            "text_key": TEXT_TEST_KEY,
            "image_key": IMAGE_TEST_KEY,
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "image_model": "gpt-image-2",
            "video_model": "omni_flash-10s",
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"].startswith("Text model storyboard generation failed:")
    assert list((tmp_path / "projects").iterdir()) == []


def test_load_project_returns_written_artifacts(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    created = client.post(
        "/api/projects/short-drama",
        json={
            "title": "Rain Alley",
            "prompt": "rain-night urban reversal short drama",
            "text_key": TEXT_TEST_KEY,
            "image_key": IMAGE_TEST_KEY,
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "image_model": "gpt-image-2",
            "video_model": "omni_flash-10s",
        },
    ).json()

    response = client.get(f"/api/projects/{created['project']['id']}")

    assert response.status_code == 200
    body = response.json()
    assert body["project"]["id"] == created["project"]["id"]
    assert body["series_bible"]["characters"][0]["id"] == "c1"
    assert len(body["storyboard"]["shots"]) >= 4


def test_regenerate_shot_updates_storyboard_and_emits_event(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]

    def fake_run_single_shot_generation(**kwargs):
        return {
            "shot_id": shot_id,
            "output_path": str(kwargs["project_dir"] / "assets" / "video" / f"{shot_id}.mp4"),
            "tool_result": {"url": "https://video.example/s1.mp4"},
            "cost_usd": 0.2,
        }

    monkeypatch.setattr("server.app.main.run_single_shot_generation", fake_run_single_shot_generation)

    response = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"video_key": VIDEO_TEST_KEY, "base_url": "https://api.0000238.xyz", "video_model": "omni_flash-10s"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["event"]["status"] == "complete"
    assert body["event"]["stage"] == "regenerate"
    assert body["shot"]["status"] == "complete"
    assert body["shot"]["output_path"].endswith("s1.mp4")


def test_regenerate_shot_persists_updated_storyboard(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]

    def fake_run_single_shot_generation(**kwargs):
        return {
            "shot_id": shot_id,
            "output_path": str(kwargs["project_dir"] / "assets" / "video" / f"{shot_id}.mp4"),
            "tool_result": {"url": "https://video.example/s1.mp4"},
            "cost_usd": 0.2,
        }

    monkeypatch.setattr("server.app.main.run_single_shot_generation", fake_run_single_shot_generation)

    client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"video_key": VIDEO_TEST_KEY, "base_url": "https://api.0000238.xyz", "video_model": "omni_flash-10s"},
    )
    loaded = client.get(f"/api/projects/{project_id}").json()

    assert loaded["storyboard"]["shots"][0]["status"] == "complete"
    assert loaded["storyboard"]["shots"][0]["output_url"] == "https://video.example/s1.mp4"


def test_save_shot_does_not_generate_video_or_emit_regenerate_event(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]
    calls = []

    def fake_run_single_shot_generation(**kwargs):
        calls.append(kwargs)
        raise AssertionError("save route should not trigger shot generation")

    monkeypatch.setattr("server.app.main.run_single_shot_generation", fake_run_single_shot_generation)

    response = client.patch(
        f"/api/projects/{project_id}/shots/{shot_id}",
        json={
            "prompt": "Lin pauses under the neon sign.",
            "characters": ["c1"],
            "location": "rainy alley",
            "props": ["envelope"],
            "asset_ids": [],
            "shot_intent": "Hold tension before the clue reveal.",
            "shot_language": {"shot_size": "medium", "camera_movement": "static"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["event"]["stage"] == "save"
    assert body["event"]["status"] == "complete"
    assert body["shot"]["status"] == "ready"
    assert body["shot"]["output_path"] is None
    assert body["shot"]["history"][-1]["source"] == "prompt_edit"
    assert calls == []

    loaded = client.get(f"/api/projects/{project_id}")
    assert loaded.status_code == 200
    reloaded_shot = loaded.json()["storyboard"]["shots"][0]
    assert reloaded_shot["status"] == "ready"
    assert reloaded_shot["output_path"] is None
    assert reloaded_shot["output_url"] is None


def test_save_shot_clears_previous_render_state_after_metadata_change(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]

    def fake_run_single_shot_generation(**kwargs):
        return {
            "shot_id": shot_id,
            "output_path": str(kwargs["project_dir"] / "assets" / "video" / f"{shot_id}.mp4"),
            "tool_result": {"url": "https://video.example/s1.mp4"},
            "cost_usd": 0.2,
        }

    monkeypatch.setattr("server.app.main.run_single_shot_generation", fake_run_single_shot_generation)

    regenerated = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"video_key": VIDEO_TEST_KEY, "base_url": "https://api.0000238.xyz", "video_model": "omni_flash-10s"},
    )
    assert regenerated.status_code == 200
    assert regenerated.json()["shot"]["output_url"] == "https://video.example/s1.mp4"

    response = client.patch(
        f"/api/projects/{project_id}/shots/{shot_id}",
        json={"prompt": "Lin pauses under the neon sign with a new reveal.", "location": "rainy alley"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["shot"]["output_path"] is None
    assert body["shot"]["output_url"] is None
    assert body["shot"]["status"] == "ready"
    assert body["shot"]["version"] == 2


def test_save_shot_succeeds_without_provider_fields(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]

    response = client.patch(
        f"/api/projects/{project_id}/shots/{shot_id}",
        json={
            "prompt": "Lin pauses under the neon sign.",
            "characters": ["c1"],
            "location": "rainy alley",
            "props": ["envelope"],
            "asset_ids": [],
            "shot_intent": "Hold tension before the clue reveal.",
            "shot_language": {"shot_size": "medium", "camera_movement": "static"},
        },
    )

    assert response.status_code == 200
    assert response.json()["event"]["stage"] == "save"


def test_save_shot_can_clear_location_to_null(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]

    response = client.patch(f"/api/projects/{project_id}/shots/{shot_id}", json={"location": None})

    assert response.status_code == 200
    body = response.json()
    assert body["shot"]["location"] is None
    assert body["shot"]["version"] == 2
    assert body["shot"]["history"][-1]["location"] == "rainy alley"


def test_save_shot_refreshes_consistency_scores_after_recalculation(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]

    response = client.patch(f"/api/projects/{project_id}/shots/{shot_id}", json={"location": None})

    assert response.status_code == 200
    body = response.json()
    assert any(issue["code"] == "missing_location" for issue in body["consistency_report"]["issues"])
    assert body["shot"]["location"] is None
    assert body["shot"]["consistency_score"] < 100
    saved_shot = next(shot for shot in body["storyboard"]["shots"] if shot["id"] == shot_id)
    assert saved_shot["consistency_score"] < 100

    loaded = client.get(f"/api/projects/{project_id}")
    assert loaded.status_code == 200
    persisted_shot = next(shot for shot in loaded.json()["storyboard"]["shots"] if shot["id"] == shot_id)
    assert persisted_shot["consistency_score"] < 100


def test_save_shot_noop_does_not_increment_version_or_history(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot = created["storyboard"]["shots"][0]

    response = client.patch(
        f"/api/projects/{project_id}/shots/{shot['id']}",
        json={
            "prompt": shot["prompt"],
            "characters": shot["characters"],
            "location": shot["location"],
            "props": shot["props"],
            "asset_ids": shot["asset_ids"],
            "shot_intent": shot["shot_intent"],
            "shot_language": shot["shot_language"],
        },
    )

    assert response.status_code == 200
    saved = response.json()["shot"]
    assert saved["version"] == shot["version"]
    assert saved["history"] == shot["history"]
    assert saved["status"] == shot["status"]


def test_regenerate_shot_generates_single_video(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]
    calls = []

    def fake_run_single_shot_generation(**kwargs):
        calls.append(kwargs)
        return {
            "shot_id": shot_id,
            "output_path": str(kwargs["project_dir"] / "assets" / "video" / f"{shot_id}.mp4"),
            "tool_result": {"url": "https://video.example/s1.mp4"},
            "cost_usd": 0.2,
        }

    monkeypatch.setattr("server.app.main.run_single_shot_generation", fake_run_single_shot_generation)

    response = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"video_key": VIDEO_TEST_KEY, "base_url": "https://api.0000238.xyz", "video_model": "omni_flash-10s"},
    )

    assert response.status_code == 200
    body = response.json()
    assert calls[0]["video_model"] == "omni_flash-10s"
    assert body["event"]["stage"] == "regenerate"
    assert body["shot"]["output_url"] == "https://video.example/s1.mp4"
    assert body["shot"]["status"] == "complete"


def test_regenerate_shot_returns_sanitized_generation_summary(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]

    def fake_run_single_shot_generation(**kwargs):
        project_dir = kwargs["project_dir"]
        reference = project_dir / "assets" / "images" / "character" / "lin.png"
        reference.parent.mkdir(parents=True)
        reference.write_bytes(b"fake png")
        return {
            "shot_id": shot_id,
            "output_path": str(project_dir / "assets" / "video" / f"{shot_id}.mp4"),
            "tool_result": {
                "url": "https://video.example/s1.mp4",
                "operation": "reference_to_video",
                "output_path": str(project_dir / "assets" / "video" / "tool-result.mp4"),
            },
            "cost_usd": 0.2,
            "operation": "reference_to_video",
            "reference_image_paths": [str(reference)],
        }

    monkeypatch.setattr("server.app.main.run_single_shot_generation", fake_run_single_shot_generation)

    response = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "video_model": "omni_flash-10s",
        },
    )

    assert response.status_code == 200
    body = response.json()

    def collect_strings(value):
        if isinstance(value, dict):
            for item in value.values():
                yield from collect_strings(item)
        elif isinstance(value, list):
            for item in value:
                yield from collect_strings(item)
        elif isinstance(value, str):
            yield value

    leaked_values = [item for item in collect_strings(body) if str(tmp_path) in item]
    assert leaked_values == []
    assert set(body["generation"].keys()) == {"operation", "reference_image_paths", "output_path", "cost_usd"}
    assert body["generation"]["operation"] == "reference_to_video"
    assert body["generation"]["reference_image_paths"] == ["assets/images/character/lin.png"]
    assert body["generation"]["output_path"] == f"assets/video/{shot_id}.mp4"


def test_regenerate_shot_requires_video_key(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]

    response = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"base_url": "https://api.0000238.xyz", "video_model": "omni_flash-10s"},
    )

    assert response.status_code == 422


def test_regenerate_shot_rejects_whitespace_only_video_key(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]
    calls = []

    def fake_run_single_shot_generation(**kwargs):
        calls.append(kwargs)
        raise AssertionError("validation should reject whitespace-only video keys before generation")

    monkeypatch.setattr("server.app.main.run_single_shot_generation", fake_run_single_shot_generation)

    response = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"video_key": "   ", "base_url": "https://api.0000238.xyz", "video_model": "omni_flash-10s"},
    )

    assert response.status_code == 422
    assert calls == []


def test_save_shot_accepts_prompt_edits_and_tracks_history(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]

    response = client.patch(
        f"/api/projects/{project_id}/shots/{shot_id}",
        json={
            "prompt": "Lin stops under neon rain and opens the soaked envelope.",
            "characters": ["c1"],
            "location": "rainy neon alley",
            "props": ["envelope"],
            "asset_ids": ["asset-c1-ref"],
            "shot_intent": "Reveal the clue with a more deliberate pause.",
            "shot_language": {"shot_size": "medium", "camera_movement": "static"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["shot"]["version"] == 2
    assert body["shot"]["prompt"].startswith("Lin stops under neon rain")
    assert body["shot"]["asset_ids"] == ["asset-c1-ref"]
    assert body["shot"]["history"][-1]["source"] == "prompt_edit"
    assert body["shot"]["history"][-1]["version"] == 1
    assert body["shot"]["history"][-1]["shot_intent"] == "Reveal the clue."
    assert body["shot"]["history"][-1]["shot_language"]["shot_size"] == "medium_close"
    assert body["shot"]["shot_intent"] == "Reveal the clue with a more deliberate pause."
    assert body["shot"]["shot_language"]["shot_size"] == "medium"


def test_save_shot_updates_asset_shot_ids_and_rewrites_workflow_artifacts(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]
    store = app.state.store
    series_bible = store.read_artifact(project_id, "series_bible.json")
    assert series_bible is not None
    series_bible["assets"] = [
        {
            "id": "asset-c1-ref",
            "kind": "character",
            "label": "Lin reference",
            "description": "red coat",
            "prompt": "red coat",
            "reference_images": ["assets/images/character/asset-c1-ref.png"],
            "shot_ids": [],
            "version": 1,
        }
    ]
    store.write_artifact(project_id, "series_bible.json", series_bible)

    response = client.patch(
        f"/api/projects/{project_id}/shots/{shot_id}",
        json={
            "asset_ids": ["asset-c1-ref"],
            "prompt": "Lin in red coat finds the envelope.",
            "characters": ["c1"],
            "location": "rainy alley",
            "props": ["envelope"],
            "shot_intent": "Reveal the clue.",
            "shot_language": {"shot_size": "medium_close", "camera_movement": "dolly_in"},
        },
    )

    assert response.status_code == 200
    loaded = client.get(f"/api/projects/{project_id}").json()
    assert loaded["series_bible"]["assets"][0]["shot_ids"] == [shot_id]
    asset_library = store.read_artifact(project_id, "asset_library.json")
    assert asset_library is not None
    assert asset_library["assets"][0]["shot_ids"] == [shot_id]
    scene_plan = store.read_artifact(project_id, "scene_plan.json")
    assert scene_plan is not None
    assert scene_plan["scenes"][0]["description"] == "Lin in red coat finds the envelope."


def test_save_shot_preserves_existing_workflow_video_model_on_metadata_only_save(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    created = client.post(
        "/api/projects/short-drama",
        json={
            "title": "Rain Alley",
            "prompt": "rain-night urban reversal short drama",
            "text_key": TEXT_TEST_KEY,
            "image_key": IMAGE_TEST_KEY,
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "image_model": "gpt-image-2",
            "video_model": "veo_3_1-lite",
        },
    ).json()
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]
    store = app.state.store

    response = client.patch(
        f"/api/projects/{project_id}/shots/{shot_id}",
        json={"shot_intent": "Hold the reveal a beat longer."},
    )

    assert response.status_code == 200
    proposal_packet = store.read_artifact(project_id, "proposal_packet.json")
    asset_manifest = store.read_artifact(project_id, "asset_manifest.json")
    edit_decisions = store.read_artifact(project_id, "edit_decisions.json")
    assert proposal_packet is not None
    assert asset_manifest is not None
    assert edit_decisions is not None
    assert proposal_packet["cost_estimate"]["line_items"][0]["model"] == "veo_3_1-lite"
    assert asset_manifest["assets"][0]["model"] == "veo_3_1-lite"
    assert edit_decisions["render_runtime"] == "ffmpeg"


def test_regenerate_shot_updates_asset_shot_ids_and_rewrites_workflow_artifacts(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]
    store = app.state.store
    series_bible = store.read_artifact(project_id, "series_bible.json")
    storyboard = store.read_artifact(project_id, "episode_storyboard.json")
    assert series_bible is not None
    assert storyboard is not None
    series_bible["assets"] = [
        {
            "id": "asset-c1-ref",
            "kind": "character",
            "label": "Lin reference",
            "description": "red coat",
            "prompt": "red coat",
            "reference_images": ["assets/images/character/asset-c1-ref.png"],
            "shot_ids": [],
            "version": 1,
        }
    ]
    storyboard["shots"][0]["asset_ids"] = ["asset-c1-ref"]
    store.write_artifact(project_id, "series_bible.json", series_bible)
    store.write_artifact(project_id, "episode_storyboard.json", storyboard)
    rewrite_workflow_artifacts(
        workbench=store,
        project_id=project_id,
        series_bible=series_bible,
        storyboard=storyboard,
        render_runtime="remotion",
        video_model="omni_flash-10s",
    )

    def fake_run_single_shot_generation(**kwargs):
        return {
            "shot_id": shot_id,
            "output_path": str(kwargs["project_dir"] / "assets" / "video" / f"{shot_id}.mp4"),
            "tool_result": {"url": "https://video.example/s1.mp4"},
            "cost_usd": 0.2,
        }

    monkeypatch.setattr("server.app.main.run_single_shot_generation", fake_run_single_shot_generation)

    response = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"video_key": VIDEO_TEST_KEY, "base_url": "https://api.0000238.xyz", "video_model": "veo_3_1-lite"},
    )

    assert response.status_code == 200
    loaded = client.get(f"/api/projects/{project_id}").json()
    proposal_packet = store.read_artifact(project_id, "proposal_packet.json")
    asset_manifest = store.read_artifact(project_id, "asset_manifest.json")
    edit_decisions = store.read_artifact(project_id, "edit_decisions.json")
    assert loaded["series_bible"]["assets"][0]["shot_ids"] == [shot_id]
    asset_library = store.read_artifact(project_id, "asset_library.json")
    assert asset_library is not None
    assert asset_library["assets"][0]["shot_ids"] == [shot_id]
    assert proposal_packet is not None
    assert asset_manifest is not None
    assert edit_decisions is not None
    assert proposal_packet["cost_estimate"]["line_items"][0]["model"] == "veo_3_1-lite"
    assert asset_manifest["assets"][0]["model"] == "veo_3_1-lite"
    assert edit_decisions["render_runtime"] == "remotion"


def test_regenerate_shot_failure_updates_asset_library_shot_ids_before_rewriting_artifacts(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]
    store = app.state.store
    series_bible = store.read_artifact(project_id, "series_bible.json")
    storyboard = store.read_artifact(project_id, "episode_storyboard.json")
    assert series_bible is not None
    assert storyboard is not None
    series_bible["assets"] = [
        {
            "id": "asset-c1-ref",
            "kind": "character",
            "label": "Lin reference",
            "description": "red coat",
            "prompt": "red coat",
            "reference_images": ["assets/images/character/asset-c1-ref.png"],
            "shot_ids": [],
            "version": 1,
        }
    ]
    storyboard["shots"][0]["asset_ids"] = ["asset-c1-ref"]
    store.write_artifact(project_id, "series_bible.json", series_bible)
    store.write_artifact(project_id, "episode_storyboard.json", storyboard)

    def fake_failing_generation(**kwargs):
        raise RuntimeError("video provider timeout")

    monkeypatch.setattr("server.app.main.run_single_shot_generation", fake_failing_generation)

    response = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"video_key": VIDEO_TEST_KEY, "base_url": "https://api.0000238.xyz", "video_model": "veo_3_1-lite"},
    )

    assert response.status_code == 500
    asset_library = store.read_artifact(project_id, "asset_library.json")
    assert asset_library is not None
    assert asset_library["assets"][0]["shot_ids"] == [shot_id]


def test_regenerate_shot_failure_persists_failed_status_and_clears_outputs(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]

    def fake_successful_generation(**kwargs):
        return {
            "shot_id": shot_id,
            "output_path": str(kwargs["project_dir"] / "assets" / "video" / f"{shot_id}.mp4"),
            "tool_result": {"url": "https://video.example/s1.mp4"},
            "cost_usd": 0.2,
        }

    monkeypatch.setattr("server.app.main.run_single_shot_generation", fake_successful_generation)
    first_response = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"video_key": VIDEO_TEST_KEY, "base_url": "https://api.0000238.xyz", "video_model": "omni_flash-10s"},
    )
    assert first_response.status_code == 200
    assert first_response.json()["shot"]["output_url"] == "https://video.example/s1.mp4"

    def fake_failing_generation(**kwargs):
        raise RuntimeError("video provider timeout")

    monkeypatch.setattr("server.app.main.run_single_shot_generation", fake_failing_generation)
    failed_response = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"video_key": VIDEO_TEST_KEY, "base_url": "https://api.0000238.xyz", "video_model": "omni_flash-10s"},
    )
    assert failed_response.status_code == 500
    assert failed_response.json()["detail"] == "video provider timeout"

    loaded = client.get(f"/api/projects/{project_id}")
    assert loaded.status_code == 200
    reloaded_shot = loaded.json()["storyboard"]["shots"][0]
    assert reloaded_shot["status"] == "failed"
    assert reloaded_shot["output_path"] is None
    assert reloaded_shot["output_url"] is None


def test_optimize_prompt_route_returns_structured_shot_fields(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    optimize_calls = []

    def fake_optimize_text_prompt(**kwargs):
        optimize_calls.append(kwargs)
        return {
            "optimized_text": "Lin in red coat opens the soaked envelope under neon rain.",
            "shot_intent": "Push into the clue as Lin realizes the betrayal.",
            "shot_language": {
                "shot_size": "close_up",
                "camera_movement": "dolly_in",
                "lens_mm": 85,
                "depth_of_field": "shallow",
            },
            "notes": ["rewritten by text model as structured shot JSON"],
        }

    monkeypatch.setattr("server.app.main.optimize_text_prompt", fake_optimize_text_prompt)

    response = client.post(
        f"/api/projects/{project_id}/prompt-optimize",
        json={
            "target": "shot",
            "target_id": "s1",
            "source_text": "Lin opens envelope.",
            "text_key": TEXT_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "mode": "shot_json",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["optimized_text"].startswith("Lin in red coat")
    assert body["shot_intent"].startswith("Push into")
    assert body["shot_language"]["camera_movement"] == "dolly_in"
    assert optimize_calls[0]["context"] == {"target": "shot", "target_id": "s1", "mode": "shot_json"}


def test_optimize_prompt_route_defaults_blank_base_url_and_text_mode(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    optimize_calls = []

    def fake_optimize_text_prompt(**kwargs):
        optimize_calls.append(kwargs)
        return {
            "optimized_text": "Tighten the alley prompt around Lin's discovery and the rain-soaked envelope.",
            "notes": ["rewritten by text model"],
        }

    monkeypatch.setattr("server.app.main.optimize_text_prompt", fake_optimize_text_prompt)

    response = client.post(
        f"/api/projects/{project_id}/prompt-optimize",
        json={
            "target": "shot",
            "target_id": "s1",
            "source_text": "Lin opens envelope.",
            "text_key": TEXT_TEST_KEY,
            "base_url": "   ",
            "text_model": "gpt-5.5",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["optimized_text"].startswith("Tighten the alley prompt")
    assert body["notes"] == ["rewritten by text model"]
    assert optimize_calls[0]["base_url"] == "https://api.0000238.xyz"
    assert optimize_calls[0]["context"] == {"target": "shot", "target_id": "s1", "mode": "text"}


def test_optimize_prompt_route_returns_502_for_invalid_structured_response(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]

    def fake_optimize_text_prompt(**kwargs):
        return {
            "optimized_text": "Lin in red coat opens the soaked envelope under neon rain.",
            "shot_intent": "Push into the clue as Lin realizes the betrayal.",
            "shot_language": {
                "camera_movement": "teleport_sideways",
            },
            "notes": ["rewritten by text model as structured shot JSON"],
        }

    monkeypatch.setattr("server.app.main.optimize_text_prompt", fake_optimize_text_prompt)

    response = client.post(
        f"/api/projects/{project_id}/prompt-optimize",
        json={
            "target": "shot",
            "target_id": "s1",
            "source_text": "Lin opens envelope.",
            "text_key": TEXT_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "mode": "shot_json",
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"].startswith("Text model prompt optimization failed:")


def test_optimize_prompt_route_rejects_whitespace_only_text_key(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]

    response = client.post(
        f"/api/projects/{project_id}/prompt-optimize",
        json={
            "target": "shot",
            "target_id": "s1",
            "source_text": "Lin opens envelope.",
            "text_key": "   ",
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
        },
    )

    assert response.status_code == 422


def test_render_project_generates_final_video_and_updates_storyboard(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    created = client.post(
        "/api/projects/short-drama",
        json={
            "title": "Rain Alley",
            "prompt": "rain-night urban reversal short drama",
            "text_key": TEXT_TEST_KEY,
            "image_key": IMAGE_TEST_KEY,
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "image_model": "gpt-image-2",
            "video_model": "omni_flash-10s",
        },
    ).json()
    project_id = created["project"]["id"]

    captured_render_kwargs = {}

    def fake_render_short_drama_project(**kwargs):
        captured_render_kwargs.update(kwargs)
        project_dir = kwargs["project_dir"]
        storyboard = kwargs["storyboard"]
        for shot in storyboard["shots"]:
            shot["status"] = "complete"
            shot["output_path"] = str(project_dir / "assets" / "video" / f"{shot['id']}.mp4")
        final_path = project_dir / "renders" / "final.mp4"
        final_path.parent.mkdir(parents=True, exist_ok=True)
        final_path.write_bytes(b"fake video")
        return {
            "final_path": str(final_path),
            "render_report": {
                "version": "1.0",
                "outputs": [
                    {
                        "path": str(final_path),
                        "format": "mp4",
                        "resolution": "720x1280",
                        "duration_seconds": 25,
                    }
                ],
                "warnings": [],
                "verification_notes": ["fake render"],
            },
            "storyboard": storyboard,
            "artifacts": {},
            "outputs": [],
        }

    monkeypatch.setattr("server.app.main.render_short_drama_project", fake_render_short_drama_project)

    response = client.post(
        f"/api/projects/{project_id}/render",
        json={
            "text_key": TEXT_TEST_KEY,
            "image_key": IMAGE_TEST_KEY,
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "image_model": "gpt-image-2",
            "video_model": "veo_3_1-lite",
            "render_runtime": "ffmpeg",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["render_report"]["outputs"][0]["path"].endswith("final.mp4")
    assert body["storyboard"]["shots"][0]["status"] == "complete"
    assert body["storyboard"]["shots"][0]["output_path"].endswith("s1.mp4")
    assert captured_render_kwargs["video_key"] == VIDEO_TEST_KEY
    assert captured_render_kwargs["video_model"] == "veo_3_1-lite"

    loaded = client.get(f"/api/projects/{project_id}").json()
    assert loaded["storyboard"]["shots"][0]["status"] == "complete"
    assert loaded["final_path"].endswith("final.mp4")
    assert loaded["render_report"]["outputs"][0]["path"].endswith("final.mp4")


def test_render_project_sanitizes_response_absolute_paths(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    created = client.post(
        "/api/projects/short-drama",
        json={
            "title": "Rain Alley",
            "prompt": "rain-night urban reversal short drama",
            "text_key": TEXT_TEST_KEY,
            "image_key": IMAGE_TEST_KEY,
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "image_model": "gpt-image-2",
            "video_model": "omni_flash-10s",
        },
    ).json()
    project_id = created["project"]["id"]

    def fake_render_short_drama_project(**kwargs):
        project_dir = kwargs["project_dir"]
        storyboard = kwargs["storyboard"]
        reference_image = project_dir / "assets" / "images" / "character" / "lin.png"
        reference_image.parent.mkdir(parents=True, exist_ok=True)
        reference_image.write_bytes(b"fake reference image")

        for shot in storyboard["shots"]:
            shot["status"] = "complete"
            shot["output_path"] = str(project_dir / "assets" / "video" / f"{shot['id']}.mp4")

        final_path = project_dir / "renders" / "final.mp4"
        final_path.parent.mkdir(parents=True, exist_ok=True)
        final_path.write_bytes(b"fake video")
        generation_output = {
            "operation": "reference_to_video",
            "reference_image_paths": [str(reference_image)],
            "output_path": str(project_dir / "assets" / "video" / "s1.mp4"),
            "cost_usd": 0.2,
            "tool_result": {"url": "https://video.example/s1.mp4", "provider": "syapi"},
        }
        return {
            "final_path": str(final_path),
            "render_report": {
                "version": "1.0",
                "outputs": [
                    {
                        "path": str(final_path),
                        "format": "mp4",
                        "resolution": "720x1280",
                        "duration_seconds": 25,
                    }
                ],
                "warnings": [],
                "verification_notes": ["fake render"],
            },
            "storyboard": storyboard,
            "artifacts": {},
            "outputs": [generation_output],
        }

    monkeypatch.setattr("server.app.main.render_short_drama_project", fake_render_short_drama_project)

    response = client.post(
        f"/api/projects/{project_id}/render",
        json={
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "video_model": "veo_3_1-lite",
            "render_runtime": "ffmpeg",
        },
    )

    assert response.status_code == 200
    body = response.json()

    def collect_strings(value):
        if isinstance(value, dict):
            for item in value.values():
                yield from collect_strings(item)
        elif isinstance(value, list):
            for item in value:
                yield from collect_strings(item)
        elif isinstance(value, str):
            yield value

    leaked_values = [item for item in collect_strings(body) if str(tmp_path) in item]
    assert leaked_values == []
    assert body["storyboard"]["shots"][0]["output_path"] == "assets/video/s1.mp4"
    assert body["render_report"]["outputs"][0]["path"] == "renders/final.mp4"
    assert body["final_path"] == "renders/final.mp4"
    assert body["outputs"][0]["output_path"] == "assets/video/s1.mp4"
    assert body["outputs"][0]["reference_image_paths"] == ["assets/images/character/lin.png"]
    assert "tool_result" not in body["outputs"][0]


def test_load_project_returns_render_report_and_final_path_after_render(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]

    def fake_render_short_drama_project(**kwargs):
        final_path = kwargs["project_dir"] / "renders" / "final.mp4"
        final_path.parent.mkdir(parents=True, exist_ok=True)
        final_path.write_bytes(b"fake video")
        return {
            "final_path": str(final_path),
            "render_report": {
                "version": "1.0",
                "outputs": [
                    {
                        "path": str(final_path),
                        "format": "mp4",
                        "resolution": "720x1280",
                        "duration_seconds": 5,
                    }
                ],
                "warnings": [],
                "verification_notes": ["fake render"],
            },
            "storyboard": kwargs["storyboard"],
            "artifacts": {},
            "outputs": [],
        }

    monkeypatch.setattr("server.app.main.render_short_drama_project", fake_render_short_drama_project)

    response = client.post(
        f"/api/projects/{project_id}/render",
        json={
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "video_model": "omni_flash-10s",
            "render_runtime": "ffmpeg",
        },
    )

    assert response.status_code == 200
    loaded = client.get(f"/api/projects/{project_id}").json()

    assert loaded["final_path"].endswith("final.mp4")
    assert loaded["render_report"]["outputs"][0]["path"].endswith("final.mp4")


def test_get_project_sanitizes_persisted_absolute_paths(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    store = app.state.store
    project_dir = store.project_dir(project_id)

    shot_output = project_dir / "assets" / "video" / "s1.mp4"
    shot_output.write_bytes(b"fake shot video")
    render_output = project_dir / "renders" / "final.mp4"
    render_output.write_bytes(b"fake final video")
    alt_output = project_dir / "assets" / "video" / "preview.mp4"
    alt_output.write_bytes(b"fake preview video")

    storyboard = store.read_artifact(project_id, "episode_storyboard.json")
    assert storyboard is not None
    storyboard["shots"][0]["output_path"] = str(shot_output)
    store.write_artifact(project_id, "episode_storyboard.json", storyboard)
    store.write_artifact(
        project_id,
        "render_report.json",
        {
            "version": "1.0",
            "outputs": [
                {
                    "path": str(render_output),
                    "format": "mp4",
                    "resolution": "720x1280",
                    "duration_seconds": 5,
                },
                {
                    "path": str(alt_output),
                    "format": "mp4",
                    "resolution": "720x1280",
                    "duration_seconds": 2,
                },
            ],
            "warnings": [],
            "verification_notes": ["persisted absolute paths"],
        },
    )

    response = client.get(f"/api/projects/{project_id}")

    assert response.status_code == 200
    body = response.json()

    def collect_strings(value):
        if isinstance(value, dict):
            for item in value.values():
                yield from collect_strings(item)
        elif isinstance(value, list):
            for item in value:
                yield from collect_strings(item)
        elif isinstance(value, str):
            yield value

    leaked_values = [item for item in collect_strings(body) if str(project_dir) in item or str(tmp_path) in item]
    assert leaked_values == []
    assert body["storyboard"]["shots"][0]["output_path"] == "assets/video/s1.mp4"
    assert body["render_report"]["outputs"][0]["path"] == "renders/final.mp4"
    assert body["render_report"]["outputs"][1]["path"] == "assets/video/preview.mp4"
    assert body["final_path"] == "renders/final.mp4"


def test_render_project_returns_provider_error_detail(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    created = client.post(
        "/api/projects/short-drama",
        json={
            "title": "Rain Alley",
            "prompt": "rain-night urban reversal short drama",
            "text_key": TEXT_TEST_KEY,
            "image_key": IMAGE_TEST_KEY,
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "image_model": "gpt-image-2",
            "video_model": "omni_flash-10s",
        },
    ).json()
    project_id = created["project"]["id"]

    def fake_render_short_drama_project(**kwargs):
        raise RuntimeError(
            "SYAPI video HTTP error: POST https://api.0000238.xyz/v1/videos "
            "status=403 model=omni_flash-10s provider_error=video model forbidden"
        )

    monkeypatch.setattr("server.app.main.render_short_drama_project", fake_render_short_drama_project)

    response = client.post(
        f"/api/projects/{project_id}/render",
        json={
            "text_key": TEXT_TEST_KEY,
            "image_key": IMAGE_TEST_KEY,
            "video_key": VIDEO_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "image_model": "gpt-image-2",
            "video_model": "omni_flash-10s",
            "render_runtime": "ffmpeg",
        },
    )

    assert response.status_code == 500
    detail = response.json()["detail"]
    assert "POST https://api.0000238.xyz/v1/videos" in detail
    assert "status=403" in detail
    assert "model=omni_flash-10s" in detail
    assert "video model forbidden" in detail
