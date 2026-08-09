from __future__ import annotations

import importlib
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from schemas.artifacts import validate_artifact
from server.app.billing.models import GenerationJob
from server.app.core.config import get_settings
from server.app.generation_units.models import VideoGenerationUnit
from server.app.generation_units.schemas import GenerationExecutionSnapshot
from server.app.generation_units.service import (
    GenerationUnitLedgerError,
    GenerationUnitService,
    execution_key,
)
from server.app.tasks.models import TaskBatch, TaskItem
from server.app.video_model_profiles import video_model_profile
from server.tests.test_api import (
    TEST_USER,
    _create_project_with_fake_generator,
    create_app,
)


def _v2_app(tmp_path):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    base_settings = app.dependency_overrides[get_settings]()
    app.dependency_overrides[get_settings] = lambda: base_settings.model_copy(
        update={"generation_units_v2": True}
    )
    return app


def _project(app, client: TestClient, *, mergeable: bool = False):
    created = _create_project_with_fake_generator(client)
    project_id = created["project"]["id"]
    if mergeable:
        storyboard = app.state.store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        for index, shot in enumerate(storyboard["shots"]):
            shot["scene_id"] = "shared-scene"
            shot["recommended_duration_seconds"] = 5
            shot["duration_range_seconds"] = [4, 6]
            shot["can_merge_with_next"] = index < len(storyboard["shots"]) - 1
            shot["must_complete_action"] = False
            shot["must_preserve_emotion"] = False
            shot["continuity"] = {
                **(shot.get("continuity") or {}),
                "mode": "carry",
            }
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )
        workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
        workflow["brief"] = {
            **(workflow.get("brief") or {}),
            "duration_seconds": len(storyboard["shots"]) * 5,
        }
        app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)
        created["storyboard"] = storyboard
    return project_id, created["storyboard"]


def _preview(client: TestClient, project_id: str, storyboard: dict, **extra):
    return client.post(
        f"/api/projects/{project_id}/generation-plan/preview",
        json={
            "video_model": "omni_flash-10s",
            "operation": "text_to_video",
            "shot_ids": [shot["id"] for shot in storyboard["shots"]],
            **extra,
        },
    )


def test_generation_unit_migration_and_metadata_constraints():
    revision = importlib.import_module(
        "server.alembic.versions.018_video_generation_units"
    )

    assert revision.revision == "018"
    assert revision.down_revision == "017"
    segment_revision = importlib.import_module(
        "server.alembic.versions.020_generation_unit_segments"
    )
    assert segment_revision.revision == "020"
    assert segment_revision.down_revision == "019"
    assert (
        VideoGenerationUnit.__table__.metadata.tables["video_generation_units"]
        is VideoGenerationUnit.__table__
    )
    constraint_names = {
        constraint.name for constraint in VideoGenerationUnit.__table__.constraints
    }
    index_names = {index.name for index in VideoGenerationUnit.__table__.indexes}
    assert constraint_names >= {
        "pk_video_generation_units",
        "uq_video_generation_units_execution_key",
        "uq_video_generation_units_task_item",
        "uq_video_generation_units_billing_job",
        "ck_video_generation_units_status",
        "ck_video_generation_units_operation",
    }
    assert index_names >= {
        "uq_video_generation_units_active_revision",
        "uq_video_generation_units_legacy_shot",
    }
    assert "source_segment_ids_json" in VideoGenerationUnit.__table__.columns


