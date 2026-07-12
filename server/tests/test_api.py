import json
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from server.app.artifact_sync import rewrite_workflow_artifacts
from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.auth.models import User
from server.app.billing.models import (
    BillingReconciliation,
    BillingSetting,
    GenerationJob,
)
from server.app.billing.reconciliation import reconcile_due_jobs
from server.app.billing.execution import PaymentRequiredQuote
from server.app.core.config import get_settings
from server.app.db.base import Base
from server.app.db.session import get_db
from server.app.main import (
    RenderProjectRequest,
    ShortDramaRequest,
    _require_function_user,
    create_app as create_production_app,
    get_newapi_client,
)
from server.app.models import ImageGenerationRequest, PromptOptimizeRequest
from server.app.provider.newapi import (
    NewApiCallError,
    QuotedExecutionResult,
    TokenScopedQuote,
    UsageQuote,
    UsageReceipt,
    VideoTaskStatus,
)
from server.app.projects.models import ProjectRecord
from server.app.storage import ProjectMutationJournal, WorkbenchStore
from server.app.wallet.models import WalletAccount


TEST_USER = CurrentUser(
    id="api-test-user0000000000000000001",
    email="api-test@example.com",
    role="user",
)


def create_app(*, db_path, projects_root):
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
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
    db.commit()
    app = create_production_app(db_path=db_path, projects_root=projects_root)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[require_user] = lambda: TEST_USER
    app.dependency_overrides[require_csrf] = lambda: TEST_USER
    app.dependency_overrides[_require_function_user] = lambda: TEST_USER
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
        self.quote_failure = False
        self.video_status = "completed"
        self.execute_calls = []

    def close(self):
        return None

    def quote(self, kind, request, token_alias=None):
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
            elif str(body["messages"][0]["content"]).startswith("Create short-drama"):
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
        progress_callback=None,
    ):
        destination.write_bytes(b"fake video")
        if progress_callback is not None:
            progress_callback()
        return 10


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

    response = client.post("/api/projects", json={"title": "Draft", "project_type": "mini_series"})

    assert response.status_code == 200
    body = response.json()
    assert body["project"]["title"] == "Draft"
    assert body["project"]["project_type"] == "mini_series"
    assert body["continuity_plan"]["project_type"] == "mini_series"
    assert body["storyboard"]["shots"] == []
    assert body["workflow_artifacts"]


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
    client = TestClient(app)
    created = client.post("/api/projects", json={"title": "Images"}).json()
    project_id = created["project"]["id"]

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

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"job_id", "images"}
    assert "quote" not in response.text.lower()
    assert "request" not in response.text.lower()
    assert "attacker" not in response.text.lower()
    assert client.get(body["images"][0]).status_code == 200
    job = app.state.test_db.get(GenerationJob, body["job_id"])
    assert job.status == "billed" and job.result_visible is True


def test_initial_insufficient_balance_returns_sanitized_402_before_upstream(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app, raise_server_exceptions=False)
    created = client.post("/api/projects", json={"title": "No funds"}).json()
    project_id = created["project"]["id"]
    wallet = app.state.test_db.query(WalletAccount).filter_by(user_id=TEST_USER.id).one()
    wallet.balance_units = 0
    app.state.test_db.commit()

    response = client.post(
        f"/api/projects/{project_id}/images/generate",
        json={"prompt": "unaffordable frame"},
    )

    assert response.status_code == 402
    assert response.json() == {"code": "payment_required"}
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
    assert in_flight_retry.json() == {"code": "provider_result_pending"}
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

    def fake_compose(project_dir, _storyboard, *, output_path=None):
        output = output_path or project_dir / "renders" / "final.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"composed")
        return output

    monkeypatch.setattr("server.app.openmontage_runner.compose_final_video", fake_compose)
    second = client.post(f"/api/projects/{project_id}/render", json={})

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


def test_stale_public_video_bytes_are_not_served_after_shot_version_edit(
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
    assert client.get(media_url).status_code == 404


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

    def edit_then_compose(project_dir, _storyboard, *, output_path=None):
        edited_responses.append(
            editor.patch(
                f"/api/projects/{project_id}/shots/{target['id']}",
                json={"prompt": "Committed while composition was running."},
            )
        )
        output = output_path or project_dir / "renders" / "final.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"stale-composition")
        return output

    monkeypatch.setattr(
        "server.app.openmontage_runner.compose_final_video",
        edit_then_compose,
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

    def compose(project_dir, _storyboard, *, output_path=None):
        output = output_path or project_dir / "renders" / "final.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"composed")
        return output

    def process_dies_after_db_commit(journal):
        if journal.operation == "render" and not crashed["value"]:
            crashed["value"] = True
            raise SystemExit("simulated process death after db commit")
        return original_complete(journal)

    monkeypatch.setattr("server.app.openmontage_runner.compose_final_video", compose)
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


def test_reference_image_upload_persists_asset_library_and_project_snapshot(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = client.post("/api/projects", json={"title": "Draft", "project_type": "single_video"}).json()
    project_id = created["project"]["id"]

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
    loaded = client.get(f"/api/projects/{project_id}").json()
    assert loaded["continuity_plan"]["series_bible"]["worldview"] == "Rain city relay network"


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


def test_regenerate_shot_uses_server_video_credentials(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]

    response = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"base_url": "https://api.0000238.xyz", "video_model": "omni_flash-10s"},
    )

    assert response.status_code == 200


def test_regenerate_shot_ignores_whitespace_legacy_video_key(tmp_path, monkeypatch):
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
            "tool_result": {},
            "cost_usd": 0.0,
        }

    monkeypatch.setattr("server.app.main.run_single_shot_generation", fake_run_single_shot_generation)

    response = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"video_key": "   ", "base_url": "https://api.0000238.xyz", "video_model": "omni_flash-10s"},
    )

    assert response.status_code == 200
    assert len(calls) == 1


def test_regenerate_payment_required_quote_keeps_sanitized_billing_response(tmp_path, monkeypatch):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app, raise_server_exceptions=False)
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    shot_id = created["storyboard"]["shots"][0]["id"]
    job_id = "e" * 32

    def payment_required(**_kwargs):
        raise PaymentRequiredQuote(job_id)

    monkeypatch.setattr("server.app.main.run_single_shot_generation", payment_required)
    response = client.post(
        f"/api/projects/{project_id}/shots/{shot_id}/regenerate",
        json={"video_model": "omni_flash-10s"},
    )

    assert response.status_code == 402
    assert response.json() == {
        "code": "payment_required_quote",
        "billing_job_id": job_id,
    }


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
    assert failed_response.json()["detail"] == "Shot generation failed"
    assert app.state.events.history(project_id)[-1]["message"] == "Shot generation failed"

    loaded = client.get(f"/api/projects/{project_id}")
    assert loaded.status_code == 200
    reloaded_shot = loaded.json()["storyboard"]["shots"][0]
    assert reloaded_shot["status"] == "failed"
    assert reloaded_shot["output_path"] is None
    assert reloaded_shot["output_url"] is None


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

    captured_render_kwargs = {}

    def fake_render_short_drama_project(**kwargs):
        captured_render_kwargs.update(kwargs)
        project_dir = kwargs["project_dir"]
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
