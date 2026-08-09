from __future__ import annotations

import os
import shutil
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, func, inspect, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.auth.models import User
from server.app.billing.models import GenerationJob
from server.app.core.config import AppSettings, get_settings
from server.app.db.session import get_db
from server.app.generation_units.models import VideoGenerationUnit
from server.app.generation_units.service import (
    GenerationUnitService,
    execution_key,
)
from server.app.main import (
    _default_creative_workflow,
    _require_function_user,
    create_app,
    get_newapi_client,
)
from server.app.projects.models import ProjectRecord
from server.app.tasks.models import TaskBatch, TaskItem
from server.app.video_model_profiles import (
    VideoModelDurationConfiguration,
    video_model_profile,
)
from tools.base_tool import resolve_command_path


POSTGRES_URL_ENV = "GENERATION_UNITS_ACCEPTANCE_DATABASE_URL"


class ProviderMustNotBeCalled:
    def __getattr__(self, name: str):
        raise AssertionError(f"provider method {name} must not be called")


def _storyboard(prefix: str, *, output_paths: list[str | None]) -> dict:
    shots = []
    for index, output_path in enumerate(output_paths, start=1):
        shots.append(
            {
                "id": f"{prefix}-s{index}",
                "beat_id": f"{prefix}-b{index}",
                "episode_number": 1,
                "scene_id": f"{prefix}-shared-scene",
                "index": index,
                "version": 1,
                "beat": f"Beat {index}",
                "prompt": f"Acceptance shot {index}",
                "recommended_duration_seconds": 5,
                "duration_range_seconds": [4, 6],
                "can_merge_with_next": index < len(output_paths),
                "must_complete_action": False,
                "must_preserve_emotion": False,
                "cannot_split_reason": None,
                "continuity": {"mode": "carry"},
                "output_path": output_path,
            }
        )
    return {"shots": shots}


def _seed_project(
    session_factory: sessionmaker[Session],
    app,
    *,
    project_id: str,
    owner_user_id: str,
    storyboard: dict,
) -> None:
    with session_factory() as db:
        db.add(
            ProjectRecord(
                id=project_id,
                owner_user_id=owner_user_id,
                title=f"Generation units acceptance {project_id[:8]}",
                mode="general_video",
                project_type="single_video",
            )
        )
        db.commit()
    workflow = _default_creative_workflow(storyboard)
    workflow["phase"] = "approved"
    workflow["brief"] = {"duration_seconds": len(storyboard["shots"]) * 5}
    workflow["ready_to_confirm"] = True
    for approval in workflow["plan_sections"].values():
        approval["status"] = "approved"
    app.state.store.write_artifact(project_id, "episode_storyboard.json", storyboard)
    app.state.store.write_artifact(
        project_id,
        "series_bible.json",
        {"title": "Acceptance", "characters": [], "assets": []},
    )
    app.state.store.write_artifact(project_id, "continuity_plan.json", {})
    app.state.store.write_artifact(project_id, "creative_workflow.json", workflow)


def _write_test_video(path: Path) -> None:
    ffmpeg = resolve_command_path("ffmpeg")
    if ffmpeg is None:
        pytest.skip("Remotion-bundled ffmpeg is required for PostgreSQL acceptance")
    path.parent.mkdir(parents=True, exist_ok=True)
    frame_path = path.with_suffix(".png")
    Image.new("RGB", (64, 64), color="black").save(frame_path)
    try:
        subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-loop",
                "1",
                "-framerate",
                "25",
                "-i",
                str(frame_path),
                "-t",
                "1",
                "-an",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                str(path),
            ],
            check=True,
        )
    finally:
        frame_path.unlink(missing_ok=True)