def test_protected_query_validates_versions_and_prefers_inflight_replacement(tmp_path):
    app = _v2_app(tmp_path)
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client)
        shot = storyboard["shots"][0]
        profile = video_model_profile(
            "omni_flash-10s",
            "text_to_video",
            provider="newapi",
            db=app.state.test_db,
        )
        common = {
            "project_id": project_id,
            "revision": 1,
            "plan_id": "a" * 64,
            "source_shot_ids_json": [shot["id"]],
            "source_shot_versions_json": {shot["id"]: shot["version"]},
            "source_beat_ids_json": [shot.get("beat_id") or shot["id"]],
            "prompt_segments_json": [],
            "provider": "newapi",
            "model_id": "omni_flash-10s",
            "operation": "text_to_video",
            "profile_revision": profile.profile_revision,
            "profile_json": profile.model_dump(mode="json"),
            "requested_duration_seconds": 10,
            "timeline_duration_seconds": 10,
            "diagnostics_json": {},
        }
        old = VideoGenerationUnit(
            id="unit-old",
            status="complete",
            active=True,
            execution_key=execution_key(project_id, "unit-old", 1),
            **common,
        )
        replacement = VideoGenerationUnit(
            id="unit-new",
            status="queued",
            active=False,
            replaces_unit_id="unit-old",
            execution_key=execution_key(project_id, "unit-new", 1),
            **common,
        )
        app.state.test_db.add_all([old, replacement])
        app.state.test_db.commit()

        protected = GenerationUnitService(app.state.test_db).protected_units(
            project_id=project_id,
            storyboard=storyboard,
            selected_shot_ids=[shot["id"]],
        )
        assert [unit["id"] for unit in protected] == ["unit-new"]

        replacement.source_shot_versions_json = {shot["id"]: shot["version"] + 1}
        app.state.test_db.commit()
        with pytest.raises(
            GenerationUnitLedgerError,
            match="stale storyboard shot versions",
        ):
            GenerationUnitService(app.state.test_db).protected_units(
                project_id=project_id,
                storyboard=storyboard,
                selected_shot_ids=[shot["id"]],
            )

        allowed_stale = GenerationUnitService(app.state.test_db).protected_units(
            project_id=project_id,
            storyboard=storyboard,
            selected_shot_ids=[shot["id"]],
            allow_stale_unit_ids=[replacement.id],
        )
        assert [unit["id"] for unit in allowed_stale] == [replacement.id]


def test_preview_can_replace_a_unit_after_its_storyboard_shot_changes(tmp_path):
    app = _v2_app(tmp_path)
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client)
        initial_plan = _preview(client, project_id, storyboard).json()
        initial_unit_ids = [
            unit["id"] for unit in initial_plan["generation_units"]
        ]
        replaced_id = initial_unit_ids[0]
        submitted = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": initial_plan["id"],
                "generation_unit_ids": initial_unit_ids,
                "idempotency_key": "replace-after-storyboard-edit",
            },
        )
        assert submitted.status_code == 202, submitted.text

        replaced = app.state.test_db.get(
            VideoGenerationUnit,
            (project_id, replaced_id, 1),
        )
        replaced.status = "complete"
        replaced.active = True
        app.state.test_db.commit()

        changed = deepcopy(storyboard)
        changed_shot_ids = set(replaced.source_shot_ids_json)
        for shot in changed["shots"]:
            if shot["id"] in changed_shot_ids:
                shot["version"] += 1
                shot["prompt"] += " Preserve the revised ending state."
        app.state.store.write_artifact(
            project_id,
            "episode_storyboard.json",
            changed,
        )

        replacement_response = _preview(
            client,
            project_id,
            changed,
            regenerate_unit_ids=[replaced_id],
        )
        assert replacement_response.status_code == 200, replacement_response.text
        planned_replacements = [
            unit
            for unit in replacement_response.json()["generation_units"]
            if unit["status"] == "planned" and unit["replaces_unit_id"] == replaced_id
        ]
        assert len(planned_replacements) == 1
        assert set(planned_replacements[0]["source_shot_ids"]) == changed_shot_ids


