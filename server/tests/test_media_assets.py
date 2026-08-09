from __future__ import annotations

import importlib
import threading
import time

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from server.app.assets.models import MediaAsset, MediaAssetProjectLink
from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.auth.models import User
from server.app.billing.models import GenerationJob
from server.app.main import _require_function_user
from server.app.tasks.worker import PublishOutcome, TaskExecutionContext
from server.app.wallet.models import WalletAccount
from server.tests.test_api import TEST_USER, _mark_creative_workflow_approved, create_app


BOB = CurrentUser(
    id="asset-test-bob00000000000000001",
    email="asset-bob@example.com",
    role="user",
)
MEDIA_ASSET_KEYS = {
    "id",
    "origin_project_id",
    "kind",
    "source_type",
    "label",
    "description",
    "prompt",
    "model",
    "generation_job_id",
    "provenance",
    "media_url",
    "status",
    "created_at",
}


def _new_client(tmp_path):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    return app, app.state.test_db


def _project(client, title: str) -> str:
    response = client.post("/api/projects", json={"title": title})
    assert response.status_code == 200, response.text
    project_id = response.json()["project"]["id"]
    _mark_creative_workflow_approved(client.app, project_id)
    return project_id


def _upload(client, project_id: str, *, kind: str = "character", label: str = "Lin"):
    response = client.post(
        f"/api/projects/{project_id}/assets/upload",
        data={
            "kind": kind,
            "label": label,
            "description": f"{label} description",
            "prompt": f"{label} prompt",
        },
        files={"file": (f"{label}.png", b"image-bytes", "image/png")},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _as_user(app, user: CurrentUser) -> None:
    app.dependency_overrides[require_user] = lambda: user
    app.dependency_overrides[require_csrf] = lambda: user
    app.dependency_overrides[_require_function_user] = lambda: user


def _wait_for_task(client, project_id: str, task_id: str, expected: set[str]):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get(f"/api/projects/{project_id}/tasks/{task_id}")
        assert response.status_code == 200, response.text
        task = response.json()
        if task["status"] in expected:
            return task
        time.sleep(0.02)
    raise AssertionError(f"task {task_id} did not reach {expected}")


def test_media_asset_model_rejects_invalid_kind_and_duplicate_generation_output(
    tmp_path,
):
    from fastapi.testclient import TestClient

    app, db = _new_client(tmp_path)
    client = TestClient(app)
    project_id = _project(client, "Constraints")
    common = {
        "owner_user_id": TEST_USER.id,
        "origin_project_id": project_id,
        "source_type": "upload",
        "label": "Invalid",
        "description": "",
        "prompt": "",
        "storage_path": "assets/images/character/invalid.png",
        "content_type": "image/png",
        "status": "ready",
    }
    db.add(MediaAsset(id="1" * 32, kind="costume", **common))
    try:
        db.commit()
        raise AssertionError("invalid kind was accepted")
    except IntegrityError:
        db.rollback()

    generated = {
        "owner_user_id": TEST_USER.id,
        "origin_project_id": project_id,
        "kind": "scene",
        "source_type": "ai_generated",
        "label": "Frame",
        "description": "",
        "prompt": "frame",
        "model": "gpt-image-2",
        "generation_job_id": "a" * 32,
        "output_index": 0,
        "storage_path": "assets/images/generated/" + "a" * 32 + "-0.png",
        "content_type": "image/png",
        "status": "ready",
    }
    db.add_all(
        [
            MediaAsset(id="2" * 32, **generated),
            MediaAsset(id="3" * 32, **generated),
        ]
    )
    try:
        db.commit()
        raise AssertionError("duplicate generation output was accepted")
    except IntegrityError:
        db.rollback()


def test_media_asset_model_allows_recovered_ai_and_rejects_duplicate_recovery_key(
    tmp_path,
):
    from fastapi.testclient import TestClient

    app, db = _new_client(tmp_path)
    client = TestClient(app)
    project_id = _project(client, "Recovery constraints")
    common = {
        "owner_user_id": TEST_USER.id,
        "origin_project_id": project_id,
        "kind": "scene",
        "source_type": "ai_generated",
        "label": "Recovered",
        "description": "",
        "prompt": "legacy",
        "model": "old-image-model",
        "generation_job_id": None,
        "output_index": None,
        "recovery_key": "same-recovery-key",
        "content_type": "image/png",
        "status": "missing",
    }
    db.add(
        MediaAsset(
            id="4" * 32,
            storage_path="assets/images/generated/first.png",
            **common,
        )
    )
    db.commit()

    db.add(
        MediaAsset(
            id="5" * 32,
            storage_path="assets/images/generated/second.png",
            **common,
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_media_asset_migration_follows_current_head_and_registers_metadata():
    revision = importlib.import_module(
        "server.alembic.versions.014_legacy_asset_recovery"
    )

    assert revision.revision == "014"
    assert revision.down_revision == "013"
    assert MediaAsset.__table__.metadata.tables["media_assets"] is MediaAsset.__table__
    assert (
        MediaAssetProjectLink.__table__.metadata.tables["media_asset_project_links"]
        is MediaAssetProjectLink.__table__
    )
    assert {constraint.name for constraint in MediaAsset.__table__.constraints} >= {
        "ck_media_assets_kind",
        "ck_media_assets_source_shape",
        "uq_media_assets_generation_output",
        "uq_media_assets_owner_recovery_key",
    }


def test_recovered_ai_asset_is_visible_without_exposing_internal_recovery_key(tmp_path):
    from fastapi.testclient import TestClient

    app, db = _new_client(tmp_path)
    client = TestClient(app)
    project_id = _project(client, "Recovered")
    storage_path = "assets/images/generated/legacy.png"
    media_path = app.state.store.project_dir(project_id) / storage_path
    media_path.parent.mkdir(parents=True, exist_ok=True)
    media_path.write_bytes(b"legacy-image")
    asset_id = "4" * 32
    db.add_all(
        [
            MediaAsset(
                id=asset_id,
                owner_user_id=TEST_USER.id,
                origin_project_id=project_id,
                kind="scene",
                source_type="ai_generated",
                label="Legacy frame",
                description="Recovered metadata",
                prompt="Old prompt",
                model="old-image-model",
                generation_job_id=None,
                output_index=None,
                recovery_key="legacy-recovery-key",
                storage_path=storage_path,
                content_type="image/png",
                status="ready",
            ),
            MediaAssetProjectLink(
                asset_id=asset_id,
                project_id=project_id,
                storage_path=storage_path,
            ),
        ]
    )
    db.commit()

    response = client.get("/api/assets", params={"source_type": "ai_generated"})

    assert response.status_code == 200
    assets = response.json()["assets"]
    assert len(assets) == 1
    assert set(assets[0]) == MEDIA_ASSET_KEYS
    assert assets[0]["id"] == asset_id
    assert assets[0]["generation_job_id"] is None
    assert assets[0]["model"] == "old-image-model"
    assert "recovery_key" not in assets[0]


def test_upload_persists_library_asset_and_lists_with_filters_and_cursor(tmp_path):
    from fastapi.testclient import TestClient

    app, db = _new_client(tmp_path)
    with TestClient(app) as client:
        project_id = _project(client, "Uploads")
        first = _upload(client, project_id, kind="character", label="Lin")
        _upload(client, project_id, kind="scene", label="Alley")
        _upload(client, project_id, kind="prop", label="Key")

        assert set(first["library_asset"]) == MEDIA_ASSET_KEYS
        assert first["library_asset"]["source_type"] == "upload"
        assert first["asset"]["id"] == first["library_asset"]["id"]

        page_one = client.get("/api/assets", params={"limit": 2}).json()
        assert len(page_one["assets"]) == 2
        assert page_one["next_cursor"]
        page_two = client.get(
            "/api/assets",
            params={"limit": 2, "cursor": page_one["next_cursor"]},
        ).json()
        assert len(page_two["assets"]) == 1
        assert page_two["next_cursor"] is None
        assert {item["id"] for item in page_one["assets"]}.isdisjoint(
            {item["id"] for item in page_two["assets"]}
        )

        filtered = client.get(
            "/api/assets",
            params={
                "scope": "project",
                "project_id": project_id,
                "kind": "scene",
                "source_type": "upload",
            },
        ).json()
        assert [item["label"] for item in filtered["assets"]] == ["Alley"]

    with TestClient(app) as refreshed_client:
        refreshed = refreshed_client.get("/api/assets").json()
        assert len(refreshed["assets"]) == 3
        assert db.scalar(select(func.count(MediaAsset.id))) == 3


def test_image_generation_persists_assets_and_same_billing_job_is_idempotent(
    tmp_path,
):
    from fastapi.testclient import TestClient

    app, db = _new_client(tmp_path)
    with TestClient(app) as client:
        project_id = _project(client, "Generated")
        payload = {
            "prompt": "rainy alley",
            "model": "gpt-image-2",
            "count": 2,
            "kind": "scene",
            "label": "Rain alley",
            "description": "Night establishing reference",
        }

        first = client.post(f"/api/projects/{project_id}/images/generate", json=payload)
        assert first.status_code == 202, first.text
        accepted = first.json()
        completed = _wait_for_task(client, project_id, accepted["task_id"], {"complete"})
        assert completed["items"][0]["billing_job_id"]
        body = client.get(
            "/api/assets",
            params={"scope": "project", "project_id": project_id},
        ).json()
        assert len(body["assets"]) == 2
        assert all(set(asset) == MEDIA_ASSET_KEYS for asset in body["assets"])
        assert all(asset["source_type"] == "ai_generated" for asset in body["assets"])
        execute_count = len(app.state.fake_newapi.execute_calls)

        retry = client.post(f"/api/projects/{project_id}/images/generate", json=payload)
        assert retry.status_code == 202, retry.text
        assert retry.json()["deduplicated"] is True
        assert retry.json()["task_id"] == accepted["task_id"]
        assert len(app.state.fake_newapi.execute_calls) == execute_count
        assert db.scalar(select(func.count(MediaAsset.id))) == 2
        assert {
            asset["id"] for asset in app.state.store.read_asset_library(project_id)
        } == {asset["id"] for asset in body["assets"]}
        assert all(
            client.get(asset["media_url"]).status_code == 200 for asset in body["assets"]
        )

        job = db.get(GenerationJob, completed["items"][0]["billing_job_id"])
        job.result_visible = False
        db.commit()
        assert (
            client.get("/api/assets", params={"source_type": "ai_generated"}).json()[
                "assets"
            ]
            == []
        )
        assert client.get(body["assets"][0]["media_url"]).status_code == 404


def test_payment_required_and_provider_failure_create_no_visible_assets(tmp_path):
    from fastapi.testclient import TestClient

    app, db = _new_client(tmp_path)
    with TestClient(app, raise_server_exceptions=False) as client:
        project_id = _project(client, "Failures")
        wallet = db.query(WalletAccount).filter_by(user_id=TEST_USER.id).one()
        wallet.balance_units = 0
        db.commit()

        payment = client.post(
            f"/api/projects/{project_id}/images/generate",
            json={"prompt": "unaffordable", "kind": "scene", "label": "Nope"},
        )
        assert payment.status_code == 202
        blocked = _wait_for_task(
            client, project_id, payment.json()["task_id"], {"awaiting_payment"}
        )
        assert blocked["items"][0]["billing_job_id"] is None
        assert client.get("/api/assets").json()["assets"] == []

        wallet.balance_units = 1_000_000_000
        db.commit()
        retried = client.post(
            f"/api/projects/{project_id}/tasks/{blocked['id']}/items/{blocked['items'][0]['id']}/retry",
            json={},
        )
        assert retried.status_code == 202, retried.text
        _wait_for_task(client, project_id, blocked["id"], {"complete"})
        assert len(client.get("/api/assets").json()["assets"]) == 1

        app.state.fake_newapi.quote_failure = True
        provider = client.post(
            f"/api/projects/{project_id}/images/generate",
            json={"prompt": "provider down", "kind": "scene", "label": "Nope"},
        )
        assert provider.status_code == 202
        failed = _wait_for_task(
            client, project_id, provider.json()["task_id"], {"failed"}
        )
        assert failed["items"][0]["error_code"] == "provider_call_failed"
        assert len(client.get("/api/assets").json()["assets"]) == 1


def _planned_resources(app, project_id: str) -> list[dict]:
    resources = [
        {
            "id": "planned-character",
            "kind": "character",
            "label": "Mara",
            "description": "Red coat detective",
            "prompt": "Mara portrait",
            "reference_images": [],
            "shot_ids": ["s1"],
            "version": 1,
        },
        {
            "id": "planned-scene",
            "kind": "scene",
            "label": "Rain alley",
            "description": "Night alley",
            "prompt": "Rain alley establishing frame",
            "reference_images": [],
            "shot_ids": ["s1", "s2"],
            "version": 1,
        },
        {
            "id": "planned-prop",
            "kind": "prop",
            "label": "Envelope",
            "description": "Sealed envelope",
            "prompt": "Wax sealed envelope",
            "reference_images": [],
            "shot_ids": ["s2"],
            "version": 1,
        },
    ]
    series_bible = app.state.store.read_artifact(project_id, "series_bible.json")
    series_bible["assets"] = resources
    app.state.store.write_artifact(project_id, "series_bible.json", series_bible)
    app.state.store.write_asset_library(project_id, resources)
    workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
    workflow["planned_asset_ids"] = [resource["id"] for resource in resources]
    app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)
    return resources


def test_resource_batch_snapshots_project_assets_and_restores_items_from_queries(tmp_path):
    from fastapi.testclient import TestClient

    app, db = _new_client(tmp_path)
    # The test fixture uses one StaticPool SQLite connection; serialize this
    # batch while production keeps the configured bounded worker concurrency.
    app.state.task_worker.max_concurrency = 1
    with TestClient(app) as client:
        project_id = _project(client, "Batch resources")
        resources = _planned_resources(app, project_id)
        response = client.post(
            f"/api/projects/{project_id}/images/generate",
            json={
                "prompt": "ignored for batch",
                "kind": "scene",
                "label": "Batch",
                "resource_ids": [resource["id"] for resource in resources],
            },
        )
        assert response.status_code == 202, response.text
        accepted = response.json()
        assert accepted["task"]["total_items"] == 3
        assert {
            item["target_entity_id"] for item in accepted["task"]["items"]
        } == {resource["id"] for resource in resources}

        completed = _wait_for_task(
            client, project_id, accepted["task_id"], {"complete"}
        )
        assert {item["status"] for item in completed["items"]} == {"complete"}
        assert db.scalar(select(func.count(MediaAsset.id))) == 3
        persisted = app.state.store.read_asset_library(project_id)
        assert [asset["id"] for asset in persisted] == [
            resource["id"] for resource in resources
        ]
        assert [asset["shot_ids"] for asset in persisted] == [
            resource["shot_ids"] for resource in resources
        ]
        assert all(asset["version"] == 2 for asset in persisted)
        assert all(asset["source_type"] == "ai_generated" for asset in persisted)
        assert all(asset["status"] == "ready" for asset in persisted)
        assert all(asset["media_asset_id"] for asset in persisted)
        assert all(asset["reference_images"] for asset in persisted)
        assert all(asset["media_urls"] for asset in persisted)
        assert len({asset["media_asset_id"] for asset in persisted}) == 3
        assert app.state.store.read_artifact(
            project_id, "creative_workflow.json"
        )["planned_asset_ids"] == []
        listed = client.get(
            f"/api/projects/{project_id}/tasks",
            params={"include_items": True},
        ).json()
        assert listed["tasks"][0]["items"] == completed["items"]
        assert any(
            event.get("event_type") == "task_item"
            and event.get("status") == "complete"
            for event in app.state.events.history(project_id)
        )

        first_item = completed["items"][0]
        context = TaskExecutionContext(
            item_id=first_item["id"],
            batch_id=completed["id"],
            owner_user_id=TEST_USER.id,
            project_id=project_id,
            task_type=first_item["task_type"],
            input_snapshot=first_item["input"],
            reference_snapshot=first_item["references"],
            model=first_item["model"],
            project_version=first_item["project_version"],
            snapshot_version=first_item["snapshot_version"],
            target_entity_type=first_item["target_entity_type"],
            target_entity_id=first_item["target_entity_id"],
            target_entity_version=first_item["target_entity_version"],
            attempt_count=first_item["attempt_count"],
            billing_job_id=first_item["billing_job_id"],
            settlement_key=first_item["settlement_key"],
            report_progress=lambda _progress: True,
        )
        publisher = app.state.task_worker._handlers["resource_image.generate"].publish
        assert publisher is not None
        assert publisher(
            context,
            dict(first_item["result"]),
            first_item["target_entity_version"],
        ) == PublishOutcome.ALREADY_PUBLISHED
        assert db.scalar(select(func.count(MediaAsset.id))) == 3
        assert len(app.state.store.read_asset_library(project_id)) == 3

    with TestClient(app) as refreshed_client:
        restored = refreshed_client.get(
            f"/api/projects/{project_id}/tasks/{accepted['task_id']}"
        ).json()
        assert restored["status"] == "complete"
        snapshot = refreshed_client.get(f"/api/projects/{project_id}").json()
        assert [asset["id"] for asset in snapshot["series_bible"]["assets"]] == [
            resource["id"] for resource in resources
        ]
        assert all(
            asset["media_asset_id"]
            for asset in snapshot["series_bible"]["assets"]
        )
        assert len(
            refreshed_client.get(
                "/api/assets",
                params={"scope": "project", "project_id": project_id},
            ).json()["assets"]
        ) == 3


def test_resource_result_cas_rejects_changed_asset_version(tmp_path):
    from fastapi.testclient import TestClient

    app, db = _new_client(tmp_path)
    entered = threading.Event()
    release = threading.Event()
    original_execute = app.state.fake_newapi.execute_quoted

    def blocked_execute(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original_execute(*args, **kwargs)

    app.state.fake_newapi.execute_quoted = blocked_execute
    with TestClient(app) as client:
        project_id = _project(client, "CAS resource")
        resources = _planned_resources(app, project_id)
        response = client.post(
            f"/api/projects/{project_id}/images/generate",
            json={
                "prompt": resources[0]["prompt"],
                "kind": resources[0]["kind"],
                "label": resources[0]["label"],
                "resource_ids": [resources[0]["id"]],
            },
        )
        assert response.status_code == 202
        assert entered.wait(5)
        resources[0]["version"] = 2
        resources[0]["prompt"] = "User edited prompt"
        series_bible = app.state.store.read_artifact(project_id, "series_bible.json")
        series_bible["assets"] = resources
        app.state.store.write_artifact(project_id, "series_bible.json", series_bible)
        app.state.store.write_asset_library(project_id, resources)
        expected_series_bible = app.state.store.read_artifact(
            project_id, "series_bible.json"
        )
        expected_asset_library = app.state.store.read_asset_library(project_id)
        expected_workflow = app.state.store.read_artifact(
            project_id, "creative_workflow.json"
        )
        release.set()

        failed = _wait_for_task(
            client, project_id, response.json()["task_id"], {"failed"}
        )
        failed_item = failed["items"][0]
        assert failed_item["error_code"] == "stale_entity_version"
        assert failed_item["result"]["published_assets"]
        assert app.state.store.read_artifact(
            project_id, "series_bible.json"
        ) == expected_series_bible
        assert app.state.store.read_asset_library(project_id) == expected_asset_library
        assert app.state.store.read_artifact(
            project_id, "creative_workflow.json"
        ) == expected_workflow
        assert expected_asset_library[0]["version"] == 2
        assert expected_asset_library[0]["prompt"] == "User edited prompt"
        assert expected_asset_library[0]["shot_ids"] == ["s1"]
        assert expected_workflow["planned_asset_ids"] == [
            resource["id"] for resource in resources
        ]

        media = db.scalars(select(MediaAsset)).all()
        assert len(media) == 1
        visible = client.get(
            "/api/assets",
            params={"scope": "project", "project_id": project_id},
        ).json()["assets"]
        assert len(visible) == 1
        assert visible[0]["id"] == media[0].id
        assert visible[0]["source_type"] == "ai_generated"
        assert failed_item["result"]["published_assets"][0]["id"] == media[0].id
        assert len(app.state.fake_newapi.execute_calls) == 1

        context = TaskExecutionContext(
            item_id=failed_item["id"],
            batch_id=failed["id"],
            owner_user_id=TEST_USER.id,
            project_id=project_id,
            task_type=failed_item["task_type"],
            input_snapshot=failed_item["input"],
            reference_snapshot=failed_item["references"],
            model=failed_item["model"],
            project_version=failed_item["project_version"],
            snapshot_version=failed_item["snapshot_version"],
            target_entity_type=failed_item["target_entity_type"],
            target_entity_id=failed_item["target_entity_id"],
            target_entity_version=failed_item["target_entity_version"],
            attempt_count=failed_item["attempt_count"],
            billing_job_id=failed_item["billing_job_id"],
            settlement_key=failed_item["settlement_key"],
            report_progress=lambda _progress: True,
        )
        publisher = app.state.task_worker._handlers["resource_image.generate"].publish
        assert publisher is not None
        assert publisher(
            context,
            dict(failed_item["result"]),
            failed_item["target_entity_version"],
        ) == PublishOutcome.STALE
        assert db.scalar(select(func.count(MediaAsset.id))) == 1
        assert len(app.state.fake_newapi.execute_calls) == 1


def _shot_frame_storyboard(app, project_id: str) -> dict:
    shot = {
        "id": "s1",
        "scene_id": "scene-1",
        "index": 1,
        "beat": "Mara enters the alley",
        "prompt": "Mara enters a rainy alley",
        "characters": [],
        "location": "Rain alley",
        "props": [],
        "status": "ready",
        "consistency_score": 100,
        "output_url": None,
        "output_path": None,
        "asset_ids": ["planned-scene"],
        "continuity": {
            "mode": "carry",
            "inherit_previous_tail": False,
            "explicit_user_first_frame_asset_id": "old-first",
            "inherited_first_frame_asset_id": None,
            "last_frame_asset_id": "old-last",
            "first_frame": {
                "asset_id": "old-first",
                "version": 1,
                "status": "ready",
                "source": "user",
            },
            "last_frame": {
                "asset_id": "old-last",
                "version": 1,
                "status": "ready",
                "source": "user",
            },
            "stale": False,
        },
        "version": 1,
        "history": [],
    }
    app.state.store.write_artifact(
        project_id, "episode_storyboard.json", {"shots": [shot]}
    )
    return shot


def _frame_payload(target: str) -> dict:
    return {
        "prompt": f"Mara rainy alley {target} frame",
        "kind": "scene",
        "label": f"s1 {target} frame",
        "count": 1,
        "shot_id": "s1",
        "frame_target": target,
    }


def test_shot_first_and_last_frame_tasks_publish_and_restore_from_snapshot(tmp_path):
    from fastapi.testclient import TestClient

    app, db = _new_client(tmp_path)
    with TestClient(app) as client:
        project_id = _project(client, "Manual keyframes")
        _shot_frame_storyboard(app, project_id)

        first_response = client.post(
            f"/api/projects/{project_id}/images/generate",
            json=_frame_payload("first"),
        )
        assert first_response.status_code == 202, first_response.text
        first_accepted = first_response.json()
        first_item = first_accepted["task"]["items"][0]
        assert first_item["target_entity_type"] == "shot_frame"
        assert first_item["target_entity_id"] == "s1"
        assert first_item["target_entity_version"] == 1
        assert first_item["input"]["frame_target"] == "first"
        first_complete = _wait_for_task(
            client, project_id, first_accepted["task_id"], {"complete"}
        )
        first_asset = first_complete["items"][0]["result"]["published_assets"][0]

        last_response = client.post(
            f"/api/projects/{project_id}/images/generate",
            json=_frame_payload("last"),
        )
        assert last_response.status_code == 202, last_response.text
        assert last_response.json()["task"]["items"][0]["target_entity_version"] == 2
        last_complete = _wait_for_task(
            client, project_id, last_response.json()["task_id"], {"complete"}
        )
        last_asset = last_complete["items"][0]["result"]["published_assets"][0]

        storyboard = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        shot = storyboard["shots"][0]
        assert shot["asset_ids"] == ["planned-scene"]
        assert shot["continuity"]["explicit_user_first_frame_asset_id"] == first_asset["id"]
        assert shot["continuity"]["first_frame"] == {
            "asset_id": first_asset["id"],
            "version": 2,
            "status": "ready",
            "source": "ai_generated",
            "generation_job_id": first_complete["items"][0]["billing_job_id"],
        }
        assert shot["continuity"]["last_frame_asset_id"] == last_asset["id"]
        assert shot["continuity"]["last_frame"] == {
            "asset_id": last_asset["id"],
            "version": 2,
            "status": "ready",
            "source": "ai_generated",
            "generation_job_id": last_complete["items"][0]["billing_job_id"],
        }
        assert shot["version"] == 3
        assert [revision["source"] for revision in shot["history"]] == [
            "ai_generated_frame",
            "ai_generated_frame",
        ]
        assert db.scalar(select(func.count(MediaAsset.id))) == 2
        assert {asset["id"] for asset in app.state.store.read_asset_library(project_id)} == {
            first_asset["id"],
            last_asset["id"],
        }

    with TestClient(app) as refreshed_client:
        snapshot = refreshed_client.get(f"/api/projects/{project_id}").json()
        restored = snapshot["storyboard"]["shots"][0]
        assert restored["continuity"]["first_frame"]["asset_id"] == first_asset["id"]
        assert restored["continuity"]["last_frame"]["asset_id"] == last_asset["id"]
        assert {asset["id"] for asset in snapshot["series_bible"]["assets"]} == {
            first_asset["id"],
            last_asset["id"],
        }


def test_shot_frame_target_shape_and_project_ownership_are_server_validated(tmp_path):
    from fastapi.testclient import TestClient

    app, _db = _new_client(tmp_path)
    client = TestClient(app)
    project_id = _project(client, "Validated manual keyframe")
    _shot_frame_storyboard(app, project_id)

    missing_target = client.post(
        f"/api/projects/{project_id}/images/generate",
        json={**_frame_payload("first"), "frame_target": None},
    )
    assert missing_target.status_code == 422
    mixed_target = client.post(
        f"/api/projects/{project_id}/images/generate",
        json={**_frame_payload("first"), "resource_ids": ["planned-scene"]},
    )
    assert mixed_target.status_code == 422
    multiple = client.post(
        f"/api/projects/{project_id}/images/generate",
        json={**_frame_payload("last"), "count": 2},
    )
    assert multiple.status_code == 422
    unknown_shot = client.post(
        f"/api/projects/{project_id}/images/generate",
        json={**_frame_payload("first"), "shot_id": "missing-shot"},
    )
    assert unknown_shot.status_code == 404


def test_shot_frame_duplicate_submission_and_version_conflict_keep_media_visible(
    tmp_path,
):
    from fastapi.testclient import TestClient

    app, db = _new_client(tmp_path)
    entered = threading.Event()
    release = threading.Event()
    original_execute = app.state.fake_newapi.execute_quoted

    def blocked_execute(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original_execute(*args, **kwargs)

    app.state.fake_newapi.execute_quoted = blocked_execute
    with TestClient(app) as client:
        project_id = _project(client, "Stale manual keyframe")
        _shot_frame_storyboard(app, project_id)
        first = client.post(
            f"/api/projects/{project_id}/images/generate",
            json=_frame_payload("first"),
        )
        assert first.status_code == 202
        assert entered.wait(5)
        duplicate = client.post(
            f"/api/projects/{project_id}/images/generate",
            json=_frame_payload("first"),
        )
        assert duplicate.status_code == 202
        assert duplicate.json()["deduplicated"] is True
        assert duplicate.json()["task_id"] == first.json()["task_id"]

        storyboard = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        storyboard["shots"][0]["version"] = 2
        storyboard["shots"][0]["prompt"] = "User saved a newer shot"
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )
        release.set()

        failed = _wait_for_task(
            client, project_id, first.json()["task_id"], {"failed"}
        )
        assert failed["items"][0]["error_code"] == "stale_entity_version"
        current = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )["shots"][0]
        assert current["prompt"] == "User saved a newer shot"
        assert current["continuity"]["explicit_user_first_frame_asset_id"] == "old-first"
        assert db.scalar(select(func.count(MediaAsset.id))) == 1
        visible = client.get(
            "/api/assets",
            params={"scope": "project", "project_id": project_id},
        ).json()["assets"]
        assert len(visible) == 1
        assert visible[0]["source_type"] == "ai_generated"
        assert len(app.state.fake_newapi.execute_calls) == 1


def test_shot_frame_payment_wait_and_provider_failure_do_not_replace_old_frames(
    tmp_path,
):
    from fastapi.testclient import TestClient

    app, db = _new_client(tmp_path)
    with TestClient(app, raise_server_exceptions=False) as client:
        project_id = _project(client, "Blocked manual keyframes")
        _shot_frame_storyboard(app, project_id)
        wallet = db.query(WalletAccount).filter_by(user_id=TEST_USER.id).one()
        wallet.balance_units = 0
        db.commit()

        payment = client.post(
            f"/api/projects/{project_id}/images/generate",
            json=_frame_payload("first"),
        )
        assert payment.status_code == 202
        waiting = _wait_for_task(
            client, project_id, payment.json()["task_id"], {"awaiting_payment"}
        )
        assert waiting["items"][0]["billing_job_id"] is None
        current = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )["shots"][0]["continuity"]
        assert current["explicit_user_first_frame_asset_id"] == "old-first"
        assert db.scalar(select(func.count(MediaAsset.id))) == 0

        wallet.balance_units = 1_000_000_000
        db.commit()
        app.state.fake_newapi.quote_failure = True
        failure = client.post(
            f"/api/projects/{project_id}/images/generate",
            json=_frame_payload("last"),
        )
        assert failure.status_code == 202
        failed = _wait_for_task(
            client, project_id, failure.json()["task_id"], {"failed"}
        )
        assert failed["items"][0]["error_code"] == "provider_call_failed"
        current = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )["shots"][0]["continuity"]
        assert current["last_frame_asset_id"] == "old-last"
        assert db.scalar(select(func.count(MediaAsset.id))) == 0


