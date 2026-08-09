import inspect
import json
import logging
import threading
import time
import uuid
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from server.app.assets.service import MediaAssetRepository, compatible_asset_record
from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.auth.models import User
from server.app.auth.router import get_provisioner
from server.app.billing.models import (
    BillingReconciliation,
    BillingSetting,
    GenerationJob,
)
from server.app.billing.reconciliation import reconcile_due_jobs
from server.app.core.config import AppSettings, get_settings
from server.app.db.base import Base
from server.app.db.session import get_db
from server.app.main import (
    RenderProjectRequest,
    ShortDramaRequest,
    _affected_plan_sections,
    _require_function_user,
    create_app as create_production_app,
    get_newapi_client,
)
from server.app.models import ImageGenerationRequest, PromptOptimizeRequest
from server.app.provider.newapi import (
    InvalidNewApiResponse,
    NewApiCallError,
    NewApiRateLimited,
    QuotedExecutionResult,
    TokenScopedQuote,
    UsageQuote,
    UsageReceipt,
    VideoTaskStatus,
)
from server.app.projects.models import ProjectRecord
from server.app.storage import ProjectMutationJournal, WorkbenchStore
from server.app.wallet.models import WalletAccount
from server.app.video_model_settings.service import (
    VideoModelDurationService,
    bootstrap_verified_duration_settings,
)
from server.app.wallet.provisioning import WalletProvisioner


TEST_USER = CurrentUser(
    id="api-test-user0000000000000000001",
    email="api-test@example.com",
    role="user",
)


def _wait_project_task(client, project_id: str, task_id: str, expected: set[str]):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get(f"/api/projects/{project_id}/tasks/{task_id}")
        assert response.status_code == 200, response.text
        task = response.json()
        if task["status"] in expected:
            return task
        time.sleep(0.02)
    raise AssertionError(f"task {task_id} did not reach {expected}")


def test_production_app_provisioner_override_has_no_request_parameters(tmp_path):
    app = create_production_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )

    override = app.dependency_overrides[get_provisioner]

    assert list(inspect.signature(override).parameters) == []
    assert isinstance(override(), WalletProvisioner)


def create_app(*, db_path, projects_root):
    database_path = Path(db_path).with_name(
        f"{Path(db_path).stem}-{uuid.uuid4().hex}-orm.sqlite3"
    )
    engine = create_engine(
        f"sqlite+pysqlite:///{database_path.as_posix()}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    db = Session(engine, expire_on_commit=False)
    db.add(
        User(
            id=TEST_USER.id,
            email=TEST_USER.email,
            password_hash="hash",
            role="user",
            status="active",
        )
    )
    db.add(
        WalletAccount(
            id="a" * 32,
            user_id=TEST_USER.id,
            balance_units=1_000_000_000,
            held_units=0,
        )
    )
    db.add(BillingSetting(id=1, multiplier_bps=15_000, version=0))
    bootstrap_verified_duration_settings(db)
    db.commit()
    app = create_production_app(db_path=db_path, projects_root=projects_root)

    def database_dependency():
        try:
            yield db
        except Exception:
            db.rollback()
            raise
        finally:
            if db.in_transaction():
                db.commit()

    app.dependency_overrides[get_db] = database_dependency
    app.dependency_overrides[require_user] = lambda: TEST_USER
    app.dependency_overrides[require_csrf] = lambda: TEST_USER
    app.dependency_overrides[_require_function_user] = lambda: TEST_USER
    app.dependency_overrides[get_settings] = lambda: AppSettings(
        _env_file=None,
        environment="test",
        auth_hmac_secret="x" * 32,
        newapi_text_fixed_group="openmontage-text",
        newapi_image_fixed_group="openmontage-image",
        newapi_video_fixed_group="openmontage-video",
    )
    app.state.fake_newapi = FakeNewApi()
    app.dependency_overrides[get_newapi_client] = lambda: app.state.fake_newapi
    app.state.test_db = db
    app.state.test_db_engine = engine
    return app


class FakeNewApi:
    def __init__(self):
        self.counter = 0
        self.references = {}
        self.invalid_prompt = False
        self.invalid_quote = False
        self.invalid_model_catalog = False
        self.quote_failure = False
        self.quote_rate_limited = False
        self.video_status = "completed"
        self.execute_calls = []
        self.list_model_calls = []

    def close(self):
        return None

    def list_models(self, kind, token_alias=None):
        self.list_model_calls.append((kind, token_alias))
        if self.invalid_model_catalog:
            raise InvalidNewApiResponse("invalid model catalog")
        return {
            "text": ["gpt-5.5", "gpt-5.5-mini"],
            "image": ["gpt-image-2", "imagen-4"],
            "video": ["kling-v2", "omni_flash-10s"],
        }[kind]

    def quote(self, kind, request, token_alias=None):
        if self.invalid_quote:
            raise InvalidNewApiResponse("invalid quote")
        if self.quote_rate_limited:
            raise NewApiRateLimited("provider rate limited")
        if self.quote_failure:
            raise NewApiCallError("provider unavailable")
        self.counter += 1
        relay_format = {
            "text": "openai",
            "image": "openai_image",
            "video": "task",
        }[kind]
        alias = token_alias or f"{kind}-v1"
        return TokenScopedQuote(
            token_alias=alias,
            quote=UsageQuote(
                quote_id="uq_" + f"{self.counter:032x}",
                status="quoted",
                model=request.model,
                fixed_group=f"openmontage-{kind}",
                relay_format=relay_format,
                estimated_quota=500_000,
                quota_per_unit=Decimal("500000"),
                cost_currency="USD",
                estimated_cost_amount_micro=1_000_000,
                pricing_version="sha256:test-pricing",
                billing_fingerprint=f"sha256:test-{self.counter}",
                other_ratios={},
                expires_at=int((datetime.now(timezone.utc) + timedelta(seconds=120)).timestamp()),
            ),
        )

    def execute_quoted(self, kind, token_alias, request, quote_id):
        self.execute_calls.append((kind, quote_id))
        self.counter += 1
        if kind == "video":
            reference = "task_" + f"{self.counter:032x}"
            response = httpx.Response(200, json={"id": reference})
            reference_type = "task"
        else:
            reference = f"{self.counter:023d}" + "deadbeefABC12345"
            body = json.loads(request.content)
            if kind == "image":
                content = {
                    "data": [
                        {
                            "b64_json": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
                        }
                        for _ in range(body["n"])
                    ]
                }
            elif str(body["messages"][0]["content"]).startswith("You are the creative producer"):
                content = {
                    "choices": [{"message": {"content": json.dumps({
                        "reply": "The direction is clear. Confirm when you want the full plan.",
                        "ready_to_confirm": True,
                        "brief": {
                            "title": "Rain Letter",
                            "logline": "A courier receives a letter from tomorrow.",
                            "audience": "young suspense fans",
                            "format": "vertical short drama",
                            "duration_seconds": 60,
                            "aspect_ratio": "9:16",
                            "genre": "suspense",
                            "tone": "tense and emotional",
                            "visual_style": "rainy neon realism",
                            "story_outline": "The warning arrives, is doubted, then comes true.",
                            "must_have": ["rain", "sealed letter"],
                            "open_questions": [],
                        },
                    })}}]
                }
            elif str(body["messages"][0]["content"]).startswith("Create a production-ready"):
                content = {
                    "choices": [{"message": {"content": json.dumps(_fake_storyboard_result())}}]
                }
            elif "Return exactly one JSON object" in body["messages"][1]["content"]:
                content = {
                    "choices": [{"message": {"content": json.dumps({
                        "prompt": "optimized shot prompt",
                        "shot_intent": "Reveal the clue.",
                        "shot_language": {
                            "shot_size": "medium_close",
                            "camera_movement": (
                                "teleport_sideways" if self.invalid_prompt else "dolly_in"
                            ),
                        },
                    })}}]
                }
            else:
                content = {"choices": [{"message": {"content": "optimized prompt"}}]}
            response = httpx.Response(
                200,
                headers={"X-Oneapi-Request-Id": reference},
                json=content,
            )
            reference_type = "request"
        self.references[reference] = (kind, request.model)
        return QuotedExecutionResult(reference_type, reference, response)

    def get_request_receipt(self, kind, token_alias, request_id):
        return self._receipt("request", request_id)

    def get_task_receipt(self, kind, token_alias, task_id):
        return self._receipt("task", task_id)

    def _receipt(self, reference_type, reference_id):
        _kind, model = self.references[reference_id]
        return UsageReceipt(
            reference_type=reference_type,
            reference_id=reference_id,
            status="settled",
            model=model,
            quota=500_000,
            refunded_quota=0,
            quota_per_unit=Decimal("500000"),
            pricing_version="sha256:test-pricing",
            cost_currency="USD",
            cost_amount_micro=800_000,
            settled_at=int(datetime.now(timezone.utc).timestamp()),
        )

    def get_video_task(self, token_alias, task_id):
        return VideoTaskStatus(id=task_id, status=self.video_status)

    def download_video_content(
        self,
        token_alias,
        task_id,
        destination,
        *,
        fallback_url=None,
        progress_callback=None,
    ):
        destination.write_bytes(b"fake video")
        if progress_callback is not None:
            progress_callback()
        return 10


def test_generation_models_are_loaded_from_the_capability_specific_provider(tmp_path):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    client = TestClient(app)

    response = client.get("/api/generation/models", params={"capability": "video"})

    assert response.status_code == 200
    body = response.json()
    assert body["capability"] == "video"
    assert body["models"] == ["kling-v2", "omni_flash-10s"]
    assert any(
        profile["model_id"] == "kling-v2"
        and profile["duration_mode"] == "unknown"
        for profile in body["profiles"]
    )
    omni_profiles = [
        profile for profile in body["profiles"]
        if profile["model_id"] == "omni_flash-10s"
    ]
    assert omni_profiles
    assert all(profile["supports_start_frame"] is False for profile in omni_profiles)
    assert all(profile["supports_end_frame"] is False for profile in omni_profiles)
    assert any(
        profile["operation"] == "text_to_video"
        and profile["fixed_duration_seconds"] == 10
        for profile in omni_profiles
    )
    assert app.state.fake_newapi.list_model_calls == [("video", None)]


def test_text_generation_models_use_the_text_provider_capability(tmp_path):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    client = TestClient(app)

    response = client.get("/api/generation/models", params={"capability": "text"})

    assert response.status_code == 200
    assert response.json() == {
        "capability": "text",
        "models": ["gpt-5.5", "gpt-5.5-mini"],
        "profiles": [],
    }
    assert app.state.fake_newapi.list_model_calls == [("text", None)]


def test_generation_models_reject_unknown_capabilities(tmp_path):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    response = TestClient(app).get(
        "/api/generation/models",
        params={"capability": "audio"},
    )

    assert response.status_code == 422
    assert app.state.fake_newapi.list_model_calls == []


def test_generation_models_map_invalid_provider_payloads_to_gateway_failure(tmp_path):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    app.state.fake_newapi.invalid_model_catalog = True

    response = TestClient(app, raise_server_exceptions=False).get(
        "/api/generation/models",
        params={"capability": "image"},
    )

    assert response.status_code == 502
    assert response.json() == {"code": "provider_call_failed"}


TEXT_TEST_KEY = "txt-test-key-1234567890abcdef"
IMAGE_TEST_KEY = "img-test-key-1234567890abcdef"
VIDEO_TEST_KEY = "vid-test-key-1234567890abcdef"

def _create_project_with_fake_generator(client):
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
    assert response.status_code == 200, response.text
    created = response.json()
    project_id = created["project"]["id"]
    for section, approval in created["creative_workflow"]["plan_sections"].items():
        updated = client.patch(
            f"/api/projects/{project_id}/creative-plan/sections/{section}",
            json={"status": "approved", "revision": approval["revision"]},
        )
        assert updated.status_code == 200, updated.text
    approved = client.post(f"/api/projects/{project_id}/storyboard/approve")
    assert approved.status_code == 200, approved.text
    return approved.json()


def _mark_creative_workflow_approved(app, project_id):
    workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
    for section in workflow["plan_sections"].values():
        section["status"] = "approved"
        section["revision"] += 1
        section["feedback"] = None
        section["updated_at"] = datetime.now(timezone.utc).isoformat()
    workflow["phase"] = "approved"
    workflow["approved_at"] = datetime.now(timezone.utc).isoformat()
    app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)