def test_render_readiness_rejects_active_units_from_an_older_shot_version(
    tmp_path, monkeypatch
):
    from server.app import main as main_module

    app = _v2_app(tmp_path)
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client, mergeable=True)
        plan = _preview(client, project_id, storyboard).json()
        submitted = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": plan["id"],
                "generation_unit_ids": [
                    unit["id"] for unit in plan["generation_units"]
                ],
                "idempotency_key": "outdated-render-readiness",
            },
        )
        assert submitted.status_code == 202, submitted.text

        records = list(
            app.state.test_db.scalars(
                select(VideoGenerationUnit).where(
                    VideoGenerationUnit.project_id == project_id
                )
            )
        )
        for record in records:
            relative = f"assets/video/units/{record.id}/v{record.revision}.mp4"
            output = app.state.store.project_dir(project_id) / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(f"unit:{record.id}".encode())
            record.output_path = relative
            record.output_asset_id = f"asset-{record.id}"
            record.source_duration_seconds = 10
            record.timeline_duration_seconds = 10
            record.status = "complete"
            record.active = True
        app.state.test_db.commit()

        storyboard["shots"][0]["version"] += 1
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )
        monkeypatch.setattr(
            main_module,
            "media_matches_aspect_ratio",
            lambda *_args, **_kwargs: True,
        )

        prepared = client.post(
            f"/api/projects/{project_id}/render/prepare",
            json={"selected_shot_ids": [shot["id"] for shot in storyboard["shots"]]},
        )

        assert prepared.status_code == 200, prepared.text
        readiness = prepared.json()["readiness"]
        assert readiness["ready"] is False
        assert "generation_unit_outdated" in {
            blocker["code"] for blocker in readiness["blockers"]
        }


def test_legacy_backfill_is_idempotent_and_records_probe_failure(tmp_path):
    app = _v2_app(tmp_path)
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client)
        output_path = "assets/video/legacy-shot.mp4"
        media_path = app.state.store.project_dir(project_id) / output_path
        media_path.parent.mkdir(parents=True, exist_ok=True)
        media_path.write_bytes(b"not-a-video")
        storyboard["shots"][0]["output_path"] = output_path
        app.state.store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )

        first = client.get(f"/api/projects/{project_id}")
        second = client.get(f"/api/projects/{project_id}")

        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        records = list(
            app.state.test_db.scalars(
                select(VideoGenerationUnit).where(
                    VideoGenerationUnit.project_id == project_id
                )
            )
        )
        assert len(records) == 1
        record = records[0]
        assert record.legacy_source_shot_id == storyboard["shots"][0]["id"]
        assert record.model_id == "legacy_unknown"
        assert record.output_path == output_path
        assert record.source_duration_seconds is None
        assert record.diagnostics_json["duration_probe"]["code"] == "media_probe_failed"
        assert record.status == "complete"
        assert record.active is True
        execution = second.json()["generation_execution"]
        assert execution["generation_units"][0]["output_path"] == output_path
        validate_artifact(
            "generation_execution",
            app.state.store.read_artifact(project_id, "generation_execution.json"),
        )


def test_legacy_execution_snapshot_import_fills_new_ledger_fields(tmp_path):
    app = _v2_app(tmp_path)
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client)
        shot = storyboard["shots"][0]
        snapshot = GenerationExecutionSnapshot.model_validate(
            {
                "version": "1.0",
                "project_id": project_id,
                "updated_at": "2026-07-24T12:00:00Z",
                "active_generation_unit_ids": ["legacy-unit"],
                "generation_units": [
                    {
                        "id": "legacy-unit",
                        "plan_id": "a" * 64,
                        "revision": 1,
                        "status": "complete",
                        "source_shot_ids": [shot["id"]],
                        "source_shot_versions": {shot["id"]: shot["version"]},
                        "source_beat_ids": [shot.get("beat_id") or shot["id"]],
                        "provider": "newapi",
                        "model_id": "omni_flash-10s",
                        "operation": "text_to_video",
                        "requested_duration_seconds": 10,
                        "source_duration_seconds": 10,
                        "timeline_duration_seconds": 10,
                        "output_asset_id": None,
                        "output_path": "assets/video/legacy-unit.mp4",
                        "task_item_id": None,
                        "billing_job_id": None,
                        "replaces_unit_id": None,
                        "created_at": "2026-07-24T12:00:00Z",
                        "updated_at": "2026-07-24T12:00:00Z",
                    }
                ],
            }
        )

        records = GenerationUnitService(app.state.test_db).import_snapshot(
            project_id=project_id,
            snapshot=snapshot,
            storyboard=storyboard,
        )
        app.state.test_db.commit()

        assert len(records) == 1
        assert records[0].active is True
        assert records[0].prompt_segments_json == []
        assert (
            records[0].profile_revision
            == video_model_profile(
                "omni_flash-10s",
                "text_to_video",
                provider="newapi",
                db=app.state.test_db,
            ).profile_revision
        )
        assert records[0].profile_json["model_id"] == "omni_flash-10s"
        assert records[0].diagnostics_json == {}