def test_resource_generation_rejects_foreign_project_and_unknown_resource(tmp_path):
    from fastapi.testclient import TestClient

    app, _db = _new_client(tmp_path)
    client = TestClient(app)
    project_id = _project(client, "Owned resources")
    _planned_resources(app, project_id)
    missing = client.post(
        f"/api/projects/{project_id}/images/generate",
        json={
            "prompt": "missing",
            "kind": "scene",
            "label": "Missing",
            "resource_ids": ["not-in-this-project"],
        },
    )
    assert missing.status_code == 404

    _as_user(app, BOB)
    foreign = client.post(
        f"/api/projects/{project_id}/images/generate",
        json={"prompt": "foreign", "kind": "scene", "label": "Foreign"},
    )
    assert foreign.status_code == 404

def test_cross_user_asset_is_hidden_and_owned_asset_can_be_added_to_another_project(
    tmp_path,
):
    from fastapi.testclient import TestClient

    app, db = _new_client(tmp_path)
    alice = TestClient(app, raise_server_exceptions=False)
    source_project = _project(alice, "Source")
    uploaded = _upload(alice, source_project, kind="prop", label="Key")
    asset_id = uploaded["library_asset"]["id"]
    target_project = _project(alice, "Target")

    added = alice.post(f"/api/projects/{target_project}/assets/{asset_id}/add")
    assert added.status_code == 200, added.text
    assert set(added.json()) == {"asset", "library_asset"}
    assert added.json()["library_asset"]["id"] == asset_id
    assert added.json()["asset"]["id"] == asset_id
    assert alice.get(added.json()["asset"]["media_urls"][0]).status_code == 200
    snapshot = alice.get(f"/api/projects/{target_project}").json()
    assert [item["id"] for item in snapshot["series_bible"]["assets"]] == [asset_id]
    target_assets = alice.get(
        "/api/assets",
        params={"scope": "project", "project_id": target_project},
    ).json()
    assert [item["id"] for item in target_assets["assets"]] == [asset_id]

    db.add(
        User(
            id=BOB.id,
            email=BOB.email,
            password_hash="hash",
            role="user",
            status="active",
        )
    )
    db.add(
        WalletAccount(
            id="b" * 32,
            user_id=BOB.id,
            balance_units=1_000_000_000,
            held_units=0,
        )
    )
    db.commit()
    _as_user(app, BOB)
    bob = TestClient(app, raise_server_exceptions=False)
    bob_project = _project(bob, "Bob target")

    assert bob.get("/api/assets").json() == {"assets": [], "next_cursor": None}
    hidden = bob.post(f"/api/projects/{bob_project}/assets/{asset_id}/add")
    assert hidden.status_code == 404
    assert hidden.json() == {"detail": "Asset not found"}


def test_deleting_origin_project_rehomes_asset_to_an_existing_project_copy(tmp_path):
    from fastapi.testclient import TestClient

    app, _db = _new_client(tmp_path)
    with TestClient(app) as client:
        source_project = _project(client, "Source")
        uploaded = _upload(client, source_project, kind="scene", label="Shared alley")
        asset_id = uploaded["library_asset"]["id"]
        target_project = _project(client, "Target")

        added = client.post(f"/api/projects/{target_project}/assets/{asset_id}/add")
        assert added.status_code == 200, added.text

        deleted = client.delete(f"/api/projects/{source_project}")
        assert deleted.status_code == 204, deleted.text

        library = client.get("/api/assets").json()
        assert [asset["id"] for asset in library["assets"]] == [asset_id]
        recovered = library["assets"][0]
        assert recovered["origin_project_id"] == target_project
        assert client.get(recovered["media_url"]).status_code == 200