def _fake_storyboard_result() -> dict:
    return {
        "series_bible": {
            "title": "Rain Alley",
            "mode": "short_drama",
            "worldview": "Near-future messages can travel backward by one day.",
            "main_arc": "Lin decides whether to trust the impossible warning.",
            "style_lock": "rainy neon suspense",
            "visual_rules": "Cool rain exteriors contrast with warm truthful interiors.",
            "series_prompt": "Escalate the impossible warning while preserving rain-night continuity.",
            "relationship_map": ["Lin distrusts Chen, who knows more than he admits."],
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
        "continuity_plan": {
            "episodes": [
                {
                    "episode_number": 1,
                    "title": "The first warning",
                    "goal": "Verify the impossible letter.",
                    "conflict": "Chen blocks the investigation.",
                    "twist": "The warning comes true.",
                    "cliffhanger": "A second letter names Lin.",
                    "inherited_state": ["Lin has the first letter."],
                    "prompt": "Stage the first warning as a compact suspense episode.",
                    "outline": "Letter, obstruction, proof, second warning.",
                }
            ]
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


@pytest.fixture(autouse=True)
def stub_storyboard_generator(monkeypatch):
    monkeypatch.setattr(
        "server.app.provider.video_recovery.probe_output",
        lambda path: {
            "file_size_bytes": path.stat().st_size,
            "video_width": 720,
            "video_height": 1280,
        },
    )


def test_browser_provider_key_session_is_removed(tmp_path, monkeypatch):
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

    assert response.status_code == 404
    assert TEXT_TEST_KEY not in response.text
    assert IMAGE_TEST_KEY not in response.text
    assert VIDEO_TEST_KEY not in response.text


def test_browser_provider_key_session_never_calls_validation(tmp_path, monkeypatch):
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
            "video_model": "omni_flash-10s",
        },
    )

    assert response.status_code == 404


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
    assert body["creative_workflow"]["phase"] == "plan_review"
    assert all(
        section["status"] == "pending"
        for section in body["creative_workflow"]["plan_sections"].values()
    )


def test_legacy_short_drama_create_cannot_bypass_section_approval_for_media(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app, raise_server_exceptions=False)
    created = client.post(
        "/api/projects/short-drama",
        json={"title": "Review first", "prompt": "A short suspense story"},
    )
    assert created.status_code == 200, created.text
    project_id = created.json()["project"]["id"]
    calls_after_planning = list(app.state.fake_newapi.execute_calls)

    responses = [
        client.post(
            f"/api/projects/{project_id}/images/generate",
            json={"prompt": "blocked image"},
        ),
        client.post(
            f"/api/projects/{project_id}/shots/s1/regenerate",
            json={},
        ),
        client.post(f"/api/projects/{project_id}/render", json={}),
    ]

    assert [response.status_code for response in responses] == [409, 409, 409]
    assert app.state.fake_newapi.execute_calls == calls_after_planning


def test_billed_storyboard_request_supports_default_shot_count():
    from server.app.storyboard_generator import prepare_storyboard_request

    request = prepare_storyboard_request(
        title="Rain Alley",
        prompt="rain-night urban reversal short drama",
        model="gpt-5.5",
    )

    payload = json.loads(request.content)
    user_content = payload["messages"][1]["content"]
    assert user_content.startswith("Title: Rain Alley\nBrief: rain-night")
    assert "Shots:" in user_content


def test_create_draft_project_returns_continuity_and_workflow_shell(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    response = client.post(
        "/api/projects",
        json={
            "title": "Draft",
            "project_type": "mini_series",
            "prompt": "  Preserve this story and visual direction.  ",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["project"]["title"] == "Draft"
    assert body["project"]["project_type"] == "mini_series"
    assert body["continuity_plan"]["project_type"] == "mini_series"
    assert body["series_bible"]["project_brief"] == (
        "Preserve this story and visual direction."
    )
    assert body["storyboard"]["shots"] == []
    assert body["creative_workflow"]["phase"] == "inspiration"
    assert set(body["creative_workflow"]["plan_sections"]) == {
        "worldview",
        "characters",
        "scenes",
        "props",
        "sound",
        "storyboard",
    }
    assert all(
        section["status"] == "pending"
        for section in body["creative_workflow"]["plan_sections"].values()
    )
    assert body["workflow_artifacts"]


def test_inspiration_to_plan_to_approval_persists_each_gate(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    draft = client.post(
        "/api/projects",
        json={"title": "Rain Letter", "project_type": "single_video"},
    ).json()
    project_id = draft["project"]["id"]

    conversation = client.post(
        f"/api/projects/{project_id}/inspiration/chat",
        json={
            "messages": [
                {"role": "user", "content": "A courier gets a letter from tomorrow."}
            ],
            "text_model": "selected-planner-model",
        },
    )

    assert conversation.status_code == 200, conversation.text
    workflow = conversation.json()["creative_workflow"]
    assert workflow["phase"] == "inspiration"
    assert workflow["ready_to_confirm"] is True
    assert workflow["text_model"] == "selected-planner-model"
    assert workflow["brief"]["title"] == "Rain Letter"
    assert [message["role"] for message in workflow["messages"]] == ["user", "assistant"]

    planned = client.post(
        f"/api/projects/{project_id}/storyboard/plan",
        json={"prompt": "A 60-second vertical suspense story about tomorrow's letter."},
    )

    assert planned.status_code == 200, planned.text
    planned_body = planned.json()
    assert planned_body["creative_workflow"]["phase"] == "plan_review"
    assert planned_body["continuity_plan"]["series_bible"]["worldview"].startswith(
        "Near-future"
    )
    assert planned_body["series_bible"]["characters"][0]["visual_lock"]
    assert all(asset["prompt"] for asset in planned_body["series_bible"]["assets"])
    workflow = planned_body["creative_workflow"]
    assert workflow["text_model"] == "selected-planner-model"
    assert workflow["brief_confirmed_at"]
    assert workflow["plan_generated_at"]
    assert all(
        section["status"] == "pending" and section["revision"] == 1
        for section in workflow["plan_sections"].values()
    )

    incomplete = client.post(f"/api/projects/{project_id}/storyboard/approve")

    assert incomplete.status_code == 409
    assert incomplete.json()["detail"]["code"] == "creative_plan_sections_incomplete"
    assert incomplete.json()["detail"]["missing_sections"] == [
        "worldview",
        "characters",
        "scenes",
        "props",
        "sound",
        "storyboard",
    ]

    for section, approval in workflow["plan_sections"].items():
        updated = client.patch(
            f"/api/projects/{project_id}/creative-plan/sections/{section}",
            json={"status": "approved", "revision": approval["revision"]},
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["creative_workflow"]["plan_sections"][section][
            "status"
        ] == "approved"

    refreshed = client.get(f"/api/projects/{project_id}").json()
    assert all(
        section["status"] == "approved" and section["revision"] == 2
        for section in refreshed["creative_workflow"]["plan_sections"].values()
    )

    approved = client.post(f"/api/projects/{project_id}/storyboard/approve")

    assert approved.status_code == 200, approved.text
    assert approved.json()["creative_workflow"]["phase"] == "approved"
    assert approved.json()["creative_workflow"]["approved_at"]


def test_async_storyboard_plan_returns_202_and_publishes_after_worker_completion(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    with TestClient(app) as client:
        draft = client.post(
            "/api/projects",
            json={"title": "Async Rain Letter", "project_type": "single_video"},
        ).json()
        project_id = draft["project"]["id"]
        conversation = client.post(
            f"/api/projects/{project_id}/inspiration/chat",
            json={"messages": [{"role": "user", "content": "A courier gets a letter from tomorrow."}]},
        )
        assert conversation.status_code == 200, conversation.text

        submitted = client.post(
            f"/api/projects/{project_id}/storyboard/plan/tasks",
            json={
                "prompt": "A suspense story about tomorrow's letter.",
                "text_model": "gpt-5.4",
            },
        )

        assert submitted.status_code == 202, submitted.text
        task_id = submitted.json()["task_id"]
        assert submitted.json()["status"] in {"queued", "running", "complete"}
        task = _wait_project_task(client, project_id, task_id, {"complete"})
        assert task["task_type"] == "storyboard.plan"
        assert task["items"][0]["input"]["text_model"] == "gpt-5.4"
        assert task["items"][0]["model"] == "gpt-5.4"
        project = client.get(f"/api/projects/{project_id}")
        assert project.status_code == 200, project.text
        assert project.json()["creative_workflow"]["phase"] == "plan_review"


def test_async_storyboard_plan_deduplicates_while_the_provider_is_running(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    provider_started = threading.Event()
    release_provider = threading.Event()
    original_execute = app.state.fake_newapi.execute_quoted

    def blocking_execute(kind, *args, **kwargs):
        request = args[1] if len(args) > 1 else None
        is_storyboard_plan = (
            kind == "text"
            and request is not None
            and b"Create a production-ready" in request.content
        )
        if is_storyboard_plan:
            provider_started.set()
            assert release_provider.wait(5)
        return original_execute(kind, *args, **kwargs)

    monkeypatch.setattr(app.state.fake_newapi, "execute_quoted", blocking_execute)
    with TestClient(app) as client:
        draft = client.post(
            "/api/projects",
            json={"title": "Deduplicated Plan", "project_type": "single_video"},
        ).json()
        project_id = draft["project"]["id"]
        assert client.post(
            f"/api/projects/{project_id}/inspiration/chat",
            json={"messages": [{"role": "user", "content": "A warning arrives from tomorrow."}]},
        ).status_code == 200

        first = client.post(
            f"/api/projects/{project_id}/storyboard/plan/tasks",
            json={"prompt": "A suspense story about a warning."},
        )
        assert first.status_code == 202, first.text
        assert provider_started.wait(5)

        second = client.post(
            f"/api/projects/{project_id}/storyboard/plan/tasks",
            json={"prompt": "A suspense story about a warning."},
        )
        assert second.status_code == 202, second.text
        assert second.json()["task_id"] == first.json()["task_id"]
        assert second.json()["deduplicated"] is True

        release_provider.set()
        task = _wait_project_task(client, project_id, first.json()["task_id"], {"complete"})
        assert task["status"] == "complete"


def test_series_planning_uses_authorized_project_type_and_persists_episode_contract(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    draft = client.post(
        "/api/projects",
        json={"title": "Rain Letter Series", "project_type": "mini_series"},
    ).json()
    project_id = draft["project"]["id"]
    assert client.post(
        f"/api/projects/{project_id}/inspiration/chat",
        json={"messages": [{"role": "user", "content": "A serialized warning from tomorrow."}]},
    ).status_code == 200

    planned = client.post(
        f"/api/projects/{project_id}/storyboard/plan",
        json={
            "prompt": "A compact serialized suspense story.",
            "project_type": "single_video",
        },
    )

    assert planned.status_code == 200, planned.text
    body = planned.json()
    assert body["continuity_plan"]["project_type"] == "mini_series"
    assert len(body["continuity_plan"]["episodes"]) == 3
    assert body["continuity_plan"]["episodes"][0]["title"] == "The first warning"
    assert body["continuity_plan"]["episodes"][0]["prompt"]
    assert body["continuity_plan"]["series_bible"]["series_prompt"].startswith(
        "Escalate the impossible warning"
    )
    assert body["continuity_plan"]["series_bible"]["relationship_map"] == [
        "Lin distrusts Chen, who knows more than he admits."
    ]


def test_inspiration_promotes_single_video_draft_when_brief_explicitly_becomes_series(
    tmp_path,
    monkeypatch,
):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    draft = client.post(
        "/api/projects",
        json={"title": "Matchmaking", "project_type": "single_video"},
    ).json()
    project_id = draft["project"]["id"]

    def fake_develop_inspiration_billed(**_kwargs):
        return {
            "reply": "This is now a three-episode mini series.",
            "ready_to_confirm": True,
            "brief": {
                "title": "Matchmaking trilogy",
                "logline": "Three linked matchmaking episodes.",
                "audience": "Comedy viewers",
                "format": "mini_series",
                "duration_seconds": 90,
                "aspect_ratio": "16:9",
                "genre": "Comedy",
                "tone": "Fast",
                "visual_style": "Urban",
                "story_outline": "Three episodes.",
                "must_have": [],
                "open_questions": [],
            },
        }

    monkeypatch.setattr(
        "server.app.main.develop_inspiration_billed",
        fake_develop_inspiration_billed,
    )
    response = client.post(
        f"/api/projects/{project_id}/inspiration/chat",
        json={"messages": [{"role": "user", "content": "Make it three episodes."}]},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["project"]["project_type"] == "mini_series"
    assert body["continuity_plan"]["project_type"] == "mini_series"
    assert body["continuity_plan"]["active_episode_number"] == 1
    stored = client.get(f"/api/projects/{project_id}").json()
    assert stored["project"]["project_type"] == "mini_series"


def test_planning_requests_use_the_server_configured_model_when_omitted(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    app.dependency_overrides[get_settings] = lambda: AppSettings(
        _env_file=None,
        environment="test",
        auth_hmac_secret="x" * 32,
        newapi_text_fixed_group="openmontage-text",
        newapi_image_fixed_group="openmontage-image",
        newapi_video_fixed_group="openmontage-video",
        newapi_planning_text_model="gpt-5.4",
    )
    client = TestClient(app)
    draft = client.post(
        "/api/projects",
        json={"title": "Configured planning model", "project_type": "single_video"},
    ).json()
    project_id = draft["project"]["id"]
    assert client.post(
        f"/api/projects/{project_id}/inspiration/chat",
        json={"messages": [{"role": "user", "content": "A restrained rainy short."}]},
    ).status_code == 200

    planned = client.post(
        f"/api/projects/{project_id}/storyboard/plan",
        json={"prompt": "A restrained rainy short."},
    )
    revised = client.post(
        f"/api/projects/{project_id}/creative-plan/revise",
        json={"sections": ["worldview"], "feedback": "Keep the rules grounded."},
    )

    assert planned.status_code == 200, planned.text
    assert revised.status_code == 200, revised.text
    jobs = app.state.test_db.scalars(
        select(GenerationJob)
        .where(GenerationJob.operation == "storyboard_generation")
        .order_by(GenerationJob.created_at)
    ).all()
    assert [job.model for job in jobs] == ["gpt-5.4", "gpt-5.4"]


def test_plan_section_update_rejects_a_stale_revision_with_current_state(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
    workflow["phase"] = "plan_review"
    workflow["plan_sections"] = {
        section: {
            "status": "pending",
            "revision": 4,
            "feedback": None,
            "updated_at": None,
        }
        for section in (
            "worldview",
            "characters",
            "scenes",
            "props",
            "sound",
            "storyboard",
        )
    }
    app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)

    first = client.patch(
        f"/api/projects/{project_id}/creative-plan/sections/worldview",
        json={"status": "approved", "revision": 4},
    )
    stale = client.patch(
        f"/api/projects/{project_id}/creative-plan/sections/worldview",
        json={
            "status": "changes_requested",
            "feedback": "Use a grounded world",
            "revision": 4,
        },
    )

    assert first.status_code == 200, first.text
    assert first.json()["creative_workflow"]["plan_sections"]["worldview"][
        "revision"
    ] == 5
    assert stale.status_code == 409
    assert stale.json()["detail"] == {
        "code": "plan_section_revision_conflict",
        "message": "Creative plan section has changed",
        "section": "worldview",
        "submitted_revision": 4,
        "current_revision": 5,
        "current": first.json()["creative_workflow"]["plan_sections"]["worldview"],
    }


def test_approved_storyboard_revision_can_start_and_cancel_without_resetting_units_or_model(
    tmp_path,
):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    approved = _create_project_with_fake_generator(client)
    project_id = approved["project"]["id"]
    first_shot_id = approved["storyboard"]["shots"][0]["id"]
    generation_execution = {
        "version": "1.0",
        "generation_units": [
            {
                "id": "unit-complete",
                "plan_id": "plan-approved",
                "revision": 1,
                "status": "complete",
                "active": True,
                "source_shot_ids": [first_shot_id],
                "source_shot_versions": {first_shot_id: 1},
                "source_beat_ids": ["beat-1"],
                "prompt_segments": [],
                "provider": "newapi",
                "model_id": "omni_flash-10s",
                "operation": "text_to_video",
                "profile_revision": "test-profile",
                "profile": {},
                "requested_duration_seconds": 10,
                "source_duration_seconds": 10,
                "timeline_duration_seconds": 10,
                "output_asset_id": "asset-complete",
                "output_path": "assets/video/units/unit-complete/v1.mp4",
                "task_item_id": "task-item-complete",
                "billing_job_id": "billing-complete",
                "replaces_unit_id": None,
                "diagnostics": {},
                "created_at": "2026-07-26T00:00:00Z",
                "updated_at": "2026-07-26T00:00:00Z",
            }
        ],
    }
    app.state.store.write_artifact(
        project_id, "generation_execution.json", generation_execution
    )
    continuity = app.state.store.read_artifact(project_id, "continuity_plan.json")
    continuity["generation_preferences"]["video_model"] = "sora_v2"
    app.state.store.write_artifact(project_id, "continuity_plan.json", continuity)
    provider_calls = list(app.state.fake_newapi.execute_calls)

    started = client.post(
        f"/api/projects/{project_id}/creative-plan/storyboard-revision/start",
        json={},
    )

    assert started.status_code == 200, started.text
    started_body = started.json()
    started_workflow = started_body["creative_workflow"]
    assert started_workflow["phase"] == "plan_review"
    assert started_workflow["revision_session"]["section"] == "storyboard"
    assert started_workflow["plan_sections"]["storyboard"]["status"] == "changes_requested"
    assert started_body["generation_execution"] == generation_execution
    assert started_body["continuity_plan"]["generation_preferences"]["video_model"] == "sora_v2"
    assert app.state.fake_newapi.execute_calls == provider_calls

    canceled = client.post(
        f"/api/projects/{project_id}/creative-plan/storyboard-revision/cancel",
        json={},
    )

    assert canceled.status_code == 200, canceled.text
    canceled_body = canceled.json()
    canceled_workflow = canceled_body["creative_workflow"]
    assert canceled_workflow["phase"] == "approved"
    assert canceled_workflow["revision_session"] is None
    assert canceled_workflow["plan_sections"]["storyboard"]["status"] == "approved"
    assert canceled_body["generation_execution"] == generation_execution
    assert canceled_body["continuity_plan"]["generation_preferences"]["video_model"] == "sora_v2"
    assert app.state.fake_newapi.execute_calls == provider_calls


def test_storyboard_revision_cancel_rejects_a_section_changed_after_start(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    approved = _create_project_with_fake_generator(client)
    project_id = approved["project"]["id"]

    started = client.post(
        f"/api/projects/{project_id}/creative-plan/storyboard-revision/start",
        json={},
    )
    assert started.status_code == 200, started.text
    revision = started.json()["creative_workflow"]["plan_sections"]["storyboard"]
    changed = client.patch(
        f"/api/projects/{project_id}/creative-plan/sections/storyboard",
        json={
            "status": "changes_requested",
            "feedback": "Keep the revised six-shot structure",
            "revision": revision["revision"],
        },
    )
    assert changed.status_code == 200, changed.text

    canceled = client.post(
        f"/api/projects/{project_id}/creative-plan/storyboard-revision/cancel",
        json={},
    )

    assert canceled.status_code == 409
    assert canceled.json()["detail"]["code"] == "storyboard_revision_changed"
    persisted = client.get(f"/api/projects/{project_id}").json()["creative_workflow"]
    assert persisted["phase"] == "plan_review"
    assert persisted["revision_session"]["section"] == "storyboard"


def test_legacy_plan_section_defaults_fail_closed_except_for_approved_projects(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
    workflow.pop("plan_sections", None)
    workflow["phase"] = "approved"
    app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)

    approved = client.get(f"/api/projects/{project_id}").json()["creative_workflow"]
    assert all(
        section["status"] == "approved"
        for section in approved["plan_sections"].values()
    )

    workflow["phase"] = "plan_review"
    app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)
    pending = client.get(f"/api/projects/{project_id}").json()["creative_workflow"]
    assert all(
        section["status"] == "pending"
        for section in pending["plan_sections"].values()
    )


@pytest.mark.parametrize(
    ("requested", "expected"),
    [
        (
            ["worldview"],
            ["worldview", "characters", "scenes", "props", "storyboard"],
        ),
        (["characters"], ["characters", "storyboard"]),
        (["scenes"], ["scenes", "storyboard"]),
        (["props"], ["props", "storyboard"]),
        (["sound"], ["sound"]),
        (["storyboard"], ["storyboard"]),
    ],
)
def test_creative_plan_dependency_invalidation_matrix(requested, expected):
    assert _affected_plan_sections(
        requested,
        {},
        {"shots": []},
        {},
        {"shots": []},
    ) == expected


def test_sound_revision_invalidates_storyboard_when_sound_is_embedded_in_shots():
    assert _affected_plan_sections(
        ["sound"],
        {"sound_plan": {"storyboard_prompt_integration": True}},
        {"shots": []},
        {},
        {"shots": []},
    ) == ["sound", "storyboard"]


def test_revise_creative_plan_updates_only_text_and_atomically_invalidates_dependencies(
    tmp_path,
):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    draft = client.post(
        "/api/projects",
        json={"title": "Revision", "project_type": "single_video"},
    ).json()
    project_id = draft["project"]["id"]
    assert client.post(
        f"/api/projects/{project_id}/inspiration/chat",
        json={"messages": [{"role": "user", "content": "A rainy suspense short."}]},
    ).status_code == 200
    planned = client.post(
        f"/api/projects/{project_id}/storyboard/plan",
        json={"prompt": "A rainy suspense short."},
    ).json()

    for section, approval in planned["creative_workflow"]["plan_sections"].items():
        response = client.patch(
            f"/api/projects/{project_id}/creative-plan/sections/{section}",
            json={"status": "approved", "revision": approval["revision"]},
        )
        assert response.status_code == 200, response.text
    requested = client.patch(
        f"/api/projects/{project_id}/creative-plan/sections/worldview",
        json={
            "status": "changes_requested",
            "feedback": "Ground the time-travel rule in one visible mechanism.",
            "revision": 2,
        },
    )
    assert requested.status_code == 200, requested.text
    before_calls = len(app.state.fake_newapi.execute_calls)

    revised = client.post(
        f"/api/projects/{project_id}/creative-plan/revise",
        json={
            "sections": ["worldview"],
            "feedback": "Ground the time-travel rule in one visible mechanism.",
        },
    )

    assert revised.status_code == 200, revised.text
    workflow = revised.json()["creative_workflow"]
    assert workflow["phase"] == "plan_review"
    assert workflow["approved_at"] is None
    assert workflow["plan_sections"]["worldview"] == {
        "status": "pending",
        "revision": 4,
        "feedback": "Ground the time-travel rule in one visible mechanism.",
        "updated_at": workflow["plan_sections"]["worldview"]["updated_at"],
    }
    for section in ("characters", "scenes", "props", "storyboard"):
        assert workflow["plan_sections"][section]["status"] == "pending"
        assert workflow["plan_sections"][section]["revision"] == 3
        assert workflow["plan_sections"][section]["feedback"] is None
    assert workflow["plan_sections"]["sound"]["status"] == "approved"
    assert workflow["plan_sections"]["sound"]["revision"] == 2
    assert len(app.state.fake_newapi.execute_calls) == before_calls + 1
    assert app.state.fake_newapi.execute_calls[-1][0] == "text"
    video_dir = app.state.store.project_dir(project_id) / "assets" / "video"
    assert not video_dir.exists() or not any(video_dir.rglob("*"))
    assert client.get(f"/api/projects/{project_id}").json()["creative_workflow"] == workflow


def test_revising_characters_syncs_asset_prompt_without_losing_asset_metadata(
    tmp_path,
):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = client.post(
        "/api/projects/short-drama",
        json={"title": "Character revision", "prompt": "A rainy suspense short."},
    )
    assert created.status_code == 200, created.text
    project_id = created.json()["project"]["id"]

    series_bible = app.state.store.read_artifact(project_id, "series_bible.json")
    character = next(item for item in series_bible["characters"] if item["id"] == "c1")
    character["visual_lock"] = "stale character lock"
    asset = next(
        item
        for item in series_bible["assets"]
        if item["kind"] == "character" and item["label"] == character["name"]
    )
    asset.update(
        {
            "description": "User-authored wardrobe notes",
            "prompt": "stale asset prompt",
            "reference_images": ["local://media/character-reference"],
            "media_urls": ["local://media/character-preview"],
            "version": 7,
            "custom_metadata": {"keep": True},
        }
    )
    asset_before_revision = deepcopy(asset)
    app.state.store.write_artifact(project_id, "series_bible.json", series_bible)
    app.state.store.write_asset_library(project_id, series_bible["assets"])

    revised = client.post(
        f"/api/projects/{project_id}/creative-plan/revise",
        json={
            "sections": ["characters"],
            "feedback": "Restore the original red coat identity lock.",
        },
    )

    assert revised.status_code == 200, revised.text
    persisted = app.state.store.read_artifact(project_id, "series_bible.json")
    revised_character = next(
        item for item in persisted["characters"] if item["id"] == "c1"
    )
    revised_asset = next(
        item
        for item in persisted["assets"]
        if item["kind"] == "character" and item["label"] == revised_character["name"]
    )
    assert revised_character["visual_lock"] == "red coat, short hair"
    assert revised_asset == {
        **asset_before_revision,
        "prompt": revised_character["visual_lock"],
    }
    assert app.state.store.read_asset_library(project_id) == persisted["assets"]


def test_render_rechecks_the_approval_gate_before_publishing(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]

    def invalidate_before_publish(**kwargs):
        staged = kwargs["composition_output_path"]
        staged.parent.mkdir(parents=True, exist_ok=True)
        staged.write_bytes(b"must-not-publish")
        workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
        workflow["phase"] = "plan_review"
        app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)
        return {
            "final_path": str(staged),
            "render_report": {
                "version": "1.0",
                "outputs": [{
                    "path": str(staged),
                    "format": "mp4",
                    "resolution": "720x1280",
                    "duration_seconds": 25,
                }],
            },
            "storyboard": kwargs["storyboard"],
            "artifacts": {},
            "outputs": [],
        }

    monkeypatch.setattr(
        "server.app.main.render_short_drama_project",
        invalidate_before_publish,
    )

    response = client.post(f"/api/projects/{project_id}/render", json={})

    assert response.status_code == 409
    assert response.json() == {
        "detail": "Creative plan must be approved before production"
    }
    project_dir = app.state.store.project_dir(project_id)
    assert not (project_dir / "renders" / "final.mp4").exists()
    assert app.state.store.read_artifact(project_id, "render_report.json") is None


def test_storyboard_planning_cannot_skip_inspiration_confirmation(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    draft = client.post(
        "/api/projects",
        json={"title": "Unconfirmed", "project_type": "single_video"},
    ).json()

    response = client.post(
        f"/api/projects/{draft['project']['id']}/storyboard/plan",
        json={"prompt": "Try to bypass the inspiration gate"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == (
        "Creative brief must be confirmed before storyboard planning"
    )


@pytest.mark.parametrize("workflow_phase", ["inspiration", "plan_review"])
@pytest.mark.parametrize(
    ("endpoint", "payload"),
    [
        ("images/generate", {"prompt": "must remain blocked"}),
        ("shots/missing-shot/regenerate", {}),
        ("render", {}),
    ],
)
def test_unapproved_projects_reject_generation_and_render_endpoints(
    tmp_path,
    workflow_phase,
    endpoint,
    payload,
):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    client = TestClient(app, raise_server_exceptions=False)
    draft = client.post(
        "/api/projects",
        json={"title": "Unapproved", "project_type": "single_video"},
    ).json()
    project_id = draft["project"]["id"]
    workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
    workflow["phase"] = workflow_phase
    app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)

    response = client.post(f"/api/projects/{project_id}/{endpoint}", json=payload)

    assert response.status_code == 409
    assert response.json() == {
        "detail": "Creative plan must be approved before production"
    }
    assert app.state.fake_newapi.execute_calls == []


@pytest.mark.parametrize("workflow_phase", ["inspiration", "plan_review"])
@pytest.mark.parametrize("operation", ["upload", "add"])
def test_unapproved_projects_reject_resource_mutations(
    tmp_path,
    workflow_phase,
    operation,
):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app, raise_server_exceptions=False)
    draft = client.post(
        "/api/projects",
        json={"title": "Unapproved resources", "project_type": "single_video"},
    ).json()
    project_id = draft["project"]["id"]
    workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
    workflow["phase"] = workflow_phase
    app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)

    if operation == "upload":
        response = client.post(
            f"/api/projects/{project_id}/assets/upload",
            data={"kind": "character", "label": "Must stay blocked"},
            files={"file": ("blocked.png", b"blocked", "image/png")},
        )
    else:
        response = client.post(f"/api/projects/{project_id}/assets/missing/add", json={})

    assert response.status_code == 409
    assert response.json() == {
        "detail": "Creative plan must be approved before production"
    }
    assert not list(app.state.store.project_dir(project_id).rglob("blocked.png"))


def test_revising_inspiration_keeps_previous_plan_asset_tracking(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    draft = client.post(
        "/api/projects",
        json={"title": "Revision", "project_type": "single_video"},
    ).json()
    project_id = draft["project"]["id"]
    conversation = client.post(
        f"/api/projects/{project_id}/inspiration/chat",
        json={"messages": [{"role": "user", "content": "A rainy suspense short."}]},
    )
    assert conversation.status_code == 200, conversation.text
    planned = client.post(
        f"/api/projects/{project_id}/storyboard/plan",
        json={"prompt": "A rainy suspense short."},
    )
    assert planned.status_code == 200, planned.text
    planned_asset_ids = planned.json()["creative_workflow"]["planned_asset_ids"]
    assert planned_asset_ids

    revised = client.post(
        f"/api/projects/{project_id}/inspiration/chat",
        json={
            "messages": [
                *planned.json()["creative_workflow"]["messages"],
                {"role": "user", "content": "Move the story to a train station."},
            ]
        },
    )

    assert revised.status_code == 200, revised.text
    workflow = revised.json()["creative_workflow"]
    assert workflow["phase"] == "inspiration"
    assert workflow["planned_asset_ids"] == planned_asset_ids


def test_plan_existing_draft_preserves_preplanned_assets(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    draft = client.post(
        "/api/projects",
        json={"title": "Resource first", "project_type": "single_video"},
    ).json()
    project_id = draft["project"]["id"]
    asset = {
        "id": "asset-preplanned",
        "kind": "character",
        "label": "Lead reference",
        "description": "Uploaded before storyboard planning",
        "prompt": "Keep the lead appearance consistent",
        "reference_images": [],
        "media_urls": [],
        "shot_ids": [],
        "version": 1,
    }
    app.state.store.write_asset_library(project_id, [asset])
    series_bible = app.state.store.read_artifact(project_id, "series_bible.json")
    series_bible["assets"] = [asset]
    app.state.store.write_artifact(project_id, "series_bible.json", series_bible)
    workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
    workflow.update(
        {
            "brief": {
                "title": "Resource first",
                "logline": "Plan around the uploaded lead reference",
            },
            "ready_to_confirm": True,
        }
    )
    app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)

    response = client.post(
        f"/api/projects/{project_id}/storyboard/plan",
        json={"prompt": "Plan around the uploaded lead reference"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["project"]["id"] == project_id
    assert body["storyboard"]["shots"]
    assert body["series_bible"]["assets"][0]["id"] == "asset-preplanned"
    assert body["series_bible"]["assets"][0]["prompt"] == "Keep the lead appearance consistent"
    assert app.state.store.read_asset_library(project_id)[0]["id"] == "asset-preplanned"


def test_paid_project_contract_ignores_browser_provider_credentials(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    response = client.post(
        "/api/projects",
        json={
            "title": "No browser keys",
            "project_type": "single_video",
            "text_key": "attacker-text",
            "image_key": "attacker-image",
            "video_key": "attacker-video",
            "base_url": "https://attacker.invalid",
        },
    )

    assert response.status_code == 200
    rendered = json.dumps(response.json()).lower()
    assert "attacker" not in rendered
    assert "quote_id" not in rendered


@pytest.mark.parametrize(
    ("request_model", "payload"),
    [
        (
            ShortDramaRequest,
            {"title": "Drama", "prompt": "A reversal", "owner_user_id": "attacker"},
        ),
        (
            PromptOptimizeRequest,
            {
                "target": "shot",
                "target_id": "s1",
                "source_text": "Improve this",
                "shot_intent": "attacker metadata",
            },
        ),
        (
            ImageGenerationRequest,
            {"prompt": "A frame", "cost_usd": 0},
        ),
        (
            RenderProjectRequest,
            {"video_key": "legacy", "base_url": "https://legacy.invalid", "cost_usd": 0},
        ),
    ],
)
def test_paid_request_models_reject_noncredential_extra_fields(request_model, payload):
    with pytest.raises(ValidationError):
        request_model.model_validate(payload)


def test_paid_request_openapi_has_no_provider_credentials(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    schema = app.openapi()
    rendered = json.dumps(
        {
            path: value
            for path, value in schema["paths"].items()
            if path.endswith("/prompt-optimize")
            or path.endswith("/images/generate")
            or path.endswith("/render")
        }
    )

    assert "text_key" not in rendered
    assert "image_key" not in rendered
    assert "video_key" not in rendered
    assert "base_url" not in rendered
    assert "/api/projects/{project_id}/images/generate" in schema["paths"]


def test_wallet_payment_and_owned_billing_job_routes_are_mounted(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    paths = app.openapi()["paths"]

    assert "/api/wallet" in paths
    assert "/api/payment-orders" in paths
    assert "/api/billing/jobs/{job_id}" in paths


def test_cross_user_billing_job_and_generated_media_are_not_found(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    db = app.state.test_db
    other_user_id = "b" * 32
    other_project_id = "20000000000040008000000000000002"
    other_job_id = "c" * 32
    db.add(User(id=other_user_id, email="other@example.com", password_hash="hash", role="user", status="active"))
    db.add(ProjectRecord(id=other_project_id, owner_user_id=other_user_id, title="Other", mode="short_drama", project_type="single_video"))
    db.add(GenerationJob.parent(id=other_job_id, user_id=other_user_id, project_id=other_project_id, operation="render"))
    db.commit()
    image_path = tmp_path / "projects" / other_project_id / "assets" / "images" / "generated" / f"{other_job_id}-0.png"
    image_path.parent.mkdir(parents=True)
    image_path.write_bytes(b"private")

    assert client.get(f"/api/billing/jobs/{other_job_id}").status_code == 404
    assert client.get(
        f"/api/projects/{other_project_id}/media/assets/images/generated/{other_job_id}-0.png"
    ).status_code == 404
    assert client.get(
        f"/api/projects/{other_project_id}/media/assets/images/generated//{other_job_id}-0.png"
    ).status_code == 404


@pytest.mark.parametrize(
    "relative_path",
    [
        "assets/images/generated//{job_id}-0.png",
        "assets/images/generated/%2E%2E/generated/{job_id}-0.png",
    ],
)
def test_noncanonical_generated_media_cannot_bypass_result_visibility(tmp_path, relative_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = client.post("/api/projects", json={"title": "Hidden image"}).json()
    project_id = created["project"]["id"]
    job_id = "d" * 32
    now = datetime.now(timezone.utc)
    app.state.test_db.add(
        GenerationJob(
            id=job_id,
            parent_job_id=None,
            chargeable=True,
            user_id=TEST_USER.id,
            project_id=project_id,
            operation="image_generation",
            capability="image",
            token_kind="image",
            token_alias="image-v1",
            model="gpt-image-2",
            multiplier_bps=15_000,
            provider_method="POST",
            provider_route="/v1/images/generations",
            reference_deadline=now + timedelta(days=1),
            receipt_deadline=now + timedelta(days=1),
            status="receipt_pending",
            result_staged=False,
            result_visible=False,
            quote_id="uq_" + "d" * 32,
            quote_expires_at=now + timedelta(minutes=2),
            quote_estimated_quota=500_000,
            quote_estimated_provider_cost_micro=1_000_000,
            quote_quota_per_unit=Decimal("500000"),
            quote_pricing_version="sha256:test-pricing",
            quote_other_ratios_json="{}",
            quote_billing_fingerprint="sha256:hidden-image",
        )
    )
    app.state.test_db.commit()
    image_path = tmp_path / "projects" / project_id / "assets" / "images" / "generated" / f"{job_id}-0.png"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(b"private")

    response = client.get(
        f"/api/projects/{project_id}/media/{relative_path.format(job_id=job_id)}"
    )

    assert response.status_code == 404


def test_image_generation_endpoint_bills_then_serves_owned_media_without_provider_metadata(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    with TestClient(app) as client:
        created = client.post("/api/projects", json={"title": "Images"}).json()
        project_id = created["project"]["id"]
        _mark_creative_workflow_approved(app, project_id)

        response = client.post(
            f"/api/projects/{project_id}/images/generate",
            json={
                "prompt": "rainy alley frame",
                "model": "gpt-image-2",
                "count": 1,
                "size": "1024x1024",
                "quality": "standard",
                "image_key": "ignored-browser-key",
                "base_url": "https://attacker.invalid",
            },
        )

        assert response.status_code == 202
        assert "quote" not in response.text.lower()
        assert "attacker" not in response.text.lower()
        completed = _wait_project_task(
            client, project_id, response.json()["task_id"], {"complete"}
        )
        assets = client.get(
            "/api/assets", params={"scope": "project", "project_id": project_id}
        ).json()["assets"]
        assert len(assets) == 1
        assert client.get(assets[0]["media_url"]).status_code == 200
        job = app.state.test_db.get(
            GenerationJob, completed["items"][0]["billing_job_id"]
        )
        assert job.status == "billed" and job.result_visible is True


def test_initial_insufficient_balance_returns_sanitized_402_before_upstream(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    with TestClient(app, raise_server_exceptions=False) as client:
        created = client.post("/api/projects", json={"title": "No funds"}).json()
        project_id = created["project"]["id"]
        _mark_creative_workflow_approved(app, project_id)
        wallet = app.state.test_db.query(WalletAccount).filter_by(user_id=TEST_USER.id).one()
        wallet.balance_units = 0
        app.state.test_db.commit()

        response = client.post(
            f"/api/projects/{project_id}/images/generate",
            json={"prompt": "unaffordable frame"},
        )

        assert response.status_code == 202
        blocked = _wait_project_task(
            client, project_id, response.json()["task_id"], {"awaiting_payment"}
        )
        assert blocked["items"][0]["billing_job_id"] is None
        assert app.state.fake_newapi.execute_calls == []


def test_pending_render_resumes_same_children_and_worker_publishes_results(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_count = len(created["storyboard"]["shots"])
    app.state.fake_newapi.video_status = "queued"

    first = client.post(f"/api/projects/{project_id}/render", json={})

    assert first.status_code == 409
    assert first.json() == {"code": "provider_result_pending"}
    video_calls = [call for call in app.state.fake_newapi.execute_calls if call[0] == "video"]
    assert len(video_calls) == shot_count
    children = app.state.test_db.query(GenerationJob).filter(
        GenerationJob.project_id == project_id,
        GenerationJob.capability == "video",
    ).all()
    assert len(children) == shot_count
    assert len({child.parent_job_id for child in children}) == 1

    in_flight_retry = client.post(f"/api/projects/{project_id}/render", json={})
    assert in_flight_retry.status_code == 409
    assert in_flight_retry.json()["detail"]["code"] == "render_in_progress"
    assert in_flight_retry.json()["detail"]["job_id"]
    assert len([call for call in app.state.fake_newapi.execute_calls if call[0] == "video"]) == shot_count

    app.state.fake_newapi.video_status = "completed"
    processed = reconcile_due_jobs(
        app.state.test_db,
        app.state.fake_newapi,
        datetime.now(timezone.utc),
        100,
        settings=get_settings(),
        media_store=app.state.store,
    )
    rows = app.state.test_db.scalars(
        select(BillingReconciliation).join(
            GenerationJob, GenerationJob.id == BillingReconciliation.job_id
        ).where(GenerationJob.project_id == project_id)
    ).all()
    assert processed == shot_count, [
        (row.reason, row.status, row.attempts, row.next_retry_at, row.last_error)
        for row in rows
    ]
    storyboard = app.state.store.read_artifact(project_id, "episode_storyboard.json")
    assert storyboard is not None
    assert all(shot["status"] == "complete" for shot in storyboard["shots"])
    assert all(shot["output_path"] for shot in storyboard["shots"])

    def fake_render_short_drama_project(**kwargs):
        output = kwargs["composition_output_path"]
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"composed")
        return {
            "final_path": str(output),
            "render_report": {
                "version": "1.0",
                "outputs": [
                    {
                        "path": str(output),
                        "format": "mp4",
                        "resolution": "720x1280",
                        "duration_seconds": 15.0,
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
    second = client.post(f"/api/projects/{project_id}/render", json={"resume_existing": True})

    assert second.status_code == 200, second.text
    assert len([call for call in app.state.fake_newapi.execute_calls if call[0] == "video"]) == shot_count
    parents = app.state.test_db.query(GenerationJob).filter(
        GenerationJob.project_id == project_id,
        GenerationJob.chargeable.is_(False),
    ).all()
    assert len(parents) == 1
    assert parents[0].status == "complete"


def test_render_does_not_hold_project_mutation_across_provider_io(
    tmp_path, monkeypatch
):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    client = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    active = {"journals": 0}
    observed_depths: list[int] = []
    original_begin = app.state.store.begin_project_mutation
    original_execute = app.state.fake_newapi.execute_quoted

    class TrackedJournal:
        def __init__(self, journal):
            self.journal = journal
            self.closed = False

        def _close(self, method):
            try:
                return method()
            finally:
                if not self.closed:
                    active["journals"] -= 1
                    self.closed = True

        def complete(self):
            return self._close(self.journal.complete)

        def restore(self):
            return self._close(self.journal.restore)

    def begin_mutation(*args, **kwargs):
        journal = original_begin(*args, **kwargs)
        active["journals"] += 1
        return TrackedJournal(journal)

    def execute_quoted(kind, *args, **kwargs):
        if kind == "video":
            observed_depths.append(active["journals"])
        return original_execute(kind, *args, **kwargs)

    monkeypatch.setattr(app.state.store, "begin_project_mutation", begin_mutation)
    monkeypatch.setattr(app.state.fake_newapi, "execute_quoted", execute_quoted)
    app.state.fake_newapi.video_status = "queued"

    response = client.post(f"/api/projects/{project_id}/render", json={})

    assert response.status_code == 409
    assert observed_depths
    assert observed_depths == [0] * len(observed_depths)
    assert active["journals"] == 0


def test_regenerate_does_not_hold_route_mutation_across_provider_lifecycle(
    tmp_path, monkeypatch
):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    client = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]
    provider_calls = []

    for name in (
        "quote",
        "execute_quoted",
        "get_video_task",
        "download_video_content",
        "get_task_receipt",
    ):
        def forbidden_provider_call(*_args, _name=name, **_kwargs):
            provider_calls.append(_name)
            raise AssertionError("the regenerate route must not call the provider")

        monkeypatch.setattr(app.state.fake_newapi, name, forbidden_provider_call)

    response = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"video_model": "omni_flash-10s"},
    )

    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "queued"
    assert body["deduplicated"] is False
    assert body["task"]["items"][0]["target_entity_id"] == shot_id
    assert provider_calls == []



def test_previous_public_video_bytes_remain_previewable_after_shot_version_edit(
    tmp_path,
):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    client = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    stale_shot = created["storyboard"]["shots"][0]
    app.state.fake_newapi.video_status = "queued"
    assert client.post(f"/api/projects/{project_id}/render", json={}).status_code == 409
    app.state.fake_newapi.video_status = "completed"
    assert reconcile_due_jobs(
        app.state.test_db,
        app.state.fake_newapi,
        datetime.now(timezone.utc),
        100,
        settings=get_settings(),
        media_store=app.state.store,
    ) == len(created["storyboard"]["shots"])
    media_url = f"/api/projects/{project_id}/media/assets/video/{stale_shot['id']}.mp4"
    assert client.get(media_url).status_code == 200

    edited = client.patch(
        f"/api/projects/{project_id}/shots/{stale_shot['id']}",
        json={"prompt": "The new version revokes the old public bytes."},
    )

    assert edited.status_code == 200
    public_path = (
        app.state.store.project_dir(project_id)
        / "assets"
        / "video"
        / f"{stale_shot['id']}.mp4"
    )
    assert public_path.is_file()
    assert client.get(media_url).status_code == 200


def test_unclaimed_project_video_remains_owned_media(tmp_path):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    client = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    media_path = (
        app.state.store.project_dir(project_id)
        / "assets"
        / "video"
        / "manual.mp4"
    )
    media_path.parent.mkdir(parents=True, exist_ok=True)
    media_path.write_bytes(b"manual-owned-video")

    response = client.get(
        f"/api/projects/{project_id}/media/assets/video/manual.mp4"
    )

    assert response.status_code == 200
    assert response.content == b"manual-owned-video"


@pytest.mark.parametrize("intent_state", ["missing", "corrupt"])
def test_billed_video_requires_valid_current_intent(tmp_path, intent_state):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    client = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    target = created["storyboard"]["shots"][0]
    app.state.fake_newapi.video_status = "queued"
    assert client.post(f"/api/projects/{project_id}/render", json={}).status_code == 409
    app.state.fake_newapi.video_status = "completed"
    assert reconcile_due_jobs(
        app.state.test_db,
        app.state.fake_newapi,
        datetime.now(timezone.utc),
        100,
        settings=get_settings(),
        media_store=app.state.store,
    ) == len(created["storyboard"]["shots"])
    job = app.state.test_db.scalar(
        select(GenerationJob).where(
            GenerationJob.project_id == project_id,
            GenerationJob.operation == f"shot:{target['id']}",
        )
    )
    intent_path = (
        app.state.store.project_dir(project_id)
        / ".billing-results"
        / "video-intents"
        / f"{job.id}.json"
    )
    if intent_state == "missing":
        intent_path.unlink()
    else:
        intent_path.write_text('{"prompt":"must-not-authorize"}', encoding="utf-8")

    response = client.get(
        f"/api/projects/{project_id}/media/assets/video/{target['id']}.mp4"
    )

    assert response.status_code == 404


def test_public_video_is_denied_before_storyboard_commit_and_restored_on_crash(
    tmp_path, monkeypatch
):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    client = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    app.state.fake_newapi.video_status = "queued"
    assert client.post(f"/api/projects/{project_id}/render", json={}).status_code == 409

    original_write = app.state.store.write_artifact
    observed_statuses = []
    crashed_publication = {}

    def crash_before_storyboard_commit(target_project_id, name, data):
        if name == "episode_storyboard.json" and not crashed_publication:
            shot = next(
                shot
                for shot in data["shots"]
                if shot.get("status") == "complete" and shot.get("output_path")
            )
            public_path = (
                app.state.store.project_dir(project_id) / shot["output_path"]
            )
            assert public_path.is_file()
            crashed_publication.update(shot_id=shot["id"], path=public_path)
            observed_statuses.append(
                client.get(
                    f"/api/projects/{project_id}/media/{shot['output_path']}"
                ).status_code
            )
            raise RuntimeError("crash before storyboard commit")
        return original_write(target_project_id, name, data)

    monkeypatch.setattr(app.state.store, "write_artifact", crash_before_storyboard_commit)
    app.state.fake_newapi.video_status = "completed"

    reconcile_due_jobs(
        app.state.test_db,
        app.state.fake_newapi,
        datetime.now(timezone.utc),
        100,
        settings=get_settings(),
        media_store=app.state.store,
    )

    assert observed_statuses == [503]
    assert not crashed_publication["path"].exists()
    assert (
        client.get(
            f"/api/projects/{project_id}/media/assets/video/"
            f"{crashed_publication['shot_id']}.mp4"
        ).status_code
        == 404
    )
    storyboard = app.state.store.read_artifact(project_id, "episode_storyboard.json")
    current = next(
        shot
        for shot in storyboard["shots"]
        if shot["id"] == crashed_publication["shot_id"]
    )
    assert current["output_path"] is None
    job = app.state.test_db.scalar(
        select(GenerationJob).where(
            GenerationJob.project_id == project_id,
            GenerationJob.operation == f"shot:{crashed_publication['shot_id']}",
        )
    )
    reconciliation = app.state.test_db.scalar(
        select(BillingReconciliation).where(
            BillingReconciliation.job_id == job.id,
            BillingReconciliation.reason == "provider_completion",
        )
    )
    assert reconciliation.status == "open"
    assert reconciliation.last_error == "RuntimeError: crash before storyboard commit"


def test_restart_restores_public_video_after_process_death_before_storyboard_commit(
    tmp_path, monkeypatch
):
    projects_root = tmp_path / "projects"
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=projects_root,
    )
    client = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    app.state.fake_newapi.video_status = "queued"
    assert client.post(f"/api/projects/{project_id}/render", json={}).status_code == 409
    original_write = app.state.store.write_artifact
    original_restore = ProjectMutationJournal.restore
    crashed_publication = {}

    def crash_before_storyboard_commit(target_project_id, name, data):
        if name == "episode_storyboard.json" and not crashed_publication:
            shot = next(
                shot
                for shot in data["shots"]
                if shot.get("status") == "complete" and shot.get("output_path")
            )
            public_path = app.state.store.project_dir(project_id) / shot["output_path"]
            assert public_path.is_file()
            crashed_publication.update(shot_id=shot["id"], path=public_path)
            raise RuntimeError("crash before storyboard commit")
        return original_write(target_project_id, name, data)

    def process_dies_before_restore(journal):
        if journal.operation == "publish-billed-video":
            raise SystemExit("simulated process death")
        return original_restore(journal)

    monkeypatch.setattr(app.state.store, "write_artifact", crash_before_storyboard_commit)
    monkeypatch.setattr(ProjectMutationJournal, "restore", process_dies_before_restore)
    app.state.fake_newapi.video_status = "completed"

    with pytest.raises(SystemExit, match="simulated process death"):
        reconcile_due_jobs(
            app.state.test_db,
            app.state.fake_newapi,
            datetime.now(timezone.utc),
            100,
            settings=get_settings(),
            media_store=app.state.store,
        )

    assert crashed_publication["path"].is_file()
    assert (projects_root / ".recovery" / project_id).is_dir()
    app.state.test_db.rollback()
    monkeypatch.setattr(ProjectMutationJournal, "restore", original_restore)
    app.state.store = WorkbenchStore(projects_root=projects_root)

    assert not crashed_publication["path"].exists()
    assert not (projects_root / ".recovery").exists()
    assert (
        client.get(
            f"/api/projects/{project_id}/media/assets/video/"
            f"{crashed_publication['shot_id']}.mp4"
        ).status_code
        == 404
    )


def test_edit_during_composition_cannot_overwrite_storyboard_or_publish_final(
    tmp_path, monkeypatch
):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    client = TestClient(app, raise_server_exceptions=False)
    editor = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    target = created["storyboard"]["shots"][0]
    edited_responses = []

    def edit_then_render(**kwargs):
        edited_responses.append(
            editor.patch(
                f"/api/projects/{project_id}/shots/{target['id']}",
                json={"prompt": "Committed while composition was running."},
            )
        )
        output = kwargs["composition_output_path"]
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"stale-composition")
        return {
            "final_path": str(output),
            "render_report": {
                "version": "1.0",
                "outputs": [{"path": str(output)}],
                "warnings": [],
                "verification_notes": ["fake render"],
            },
            "storyboard": kwargs["storyboard"],
            "artifacts": {},
            "outputs": [],
        }

    monkeypatch.setattr(
        "server.app.main.render_short_drama_project",
        edit_then_render,
    )
    app.state.fake_newapi.video_status = "completed"

    response = client.post(f"/api/projects/{project_id}/render", json={})

    assert response.status_code == 409
    assert response.json() == {"code": "provider_result_pending"}
    assert edited_responses and edited_responses[0].status_code == 200
    storyboard = app.state.store.read_artifact(
        project_id, "episode_storyboard.json"
    )
    current = next(
        shot for shot in storyboard["shots"] if shot["id"] == target["id"]
    )
    assert current["prompt"] == "Committed while composition was running."
    assert current["version"] == target["version"] + 1
    assert not (
        app.state.store.project_dir(project_id) / "renders" / "final.mp4"
    ).exists()
    parent = app.state.test_db.query(GenerationJob).filter(
        GenerationJob.project_id == project_id,
        GenerationJob.chargeable.is_(False),
    ).one()
    assert parent.status == "partial_failure"


def test_restart_restores_final_composition_after_db_commit(tmp_path, monkeypatch):
    projects_root = tmp_path / "projects"
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=projects_root,
    )
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    original_complete = ProjectMutationJournal.complete
    crashed = {"value": False}

    def render(**kwargs):
        output = kwargs["composition_output_path"]
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"composed")
        return {
            "final_path": str(output),
            "render_report": {
                "version": "1.0",
                "outputs": [{"path": str(output)}],
                "warnings": [],
                "verification_notes": ["fake render"],
            },
            "storyboard": kwargs["storyboard"],
            "artifacts": {},
            "outputs": [],
        }

    def process_dies_after_db_commit(journal):
        if journal.operation == "render" and not crashed["value"]:
            crashed["value"] = True
            raise SystemExit("simulated process death after db commit")
        return original_complete(journal)

    monkeypatch.setattr("server.app.main.render_short_drama_project", render)
    monkeypatch.setattr(ProjectMutationJournal, "complete", process_dies_after_db_commit)
    app.state.fake_newapi.video_status = "completed"

    with pytest.raises(SystemExit, match="after db commit"):
        client.post(f"/api/projects/{project_id}/render", json={})

    final_path = app.state.store.project_dir(project_id) / "renders" / "final.mp4"
    assert final_path.is_file()
    assert (projects_root / ".recovery" / project_id).is_dir()
    execute_count = len(app.state.fake_newapi.execute_calls)
    app.state.test_db.rollback()
    monkeypatch.setattr(ProjectMutationJournal, "complete", original_complete)
    app.state.store = WorkbenchStore(projects_root=projects_root)

    assert not final_path.exists()
    assert not (projects_root / ".recovery").exists()
    loaded = client.get(f"/api/projects/{project_id}")
    assert loaded.status_code == 200
    assert loaded.json()["final_path"] is None

    rerendered = client.post(f"/api/projects/{project_id}/render", json={})

    assert rerendered.status_code == 200
    assert final_path.is_file()
    assert len(app.state.fake_newapi.execute_calls) == execute_count


def test_worker_keeps_older_billed_video_detached_after_shot_edit(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    stale_shot = created["storyboard"]["shots"][0]
    app.state.fake_newapi.video_status = "queued"
    assert client.post(f"/api/projects/{project_id}/render", json={}).status_code == 409

    edited = client.patch(
        f"/api/projects/{project_id}/shots/{stale_shot['id']}",
        json={"prompt": "A newer shot version must win."},
    )
    assert edited.status_code == 200
    assert edited.json()["shot"]["version"] == stale_shot["version"] + 1

    app.state.fake_newapi.video_status = "completed"
    assert reconcile_due_jobs(
        app.state.test_db,
        app.state.fake_newapi,
        datetime.now(timezone.utc),
        100,
        settings=get_settings(),
        media_store=app.state.store,
    ) == len(created["storyboard"]["shots"])

    storyboard = app.state.store.read_artifact(project_id, "episode_storyboard.json")
    current = next(shot for shot in storyboard["shots"] if shot["id"] == stale_shot["id"])
    assert current["version"] == stale_shot["version"] + 1
    assert current["prompt"] == "A newer shot version must win."
    assert current["status"] != "complete"
    assert current["output_path"] is None
    assert not (
        app.state.store.project_dir(project_id)
        / "assets"
        / "video"
        / f"{stale_shot['id']}.mp4"
    ).exists()


def test_latest_project_disabled_in_public_mode(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    response = client.get("/api/projects/latest")

    assert response.status_code == 404
    assert response.json()["detail"] == "Global latest project is disabled"


def test_create_app_preserves_expired_durable_media_across_restarts(tmp_path):
    projects_root = tmp_path / "projects"
    old_video = projects_root / "p1" / "assets" / "video" / "old.mp4"
    old_video.parent.mkdir(parents=True)
    old_video.write_bytes(b"old")

    import os
    from datetime import UTC, datetime, timedelta

    old_time = (datetime.now(UTC) - timedelta(days=4)).timestamp()
    os.utime(old_video, (old_time, old_time))

    create_app(db_path=tmp_path / "workbench.db", projects_root=projects_root)
    create_app(db_path=tmp_path / "workbench.db", projects_root=projects_root)

    assert old_video.exists()


def test_reference_image_upload_persists_asset_library_and_project_snapshot(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = client.post("/api/projects", json={"title": "Draft", "project_type": "single_video"}).json()
    project_id = created["project"]["id"]
    _mark_creative_workflow_approved(app, project_id)

    response = client.post(
        f"/api/projects/{project_id}/assets/upload",
        data={
            "kind": "character",
            "label": "Lin reference",
            "description": "red coat",
            "prompt": "red coat portrait",
        },
        files={"file": ("lin.png", b"fake-png", "image/png")},
    )

    assert response.status_code == 200
    asset = response.json()["asset"]
    assert asset["label"] == "Lin reference"
    assert asset["media_urls"][0].startswith(f"/api/projects/{project_id}/media/assets/images/character/")
    loaded = client.get(f"/api/projects/{project_id}").json()
    assert loaded["series_bible"]["assets"][0]["id"] == asset["id"]


def test_save_continuity_plan_updates_project_snapshot_and_handoff(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = client.post("/api/projects", json={"title": "Draft", "project_type": "long_series"}).json()
    project_id = created["project"]["id"]

    continuity_plan = created["continuity_plan"]
    continuity_plan["active_episode_number"] = 1
    continuity_plan["series_bible"]["worldview"] = "Rain city relay network"
    continuity_plan["sound"] = {
        "narration": "First-person restrained narration",
        "dialogue": "Keep dialogue natural",
        "ambience": "Rain and distant traffic",
        "music_direction": "Sparse piano",
        "prompt": "Intimate rain-night soundscape",
        "storyboard_prompt_integration": True,
    }
    continuity_plan["generation_preferences"] = {
        "image_model": "image-model-phase-9",
        "video_model": "video-model-phase-9",
        "image_size": "1536x1024",
        "image_quality": "high",
        "aspect_ratio": "16:9",
    }
    continuity_plan["episodes"] = [
        {
            "episode_number": 1,
            "title": "Pilot",
            "goal": "Expose the missing package",
            "conflict": "Lin is blocked by Chen",
            "twist": "The package is a decoy",
            "cliffhanger": "A second relay appears",
            "inherited_state": [],
            "locked": False,
        }
    ]

    response = client.patch(f"/api/projects/{project_id}/continuity", json=continuity_plan)

    assert response.status_code == 200
    body = response.json()
    assert body["continuity_plan"]["active_episode_number"] == 1
    assert body["continuity_plan"]["sound"]["narration"] == "First-person restrained narration"
    assert body["continuity_plan"]["generation_preferences"]["video_model"] == "video-model-phase-9"
    loaded = client.get(f"/api/projects/{project_id}").json()
    assert loaded["continuity_plan"]["series_bible"]["worldview"] == "Rain city relay network"
    assert loaded["continuity_plan"]["sound"]["prompt"] == "Intimate rain-night soundscape"
    assert app.state.fake_newapi.execute_calls == []


def test_create_short_drama_project_uses_server_text_model_billing(tmp_path):
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
    job = app.state.test_db.query(GenerationJob).filter(
        GenerationJob.operation == "storyboard_generation"
    ).one()
    assert job.model == "gpt-5.5"
    assert job.capability == "text"
    assert job.status == "billed"
    assert response.json()["storyboard"]["shots"][0]["shot_language"]["shot_size"] == "medium_close"


def test_create_short_drama_quote_failure_returns_sanitized_error_without_child(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    app.state.fake_newapi.quote_failure = True

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
    assert response.json() == {"code": "provider_call_failed"}
    assert list((tmp_path / "projects").iterdir()) == []
    assert app.state.test_db.query(GenerationJob).count() == 0
    assert app.state.test_db.query(ProjectRecord).count() == 0

    app.state.fake_newapi.quote_failure = False
    retry = client.post(
        "/api/projects/short-drama",
        json={"title": "Rain Alley", "prompt": "rain-night urban reversal short drama"},
    )

    assert retry.status_code == 200, retry.text
    assert app.state.test_db.query(ProjectRecord).count() == 1
    assert len(list((tmp_path / "projects").iterdir())) == 1


def test_create_short_drama_quote_rate_limit_rolls_back_project_and_retry_succeeds(
    tmp_path,
):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    app.state.fake_newapi.quote_rate_limited = True

    response = client.post(
        "/api/projects/short-drama",
        json={"title": "Rain Alley", "prompt": "rain-night urban reversal short drama"},
    )

    assert response.status_code == 429
    assert response.json() == {"code": "provider_quote_rate_limited"}
    assert app.state.test_db.query(ProjectRecord).count() == 0
    assert app.state.test_db.query(GenerationJob).count() == 0
    assert list((tmp_path / "projects").iterdir()) == []

    app.state.fake_newapi.quote_rate_limited = False
    retry = client.post(
        "/api/projects/short-drama",
        json={"title": "Rain Alley", "prompt": "rain-night urban reversal short drama"},
    )

    assert retry.status_code == 200, retry.text
    assert app.state.test_db.query(ProjectRecord).count() == 1
    assert len(list((tmp_path / "projects").iterdir())) == 1


def test_create_short_drama_invalid_quote_rolls_back_project_before_retry(
    tmp_path,
):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    app.state.fake_newapi.invalid_quote = True

    response = client.post(
        "/api/projects/short-drama",
        json={"title": "Rain Alley", "prompt": "rain-night urban reversal short drama"},
    )

    assert response.status_code == 503
    assert response.json() == {"code": "provider_pricing_unavailable"}
    assert app.state.test_db.query(ProjectRecord).count() == 0
    assert app.state.test_db.query(GenerationJob).count() == 0
    assert list((tmp_path / "projects").iterdir()) == []

    app.state.fake_newapi.invalid_quote = False
    retry = client.post(
        "/api/projects/short-drama",
        json={"title": "Rain Alley", "prompt": "rain-night urban reversal short drama"},
    )

    assert retry.status_code == 200, retry.text
    assert app.state.test_db.query(ProjectRecord).count() == 1
    assert len(list((tmp_path / "projects").iterdir())) == 1


def test_create_short_drama_insufficient_balance_rolls_back_project_and_retry_succeeds(
    tmp_path,
):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    wallet = app.state.test_db.query(WalletAccount).filter_by(user_id=TEST_USER.id).one()
    wallet.balance_units = 0
    app.state.test_db.commit()

    response = client.post(
        "/api/projects/short-drama",
        json={"title": "Rain Alley", "prompt": "rain-night urban reversal short drama"},
    )

    assert response.status_code == 402
    assert response.json() == {"code": "payment_required"}
    assert app.state.test_db.query(ProjectRecord).count() == 0
    assert app.state.test_db.query(GenerationJob).count() == 0
    assert list((tmp_path / "projects").iterdir()) == []

    wallet.balance_units = 1_000_000_000
    app.state.test_db.commit()
    retry = client.post(
        "/api/projects/short-drama",
        json={"title": "Rain Alley", "prompt": "rain-night urban reversal short drama"},
    )

    assert retry.status_code == 200, retry.text
    assert app.state.test_db.query(ProjectRecord).count() == 1
    assert len(list((tmp_path / "projects").iterdir())) == 1


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




def test_regenerate_middle_shot_requires_previous_first_frame_dependency(
    tmp_path, monkeypatch
):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    storyboard = app.state.store.read_artifact(project_id, "episode_storyboard.json")
    middle = storyboard["shots"][1]
    middle["continuity"] = {
        "mode": "carry",
        "inherit_previous_tail": True,
        "first_frame": None,
        "last_frame": None,
    }
    app.state.store.write_artifact(project_id, "episode_storyboard.json", storyboard)
    called = False

    def should_not_generate(**_kwargs):
        nonlocal called
        called = True
        raise AssertionError("provider generation must wait for the previous frame")

    monkeypatch.setattr("server.app.main.run_single_shot_generation", should_not_generate)

    response = client.post(
        f"/api/projects/{project_id}/shots/{middle['id']}/regenerate",
        json={"video_model": "omni_flash-10s"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "previous_shot_missing",
        "message": "上一个分镜未生成，暂时无法生成当前分镜。",
        "previous_shot_id": storyboard["shots"][0]["id"],
    }
    assert called is False


def test_regenerate_completed_shot_requires_current_first_and_last_frames(
    tmp_path, monkeypatch
):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot = app.state.store.read_artifact(project_id, "episode_storyboard.json")["shots"][0]
    shot["status"] = "complete"
    shot["continuity"] = {
        "mode": "cut",
        "inherit_previous_tail": False,
        "first_frame": None,
        "last_frame": None,
    }
    storyboard = app.state.store.read_artifact(project_id, "episode_storyboard.json")
    storyboard["shots"][0] = shot
    app.state.store.write_artifact(project_id, "episode_storyboard.json", storyboard)
    called = False

    def should_not_generate(**_kwargs):
        nonlocal called
        called = True
        raise AssertionError("provider generation must wait for current frames")

    monkeypatch.setattr("server.app.main.run_single_shot_generation", should_not_generate)

    response = client.post(
        f"/api/projects/{project_id}/shots/{shot['id']}/regenerate",
        json={"video_model": "omni_flash-10s"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "shot_frame_dependencies_missing",
        "message": "二次生成需要当前镜头的首帧和尾帧，请先完成画面依赖准备。",
        "shot_id": shot["id"],
    }
    assert called is False






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


def test_save_shot_preserves_completed_render_after_metadata_change(tmp_path):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]
    storyboard = app.state.store.read_artifact(project_id, "episode_storyboard.json")
    shot = storyboard["shots"][0]
    output = app.state.store.project_dir(project_id) / "assets" / "video" / f"{shot_id}.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"completed-video")
    shot["status"] = "complete"
    shot["output_path"] = str(output)
    shot["output_url"] = "https://video.example/s1.mp4"
    app.state.store.write_artifact(project_id, "episode_storyboard.json", storyboard)

    response = client.patch(
        f"/api/projects/{project_id}/shots/{shot_id}",
        json={
            "prompt": "Lin pauses under the neon sign with a new reveal.",
            "location": "rainy alley",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["shot"]["output_path"].replace("\\", "/").endswith(
        "/assets/video/s1.mp4"
    )
    assert body["shot"]["output_url"] == "https://video.example/s1.mp4"
    assert body["shot"]["status"] == "complete"
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


def test_save_shot_can_assign_and_clear_episode_number(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]

    assigned = client.patch(
        f"/api/projects/{project_id}/shots/{shot_id}",
        json={"episode_number": 2},
    )

    assert assigned.status_code == 200
    assert assigned.json()["shot"]["episode_number"] == 2
    assert assigned.json()["shot"]["version"] == 2

    cleared = client.patch(
        f"/api/projects/{project_id}/shots/{shot_id}",
        json={"episode_number": None},
    )

    assert cleared.status_code == 200
    assert cleared.json()["shot"]["episode_number"] is None
    assert cleared.json()["shot"]["version"] == 3
    reloaded = client.get(f"/api/projects/{project_id}")
    assert reloaded.status_code == 200
    persisted = next(
        shot for shot in reloaded.json()["storyboard"]["shots"] if shot["id"] == shot_id
    )
    assert persisted["episode_number"] is None


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


def test_save_shot_accepts_real_nine_shot_continuity_payload(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]

    response = client.patch(
        f"/api/projects/{project_id}/shots/s1",
        json={
            "prompt": "Cinematic emotional reunion shot on the dawn platform.",
            "characters": ["char_girl_lin", "char_father_chen"],
            "location": "清晨站台中央",
            "props": ["prop_recorder"],
            "asset_ids": ["prop_recorder"],
            "shot_intent": "完成父女重逢和情绪闭环。",
            "shot_language": {
                "shot_size": "medium_close",
                "camera_movement": "dolly_in",
                "lens_mm": 50,
                "lighting_key": "golden_hour",
                "depth_of_field": "medium",
                "color_temperature": "warm",
            },
            "continuity": {
                "mode": "cut",
                "inherit_previous_tail": False,
                "explicit_user_first_frame_asset_id": None,
                "inherited_first_frame_asset_id": None,
                "last_frame_asset_id": None,
                "first_frame": None,
                "last_frame": None,
                "stale": False,
                "composition": "",
                "subject_pose": "",
                "gaze": "",
                "motion_direction": "",
                "lighting": "",
                "scene_state": "",
            },
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["shot"]["asset_ids"] == ["prop_recorder"]
    assert body["shot"]["continuity"]["mode"] == "cut"
    assert body["shot"]["continuity"]["first_frame"] is None


def test_save_shot_stales_tail_asset_and_downstream_inheritance_without_deleting_media(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    store = app.state.store
    db = app.state.test_db
    project_dir = store.project_dir(project_id)
    frame_path = project_dir / "assets" / "images" / "keyframes" / "s1-tail.png"
    frame_path.parent.mkdir(parents=True, exist_ok=True)
    frame_path.write_bytes(b"old-tail-frame")
    repository = MediaAssetRepository(db, store)
    tail = repository.create_video_frame(
        owner_user_id=TEST_USER.id,
        origin_project_id=project_id,
        shot_id="s1",
        video_version=1,
        media_sha256="a" * 64,
        sample_time_seconds=4.9,
        storage_path="assets/images/keyframes/s1-tail.png",
    )
    db.commit()
    asset_record = compatible_asset_record(
        tail,
        project_id=project_id,
        storage_path="assets/images/keyframes/s1-tail.png",
    )
    series_bible = store.read_artifact(project_id, "series_bible.json")
    storyboard = store.read_artifact(project_id, "episode_storyboard.json")
    series_bible["assets"] = [asset_record]
    first, second = storyboard["shots"][:2]
    first["continuity"] = {
        "mode": "carry",
        "inherit_previous_tail": True,
        "last_frame_asset_id": tail.id,
        "last_frame": {
            "asset_id": tail.id,
            "version": 1,
            "status": "ready",
            "source": "video_extract",
        },
    }
    second["continuity"] = {
        "mode": "carry",
        "inherit_previous_tail": True,
        "inherited_first_frame_asset_id": tail.id,
        "first_frame": {
            "asset_id": tail.id,
            "version": 1,
            "status": "ready",
            "source": "inherited",
            "origin_shot_id": "s1",
            "origin_shot_version": 1,
            "origin_frame_version": 1,
        },
    }
    store.write_artifact(project_id, "series_bible.json", series_bible)
    store.write_asset_library(project_id, [asset_record])
    store.write_artifact(project_id, "episode_storyboard.json", storyboard)

    response = client.patch(
        f"/api/projects/{project_id}/shots/s1",
        json={"prompt": "Changed upstream shot prompt."},
    )

    assert response.status_code == 200, response.text
    reloaded = store.read_artifact(project_id, "episode_storyboard.json")
    assets = store.read_asset_library(project_id)
    db.refresh(tail)
    assert reloaded["shots"][0]["continuity"]["last_frame"]["status"] == "stale"
    assert reloaded["shots"][1]["continuity"]["first_frame"]["status"] == "stale"
    assert assets[0]["status"] == "stale"
    assert tail.status == "stale"
    assert frame_path.is_file()


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
    _mark_creative_workflow_approved(app, project_id)

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
    assert "requested_duration_seconds" not in asset_manifest["assets"][0]
    assert edit_decisions["render_runtime"] == "ffmpeg"








def test_optimize_prompt_route_returns_structured_shot_fields(tmp_path):
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
            "text_key": TEXT_TEST_KEY,
            "base_url": "https://api.0000238.xyz",
            "text_model": "gpt-5.5",
            "mode": "shot_json",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["optimized_text"] == "optimized shot prompt"
    assert body["shot_intent"] == "Reveal the clue."
    assert body["shot_language"]["camera_movement"] == "dolly_in"


def test_optimize_prompt_route_ignores_browser_base_url_and_defaults_text_mode(tmp_path):
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
            "text_key": TEXT_TEST_KEY,
            "base_url": "   ",
            "text_model": "gpt-5.5",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["optimized_text"] == "optimized prompt"
    assert body["notes"] == ["rewritten by text model"]


def test_optimize_asset_prompt_route_forwards_asset_kind(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    project_id = client.post(
        "/api/projects",
        json={"title": "Asset prompt", "project_type": "single_video"},
    ).json()["project"]["id"]
    captured = {}

    def fake_optimize_text_prompt(**kwargs):
        captured.update(kwargs)
        return {"optimized_text": "prop reference sheet", "notes": []}

    monkeypatch.setattr("server.app.main.optimize_text_prompt", fake_optimize_text_prompt)

    response = client.post(
        f"/api/projects/{project_id}/prompt-optimize",
        json={
            "target": "asset",
            "target_id": "image-generation-draft",
            "asset_kind": "prop",
            "source_text": "An old pocket watch.",
        },
    )

    assert response.status_code == 200, response.text
    assert captured["context"] == {
        "target": "asset",
        "target_id": "image-generation-draft",
        "mode": "text",
        "asset_kind": "prop",
    }


def test_optimize_prompt_route_normalizes_invalid_optional_structured_fields(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]

    app.state.fake_newapi.invalid_prompt = True

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
    assert response.json()["shot_language"]["camera_movement"] is None


def test_optimize_prompt_route_ignores_legacy_whitespace_text_key(tmp_path):
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

    assert response.status_code == 200


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
    _mark_creative_workflow_approved(app, project_id)
    VideoModelDurationService(app.state.test_db).update(
        provider="newapi",
        model_id="veo_3_1-lite",
        call_duration_seconds=10,
        expected_version=0,
        updated_by=TEST_USER.id,
        reason="test verified render contract",
    )
    app.state.test_db.commit()
    monkeypatch.setattr(
        "server.app.openmontage_runner.probe_media",
        lambda _path: {"duration_seconds": 10.0},
    )

    captured_render_kwargs = {}

    def fake_render_short_drama_project(**kwargs):
        captured_render_kwargs.update(kwargs)
        storyboard = kwargs["storyboard"]
        for shot in storyboard["shots"]:
            output = kwargs["generate_missing_shot"](shot)
            shot["status"] = "complete"
            shot["output_path"] = output["output_path"]
        final_path = kwargs["composition_output_path"]
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
    assert captured_render_kwargs["video_model"] == "veo_3_1-lite"
    assert "video_key" not in captured_render_kwargs

    loaded = client.get(f"/api/projects/{project_id}").json()
    assert loaded["storyboard"]["shots"][0]["status"] == "complete"
    assert loaded["final_path"].endswith("final.mp4")
    assert loaded["render_report"]["outputs"][0]["path"].endswith("final.mp4")


def test_prepare_render_returns_authoritative_readiness_balance_and_output(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    project_dir = app.state.store.project_dir(project_id)
    storyboard = app.state.store.read_artifact(project_id, "episode_storyboard.json")
    first = storyboard["shots"][0]
    first_output = project_dir / "assets" / "video" / f"{first['id']}.mp4"
    first_output.parent.mkdir(parents=True, exist_ok=True)
    first_output.write_bytes(b"reusable")
    first["output_path"] = str(first_output)
    first["status"] = "complete"
    app.state.store.write_artifact(project_id, "episode_storyboard.json", storyboard)
    execution_calls_before_prepare = list(app.state.fake_newapi.execute_calls)

    response = client.post(
        f"/api/projects/{project_id}/render/prepare",
        json={"render_runtime": "ffmpeg", "video_model": "omni_flash-10s"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    missing = len(storyboard["shots"]) - 1
    assert body["shot_summary"] == {
        "total": len(storyboard["shots"]),
        "reusable": 1,
        "to_generate": missing,
        "completed": 1,
    }
    assert body["estimated_units"] == 0
    wallet = app.state.test_db.query(WalletAccount).filter_by(user_id=TEST_USER.id).one()
    assert body["available_units"] == wallet.balance_units - wallet.held_units
    assert body["estimate_status"] == "not_required"
    assert body["readiness"]["ready"] is False
    assert len(body["readiness"]["blockers"]) == missing
    assert {item["code"] for item in body["readiness"]["blockers"]} == {
        "shot_media_missing"
    }
    assert body["output"]["format"] == "mp4"
    assert body["output"]["render_runtime"] == "ffmpeg"
    assert app.state.fake_newapi.execute_calls == execution_calls_before_prepare


def test_prepare_render_describes_next_timeline_instead_of_previous_output(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    store = app.state.store

    storyboard = store.read_artifact(project_id, "episode_storyboard.json")
    for shot in storyboard["shots"]:
        shot["source_duration_seconds"] = 10.0
        shot["timeline_duration_seconds"] = 10.0
        shot["requested_duration_seconds"] = 10.0
    store.write_artifact(project_id, "episode_storyboard.json", storyboard)

    workflow = store.read_artifact(project_id, "creative_workflow.json")
    workflow["brief"] = {
        **(workflow.get("brief") or {}),
        "duration_seconds": 30,
        "aspect_ratio": "16:9",
    }
    store.write_artifact(project_id, "creative_workflow.json", workflow)
    store.write_artifact(
        project_id,
        "render_report.json",
        {
            "version": "1.0",
            "outputs": [{
                "path": "renders/final.mp4",
                "format": "mp4",
                "resolution": "1920x1080",
                "duration_seconds": 30,
            }],
            "warnings": [],
            "verification_notes": [],
        },
    )

    response = client.post(
        f"/api/projects/{project_id}/render/prepare",
        json={"render_runtime": "ffmpeg", "video_model": "omni_flash-10s"},
    )

    assert response.status_code == 200, response.text
    output = response.json()["output"]
    assert output["duration_seconds"] == len(storyboard["shots"]) * 10
    assert output["target_duration_seconds"] == 30
    assert output["duration_difference_seconds"] == len(storyboard["shots"]) * 10 - 30


def test_series_render_composes_active_episode_and_preserves_other_episode_outputs(
    tmp_path,
    monkeypatch,
):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    draft = client.post(
        "/api/projects",
        json={"title": "Rain Letter Series", "project_type": "mini_series"},
    ).json()
    project_id = draft["project"]["id"]
    assert client.post(
        f"/api/projects/{project_id}/inspiration/chat",
        json={"messages": [{"role": "user", "content": "A warning from tomorrow."}]},
    ).status_code == 200
    planned = client.post(
        f"/api/projects/{project_id}/storyboard/plan",
        json={"prompt": "A compact serialized suspense story."},
    )
    assert planned.status_code == 200, planned.text
    _mark_creative_workflow_approved(app, project_id)

    store = app.state.store
    project_dir = store.project_dir(project_id)
    storyboard = store.read_artifact(project_id, "episode_storyboard.json")
    assert {shot["episode_number"] for shot in storyboard["shots"]} == {1}
    episode_two_shot = deepcopy(storyboard["shots"][0])
    episode_two_shot.update(
        {
            "id": "episode-2-shot-1",
            "index": 1,
            "episode_number": 2,
            "status": "complete",
            "output_path": "assets/video/episode-2-shot-1.mp4",
        }
    )
    episode_two_media = project_dir / episode_two_shot["output_path"]
    episode_two_media.parent.mkdir(parents=True, exist_ok=True)
    episode_two_media.write_bytes(b"episode two shot")
    storyboard["shots"].append(episode_two_shot)
    store.write_artifact(project_id, "episode_storyboard.json", storyboard)
    selected_episode_one_shot_ids = [
        storyboard["shots"][0]["id"],
        storyboard["shots"][2]["id"],
    ]

    episode_two_final = project_dir / "renders" / "episode-002.mp4"
    episode_two_final.parent.mkdir(parents=True, exist_ok=True)
    episode_two_final.write_bytes(b"episode two final")
    store.write_artifact(
        project_id,
        "render_report.json",
        {
            "version": "1.0",
            "outputs": [
                {
                    "path": str(episode_two_final),
                    "format": "mp4",
                    "resolution": "720x1280",
                    "duration_seconds": 10,
                    "episode_number": 2,
                    "episode_title": "Episode 2",
                }
            ],
            "warnings": [],
            "verification_notes": ["existing episode"],
        },
    )

    preparation = client.post(
        f"/api/projects/{project_id}/render/prepare",
        json={
            "render_runtime": "ffmpeg",
            "selected_shot_ids": selected_episode_one_shot_ids,
        },
    )
    assert preparation.status_code == 200, preparation.text
    prepared = preparation.json()
    assert prepared["render_scope"] == {
        "kind": "episode",
        "episode_number": 1,
        "episode_title": "The first warning",
        "total_episodes": 3,
    }
    assert prepared["shot_summary"]["total"] == 2
    assert prepared["selected_shot_ids"] == selected_episode_one_shot_ids

    cross_episode = client.post(
        f"/api/projects/{project_id}/render/prepare",
        json={"selected_shot_ids": [episode_two_shot["id"]]},
    )
    assert cross_episode.status_code == 422
    assert cross_episode.json()["detail"] == {
        "code": "selected_shots_outside_render_scope",
        "shot_ids": [episode_two_shot["id"]],
    }

    captured = {}

    def fake_render_short_drama_project(**kwargs):
        captured.update(kwargs)
        final_path = kwargs["composition_output_path"]
        final_path.parent.mkdir(parents=True, exist_ok=True)
        final_path.write_bytes(b"episode one final")
        return {
            "final_path": str(final_path),
            "render_report": {
                "version": "1.0",
                "outputs": [
                    {
                        "path": str(final_path),
                        "format": "mp4",
                        "resolution": "720x1280",
                        "duration_seconds": 20,
                    }
                ],
                "warnings": [],
                "verification_notes": ["episode render"],
            },
            "storyboard": kwargs["storyboard"],
            "artifacts": {},
            "outputs": [],
        }

    monkeypatch.setattr(
        "server.app.main.render_short_drama_project",
        fake_render_short_drama_project,
    )
    rendered = client.post(
        f"/api/projects/{project_id}/render",
        json={
            "render_runtime": "ffmpeg",
            "selected_shot_ids": selected_episode_one_shot_ids,
        },
    )

    assert rendered.status_code == 200, rendered.text
    body = rendered.json()
    assert [shot["id"] for shot in captured["storyboard"]["shots"]] == (
        selected_episode_one_shot_ids
    )
    assert body["final_path"] == "renders/episode-001.mp4"
    assert [output["episode_number"] for output in body["render_report"]["outputs"]] == [1, 2]
    assert body["render_report"]["outputs"][0]["shot_ids"] == (
        selected_episode_one_shot_ids
    )
    loaded = client.get(f"/api/projects/{project_id}").json()
    assert loaded["final_path"] == "renders/episode-001.mp4"
    assert {shot["id"] for shot in loaded["storyboard"]["shots"]} == {
        *(shot["id"] for shot in storyboard["shots"]),
    }
    assert episode_two_final.read_bytes() == b"episode two final"


def test_render_plan_output_spec_uses_approved_ratio_over_stale_render_report():
    from server.app.main import _render_plan_output_spec

    result = _render_plan_output_spec(
        {"brief": {"aspect_ratio": "16:9", "duration_seconds": 12}},
        {"shots": [{"id": "s1"}, {"id": "s2"}, {"id": "s3"}]},
        {"outputs": [{"resolution": "720x1280", "fps": 24}]},
    )

    assert result == {
        "width": 1920,
        "height": 1080,
        "fps": 24.0,
        "format": "mp4",
        "video_codec": "h264",
        "audio_codec": "aac",
    }


def test_prepare_render_uses_the_creative_approval_gate(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = client.post(
        "/api/projects",
        json={"title": "Unapproved", "project_type": "single_video"},
    ).json()

    response = client.post(
        f"/api/projects/{created['project']['id']}/render/prepare",
        json={"render_runtime": "ffmpeg"},
    )

    assert response.status_code == 409
    assert response.json() == {
        "detail": "Creative plan must be approved before production"
    }
    assert app.state.fake_newapi.counter == 0


def test_load_project_restores_latest_render_job_and_shot_summary(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    parent = GenerationJob.parent(
        id="f" * 32,
        user_id=TEST_USER.id,
        project_id=project_id,
        operation="render",
    )
    app.state.test_db.add(parent)
    app.state.test_db.commit()

    response = client.get(f"/api/projects/{project_id}")

    assert response.status_code == 200
    production = response.json()["production"]
    assert production["active_job"] == {
        "id": "f" * 32,
        "status": "running",
        "updated_at": parent.updated_at.isoformat(),
        "billing_job_id": None,
        "estimated_units": None,
        "resume_available": False,
    }
    assert production["shot_summary"]["total"] == len(created["storyboard"]["shots"])


def test_render_rejects_duplicate_running_parent_before_provider_execution(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    parent = GenerationJob.parent(
        id="e" * 32,
        user_id=TEST_USER.id,
        project_id=project_id,
        operation="render",
    )
    app.state.test_db.add(parent)
    app.state.test_db.commit()
    execution_calls = list(app.state.fake_newapi.execute_calls)

    preparation = client.post(
        f"/api/projects/{project_id}/render/prepare",
        json={"render_runtime": "ffmpeg"},
    )
    assert preparation.status_code == 409
    assert preparation.json() == {
        "detail": {"code": "render_in_progress", "job_id": "e" * 32}
    }

    response = client.post(
        f"/api/projects/{project_id}/render",
        json={"render_runtime": "ffmpeg"},
    )

    assert response.status_code == 409
    assert response.json() == {
        "detail": {"code": "render_in_progress", "job_id": "e" * 32}
    }
    assert app.state.fake_newapi.execute_calls == execution_calls


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
    _mark_creative_workflow_approved(app, project_id)
    VideoModelDurationService(app.state.test_db).update(
        provider="newapi",
        model_id="veo_3_1-lite",
        call_duration_seconds=10,
        expected_version=0,
        updated_by=TEST_USER.id,
        reason="test verified render contract",
    )
    app.state.test_db.commit()
    monkeypatch.setattr(
        "server.app.openmontage_runner.probe_media",
        lambda _path: {"duration_seconds": 10.0},
    )

    def fake_render_short_drama_project(**kwargs):
        project_dir = kwargs["project_dir"]
        storyboard = kwargs["storyboard"]
        reference_image = project_dir / "assets" / "images" / "character" / "lin.png"
        reference_image.parent.mkdir(parents=True, exist_ok=True)
        reference_image.write_bytes(b"fake reference image")

        for shot in storyboard["shots"]:
            kwargs["generate_missing_shot"](shot)
            shot["status"] = "complete"
            shot["output_path"] = str(project_dir / "assets" / "video" / f"{shot['id']}.mp4")

        final_path = kwargs["composition_output_path"]
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
        final_path = kwargs["composition_output_path"]
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


def test_render_project_sanitizes_provider_error_in_response_events_sse_and_logs(
    tmp_path, monkeypatch, caplog
):
    from server.app.events import _format_sse

    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    caplog.set_level(logging.DEBUG)

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
    _mark_creative_workflow_approved(app, project_id)

    leaked_values = [
        "sk-live-fake-api-key",
        "Authorization: Bearer fake-header-token",
        "https://user:fake-password@credentials.example/provider?session=fake-session-code",
    ]
    provider_error = " | ".join(leaked_values)

    def fake_render_short_drama_project(**kwargs):
        kwargs["emit_event"]("assets", "failed", provider_error)
        raise RuntimeError(provider_error)

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
    assert response.json()["detail"] == "Project render failed"
    events = app.state.events.history(project_id)
    assert any(event["status"] == "failed" for event in events)
    public_output = "\n".join(
        [
            response.text,
            json.dumps(events),
            *[_format_sse(event) for event in events],
            caplog.text,
        ]
    )
    for leaked_value in leaked_values:
        assert leaked_value not in public_output
    assert all(
        event["message"] == "Project render failed"
        for event in events
        if event["status"] == "failed"
    )