def test_v2_preview_reads_only_authoritative_inputs_and_confirmation_rebuilds(tmp_path):
    app = _v2_app(tmp_path)
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client)
        before_storyboard = deepcopy(
            app.state.store.read_artifact(project_id, "episode_storyboard.json")
        )
        jobs_before = app.state.test_db.scalar(select(func.count(GenerationJob.id)))
        shot = storyboard["shots"][0]
        response = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "video_model": "omni_flash-10s",
                "operation": "text_to_video",
                "shot_ids": [shot["id"]],
            },
        )

        assert response.status_code == 200, response.text
        plan = response.json()
        assert plan["requires_confirmation"] is False or plan["can_generate"] is False
        assert (
            app.state.store.read_artifact(project_id, "episode_storyboard.json")
            == before_storyboard
        )
        assert app.state.store.read_artifact(project_id, "generation_plan.json") is None
        assert app.state.test_db.scalar(select(func.count(VideoGenerationUnit.id))) == 0
        assert app.state.test_db.scalar(select(func.count(TaskItem.id))) == 0
        assert (
            app.state.test_db.scalar(select(func.count(GenerationJob.id)))
            == jobs_before
        )

        workflow = app.state.store.read_artifact(project_id, "creative_workflow.json")
        workflow["brief"] = {
            **(workflow.get("brief") or {}),
            "duration_seconds": 20,
        }
        app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)
        blocked = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "video_model": "omni_flash-10s",
                "operation": "text_to_video",
                "shot_ids": [shot["id"]],
            },
        ).json()
        confirmed_response = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "video_model": "omni_flash-10s",
                "operation": "text_to_video",
                "shot_ids": [shot["id"]],
                "confirmed_strategy": "accept_longer_duration",
            },
        )
        bypass = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "video_model": "omni_flash-10s",
                "operation": "text_to_video",
                "shot_ids": [shot["id"]],
                "confirmed_strategy": "accept_model_duration",
            },
        )

        assert blocked["requires_confirmation"] is True
        assert blocked["can_generate"] is False
        assert confirmed_response.status_code == 200
        confirmed = confirmed_response.json()
        assert confirmed["id"] != blocked["id"]
        assert confirmed["confirmed_strategy"] == "accept_longer_duration"
        assert confirmed["can_generate"] is True
        assert bypass.status_code == 422


