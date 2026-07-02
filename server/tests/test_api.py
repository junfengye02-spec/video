import pytest
from fastapi.testclient import TestClient

from server.app.main import create_app


TEXT_TEST_KEY = "txt-test-key-1234567890abcdef"
IMAGE_TEST_KEY = "img-test-key-1234567890abcdef"
VIDEO_TEST_KEY = "vid-test-key-1234567890abcdef"


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
                    "version": 1,
                    "history": [],
                },
            ]
        },
    }


@pytest.fixture(autouse=True)
def stub_storyboard_generator(monkeypatch):
    monkeypatch.setattr(
        "server.app.main.generate_short_drama_storyboard",
        lambda **kwargs: _fake_storyboard_result(),
    )


def test_key_session_returns_masked_key(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

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
    assert body["masked_keys"]["text"] == "txt-...cdef"
    assert body["masked_keys"]["image"] == "img-...cdef"
    assert body["masked_keys"]["video"] == "vid-...cdef"
    assert body["models"] == {
        "text": "gpt-5.5",
        "image": "gpt-image-2",
        "video": "veo_3_1-lite",
    }


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


def test_regenerate_shot_updates_storyboard_and_emits_event(tmp_path):
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
    shot_id = created["storyboard"]["shots"][0]["id"]

    response = client.post(f"/api/projects/{project_id}/shots/{shot_id}/regenerate", json={})

    assert response.status_code == 200
    body = response.json()
    assert body["shot"]["version"] == 2
    assert body["event"]["status"] == "complete"
    assert body["event"]["stage"] == "regenerate"


def test_regenerate_shot_persists_updated_storyboard(tmp_path):
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
    shot_id = created["storyboard"]["shots"][0]["id"]

    client.post(f"/api/projects/{project_id}/shots/{shot_id}/regenerate", json={})
    loaded = client.get(f"/api/projects/{project_id}").json()

    assert loaded["storyboard"]["shots"][0]["version"] == 2


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