def _seed_legacy_execution(
    session_factory: sessionmaker[Session],
    *,
    user_id: str,
    project_id: str,
    shot_id: str,
    output_path: str,
) -> tuple[str, str, str]:
    now = datetime.now(timezone.utc)
    job_id = uuid.uuid4().hex
    batch_id = uuid.uuid4().hex
    item_id = uuid.uuid4().hex
    job = GenerationJob(
        id=job_id,
        parent_job_id=None,
        chargeable=True,
        user_id=user_id,
        project_id=project_id,
        operation=f"shot:{shot_id}",
        capability="video",
        token_kind="video",
        token_alias="legacy-video",
        model="omni_flash-10s",
        multiplier_bps=15_000,
        status="billed",
        result_locator=output_path,
        result_sha256="a" * 64,
        result_staged=True,
        result_visible=True,
        quote_id=f"quote-{uuid.uuid4().hex}",
        quote_expires_at=now + timedelta(hours=1),
        quote_estimated_quota=1,
        quote_estimated_provider_cost_micro=1,
        quote_quota_per_unit=Decimal("1"),
        quote_pricing_version="acceptance-v1",
        quote_other_ratios_json="{}",
        quote_billing_fingerprint=f"fingerprint-{uuid.uuid4().hex}",
    )
    batch = TaskBatch(
        id=batch_id,
        owner_user_id=user_id,
        project_id=project_id,
        task_type="storyboard_video.generate",
        status="complete",
        idempotency_key=f"legacy-{uuid.uuid4().hex}",
        request_hash=uuid.uuid4().hex * 2,
        snapshot_version=1,
        project_version=1,
        request_snapshot={"version": 1},
        progress=100,
        total_items=1,
        completed_items=1,
        failed_items=0,
        completed_at=now,
    )
    item = TaskItem(
        id=item_id,
        batch_id=batch_id,
        position=0,
        task_type="shot_video.generate",
        status="complete",
        idempotency_key="legacy-shot-1",
        snapshot_version=1,
        project_version=1,
        input_snapshot={
            "generation_unit": {
                "provider": "newapi",
                "model_id": "omni_flash-10s",
                "operation": "text_to_video",
                "requested_duration_seconds": 10,
            }
        },
        reference_snapshot=[],
        model="omni_flash-10s",
        target_entity_type="shot_video",
        target_entity_id=shot_id,
        target_entity_version=1,
        attempt_count=1,
        max_attempts=3,
        progress=100,
        retryable=False,
        result_snapshot={
            "output_path": output_path,
            "operation": "text_to_video",
            "billing_job_id": job_id,
        },
        billing_job_id=job_id,
        settlement_key=uuid.uuid4().hex * 2,
        completed_at=now,
    )
    with session_factory() as db:
        db.add_all([job, batch, item])
        db.commit()
    return job_id, batch_id, item_id


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


def _constraint_name(session_factory, record: VideoGenerationUnit) -> str | None:
    with session_factory() as db:
        db.add(record)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            diagnostic = getattr(getattr(exc, "orig", None), "diag", None)
            return getattr(diagnostic, "constraint_name", None)
    return None