def test_v2_submit_is_strict_idempotent_and_detects_stale_plan(tmp_path):
    app = _v2_app(tmp_path)
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client, mergeable=True)
        preview = _preview(client, project_id, storyboard)
        assert preview.status_code == 200, preview.text
        plan = preview.json()
        assert [len(unit["source_shot_ids"]) for unit in plan["generation_units"]] == [
            2,
            2,
        ]
        unit_ids = [unit["id"] for unit in plan["generation_units"]]

        partial = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": plan["id"],
                "generation_unit_ids": unit_ids[:1],
                "idempotency_key": "v2-partial",
            },
        )
        assert partial.status_code == 409
        assert partial.json()["detail"]["code"] == "generation_plan_selection_invalid"
        assert app.state.test_db.scalar(select(func.count(VideoGenerationUnit.id))) == 0

        payload = {
            "generation_plan_id": plan["id"],
            "generation_unit_ids": unit_ids,
            "idempotency_key": "v2-submit",
        }
        first = client.post(
            f"/api/projects/{project_id}/generation-units/generate", json=payload
        )
        second = client.post(
            f"/api/projects/{project_id}/generation-units/generate", json=payload
        )

        assert first.status_code == 202, first.text
        assert second.status_code == 202, second.text
        assert first.json()["task_id"] == second.json()["task_id"]
        assert first.json()["deduplicated"] is False
        assert second.json()["deduplicated"] is True
        assert app.state.test_db.scalar(select(func.count(VideoGenerationUnit.id))) == 2
        assert app.state.test_db.scalar(select(func.count(TaskBatch.id))) == 1
        assert app.state.test_db.scalar(select(func.count(TaskItem.id))) == 2
        records = list(
            app.state.test_db.scalars(
                select(VideoGenerationUnit)
                .where(VideoGenerationUnit.project_id == project_id)
                .order_by(VideoGenerationUnit.created_at, VideoGenerationUnit.id)
            )
        )
        assert all(record.source_segment_ids_json for record in records)
        assert {
            segment_id
            for record in records
            for segment_id in record.source_segment_ids_json
        } == set(plan["covered_segment_ids"])
        assert all(
            record.profile_json["profile_revision"] == record.profile_revision
            and record.requested_duration_seconds == 10
            for record in records
        )
        unit_jobs = list(
            app.state.test_db.scalars(
                select(GenerationJob).where(
                    GenerationJob.project_id == project_id,
                    GenerationJob.operation.like("generation_unit:%"),
                )
            )
        )
        assert len(unit_jobs) <= len(unit_ids)
        assert len({job.operation for job in unit_jobs}) == len(unit_jobs)

        v2_settings = app.dependency_overrides[get_settings]()
        app.dependency_overrides[get_settings] = lambda: v2_settings.model_copy(
            update={"generation_units_v2": False}
        )
        legacy_after_v2 = client.post(
            f"/api/projects/{project_id}/shots/generate",
            json={
                "shot_ids": [storyboard["shots"][0]["id"]],
                "video_model": "omni_flash-10s",
                "duration_strategy": "accept_model_duration",
                "idempotency_key": "v1-after-v2",
            },
        )
        assert legacy_after_v2.status_code == 409
        assert legacy_after_v2.json()["detail"]["code"] == (
            "generation_submission_mode_conflict"
        )
        app.dependency_overrides[get_settings] = lambda: v2_settings

        stale_project_id, stale_storyboard = _project(app, client, mergeable=True)
        stale_plan = _preview(client, stale_project_id, stale_storyboard).json()
        current = app.state.store.read_artifact(
            stale_project_id, "episode_storyboard.json"
        )
        current["shots"][0]["version"] += 1
        app.state.store.write_artifact(
            stale_project_id, "episode_storyboard.json", current
        )
        stale = client.post(
            f"/api/projects/{stale_project_id}/generation-units/generate",
            json={
                "generation_plan_id": stale_plan["id"],
                "generation_unit_ids": [
                    unit["id"] for unit in stale_plan["generation_units"]
                ],
                "idempotency_key": "v2-stale",
            },
        )
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "generation_plan_stale"


