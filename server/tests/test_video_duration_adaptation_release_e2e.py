from __future__ import annotations

from copy import deepcopy

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.auth.models import AdminAuditLog
from server.app.billing.models import GenerationJob
from server.app.generation_units.models import VideoGenerationUnit
from server.app.rendering import compile_render_plan
from server.app.video_model_settings.service import VideoModelDurationService
from server.tests.test_api import TEST_USER, _wait_project_task
from server.tests.test_generation_unit_execution import _fake_tail_extractor
from server.tests.test_generation_units import _project, _v2_app


def _adaptation_result(request):
    return {
        "task_type": "video_generation_adaptation",
        "immutable_story_facts_hash": request.immutable_story_facts_hash,
        "preserved_story_facts": request.immutable_story_facts,
        "segments": [
            {
                "id": segment_id,
                "source_beat_id": request.source_beat_id,
                "source_shot_id": request.source_shot_id,
                "segment_index": index,
                "segment_count": request.segment_count,
                "start_state": "sealed" if index == 1 else "half-open",
                "action_progress": f"Open the same letter, part {index}",
                "end_state": "half-open" if index == 1 else "open",
                "prompt": f"Continuous letter opening, part {index}",
                "continuity_requirements": ["same hand", "same sealed letter"],
                "introduced_story_facts": [],
                "immutable_story_facts_hash": request.immutable_story_facts_hash,
            }
            for index, segment_id in enumerate(request.requested_segment_ids, start=1)
        ],
    }