@pytest.mark.skipif(
    not os.environ.get(POSTGRES_URL_ENV),
    reason=f"set {POSTGRES_URL_ENV} to an explicitly isolated PostgreSQL database",
)
def test_generation_units_postgres_backfill_dual_read_and_submission_gates(tmp_path):
    database_url = os.environ[POSTGRES_URL_ENV]
    assert "generation_units_acceptance" in database_url
    engine = create_engine(database_url, pool_pre_ping=True)
    assert engine.dialect.name == "postgresql"
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)

    run_id = uuid.uuid4().hex
    user_id = uuid.uuid4().hex
    legacy_project_id = uuid.uuid4().hex
    v2_project_id = uuid.uuid4().hex
    current_user = CurrentUser(
        id=user_id,
        email=f"generation-units-{run_id}@example.invalid",
        role="user",
    )
    with session_factory() as db:
        db.add(
            User(
                id=user_id,
                email=current_user.email,
                password_hash="not-used",
                role="user",
                status="active",
            )
        )
        db.commit()

    app = create_app(
        db_path=tmp_path / "workbench.sqlite3",
        projects_root=tmp_path / "projects",
    )
    state = {"generation_units_v2": False}
    base_settings = AppSettings(
        _env_file=None,
        environment="test",
        database_url=database_url,
        auth_hmac_secret="x" * 32,
    )
    assert base_settings.generation_units_v2 is False

    def database_dependency():
        with session_factory() as db:
            try:
                yield db
            except Exception:
                db.rollback()
                raise

    app.state.task_session_factory = session_factory
    app.dependency_overrides[get_db] = database_dependency
    app.dependency_overrides[require_user] = lambda: current_user
    app.dependency_overrides[require_csrf] = lambda: current_user
    app.dependency_overrides[_require_function_user] = lambda: current_user
    app.dependency_overrides[get_settings] = lambda: base_settings.model_copy(
        update={"generation_units_v2": state["generation_units_v2"]}
    )
    app.dependency_overrides[get_newapi_client] = ProviderMustNotBeCalled

    first_path = "assets/video/legacy-1.mp4"
    second_path = "assets/video/legacy-2.mp4"
    legacy_storyboard = _storyboard(
        f"legacy-{run_id[:8]}", output_paths=[first_path, second_path, None, None]
    )
    _seed_project(
        session_factory,
        app,
        project_id=legacy_project_id,
        owner_user_id=user_id,
        storyboard=legacy_storyboard,
    )
    first_media = app.state.store.project_dir(legacy_project_id) / first_path
    second_media = app.state.store.project_dir(legacy_project_id) / second_path
    _write_test_video(first_media)
    shutil.copyfile(first_media, second_media)
    job_id, _batch_id, item_id = _seed_legacy_execution(
        session_factory,
        user_id=user_id,
        project_id=legacy_project_id,
        shot_id=legacy_storyboard["shots"][0]["id"],
        output_path=first_path,
    )
    second_job_id, _second_batch_id, second_item_id = _seed_legacy_execution(
        session_factory,
        user_id=user_id,
        project_id=legacy_project_id,
        shot_id=legacy_storyboard["shots"][1]["id"],
        output_path=second_path,
    )

    v2_storyboard = _storyboard(
        f"v2-{run_id[:8]}", output_paths=[None, None, None, None]
    )
    _seed_project(
        session_factory,
        app,
        project_id=v2_project_id,
        owner_user_id=user_id,
        storyboard=v2_storyboard,
    )

    with TestClient(app) as client:
        compatibility = client.get(f"/api/projects/{legacy_project_id}")
        assert compatibility.status_code == 200, compatibility.text
        assert compatibility.json()["generation_execution"] is None
        assert [
            shot["output_path"]
            for shot in compatibility.json()["storyboard"]["shots"][:2]
        ] == [first_path, second_path]

        state["generation_units_v2"] = True
        first_read = client.get(f"/api/projects/{legacy_project_id}")
        second_read = client.get(f"/api/projects/{legacy_project_id}")
        assert first_read.status_code == 200, first_read.text
        assert second_read.status_code == 200, second_read.text
        execution = second_read.json()["generation_execution"]
        assert len(execution["generation_units"]) == 2
        assert execution["active_generation_unit_ids"] == [
            unit["id"] for unit in execution["generation_units"]
        ]

        with session_factory() as db:
            service = GenerationUnitService(db)
            legacy_units = service.repository.list_project(legacy_project_id)
            assert len(legacy_units) == 2
            assert {unit.output_path for unit in legacy_units} == {
                first_path,
                second_path,
            }
            assert all(
                unit.status == "complete" and unit.active for unit in legacy_units
            )
            assert all(
                unit.source_duration_seconds == pytest.approx(1.0)
                for unit in legacy_units
            )
            recovered = next(
                unit for unit in legacy_units if unit.output_path == first_path
            )
            assert recovered.model_id == "omni_flash-10s"
            assert recovered.task_item_id == item_id
            assert recovered.billing_job_id == job_id
            recovered_second = next(
                unit for unit in legacy_units if unit.output_path == second_path
            )
            assert recovered_second.model_id == "omni_flash-10s"
            assert recovered_second.task_item_id == second_item_id
            assert recovered_second.billing_job_id == second_job_id
            assert len(service.active_units(project_id=legacy_project_id)) == 2
            assert (
                len(
                    service.protected_units(
                        project_id=legacy_project_id,
                        storyboard=legacy_storyboard,
                    )
                )
                == 2
            )
            assert (
                db.scalar(
                    select(func.count(GenerationJob.id)).where(
                        GenerationJob.project_id == legacy_project_id
                    )
                )
                == 2
            )
            job = db.get(GenerationJob, job_id)
            assert (job.operation, job.status, job.result_locator) == (
                f"shot:{legacy_storyboard['shots'][0]['id']}",
                "billed",
                first_path,
            )
            second_job = db.get(GenerationJob, second_job_id)
            assert (second_job.status, second_job.result_locator) == (
                "billed",
                second_path,
            )

        stored_storyboard = app.state.store.read_artifact(
            legacy_project_id, "episode_storyboard.json"
        )
        assert [shot["output_path"] for shot in stored_storyboard["shots"][:2]] == [
            first_path,
            second_path,
        ]
        stored_storyboard["shots"][0]["output_path"] = "assets/video/changed-v1.mp4"
        app.state.store.write_artifact(
            legacy_project_id, "episode_storyboard.json", stored_storyboard
        )
        ledger_read = client.get(f"/api/projects/{legacy_project_id}")
        assert ledger_read.status_code == 200
        assert {
            unit["output_path"]
            for unit in ledger_read.json()["generation_execution"]["generation_units"]
        } == {first_path, second_path}

        legacy_plan_response = _preview(
            client,
            legacy_project_id,
            stored_storyboard,
            confirmed_strategy="accept_longer_duration",
        )
        assert legacy_plan_response.status_code == 200, legacy_plan_response.text
        legacy_plan = legacy_plan_response.json()
        legacy_pending = [
            unit["id"]
            for unit in legacy_plan["generation_units"]
            if unit["status"] == "planned"
        ]
        v1_to_v2 = client.post(
            f"/api/projects/{legacy_project_id}/generation-units/generate",
            json={
                "generation_plan_id": legacy_plan["id"],
                "generation_unit_ids": legacy_pending,
                "idempotency_key": f"v1-to-v2-{run_id}",
            },
        )
        assert v1_to_v2.status_code == 409, v1_to_v2.text
        assert (
            v1_to_v2.json()["detail"]["code"] == "generation_submission_mode_conflict"
        )

        v2_plan_response = _preview(client, v2_project_id, v2_storyboard)
        assert v2_plan_response.status_code == 200, v2_plan_response.text
        v2_plan = v2_plan_response.json()
        assert [
            len(unit["source_shot_ids"]) for unit in v2_plan["generation_units"]
        ] == [2, 2]
        v2_unit_ids = [unit["id"] for unit in v2_plan["generation_units"]]

        legacy_adapter = client.post(
            f"/api/projects/{v2_project_id}/shots/generate",
            json={
                "shot_ids": [shot["id"] for shot in v2_storyboard["shots"]],
                "video_model": "omni_flash-10s",
                "generation_plan_id": v2_plan["id"],
                "idempotency_key": f"v2-through-v1-{run_id}",
            },
        )
        assert legacy_adapter.status_code == 409, legacy_adapter.text
        assert legacy_adapter.json()["detail"]["code"] == "generation_units_v2_required"

        assert app.state.task_worker.stop(timeout=30)
        payload = {
            "generation_plan_id": v2_plan["id"],
            "generation_unit_ids": v2_unit_ids,
            "idempotency_key": f"v2-submit-{run_id}",
        }
        first_submit = client.post(
            f"/api/projects/{v2_project_id}/generation-units/generate", json=payload
        )
        duplicate_submit = client.post(
            f"/api/projects/{v2_project_id}/generation-units/generate", json=payload
        )
        assert first_submit.status_code == 202, first_submit.text
        assert duplicate_submit.status_code == 202, duplicate_submit.text
        assert first_submit.json()["task_id"] == duplicate_submit.json()["task_id"]
        assert first_submit.json()["deduplicated"] is False
        assert duplicate_submit.json()["deduplicated"] is True

        with session_factory() as db:
            service = GenerationUnitService(db)
            v2_units = service.repository.list_project(v2_project_id)
            assert len(v2_units) == 2
            assert all(unit.status == "queued" and not unit.active for unit in v2_units)
            assert (
                len(
                    service.protected_units(
                        project_id=v2_project_id,
                        storyboard=v2_storyboard,
                    )
                )
                == 2
            )
            assert service.active_units(project_id=v2_project_id) == []
            assert (
                db.scalar(
                    select(func.count(TaskBatch.id)).where(
                        TaskBatch.project_id == v2_project_id,
                        TaskBatch.task_type == "generation_unit_video.generate",
                    )
                )
                == 1
            )
            assert (
                db.scalar(
                    select(func.count(TaskItem.id))
                    .join(TaskBatch, TaskBatch.id == TaskItem.batch_id)
                    .where(TaskBatch.project_id == v2_project_id)
                )
                == 2
            )
            assert (
                db.scalar(
                    select(func.count(GenerationJob.id)).where(
                        GenerationJob.project_id == v2_project_id
                    )
                )
                == 0
            )
            first_unit = v2_units[0]
            first_unit.status = "complete"
            first_unit.active = True
            db.commit()
            active_id = first_unit.id

        with session_factory() as db:
            service = GenerationUnitService(db)
            assert [
                unit.id for unit in service.active_units(project_id=v2_project_id)
            ] == [active_id]
            assert (
                len(
                    service.protected_units(
                        project_id=v2_project_id,
                        storyboard=v2_storyboard,
                    )
                )
                == 2
            )

        state["generation_units_v2"] = False
        v2_to_v1 = client.post(
            f"/api/projects/{v2_project_id}/shots/generate",
            json={
                "shot_ids": [v2_storyboard["shots"][0]["id"]],
                "video_model": "omni_flash-10s",
                "idempotency_key": f"v2-to-v1-{run_id}",
            },
        )
        assert v2_to_v1.status_code == 409, v2_to_v1.text
        assert (
            v2_to_v1.json()["detail"]["code"] == "generation_submission_mode_conflict"
        )

    metadata = inspect(engine)
    assert {
        column["name"] for column in metadata.get_columns("video_generation_units")
    } >= {
        "source_shot_ids_json",
        "source_beat_ids_json",
        "source_segment_ids_json",
        "prompt_segments_json",
        "profile_revision",
        "profile_json",
    }
    assert metadata.get_pk_constraint("video_generation_units")["name"] == (
        "pk_video_generation_units"
    )
    assert {
        constraint["name"]
        for constraint in metadata.get_check_constraints("video_generation_units")
    } >= {
        "ck_video_generation_units_status",
        "ck_video_generation_units_operation",
        "ck_video_generation_units_revision",
        "ck_video_generation_units_plan_id",
        "ck_video_generation_units_execution_key",
    }
    assert {
        constraint["name"]
        for constraint in metadata.get_unique_constraints("video_generation_units")
    } == {
        "uq_video_generation_units_execution_key",
        "uq_video_generation_units_task_item",
        "uq_video_generation_units_billing_job",
    }
    assert {
        index["name"] for index in metadata.get_indexes("video_generation_units")
    } >= {
        "ix_video_generation_units_project_status",
        "uq_video_generation_units_active_revision",
        "uq_video_generation_units_legacy_shot",
    }

    profile = video_model_profile(
        "omni_flash-10s",
        "text_to_video",
        provider="newapi",
        duration_configuration=VideoModelDurationConfiguration(
            provider="newapi",
            model_id="omni_flash-10s",
            call_duration_seconds=10,
            version=1,
        ),
    )
    invalid_status = VideoGenerationUnit(
        project_id=v2_project_id,
        id=f"invalid-status-{run_id[:8]}",
        revision=1,
        plan_id="f" * 64,
        status="invalid",
        active=False,
        source_shot_ids_json=[v2_storyboard["shots"][0]["id"]],
        source_shot_versions_json={v2_storyboard["shots"][0]["id"]: 1},
        source_beat_ids_json=[v2_storyboard["shots"][0]["beat_id"]],
        prompt_segments_json=[],
        provider="newapi",
        model_id="omni_flash-10s",
        operation="text_to_video",
        profile_revision=profile.profile_revision,
        profile_json=profile.model_dump(mode="json"),
        requested_duration_seconds=10,
        execution_key=execution_key(v2_project_id, f"invalid-{run_id}", 1),
        diagnostics_json={},
    )
    assert _constraint_name(session_factory, invalid_status) == (
        "ck_video_generation_units_status"
    )

    with session_factory() as db:
        active = db.scalar(
            select(VideoGenerationUnit).where(
                VideoGenerationUnit.project_id == v2_project_id,
                VideoGenerationUnit.active.is_(True),
            )
        )
        duplicate_active = VideoGenerationUnit(
            project_id=v2_project_id,
            id=active.id,
            revision=active.revision + 1,
            plan_id=active.plan_id,
            status="complete",
            active=True,
            source_shot_ids_json=list(active.source_shot_ids_json),
            source_shot_versions_json=dict(active.source_shot_versions_json),
            source_beat_ids_json=list(active.source_beat_ids_json),
            prompt_segments_json=list(active.prompt_segments_json),
            provider=active.provider,
            model_id=active.model_id,
            operation=active.operation,
            profile_revision=active.profile_revision,
            profile_json=dict(active.profile_json),
            requested_duration_seconds=active.requested_duration_seconds,
            execution_key=execution_key(v2_project_id, active.id, active.revision + 1),
            diagnostics_json={},
        )
    assert _constraint_name(session_factory, duplicate_active) == (
        "uq_video_generation_units_active_revision"
    )
    engine.dispose()