def test_overlong_preview_uses_project_cache_and_submit_is_cache_only(
    tmp_path, monkeypatch
):
    from server.app import main as main_module
    from server.app.video_model_settings.service import VideoModelDurationService

    app = _v2_app(tmp_path)
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client)
        shot = storyboard["shots"][0]
        shot.update(
            beat_id="beat-long",
            beat="A hand opens the sealed letter.",
            prompt="A hand opens the sealed letter in one continuous scene.",
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
                    "id": "beat-long",
                    "index": 1,
                    "summary": "A hand opens the sealed letter.",
                    "recommended_duration_seconds": 8,
                    "duration_range_seconds": [8, 8],
                }
            ],
        }
        app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)
        VideoModelDurationService(app.state.test_db).update(
            provider="newapi",
            model_id="adaptive-model-5s",
            call_duration_seconds=5,
            expected_version=0,
            updated_by=TEST_USER.id,
            reason="Exercise overlong generation adaptation",
        )
        app.state.test_db.commit()

        adaptation_calls = []
        adaptation_models = []

        def fake_adaptation(**kwargs):
            request = kwargs["request"]
            adaptation_calls.append(request)
            adaptation_models.append(kwargs["text_model"])
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
                        "action_progress": f"Opening action part {index}",
                        "end_state": "half-open" if index == 1 else "open",
                        "prompt": f"Continuous opening action part {index}",
                        "continuity_requirements": ["same hand", "same letter"],
                        "introduced_story_facts": [],
                        "immutable_story_facts_hash": (
                            request.immutable_story_facts_hash
                        ),
                    }
                    for index, segment_id in enumerate(
                        request.requested_segment_ids, start=1
                    )
                ],
            }

        monkeypatch.setattr(
            main_module,
            "generate_video_generation_adaptation_billed",
            fake_adaptation,
        )
        preview_payload = {
            "video_model": "adaptive-model-5s",
            "operation": "text_to_video",
            "shot_ids": [shot["id"]],
            "text_model": "selected-planner-model",
        }
        first = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json=preview_payload,
        )
        assert first.status_code == 200, first.text

        # A prior preview may have persisted the same authoritative plan ID
        # with stale diagnostics. Re-preview must replace that candidate rather
        # than treating the derived payload as a permanent conflict.
        stale_candidate = app.state.store.read_artifact(
            project_id,
            main_module._generation_plan_candidate_name(first.json()["id"]),
        )
        assert stale_candidate is not None
        stale_candidate["generation_plan"]["adaptation_options"] = [
            "stale-diagnostic"
        ]
        app.state.store.write_artifact(
            project_id,
            main_module._generation_plan_candidate_name(first.json()["id"]),
            stale_candidate,
        )

        second = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json=preview_payload,
        )

        assert second.status_code == 200, second.text
        assert first.json() == second.json()
        assert (
            app.state.store.read_artifact(
                project_id,
                main_module._generation_plan_candidate_name(first.json()["id"]),
            )["generation_plan"]
            == second.json()
        )
        assert len(adaptation_calls) == 1
        assert adaptation_models == ["selected-planner-model"]
        plan = first.json()
        assert len(plan["generation_segments"]) == 2
        assert [
            unit["requested_duration_seconds"] for unit in plan["generation_units"]
        ] == [
            5,
            5,
        ]

        submitted = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": plan["id"],
                "generation_unit_ids": [
                    unit["id"] for unit in plan["generation_units"]
                ],
                "idempotency_key": "overlong-cache-only-submit",
            },
        )

        assert submitted.status_code == 202, submitted.text
        assert len(adaptation_calls) == 1
        records = list(
            app.state.test_db.scalars(
                select(VideoGenerationUnit)
                .where(VideoGenerationUnit.project_id == project_id)
                .order_by(VideoGenerationUnit.created_at, VideoGenerationUnit.id)
            )
        )
        assert len(records) == 2
        assert {tuple(record.source_beat_ids_json) for record in records} == {
            ("beat-long",)
        }
        assert (
            len(
                {
                    segment_id
                    for record in records
                    for segment_id in record.source_segment_ids_json
                }
            )
            == 2
        )

        monkeypatch.setattr(
            main_module,
            "media_matches_aspect_ratio",
            lambda *_args, **_kwargs: True,
        )
        for index, record in enumerate(records):
            relative = f"assets/video/units/{record.id}/v{record.revision}.mp4"
            output = app.state.store.project_dir(project_id) / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(f"unit:{record.id}".encode())
            record.output_path = relative
            record.output_asset_id = f"asset-{record.id}"
            record.source_duration_seconds = 5
            record.timeline_duration_seconds = 5
            record.status = "complete" if index == 0 else "queued"
            record.active = index == 0
        app.state.test_db.commit()

        partial = client.post(
            f"/api/projects/{project_id}/render/prepare",
            json={"selected_shot_ids": [shot["id"]]},
        )
        assert partial.status_code == 200, partial.text
        partial_readiness = partial.json()["readiness"]
        assert partial_readiness["ready"] is False
        assert partial_readiness["reusable_shot_ids"] == []
        assert {blocker["code"] for blocker in partial_readiness["blockers"]} == {
            "generation_unit_pending"
        }

        records[1].status = "complete"
        records[1].active = True
        app.state.test_db.commit()
        complete = client.post(
            f"/api/projects/{project_id}/render/prepare",
            json={"selected_shot_ids": [shot["id"]]},
        )
        assert complete.status_code == 200, complete.text
        complete_readiness = complete.json()["readiness"]
        assert complete_readiness["ready"] is True
        assert complete_readiness["blockers"] == []
        assert complete_readiness["reusable_shot_ids"] == [shot["id"]]
        assert set(complete_readiness["reusable_generation_unit_ids"]) == {
            record.id for record in records
        }

        target_project_id, target_storyboard = _project(app, client, mergeable=True)
        target_plan = _preview(client, target_project_id, target_storyboard).json()
        workflow = app.state.store.read_artifact(
            target_project_id, "creative_workflow.json"
        )
        workflow["brief"]["duration_seconds"] += 10
        app.state.store.write_artifact(
            target_project_id, "creative_workflow.json", workflow
        )
        stale_target = client.post(
            f"/api/projects/{target_project_id}/generation-units/generate",
            json={
                "generation_plan_id": target_plan["id"],
                "generation_unit_ids": [
                    unit["id"] for unit in target_plan["generation_units"]
                ],
                "idempotency_key": "v2-stale-target",
            },
        )
        assert stale_target.status_code == 409
        stale_target_detail = stale_target.json()["detail"]
        assert stale_target_detail["code"] == "generation_plan_stale"
        assert stale_target_detail["reason"] == "authoritative_inputs_changed"