def test_admin_catalog_to_adaptation_execution_publication_and_timeline(
    tmp_path, monkeypatch
):
    from server.app import main as main_module

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
    adaptation_calls = []

    def fake_adaptation(**kwargs):
        request = kwargs["request"]
        adaptation_calls.append(request)
        return _adaptation_result(request)

    monkeypatch.setattr(
        main_module,
        "generate_video_generation_adaptation_billed",
        fake_adaptation,
    )

    app = _v2_app(tmp_path)
    app.state.task_worker.max_concurrency = 1
    app.state.task_worker.retry_base_seconds = 0.01
    original_list_models = app.state.fake_newapi.list_models

    def list_models(kind, token_alias=None):
        models = original_list_models(kind, token_alias)
        return [*models, "release-model-5s"] if kind == "video" else models

    app.state.fake_newapi.list_models = list_models
    admin = CurrentUser(
        id=TEST_USER.id,
        email=TEST_USER.email,
        role="admin",
    )

    with TestClient(app) as client:
        project_id, storyboard = _project(app, client)
        shot = deepcopy(storyboard["shots"][0])
        shot.update(
            id="release-shot",
            beat_id="release-beat",
            beat="A hand opens the sealed letter.",
            prompt="A hand opens the sealed letter without interruption.",
            recommended_duration_seconds=8,
            duration_range_seconds=[8, 8],
            cannot_split=False,
            cannot_split_reason=None,
        )
        storyboard["shots"] = [shot]
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )
        workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
        workflow["brief"] = {
            **(workflow.get("brief") or {}),
            "duration_seconds": 10,
            "narrative_beats": [
                {
                    "id": "release-beat",
                    "index": 1,
                    "summary": "A hand opens the sealed letter.",
                    "recommended_duration_seconds": 8,
                    "duration_range_seconds": [8, 8],
                }
            ],
        }
        app.state.store.write_artifact(
            project_id, "creative_workflow.json", workflow
        )

        catalog_before = client.get(
            "/api/generation/models", params={"capability": "video"}
        )
        unknown = next(
            profile
            for profile in catalog_before.json()["profiles"]
            if profile["model_id"] == "release-model-5s"
        )
        assert unknown["duration_mode"] == "unknown"
        jobs_before = app.state.test_db.scalar(select(func.count(GenerationJob.id)))
        blocked = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "contract_version": 2,
                "video_model": "release-model-5s",
                "operation": "text_to_video",
                "shot_ids": [shot["id"]],
            },
        )
        assert blocked.status_code == 200, blocked.text
        assert blocked.json()["can_generate"] is False
        assert "video_model_contract_unknown" in {
            issue["code"] for issue in blocked.json()["issues"]
        }
        assert app.state.test_db.scalar(select(func.count(GenerationJob.id))) == jobs_before

        app.dependency_overrides[require_user] = lambda: admin
        app.dependency_overrides[require_csrf] = lambda: admin
        admin_catalog = client.get("/api/admin/video-model-duration-settings")
        release_item = next(
            item
            for item in admin_catalog.json()["models"]
            if item["model_id"] == "release-model-5s"
        )
        assert release_item["configuration_status"] == "unconfigured"
        configured = client.put(
            "/api/admin/video-model-duration-settings/release-model-5s",
            json={
                "call_duration_seconds": 5,
                "expected_version": 0,
                "reason": "Phase 7 isolated fake-provider verification",
            },
        )
        assert configured.status_code == 200, configured.text
        assert configured.json()["version"] == 1
        assert app.state.test_db.scalar(
            select(AdminAuditLog).where(
                AdminAuditLog.action == "video_model_duration.update",
                AdminAuditLog.object_type == "video_model_duration_setting",
            )
        ) is not None
        assert app.state.test_db.scalar(select(func.count(GenerationJob.id))) == jobs_before
        app.dependency_overrides[require_user] = lambda: TEST_USER
        app.dependency_overrides[require_csrf] = lambda: TEST_USER

        catalog_after = client.get(
            "/api/generation/models", params={"capability": "video"}
        )
        fixed = next(
            profile
            for profile in catalog_after.json()["profiles"]
            if profile["model_id"] == "release-model-5s"
        )
        assert fixed["duration_mode"] == "fixed"
        assert fixed["fixed_duration_seconds"] == 5

        preview_payload = {
            "contract_version": 2,
            "video_model": "release-model-5s",
            "operation": "text_to_video",
            "shot_ids": [shot["id"]],
        }
        first_plan = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json=preview_payload,
        )
        second_plan = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json=preview_payload,
        )
        assert first_plan.status_code == 200, first_plan.text
        assert first_plan.json() == second_plan.json()
        plan = first_plan.json()
        assert len(adaptation_calls) == 1
        assert len(plan["generation_segments"]) == 2
        assert [
            unit["requested_duration_seconds"]
            for unit in plan["generation_units"]
        ] == [5, 5]
        assert [
            segment["source_beat_id"] for segment in plan["generation_segments"]
        ] == ["release-beat", "release-beat"]

        unit_ids = [unit["id"] for unit in plan["generation_units"]]
        submitted = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "contract_version": 2,
                "generation_plan_id": plan["id"],
                "generation_unit_ids": unit_ids,
                "idempotency_key": "phase7-release-e2e",
            },
        )
        assert submitted.status_code == 202, submitted.text
        completed = _wait_project_task(
            client, project_id, submitted.json()["task_id"], {"complete"}
        )
        assert len(completed["items"]) == 2
        assert len(
            [call for call in app.state.fake_newapi.execute_calls if call[0] == "video"]
        ) == 2

        records = list(
            app.state.test_db.scalars(
                select(VideoGenerationUnit)
                .where(VideoGenerationUnit.project_id == project_id)
                .order_by(VideoGenerationUnit.created_at, VideoGenerationUnit.id)
            )
        )
        assert len(records) == 2
        assert all(
            record.status == "complete"
            and record.active
            and record.requested_duration_seconds == 5
            and record.source_duration_seconds == 10
            for record in records
        )
        frozen_revisions = {record.id: record.profile_revision for record in records}

        manifest = app.state.store.read_artifact(project_id, "asset_manifest.json")
        render_plan = compile_render_plan(
            project_id=project_id,
            project_dir=app.state.store.project_dir(project_id),
            storyboard=storyboard,
            asset_manifest=manifest,
            edit_decisions={
                "version": "1.0",
                "cuts": [],
                "render_runtime": "ffmpeg",
            },
            output={"width": 720, "height": 1280, "fps": 30},
            media_probe=lambda _path: {
                "duration_seconds": 10.005,
                "has_audio": False,
                "video_width": 720,
                "video_height": 1280,
                "fps": 30,
                "video_codec": "h264",
                "audio_codec": None,
            },
        )
        assert [clip.generation_unit_id for clip in render_plan.clips] == unit_ids
        assert [clip.timeline_duration_seconds for clip in render_plan.clips] == [
            10.005,
            10.005,
        ]
        assert all(
            clip.source_in_seconds == 0
            and clip.source_out_seconds == 10.005
            and clip.playback_rate == 1
            for clip in render_plan.clips
        )

        provider_calls_before_update = len(app.state.fake_newapi.execute_calls)
        VideoModelDurationService(app.state.test_db).update(
            provider="newapi",
            model_id="release-model-5s",
            call_duration_seconds=6,
            expected_version=1,
            updated_by=TEST_USER.id,
            reason="Verify cache invalidation without mutating completed units",
        )
        app.state.test_db.commit()
        changed = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json=preview_payload,
        )
        assert changed.status_code == 200, changed.text
        assert changed.json()["protected_generation_unit_ids"] == unit_ids
        assert all(
            unit["status"] == "complete"
            for unit in changed.json()["generation_units"]
        )
        assert len(adaptation_calls) == 1
        assert len(app.state.fake_newapi.execute_calls) == provider_calls_before_update
        app.state.test_db.expire_all()
        persisted = list(
            app.state.test_db.scalars(
                select(VideoGenerationUnit).where(
                    VideoGenerationUnit.project_id == project_id
                )
            )
        )
        assert all(record.requested_duration_seconds == 5 for record in persisted)
        assert {record.id: record.profile_revision for record in persisted} == frozen_revisions