def test_same_model_regeneration_stages_a_new_unit_revision(tmp_path):
    app = _v2_app(tmp_path)
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client, mergeable=True)
        initial_plan = _preview(client, project_id, storyboard).json()
        initial_unit_ids = [unit["id"] for unit in initial_plan["generation_units"]]
        initial = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": initial_plan["id"],
                "generation_unit_ids": initial_unit_ids,
                "idempotency_key": "v2-initial",
            },
        )
        assert initial.status_code == 202, initial.text

        replaced_id = initial_unit_ids[0]
        replaced = app.state.test_db.get(
            VideoGenerationUnit, (project_id, replaced_id, 1)
        )
        replaced.status = "complete"
        replaced.active = True
        app.state.test_db.commit()

        replacement_plan = _preview(
            client,
            project_id,
            storyboard,
            regenerate_unit_ids=[replaced_id],
        ).json()
        replacement = next(
            unit
            for unit in replacement_plan["generation_units"]
            if unit["status"] == "planned"
        )
        assert replacement["id"] == replaced_id
        assert replacement["revision"] == 2
        assert replacement["replaces_unit_id"] == replaced_id

        submitted = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": replacement_plan["id"],
                "generation_unit_ids": [replaced_id],
                "idempotency_key": "v2-replacement",
            },
        )
        assert submitted.status_code == 202, submitted.text

        revisions = list(
            app.state.test_db.scalars(
                select(VideoGenerationUnit)
                .where(
                    VideoGenerationUnit.project_id == project_id,
                    VideoGenerationUnit.id == replaced_id,
                )
                .order_by(VideoGenerationUnit.revision)
            )
        )
        assert [record.revision for record in revisions] == [1, 2]
        assert revisions[0].active is True
        assert revisions[1].active is False
        assert revisions[1].status == "queued"


def test_feature_flag_and_v1_to_v2_submission_mode_gate(tmp_path):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client)
        shot_ids = [storyboard["shots"][0]["id"]]
        disabled = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "generation_plan_id": "a" * 64,
                "generation_unit_ids": ["unit-disabled"],
                "idempotency_key": "v2-disabled",
            },
        )
        assert disabled.status_code == 404
        assert disabled.json()["detail"]["code"] == "generation_units_v2_disabled"

        disabled_preview = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "contract_version": 2,
                "video_model": "omni_flash-10s",
                "shot_ids": shot_ids,
            },
        )
        assert disabled_preview.status_code == 404
        assert disabled_preview.json()["detail"]["code"] == (
            "generation_units_v2_disabled"
        )
        assert not list(
            app.state.store.artifact_dir(project_id).glob(
                "generation_plan-*.json"
            )
        )

        v1_plan = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "video_model": "omni_flash-10s",
                "shot_ids": shot_ids,
            },
        ).json()
        v1_submit = client.post(
            f"/api/projects/{project_id}/shots/generate",
            json={
                "shot_ids": shot_ids,
                "video_model": "omni_flash-10s",
                "generation_plan_id": v1_plan["id"],
                "duration_strategy": "accept_model_duration",
                "idempotency_key": "v1-first",
            },
        )
        assert v1_submit.status_code == 202, v1_submit.text

        base_settings = app.dependency_overrides[get_settings]()
        app.dependency_overrides[get_settings] = lambda: base_settings.model_copy(
            update={"generation_units_v2": True}
        )
        incompatible = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "contract_version": 1,
                "video_model": "omni_flash-10s",
                "shot_ids": shot_ids,
            },
        )
        assert incompatible.status_code == 409
        assert incompatible.json()["detail"] == {
            "code": "generation_units_contract_incompatible",
            "expected_contract_version": 2,
            "received_contract_version": 1,
        }
        v2_plan = client.post(
            f"/api/projects/{project_id}/generation-plan/preview",
            json={
                "contract_version": 2,
                "video_model": "omni_flash-10s",
                "shot_ids": shot_ids,
                "confirmed_strategy": "accept_longer_duration",
            },
        ).json()
        v2_submit = client.post(
            f"/api/projects/{project_id}/generation-units/generate",
            json={
                "contract_version": 2,
                "generation_plan_id": v2_plan["id"],
                "generation_unit_ids": [
                    unit["id"]
                    for unit in v2_plan["generation_units"]
                    if unit["status"] == "planned"
                ],
                "idempotency_key": "v2-after-v1",
            },
        )
        assert v2_submit.status_code == 409
        assert v2_submit.json()["detail"]["code"] == (
            "generation_submission_mode_conflict"
        )


def test_legacy_native_duration_confirmation_keeps_single_shot_compatibility(
    tmp_path,
):
    app = _v2_app(tmp_path)
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client)
        shot_id = storyboard["shots"][0]["id"]
        plan = _preview(
            client,
            project_id,
            storyboard,
            shot_ids=[shot_id],
            operation=None,
        ).json()

        response = client.post(
            f"/api/projects/{project_id}/shots/generate",
            json={
                "shot_ids": [shot_id],
                "video_model": "omni_flash-10s",
                "generation_plan_id": plan["id"],
                "duration_strategy": "accept_model_duration",
                "idempotency_key": "legacy-native-duration",
            },
        )

        assert response.status_code == 202, response.text
        assert response.json()["task"]["task_type"] == "storyboard_video.generate"
        snapshot = response.json()["task"]["snapshot"]["snapshot"]
        assert snapshot["generation_plan_id"] == plan["id"]
        assert [
            unit["requested_duration_seconds"]
            for unit in snapshot["generation_units"]
        ] == [10]


def test_legacy_shot_submit_rejects_multi_shot_plan_without_fallback(tmp_path):
    app = _v2_app(tmp_path)
    with TestClient(app) as client:
        project_id, storyboard = _project(app, client, mergeable=True)
        plan = _preview(client, project_id, storyboard).json()

        response = client.post(
            f"/api/projects/{project_id}/shots/generate",
            json={
                "shot_ids": [shot["id"] for shot in storyboard["shots"]],
                "video_model": "omni_flash-10s",
                "generation_plan_id": plan["id"],
                "idempotency_key": "legacy-multi-shot",
            },
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "generation_units_v2_required"
        assert app.state.test_db.scalar(select(func.count(TaskBatch.id))) == 0
        assert app.state.test_db.scalar(select(func.count(VideoGenerationUnit.id))) == 0
