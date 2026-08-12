from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import uuid
from contextlib import asynccontextmanager, contextmanager
from collections.abc import Callable, Mapping
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, AsyncIterator, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from python_multipart.exceptions import MultipartParseError
from redis import Redis
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.datastructures import FormData, UploadFile

from server.app.admin.billing_router import router as admin_billing_router
from server.app.admin.video_model_router import router as admin_video_model_router
from server.app.artifact_sync import (
    read_workflow_settings,
    rewrite_workflow_artifacts,
    sync_asset_shot_ids,
    write_generation_execution_snapshot,
)
from server.app.assets.schemas import (
    AssetKind,
    AssetSourceType,
    MediaAssetListResponse,
)
from server.app.assets.service import MediaAssetRepository, compatible_asset_record
from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.auth.router import get_provisioner, router as auth_router
from server.app.billing.models import GenerationJob
from server.app.billing.health import (
    BillingReconciliationUnavailable,
    require_billing_worker_healthy,
)
from server.app.billing.execution import (
    PaymentRequiredQuote,
    ProviderPricingUnstable,
    ProviderResultPending,
    ProviderResultUnavailable,
)
from server.app.billing.service import BillingService, ProviderPricingUnavailable
from server.app.core.config import AppSettings, get_settings
from server.app.consistency import apply_consistency_scores, evaluate_storyboard_consistency
from server.app.continuity_frames import (
    mark_shot_continuity_stale,
    resolve_continuity,
    resolve_shot_generation_frame_requirements,
)
from server.app.events import EventBus
from server.app.generation_units.schemas import (
    GenerationPlanCandidate,
    GenerationUnitsGenerateRequest,
)
from server.app.generation_units.models import VideoGenerationUnit
from server.app.generation_units.release_gate import (
    GENERATION_UNITS_CONTRACT_VERSION,
    GenerationUnitsReleaseGateError,
    require_generation_units_release,
)
from server.app.generation_units.prompt import (
    compile_generation_unit_prompt,
    generation_unit_prompt_contract,
)
from server.app.generation_units.service import (
    GenerationUnitLedgerError,
    GenerationUnitService,
    execution_key as generation_unit_execution_key,
    legacy_video_assets_by_shot,
)
from server.app.inspiration_developer import develop_inspiration_billed
from server.app.keyframe_service import synchronize_project_video_durations
from server.app.media_files import (
    IMAGE_EXTENSIONS,
    MAX_IMAGE_BYTES,
    copy_media_file_atomic,
    media_content_type,
    media_download_url,
    replace_atomic_output,
    relative_project_path,
    safe_project_media_destination,
    safe_project_media_file,
    save_upload_file,
    validate_upload_extension,
)
from server.app.media_retention import cleanup_expired_media
from server.app.mock_runner import update_mock_shot
from server.app.models import (
    ContinuityPlan,
    CreativePlanReviseRequest,
    CreativeWorkflow,
    CredentialFreeRequest,
    ImageGenerationRequest,
    InspirationChatRequest,
    InspirationIntentUpdateRequest,
    PLAN_SECTION_IDS,
    PlanSectionApproval,
    PlanSectionId,
    PlanSectionUpdateRequest,
    ProjectType,
    PromptOptimizeRequest,
    PromptOptimizeResponse,
    ShotRegenerateRequest,
    ShotSaveRequest,
    StoryboardRevisionSession,
)
from server.app.openmontage_runner import (
    REFERENCE_IMAGE_EXTENSIONS,
    generate_billed_shot as run_single_shot_generation,
    media_matches_aspect_ratio,
    render_short_drama_project,
)
from server.app.prompt_optimizer import optimize_text_prompt_billed as optimize_text_prompt
from server.app.projects.models import ProjectRecord
from server.app.projects.repository import ProjectRepository
from server.app.projects.schemas import (
    MAX_IMPORT_ARTIFACT_BYTES,
    ProjectCreateRequest,
    ProjectImportRequest,
    ProjectListResponse,
    ProjectResponse,
)
from server.app.provider.newapi import (
    InvalidNewApiResponse,
    NewApiCallError,
    NewApiClient,
    NewApiRateLimited,
)
from server.app.provider.dependencies import get_newapi_client
from server.app.payments.router import router as payment_router
from server.app.db.session import get_db
from server.app.redis import get_redis
from server.app.request_validation import (
    parse_json_request,
    redacted_validation_exception_handler,
)
from server.app.settings import (
    DEFAULT_DB_PATH,
    DEFAULT_PROJECTS_ROOT,
    PUBLIC_DISABLE_GLOBAL_LATEST,
)
from server.app.storyboard_generator import (
    generate_short_drama_storyboard_billed as generate_short_drama_storyboard,
)
from server.app.storage import ProjectRecoveryRequired, WorkbenchStore
from server.app.tasks.router import router as task_router
from server.app.tasks.models import TaskBatch, TaskItem
from server.app.tasks.resource_images import execute_resource_image
from server.app.tasks.storyboard_plans import (
    STORYBOARD_PLAN_TASK_TYPE,
    execute_storyboard_plan,
)
from server.app.tasks.generation_unit_videos import (
    execute_generation_unit_video,
    publish_generation_unit_video,
)
from server.app.tasks.runtime import configure_task_runtime
from server.app.tasks.schemas import (
    ShotBatchGenerateRequest,
    TaskAcceptedResponse,
    TaskItemSubmit,
    TaskSubmitRequest,
)
from server.app.tasks.service import (
    PREVIOUS_SHOT_MISSING_CODE,
    PREVIOUS_SHOT_MISSING_MESSAGE,
    SHOT_FRAME_DEPENDENCIES_MISSING_CODE,
    SHOT_FRAME_DEPENDENCIES_MISSING_MESSAGE,
    TaskConflict,
    TaskStateError,
    TaskService,
)
from server.app.tasks.shot_videos import (
    SHOT_VIDEO_TASK_TYPE,
    dependency_tail_asset,
    execute_shot_video,
    previous_video_is_available,
    publish_shot_video,
)
from server.app.tasks.worker import (
    PermanentTaskError,
    PublishOutcome,
    TaskExecutionContext,
    TaskExecutionResult,
)
from server.app.video_model_profiles import (
    GenerationPlan,
    VideoModelProfile,
    build_generation_plan,
    model_profiles,
    operation_for_shot,
)
from server.app.video_generation_adaptation import (
    VideoGenerationAdaptationError,
    VideoGenerationAdaptationRequest,
    adaptation_cache_key,
    generate_video_generation_adaptation_billed,
    load_cached_adaptation,
    resolve_cached_adaptation,
)
from server.app.video_model_settings.service import VideoModelDurationService
from server.app.wallet.provisioning import WalletProvisioner
from server.app.wallet.router import router as wallet_router
from server.app.wallet.service import InsufficientBalance, available_units

DEFAULT_TEXT_MODEL = "gpt-5.5"
DEFAULT_IMAGE_MODEL = "gpt-image-2"
DEFAULT_VIDEO_MODEL = "omni_flash-10s"
INSPIRATION_END_FRAME_TASK_PURPOSE = "inspiration_end_frames"
STORYBOARD_GENERATION_FAILED = "Text model storyboard generation failed"
INSPIRATION_DEVELOPMENT_FAILED = "Text model inspiration development failed"
PROMPT_OPTIMIZATION_FAILED = "Text model prompt optimization failed"
SHOT_GENERATION_FAILED = "Shot generation failed"
PROJECT_RENDER_FAILED = "Project render failed"
COMPOSITION_TASK_TYPE = "project_render.compose"
project_delete_logger = logging.getLogger("server.app.project_delete")
end_frame_task_logger = logging.getLogger("server.app.inspiration_end_frames")
generation_unit_logger = logging.getLogger("server.app.generation_units")
MAX_MULTIPART_FIELD_BYTES = 64 * 1024
MAX_MULTIPART_FIELDS = 4
MAX_MULTIPART_FILES = 1
MAX_MULTIPART_REQUEST_BYTES = MAX_IMAGE_BYTES + MAX_MULTIPART_FIELD_BYTES
WORKFLOW_ARTIFACT_PATHS = [
    "artifacts/proposal_packet.json",
    "artifacts/scene_plan.json",
    "artifacts/asset_manifest.json",
    "artifacts/edit_decisions.json",
    "artifacts/continuity_plan.json",
    "artifacts/generation_plan.json",
    "artifacts/generation_execution.json",
]
STORYBOARD_ARTIFACT_PATHS = [
    "artifacts/episode_storyboard.json",
    "artifacts/series_bible.json",
    "artifacts/asset_library.json",
    "artifacts/consistency_report.json",
]
_GENERATED_IMAGE_PATH = re.compile(
    r"^assets/images/generated/([0-9a-f]{32})-[0-9]+\.(?:png|jpg|webp)$"
)
_GENERATED_VIDEO_PATH = re.compile(
    r"^assets/video/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.mp4$"
)
_BILLING_CONTROL_ERRORS = (
    PaymentRequiredQuote,
    ProviderResultPending,
    ProviderResultUnavailable,
    ProviderPricingUnavailable,
    ProviderPricingUnstable,
    NewApiCallError,
    NewApiRateLimited,
    InsufficientBalance,
)


def sanitize_project_path(project_dir: Path, path_value: Any) -> str | None:
    if not isinstance(path_value, str) or not path_value.strip():
        return None

    project_root = project_dir.resolve()
    candidate = Path(path_value.strip())
    resolved_candidate = (candidate if candidate.is_absolute() else project_dir / candidate).resolve(strict=False)
    try:
        relative_path = resolved_candidate.relative_to(project_root)
    except ValueError:
        return None

    if resolved_candidate.suffix.lower() in REFERENCE_IMAGE_EXTENSIONS and not resolved_candidate.is_file():
        return None

    return relative_path.as_posix()


def _sanitize_generation_output(project_dir: Path, output: dict[str, Any]) -> dict[str, Any]:
    return {
        "operation": output.get("operation"),
        "reference_image_paths": [
            relative_path
            for reference in output.get("reference_image_paths", [])
            if (relative_path := sanitize_project_path(project_dir, reference)) is not None
        ],
        "output_path": sanitize_project_path(project_dir, output.get("output_path")),
        "cost_usd": output.get("cost_usd"),
        "degraded_from_operation": output.get("degraded_from_operation"),
        "referenced_asset_ids": [
            str(asset_id)
            for asset_id in output.get("referenced_asset_ids", [])
            if isinstance(asset_id, str) and asset_id
        ],
    }


def _sanitize_shot_response(project_dir: Path, shot: dict[str, Any]) -> dict[str, Any]:
    response_shot = deepcopy(shot)
    response_shot["output_path"] = sanitize_project_path(project_dir, response_shot.get("output_path"))
    return response_shot


def _sanitize_storyboard_response(project_dir: Path, storyboard: dict[str, Any]) -> dict[str, Any]:
    response_storyboard = deepcopy(storyboard)
    for response_shot in response_storyboard.get("shots", []):
        if isinstance(response_shot, dict):
            response_shot["output_path"] = sanitize_project_path(project_dir, response_shot.get("output_path"))
    return response_storyboard


def _sanitize_render_report_response(project_dir: Path, render_report: dict[str, Any]) -> dict[str, Any]:
    response_render_report = deepcopy(render_report)
    for output in response_render_report.get("outputs", []):
        if isinstance(output, dict):
            output["path"] = sanitize_project_path(project_dir, output.get("path"))
    return response_render_report


def _sanitize_generation_execution_response(
    project_dir: Path,
    generation_execution: dict[str, Any],
) -> dict[str, Any]:
    response = deepcopy(generation_execution)
    units = response.get("generation_units")
    if not isinstance(units, list):
        response["generation_units"] = []
        return response
    for unit in units:
        if isinstance(unit, dict):
            unit["output_path"] = sanitize_project_path(
                project_dir, unit.get("output_path")
            )
    return response


def _persist_storyboard_state(
    *,
    workbench: WorkbenchStore,
    project_id: str,
    storyboard: dict[str, Any],
    series_bible: dict[str, Any],
    consistency_report: dict[str, Any],
) -> None:
    workbench.write_artifact(project_id, "episode_storyboard.json", storyboard)
    workbench.write_artifact(project_id, "series_bible.json", series_bible)
    workbench.write_asset_library(project_id, list(series_bible.get("assets", [])))
    workbench.write_artifact(project_id, "consistency_report.json", consistency_report)


def _mark_compatible_video_frames_stale(
    assets: list[dict[str, Any]],
    *,
    shot_id: str,
) -> int:
    changed = 0
    for asset in assets:
        if not isinstance(asset, dict) or asset.get("source_type") != "video_frame":
            continue
        provenance = asset.get("provenance")
        if not isinstance(provenance, dict) or provenance.get("shot_id") != shot_id:
            continue
        if asset.get("status") != "stale":
            asset["status"] = "stale"
            changed += 1
    return changed


def _persist_compatible_assets(
    *,
    db: Session,
    workbench: WorkbenchStore,
    project_id: str,
    asset_records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    series_bible = workbench.read_artifact(project_id, "series_bible.json")
    if series_bible is None:
        raise HTTPException(status_code=404, detail="Project not found")
    assets = workbench.read_asset_library(project_id)
    assets_by_id = {
        str(asset.get("id")): asset
        for asset in assets
        if isinstance(asset, dict) and asset.get("id")
    }
    persisted: list[dict[str, Any]] = []
    for asset_record in asset_records:
        asset_id = str(asset_record["id"])
        existing = assets_by_id.get(asset_id)
        if existing is not None:
            persisted.append(existing)
            continue
        assets.append(asset_record)
        assets_by_id[asset_id] = asset_record
        persisted.append(asset_record)
    workbench.write_asset_library(project_id, assets)
    series_bible["assets"] = assets
    workbench.write_artifact(project_id, "series_bible.json", series_bible)
    storyboard = workbench.read_artifact(
        project_id, "episode_storyboard.json"
    ) or {"shots": []}
    continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
    workflow_settings = read_workflow_settings(workbench, project_id)
    rewrite_workflow_artifacts(
        workbench=workbench,
        project_id=project_id,
        series_bible=series_bible,
        storyboard=storyboard,
        render_runtime=workflow_settings["render_runtime"],
        video_model=workflow_settings["video_model"],
        continuity_plan=continuity_plan,
        db=db,
    )
    return persisted


def _replace_planned_resource_with_generated(
    *,
    db: Session,
    workbench: WorkbenchStore,
    project_id: str,
    resource_id: str,
    target_version: int,
    generated_record: dict[str, Any],
) -> dict[str, Any]:
    assets = workbench.read_asset_library(project_id)
    resource_index = next(
        (
            index
            for index, asset in enumerate(assets)
            if isinstance(asset, dict) and str(asset.get("id")) == resource_id
        ),
        None,
    )
    if resource_index is None:
        raise ValueError("planned resource is unavailable")
    current = assets[resource_index]
    if int(current.get("version") or 1) != target_version:
        raise ValueError("planned resource version changed")

    merged = deepcopy(current)
    for field in (
        "kind",
        "label",
        "description",
        "prompt",
        "reference_images",
        "media_urls",
        "origin_project_id",
        "source_type",
        "model",
        "generation_job_id",
        "media_url",
        "status",
    ):
        if field in generated_record:
            merged[field] = deepcopy(generated_record[field])
    merged["id"] = resource_id
    merged["media_asset_id"] = str(generated_record["id"])
    merged["shot_ids"] = list(current.get("shot_ids") or [])
    merged["version"] = target_version + 1
    merged.pop("planned", None)
    assets[resource_index] = merged

    series_bible = workbench.read_artifact(project_id, "series_bible.json")
    if not isinstance(series_bible, dict):
        raise ValueError("project series bible is unavailable")
    series_bible["assets"] = assets
    workbench.write_asset_library(project_id, assets)
    workbench.write_artifact(project_id, "series_bible.json", series_bible)

    creative_workflow = workbench.read_artifact(
        project_id, "creative_workflow.json"
    ) or {}
    if isinstance(creative_workflow, dict):
        creative_workflow["planned_asset_ids"] = [
            str(asset_id)
            for asset_id in creative_workflow.get("planned_asset_ids", [])
            if str(asset_id) != resource_id
        ]
        workbench.write_artifact(
            project_id, "creative_workflow.json", creative_workflow
        )

    storyboard = workbench.read_artifact(
        project_id, "episode_storyboard.json"
    ) or {"shots": []}
    workflow_settings = read_workflow_settings(workbench, project_id)
    rewrite_workflow_artifacts(
        workbench=workbench,
        project_id=project_id,
        series_bible=series_bible,
        storyboard=storyboard,
        render_runtime=workflow_settings["render_runtime"],
        video_model=workflow_settings["video_model"],
        continuity_plan=workbench.read_artifact(project_id, "continuity_plan.json"),
        db=db,
    )
    return merged


def _bind_generated_shot_frame(
    *,
    db: Session,
    workbench: WorkbenchStore,
    project_id: str,
    shot_id: str,
    frame_target: Literal["first", "last"],
    target_version: int,
    generated_record: dict[str, Any],
) -> dict[str, Any]:
    storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
    series_bible = workbench.read_artifact(project_id, "series_bible.json")
    if not isinstance(storyboard, dict) or not isinstance(series_bible, dict):
        raise ValueError("shot frame project artifacts are unavailable")
    shot = next(
        (
            candidate
            for candidate in storyboard.get("shots", [])
            if isinstance(candidate, dict) and str(candidate.get("id")) == shot_id
        ),
        None,
    )
    if shot is None or int(shot.get("version") or 1) != target_version:
        raise ValueError("shot frame target version changed")

    continuity = resolve_continuity(shot)
    frame_key = "first_frame" if frame_target == "first" else "last_frame"
    previous_frame = continuity.get(frame_key)
    frame_version = (
        int(previous_frame.get("version") or 1) + 1
        if isinstance(previous_frame, dict)
        else 1
    )
    frame_reference = {
        "asset_id": str(generated_record["id"]),
        "version": frame_version,
        "status": "ready",
        "source": "ai_generated",
        "generation_job_id": generated_record.get("generation_job_id"),
    }
    if frame_target == "first":
        continuity["explicit_user_first_frame_asset_id"] = str(
            generated_record["id"]
        )
        continuity["first_frame"] = frame_reference
    else:
        continuity["last_frame_asset_id"] = str(generated_record["id"])
        continuity["last_frame"] = frame_reference
    continuity["stale"] = False
    updated_shot = update_mock_shot(
        storyboard,
        shot_id,
        edits={"continuity": continuity},
        source="ai_generated_frame",
    )

    generated_record = deepcopy(generated_record)
    generated_record["shot_ids"] = [shot_id]
    asset_library = workbench.read_asset_library(project_id)
    existing_index = next(
        (
            index
            for index, asset in enumerate(asset_library)
            if isinstance(asset, dict)
            and str(asset.get("id")) == str(generated_record["id"])
        ),
        None,
    )
    if existing_index is None:
        asset_library.append(generated_record)
    else:
        asset_library[existing_index] = generated_record
    series_bible["assets"] = asset_library
    workbench.write_asset_library(project_id, asset_library)
    workbench.write_artifact(project_id, "series_bible.json", series_bible)
    workbench.write_artifact(project_id, "episode_storyboard.json", storyboard)
    workflow_settings = read_workflow_settings(workbench, project_id)
    rewrite_workflow_artifacts(
        workbench=workbench,
        project_id=project_id,
        series_bible=series_bible,
        storyboard=storyboard,
        render_runtime=workflow_settings["render_runtime"],
        video_model=workflow_settings["video_model"],
        continuity_plan=workbench.read_artifact(project_id, "continuity_plan.json"),
        db=db,
    )
    return updated_shot


def _inspiration_frame_prompt(
    shot: dict[str, Any],
    frame_target: Literal["first", "last"],
) -> str:
    continuity = resolve_continuity(shot)
    locks = [
        f"composition: {continuity.get('composition')}",
        f"subject pose: {continuity.get('subject_pose')}",
        f"gaze: {continuity.get('gaze')}",
        f"motion direction: {continuity.get('motion_direction')}",
        f"lighting: {continuity.get('lighting')}",
        f"scene state: {continuity.get('scene_state')}",
    ]
    locks = [lock for lock in locks if not lock.endswith(": None") and not lock.endswith(": ")]
    role = (
        "Create the opening keyframe for the first shot"
        if frame_target == "first"
        else "Create the closing keyframe for the final shot"
    )
    prompt = str(shot.get("prompt") or shot.get("beat") or "cinematic shot").strip()
    intent = str(shot.get("shot_intent") or "").strip()
    location = str(shot.get("location") or "").strip()
    details = [
        role,
        f"Shot description: {prompt}",
        f"Shot intent: {intent}" if intent else "",
        f"Location: {location}" if location else "",
        f"Continuity locks: {'; '.join(locks)}" if locks else "Preserve subject, setting, lighting, and screen direction",
        "Single still frame without text, captions, logos, or watermarks",
    ]
    return ". ".join(detail for detail in details if detail)


def _inspiration_shot_snapshot(shot: dict[str, Any]) -> dict[str, Any]:
    fields = (
        "id",
        "index",
        "beat",
        "prompt",
        "location",
        "shot_intent",
        "shot_language",
        "characters",
        "props",
        "asset_ids",
        "visual_style",
        "aspect_ratio",
        "continuity",
        "version",
    )
    return {field: deepcopy(shot.get(field)) for field in fields if field in shot}


def _inspiration_frame_references(shot: dict[str, Any]) -> list[dict[str, Any]]:
    references: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for entity_type, values in (
        ("asset", shot.get("asset_ids")),
        ("character", shot.get("characters")),
        ("prop", shot.get("props")),
    ):
        if not isinstance(values, list):
            continue
        for value in values:
            entity_id = str(value or "").strip()
            key = (entity_type, entity_id)
            if not entity_id or key in seen:
                continue
            seen.add(key)
            references.append(
                {"entity_type": entity_type, "entity_id": entity_id}
            )
            if len(references) == 50:
                return references
    return references


def _build_inspiration_end_frame_submission(
    *,
    storyboard: dict[str, Any],
    continuity_plan: dict[str, Any] | None,
    plan_generation_id: str,
) -> TaskSubmitRequest | None:
    shots = [shot for shot in storyboard.get("shots", []) if isinstance(shot, dict)]
    if not shots or not plan_generation_id.strip():
        return None

    first_shot = shots[0]
    last_shot = shots[-1]
    first_id = str(first_shot.get("id") or "").strip()
    last_id = str(last_shot.get("id") or "").strip()
    if not first_id or not last_id:
        return None

    preferences = (continuity_plan or {}).get("generation_preferences")
    preferences = preferences if isinstance(preferences, dict) else {}
    image_model = str(preferences.get("image_model") or DEFAULT_IMAGE_MODEL).strip()
    image_size = str(preferences.get("image_size") or "1024x1024").strip()
    if image_size not in {"1024x1024", "1536x1024", "1024x1536"}:
        image_size = "1024x1024"
    image_quality = str(preferences.get("image_quality") or "standard").strip()
    if image_quality not in {"standard", "high"}:
        image_quality = "standard"

    first_snapshot = _inspiration_shot_snapshot(first_shot)
    last_snapshot = _inspiration_shot_snapshot(last_shot)
    request_snapshot = {
        "purpose": INSPIRATION_END_FRAME_TASK_PURPOSE,
        "plan_generation_id": plan_generation_id,
        "targets": [
            {"shot_id": first_id, "frame_target": "first", "shot": first_snapshot},
            {"shot_id": last_id, "frame_target": "last", "shot": last_snapshot},
        ],
        "generation_preferences": {
            "image_model": image_model,
            "image_size": image_size,
            "image_quality": image_quality,
        },
    }
    canonical = json.dumps(
        request_snapshot,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    first_key = f"first:{first_id}:{digest[:32]}"
    single_shot = first_id == last_id
    first_version = int(first_shot.get("version") or 1)
    last_version = int(last_shot.get("version") or 1) + (1 if single_shot else 0)

    def item(
        *,
        shot: dict[str, Any],
        shot_id: str,
        frame_target: Literal["first", "last"],
        target_version: int,
        depends_on: list[str],
    ) -> TaskItemSubmit:
        label = "Opening frame" if frame_target == "first" else "Closing frame"
        return TaskItemSubmit(
            idempotency_key=f"{frame_target}:{shot_id}:{digest[:32]}",
            input={
                "kind": "scene",
                "label": label,
                "description": str(shot.get("beat") or shot.get("shot_intent") or ""),
                "prompt": _inspiration_frame_prompt(shot, frame_target),
                "model": image_model,
                "count": 1,
                "size": image_size,
                "quality": image_quality,
                "shot_id": shot_id,
                "frame_target": frame_target,
                "shot_snapshot": _inspiration_shot_snapshot(shot),
            },
            references=_inspiration_frame_references(shot),
            model=image_model,
            target_entity_type="shot_frame",
            target_entity_id=shot_id,
            target_entity_version=target_version,
            depends_on=depends_on,
        )

    return TaskSubmitRequest(
        idempotency_key=_inspiration_end_frame_batch_key(plan_generation_id),
        task_type="resource_image.generate",
        project_version=1,
        snapshot=request_snapshot,
        items=[
            item(
                shot=first_shot,
                shot_id=first_id,
                frame_target="first",
                target_version=first_version,
                depends_on=[],
            ),
            item(
                shot=last_shot,
                shot_id=last_id,
                frame_target="last",
                target_version=last_version,
                depends_on=[first_key] if single_shot else [],
            ),
        ],
    )


def _inspiration_end_frame_batch_key(plan_generation_id: str) -> str:
    digest = hashlib.sha256(plan_generation_id.encode("utf-8")).hexdigest()
    return f"inspiration-end-frames:{digest}"


def _default_continuity_plan(project_type: ProjectType | str) -> dict[str, Any]:
    plan = ContinuityPlan(project_type=project_type).model_dump()
    if project_type != "single_video":
        plan["active_episode_number"] = 1
    return plan


def _project_type_from_brief(brief: Any) -> ProjectType | None:
    if not isinstance(brief, dict):
        return None
    format_value = str(brief.get("format") or "").strip().lower()
    if format_value in {"mini_series", "mini series", "series", "episodic"}:
        return "mini_series"
    if format_value in {"long_series", "long series", "season"}:
        return "long_series"
    return None


def _brief_project_title(brief: Any) -> str | None:
    if not isinstance(brief, dict):
        return None
    title = str(brief.get("title") or "").strip()
    return title[:255] if title else None


def _default_creative_workflow(storyboard: dict[str, Any]) -> dict[str, Any]:
    has_storyboard = bool(storyboard.get("shots"))
    section_status = "approved" if has_storyboard else "pending"
    return {
        "phase": "approved" if has_storyboard else "inspiration",
        "messages": [],
        "brief": None,
        "ready_to_confirm": False,
        "control_end_frames": False,
        "text_model": None,
        "planned_asset_ids": [],
        "approved_at": None,
        "brief_confirmed_at": None,
        "plan_generated_at": None,
        "revision_session": None,
        "plan_sections": _default_plan_sections(section_status),
    }


def _planned_creative_workflow(
    series_bible: dict[str, Any],
    text_model: str | None = None,
) -> dict[str, Any]:
    generated_at = datetime.now(timezone.utc).isoformat()
    return {
        "phase": "plan_review",
        "messages": [],
        "brief": None,
        "ready_to_confirm": True,
        "control_end_frames": False,
        "text_model": (
            text_model.strip()
            if isinstance(text_model, str) and text_model.strip()
            else None
        ),
        "planned_asset_ids": [
            str(asset.get("id"))
            for asset in series_bible.get("assets", [])
            if isinstance(asset, dict) and asset.get("id")
        ],
        "approved_at": None,
        "brief_confirmed_at": generated_at,
        "plan_generated_at": generated_at,
        "revision_session": None,
        "plan_sections": {
            section: PlanSectionApproval(
                status="pending",
                updated_at=generated_at,
            ).model_dump()
            for section in PLAN_SECTION_IDS
        },
    }


def _default_plan_sections(
    status: Literal["pending", "approved", "changes_requested"] = "pending",
) -> dict[str, dict[str, Any]]:
    return {
        section: PlanSectionApproval(status=status).model_dump()
        for section in PLAN_SECTION_IDS
    }


def _normalized_creative_workflow(
    storyboard: dict[str, Any],
    value: dict[str, Any] | None,
) -> dict[str, Any]:
    workflow = dict(value or _default_creative_workflow(storyboard))
    if (
        storyboard.get("shots")
        and workflow.get("phase") == "inspiration"
        and not workflow.get("messages")
        and not workflow.get("brief")
    ):
        workflow["phase"] = "approved"

    phase = workflow.get("phase")
    if phase not in {"inspiration", "plan_review", "approved"}:
        phase = "inspiration"
    workflow["phase"] = phase
    fallback_status = "approved" if phase == "approved" else "pending"
    raw_sections = workflow.get("plan_sections")
    raw_sections = raw_sections if isinstance(raw_sections, dict) else {}
    normalized_sections: dict[str, dict[str, Any]] = {}
    for section in PLAN_SECTION_IDS:
        raw_approval = raw_sections.get(section)
        if not isinstance(raw_approval, dict):
            normalized_sections[section] = PlanSectionApproval(
                status=fallback_status
            ).model_dump()
            continue
        try:
            normalized_sections[section] = PlanSectionApproval.model_validate(
                raw_approval
            ).model_dump()
        except Exception:
            # A malformed persisted approval must fail closed rather than unlock production.
            normalized_sections[section] = PlanSectionApproval().model_dump()

    workflow["messages"] = (
        workflow.get("messages") if isinstance(workflow.get("messages"), list) else []
    )
    workflow["brief"] = workflow.get("brief") if isinstance(workflow.get("brief"), dict) else None
    workflow["ready_to_confirm"] = workflow.get("ready_to_confirm") is True
    workflow["control_end_frames"] = workflow.get("control_end_frames") is True
    raw_text_model = workflow.get("text_model")
    workflow["text_model"] = (
        raw_text_model.strip()
        if isinstance(raw_text_model, str) and raw_text_model.strip()
        else None
    )
    workflow["planned_asset_ids"] = [
        str(asset_id)
        for asset_id in workflow.get("planned_asset_ids", [])
        if str(asset_id)
    ] if isinstance(workflow.get("planned_asset_ids"), list) else []
    for timestamp in (
        "approved_at",
        "brief_confirmed_at",
        "plan_generated_at",
    ):
        workflow[timestamp] = (
            workflow.get(timestamp) if isinstance(workflow.get(timestamp), str) else None
        )
    raw_revision_session = workflow.get("revision_session")
    if isinstance(raw_revision_session, dict):
        try:
            workflow["revision_session"] = StoryboardRevisionSession.model_validate(
                raw_revision_session
            ).model_dump()
        except Exception:
            workflow["revision_session"] = None
    else:
        workflow["revision_session"] = None
    workflow["plan_sections"] = normalized_sections
    return CreativeWorkflow.model_validate(workflow).model_dump()


def _creative_workflow_state(
    workbench: WorkbenchStore,
    project_id: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    storyboard = workbench.read_artifact(project_id, "episode_storyboard.json") or {"shots": []}
    workflow = workbench.read_artifact(project_id, "creative_workflow.json")
    return storyboard, _normalized_creative_workflow(storyboard, workflow)


def _missing_plan_sections(workflow: dict[str, Any]) -> list[PlanSectionId]:
    sections = workflow.get("plan_sections", {})
    return [
        section
        for section in PLAN_SECTION_IDS
        if not isinstance(sections.get(section), dict)
        or sections[section].get("status") != "approved"
    ]


def _require_approved_creative_workflow(
    workbench: WorkbenchStore,
    project_id: str,
) -> dict[str, Any]:
    _, workflow = _creative_workflow_state(workbench, project_id)
    if workflow.get("phase") != "approved" or _missing_plan_sections(workflow):
        raise HTTPException(
            status_code=409,
            detail="Creative plan must be approved before production",
        )
    return workflow


def _require_inspiration_editable_workflow(
    workbench: WorkbenchStore,
    project_id: str,
) -> dict[str, Any]:
    _, workflow = _creative_workflow_state(workbench, project_id)
    if workflow.get("phase") == "approved":
        raise HTTPException(
            status_code=409,
            detail="Approved creative plan cannot be edited in inspiration",
        )
    return workflow


def _require_creative_brief_ready_for_planning(
    workbench: WorkbenchStore,
    project_id: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    storyboard, workflow = _creative_workflow_state(workbench, project_id)
    if (
        workflow.get("phase") not in {"inspiration", "plan_review"}
        or workflow.get("ready_to_confirm") is not True
        or not isinstance(workflow.get("brief"), dict)
    ):
        raise HTTPException(
            status_code=409,
            detail="Creative brief must be confirmed before storyboard planning",
        )
    return storyboard, workflow


def _storyboard_plan_workflow_token(workflow: dict[str, Any]) -> str:
    value = {
        "phase": workflow.get("phase"),
        "messages": workflow.get("messages"),
        "brief": workflow.get("brief"),
        "ready_to_confirm": workflow.get("ready_to_confirm"),
        "control_end_frames": workflow.get("control_end_frames"),
        "text_model": workflow.get("text_model"),
        "plan_generated_at": workflow.get("plan_generated_at"),
    }
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _merge_generated_continuity(
    continuity_plan: dict[str, Any],
    series_bible: dict[str, Any],
    *,
    inherit_generation_preferences: bool = False,
    generated_continuity: dict[str, Any] | None = None,
) -> dict[str, Any]:
    merged = deepcopy(continuity_plan)
    continuity_bible = merged.setdefault("series_bible", {})
    for key in ("worldview", "main_arc", "style_lock", "visual_rules", "series_prompt"):
        source = series_bible.get(key)
        value = (
            json.dumps(source, ensure_ascii=False, indent=2)
            if isinstance(source, (dict, list))
            else str(source or "").strip()
        )
        if value and _continuity_value_is_empty(continuity_bible.get(key)):
            continuity_bible[key] = value

    generated_relationships = series_bible.get("relationship_map")
    if (
        isinstance(generated_relationships, list)
        and generated_relationships
        and _continuity_value_is_empty(continuity_bible.get("relationship_map"))
    ):
        continuity_bible["relationship_map"] = list(generated_relationships)

    visual_rules = series_bible.get("visual_rules")
    if inherit_generation_preferences and isinstance(visual_rules, dict):
        aspect_ratio = str(visual_rules.get("aspect_ratio") or "").strip()
        image_sizes = {
            "16:9": "1536x1024",
            "9:16": "1024x1536",
            "1:1": "1024x1024",
            "4:3": "1536x1024",
        }
        if aspect_ratio in image_sizes:
            preferences = merged.setdefault("generation_preferences", {})
            preferences["aspect_ratio"] = aspect_ratio
            preferences["image_size"] = image_sizes[aspect_ratio]

    assets = [asset for asset in series_bible.get("assets", []) if isinstance(asset, dict)]
    locations = [
        str(asset.get("label") or "").strip()
        for asset in assets
        if asset.get("kind") == "scene" and str(asset.get("label") or "").strip()
    ]
    props = [
        str(asset.get("label") or "").strip()
        for asset in assets
        if asset.get("kind") == "prop" and str(asset.get("label") or "").strip()
    ]
    if locations and _continuity_value_is_empty(continuity_bible.get("locations")):
        continuity_bible["locations"] = list(dict.fromkeys(locations))
    if props and _continuity_value_is_empty(continuity_bible.get("props")):
        continuity_bible["props"] = list(dict.fromkeys(props))
    sound_plan = series_bible.get("sound_plan")
    if isinstance(sound_plan, dict):
        sound = merged.setdefault("sound", {})
        for key in (
            "narration",
            "dialogue",
            "ambience",
            "music_direction",
            "prompt",
            "storyboard_prompt_integration",
        ):
            if key in sound_plan and _continuity_value_is_empty(sound.get(key)):
                sound[key] = sound_plan[key]
    episodes = []
    if isinstance(generated_continuity, dict):
        episodes = generated_continuity.get("episodes", [])
    if not isinstance(episodes, list) or not episodes:
        episodes = series_bible.get("episodes", [])
    if isinstance(episodes, list):
        merged["episodes"] = _merge_generated_episodes(
            merged.get("episodes", []), episodes
        )
    return merged


def _publish_storyboard_plan_result(
    *,
    db: Session,
    workbench: WorkbenchStore,
    project: ProjectRecord,
    creative_workflow: dict[str, Any],
    prompt: str,
    video_model: str,
    text_model: str | None = None,
    result: dict[str, Any],
    task_receipt: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    previous_planned_ids = {
        str(asset_id)
        for asset_id in creative_workflow.get("planned_asset_ids", [])
        if str(asset_id)
    }
    existing_assets = [
        asset
        for asset in workbench.read_asset_library(project.id)
        if not isinstance(asset, dict) or str(asset.get("id")) not in previous_planned_ids
    ]
    existing_asset_ids = {
        asset.get("id") for asset in existing_assets if isinstance(asset, dict)
    }
    generated_assets = result["series_bible"].get("assets", [])
    result["series_bible"]["assets"] = [
        *existing_assets,
        *[
            asset
            for asset in generated_assets
            if isinstance(asset, dict) and asset.get("id") not in existing_asset_ids
        ],
    ]
    result["series_bible"]["project_brief"] = prompt.strip()
    result["consistency_report"] = evaluate_storyboard_consistency(
        result["series_bible"],
        result["storyboard"],
    )
    apply_consistency_scores(result["storyboard"], result["consistency_report"])

    changed_paths = [
        *STORYBOARD_ARTIFACT_PATHS,
        *WORKFLOW_ARTIFACT_PATHS,
        "artifacts/creative_workflow.json",
    ]
    if task_receipt is not None:
        changed_paths.append("artifacts/storyboard_plan_task.json")
    with _project_mutation(
        db=db,
        workbench=workbench,
        project_id=project.id,
        operation="plan_storyboard",
        changed_paths=changed_paths,
        failure_detail="Storyboard planning failed",
    ):
        continuity_plan = workbench.read_artifact(
            project.id, "continuity_plan.json"
        ) or _default_continuity_plan(project.project_type)
        continuity_plan = _merge_generated_continuity(
            continuity_plan,
            result["series_bible"],
            inherit_generation_preferences=(
                creative_workflow.get("plan_generated_at") is None
            ),
            generated_continuity=result.get("continuity_plan"),
        )
        _persist_storyboard_state(
            workbench=workbench,
            project_id=project.id,
            storyboard=result["storyboard"],
            series_bible=result["series_bible"],
            consistency_report=result["consistency_report"],
        )
        workbench.write_artifact(project.id, "continuity_plan.json", continuity_plan)
        plan_generated_at = datetime.now(timezone.utc).isoformat()
        was_previously_generated = creative_workflow.get("plan_generated_at") is not None
        creative_workflow.update(
            {
                "phase": "plan_review",
                "ready_to_confirm": True,
                "text_model": (
                    text_model.strip()
                    if isinstance(text_model, str) and text_model.strip()
                    else creative_workflow.get("text_model")
                ),
                "planned_asset_ids": [
                    str(asset.get("id"))
                    for asset in generated_assets
                    if isinstance(asset, dict) and asset.get("id")
                ],
                "approved_at": None,
                "brief_confirmed_at": (
                    creative_workflow.get("brief_confirmed_at") or plan_generated_at
                ),
                "plan_generated_at": plan_generated_at,
                "plan_sections": {
                    section: PlanSectionApproval(
                        status="pending",
                        revision=(
                            approval["revision"] + 1
                            if was_previously_generated
                            else approval["revision"]
                        ),
                        updated_at=plan_generated_at,
                    ).model_dump()
                    for section, approval in creative_workflow["plan_sections"].items()
                },
            }
        )
        workbench.write_artifact(
            project.id, "creative_workflow.json", creative_workflow
        )
        if task_receipt is not None:
            workbench.write_artifact(
                project.id, "storyboard_plan_task.json", task_receipt
            )
        workflow_settings = read_workflow_settings(workbench, project.id)
        rewrite_workflow_artifacts(
            workbench=workbench,
            project_id=project.id,
            series_bible=result["series_bible"],
            storyboard=result["storyboard"],
            render_runtime=workflow_settings["render_runtime"],
            video_model=video_model,
            continuity_plan=continuity_plan,
            db=db,
        )
        project.updated_at = datetime.now(timezone.utc)
    return result["storyboard"], creative_workflow, continuity_plan


def _continuity_value_is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, dict)):
        return not value
    return False


def _merge_generated_episodes(
    current: Any,
    generated: list[Any],
) -> list[dict[str, Any]]:
    current_items = current if isinstance(current, list) else []
    existing = {
        int(item.get("episode_number")): deepcopy(item)
        for item in current_items
        if isinstance(item, dict) and str(item.get("episode_number", "")).isdigit()
    }
    fields = (
        "title",
        "goal",
        "conflict",
        "twist",
        "cliffhanger",
        "inherited_state",
        "prompt",
        "outline",
    )
    for item in generated:
        if not isinstance(item, dict):
            continue
        try:
            number = int(item.get("episode_number"))
        except (TypeError, ValueError):
            continue
        if number < 1:
            continue
        previous = existing.setdefault(
            number,
            {"episode_number": number, "locked": False},
        )
        if previous.get("locked") is True:
            continue
        for field in fields:
            value = item.get(field)
            if (
                _continuity_value_is_empty(previous.get(field))
                and not _continuity_value_is_empty(value)
            ):
                previous[field] = deepcopy(value)
        if "locked" not in previous:
            previous["locked"] = bool(item.get("locked", False))
    return [existing[number] for number in sorted(existing)]


def _continuity_video_model(
    continuity_plan: dict[str, Any] | None,
    requested_model: str | None = None,
) -> str:
    if requested_model and requested_model.strip():
        return requested_model.strip()
    preferences = (continuity_plan or {}).get("generation_preferences")
    if isinstance(preferences, dict):
        preferred = str(preferences.get("video_model") or "").strip()
        if preferred:
            return preferred
    return DEFAULT_VIDEO_MODEL


def _creative_target_duration(creative_workflow: dict[str, Any] | None) -> float | None:
    brief = (creative_workflow or {}).get("brief")
    value = brief.get("duration_seconds") if isinstance(brief, dict) else None
    try:
        duration = float(value)
    except (TypeError, ValueError):
        return None
    return duration if duration > 0 else None


_PLAN_SECTION_DEPENDENCIES: dict[PlanSectionId, tuple[PlanSectionId, ...]] = {
    "worldview": ("worldview", "characters", "scenes", "props", "storyboard"),
    "characters": ("characters", "storyboard"),
    "scenes": ("scenes", "storyboard"),
    "props": ("props", "storyboard"),
    "sound": ("sound",),
    "storyboard": ("storyboard",),
}
_SOUND_STORYBOARD_FIELDS = {
    "audio_prompt",
    "dialogue",
    "music_cue",
    "narration",
    "sound_design",
    "sound_prompt",
    "voiceover",
}


def _sound_plan_affects_storyboard(
    series_bible: dict[str, Any],
    storyboard: dict[str, Any],
) -> bool:
    sound_plan = series_bible.get("sound_plan")
    if isinstance(sound_plan, dict) and any(
        sound_plan.get(field) is True
        for field in (
            "applies_to_storyboard",
            "storyboard_prompt_integration",
            "write_into_storyboard_prompts",
        )
    ):
        return True
    return any(
        isinstance(shot, dict) and bool(_SOUND_STORYBOARD_FIELDS.intersection(shot))
        for shot in storyboard.get("shots", [])
    )


def _affected_plan_sections(
    requested_sections: list[PlanSectionId],
    current_series_bible: dict[str, Any],
    current_storyboard: dict[str, Any],
    generated_series_bible: dict[str, Any],
    generated_storyboard: dict[str, Any],
) -> list[PlanSectionId]:
    affected = {
        dependency
        for section in requested_sections
        for dependency in _PLAN_SECTION_DEPENDENCIES[section]
    }
    if "sound" in requested_sections and (
        _sound_plan_affects_storyboard(current_series_bible, current_storyboard)
        or _sound_plan_affects_storyboard(generated_series_bible, generated_storyboard)
    ):
        affected.add("storyboard")
    return [section for section in PLAN_SECTION_IDS if section in affected]


def _merge_revised_characters(
    current: list[Any],
    generated: list[Any],
) -> list[dict[str, Any]]:
    existing = {
        str(character.get("id")): character
        for character in current
        if isinstance(character, dict) and character.get("id")
    }
    merged: list[dict[str, Any]] = []
    for character in generated:
        if not isinstance(character, dict):
            continue
        previous = existing.get(str(character.get("id")), {})
        next_character = {**previous, **character}
        if previous.get("reference_images"):
            next_character["reference_images"] = list(previous["reference_images"])
        merged.append(next_character)
    return merged


def _character_asset_match_index(
    asset: dict[str, Any],
    characters: list[dict[str, Any]],
) -> int | None:
    if str(asset.get("kind") or "").strip().lower() != "character":
        return None
    asset_id = str(asset.get("id") or "").strip().casefold()
    asset_label = str(asset.get("label") or "").strip().casefold()
    matches: list[tuple[int, int]] = []
    for index, character in enumerate(characters):
        character_id = str(character.get("id") or "").strip().casefold()
        character_name = str(character.get("name") or "").strip().casefold()
        if character_id and asset_id in {character_id, f"character-{character_id}"}:
            matches.append((3, index))
        elif character_name and asset_label == character_name:
            matches.append((1, index))
    if not matches:
        return None
    highest_rank = max(rank for rank, _ in matches)
    best = [index for rank, index in matches if rank == highest_rank]
    return best[0] if len(best) == 1 else None


def _sync_revised_character_assets(
    current_assets: list[dict[str, Any]],
    generated_assets: list[Any],
    revised_characters: list[dict[str, Any]],
    planned_asset_ids: set[str],
) -> tuple[list[dict[str, Any]], set[str]]:
    """Keep character asset prompts aligned without replacing user-owned media."""
    assets = [deepcopy(asset) for asset in current_assets if isinstance(asset, dict)]
    generated_character_assets = [
        asset
        for asset in generated_assets
        if isinstance(asset, dict)
        and str(asset.get("kind") or "").strip().lower() == "character"
    ]
    generated_character_by_id: dict[str, int | None] = {}
    for asset in generated_character_assets:
        asset_id = str(asset.get("id") or "").strip().casefold()
        character_index = _character_asset_match_index(asset, revised_characters)
        if not asset_id or character_index is None:
            continue
        if asset_id in generated_character_by_id:
            generated_character_by_id[asset_id] = None
        else:
            generated_character_by_id[asset_id] = character_index

    matched_character_indexes: set[int] = set()
    for asset in assets:
        if str(asset.get("kind") or "").strip().lower() != "character":
            continue
        character_index = _character_asset_match_index(asset, revised_characters)
        if character_index is None:
            generated_match = generated_character_by_id.get(
                str(asset.get("id") or "").strip().casefold()
            )
            character_index = generated_match
        if character_index is None:
            continue
        visual_lock = str(
            revised_characters[character_index].get("visual_lock") or ""
        ).strip()
        if visual_lock:
            asset["prompt"] = visual_lock
        matched_character_indexes.add(character_index)

    existing_ids = {
        str(asset.get("id"))
        for asset in assets
        if isinstance(asset, dict) and asset.get("id")
    }
    next_planned_ids = set(planned_asset_ids)
    for generated_asset in generated_character_assets:
        character_index = _character_asset_match_index(
            generated_asset, revised_characters
        )
        if character_index is None or character_index in matched_character_indexes:
            continue
        asset_id = str(generated_asset.get("id") or "").strip()
        visual_lock = str(
            revised_characters[character_index].get("visual_lock") or ""
        ).strip()
        if not asset_id or not visual_lock or asset_id in existing_ids:
            continue
        next_asset = deepcopy(generated_asset)
        next_asset["prompt"] = visual_lock
        assets.append(next_asset)
        existing_ids.add(asset_id)
        next_planned_ids.add(asset_id)
        matched_character_indexes.add(character_index)
    return assets, next_planned_ids


def _merge_revised_assets(
    current_assets: list[Any],
    generated_assets: list[Any],
    planned_asset_ids: set[str],
    affected_sections: set[PlanSectionId],
) -> tuple[list[dict[str, Any]], set[str]]:
    selected_kinds = {
        kind
        for section, kind in (("scenes", "scene"), ("props", "prop"))
        if section in affected_sections
    }
    if not selected_kinds:
        return (
            [deepcopy(asset) for asset in current_assets if isinstance(asset, dict)],
            planned_asset_ids,
        )

    current = [deepcopy(asset) for asset in current_assets if isinstance(asset, dict)]
    existing_by_id = {
        str(asset.get("id")): asset for asset in current if asset.get("id")
    }
    merged = [
        asset
        for asset in current
        if asset.get("kind") not in selected_kinds
        or str(asset.get("id")) not in planned_asset_ids
    ]
    merged_index = {
        str(asset.get("id")): index
        for index, asset in enumerate(merged)
        if asset.get("id")
    }
    next_planned_ids = {
        asset_id
        for asset_id in planned_asset_ids
        if str(existing_by_id.get(asset_id, {}).get("kind")) not in selected_kinds
    }
    for asset in generated_assets:
        if not isinstance(asset, dict) or asset.get("kind") not in selected_kinds:
            continue
        asset_id = str(asset.get("id") or "")
        if not asset_id:
            continue
        previous = existing_by_id.get(asset_id, {})
        next_asset = {**previous, **deepcopy(asset)}
        for media_field in ("reference_images", "media_urls"):
            if previous.get(media_field):
                next_asset[media_field] = list(previous[media_field])
        next_asset["version"] = max(
            int(previous.get("version") or 0) + 1,
            int(asset.get("version") or 1),
        )
        if asset_id in merged_index:
            merged[merged_index[asset_id]] = next_asset
        else:
            merged_index[asset_id] = len(merged)
            merged.append(next_asset)
        next_planned_ids.add(asset_id)
    return merged, next_planned_ids


def _merge_revised_storyboard(
    current_storyboard: dict[str, Any],
    generated_storyboard: dict[str, Any],
    updated_at: str,
) -> dict[str, Any]:
    current_by_id = {
        str(shot.get("id")): shot
        for shot in current_storyboard.get("shots", [])
        if isinstance(shot, dict) and shot.get("id")
    }
    revised = deepcopy(generated_storyboard)
    for shot in revised.get("shots", []):
        if not isinstance(shot, dict):
            continue
        previous = current_by_id.get(str(shot.get("id")))
        if previous is None:
            shot["output_url"] = None
            shot["output_path"] = None
            continue
        shot["version"] = int(previous.get("version") or 0) + 1
        shot["status"] = "ready"
        shot["output_url"] = None
        shot["output_path"] = None
        shot["history"] = [
            *deepcopy(previous.get("history", [])),
            {
                "version": shot["version"],
                "source": "prompt_edit",
                "prompt": str(shot.get("prompt") or ""),
                "characters": list(shot.get("characters", [])),
                "location": shot.get("location"),
                "props": list(shot.get("props", [])),
                "asset_ids": list(shot.get("asset_ids", [])),
                "shot_intent": shot.get("shot_intent"),
                "shot_language": shot.get("shot_language"),
                "updated_at": updated_at,
            },
        ]
    return revised


def _merge_revised_plan(
    *,
    current_series_bible: dict[str, Any],
    current_storyboard: dict[str, Any],
    generated_series_bible: dict[str, Any],
    generated_storyboard: dict[str, Any],
    affected_sections: list[PlanSectionId],
    planned_asset_ids: set[str],
    updated_at: str,
) -> tuple[dict[str, Any], dict[str, Any], set[str]]:
    affected = set(affected_sections)
    series_bible = deepcopy(current_series_bible)
    if "worldview" in affected:
        for field in ("worldview", "main_arc", "style_lock", "visual_rules"):
            series_bible[field] = generated_series_bible.get(field, "")
    if "characters" in affected:
        series_bible["characters"] = _merge_revised_characters(
            list(current_series_bible.get("characters", [])),
            list(generated_series_bible.get("characters", [])),
        )
    if "sound" in affected:
        series_bible["sound_plan"] = deepcopy(
            generated_series_bible.get("sound_plan", {})
        )
    series_bible["assets"], next_planned_ids = _merge_revised_assets(
        list(current_series_bible.get("assets", [])),
        list(generated_series_bible.get("assets", [])),
        planned_asset_ids,
        affected,
    )
    if "characters" in affected:
        series_bible["assets"], next_planned_ids = _sync_revised_character_assets(
            series_bible["assets"],
            list(generated_series_bible.get("assets", [])),
            [
                character
                for character in series_bible.get("characters", [])
                if isinstance(character, dict)
            ],
            next_planned_ids,
        )
    storyboard = (
        _merge_revised_storyboard(
            current_storyboard,
            generated_storyboard,
            updated_at,
        )
        if "storyboard" in affected
        else deepcopy(current_storyboard)
    )
    return series_bible, storyboard, next_planned_ids


def _workflow_artifacts(workbench: WorkbenchStore, project_id: str) -> list[dict[str, Any]]:
    entries = [
        ("proposal_packet", "proposal_packet.json"),
        ("scene_plan", "scene_plan.json"),
        ("asset_manifest", "asset_manifest.json"),
        ("edit_decisions", "edit_decisions.json"),
        ("render_report", "render_report.json"),
        ("continuity_plan", "continuity_plan.json"),
        ("generation_plan", "generation_plan.json"),
        ("generation_execution", "generation_execution.json"),
    ]
    artifact_dir = workbench.artifact_dir(project_id)
    return [
        {
            "name": name,
            "path": filename,
            "exists": (artifact_dir / filename).exists(),
        }
        for name, filename in entries
    ]


def _decorate_asset_media(project_id: str, project_dir: Path, asset: dict[str, Any]) -> dict[str, Any]:
    decorated = dict(asset)
    reference_images = []
    media_urls = []
    for reference in asset.get("reference_images", []) or []:
        if isinstance(reference, str) and reference.startswith("local://media/"):
            reference_images.append(reference)
            continue
        try:
            relative = relative_project_path(project_dir, reference)
        except HTTPException:
            continue
        reference_images.append(relative)
        media_urls.append(media_download_url(project_id, relative))
    decorated["reference_images"] = reference_images
    decorated["media_urls"] = media_urls
    return decorated


def _project_data(project: ProjectRecord) -> dict[str, Any]:
    return ProjectResponse.model_validate(project).model_dump(mode="json")


def _apply_legacy_video_manifest(
    storyboard: dict[str, Any],
    asset_manifest: Mapping[str, Any] | None,
    project_dir: Path,
) -> dict[str, Any]:
    assets_by_shot = legacy_video_assets_by_shot(asset_manifest, storyboard)
    if not assets_by_shot:
        return storyboard
    decorated = deepcopy(storyboard)
    for shot in decorated.get("shots", []):
        if not isinstance(shot, dict) or shot.get("output_path"):
            continue
        asset = assets_by_shot.get(str(shot.get("id")))
        path = str(asset.get("path") or "").strip() if asset else ""
        if path and _project_media_file_exists(project_dir, path):
            shot["output_path"] = path
    return decorated


def _project_media_file_exists(project_dir: Path, output_path: str) -> bool:
    if not output_path or output_path.startswith("local://"):
        return False
    raw = Path(output_path)
    candidate = raw if raw.is_absolute() else project_dir / raw
    root = project_dir.resolve(strict=False)
    resolved = candidate.resolve(strict=False)
    if resolved != root and root not in resolved.parents:
        return False
    return resolved.is_file()


def _project_snapshot(workbench: WorkbenchStore, project: ProjectRecord) -> dict[str, Any]:
    project_dir = workbench.project_dir(project.id)
    storyboard, creative_workflow = _creative_workflow_state(workbench, project.id)
    asset_manifest = workbench.read_artifact(project.id, "asset_manifest.json") or {}
    storyboard = _apply_legacy_video_manifest(storyboard, asset_manifest, project_dir)
    series_bible = workbench.read_artifact(project.id, "series_bible.json") or {"characters": [], "assets": []}
    series_bible = dict(series_bible)
    series_bible["assets"] = [
        _decorate_asset_media(project.id, project_dir, asset)
        for asset in series_bible.get("assets", [])
    ]
    continuity_plan = (
        workbench.read_artifact(project.id, "continuity_plan.json")
        or _default_continuity_plan(project.project_type)
    )
    render_scope = _render_scope(project.project_type, continuity_plan)
    render_report = workbench.read_artifact(project.id, "render_report.json")
    response_storyboard = _sanitize_storyboard_response(project_dir, storyboard)
    response_render_report = (
        _sanitize_render_report_response(project_dir, render_report) if render_report else None
    )
    generation_execution = workbench.read_artifact(
        project.id, "generation_execution.json"
    )
    final_path = None
    scoped_output = _render_output_for_scope(
        response_render_report,
        render_scope,
        accept_legacy_output=not any(
            isinstance(shot, dict) and shot.get("episode_number") is not None
            for shot in storyboard.get("shots", [])
        ),
    )
    if scoped_output is not None:
        final_path = scoped_output.get("path")
    return {
        "project": _project_data(project),
        "series_bible": series_bible,
        "storyboard": response_storyboard,
        "consistency_report": workbench.read_artifact(project.id, "consistency_report.json") or {"score": 100, "issues": []},
        "continuity_plan": continuity_plan,
        "creative_workflow": creative_workflow,
        "workflow_artifacts": _workflow_artifacts(workbench, project.id),
        "render_report": response_render_report,
        "generation_execution": (
            _sanitize_generation_execution_response(
                project_dir, generation_execution
            )
            if isinstance(generation_execution, dict)
            else None
        ),
        "final_path": final_path,
    }


def _backfill_legacy_generation_units(
    *,
    workbench: WorkbenchStore,
    project_id: str,
    storyboard: Mapping[str, Any],
    db: Session,
    include_storyboard_outputs: bool = True,
) -> GenerationUnitService:
    ledger = GenerationUnitService(db)
    ledger.backfill_legacy_shots(
        project_id=project_id,
        storyboard=storyboard,
        project_dir=workbench.project_dir(project_id),
        asset_manifest=workbench.read_artifact(project_id, "asset_manifest.json"),
        include_storyboard_outputs=include_storyboard_outputs,
    )
    db.commit()
    write_generation_execution_snapshot(
        workbench=workbench,
        snapshot=ledger.snapshot(project_id),
    )
    return ledger


def _render_scope(
    project_type: ProjectType | str,
    continuity_plan: dict[str, Any] | None,
) -> dict[str, Any]:
    normalized_type = str(project_type or "single_video")
    episodes = [
        episode
        for episode in (continuity_plan or {}).get("episodes", [])
        if isinstance(episode, dict)
    ]
    if normalized_type == "single_video" and not episodes:
        return {
            "kind": "single_video",
            "episode_number": None,
            "episode_title": None,
            "total_episodes": 0,
        }
    try:
        active_episode_number = int(
            (continuity_plan or {}).get("active_episode_number") or 1
        )
    except (TypeError, ValueError):
        active_episode_number = 1
    active_episode_number = max(1, active_episode_number)
    active_episode = next(
        (
            episode
            for episode in episodes
            if episode.get("episode_number") == active_episode_number
        ),
        None,
    )
    episode_title = str((active_episode or {}).get("title") or "").strip() or None
    return {
        "kind": "episode",
        "episode_number": active_episode_number,
        "episode_title": episode_title,
        "total_episodes": len(episodes),
    }


def _storyboard_for_scope(
    storyboard: dict[str, Any],
    render_scope: dict[str, Any],
) -> dict[str, Any]:
    shots = [
        shot for shot in storyboard.get("shots", []) if isinstance(shot, dict)
    ]
    if render_scope["kind"] == "single_video":
        return {**storyboard, "shots": shots}
    tagged = [shot for shot in shots if shot.get("episode_number") is not None]
    if not tagged:
        return {**storyboard, "shots": shots}
    active_episode_number = render_scope["episode_number"]
    return {
        **storyboard,
        "shots": [
            shot
            for shot in shots
            if shot.get("episode_number") == active_episode_number
        ],
    }


def _build_shot_video_submission(
    *,
    workbench: WorkbenchStore,
    project: ProjectRecord,
    storyboard: dict[str, Any],
    series_bible: dict[str, Any],
    continuity_plan: dict[str, Any] | None,
    creative_workflow: dict[str, Any],
    payload: ShotBatchGenerateRequest,
    generation_plan: GenerationPlan,
    generation_revisions: dict[str, int] | None = None,
) -> tuple[TaskSubmitRequest, set[str]]:
    render_scope = _render_scope(project.project_type, continuity_plan)
    scoped = _storyboard_for_scope(storyboard, render_scope)
    ordered_shots = sorted(
        [
            shot
            for shot in scoped.get("shots", [])
            if isinstance(shot, dict) and shot.get("id")
        ],
        key=lambda shot: (int(shot.get("index") or 0), str(shot.get("id"))),
    )
    available_ids = {str(shot["id"]) for shot in ordered_shots}
    requested = set(payload.shot_ids)
    outside_scope = sorted(requested - available_ids)
    if outside_scope:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "selected_shots_outside_generation_scope",
                "shot_ids": outside_scope,
            },
        )
    selected = [shot for shot in ordered_shots if str(shot["id"]) in requested]
    if not selected:
        raise HTTPException(
            status_code=422,
            detail={"code": "selected_shots_required"},
        )

    all_assets = {
        str(asset.get("id")): asset
        for asset in series_bible.get("assets", [])
        if isinstance(asset, dict) and asset.get("id")
    }
    all_characters = {
        str(character.get("id")): character
        for character in series_bible.get("characters", [])
        if isinstance(character, dict) and character.get("id")
    }
    video_model = _continuity_video_model(continuity_plan, payload.video_model)
    if (
        generation_plan.model_id != video_model
        or set(generation_plan.shot_ids) != {str(shot["id"]) for shot in selected}
    ):
        raise HTTPException(status_code=409, detail={"code": "generation_plan_stale"})
    units_by_shot = {
        unit.shot_ids[0]: unit
        for unit in generation_plan.generation_units
        if len(unit.shot_ids) == 1
    }
    brief = (
        creative_workflow.get("brief")
        if isinstance(creative_workflow.get("brief"), dict)
        else {}
    )
    aspect_ratio = str(
        brief.get("aspect_ratio")
        or ((continuity_plan or {}).get("generation_preferences") or {}).get(
            "aspect_ratio"
        )
        or "9:16"
    )
    position_by_id = {
        str(shot["id"]): position for position, shot in enumerate(ordered_shots)
    }
    selected_ids = {str(shot["id"]) for shot in selected}
    item_keys = {
        str(shot["id"]): _shot_video_item_key(shot)
        for shot in selected
    }
    external_missing_keys: set[str] = set()
    generation_revisions = generation_revisions or {}
    items: list[TaskItemSubmit] = []
    for shot in selected:
        shot_id = str(shot["id"])
        shot_version = int(shot.get("version") or 1)
        generation_revision = generation_revisions.get(shot_id, 0)
        generation_key = _shot_generation_key(
            owner_user_id=str(project.owner_user_id),
            project_id=project.id,
            shot_id=shot_id,
            shot_version=shot_version,
            generation_revision=generation_revision,
            model=video_model,
        )
        scoped_position = position_by_id[shot_id]
        previous = ordered_shots[scoped_position - 1] if scoped_position > 0 else None
        if previous is not None and previous.get("episode_number") != shot.get(
            "episode_number"
        ):
            previous = None
        requirements = resolve_shot_generation_frame_requirements(shot, previous)
        continuity = requirements.continuity
        if requirements.regeneration and not requirements.regeneration_frames_ready:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": SHOT_FRAME_DEPENDENCIES_MISSING_CODE,
                    "message": SHOT_FRAME_DEPENDENCIES_MISSING_MESSAGE,
                    "shot_id": shot_id,
                },
            )
        if requirements.regeneration:
            for frame_name in ("first_frame", "last_frame"):
                frame = continuity.get(frame_name)
                asset_id = frame.get("asset_id") if isinstance(frame, dict) else None
                if not asset_id or not _project_asset_reference_is_available(
                    workbench=workbench,
                    project_id=project.id,
                    assets=all_assets,
                    asset_id=str(asset_id),
                ):
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": SHOT_FRAME_DEPENDENCIES_MISSING_CODE,
                            "message": SHOT_FRAME_DEPENDENCIES_MISSING_MESSAGE,
                            "shot_id": shot_id,
                        },
                    )
        else:
            explicit_asset_id = continuity.get(
                "explicit_user_first_frame_asset_id"
            )
            if explicit_asset_id and not _project_asset_reference_is_available(
                workbench=workbench,
                project_id=project.id,
                assets=all_assets,
                asset_id=str(explicit_asset_id),
            ):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "first_frame_unavailable",
                        "message": "The explicitly selected first frame is unavailable",
                        "shot_id": shot_id,
                    },
                )
        requires_previous = requirements.requires_previous_tail
        dependency: dict[str, Any] = {"required": requires_previous}
        depends_on: list[str] = []
        if previous is not None:
            previous_id = str(previous["id"])
            previous_version = int(previous.get("version") or 1)
            dependency.update(
                {
                    "previous_shot_id": previous_id,
                    "previous_shot_version": previous_version,
                }
            )
            if previous_id in selected_ids:
                dependency["source"] = "batch"
                depends_on = [item_keys[previous_id]]
            else:
                tail_ready = dependency_tail_asset(
                    workbench, project.id, previous, previous_version
                )
                video_ready = previous_video_is_available(
                    workbench, project.id, previous, previous_version
                )
                dependency["source"] = (
                    "existing_tail"
                    if tail_ready is not None
                    else "existing_video"
                    if video_ready
                    else "missing"
                )
                if not video_ready or (requires_previous and tail_ready is None):
                    external_missing_keys.add(item_keys[shot_id])
        normalized_shot = deepcopy(shot)
        normalized_shot["continuity"] = continuity
        generation_unit = units_by_shot.get(shot_id)
        if generation_unit is None:
            raise HTTPException(
                status_code=409, detail={"code": "generation_plan_stale"}
            )
        normalized_shot["requested_duration_seconds"] = (
            generation_unit.requested_duration_seconds
        )
        referenced_ids = {
            str(asset_id) for asset_id in shot.get("asset_ids", []) if asset_id
        }
        for frame_name in ("first_frame", "last_frame"):
            frame = continuity.get(frame_name)
            if isinstance(frame, dict) and frame.get("asset_id"):
                referenced_ids.add(str(frame["asset_id"]))
        referenced_assets = [
            deepcopy(all_assets[asset_id])
            for asset_id in sorted(referenced_ids)
            if asset_id in all_assets
        ]
        character_ids = {
            str(character_id)
            for character_id in shot.get("characters", [])
            if character_id
        }
        task_series_bible = {
            key: deepcopy(value)
            for key, value in series_bible.items()
            if key not in {"assets", "characters"}
        }
        task_series_bible["assets"] = referenced_assets
        task_series_bible["characters"] = [
            deepcopy(all_characters[character_id])
            for character_id in sorted(character_ids)
            if character_id in all_characters
        ]
        references = [
            {
                "asset_id": asset_id,
                "version": int(all_assets[asset_id].get("version") or 1),
                "source_type": all_assets[asset_id].get("source_type"),
            }
            for asset_id in sorted(referenced_ids)
            if asset_id in all_assets
        ][:50]
        items.append(
            TaskItemSubmit(
                idempotency_key=item_keys[shot_id],
                task_type=SHOT_VIDEO_TASK_TYPE,
                input={
                    "shot": normalized_shot,
                    "shot_version": shot_version,
                    "prompt": str(shot.get("prompt") or ""),
                    "video_model": video_model,
                    "aspect_ratio": aspect_ratio,
                    "series_bible": task_series_bible,
                    "dependency": dependency,
                    "generation_mode": (
                        "regenerate" if requirements.regeneration else "initial"
                    ),
                    "generation_unit": generation_unit.model_dump(mode="json"),
                    "explicit_first_frame_asset_id": continuity.get(
                        "explicit_user_first_frame_asset_id"
                    ),
                    "inherited_first_frame_asset_id": continuity.get(
                        "inherited_first_frame_asset_id"
                    ),
                },
                references=references,
                model=video_model,
                target_entity_type="shot_video",
                target_entity_id=shot_id,
                target_entity_version=shot_version,
                depends_on=depends_on,
                # Reserve the hard-limit attempt for an explicit item retry
                # after automatic provider recovery has been exhausted.
                max_attempts=9,
                settlement_key=generation_key[:32],
                generation_key=generation_key,
                generation_revision=generation_revision,
            )
        )
    return (
        TaskSubmitRequest(
            idempotency_key=payload.idempotency_key,
            task_type="storyboard_video.generate",
            project_version=1,
            snapshot={
                "purpose": "storyboard_video_generation",
                "scope": render_scope,
                "selected_shot_ids": [str(shot["id"]) for shot in selected],
                "video_model": video_model,
                "generation_plan_id": generation_plan.id,
                "duration_strategy": generation_plan.confirmed_strategy,
                "generation_units": [
                    unit.model_dump(mode="json")
                    for unit in generation_plan.generation_units
                ],
            },
            items=items,
        ),
        external_missing_keys,
    )


def _project_asset_reference_is_available(
    *,
    workbench: WorkbenchStore,
    project_id: str,
    assets: dict[str, dict[str, Any]],
    asset_id: str,
) -> bool:
    asset = assets.get(asset_id)
    references = asset.get("reference_images") if isinstance(asset, dict) else None
    if (
        not isinstance(asset, dict)
        or asset.get("status") in {"missing", "stale", "deleted"}
        or not isinstance(references, list)
        or not references
    ):
        return False
    try:
        path = safe_project_media_file(
            workbench.project_dir(project_id), str(references[0])
        )
    except (HTTPException, ValueError):
        return False
    return path.is_file()


def _require_generation_frame_dependencies(
    *,
    workbench: WorkbenchStore,
    project_id: str,
    storyboard: dict[str, Any],
    series_bible: dict[str, Any],
    shot_ids: list[str],
    allow_external_waiting: bool = False,
) -> None:
    ordered_shots = sorted(
        [
            shot
            for shot in storyboard.get("shots", [])
            if isinstance(shot, dict) and shot.get("id")
        ],
        key=lambda shot: (int(shot.get("index") or 0), str(shot.get("id"))),
    )
    requested_ids = set(shot_ids)
    selected = [
        shot for shot in ordered_shots if str(shot["id"]) in requested_ids
    ]
    selected_ids = {str(shot["id"]) for shot in selected}
    position_by_id = {
        str(shot["id"]): position for position, shot in enumerate(ordered_shots)
    }
    all_assets = {
        str(asset.get("id")): asset
        for asset in series_bible.get("assets", [])
        if isinstance(asset, dict) and asset.get("id")
    }

    for shot in selected:
        shot_id = str(shot["id"])
        position = position_by_id[shot_id]
        previous = ordered_shots[position - 1] if position > 0 else None
        if (
            previous is not None
            and shot.get("episode_number") is not None
            and previous.get("episode_number") != shot.get("episode_number")
        ):
            previous = None
        requirements = resolve_shot_generation_frame_requirements(shot, previous)

        if requirements.regeneration:
            if not requirements.regeneration_frames_ready:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": SHOT_FRAME_DEPENDENCIES_MISSING_CODE,
                        "message": SHOT_FRAME_DEPENDENCIES_MISSING_MESSAGE,
                        "shot_id": shot_id,
                    },
                )
            for frame_name in ("first_frame", "last_frame"):
                frame = requirements.continuity.get(frame_name)
                asset_id = frame.get("asset_id") if isinstance(frame, dict) else None
                if not asset_id or not _project_asset_reference_is_available(
                    workbench=workbench,
                    project_id=project_id,
                    assets=all_assets,
                    asset_id=str(asset_id),
                ):
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": SHOT_FRAME_DEPENDENCIES_MISSING_CODE,
                            "message": SHOT_FRAME_DEPENDENCIES_MISSING_MESSAGE,
                            "shot_id": shot_id,
                        },
                    )
            continue

        explicit_asset_id = requirements.continuity.get(
            "explicit_user_first_frame_asset_id"
        )
        if explicit_asset_id and not _project_asset_reference_is_available(
            workbench=workbench,
            project_id=project_id,
            assets=all_assets,
            asset_id=str(explicit_asset_id),
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "first_frame_unavailable",
                    "message": "The explicitly selected first frame is unavailable",
                    "shot_id": shot_id,
                },
            )

        if previous is None:
            continue
        previous_id = str(previous["id"])
        if previous_id in selected_ids:
            continue
        previous_version = int(previous.get("version") or 1)
        has_tail = dependency_tail_asset(
            workbench, project_id, previous, previous_version
        )
        has_video = previous_video_is_available(
            workbench, project_id, previous, previous_version
        )
        dependency_ready = has_video and (
            not requirements.requires_previous_tail or has_tail is not None
        )
        if not dependency_ready and not allow_external_waiting:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": PREVIOUS_SHOT_MISSING_CODE,
                    "message": PREVIOUS_SHOT_MISSING_MESSAGE,
                    "previous_shot_id": previous_id,
                },
            )


def _shot_video_item_key(shot: dict[str, Any]) -> str:
    identity = f"{shot.get('id')}:{int(shot.get('version') or 1)}"
    return f"shot-video:{hashlib.sha256(identity.encode('utf-8')).hexdigest()}"


def _shot_generation_key(
    *,
    owner_user_id: str,
    project_id: str,
    shot_id: str,
    shot_version: int,
    generation_revision: int,
    model: str,
) -> str:
    payload = {
        "owner_user_id": owner_user_id,
        "project_id": project_id,
        "target_entity_type": "shot_video",
        "target_entity_id": shot_id,
        "target_entity_version": shot_version,
        "generation_revision": generation_revision,
        "model": model,
        "operation": f"shot:{shot_id}",
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _task_conflict_detail(exc: TaskConflict) -> dict[str, Any]:
    return {"code": exc.code, "message": exc.message, **exc.details}


def _require_video_reconciliation(db: Session, settings: AppSettings) -> None:
    try:
        require_billing_worker_healthy(db, settings)
    except BillingReconciliationUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "billing_reconciliation_unavailable",
                "message": "Video generation is unavailable until billing reconciliation recovers",
            },
        ) from exc


def _storyboard_for_render(
    storyboard: dict[str, Any],
    render_scope: dict[str, Any],
    selected_shot_ids: list[str] | None,
) -> tuple[dict[str, Any], list[str]]:
    scoped_storyboard = _storyboard_for_scope(storyboard, render_scope)
    scoped_shots = [
        shot
        for shot in scoped_storyboard.get("shots", [])
        if isinstance(shot, dict) and shot.get("id")
    ]
    available_ids = [str(shot["id"]) for shot in scoped_shots]
    if selected_shot_ids is None:
        return scoped_storyboard, available_ids

    requested_ids = [str(shot_id) for shot_id in selected_shot_ids]
    if not requested_ids:
        raise HTTPException(
            status_code=422,
            detail={"code": "selected_shots_required"},
        )
    if len(set(requested_ids)) != len(requested_ids):
        raise HTTPException(
            status_code=422,
            detail={"code": "selected_shots_must_be_unique"},
        )
    available_set = set(available_ids)
    outside_scope = [
        shot_id for shot_id in requested_ids if shot_id not in available_set
    ]
    if outside_scope:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "selected_shots_outside_render_scope",
                "shot_ids": outside_scope,
            },
        )
    selected_set = set(requested_ids)
    selected_shots = [
        shot for shot in scoped_shots if str(shot["id"]) in selected_set
    ]
    return {**scoped_storyboard, "shots": selected_shots}, [
        str(shot["id"]) for shot in selected_shots
    ]


def _render_output_for_scope(
    render_report: dict[str, Any] | None,
    render_scope: dict[str, Any],
    *,
    accept_legacy_output: bool = True,
) -> dict[str, Any] | None:
    outputs = [
        output
        for output in (render_report or {}).get("outputs", [])
        if isinstance(output, dict)
    ]
    if render_scope["kind"] == "single_video":
        return outputs[0] if outputs else None
    matching = next(
        (
            output
            for output in outputs
            if output.get("episode_number") == render_scope["episode_number"]
        ),
        None,
    )
    if matching is not None:
        return matching
    if (
        accept_legacy_output
        and outputs
        and not any(output.get("episode_number") is not None for output in outputs)
    ):
        return outputs[0]
    return None


def _report_for_scope(
    render_report: dict[str, Any] | None,
    render_scope: dict[str, Any],
    *,
    accept_legacy_output: bool = True,
) -> dict[str, Any] | None:
    output = _render_output_for_scope(
        render_report,
        render_scope,
        accept_legacy_output=accept_legacy_output,
    )
    if output is None:
        return None
    return {**(render_report or {}), "outputs": [output]}


def _merge_episode_render_report(
    existing_report: dict[str, Any] | None,
    rendered_report: dict[str, Any],
    render_scope: dict[str, Any],
    shot_ids: list[str],
) -> dict[str, Any]:
    if render_scope["kind"] == "single_video":
        return {
            **rendered_report,
            "outputs": [
                {**output, "shot_ids": shot_ids}
                for output in rendered_report.get("outputs", [])
                if isinstance(output, dict)
            ],
        }
    episode_number = render_scope["episode_number"]
    episode_title = render_scope["episode_title"]
    rendered_outputs = [
        {
            **output,
            "episode_number": episode_number,
            "episode_title": episode_title,
            "shot_ids": shot_ids,
        }
        for output in rendered_report.get("outputs", [])
        if isinstance(output, dict)
    ]
    preserved_outputs = [
        output
        for output in (existing_report or {}).get("outputs", [])
        if isinstance(output, dict)
        and output.get("episode_number") is not None
        and output.get("episode_number") != episode_number
    ]
    outputs = sorted(
        [*preserved_outputs, *rendered_outputs],
        key=lambda output: int(output.get("episode_number") or 0),
    )
    return {**rendered_report, "outputs": outputs}


def _merge_rendered_storyboard(
    current_storyboard: dict[str, Any],
    rendered_storyboard: dict[str, Any],
) -> dict[str, Any]:
    rendered_shots = {
        str(shot.get("id")): shot
        for shot in rendered_storyboard.get("shots", [])
        if isinstance(shot, dict) and shot.get("id")
    }
    return {
        **current_storyboard,
        "shots": [
            rendered_shots.get(str(shot.get("id")), shot)
            if isinstance(shot, dict)
            else shot
            for shot in current_storyboard.get("shots", [])
        ],
    }


def _production_output_spec(
    workflow: dict[str, Any],
    storyboard: dict[str, Any],
    render_report: dict[str, Any] | None,
    *,
    authoritative_duration_seconds: float | None = None,
) -> dict[str, Any]:
    brief = workflow.get("brief") if isinstance(workflow.get("brief"), dict) else {}
    aspect_ratio = str(brief.get("aspect_ratio") or "9:16")
    resolutions = {
        "16:9": "1920x1080",
        "9:16": "1080x1920",
        "1:1": "1080x1080",
        "4:3": "1440x1080",
        "3:4": "1080x1440",
    }
    try:
        target_duration_seconds = float(brief.get("duration_seconds"))
    except (TypeError, ValueError):
        target_duration_seconds = 0
    native_duration_seconds = 0.0
    for shot in storyboard.get("shots", []):
        if not isinstance(shot, dict):
            continue
        for field in (
            "timeline_duration_seconds",
            "source_duration_seconds",
            "requested_duration_seconds",
        ):
            try:
                value = float(shot.get(field))
            except (TypeError, ValueError):
                continue
            if value > 0:
                native_duration_seconds += value
                break
    output = (render_report or {}).get("outputs", [])
    first_output = output[0] if output and isinstance(output[0], dict) else {}
    effective_duration_seconds = round(float(
        first_output.get("duration_seconds")
        or authoritative_duration_seconds
        or native_duration_seconds
        or target_duration_seconds
        or 0
    ), 3)
    return {
        "format": str(first_output.get("format") or "mp4"),
        "resolution": str(first_output.get("resolution") or resolutions.get(aspect_ratio, "1080x1920")),
        "aspect_ratio": aspect_ratio,
        "duration_seconds": effective_duration_seconds,
        "target_duration_seconds": (
            target_duration_seconds if target_duration_seconds > 0 else None
        ),
        "duration_difference_seconds": (
            round(effective_duration_seconds - target_duration_seconds, 3)
            if target_duration_seconds > 0
            and effective_duration_seconds > 0
            else None
        ),
        "render_runtime": "ffmpeg",
    }


def _render_plan_output_spec(
    workflow: dict[str, Any],
    storyboard: dict[str, Any],
    render_report: dict[str, Any] | None,
) -> dict[str, Any]:
    # A previous render describes what was produced, not what the approved brief
    # asks the next render to produce. Otherwise a stale portrait report can pin
    # every later render to 9:16 even after the authoritative brief is 16:9.
    production = _production_output_spec(workflow, storyboard, None)
    match = re.fullmatch(r"(\d+)x(\d+)", str(production["resolution"]))
    if match is None:
        width, height = 1080, 1920
    else:
        width, height = int(match.group(1)), int(match.group(2))
    outputs = (render_report or {}).get("outputs") or []
    first_output = outputs[0] if outputs and isinstance(outputs[0], dict) else {}
    return {
        "width": width,
        "height": height,
        "fps": float(first_output.get("fps") or 30),
        "format": "mp4",
        "video_codec": "h264",
        "audio_codec": "aac",
    }


def _usable_shot_media(
    *,
    workbench: WorkbenchStore,
    project_id: str,
    shot: dict[str, Any],
    aspect_ratio: str,
) -> str | None:
    relative = sanitize_project_path(
        workbench.project_dir(project_id), shot.get("output_path")
    )
    if (
        shot.get("status") == "stale"
        or relative is None
        or not (workbench.project_dir(project_id) / relative).is_file()
        or not media_matches_aspect_ratio(
            workbench.project_dir(project_id) / relative,
            shot.get("aspect_ratio") or aspect_ratio,
        )
    ):
        return None
    return relative


def _generation_unit_coverage_keys(
    record: VideoGenerationUnit,
    shot_id: str,
) -> set[str]:
    prompt_segment_ids = {
        str(segment["id"])
        for segment in record.prompt_segments_json
        if isinstance(segment, dict)
        and str(segment.get("source_shot_id") or "") == shot_id
        and segment.get("id")
    }
    if prompt_segment_ids:
        return {f"segment:{segment_id}" for segment_id in prompt_segment_ids}
    source_shot_ids = [str(value) for value in record.source_shot_ids_json]
    if len(source_shot_ids) == 1 and record.source_segment_ids_json:
        return {
            f"segment:{segment_id}"
            for value in record.source_segment_ids_json
            if (segment_id := str(value))
        }
    return {f"unit:{record.id}"}


def _generation_unit_render_state(
    *,
    workbench: WorkbenchStore,
    project_id: str,
    db: Session,
    scoped_storyboard: dict[str, Any],
    project_aspect_ratio: str,
) -> dict[str, Any] | None:
    records = list(
        db.scalars(
            select(VideoGenerationUnit)
            .where(
                VideoGenerationUnit.project_id == project_id,
                VideoGenerationUnit.legacy_source_shot_id.is_(None),
            )
            .order_by(
                VideoGenerationUnit.created_at,
                VideoGenerationUnit.id,
                VideoGenerationUnit.revision,
            )
        )
    )
    if not records:
        return None
    shots = sorted(
        (
            shot
            for shot in scoped_storyboard.get("shots", [])
            if isinstance(shot, dict) and shot.get("id")
        ),
        key=lambda shot: int(shot.get("index", 0)),
    )
    selected_ids = [str(shot["id"]) for shot in shots]
    selected = set(selected_ids)
    positions = {shot_id: index for index, shot_id in enumerate(selected_ids)}
    shot_versions = {
        str(shot["id"]): int(shot.get("version") or 1) for shot in shots
    }
    all_relevant = [
        record
        for record in records
        if record.status != "stale"
        and selected.intersection(str(value) for value in record.source_shot_ids_json)
    ]
    relevant = [
        record
        for record in all_relevant
        if all(
            int(record.source_shot_versions_json.get(str(shot_id)) or 0)
            == shot_versions.get(str(shot_id))
            for shot_id in record.source_shot_ids_json
        )
    ]
    outdated_by_shot: dict[str, list[VideoGenerationUnit]] = {
        shot_id: [] for shot_id in selected_ids
    }
    for record in all_relevant:
        source_ids = {str(value) for value in record.source_shot_ids_json}
        if (
            record in relevant
            or not source_ids.issubset(selected)
            or not record.active
            or record.status != "complete"
        ):
            continue
        for shot_id in selected.intersection(
            str(value) for value in record.source_shot_ids_json
        ):
            outdated_by_shot[shot_id].append(record)
    blockers: list[dict[str, Any]] = []
    for record in all_relevant:
        source_ids = [str(value) for value in record.source_shot_ids_json]
        if not set(source_ids).issubset(selected):
            blockers.append(
                {
                    "code": "generation_unit_selection_partial",
                    "message": "Render selection splits an existing generation unit.",
                    "generation_unit_id": record.id,
                    "shot_id": next(
                        (shot_id for shot_id in source_ids if shot_id in selected),
                        None,
                    ),
                    "task_id": None,
                    "task_item_id": record.task_item_id,
                    "task_status": record.status,
                    "retryable": False,
                }
            )

    active = [
        record
        for record in relevant
        if record.active and record.status == "complete"
    ]
    active.sort(
        key=lambda record: positions.get(
            str(record.source_shot_ids_json[0]), 10**9
        )
    )
    expected_keys: dict[str, set[str]] = {shot_id: set() for shot_id in selected_ids}
    for record in relevant:
        for shot_id in selected.intersection(
            str(value) for value in record.source_shot_ids_json
        ):
            expected_keys[shot_id].update(
                _generation_unit_coverage_keys(record, shot_id)
            )

    covered: dict[str, VideoGenerationUnit] = {}
    covered_keys: dict[str, set[str]] = {shot_id: set() for shot_id in selected_ids}
    covered_segments: dict[str, VideoGenerationUnit] = {}
    legacy_covered_shots: dict[str, VideoGenerationUnit] = {}
    usable: list[VideoGenerationUnit] = []
    project_dir = workbench.project_dir(project_id)
    for record in active:
        source_ids = [str(value) for value in record.source_shot_ids_json]
        source_segment_ids = [
            str(value) for value in record.source_segment_ids_json if str(value)
        ]
        overlap_segments = [
            segment_id
            for segment_id in source_segment_ids
            if segment_id in covered_segments
        ]
        overlap_shots = [
            shot_id
            for shot_id in source_ids
            if (
                shot_id in legacy_covered_shots
                or (not source_segment_ids and shot_id in covered)
            )
        ]
        if overlap_segments or overlap_shots:
            blockers.append(
                {
                    "code": "generation_unit_mapping_conflict",
                    "message": (
                        "Active generation units overlap generation segments."
                        if overlap_segments
                        else "Legacy active generation units overlap storyboard shots."
                    ),
                    "generation_unit_id": record.id,
                    "shot_id": overlap_shots[0] if overlap_shots else (
                        source_ids[0] if source_ids else None
                    ),
                    "task_id": None,
                    "task_item_id": record.task_item_id,
                    "task_status": record.status,
                    "retryable": False,
                }
            )
            continue
        relative = sanitize_project_path(project_dir, record.output_path)
        if (
            relative is None
            or not (project_dir / relative).is_file()
            or not media_matches_aspect_ratio(
                project_dir / relative,
                project_aspect_ratio,
            )
        ):
            blockers.append(
                {
                    "code": "generation_unit_media_missing",
                    "message": "An active generation unit has no usable video media.",
                    "generation_unit_id": record.id,
                    "shot_id": source_ids[0] if source_ids else None,
                    "task_id": None,
                    "task_item_id": record.task_item_id,
                    "task_status": record.status,
                    "retryable": False,
                }
            )
            continue
        usable.append(record)
        for segment_id in source_segment_ids:
            covered_segments[segment_id] = record
        for shot_id in source_ids:
            covered[shot_id] = record
            covered_keys.setdefault(shot_id, set()).update(
                _generation_unit_coverage_keys(record, shot_id)
            )
            if not source_segment_ids:
                legacy_covered_shots[shot_id] = record

    latest = _latest_task_items_by_target(
        db,
        owner_user_id=str(
            db.scalar(
                select(ProjectRecord.owner_user_id).where(ProjectRecord.id == project_id)
            )
            or ""
        ),
        project_id=project_id,
    )
    fully_covered_shot_ids: list[str] = []
    for shot_id in selected_ids:
        shot_expected_keys = expected_keys.get(shot_id, set())
        shot_covered_keys = covered_keys.get(shot_id, set())
        if (
            shot_expected_keys
            and shot_expected_keys.issubset(shot_covered_keys)
        ) or (not shot_expected_keys and shot_id in covered):
            fully_covered_shot_ids.append(shot_id)
            continue
        outdated = outdated_by_shot.get(shot_id, [])
        if outdated and not shot_expected_keys:
            candidate = outdated[-1]
            blockers.append(
                {
                    "code": "generation_unit_outdated",
                    "message": (
                        "The available video was generated from an older storyboard "
                        "revision and must be regenerated."
                    ),
                    "generation_unit_id": candidate.id,
                    "shot_id": shot_id,
                    "task_id": None,
                    "task_item_id": candidate.task_item_id,
                    "task_status": candidate.status,
                    "retryable": False,
                }
            )
            continue
        missing_keys = shot_expected_keys - shot_covered_keys
        candidate = next(
            (
                record
                for record in reversed(relevant)
                if shot_id in {str(value) for value in record.source_shot_ids_json}
                and (
                    not missing_keys
                    or missing_keys.intersection(
                        _generation_unit_coverage_keys(record, shot_id)
                    )
                )
            ),
            None,
        )
        task = (
            latest.get(("generation_unit", candidate.id, None))
            if candidate is not None
            else None
        )
        batch, item = task if task is not None else (None, None)
        blockers.append(
            {
                "code": "generation_unit_pending" if candidate else "generation_unit_missing",
                "message": "A generation unit covering this shot is not complete.",
                "generation_unit_id": candidate.id if candidate else None,
                "shot_id": shot_id,
                "task_id": batch.id if batch is not None else None,
                "task_item_id": item.id if item is not None else None,
                "task_status": item.status if item is not None else (
                    candidate.status if candidate is not None else None
                ),
                "retryable": bool(item is not None and item.retryable),
            }
        )
    return {
        "active_units": usable,
        "blockers": blockers,
        "covered_shot_ids": fully_covered_shot_ids,
    }


def _generation_unit_asset_manifest(
    manifest: dict[str, Any],
    units: list[VideoGenerationUnit],
) -> dict[str, Any]:
    merged = deepcopy(manifest)
    assets = [
        deepcopy(asset)
        for asset in merged.get("assets", [])
        if isinstance(asset, dict)
    ]
    active_keys = {(unit.id, unit.revision) for unit in units}
    for asset in assets:
        metadata = asset.get("metadata")
        if isinstance(metadata, dict) and metadata.get("generation_unit_id"):
            key = (
                str(metadata.get("generation_unit_id")),
                int(metadata.get("revision") or 0),
            )
            metadata["active"] = key in active_keys
    by_id = {
        str(asset.get("id")): index
        for index, asset in enumerate(assets)
        if asset.get("id")
    }
    for unit in units:
        asset = {
            "id": unit.output_asset_id,
            "type": "video",
            "path": unit.output_path,
            "source_tool": unit.provider,
            "scene_id": unit.id,
            "prompt": "\n".join(
                str(segment.get("prompt") or "")
                for segment in unit.prompt_segments_json
                if isinstance(segment, dict)
            ),
            "model": unit.model_id,
            "cost_usd": 0,
            "requested_duration_seconds": unit.requested_duration_seconds,
            "source_duration_seconds": unit.source_duration_seconds,
            "duration_seconds": unit.source_duration_seconds,
            "format": "mp4",
            "provider": unit.provider,
            "generation_summary": "Generated as one authoritative video generation unit.",
            "metadata": {
                "generation_unit_id": unit.id,
                "source_shot_ids": list(unit.source_shot_ids_json),
                "source_beat_ids": list(unit.source_beat_ids_json),
                "source_segment_ids": list(unit.source_segment_ids_json or []),
                "revision": unit.revision,
                "provider": unit.provider,
                "model": unit.model_id,
                "operation": f"generation_unit:{unit.id}:v{unit.revision}",
                "active": True,
                "status": "complete",
            },
        }
        asset_id = str(unit.output_asset_id or "")
        if not asset_id:
            continue
        if asset_id in by_id:
            assets[by_id[asset_id]] = asset
        else:
            by_id[asset_id] = len(assets)
            assets.append(asset)
    merged["version"] = "1.0"
    merged["assets"] = assets
    metadata = dict(merged.get("metadata") or {})
    metadata["generation_units_v2"] = True
    merged["metadata"] = metadata
    return merged


def _latest_task_items_by_target(
    db: Session,
    *,
    owner_user_id: str,
    project_id: str,
) -> dict[tuple[str, str, str | None], tuple[TaskBatch, TaskItem]]:
    rows = (
        db.query(TaskBatch, TaskItem)
        .join(TaskItem, TaskItem.batch_id == TaskBatch.id)
        .filter(
            TaskBatch.owner_user_id == owner_user_id,
            TaskBatch.project_id == project_id,
            TaskItem.target_entity_type.in_(
                ("shot_video", "shot_frame", "generation_unit")
            ),
        )
        .order_by(TaskItem.updated_at.desc(), TaskItem.id.desc())
        .all()
    )
    latest: dict[tuple[str, str, str | None], tuple[TaskBatch, TaskItem]] = {}
    for batch, item in rows:
        frame_target = (
            str(item.input_snapshot.get("frame_target"))
            if item.target_entity_type == "shot_frame"
            and item.input_snapshot.get("frame_target") in {"first", "last"}
            else None
        )
        key = (
            str(item.target_entity_type),
            str(item.target_entity_id),
            frame_target,
        )
        latest.setdefault(key, (batch, item))
    return latest


def _composition_blocker(
    *,
    code: str,
    message: str,
    shot_id: str | None = None,
    task: tuple[TaskBatch, TaskItem] | None = None,
) -> dict[str, Any]:
    batch, item = task if task is not None else (None, None)
    return {
        "code": code,
        "message": message,
        "shot_id": shot_id,
        "task_id": batch.id if batch is not None else None,
        "task_item_id": item.id if item is not None else None,
        "task_status": item.status if item is not None else None,
        "retryable": bool(item is not None and item.retryable),
    }


def _task_readiness_blocker(
    *,
    task: tuple[TaskBatch, TaskItem] | None,
    shot_id: str,
    frame_target: str | None = None,
) -> dict[str, Any]:
    label = "首帧" if frame_target == "first" else "尾帧" if frame_target == "last" else "镜头"
    if task is None:
        code = "control_frame_missing" if frame_target else "shot_media_missing"
        return _composition_blocker(
            code=code,
            message=f"镜头 {shot_id} 的{label}尚未生成。",
            shot_id=shot_id,
        )
    _, item = task
    if item.status == "awaiting_payment":
        return _composition_blocker(
            code="awaiting_payment",
            message=f"镜头 {shot_id} 的{label}正在等待支付确认。",
            shot_id=shot_id,
            task=task,
        )
    if item.status == "waiting_dependency":
        return _composition_blocker(
            code="waiting_dependency",
            message=(item.error_message or f"镜头 {shot_id} 的{label}仍被依赖阻塞。"),
            shot_id=shot_id,
            task=task,
        )
    if item.status in {"failed", "cancelled"}:
        return _composition_blocker(
            code="control_frame_failed" if frame_target else "shot_generation_failed",
            message=(item.error_message or f"镜头 {shot_id} 的{label}生成失败。"),
            shot_id=shot_id,
            task=task,
        )
    return _composition_blocker(
        code="control_frame_pending" if frame_target else "shot_generation_pending",
        message=f"镜头 {shot_id} 的{label}仍在{('排队' if item.status == 'queued' else '生成')}。",
        shot_id=shot_id,
        task=task,
    )


def _composition_readiness(
    *,
    workbench: WorkbenchStore,
    project: ProjectRecord,
    db: Session,
    scoped_storyboard: dict[str, Any],
    selected_shot_ids: list[str],
    creative_workflow: dict[str, Any],
    project_aspect_ratio: str,
) -> dict[str, Any]:
    shots = [
        shot
        for shot in scoped_storyboard.get("shots", [])
        if isinstance(shot, dict) and shot.get("id")
    ]
    selected = set(selected_shot_ids)
    unit_state = _generation_unit_render_state(
        workbench=workbench,
        project_id=project.id,
        db=db,
        scoped_storyboard=scoped_storyboard,
        project_aspect_ratio=project_aspect_ratio,
    )
    if unit_state is not None:
        active_units = unit_state["active_units"]
        return {
            "ready": bool(selected_shot_ids) and not unit_state["blockers"],
            "selected_shot_ids": selected_shot_ids,
            "reusable_shot_ids": unit_state["covered_shot_ids"],
            "reusable_generation_unit_ids": [unit.id for unit in active_units],
            "blockers": unit_state["blockers"],
        }
    latest = _latest_task_items_by_target(
        db,
        owner_user_id=project.owner_user_id,
        project_id=project.id,
    )
    blockers: list[dict[str, Any]] = []
    reusable_shot_ids: list[str] = []
    for shot in shots:
        shot_id = str(shot["id"])
        if shot_id not in selected:
            continue
        if _usable_shot_media(
            workbench=workbench,
            project_id=project.id,
            shot=shot,
            aspect_ratio=project_aspect_ratio,
        ) is not None:
            reusable_shot_ids.append(shot_id)
            continue
        blockers.append(
            _task_readiness_blocker(
                task=latest.get(("shot_video", shot_id, None)),
                shot_id=shot_id,
            )
        )

    if creative_workflow.get("control_end_frames") is True and shots:
        controlled = ((shots[0], "first"), (shots[-1], "last"))
        seen: set[tuple[str, str]] = set()
        for shot, frame_target in controlled:
            shot_id = str(shot["id"])
            key = (shot_id, frame_target)
            if key in seen or shot_id not in selected:
                continue
            seen.add(key)
            continuity = resolve_continuity(shot)
            frame = continuity.get(f"{frame_target}_frame")
            if (
                isinstance(frame, dict)
                and frame.get("asset_id")
                and frame.get("status") == "ready"
            ):
                continue
            blockers.append(
                _task_readiness_blocker(
                    task=latest.get(("shot_frame", shot_id, frame_target)),
                    shot_id=shot_id,
                    frame_target=frame_target,
                )
            )

    return {
        "ready": bool(selected_shot_ids) and not blockers,
        "selected_shot_ids": selected_shot_ids,
        "reusable_shot_ids": reusable_shot_ids,
        "blockers": blockers,
    }


def _production_snapshot(
    workbench: WorkbenchStore,
    project: ProjectRecord,
    db: Session,
    selected_shot_ids: list[str] | None = None,
    *,
    describe_next_render: bool = False,
) -> dict[str, Any]:
    storyboard, workflow = _creative_workflow_state(workbench, project.id)
    series_bible = workbench.read_artifact(project.id, "series_bible.json") or {}
    continuity = workbench.read_artifact(project.id, "continuity_plan.json") or {}
    render_report = workbench.read_artifact(project.id, "render_report.json")
    render_scope = _render_scope(project.project_type, continuity)
    scoped_storyboard, resolved_shot_ids = _storyboard_for_render(
        storyboard,
        render_scope,
        selected_shot_ids,
    )
    shots = [shot for shot in scoped_storyboard.get("shots", []) if isinstance(shot, dict)]
    project_aspect_ratio = _production_output_spec(
        workflow, scoped_storyboard, None
    )["aspect_ratio"]
    generation_unit_state = _generation_unit_render_state(
        workbench=workbench,
        project_id=project.id,
        db=db,
        scoped_storyboard=scoped_storyboard,
        project_aspect_ratio=project_aspect_ratio,
    )

    def reusable(shot: dict[str, Any]) -> bool:
        return _usable_shot_media(
            workbench=workbench,
            project_id=project.id,
            shot=shot,
            aspect_ratio=project_aspect_ratio,
        ) is not None

    reusable_count = sum(1 for shot in shots if reusable(shot))
    completed_count = sum(
        1 for shot in shots if shot.get("status") == "complete" and reusable(shot)
    )
    if generation_unit_state is not None:
        reusable_count = len(generation_unit_state["covered_shot_ids"])
        completed_count = reusable_count
    bound_assets = {
        str(asset_id)
        for shot in shots
        for asset_id in (shot.get("asset_ids") or [])
        if asset_id
    }
    continuity_bible = (
        continuity.get("series_bible")
        if isinstance(continuity.get("series_bible"), dict)
        else {}
    )
    latest_job = db.query(GenerationJob).filter(
        GenerationJob.user_id == project.owner_user_id,
        GenerationJob.project_id == project.id,
        GenerationJob.chargeable.is_(False),
        GenerationJob.operation == "render",
    ).order_by(GenerationJob.created_at.desc(), GenerationJob.id.desc()).first()
    active_job = None
    if latest_job is not None:
        children = db.query(GenerationJob).filter(
            GenerationJob.parent_job_id == latest_job.id,
            GenerationJob.user_id == project.owner_user_id,
            GenerationJob.project_id == project.id,
            GenerationJob.chargeable.is_(True),
        ).order_by(GenerationJob.created_at.desc(), GenerationJob.id.desc()).all()
        quoted = [
            child.quote_estimated_quota
            for child in children
            if child.quote_estimated_quota is not None
        ]
        recoverable_statuses = {
            "payment_required_quote",
            "reference_recovery_pending",
            "result_pending",
            "receipt_pending",
        }
        billing_child = next(
            (
                child for child in children
                if child.status in {"payment_required_quote", "payment_required"}
            ),
            None,
        )
        active_job = {
            "id": latest_job.id,
            "status": latest_job.status,
            "updated_at": latest_job.updated_at.isoformat(),
            "billing_job_id": billing_child.id if billing_child else None,
            "estimated_units": sum(quoted) if quoted else None,
            "resume_available": any(
                child.status in recoverable_statuses for child in children
            ) or (
                latest_job.status == "running"
                and bool(shots)
                and reusable_count == len(shots)
            ),
        }
    output_spec = _production_output_spec(
        workflow,
        scoped_storyboard,
        None if describe_next_render else _report_for_scope(
            render_report,
            render_scope,
            accept_legacy_output=not any(
                shot.get("episode_number") is not None for shot in shots
            ),
        ),
        authoritative_duration_seconds=(
            sum(
                float(unit.source_duration_seconds or 0)
                for unit in generation_unit_state["active_units"]
            )
            if generation_unit_state is not None
            else None
        ),
    )
    output_spec["render_runtime"] = read_workflow_settings(
        workbench, project.id
    )["render_runtime"]
    readiness = _composition_readiness(
        workbench=workbench,
        project=project,
        db=db,
        scoped_storyboard=scoped_storyboard,
        selected_shot_ids=resolved_shot_ids,
        creative_workflow=workflow,
        project_aspect_ratio=project_aspect_ratio,
    )
    latest_composition = (
        db.query(TaskBatch)
        .filter(
            TaskBatch.owner_user_id == project.owner_user_id,
            TaskBatch.project_id == project.id,
            TaskBatch.task_type == COMPOSITION_TASK_TYPE,
        )
        .order_by(TaskBatch.created_at.desc(), TaskBatch.id.desc())
        .first()
    )
    if latest_composition is not None:
        composition_item = latest_composition.items[0] if latest_composition.items else None
        active_job = {
            "id": latest_composition.id,
            "status": latest_composition.status,
            "updated_at": latest_composition.updated_at.isoformat(),
            "billing_job_id": None,
            "estimated_units": 0,
            "resume_available": False,
            "task_item_id": composition_item.id if composition_item is not None else None,
            "retryable": bool(composition_item is not None and composition_item.retryable),
        }
    return {
        "shot_summary": {
            "total": len(shots),
            "reusable": reusable_count,
            "to_generate": len(shots) - reusable_count,
            "completed": completed_count,
        },
        "output": output_spec,
        "continuity": {
            "characters": len(series_bible.get("characters", []) or []),
            "locations": len(continuity_bible.get("locations", []) or []),
            "props": len(continuity_bible.get("props", []) or []),
            "bound_assets": len(bound_assets),
        },
        "render_scope": render_scope,
        "selected_shot_ids": resolved_shot_ids,
        "active_job": active_job,
        "readiness": readiness,
    }


def _require_function_user(
    request: Request,
    db: Session = Depends(get_db, scope="function"),
    redis: Redis = Depends(get_redis),
    settings: AppSettings = Depends(get_settings),
) -> CurrentUser:
    return require_user(request=request, db=db, redis=redis, settings=settings)


def _require_owned_user(
    project_id: str,
    request: Request,
    current: CurrentUser = Depends(_require_function_user, scope="function"),
    db: Session = Depends(get_db, scope="function"),
) -> ProjectRecord:
    project = ProjectRepository(db).require_owned(project_id, current.id)
    _require_project_available(request, project_id)
    return project


def _require_owned_reader(
    project_id: str,
    request: Request,
    current: CurrentUser = Depends(require_user),
    db: Session = Depends(get_db),
) -> ProjectRecord:
    project = ProjectRepository(db).require_owned_for_read(project_id, current.id)
    _require_project_available(request, project_id)
    return project


def _require_owned_csrf(
    project_id: str,
    request: Request,
    current: CurrentUser = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> ProjectRecord:
    project = ProjectRepository(db).require_owned(project_id, current.id)
    _require_project_available(request, project_id)
    return project


def _lock_owned_project_after_parse(
    *,
    request: Request,
    db: Session,
    project_id: str,
    authorized_project: ProjectRecord,
) -> ProjectRecord:
    project = ProjectRepository(db).require_owned_for_update(
        project_id,
        authorized_project.owner_user_id,
    )
    _require_project_available(request, project_id)
    return project


def _require_project_available(request: Request, project_id: str) -> None:
    try:
        request.app.state.store.assert_project_available(project_id)
    except ProjectRecoveryRequired as exc:
        raise HTTPException(
            status_code=503,
            detail="Project is unavailable pending recovery",
        ) from exc


@contextmanager
def _project_mutation(
    *,
    db: Session,
    workbench: WorkbenchStore,
    project_id: str,
    operation: str,
    changed_paths: list[str],
    failure_detail: str,
    new_workspace: bool = False,
    preserve_http_error_writes: bool = False,
):
    try:
        journal = workbench.begin_project_mutation(
            project_id,
            operation=operation,
            changed_paths=changed_paths,
            new_workspace=new_workspace,
        )
    except Exception:
        _rollback_quietly(db)
        raise HTTPException(status_code=500, detail=failure_detail) from None

    try:
        yield
    except HTTPException:
        if preserve_http_error_writes:
            try:
                journal.complete()
            finally:
                _rollback_quietly(db)
        else:
            _restore_then_rollback(journal, db, failure_detail)
        raise
    except _BILLING_CONTROL_ERRORS:
        if preserve_http_error_writes:
            try:
                journal.complete()
            finally:
                _rollback_quietly(db)
        else:
            _restore_then_rollback(journal, db, failure_detail)
        raise
    except Exception:
        _restore_then_rollback(journal, db, failure_detail)
        raise HTTPException(status_code=500, detail=failure_detail) from None

    try:
        db.commit()
    except Exception:
        _restore_then_rollback(journal, db, failure_detail)
        raise HTTPException(status_code=500, detail=failure_detail) from None
    try:
        journal.complete()
    except Exception:
        raise HTTPException(status_code=500, detail=failure_detail) from None


def _rollback_quietly(db: Session) -> None:
    try:
        db.rollback()
    except Exception:
        pass


def _restore_then_rollback(journal, db: Session, failure_detail: str) -> None:
    try:
        journal.restore()
    except Exception:
        _rollback_quietly(db)
        raise HTTPException(status_code=500, detail=failure_detail) from None
    _rollback_quietly(db)


def _local_schema_ref_target(
    definitions: dict[str, Any],
    ref: str,
) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise ValueError(f"Unsupported local schema reference: {ref}")
    current: Any = {"$defs": definitions}
    for raw_token in ref[2:].split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        if not isinstance(current, dict) or token not in current:
            raise ValueError(f"Unknown local schema reference: {ref}")
        current = current[token]
    if not isinstance(current, dict):
        raise ValueError(f"Local schema reference is not an object: {ref}")
    return current


def _inline_local_schema_refs(schema: dict[str, Any]) -> dict[str, Any]:
    source = deepcopy(schema)
    definitions = source.pop("$defs", {})
    if not isinstance(definitions, dict):
        raise ValueError("Pydantic schema $defs must be an object")

    def inline(value: Any, active_refs: frozenset[str]) -> Any:
        if isinstance(value, list):
            return [inline(item, active_refs) for item in value]
        if not isinstance(value, dict):
            return value

        ref = value.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            if ref in active_refs:
                raise ValueError(f"Cyclic local schema reference: {ref}")
            target = _local_schema_ref_target(definitions, ref)
            resolved = inline(deepcopy(target), active_refs | {ref})
            siblings = {key: item for key, item in value.items() if key != "$ref"}
            if siblings:
                return {
                    "allOf": [
                        resolved,
                        inline(siblings, active_refs),
                    ]
                }
            return resolved

        return {key: inline(item, active_refs) for key, item in value.items()}

    return inline(source, frozenset())


def _json_request_openapi(model: type[BaseModel]) -> dict[str, Any]:
    schema = _inline_local_schema_refs(model.model_json_schema())
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": schema}},
        }
    }


def _upload_request_openapi() -> dict[str, Any]:
    return {
        "requestBody": {
            "required": True,
            "content": {
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "required": ["kind", "label", "file"],
                        "properties": {
                            "kind": {"type": "string"},
                            "label": {"type": "string"},
                            "description": {"type": "string", "default": ""},
                            "prompt": {"type": "string", "default": ""},
                            "file": {"type": "string", "format": "binary"},
                        },
                    }
                }
            },
        }
    }


def _form_text(
    form: FormData,
    field: str,
    *,
    default: str | None = None,
    max_length: int,
) -> str:
    value = form.get(field, default)
    if not isinstance(value, str):
        raise HTTPException(status_code=422, detail=f"{field} is required")
    if len(value.encode("utf-8")) > max_length:
        raise HTTPException(status_code=422, detail=f"{field} is too large")
    return value


@asynccontextmanager
async def _bounded_upload_form(request: Request) -> AsyncIterator[FormData]:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_bytes = int(content_length)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid Content-Length") from exc
        if declared_bytes > MAX_MULTIPART_REQUEST_BYTES:
            raise HTTPException(status_code=413, detail="Uploaded media is too large")

    upstream_receive = request.receive
    received_bytes = 0

    async def bounded_receive() -> dict[str, Any]:
        nonlocal received_bytes
        message = await upstream_receive()
        if message["type"] == "http.request":
            received_bytes += len(message.get("body", b""))
            if received_bytes > MAX_MULTIPART_REQUEST_BYTES:
                raise HTTPException(status_code=413, detail="Uploaded media is too large")
        return message

    bounded_request = Request(request.scope, receive=bounded_receive)
    try:
        async with bounded_request.form(
            max_files=MAX_MULTIPART_FILES,
            max_fields=MAX_MULTIPART_FIELDS,
            max_part_size=MAX_MULTIPART_FIELD_BYTES,
        ) as form:
            yield form
    except MultipartParseError as exc:
        raise HTTPException(status_code=400, detail="Malformed multipart body") from exc


class ShortDramaRequest(CredentialFreeRequest):
    title: str = Field(min_length=1)
    prompt: str = Field(min_length=1)
    project_type: ProjectType = "single_video"
    shot_count: int | None = Field(default=None, ge=1, le=60)
    text_model: str = DEFAULT_TEXT_MODEL
    image_model: str = DEFAULT_IMAGE_MODEL
    video_model: str = DEFAULT_VIDEO_MODEL
    billing_job_id: str | None = Field(default=None, min_length=32, max_length=32)


class StoryboardPlanRequest(CredentialFreeRequest):
    prompt: str = Field(min_length=1)
    project_type: ProjectType | None = None
    shot_count: int | None = Field(default=None, ge=1, le=60)
    text_model: str | None = Field(default=None, min_length=1, max_length=200)
    image_model: str = DEFAULT_IMAGE_MODEL
    video_model: str = DEFAULT_VIDEO_MODEL
    control_end_frames: bool | None = None
    billing_job_id: str | None = Field(default=None, min_length=32, max_length=32)


class RenderProjectRequest(CredentialFreeRequest):
    text_model: str = DEFAULT_TEXT_MODEL
    image_model: str = DEFAULT_IMAGE_MODEL
    video_model: str = DEFAULT_VIDEO_MODEL
    render_runtime: Literal["remotion", "hyperframes", "ffmpeg"] | None = None
    billing_job_id: str | None = Field(default=None, min_length=32, max_length=32)
    resume_existing: bool = False
    selected_shot_ids: list[str] | None = Field(default=None, max_length=1000)
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=128)


class GenerationModelsResponse(BaseModel):
    capability: Literal["text", "image", "video"]
    models: list[str]
    profiles: list[VideoModelProfile] = Field(default_factory=list)


class GenerationPlanPreviewRequest(CredentialFreeRequest):
    contract_version: int | None = Field(default=None, ge=1)
    video_model: str = Field(min_length=1, max_length=255)
    operation: Literal[
        "text_to_video",
        "image_to_video",
        "first_last_frame_to_video",
        "extend",
    ] | None = None
    shot_ids: list[str] = Field(min_length=1, max_length=100)
    regenerate_unit_ids: list[str] = Field(default_factory=list, max_length=100)
    confirmed_strategy: Literal[
        "accept_model_duration", "accept_longer_duration"
    ] | None = None
    text_model: str | None = Field(default=None, min_length=1, max_length=200)
    adaptation_billing_job_ids: dict[str, str] = Field(default_factory=dict)


def _require_generation_units_v2(
    *,
    db: Session,
    settings: AppSettings,
    client_contract_version: int | None,
) -> None:
    try:
        require_generation_units_release(
            db,
            enabled=settings.generation_units_v2,
            environment=settings.environment,
            client_contract_version=client_contract_version,
        )
    except GenerationUnitsReleaseGateError as exc:
        status_code = (
            404
            if exc.code == "generation_units_v2_disabled"
            else 409
            if exc.code == "generation_units_contract_incompatible"
            else 503
        )
        raise HTTPException(
            status_code=status_code,
            detail={"code": exc.code, **exc.details},
        ) from None


def _generation_plan_candidate_name(plan_id: str) -> str:
    return f"generation_plan-{plan_id[:24]}.json"


_adaptation_cache_locks_guard = threading.Lock()
_adaptation_cache_locks: dict[str, tuple[threading.Lock, int]] = {}


@contextmanager
def _adaptation_cache_lock(cache_key: str):
    with _adaptation_cache_locks_guard:
        lock, users = _adaptation_cache_locks.get(
            cache_key, (threading.Lock(), 0)
        )
        _adaptation_cache_locks[cache_key] = (lock, users + 1)
    lock.acquire()
    try:
        yield
    finally:
        lock.release()
        with _adaptation_cache_locks_guard:
            current_lock, current_users = _adaptation_cache_locks[cache_key]
            if current_users == 1:
                del _adaptation_cache_locks[cache_key]
            else:
                _adaptation_cache_locks[cache_key] = (
                    current_lock,
                    current_users - 1,
                )


def _generation_adaptation_cache_name(cache_key: str) -> str:
    digest = cache_key.removeprefix("video-adaptation-")
    if re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ValueError("video generation adaptation cache key is invalid")
    return f"video_adaptation-{digest[:32]}.json"


def _generation_adaptation_cache_loader(
    *,
    workbench: WorkbenchStore,
    project_id: str,
) -> Callable[[str], dict[str, Any] | None]:
    def load(cache_key: str) -> dict[str, Any] | None:
        artifact = workbench.read_artifact(
            project_id,
            _generation_adaptation_cache_name(cache_key),
        )
        if (
            not isinstance(artifact, dict)
            or artifact.get("cache_key") != cache_key
            or not isinstance(artifact.get("result"), dict)
        ):
            return None
        return dict(artifact["result"])

    return load


def _cached_generation_adaptation_planner(
    *,
    workbench: WorkbenchStore,
    project_id: str,
    text_model: str | None = None,
) -> Callable[[VideoGenerationAdaptationRequest], Any]:
    load = _generation_adaptation_cache_loader(
        workbench=workbench,
        project_id=project_id,
    )

    def save(cache_key: str, result: dict[str, Any]) -> None:
        workbench.write_artifact(
            project_id,
            _generation_adaptation_cache_name(cache_key),
            {"version": "1.0", "cache_key": cache_key, "result": result},
        )

    def resolve(request: VideoGenerationAdaptationRequest) -> Any:
        cached = load_cached_adaptation(
            request,
            load=load,
            save=save,
            text_model=text_model,
        )
        if cached is None:
            raise VideoGenerationAdaptationError(
                "video_generation_adaptation_cache_missing",
                "validated adaptation cache is unavailable",
            )
        return cached

    return resolve


def _preview_generation_adaptation_planner(
    *,
    workbench: WorkbenchStore,
    project_id: str,
    db: Session,
    newapi: NewApiClient,
    settings: AppSettings,
    owner_user_id: str,
    text_model: str,
    billing_job_ids: dict[str, str],
) -> Callable[[VideoGenerationAdaptationRequest], Any]:
    load = _generation_adaptation_cache_loader(
        workbench=workbench,
        project_id=project_id,
    )

    def save(cache_key: str, result: dict[str, Any]) -> None:
        workbench.write_artifact(
            project_id,
            _generation_adaptation_cache_name(cache_key),
            {"version": "1.0", "cache_key": cache_key, "result": result},
        )

    def resolve(request: VideoGenerationAdaptationRequest) -> Any:
        key = adaptation_cache_key(request, text_model=text_model)
        with _adaptation_cache_lock(key):
            return resolve_cached_adaptation(
                request,
                load=load,
                save=save,
                generate=lambda value: generate_video_generation_adaptation_billed(
                    db=db,
                    newapi=newapi,
                    settings=settings,
                    media_store=workbench,
                    user_id=owner_user_id,
                    project_id=project_id,
                    request=value,
                    text_model=text_model,
                    billing_job_id=billing_job_ids.get(key),
                ),
                text_model=text_model,
            )

    return resolve


def _write_generation_plan_candidate(
    *,
    workbench: WorkbenchStore,
    project_id: str,
    candidate: GenerationPlanCandidate,
) -> None:
    name = _generation_plan_candidate_name(candidate.generation_plan.id)
    existing = workbench.read_artifact(project_id, name)
    payload = candidate.model_dump(mode="json")
    if existing is not None:
        try:
            existing_candidate = GenerationPlanCandidate.model_validate(existing)
        except ValueError:
            existing_candidate = None
        if (
            existing_candidate is not None
            and existing_candidate.generation_plan.id == candidate.generation_plan.id
            and existing_candidate.generation_plan.model_dump(mode="json")
            == candidate.generation_plan.model_dump(mode="json")
        ):
            return
        # The plan ID is derived from authoritative inputs, while planner
        # diagnostics and adaptation output may evolve between previews.  A
        # stale candidate must not turn a valid re-preview into a permanent
        # 409; replace it with the current authoritative candidate instead.
    workbench.write_artifact(project_id, name, payload)


def _read_generation_plan_candidate(
    *,
    workbench: WorkbenchStore,
    project_id: str,
    plan_id: str,
) -> GenerationPlanCandidate:
    raw = workbench.read_artifact(
        project_id, _generation_plan_candidate_name(plan_id)
    )
    if raw is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "generation_plan_stale",
                "reason": "candidate_unavailable",
            },
        )
    try:
        candidate = GenerationPlanCandidate.model_validate(raw)
    except ValueError:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "generation_plan_stale",
                "reason": "candidate_invalid",
            },
        ) from None
    if candidate.generation_plan.id != plan_id:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "generation_plan_stale",
                "reason": "candidate_id_mismatch",
            },
        )
    return candidate


def _generation_unit_task_request(
    *,
    project_id: str,
    plan: GenerationPlan,
    storyboard: dict[str, Any],
    series_bible: dict[str, Any],
    project_aspect_ratio: str,
    generation_unit_ids: list[str],
    idempotency_key: str,
) -> TaskSubmitRequest:
    shots_by_id = {
        str(shot["id"]): shot
        for shot in storyboard.get("shots", [])
        if isinstance(shot, dict) and shot.get("id")
    }
    selected = [
        unit
        for unit in plan.generation_units
        if unit.id in set(generation_unit_ids) and unit.status == "planned"
    ]
    item_keys = {
        unit.id: f"unit:{unit.id}:v{unit.revision}" for unit in selected
    }
    plan_positions = {unit.id: index for index, unit in enumerate(plan.generation_units)}
    items: list[TaskItemSubmit] = []
    for unit in selected:
        position = plan_positions[unit.id]
        previous = plan.generation_units[position - 1] if position > 0 else None
        depends_on = (
            [item_keys[previous.id]]
            if previous is not None and previous.id in item_keys
            else []
        )
        source_shots = [deepcopy(shots_by_id[shot_id]) for shot_id in unit.source_shot_ids]
        prompt_contract = generation_unit_prompt_contract(
            unit,
            source_shots,
            series_bible=series_bible,
        )
        compiled_prompt = compile_generation_unit_prompt(
            unit,
            source_shots,
            series_bible=series_bible,
        )
        first_continuity = source_shots[0].get("continuity")
        inherits_previous_tail = bool(
            previous is not None
            and isinstance(first_continuity, dict)
            and first_continuity.get("mode") == "carry"
            and first_continuity.get("inherit_previous_tail")
            and not first_continuity.get("explicit_user_first_frame_asset_id")
        )
        key = generation_unit_execution_key(
            project_id,
            unit.id,
            unit.revision,
            model_id=unit.model_id,
            operation=unit.operation,
        )
        items.append(
            TaskItemSubmit(
                idempotency_key=item_keys[unit.id],
                task_type="generation_unit_video.generate",
                input={
                    "generation_plan_id": plan.id,
                    "generation_unit": unit.model_dump(mode="json"),
                    "source_shots": source_shots,
                    "source_shot_versions": {
                        shot_id: int(shots_by_id[shot_id].get("version") or 1)
                        for shot_id in unit.source_shot_ids
                    },
                    "source_segment_ids": list(unit.source_segment_ids),
                    "compiled_prompt": compiled_prompt,
                    "prompt_contract": prompt_contract,
                    "ledger_revision": unit.revision,
                    "profile_revision": unit.profile.profile_revision,
                    "requested_duration_seconds": unit.requested_duration_seconds,
                    "dependency": (
                        {
                            "previous_generation_unit_id": previous.id,
                            "previous_generation_unit_revision": previous.revision,
                            "inherit_previous_tail": inherits_previous_tail,
                        }
                        if previous is not None
                        else None
                    ),
                },
                model=unit.model_id,
                target_entity_type="generation_unit",
                target_entity_id=unit.id,
                target_entity_version=unit.revision,
                depends_on=depends_on,
                max_attempts=9,
                settlement_key=key[:32],
                generation_key=key,
                generation_revision=unit.revision,
            )
        )
    return TaskSubmitRequest(
        idempotency_key=idempotency_key,
        task_type="generation_unit_video.generate",
        project_version=1,
        snapshot={
            "purpose": "generation_unit_video_generation",
            "generation_plan_id": plan.id,
            "generation_unit_ids": generation_unit_ids,
            "storyboard_revision": plan.storyboard_revision,
            "protected_generation_unit_ids": plan.protected_generation_unit_ids,
            "profile_revisions": {
                unit.id: unit.profile.profile_revision
                for unit in plan.generation_units
            },
            "series_bible": deepcopy(series_bible),
            "project_aspect_ratio": project_aspect_ratio,
        },
        items=items,
    )


def _task_submission_mode(db: Session, project_id: str) -> str | None:
    task_types = set(
        db.scalars(
            select(TaskBatch.task_type).where(
                TaskBatch.project_id == project_id,
                TaskBatch.task_type.in_(
                    ("storyboard_video.generate", "generation_unit_video.generate")
                ),
            )
        )
    )
    if "generation_unit_video.generate" in task_types:
        return "v2"
    if "storyboard_video.generate" in task_types:
        return "v1"
    return None


def create_app(
    db_path: str | Path = DEFAULT_DB_PATH,
    projects_root: str | Path = DEFAULT_PROJECTS_ROOT,
) -> FastAPI:
    app = FastAPI(title="OpenMontage Short Drama Workbench")
    app.add_exception_handler(
        RequestValidationError,
        redacted_validation_exception_handler,
    )

    @app.exception_handler(PaymentRequiredQuote)
    async def payment_required_quote_handler(_request, exc):
        return JSONResponse(
            status_code=402,
            content={
                "code": "payment_required_quote",
                "billing_job_id": exc.job_id,
            },
        )

    @app.exception_handler(InsufficientBalance)
    async def insufficient_balance_handler(_request, _exc):
        return JSONResponse(
            status_code=402,
            content={"code": "payment_required"},
        )

    @app.exception_handler(ProviderResultUnavailable)
    async def provider_result_unavailable_handler(_request, _exc):
        return JSONResponse(
            status_code=502,
            content={"code": "provider_result_unavailable"},
        )

    @app.exception_handler(ProviderResultPending)
    async def provider_result_pending_handler(_request, exc):
        content = {"code": "provider_result_pending"}
        if exc.job_id:
            content["billing_job_id"] = exc.job_id
        return JSONResponse(
            status_code=409,
            content=content,
        )

    @app.exception_handler(ProviderPricingUnstable)
    async def provider_pricing_unstable_handler(_request, _exc):
        return JSONResponse(
            status_code=503,
            content={"code": "provider_pricing_unstable"},
        )

    @app.exception_handler(ProviderPricingUnavailable)
    async def provider_pricing_unavailable_handler(_request, _exc):
        return JSONResponse(
            status_code=503,
            content={"code": "provider_pricing_unavailable"},
        )

    @app.exception_handler(NewApiRateLimited)
    async def provider_rate_limited_handler(_request, _exc):
        return JSONResponse(
            status_code=429,
            content={"code": "provider_quote_rate_limited"},
        )

    @app.exception_handler(NewApiCallError)
    async def provider_call_error_handler(_request, _exc):
        return JSONResponse(
            status_code=502,
            content={"code": "provider_call_failed"},
        )
    app.include_router(auth_router)
    wallet_provisioner = WalletProvisioner()
    app.dependency_overrides[get_provisioner] = lambda: wallet_provisioner
    app.include_router(wallet_router)
    app.include_router(payment_router)
    app.include_router(admin_billing_router)
    app.include_router(admin_video_model_router)
    app.include_router(task_router)
    store = WorkbenchStore(projects_root=Path(projects_root), db_path=Path(db_path))
    events = EventBus()
    app.state.store = store
    app.state.events = events
    task_worker = configure_task_runtime(app, events)
    asset_publish_lock = threading.RLock()
    storyboard_plan_publish_lock = threading.RLock()
    composition_publish_lock = threading.RLock()

    def task_settings() -> AppSettings:
        override = app.dependency_overrides.get(get_settings)
        return override() if override is not None else get_settings()

    @contextmanager
    def task_newapi(settings: AppSettings):
        override = app.dependency_overrides.get(get_newapi_client)
        if override is not None:
            yield override()
            return
        client = NewApiClient(settings)
        try:
            yield client
        finally:
            client.close()

    def publish_resource_image(
        context: TaskExecutionContext,
        result: dict[str, Any],
        target_version: int | None,
    ) -> PublishOutcome:
        with asset_publish_lock, task_worker.session_factory() as publish_db:
            ProjectRepository(publish_db).require_owned_for_update(
                context.project_id,
                context.owner_user_id,
            )
            repository = MediaAssetRepository(publish_db, store)
            billing_job_id = str(result["billing_job_id"])
            existing = repository.get_generation_assets(
                generation_job_id=billing_job_id,
                owner_user_id=context.owner_user_id,
                origin_project_id=context.project_id,
            )

            current_resource: dict[str, Any] | None = None
            current_shot: dict[str, Any] | None = None
            resource_stale = False
            frame_target = context.input_snapshot.get("frame_target")
            if context.target_entity_type == "resource_asset":
                current_assets = store.read_asset_library(context.project_id)
                current_resource = next(
                    (
                        asset
                        for asset in current_assets
                        if isinstance(asset, dict)
                        and str(asset.get("id")) == context.target_entity_id
                    ),
                    None,
                )
                already_bound = bool(
                    existing
                    and current_resource is not None
                    and current_resource.get("generation_job_id") == billing_job_id
                    and current_resource.get("media_asset_id") == existing[0].id
                )
                if already_bound:
                    result["published_assets"] = [
                        compatible_asset_record(
                            generated,
                            project_id=context.project_id,
                            storage_path=generated.storage_path,
                        )
                        for generated in existing
                    ]
                    return PublishOutcome.ALREADY_PUBLISHED
                resource_stale = (
                    current_resource is None
                    or target_version is None
                    or int(current_resource.get("version") or 1) != target_version
                )
            elif context.target_entity_type == "shot_frame":
                storyboard = store.read_artifact(
                    context.project_id, "episode_storyboard.json"
                ) or {"shots": []}
                current_shot = next(
                    (
                        shot
                        for shot in storyboard.get("shots", [])
                        if isinstance(shot, dict)
                        and str(shot.get("id")) == context.target_entity_id
                    ),
                    None,
                )
                if frame_target not in {"first", "last"}:
                    return PublishOutcome.STALE
                continuity = resolve_continuity(current_shot) if current_shot else {}
                frame = continuity.get(
                    "first_frame" if frame_target == "first" else "last_frame"
                )
                already_bound = bool(
                    existing
                    and isinstance(frame, dict)
                    and frame.get("generation_job_id") == billing_job_id
                    and any(frame.get("asset_id") == asset.id for asset in existing)
                )
                if already_bound:
                    result["frame_target"] = frame_target
                    result["published_assets"] = [
                        compatible_asset_record(
                            generated,
                            project_id=context.project_id,
                            storage_path=generated.storage_path,
                        )
                        for generated in existing
                    ]
                    return PublishOutcome.ALREADY_PUBLISHED
            elif context.target_entity_type is not None:
                return PublishOutcome.STALE

            asset = result["asset"]
            created = existing
            if not created:
                created = repository.create_generated(
                    owner_user_id=context.owner_user_id,
                    origin_project_id=context.project_id,
                    kind=str(asset["kind"]),
                    label=str(asset["label"]),
                    description=str(asset.get("description") or ""),
                    prompt=str(asset["prompt"]),
                    model=str(asset["model"]),
                    generation_job_id=billing_job_id,
                    storage_paths=list(result["storage_paths"]),
                )
            compatible_records = [
                compatible_asset_record(
                    generated,
                    project_id=context.project_id,
                    storage_path=generated.storage_path,
                )
                for generated in created
            ]
            result["published_assets"] = compatible_records

            if context.target_entity_type == "resource_asset" and resource_stale:
                # The provider work and billing already happened. Keep the media
                # visible in the owned library, but never overwrite a newer resource.
                publish_db.commit()
                return PublishOutcome.STALE

            if context.target_entity_type == "shot_frame" and (
                current_shot is None
                or target_version is None
                or int(current_shot.get("version") or 1) != target_version
            ):
                # The provider work and billing already happened. Keep the media
                # visible in the owned library, but never overwrite a newer shot.
                publish_db.commit()
                return PublishOutcome.STALE

            with _project_mutation(
                db=publish_db,
                workbench=store,
                project_id=context.project_id,
                operation="publish_resource_image_task",
                changed_paths=[
                    *WORKFLOW_ARTIFACT_PATHS,
                    "artifacts/asset_library.json",
                    "artifacts/series_bible.json",
                    "artifacts/creative_workflow.json",
                    "artifacts/episode_storyboard.json",
                ],
                failure_detail="Generated assets could not be persisted",
            ):
                if context.target_entity_type == "resource_asset":
                    _replace_planned_resource_with_generated(
                        db=publish_db,
                        workbench=store,
                        project_id=context.project_id,
                        resource_id=str(context.target_entity_id),
                        target_version=int(target_version),
                        generated_record=compatible_records[0],
                    )
                elif context.target_entity_type == "shot_frame":
                    updated_shot = _bind_generated_shot_frame(
                        db=publish_db,
                        workbench=store,
                        project_id=context.project_id,
                        shot_id=str(context.target_entity_id),
                        frame_target=frame_target,
                        target_version=int(target_version),
                        generated_record=compatible_records[0],
                    )
                    result["frame_target"] = frame_target
                    result["shot_version"] = updated_shot.get("version")
                else:
                    _persist_compatible_assets(
                        db=publish_db,
                        workbench=store,
                        project_id=context.project_id,
                        asset_records=compatible_records,
                    )
                project = publish_db.get(ProjectRecord, context.project_id)
                if project is not None:
                    project.updated_at = datetime.now(timezone.utc)
            return PublishOutcome.PUBLISHED

    def execute_project_composition(
        context: TaskExecutionContext,
    ) -> TaskExecutionResult:
        frozen = deepcopy(context.batch_snapshot)
        storyboard = frozen.get("storyboard")
        series_bible = frozen.get("series_bible")
        if not isinstance(storyboard, dict) or not isinstance(series_bible, dict):
            raise PermanentTaskError(
                "composition_snapshot_invalid",
                "Frozen composition inputs are invalid",
            )
        with task_worker.session_factory() as ownership_db:
            ProjectRepository(ownership_db).require_owned_for_read(
                context.project_id, context.owner_user_id
            )
        output_filename = str(frozen.get("output_filename") or "")
        if not re.fullmatch(r"(?:final|episode-\d{3})\.mp4", output_filename):
            raise PermanentTaskError(
                "composition_output_invalid",
                "Frozen composition output is invalid",
            )
        project_dir = store.project_dir(context.project_id)
        for reference in frozen.get("media_references") or []:
            if not isinstance(reference, dict):
                raise PermanentTaskError(
                    "composition_media_invalid", "Frozen media references are invalid"
                )
            relative = sanitize_project_path(project_dir, reference.get("path"))
            if relative is None or not (project_dir / relative).is_file():
                raise PermanentTaskError(
                    "composition_media_missing",
                    "A selected shot no longer has an authorized media file",
                )

        staged_final_path = (
            project_dir
            / "renders"
            / f".{context.item_id}.{output_filename}.pending.mp4"
        )
        staged_final_path.unlink(missing_ok=True)

        def emit(stage: str, status: str, message: str) -> None:
            events.emit(
                context.project_id,
                job_id=context.batch_id,
                stage=stage,
                status=status,
                message=message,
            )

        def reject_missing_shot(_shot: dict[str, Any]) -> dict[str, Any]:
            raise PermanentTaskError(
                "composition_dependency_missing",
                "Composition cannot generate missing shots",
            )

        context.report_progress(5)
        try:
            result = render_short_drama_project(
                project_dir=project_dir,
                series_bible=series_bible,
                storyboard=storyboard,
                continuity_plan=frozen.get("continuity_plan"),
                video_model=str(frozen.get("video_model") or DEFAULT_VIDEO_MODEL),
                render_runtime=str(frozen["render_runtime"]),  # type: ignore[arg-type]
                emit_event=emit,
                generate_missing_shot=reject_missing_shot,
                composition_output_path=staged_final_path,
                persist_render_report=False,
                persist_execution_artifacts=False,
                pipeline_inputs=frozen.get("pipeline_inputs") or {},
                render_output_spec=frozen.get("render_output_spec"),
                project_id=context.project_id,
                project_aspect_ratio=str(frozen.get("project_aspect_ratio") or "9:16"),
                target_duration_seconds=frozen.get("target_duration_seconds"),
            )
        except Exception:
            staged_final_path.unlink(missing_ok=True)
            raise
        context.report_progress(90)
        render_report = result.get("render_report")
        if not isinstance(render_report, dict):
            staged_final_path.unlink(missing_ok=True)
            raise PermanentTaskError(
                "composition_result_invalid", "Composition returned an invalid report"
            )
        render_report["metadata"] = {
            **(
                render_report.get("metadata")
                if isinstance(render_report.get("metadata"), dict)
                else {}
            ),
            "task_batch_id": context.batch_id,
            "task_item_id": context.item_id,
            "settlement_key": context.settlement_key,
        }
        result["staged_final_path"] = relative_project_path(
            project_dir, staged_final_path
        )
        result["render_report"] = render_report
        return TaskExecutionResult(result)

    def publish_project_composition(
        context: TaskExecutionContext,
        result: dict[str, Any],
        _target_version: int | None,
    ) -> PublishOutcome:
        frozen = context.batch_snapshot
        project_dir = store.project_dir(context.project_id)
        staged_relative = sanitize_project_path(
            project_dir, result.get("staged_final_path")
        )
        staged_path = project_dir / staged_relative if staged_relative else None
        with composition_publish_lock, task_worker.session_factory() as publish_db:
            project = ProjectRepository(publish_db).require_owned_for_update(
                context.project_id, context.owner_user_id
            )
            existing_report = store.read_artifact(
                context.project_id, "render_report.json"
            )
            existing_metadata = (
                existing_report.get("metadata")
                if isinstance(existing_report, dict)
                and isinstance(existing_report.get("metadata"), dict)
                else {}
            )
            if existing_metadata.get("task_item_id") == context.item_id:
                if staged_path is not None:
                    staged_path.unlink(missing_ok=True)
                return PublishOutcome.ALREADY_PUBLISHED

            current_storyboard = store.read_artifact(
                context.project_id, "episode_storyboard.json"
            )
            current_continuity = store.read_artifact(
                context.project_id, "continuity_plan.json"
            )
            current_scope = _render_scope(project.project_type, current_continuity)
            expected_scope = frozen.get("render_scope")
            selected_shot_ids = [str(value) for value in frozen.get("selected_shot_ids") or []]
            current_versions: dict[str, int] = {}
            current_paths: dict[str, str | None] = {}
            if isinstance(current_storyboard, dict):
                for shot in current_storyboard.get("shots", []):
                    if not isinstance(shot, dict) or str(shot.get("id")) not in selected_shot_ids:
                        continue
                    shot_id = str(shot["id"])
                    current_versions[shot_id] = int(shot.get("version") or 1)
                    current_paths[shot_id] = sanitize_project_path(
                        project_dir, shot.get("output_path")
                    )
            expected_unit_revisions = {
                str(key): int(value)
                for key, value in (
                    frozen.get("generation_unit_revisions") or {}
                ).items()
            }
            current_unit_revisions: dict[str, int] = {}
            current_unit_paths: dict[str, str | None] = {}
            if expected_unit_revisions:
                current_paths = {}
                for unit in publish_db.scalars(
                    select(VideoGenerationUnit).where(
                        VideoGenerationUnit.project_id == context.project_id,
                        VideoGenerationUnit.id.in_(list(expected_unit_revisions)),
                        VideoGenerationUnit.active.is_(True),
                        VideoGenerationUnit.status == "complete",
                    )
                ):
                    current_unit_revisions[unit.id] = unit.revision
                    current_unit_paths[unit.id] = sanitize_project_path(
                        project_dir, unit.output_path
                    )
            current_runtime = read_workflow_settings(
                store, context.project_id
            )["render_runtime"]
            stale = (
                current_scope != expected_scope
                or current_versions != frozen.get("shot_versions")
                or current_paths != frozen.get("shot_media_paths")
                or current_unit_revisions != expected_unit_revisions
                or current_unit_paths
                != (frozen.get("generation_unit_media_paths") or {})
                or current_runtime != frozen.get("render_runtime")
                or staged_path is None
                or not staged_path.is_file()
            )
            if stale:
                if staged_path is not None:
                    staged_path.unlink(missing_ok=True)
                return PublishOutcome.STALE

            output_filename = str(frozen["output_filename"])
            final_path = project_dir / "renders" / output_filename
            render_report = deepcopy(result["render_report"])
            outputs = render_report.get("outputs") or []
            if not outputs or not isinstance(outputs[0], dict):
                staged_path.unlink(missing_ok=True)
                raise PermanentTaskError(
                    "composition_result_invalid", "Composition returned no final output"
                )
            outputs[0]["path"] = str(final_path)
            render_report["outputs"] = outputs
            merged_report = _merge_episode_render_report(
                existing_report,
                render_report,
                current_scope,
                selected_shot_ids,
            )
            merged_report["metadata"] = render_report.get("metadata", {})
            changed_paths = [
                "artifacts/render_report.json",
                "artifacts/edit_timeline.json",
                "artifacts/render_plan.json",
                "artifacts/final_review.json",
                f"renders/{output_filename}",
            ]
            with _project_mutation(
                db=publish_db,
                workbench=store,
                project_id=context.project_id,
                operation="publish_composition_task",
                changed_paths=changed_paths,
                failure_detail="Final composition could not be published",
            ):
                replace_atomic_output(
                    staged_path,
                    final_path,
                    final_path.parent.resolve(strict=True),
                )
                store.write_artifact(
                    context.project_id, "render_report.json", merged_report
                )
                for artifact_name, artifact_data in (
                    ("edit_timeline.json", result.get("edit_timeline")),
                    ("render_plan.json", result.get("render_plan")),
                    ("final_review.json", result.get("final_review")),
                ):
                    if artifact_data is not None:
                        store.write_artifact(
                            context.project_id, artifact_name, artifact_data
                        )
                project.updated_at = datetime.now(timezone.utc)
            result["render_report"] = merged_report
            result["final_path"] = relative_project_path(project_dir, final_path)
            result.pop("staged_final_path", None)
            return PublishOutcome.PUBLISHED

    def publish_storyboard_plan(
        context: TaskExecutionContext,
        result: dict[str, Any],
        _target_version: int | None,
    ) -> PublishOutcome:
        with storyboard_plan_publish_lock, task_worker.session_factory() as publish_db:
            project = ProjectRepository(publish_db).require_owned_for_update(
                context.project_id,
                context.owner_user_id,
            )
            receipt = store.read_artifact(
                context.project_id, "storyboard_plan_task.json"
            )
            if (
                isinstance(receipt, dict)
                and receipt.get("task_id") == context.batch_id
                and receipt.get("request_fingerprint")
                == result.get("request_fingerprint")
            ):
                storyboard, workflow = _creative_workflow_state(
                    store, context.project_id
                )
                continuity_plan = store.read_artifact(
                    context.project_id, "continuity_plan.json"
                ) or _default_continuity_plan(project.project_type)
                submit_inspiration_end_frame_tasks(
                    db=publish_db,
                    project=project,
                    storyboard=storyboard,
                    creative_workflow=workflow,
                    continuity_plan=continuity_plan,
                )
                return PublishOutcome.ALREADY_PUBLISHED

            _current_storyboard, creative_workflow = (
                _require_creative_brief_ready_for_planning(
                    store, context.project_id
                )
            )
            if (
                _storyboard_plan_workflow_token(creative_workflow)
                != context.input_snapshot.get("workflow_token")
            ):
                return PublishOutcome.STALE
            plan = result.get("plan")
            if not isinstance(plan, dict):
                raise PermanentTaskError(
                    "storyboard_result_invalid",
                    "Storyboard task returned an invalid plan",
                )
            storyboard, workflow, continuity_plan = _publish_storyboard_plan_result(
                db=publish_db,
                workbench=store,
                project=project,
                creative_workflow=creative_workflow,
                prompt=str(context.input_snapshot["prompt"]),
                video_model=str(context.input_snapshot["video_model"]),
                text_model=str(context.input_snapshot.get("text_model") or ""),
                result=deepcopy(plan),
                task_receipt={
                    "task_id": context.batch_id,
                    "request_fingerprint": result.get("request_fingerprint"),
                },
            )
            submit_inspiration_end_frame_tasks(
                db=publish_db,
                project=project,
                storyboard=storyboard,
                creative_workflow=workflow,
                continuity_plan=continuity_plan,
            )
            return PublishOutcome.PUBLISHED

    task_worker.register(
        STORYBOARD_PLAN_TASK_TYPE,
        lambda context: execute_storyboard_plan(
            context,
            session_factory=task_worker.session_factory,
            media_store=store,
            settings_factory=task_settings,
            newapi_context=task_newapi,
        ),
        publish=publish_storyboard_plan,
    )
    task_worker.register(
        "resource_image.generate",
        lambda context: execute_resource_image(
            context,
            session_factory=task_worker.session_factory,
            media_store=store,
            settings_factory=task_settings,
            newapi_context=task_newapi,
        ),
        publish=publish_resource_image,
    )
    task_worker.register(
        SHOT_VIDEO_TASK_TYPE,
        lambda context: execute_shot_video(
            context,
            session_factory=task_worker.session_factory,
            media_store=store,
            settings_factory=task_settings,
            newapi_context=task_newapi,
            events=events,
        ),
        publish=lambda context, result, target_version: publish_shot_video(
            context,
            result,
            target_version,
            media_store=store,
        ),
    )
    task_worker.register(
        "generation_unit_video.generate",
        lambda context: execute_generation_unit_video(
            context,
            session_factory=task_worker.session_factory,
            media_store=store,
            settings_factory=task_settings,
            newapi_context=task_newapi,
        ),
        publish=lambda context, result, target_version: publish_generation_unit_video(
            context,
            result,
            target_version,
            session_factory=task_worker.session_factory,
            media_store=store,
        ),
    )
    task_worker.register(
        COMPOSITION_TASK_TYPE,
        execute_project_composition,
        publish=publish_project_composition,
    )

    def submit_inspiration_end_frame_tasks(
        *,
        db: Session,
        project: ProjectRecord,
        storyboard: dict[str, Any],
        creative_workflow: dict[str, Any],
        continuity_plan: dict[str, Any] | None,
    ) -> None:
        if creative_workflow.get("control_end_frames") is not True:
            return
        plan_generation_id = str(
            creative_workflow.get("plan_generated_at") or ""
        )
        service = TaskService(db, events)
        existing = service.find_owned_by_idempotency(
            str(project.owner_user_id),
            project.id,
            _inspiration_end_frame_batch_key(plan_generation_id),
        )
        if existing is not None:
            task_worker.notify()
            return
        submission = _build_inspiration_end_frame_submission(
            storyboard=storyboard,
            continuity_plan=continuity_plan,
            plan_generation_id=plan_generation_id,
        )
        if submission is None:
            return
        try:
            service.submit(
                owner_user_id=str(project.owner_user_id),
                project_id=project.id,
                request=submission,
            )
        except Exception:
            db.rollback()
            end_frame_task_logger.exception(
                "Could not enqueue inspiration end-frame tasks",
                extra={"project_id": project.id},
            )
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "end_frame_task_submission_failed",
                    "message": "Storyboard was saved, but frame preparation could not start",
                },
            ) from None
        task_worker.notify()

    app.state.media_cleanup_deleted = cleanup_expired_media(Path(projects_root))

    def get_store() -> WorkbenchStore:
        return app.state.store

    def get_events() -> EventBus:
        return app.state.events

    @app.get("/api/generation/models", response_model=GenerationModelsResponse)
    def list_generation_models(
        capability: Literal["text", "image", "video"],
        _current: CurrentUser = Depends(require_user),
        newapi: NewApiClient = Depends(get_newapi_client),
        db: Session = Depends(get_db),
    ) -> GenerationModelsResponse:
        try:
            models = newapi.list_models(capability)
        except InvalidNewApiResponse:
            raise NewApiCallError("Provider model catalog is invalid") from None
        return GenerationModelsResponse(
            capability=capability,
            models=models,
            profiles=model_profiles(models, db=db) if capability == "video" else [],
        )

    @app.get("/api/assets", response_model=MediaAssetListResponse)
    def list_media_assets(
        request: Request,
        scope: Literal["all", "project"] = "all",
        project_id: str | None = None,
        kind: AssetKind | None = None,
        source_type: AssetSourceType | None = None,
        cursor: str | None = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        workbench: WorkbenchStore = Depends(get_store),
        current: CurrentUser = Depends(require_user),
        db: Session = Depends(get_db),
    ) -> MediaAssetListResponse:
        origin_project_id = None
        if scope == "project":
            if project_id is None:
                raise HTTPException(
                    status_code=422,
                    detail="project_id is required for project scope",
                )
            ProjectRepository(db).require_owned_for_read(project_id, current.id)
            _require_project_available(request, project_id)
            origin_project_id = project_id
        repository = MediaAssetRepository(db, workbench)
        assets, next_cursor = repository.list_owned(
            owner_user_id=current.id,
            origin_project_id=origin_project_id,
            kind=kind,
            source_type=source_type,
            cursor=cursor,
            limit=limit,
        )
        return MediaAssetListResponse(
            assets=[repository.serialize(asset) for asset in assets],
            next_cursor=next_cursor,
        )

    @app.get("/api/billing/jobs/{job_id}")
    def get_billing_job(
        job_id: str,
        current: CurrentUser = Depends(require_user),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        job = db.query(GenerationJob).filter(
            GenerationJob.id == job_id,
            GenerationJob.user_id == current.id,
        ).one_or_none()
        if job is None:
            raise HTTPException(status_code=404, detail="Billing job not found")
        return {
            "id": job.id,
            "project_id": job.project_id,
            "parent_job_id": job.parent_job_id,
            "operation": job.operation,
            "status": job.status,
            "result_visible": job.result_visible,
            "created_at": job.created_at,
            "updated_at": job.updated_at,
        }

    @app.post(
        "/api/projects/{project_id}/images/generate",
        status_code=202,
        response_model=TaskAcceptedResponse,
        openapi_extra=_json_request_openapi(ImageGenerationRequest),
    )
    async def generate_project_image(
        request: Request,
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> TaskAcceptedResponse:
        payload = await parse_json_request(request, ImageGenerationRequest)
        project = _lock_owned_project_after_parse(
            request=request,
            db=db,
            project_id=project_id,
            authorized_project=project,
        )
        _require_approved_creative_workflow(workbench, project_id)
        resource_ids = list(payload.resource_ids)
        if len(resource_ids) != len(set(resource_ids)):
            raise HTTPException(status_code=422, detail="Resource ids must be unique")
        if payload.billing_job_id is not None and len(resource_ids) > 1:
            raise HTTPException(
                status_code=422,
                detail="A billing retry can target only one resource",
            )
        shot_target: dict[str, Any] | None = None
        if payload.shot_id is not None:
            storyboard = workbench.read_artifact(
                project_id, "episode_storyboard.json"
            ) or {"shots": []}
            shot_target = next(
                (
                    shot
                    for shot in storyboard.get("shots", [])
                    if isinstance(shot, dict) and str(shot.get("id")) == payload.shot_id
                ),
                None,
            )
            if shot_target is None:
                raise HTTPException(status_code=404, detail="Project shot not found")

        resources_by_id = {
            str(asset.get("id")): asset
            for asset in workbench.read_asset_library(project_id)
            if isinstance(asset, dict) and asset.get("id")
        }
        missing = [
            resource_id
            for resource_id in resource_ids
            if resource_id not in resources_by_id
        ]
        if missing:
            raise HTTPException(status_code=404, detail="Project resource not found")

        selected = [resources_by_id[resource_id] for resource_id in resource_ids]
        if any(
            asset.get("kind") not in {"character", "scene", "prop"}
            for asset in selected
        ):
            raise HTTPException(status_code=422, detail="Resource kind is not supported")
        task_inputs: list[
            tuple[dict[str, Any], str | None, str | None, int | None]
        ] = []
        if shot_target is not None:
            task_inputs.append(
                (
                    {
                        "kind": "scene",
                        "label": payload.label,
                        "description": payload.description,
                        "prompt": payload.prompt,
                        "model": payload.model,
                        "count": 1,
                        "size": payload.size,
                        "quality": payload.quality,
                        "shot_id": payload.shot_id,
                        "frame_target": payload.frame_target,
                    },
                    "shot_frame",
                    str(shot_target["id"]),
                    int(shot_target.get("version") or 1),
                )
            )
        elif selected:
            for asset in selected:
                custom = len(selected) == 1
                task_inputs.append(
                    (
                        {
                            "kind": payload.kind if custom else str(asset.get("kind")),
                            "label": payload.label if custom else str(asset.get("label") or "Resource"),
                            "description": payload.description if custom else str(asset.get("description") or ""),
                            "prompt": payload.prompt if custom else str(asset.get("prompt") or asset.get("description") or asset.get("label") or "resource"),
                            "model": payload.model,
                            "count": 1,
                            "size": payload.size,
                            "quality": payload.quality,
                        },
                        "resource_asset",
                        str(asset["id"]),
                        int(asset.get("version") or 1),
                    )
                )
        else:
            task_inputs.append(
                (
                    payload.model_dump(
                        exclude={
                            "billing_job_id",
                            "resource_ids",
                            "shot_id",
                            "frame_target",
                            "idempotency_key",
                        }
                    ),
                    None,
                    None,
                    None,
                )
            )

        canonical = json.dumps(task_inputs, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        submission = TaskSubmitRequest(
            idempotency_key=payload.idempotency_key or f"resource-image:{digest}",
            task_type="resource_image.generate",
            project_version=1,
            snapshot={
                "resource_ids": resource_ids,
                "shot_id": payload.shot_id,
                "frame_target": payload.frame_target,
                "request_digest": digest,
            },
            items=[
                TaskItemSubmit(
                    idempotency_key=(
                        f"{target_type or 'manual'}:{target_id or index}:"
                        f"{digest[:32]}"
                    ),
                    input=task_input,
                    model=str(task_input["model"]),
                    target_entity_type=target_type,
                    target_entity_id=target_id,
                    target_entity_version=target_entity_version,
                    billing_job_id=payload.billing_job_id if index == 0 else None,
                )
                for index, (
                    task_input,
                    target_type,
                    target_id,
                    target_entity_version,
                ) in enumerate(task_inputs)
            ],
        )
        try:
            batch, deduplicated = TaskService(db, events).submit(
                owner_user_id=project.owner_user_id,
                project_id=project_id,
                request=submission,
            )
        except TaskConflict as exc:
            status_code = 404 if exc.code == "billing_job_not_found" else 409
            raise HTTPException(
                status_code=status_code,
                detail={"code": exc.code, "message": exc.message},
            ) from None
        task_worker.notify()
        return TaskAcceptedResponse(
            task_id=batch.id,
            status=batch.status,
            deduplicated=deduplicated,
            task=TaskService(db, events).batch_response(batch, include_items=True),
        )

    @app.post(
        "/api/projects",
        openapi_extra=_json_request_openapi(ProjectCreateRequest),
    )
    async def create_draft_project(
        request: Request,
        workbench: WorkbenchStore = Depends(get_store),
        current: CurrentUser = Depends(require_csrf),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        payload = await parse_json_request(request, ProjectCreateRequest)
        project = ProjectRepository(db).create(
            owner_user_id=current.id,
            title=payload.title,
            mode="short_drama",
            project_type=payload.project_type,
        )
        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project.id,
            operation="create_draft",
            changed_paths=[],
            failure_detail="Project creation failed",
            new_workspace=True,
        ):
            series_bible = {
                "title": payload.title,
                "mode": "short_drama",
                "style_lock": "",
                "project_brief": payload.prompt.strip(),
                "characters": [],
                "assets": [],
            }
            storyboard = {"shots": []}
            continuity_plan = _default_continuity_plan(payload.project_type)
            creative_workflow = _default_creative_workflow(storyboard)
            title_source = payload.title_source or (
                "placeholder"
                if payload.title in {"\u672a\u547d\u540d\u9879\u76ee", "Untitled project"}
                else "user"
            )
            consistency_report = {"score": 100, "issues": []}
            _persist_storyboard_state(
                workbench=workbench,
                project_id=project.id,
                storyboard=storyboard,
                series_bible=series_bible,
                consistency_report=consistency_report,
            )
            workbench.write_artifact(project.id, "continuity_plan.json", continuity_plan)
            workbench.write_artifact(project.id, "creative_workflow.json", creative_workflow)
            workbench.write_artifact(
                project.id, "project_title_source.json", {"source": title_source}
            )
            rewrite_workflow_artifacts(
                workbench=workbench,
                project_id=project.id,
                series_bible=series_bible,
                storyboard=storyboard,
                render_runtime="ffmpeg",
                video_model=DEFAULT_VIDEO_MODEL,
                continuity_plan=continuity_plan,
            )
        return _project_snapshot(workbench, project)

    @app.post(
        "/api/projects/{project_id}/inspiration/chat",
        openapi_extra=_json_request_openapi(InspirationChatRequest),
    )
    async def develop_project_inspiration(
        project_id: str,
        request: Request,
        authorized_project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
        newapi: NewApiClient = Depends(get_newapi_client),
    ) -> dict[str, Any]:
        payload = await parse_json_request(request, InspirationChatRequest)
        raw_title_source = workbench.read_artifact(
            project_id, "project_title_source.json"
        )
        existing_workflow = _require_inspiration_editable_workflow(
            workbench, project_id
        )
        try:
            result = develop_inspiration_billed(
                db=db,
                newapi=newapi,
                settings=settings,
                media_store=workbench,
                user_id=authorized_project.owner_user_id,
                project_id=project_id,
                title=authorized_project.title,
                project_type=authorized_project.project_type,
                messages=payload.messages,
                model=payload.text_model,
                billing_job_id=payload.billing_job_id,
            )
        except _BILLING_CONTROL_ERRORS:
            raise
        except Exception as exc:
            db.rollback()
            raise HTTPException(
                status_code=502,
                detail=INSPIRATION_DEVELOPMENT_FAILED,
            ) from exc

        workflow = {
            "phase": "inspiration",
            "messages": [
                *[message.model_dump() for message in payload.messages],
                {"role": "assistant", "content": result["reply"]},
            ],
            "brief": result["brief"],
            "ready_to_confirm": result["ready_to_confirm"],
            "control_end_frames": existing_workflow.get("control_end_frames") is True,
            "text_model": payload.text_model.strip(),
            "planned_asset_ids": list(
                existing_workflow.get("planned_asset_ids", [])
            ),
            "approved_at": None,
            "brief_confirmed_at": None,
            "plan_generated_at": None,
            "plan_sections": {
                section: {
                    **approval,
                    "status": "pending",
                    "feedback": None,
                    "updated_at": None,
                }
                for section, approval in existing_workflow["plan_sections"].items()
            },
        }
        promoted_project_type = (
            _project_type_from_brief(result.get("brief"))
            if authorized_project.project_type == "single_video"
            else None
        )
        generated_title = _brief_project_title(result.get("brief"))
        should_adopt_generated_title = generated_title is not None and (
            (
                isinstance(raw_title_source, dict)
                and raw_title_source.get("source")
                in {"placeholder", "inspiration"}
            )
            or (
                not isinstance(raw_title_source, dict)
                and authorized_project.title
                in {"\u672a\u547d\u540d\u9879\u76ee", "Untitled project"}
            )
        )
        continuity_plan = workbench.read_artifact(
            project_id, "continuity_plan.json"
        ) or _default_continuity_plan(authorized_project.project_type)
        if promoted_project_type is not None:
            continuity_plan = {
                **continuity_plan,
                "project_type": promoted_project_type,
                "active_episode_number": 1,
            }
        changed_paths = ["artifacts/creative_workflow.json"]
        if promoted_project_type is not None:
            changed_paths.append("artifacts/continuity_plan.json")
        if should_adopt_generated_title:
            changed_paths.append("artifacts/series_bible.json")
            changed_paths.append("artifacts/project_title_source.json")
        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project_id,
            operation="develop_inspiration",
            changed_paths=changed_paths,
            failure_detail="Inspiration conversation could not be saved",
        ):
            if promoted_project_type is not None:
                authorized_project.project_type = promoted_project_type
                workbench.write_artifact(
                    project_id, "continuity_plan.json", continuity_plan
                )
            if should_adopt_generated_title:
                authorized_project.title = generated_title
                series_bible = workbench.read_artifact(
                    project_id, "series_bible.json"
                ) or {}
                series_bible["title"] = generated_title
                workbench.write_artifact(
                    project_id, "series_bible.json", series_bible
                )
                workbench.write_artifact(
                    project_id,
                    "project_title_source.json",
                    {"source": "inspiration"},
                )
            workbench.write_artifact(project_id, "creative_workflow.json", workflow)
            authorized_project.updated_at = datetime.now(timezone.utc)
        return _project_snapshot(workbench, authorized_project)

    @app.patch(
        "/api/projects/{project_id}/inspiration/intent",
        openapi_extra=_json_request_openapi(InspirationIntentUpdateRequest),
    )
    async def update_project_inspiration_intent(
        project_id: str,
        request: Request,
        authorized_project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        payload = await parse_json_request(request, InspirationIntentUpdateRequest)
        workflow = _require_inspiration_editable_workflow(workbench, project_id)
        if workflow.get("phase") != "inspiration":
            raise HTTPException(
                status_code=409,
                detail="End-frame intent can only change before storyboard planning",
            )
        if workflow.get("control_end_frames") is not payload.control_end_frames:
            workflow["control_end_frames"] = payload.control_end_frames
            with _project_mutation(
                db=db,
                workbench=workbench,
                project_id=project_id,
                operation="update_inspiration_intent",
                changed_paths=["artifacts/creative_workflow.json"],
                failure_detail="Inspiration preference could not be saved",
            ):
                workbench.write_artifact(
                    project_id, "creative_workflow.json", workflow
                )
                authorized_project.updated_at = datetime.now(timezone.utc)
        return _project_snapshot(workbench, authorized_project)

    @app.post(
        "/api/projects/{project_id}/storyboard/plan/tasks",
        status_code=202,
        response_model=TaskAcceptedResponse,
        openapi_extra=_json_request_openapi(StoryboardPlanRequest),
    )
    async def submit_project_storyboard_plan(
        project_id: str,
        request: Request,
        authorized_project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
    ) -> TaskAcceptedResponse:
        payload = await parse_json_request(request, StoryboardPlanRequest)
        current_storyboard, creative_workflow = (
            _require_creative_brief_ready_for_planning(workbench, project_id)
        )
        if current_storyboard.get("shots") and creative_workflow.get("phase") in {
            "plan_review",
            "approved",
        }:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "storyboard_already_planned",
                    "message": "Storyboard is already planned",
                },
            )

        text_model = (
            payload.text_model.strip()
            if isinstance(payload.text_model, str) and payload.text_model.strip()
            else (
                creative_workflow.get("text_model").strip()
                if isinstance(creative_workflow.get("text_model"), str)
                and creative_workflow.get("text_model").strip()
                else settings.newapi_planning_text_model
            )
        )
        workflow_changed = False
        if (
            payload.control_end_frames is not None
            and creative_workflow.get("control_end_frames")
            is not payload.control_end_frames
        ):
            creative_workflow["control_end_frames"] = payload.control_end_frames
            workflow_changed = True
        if creative_workflow.get("text_model") != text_model:
            creative_workflow["text_model"] = text_model
            workflow_changed = True
        if workflow_changed:
            with _project_mutation(
                db=db,
                workbench=workbench,
                project_id=project_id,
                operation="confirm_inspiration_intent",
                changed_paths=["artifacts/creative_workflow.json"],
                failure_detail="Inspiration preference could not be saved",
            ):
                workbench.write_artifact(
                    project_id, "creative_workflow.json", creative_workflow
                )
                authorized_project.updated_at = datetime.now(timezone.utc)

        narrative_beats = (
            creative_workflow.get("brief", {}).get("narrative_beats")
            if isinstance(creative_workflow.get("brief"), dict)
            else None
        )
        workflow_token = _storyboard_plan_workflow_token(creative_workflow)
        frozen_input = {
            "prompt": payload.prompt.strip(),
            "text_model": text_model,
            "video_model": payload.video_model,
            "shot_count": payload.shot_count,
            "project_type": authorized_project.project_type,
            "narrative_beats": narrative_beats,
            "workflow_token": workflow_token,
        }
        canonical = json.dumps(
            {"project_id": project_id, **frozen_input},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        request_fingerprint = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        frozen_input["request_fingerprint"] = request_fingerprint
        submission = TaskSubmitRequest(
            idempotency_key=f"storyboard-plan:{request_fingerprint}",
            task_type=STORYBOARD_PLAN_TASK_TYPE,
            project_version=1,
            snapshot={
                "purpose": "storyboard_planning",
                "request_fingerprint": request_fingerprint,
            },
            items=[
                TaskItemSubmit(
                    idempotency_key=f"plan:{request_fingerprint[:48]}",
                    input=frozen_input,
                    model=text_model,
                    max_attempts=3,
                    billing_job_id=payload.billing_job_id,
                    settlement_key=request_fingerprint[:32],
                )
            ],
        )
        service = TaskService(db, events)
        existing = service.find_owned_by_idempotency(
            str(authorized_project.owner_user_id),
            project_id,
            submission.idempotency_key,
        )
        deduplicated = existing is not None
        if existing is None:
            try:
                batch, deduplicated = service.submit(
                    owner_user_id=str(authorized_project.owner_user_id),
                    project_id=project_id,
                    request=submission,
                )
            except TaskConflict as exc:
                raise HTTPException(
                    status_code=409,
                    detail={"code": exc.code, "message": exc.message},
                ) from None
        else:
            batch = existing
            if batch.status in {"failed", "awaiting_payment"}:
                task = service.batch_response(batch, include_items=True)
                item = task.items[0] if task.items else None
                if item is None:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "storyboard_plan_task_invalid",
                            "message": "Storyboard planning task cannot be retried",
                        },
                    )
                try:
                    service.retry_owned_item(
                        batch_id=batch.id,
                        item_id=item.id,
                        owner_user_id=str(authorized_project.owner_user_id),
                        project_id=project_id,
                    )
                    batch = service.require_owned_batch(
                        batch.id,
                        str(authorized_project.owner_user_id),
                        project_id,
                    )
                except TaskStateError as exc:
                    raise HTTPException(
                        status_code=409,
                        detail={"code": exc.code, "message": exc.message},
                    ) from None
        task_worker.notify()
        return TaskAcceptedResponse(
            task_id=batch.id,
            status=batch.status,
            deduplicated=deduplicated,
            task=service.batch_response(batch, include_items=True),
        )

    @app.post(
        "/api/projects/{project_id}/storyboard/plan",
        openapi_extra=_json_request_openapi(StoryboardPlanRequest),
    )
    async def plan_existing_project_storyboard(
        project_id: str,
        request: Request,
        authorized_project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
        newapi: NewApiClient = Depends(get_newapi_client),
    ) -> dict[str, Any]:
        payload = await parse_json_request(request, StoryboardPlanRequest)
        current_storyboard, creative_workflow = (
            _require_creative_brief_ready_for_planning(workbench, project_id)
        )
        if current_storyboard.get("shots") and creative_workflow.get("phase") == "approved":
            raise HTTPException(status_code=409, detail="Storyboard is already planned")
        if (
            current_storyboard.get("shots")
            and creative_workflow.get("phase") == "plan_review"
            and creative_workflow.get("plan_generated_at")
        ):
            continuity_plan = workbench.read_artifact(
                project_id, "continuity_plan.json"
            ) or _default_continuity_plan(authorized_project.project_type)
            submit_inspiration_end_frame_tasks(
                db=db,
                project=authorized_project,
                storyboard=current_storyboard,
                creative_workflow=creative_workflow,
                continuity_plan=continuity_plan,
            )
            return _project_snapshot(workbench, authorized_project)

        if (
            payload.control_end_frames is not None
            and creative_workflow.get("control_end_frames")
            is not payload.control_end_frames
        ):
            creative_workflow["control_end_frames"] = payload.control_end_frames
            with _project_mutation(
                db=db,
                workbench=workbench,
                project_id=project_id,
                operation="confirm_inspiration_intent",
                changed_paths=["artifacts/creative_workflow.json"],
                failure_detail="Inspiration preference could not be saved",
            ):
                workbench.write_artifact(
                    project_id, "creative_workflow.json", creative_workflow
                )
                authorized_project.updated_at = datetime.now(timezone.utc)

        text_model = (
            payload.text_model
            or creative_workflow.get("text_model")
            or settings.newapi_planning_text_model
        )
        try:
            result = generate_short_drama_storyboard(
                db=db,
                newapi=newapi,
                settings=settings,
                media_store=workbench,
                user_id=authorized_project.owner_user_id,
                project_id=project_id,
                title=authorized_project.title,
                prompt=payload.prompt,
                model=text_model,
                shot_count=payload.shot_count,
                project_type=authorized_project.project_type,
                narrative_beats=(
                    creative_workflow.get("brief", {}).get("narrative_beats")
                    if isinstance(creative_workflow.get("brief"), dict)
                    else None
                ),
                billing_job_id=payload.billing_job_id,
            )
        except _BILLING_CONTROL_ERRORS:
            raise
        except Exception as exc:
            db.rollback()
            raise HTTPException(status_code=502, detail=STORYBOARD_GENERATION_FAILED) from exc

        storyboard, creative_workflow, continuity_plan = _publish_storyboard_plan_result(
            db=db,
            workbench=workbench,
            project=authorized_project,
            creative_workflow=creative_workflow,
            prompt=payload.prompt,
            video_model=payload.video_model,
            text_model=text_model,
            result=result,
        )
        submit_inspiration_end_frame_tasks(
            db=db,
            project=authorized_project,
            storyboard=storyboard,
            creative_workflow=creative_workflow,
            continuity_plan=continuity_plan,
        )
        return _project_snapshot(workbench, authorized_project)

    @app.patch(
        "/api/projects/{project_id}/creative-plan/sections/{section}",
        openapi_extra=_json_request_openapi(PlanSectionUpdateRequest),
    )
    async def update_creative_plan_section(
        project_id: str,
        section: PlanSectionId,
        request: Request,
        authorized_project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        payload = await parse_json_request(request, PlanSectionUpdateRequest)
        project = _lock_owned_project_after_parse(
            request=request,
            db=db,
            project_id=project_id,
            authorized_project=authorized_project,
        )
        storyboard, workflow = _creative_workflow_state(workbench, project_id)
        if not storyboard.get("shots") or workflow.get("phase") != "plan_review":
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "creative_plan_not_reviewable",
                    "message": "Creative plan is not ready for section review",
                },
            )
        current = workflow["plan_sections"][section]
        if payload.revision != current["revision"]:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "plan_section_revision_conflict",
                    "message": "Creative plan section has changed",
                    "section": section,
                    "submitted_revision": payload.revision,
                    "current_revision": current["revision"],
                    "current": current,
                },
            )

        updated_at = datetime.now(timezone.utc).isoformat()
        workflow["plan_sections"][section] = PlanSectionApproval(
            status=payload.status,
            revision=current["revision"] + 1,
            feedback=payload.feedback,
            updated_at=updated_at,
        ).model_dump()
        workflow["phase"] = "plan_review"
        workflow["approved_at"] = None
        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project_id,
            operation="update_plan_section",
            changed_paths=["artifacts/creative_workflow.json"],
            failure_detail="Creative plan section could not be saved",
        ):
            workbench.write_artifact(project_id, "creative_workflow.json", workflow)
            project.updated_at = datetime.now(timezone.utc)
        return _project_snapshot(workbench, project)

    @app.post(
        "/api/projects/{project_id}/creative-plan/storyboard-revision/start"
    )
    def start_storyboard_revision(
        project_id: str,
        request: Request,
        authorized_project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        project = _lock_owned_project_after_parse(
            request=request,
            db=db,
            project_id=project_id,
            authorized_project=authorized_project,
        )
        storyboard, workflow = _creative_workflow_state(workbench, project_id)
        active_session = workflow.get("revision_session")
        if (
            workflow.get("phase") == "plan_review"
            and isinstance(active_session, dict)
            and active_session.get("section") == "storyboard"
        ):
            return _project_snapshot(workbench, project)
        if (
            not storyboard.get("shots")
            or workflow.get("phase") != "approved"
            or _missing_plan_sections(workflow)
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "storyboard_revision_not_startable",
                    "message": "Only an approved storyboard can enter revision",
                },
            )

        updated_at = datetime.now(timezone.utc).isoformat()
        current = workflow["plan_sections"]["storyboard"]
        section_revision = current["revision"] + 1
        workflow["phase"] = "plan_review"
        workflow["plan_sections"]["storyboard"] = PlanSectionApproval(
            status="changes_requested",
            revision=section_revision,
            feedback="Reduce or merge storyboard shots",
            updated_at=updated_at,
        ).model_dump()
        workflow["revision_session"] = StoryboardRevisionSession(
            started_at=updated_at,
            original_approved_at=workflow.get("approved_at"),
            section_revision=section_revision,
        ).model_dump()
        workflow["approved_at"] = None
        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project_id,
            operation="start_storyboard_revision",
            changed_paths=["artifacts/creative_workflow.json"],
            failure_detail="Storyboard revision could not be started",
        ):
            workbench.write_artifact(project_id, "creative_workflow.json", workflow)
            project.updated_at = datetime.now(timezone.utc)
        return _project_snapshot(workbench, project)

    @app.post(
        "/api/projects/{project_id}/creative-plan/storyboard-revision/cancel"
    )
    def cancel_storyboard_revision(
        project_id: str,
        request: Request,
        authorized_project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        project = _lock_owned_project_after_parse(
            request=request,
            db=db,
            project_id=project_id,
            authorized_project=authorized_project,
        )
        storyboard, workflow = _creative_workflow_state(workbench, project_id)
        session = workflow.get("revision_session")
        current = workflow["plan_sections"]["storyboard"]
        if (
            not storyboard.get("shots")
            or workflow.get("phase") != "plan_review"
            or not isinstance(session, dict)
            or session.get("section") != "storyboard"
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "storyboard_revision_not_active",
                    "message": "No storyboard revision is active",
                },
            )
        if (
            current.get("status") != "changes_requested"
            or current.get("revision") != session.get("section_revision")
            or any(
                workflow["plan_sections"][section].get("status") != "approved"
                for section in PLAN_SECTION_IDS
                if section != "storyboard"
            )
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "storyboard_revision_changed",
                    "message": "Storyboard revision changed and can no longer be cancelled",
                    "current": current,
                },
            )

        updated_at = datetime.now(timezone.utc).isoformat()
        workflow["phase"] = "approved"
        workflow["approved_at"] = session.get("original_approved_at") or updated_at
        workflow["revision_session"] = None
        workflow["plan_sections"]["storyboard"] = PlanSectionApproval(
            status="approved",
            revision=current["revision"] + 1,
            feedback=None,
            updated_at=updated_at,
        ).model_dump()
        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project_id,
            operation="cancel_storyboard_revision",
            changed_paths=["artifacts/creative_workflow.json"],
            failure_detail="Storyboard revision could not be cancelled",
        ):
            workbench.write_artifact(project_id, "creative_workflow.json", workflow)
            project.updated_at = datetime.now(timezone.utc)
        return _project_snapshot(workbench, project)

    @app.post(
        "/api/projects/{project_id}/creative-plan/revise",
        openapi_extra=_json_request_openapi(CreativePlanReviseRequest),
    )
    async def revise_creative_plan(
        project_id: str,
        request: Request,
        authorized_project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
        newapi: NewApiClient = Depends(get_newapi_client),
    ) -> dict[str, Any]:
        payload = await parse_json_request(request, CreativePlanReviseRequest)
        current_storyboard, workflow = _creative_workflow_state(workbench, project_id)
        current_series_bible = workbench.read_artifact(project_id, "series_bible.json")
        if (
            workflow.get("phase") != "plan_review"
            or current_series_bible is None
            or not current_storyboard.get("shots")
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "creative_plan_not_reviewable",
                    "message": "Creative plan is not ready for revision",
                },
            )
        initial_sections = deepcopy(workflow["plan_sections"])
        revision_prompt = (
            f"{current_series_bible.get('project_brief') or ''}\n\n"
            f"Revise these creative plan sections: {', '.join(payload.sections)}.\n"
            f"Feedback: {payload.feedback.strip()}\n"
            "Return a complete plan, but preserve the intent and all unrelated sections. "
            "Current plan JSON follows:\n"
            + json.dumps(
                {
                    "series_bible": current_series_bible,
                    "storyboard": current_storyboard,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        )
        text_model = (
            payload.text_model
            or workflow.get("text_model")
            or settings.newapi_planning_text_model
        )
        try:
            generated = generate_short_drama_storyboard(
                db=db,
                newapi=newapi,
                settings=settings,
                media_store=workbench,
                user_id=authorized_project.owner_user_id,
                project_id=project_id,
                title=authorized_project.title,
                prompt=revision_prompt,
                model=text_model,
                shot_count=len(current_storyboard.get("shots", [])),
                project_type=authorized_project.project_type,
                billing_job_id=payload.billing_job_id,
            )
        except _BILLING_CONTROL_ERRORS:
            raise
        except Exception as exc:
            db.rollback()
            raise HTTPException(
                status_code=502,
                detail=STORYBOARD_GENERATION_FAILED,
            ) from exc

        generated_series_bible = generated["series_bible"]
        generated_storyboard = generated["storyboard"]
        affected_sections = _affected_plan_sections(
            payload.sections,
            current_series_bible,
            current_storyboard,
            generated_series_bible,
            generated_storyboard,
        )
        if "storyboard" in affected_sections and not generated_storyboard.get("shots"):
            raise HTTPException(status_code=502, detail=STORYBOARD_GENERATION_FAILED)

        project = _lock_owned_project_after_parse(
            request=request,
            db=db,
            project_id=project_id,
            authorized_project=authorized_project,
        )
        locked_storyboard, locked_workflow = _creative_workflow_state(
            workbench, project_id
        )
        locked_series_bible = workbench.read_artifact(project_id, "series_bible.json")
        if (
            locked_workflow.get("phase") != "plan_review"
            or locked_workflow["plan_sections"] != initial_sections
            or locked_series_bible is None
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "creative_plan_revision_conflict",
                    "message": "Creative plan changed while revision was generated",
                    "plan_sections": locked_workflow["plan_sections"],
                },
            )

        updated_at = datetime.now(timezone.utc).isoformat()
        series_bible, storyboard, planned_asset_ids = _merge_revised_plan(
            current_series_bible=locked_series_bible,
            current_storyboard=locked_storyboard,
            generated_series_bible=generated_series_bible,
            generated_storyboard=generated_storyboard,
            affected_sections=affected_sections,
            planned_asset_ids=set(locked_workflow.get("planned_asset_ids", [])),
            updated_at=updated_at,
        )
        report = evaluate_storyboard_consistency(series_bible, storyboard)
        apply_consistency_scores(storyboard, report)
        affected_set = set(affected_sections)
        for section in PLAN_SECTION_IDS:
            if section not in affected_set:
                continue
            current = locked_workflow["plan_sections"][section]
            locked_workflow["plan_sections"][section] = PlanSectionApproval(
                status="pending",
                revision=current["revision"] + 1,
                feedback=payload.feedback if section in payload.sections else None,
                updated_at=updated_at,
            ).model_dump()
        locked_workflow.update(
            {
                "phase": "plan_review",
                "approved_at": None,
                "text_model": text_model,
                "revision_session": None,
                "plan_generated_at": updated_at,
                "planned_asset_ids": [
                    asset_id
                    for asset_id in dict.fromkeys(
                        [
                            *locked_workflow.get("planned_asset_ids", []),
                            *planned_asset_ids,
                        ]
                    )
                    if asset_id in planned_asset_ids
                ],
            }
        )
        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project_id,
            operation="revise_creative_plan",
            changed_paths=[
                *STORYBOARD_ARTIFACT_PATHS,
                *WORKFLOW_ARTIFACT_PATHS,
                "artifacts/creative_workflow.json",
            ],
            failure_detail="Creative plan revision could not be saved",
        ):
            continuity_plan = workbench.read_artifact(
                project_id, "continuity_plan.json"
            ) or _default_continuity_plan(project.project_type)
            continuity_plan = _merge_generated_continuity(
                continuity_plan,
                series_bible,
                generated_continuity=generated.get("continuity_plan"),
            )
            _persist_storyboard_state(
                workbench=workbench,
                project_id=project_id,
                storyboard=storyboard,
                series_bible=series_bible,
                consistency_report=report,
            )
            workbench.write_artifact(
                project_id, "continuity_plan.json", continuity_plan
            )
            workbench.write_artifact(
                project_id, "creative_workflow.json", locked_workflow
            )
            workflow_settings = read_workflow_settings(workbench, project_id)
            rewrite_workflow_artifacts(
                workbench=workbench,
                project_id=project_id,
                series_bible=series_bible,
                storyboard=storyboard,
                render_runtime=workflow_settings["render_runtime"],
                video_model=workflow_settings["video_model"],
                continuity_plan=continuity_plan,
                db=db,
            )
            project.updated_at = datetime.now(timezone.utc)
        return _project_snapshot(workbench, project)

    @app.post("/api/projects/{project_id}/storyboard/approve")
    def approve_project_storyboard(
        project_id: str,
        request: Request,
        authorized_project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        project = _lock_owned_project_after_parse(
            request=request,
            db=db,
            project_id=project_id,
            authorized_project=authorized_project,
        )
        storyboard, workflow = _creative_workflow_state(workbench, project_id)
        if not storyboard.get("shots"):
            raise HTTPException(status_code=409, detail="Storyboard has not been planned")
        missing_sections = _missing_plan_sections(workflow)
        if missing_sections:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "creative_plan_sections_incomplete",
                    "message": "All creative plan sections must be approved",
                    "missing_sections": missing_sections,
                    "plan_sections": workflow["plan_sections"],
                },
            )
        if workflow.get("phase") == "approved":
            return _project_snapshot(workbench, project)
        if workflow.get("phase") != "plan_review":
            raise HTTPException(status_code=409, detail="Storyboard is not ready for approval")

        workflow["phase"] = "approved"
        workflow["approved_at"] = datetime.now(timezone.utc).isoformat()
        workflow["revision_session"] = None
        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project_id,
            operation="approve_storyboard",
            changed_paths=["artifacts/creative_workflow.json"],
            failure_detail="Storyboard approval could not be saved",
        ):
            workbench.write_artifact(project_id, "creative_workflow.json", workflow)
            project.updated_at = datetime.now(timezone.utc)
        return _project_snapshot(workbench, project)

    @app.post(
        "/api/projects/import",
        status_code=201,
        openapi_extra=_json_request_openapi(ProjectImportRequest),
    )
    async def import_project(
        request: Request,
        workbench: WorkbenchStore = Depends(get_store),
        current: CurrentUser = Depends(require_csrf),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        payload = await parse_json_request(
            request,
            ProjectImportRequest,
            max_bytes=MAX_IMPORT_ARTIFACT_BYTES,
            oversized_detail="Imported project JSON is too large",
        )
        if payload.artifact_size_bytes() > MAX_IMPORT_ARTIFACT_BYTES:
            raise HTTPException(status_code=413, detail="Imported project JSON is too large")
        project = ProjectRepository(db).create(
            owner_user_id=current.id,
            title=payload.title,
            mode="short_drama",
            project_type=payload.project_type,
        )
        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project.id,
            operation="import",
            changed_paths=[],
            failure_detail="Project import failed",
            new_workspace=True,
        ):
            artifacts = payload.artifact_payloads()
            for filename, artifact in artifacts.items():
                workbench.write_artifact(project.id, filename, artifact)
            workbench.write_artifact(
                project.id,
                "creative_workflow.json",
                _default_creative_workflow(artifacts["episode_storyboard.json"]),
            )
            workbench.write_asset_library(
                project.id,
                list(artifacts["series_bible.json"]["assets"]),
            )
            if payload.generation_execution is not None:
                ledger = GenerationUnitService(db)
                try:
                    ledger.import_snapshot(
                        project_id=project.id,
                        snapshot=payload.generation_execution,
                        storyboard=artifacts["episode_storyboard.json"],
                    )
                except GenerationUnitLedgerError as exc:
                    raise HTTPException(
                        status_code=422,
                        detail={
                            "code": exc.code,
                            "message": exc.message,
                            **exc.details,
                        },
                    ) from None
                write_generation_execution_snapshot(
                    workbench=workbench,
                    snapshot=ledger.snapshot(project.id),
                )
        return _project_snapshot(workbench, project)

    @app.post(
        "/api/projects/short-drama",
        openapi_extra=_json_request_openapi(ShortDramaRequest),
    )
    async def create_short_drama_project(
        request: Request,
        workbench: WorkbenchStore = Depends(get_store),
        current: CurrentUser = Depends(require_csrf),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
        newapi: NewApiClient = Depends(get_newapi_client),
    ) -> dict[str, Any]:
        payload = await parse_json_request(request, ShortDramaRequest)
        if payload.billing_job_id is None:
            project = ProjectRepository(db).create(
                owner_user_id=current.id,
                title=payload.title,
                mode="short_drama",
                project_type=payload.project_type,
            )
        else:
            billed_job = db.query(GenerationJob).filter(
                GenerationJob.id == payload.billing_job_id,
                GenerationJob.user_id == current.id,
                GenerationJob.operation == "storyboard_generation",
            ).one_or_none()
            if billed_job is None:
                raise HTTPException(status_code=404, detail="Billing job not found")
            project = ProjectRepository(db).require_owned(
                billed_job.project_id, current.id
            )
        try:
            result = generate_short_drama_storyboard(
                db=db,
                newapi=newapi,
                settings=settings,
                media_store=workbench,
                user_id=current.id,
                project_id=project.id,
                title=payload.title,
                prompt=payload.prompt,
                model=payload.text_model,
                shot_count=payload.shot_count,
                project_type=payload.project_type,
                billing_job_id=payload.billing_job_id,
            )
        except _BILLING_CONTROL_ERRORS:
            if payload.billing_job_id is None:
                has_child = db.query(GenerationJob.id).filter(
                    GenerationJob.project_id == project.id,
                    GenerationJob.chargeable.is_(True),
                ).first()
                if has_child is None:
                    db.rollback()
            raise
        except Exception as exc:
            db.rollback()
            raise HTTPException(status_code=502, detail=STORYBOARD_GENERATION_FAILED) from exc

        result["consistency_report"] = evaluate_storyboard_consistency(
            result["series_bible"],
            result["storyboard"],
        )
        apply_consistency_scores(result["storyboard"], result["consistency_report"])

        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project.id,
            operation="create_short_drama",
            changed_paths=[],
            failure_detail="Project creation failed",
            new_workspace=not workbench.project_dir(project.id).exists(),
        ):
            continuity_plan = _merge_generated_continuity(
                _default_continuity_plan(payload.project_type),
                result["series_bible"],
                inherit_generation_preferences=True,
                generated_continuity=result.get("continuity_plan"),
            )
            _persist_storyboard_state(
                workbench=workbench,
                project_id=project.id,
                storyboard=result["storyboard"],
                series_bible=result["series_bible"],
                consistency_report=result["consistency_report"],
            )
            workbench.write_artifact(project.id, "continuity_plan.json", continuity_plan)
            workbench.write_artifact(
                project.id,
                "creative_workflow.json",
                _planned_creative_workflow(
                    result["series_bible"],
                    text_model=payload.text_model,
                ),
            )
            rewrite_workflow_artifacts(
                workbench=workbench,
                project_id=project.id,
                series_bible=result["series_bible"],
                storyboard=result["storyboard"],
                render_runtime="ffmpeg",
                video_model=payload.video_model,
                continuity_plan=continuity_plan,
                db=db,
            )
        return _project_snapshot(workbench, project)

    @app.get("/api/projects", response_model=ProjectListResponse)
    def list_projects(
        current: CurrentUser = Depends(require_user),
        db: Session = Depends(get_db),
    ) -> ProjectListResponse:
        projects = ProjectRepository(db).list(current.id)
        return ProjectListResponse(
            projects=[ProjectResponse.model_validate(project) for project in projects]
        )

    @app.get("/api/projects/latest")
    def get_latest_project(
        current: CurrentUser = Depends(require_user),
    ) -> dict[str, Any]:
        if PUBLIC_DISABLE_GLOBAL_LATEST:
            raise HTTPException(status_code=404, detail="Global latest project is disabled")
        raise HTTPException(status_code=404, detail="Global latest project is disabled")

    @app.get("/api/projects/{project_id}")
    def get_project(
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_reader)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
    ) -> dict[str, Any]:
        if settings.generation_units_v2:
            _require_generation_units_v2(
                db=db,
                settings=settings,
                client_contract_version=GENERATION_UNITS_CONTRACT_VERSION,
            )
            storyboard = workbench.read_artifact(
                project_id, "episode_storyboard.json"
            )
            if isinstance(storyboard, dict):
                try:
                    ledger = _backfill_legacy_generation_units(
                        workbench=workbench,
                        project_id=project_id,
                        storyboard=storyboard,
                        db=db,
                    )
                except GenerationUnitLedgerError as exc:
                    db.rollback()
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": exc.code,
                            "message": exc.message,
                            **exc.details,
                        },
                    ) from None
        snapshot = _project_snapshot(workbench, project)
        snapshot["production"] = _production_snapshot(workbench, project, db)
        return snapshot

    @app.delete("/api/projects/{project_id}", status_code=204)
    def delete_project(
        project_id: str,
        current: CurrentUser = Depends(require_csrf),
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> Response:
        projects = ProjectRepository(db)
        locked_project = projects.get_owned_for_update(project_id, current.id)
        if locked_project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        MediaAssetRepository(db, workbench).rehome_linked_assets_before_project_delete(
            project_id=project_id,
            owner_user_id=current.id,
        )
        project = projects.delete_owned(project_id, current.id)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        deleted_project_id = project.id
        try:
            db.commit()
        except Exception:
            _rollback_quietly(db)
            raise HTTPException(
                status_code=500,
                detail="Project deletion failed",
            ) from None
        try:
            workbench.delete_project_workspace(deleted_project_id)
        except Exception:
            project_delete_logger.error(
                "project workspace cleanup failed project_id=%s",
                deleted_project_id,
            )
        return Response(status_code=204)

    @app.patch(
        "/api/projects/{project_id}/continuity",
        openapi_extra=_json_request_openapi(ContinuityPlan),
    )
    async def save_continuity_plan(
        request: Request,
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        payload = await parse_json_request(request, ContinuityPlan)
        project = _lock_owned_project_after_parse(
            request=request,
            db=db,
            project_id=project_id,
            authorized_project=project,
        )
        plan = payload.model_dump()
        plan["project_type"] = project.project_type
        if project.project_type == "single_video":
            plan["active_episode_number"] = None
        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project_id,
            operation="continuity",
            changed_paths=WORKFLOW_ARTIFACT_PATHS,
            failure_detail="Project update failed",
        ):
            workbench.write_artifact(project_id, "continuity_plan.json", plan)
            series_bible = workbench.read_artifact(project_id, "series_bible.json")
            storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
            if series_bible is not None and storyboard is not None:
                workflow_settings = read_workflow_settings(workbench, project_id)
                rewrite_workflow_artifacts(
                    workbench=workbench,
                    project_id=project_id,
                    series_bible=series_bible,
                    storyboard=storyboard,
                    render_runtime=workflow_settings["render_runtime"],
                    video_model=_continuity_video_model(plan),
                    continuity_plan=plan,
                    db=db,
                )
            project.updated_at = datetime.now(timezone.utc)
        return {"project": _project_data(project), "continuity_plan": plan}

    @app.post(
        "/api/projects/{project_id}/assets/upload",
        openapi_extra=_upload_request_openapi(),
    )
    async def upload_reference_image(
        request: Request,
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        async with _bounded_upload_form(request) as form:
            kind = _form_text(form, "kind", max_length=32)
            label = _form_text(form, "label", max_length=255)
            description = _form_text(form, "description", default="", max_length=10_000)
            prompt = _form_text(form, "prompt", default="", max_length=10_000)
            upload = form.get("file")
            if not isinstance(upload, UploadFile):
                raise HTTPException(status_code=422, detail="file is required")
            if kind not in {"character", "scene", "prop"}:
                raise HTTPException(status_code=422, detail="Unsupported asset kind")
            suffix = validate_upload_extension(upload.filename or "", IMAGE_EXTENSIONS)
            asset_id = uuid.uuid4().hex
            project_dir = workbench.project_dir(project_id)
            output_path = safe_project_media_destination(
                project_dir,
                Path("assets") / "images" / kind,
                f"asset-{asset_id}{suffix}",
            )
            relative_path = relative_project_path(project_dir, output_path)
            project = _lock_owned_project_after_parse(
                request=request,
                db=db,
                project_id=project_id,
                authorized_project=project,
            )
            _require_approved_creative_workflow(workbench, project_id)
            series_bible = workbench.read_artifact(project_id, "series_bible.json")
            if series_bible is None:
                raise HTTPException(status_code=404, detail="Project not found")
            repository = MediaAssetRepository(db, workbench)
            with _project_mutation(
                db=db,
                workbench=workbench,
                project_id=project_id,
                operation="asset_upload",
                changed_paths=[
                    *WORKFLOW_ARTIFACT_PATHS,
                    "artifacts/asset_library.json",
                    "artifacts/series_bible.json",
                    relative_path,
                ],
                failure_detail="Project update failed",
            ):
                await save_upload_file(upload, output_path, MAX_IMAGE_BYTES)
                library_asset = repository.create_upload(
                    asset_id=asset_id,
                    owner_user_id=project.owner_user_id,
                    origin_project_id=project_id,
                    kind=kind,
                    label=label,
                    description=description,
                    prompt=prompt,
                    storage_path=relative_path,
                )
                asset_data = compatible_asset_record(
                    library_asset,
                    project_id=project_id,
                    storage_path=relative_path,
                )
                _persist_compatible_assets(
                    db=db,
                    workbench=workbench,
                    project_id=project_id,
                    asset_records=[asset_data],
                )
                project.updated_at = datetime.now(timezone.utc)
                response_data = {
                    "media": {
                        "path": relative_path,
                        "media_url": media_download_url(project_id, relative_path),
                        "filename": Path(relative_path).name,
                        "content_type": media_content_type(output_path),
                    },
                    "asset": _decorate_asset_media(project_id, project_dir, asset_data),
                    "library_asset": repository.serialize(library_asset),
                }
        return response_data

    @app.post("/api/projects/{project_id}/assets/{asset_id}/add")
    def add_library_asset_to_project(
        project_id: str,
        asset_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        _require_approved_creative_workflow(workbench, project_id)
        repository = MediaAssetRepository(db, workbench)
        library_asset = repository.get_owned(asset_id, project.owner_user_id)
        if library_asset is None:
            raise HTTPException(status_code=404, detail="Asset not found")
        origin_project = ProjectRepository(db).get_owned_for_read(
            library_asset.origin_project_id,
            project.owner_user_id,
        )
        if origin_project is None:
            raise HTTPException(status_code=404, detail="Asset not found")

        source_project_dir = workbench.project_dir(library_asset.origin_project_id)
        source_path = safe_project_media_file(
            source_project_dir, library_asset.storage_path
        )
        if not source_path.is_file():
            raise HTTPException(status_code=409, detail="Asset media is missing")
        target_project_dir = workbench.project_dir(project_id)
        if library_asset.origin_project_id == project_id:
            target_path = source_path
            target_relative = library_asset.storage_path
        else:
            target_path = safe_project_media_destination(
                target_project_dir,
                Path("assets") / "images" / library_asset.kind,
                f"{library_asset.id}{source_path.suffix.lower()}",
            )
            target_relative = relative_project_path(target_project_dir, target_path)

        existing = next(
            (
                asset
                for asset in workbench.read_asset_library(project_id)
                if isinstance(asset, dict) and asset.get("id") == library_asset.id
            ),
            None,
        )
        changed_paths = [
            *WORKFLOW_ARTIFACT_PATHS,
            "artifacts/asset_library.json",
            "artifacts/series_bible.json",
        ]
        needs_copy = (
            library_asset.origin_project_id != project_id and not target_path.is_file()
        )
        if needs_copy:
            changed_paths.append(target_relative)
        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project_id,
            operation="add_library_asset",
            changed_paths=changed_paths,
            failure_detail="Asset could not be added",
        ):
            if needs_copy:
                copy_media_file_atomic(source_path, target_path)
            repository.ensure_project_link(
                asset_id=library_asset.id,
                project_id=project_id,
                storage_path=target_relative,
            )
            if existing is None:
                asset_record = compatible_asset_record(
                    library_asset,
                    project_id=project_id,
                    storage_path=target_relative,
                )
                persisted = _persist_compatible_assets(
                    db=db,
                    workbench=workbench,
                    project_id=project_id,
                    asset_records=[asset_record],
                )[0]
            else:
                persisted = existing
            project.updated_at = datetime.now(timezone.utc)
        return {
            "asset": _decorate_asset_media(project_id, target_project_dir, persisted),
            "library_asset": repository.serialize(library_asset),
        }

    @app.get("/api/projects/{project_id}/media/{relative_path:path}")
    def project_media(
        project_id: str,
        relative_path: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_reader)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> FileResponse:
        project_dir = workbench.project_dir(project_id)
        media_path = safe_project_media_file(project_dir, relative_path)
        canonical_relative = media_path.relative_to(project_dir.resolve()).as_posix()
        if ".hidden" in Path(canonical_relative).parts or canonical_relative.startswith(".billing-results/"):
            raise HTTPException(status_code=404, detail="Media file not found")
        generated = _GENERATED_IMAGE_PATH.fullmatch(canonical_relative)
        if generated is not None:
            job = db.query(GenerationJob).filter(
                GenerationJob.id == generated.group(1),
                GenerationJob.project_id == project.id,
                GenerationJob.user_id == project.owner_user_id,
                GenerationJob.capability == "image",
                GenerationJob.result_visible.is_(True),
            ).one_or_none()
            if job is None:
                raise HTTPException(status_code=404, detail="Media file not found")
        generated_video = _GENERATED_VIDEO_PATH.fullmatch(canonical_relative)
        if generated_video is not None:
            shot_id = generated_video.group(1)
            jobs = db.query(GenerationJob).filter(
                GenerationJob.project_id == project.id,
                GenerationJob.user_id == project.owner_user_id,
                GenerationJob.capability == "video",
                GenerationJob.operation == f"shot:{shot_id}",
            ).all()
            if jobs:
                storyboard = workbench.read_artifact(
                    project_id, "episode_storyboard.json"
                )
                shot = next(
                    (
                        item
                        for item in (storyboard or {}).get("shots", [])
                        if isinstance(item, dict)
                        and str(item.get("id")) == shot_id
                    ),
                    None,
                )
                authorized = False
                if (
                    shot is not None
                    and sanitize_project_path(
                        project_dir, shot.get("output_path")
                    )
                    == canonical_relative
                ):
                    for job in jobs:
                        if job.status != "billed" or not job.result_visible:
                            continue
                        try:
                            intent = workbench.read_video_generation_intent(
                                project_id, job.id
                            )
                        except ValueError:
                            continue
                        if (
                            intent.project_id == project_id
                            and intent.job_id == job.id
                            and intent.shot_id == shot_id
                        ):
                            authorized = True
                            break
                if not authorized:
                    raise HTTPException(status_code=404, detail="Media file not found")
        if not media_path.exists():
            raise HTTPException(status_code=404, detail="Media file not found")
        return FileResponse(media_path, media_type=media_content_type(media_path))

    @app.patch(
        "/api/projects/{project_id}/shots/{shot_id}",
        openapi_extra=_json_request_openapi(ShotSaveRequest),
    )
    async def save_shot(
        request: Request,
        project_id: str,
        shot_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        bus: EventBus = Depends(get_events),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        payload = await parse_json_request(request, ShotSaveRequest)
        project = _lock_owned_project_after_parse(
            request=request,
            db=db,
            project_id=project_id,
            authorized_project=project,
        )
        _require_approved_creative_workflow(workbench, project_id)
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
        if storyboard is None or series_bible is None:
            raise HTTPException(status_code=404, detail="Project not found")
        job_id = uuid.uuid4().hex
        try:
            previous_shot = next(
                (
                    item
                    for item in storyboard.get("shots", [])
                    if item.get("id") == shot_id
                ),
                None,
            )
            previous_version = previous_shot.get("version") if previous_shot else None
            shot = update_mock_shot(storyboard, shot_id, edits=payload.model_dump(exclude_unset=True))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        report = evaluate_storyboard_consistency(series_bible, storyboard)
        has_rendered_video = bool(shot.get("output_path") or shot.get("output_url"))
        if (
            previous_version is not None
            and shot.get("version") != previous_version
            and not has_rendered_video
        ):
            mark_shot_continuity_stale(storyboard.get("shots", []), shot_id=shot_id)
            MediaAssetRepository(db, workbench).mark_all_video_frames_stale(
                origin_project_id=project_id,
                shot_id=shot_id,
            )
            _mark_compatible_video_frames_stale(
                series_bible.get("assets", []),
                shot_id=shot_id,
            )
        apply_consistency_scores(storyboard, report)
        series_bible["assets"] = sync_asset_shot_ids(series_bible.get("assets", []), storyboard)
        workflow_settings = read_workflow_settings(workbench, project_id)
        continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project_id,
            operation="shot_save",
            changed_paths=[*STORYBOARD_ARTIFACT_PATHS, *WORKFLOW_ARTIFACT_PATHS],
            failure_detail="Project update failed",
        ):
            _persist_storyboard_state(
                workbench=workbench,
                project_id=project_id,
                storyboard=storyboard,
                series_bible=series_bible,
                consistency_report=report,
            )
            rewrite_workflow_artifacts(
                workbench=workbench,
                project_id=project_id,
                series_bible=series_bible,
                storyboard=storyboard,
                render_runtime=workflow_settings["render_runtime"],
                video_model=workflow_settings["video_model"],
                continuity_plan=continuity_plan,
                db=db,
            )
            project.updated_at = datetime.now(timezone.utc)
        event = bus.emit(project_id, job_id=job_id, stage="save", status="complete", message="Shot saved")
        return {"job_id": job_id, "event": event, "shot": shot, "storyboard": storyboard, "consistency_report": report}

    @app.post(
        "/api/projects/{project_id}/prompt-optimize",
        response_model=PromptOptimizeResponse,
        openapi_extra=_json_request_openapi(PromptOptimizeRequest),
    )
    async def optimize_prompt(
        request: Request,
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
        newapi: NewApiClient = Depends(get_newapi_client),
    ) -> PromptOptimizeResponse:
        payload = await parse_json_request(request, PromptOptimizeRequest)
        try:
            result = optimize_text_prompt(
                db=db,
                newapi=newapi,
                settings=settings,
                media_store=workbench,
                user_id=project.owner_user_id,
                project_id=project_id,
                source_text=payload.source_text,
                model=payload.text_model,
                context={
                    "target": payload.target,
                    "target_id": payload.target_id,
                    "mode": payload.mode,
                    "asset_kind": payload.asset_kind,
                },
                billing_job_id=payload.billing_job_id,
            )
            return PromptOptimizeResponse(project_id=project_id, model=payload.text_model, **result)
        except (
            PaymentRequiredQuote,
            ProviderResultPending,
            ProviderResultUnavailable,
            ProviderPricingUnavailable,
            ProviderPricingUnstable,
            NewApiCallError,
            NewApiRateLimited,
        ):
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail=PROMPT_OPTIMIZATION_FAILED) from exc

    @app.post(
        "/api/projects/{project_id}/generation-plan/preview",
        response_model=GenerationPlan,
    )
    def preview_generation_plan(
        project_id: str,
        payload: GenerationPlanPreviewRequest,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
        newapi: NewApiClient = Depends(get_newapi_client),
    ) -> GenerationPlan:
        if settings.generation_units_v2 or payload.contract_version is not None:
            _require_generation_units_v2(
                db=db,
                settings=settings,
                client_contract_version=payload.contract_version,
            )
        _require_approved_creative_workflow(workbench, project_id)
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
        creative_workflow = workbench.read_artifact(
            project_id, "creative_workflow.json"
        ) or {}
        if not isinstance(storyboard, dict) or not isinstance(series_bible, dict):
            raise HTTPException(status_code=404, detail="Project not found")
        text_model = (
            payload.text_model
            or creative_workflow.get("text_model")
            or settings.newapi_planning_text_model
        )
        scoped = _storyboard_for_scope(
            storyboard,
            _render_scope(project.project_type, continuity_plan),
        )
        protected_units: list[dict[str, Any]] = []
        if settings.generation_units_v2:
            if payload.confirmed_strategy == "accept_model_duration":
                raise HTTPException(
                    status_code=422,
                    detail={
                        "code": "generation_plan_confirmation_strategy_invalid",
                        "message": "Use accept_longer_duration to confirm a v2 plan",
                    },
                )
            regeneration_ids = set(payload.regenerate_unit_ids)
            try:
                ledger = _backfill_legacy_generation_units(
                    workbench=workbench,
                    project_id=project_id,
                    storyboard=scoped,
                    db=db,
                    include_storyboard_outputs=False,
                )
                if regeneration_ids:
                    replaceable_ids = {
                        record.id
                        for record in ledger.repository.list_active(project_id)
                        if record.status == "complete"
                    }
                    unknown = sorted(regeneration_ids - replaceable_ids)
                    if unknown:
                        raise HTTPException(
                            status_code=422,
                            detail={
                                "code": "regeneration_units_invalid",
                                "generation_unit_ids": unknown,
                            },
                        )
                protected_units = ledger.protected_units(
                    project_id=project_id,
                    storyboard=scoped,
                    selected_shot_ids=payload.shot_ids,
                    allow_stale_unit_ids=payload.regenerate_unit_ids,
                )
            except GenerationUnitLedgerError as exc:
                raise HTTPException(
                    status_code=409,
                    detail={"code": exc.code, "message": exc.message, **exc.details},
                ) from None
        try:
            plan = build_generation_plan(
                storyboard=scoped,
                model_id=payload.video_model,
                shot_ids=payload.shot_ids,
                target_duration_seconds=_creative_target_duration(creative_workflow),
                operation=payload.operation,
                protected_units=protected_units,
                requested_regeneration_unit_ids=payload.regenerate_unit_ids,
                confirmed_strategy=payload.confirmed_strategy,
                profile_resolver=VideoModelDurationService(db).effective_profile,
                confirmed_beats=(
                    creative_workflow.get("brief", {}).get("narrative_beats")
                    if isinstance(creative_workflow.get("brief"), dict)
                    else None
                ),
                series_bible=series_bible,
                adaptation_planner=_preview_generation_adaptation_planner(
                    workbench=workbench,
                    project_id=project_id,
                    db=db,
                    newapi=newapi,
                    settings=settings,
                    owner_user_id=project.owner_user_id,
                    text_model=text_model,
                    billing_job_ids=payload.adaptation_billing_job_ids,
                ),
            )
        except VideoGenerationAdaptationError as exc:
            raise HTTPException(
                status_code=422,
                detail={"code": exc.code, "message": exc.message},
            ) from None
        except ValueError as exc:
            raise HTTPException(
                status_code=422,
                detail={"code": "generation_plan_shots_invalid", "message": str(exc)},
            ) from None
        # Keep the planner model with the project so a refresh or a later
        # submission continues using the model explicitly selected by the user.
        if creative_workflow.get("text_model") != text_model:
            creative_workflow["text_model"] = text_model
            workbench.write_artifact(
                project_id,
                "creative_workflow.json",
                creative_workflow,
            )
        if settings.generation_units_v2:
            _write_generation_plan_candidate(
                workbench=workbench,
                project_id=project_id,
                candidate=GenerationPlanCandidate(
                    request={
                        "contract_version": GENERATION_UNITS_CONTRACT_VERSION,
                        "provider": "newapi",
                        "video_model": payload.video_model,
                        "operation": payload.operation,
                        "shot_ids": payload.shot_ids,
                        "regenerate_unit_ids": payload.regenerate_unit_ids,
                        "confirmed_strategy": payload.confirmed_strategy,
                        "text_model": text_model,
                        "target_duration_seconds": _creative_target_duration(
                            creative_workflow
                        ),
                    },
                    generation_plan=plan,
                ),
            )
        else:
            with _project_mutation(
                db=db,
                workbench=workbench,
                project_id=project_id,
                operation="preview_generation_plan",
                changed_paths=["artifacts/generation_plan.json"],
                failure_detail="Generation plan preview could not be saved",
            ):
                workbench.write_artifact(
                    project_id,
                    "generation_plan.json",
                    plan.model_dump(mode="json"),
                )
        return plan

    @app.post(
        "/api/projects/{project_id}/generation-units/generate",
        status_code=202,
        response_model=TaskAcceptedResponse,
    )
    def generate_generation_units(
        project_id: str,
        payload: GenerationUnitsGenerateRequest,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
    ) -> TaskAcceptedResponse:
        _require_generation_units_v2(
            db=db,
            settings=settings,
            client_contract_version=payload.contract_version,
        )
        _require_approved_creative_workflow(workbench, project_id)
        candidate = _read_generation_plan_candidate(
            workbench=workbench,
            project_id=project_id,
            plan_id=payload.generation_plan_id,
        )
        task_service = TaskService(db, events)
        existing = task_service.find_owned_by_idempotency(
            project.owner_user_id,
            project_id,
            payload.idempotency_key,
        )
        if existing is not None:
            original = existing.request_snapshot.get("snapshot")
            if (
                existing.task_type != "generation_unit_video.generate"
                or not isinstance(original, dict)
                or original.get("generation_plan_id") != payload.generation_plan_id
                or original.get("generation_unit_ids")
                != payload.generation_unit_ids
            ):
                raise HTTPException(
                    status_code=409,
                    detail={"code": "idempotency_conflict"},
                )
            ledger = GenerationUnitService(db)
            existing_items = list(
                db.scalars(
                    select(TaskItem).where(TaskItem.batch_id == existing.id)
                )
            )
            ledger.attach_task_items(
                project_id=project_id, task_items=existing_items
            )
            db.commit()
            try:
                write_generation_execution_snapshot(
                    workbench=workbench,
                    snapshot=ledger.snapshot(project_id),
                )
            except Exception:
                generation_unit_logger.exception(
                    "generation execution snapshot export failed project_id=%s",
                    project_id,
                )
            task = task_service.batch_response(existing, include_items=True)
            return TaskAcceptedResponse(
                task_id=existing.id,
                status=existing.status,
                deduplicated=True,
                task=task,
            )
        request_snapshot = candidate.request
        if (
            request_snapshot.get("contract_version")
            != GENERATION_UNITS_CONTRACT_VERSION
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "generation_units_contract_incompatible",
                    "expected_contract_version": (
                        GENERATION_UNITS_CONTRACT_VERSION
                    ),
                    "received_contract_version": request_snapshot.get(
                        "contract_version"
                    ),
                },
            )
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
        creative_workflow = workbench.read_artifact(
            project_id, "creative_workflow.json"
        ) or {}
        if not isinstance(storyboard, dict) or not isinstance(series_bible, dict):
            raise HTTPException(status_code=404, detail="Project not found")
        candidate_text_model = request_snapshot.get("text_model")
        scoped = _storyboard_for_scope(
            storyboard,
            _render_scope(project.project_type, continuity_plan),
        )
        shot_ids = request_snapshot.get("shot_ids")
        regeneration_ids = request_snapshot.get("regenerate_unit_ids") or []
        if not isinstance(shot_ids, list) or not all(
            isinstance(shot_id, str) for shot_id in shot_ids
        ) or not isinstance(regeneration_ids, list):
            raise HTTPException(
                status_code=409,
                detail={"code": "generation_plan_stale", "reason": "candidate_invalid"},
            )
        ledger = GenerationUnitService(db)
        try:
            protected_units = ledger.protected_units(
                project_id=project_id,
                storyboard=scoped,
                selected_shot_ids=shot_ids,
            )
            current_plan = build_generation_plan(
                storyboard=scoped,
                provider=str(request_snapshot.get("provider") or "newapi"),
                model_id=str(request_snapshot.get("video_model") or ""),
                operation=request_snapshot.get("operation"),
                shot_ids=shot_ids,
                target_duration_seconds=_creative_target_duration(creative_workflow),
                protected_units=protected_units,
                requested_regeneration_unit_ids=regeneration_ids,
                confirmed_strategy=request_snapshot.get("confirmed_strategy"),
                profile_resolver=VideoModelDurationService(db).effective_profile,
                confirmed_beats=(
                    creative_workflow.get("brief", {}).get("narrative_beats")
                    if isinstance(creative_workflow.get("brief"), dict)
                    else None
                ),
                series_bible=series_bible,
                adaptation_planner=_cached_generation_adaptation_planner(
                    workbench=workbench,
                    project_id=project_id,
                    # Candidates created before text-model propagation use the
                    # legacy cache key; new candidates carry the selected model.
                    text_model=(
                        candidate_text_model
                        if isinstance(candidate_text_model, str)
                        else None
                    ),
                ),
            )
        except (GenerationUnitLedgerError, ValueError) as exc:
            detail = {
                "code": "generation_plan_stale",
                "reason": getattr(exc, "code", "rebuild_failed"),
                "message": str(exc),
            }
            raise HTTPException(status_code=409, detail=detail) from None
        if (
            current_plan.id != payload.generation_plan_id
            or current_plan.model_dump(mode="json")
            != candidate.generation_plan.model_dump(mode="json")
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "generation_plan_stale",
                    "reason": "authoritative_inputs_changed",
                    "generation_plan": current_plan.model_dump(mode="json"),
                },
            )
        if current_plan.requires_confirmation:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "generation_plan_confirmation_required",
                    "generation_plan": current_plan.model_dump(mode="json"),
                },
            )
        if not current_plan.can_generate:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "generation_plan_blocked",
                    "generation_plan": current_plan.model_dump(mode="json"),
                },
            )
        expected_unit_ids = [
            unit.id
            for unit in current_plan.generation_units
            if unit.status == "planned"
        ]
        if payload.generation_unit_ids != expected_unit_ids:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "generation_plan_selection_invalid",
                    "expected_generation_unit_ids": expected_unit_ids,
                },
            )
        mode = _task_submission_mode(db, project_id)
        if mode == "v1":
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "generation_submission_mode_conflict",
                    "existing_mode": "v1",
                    "requested_mode": "v2",
                },
            )
        try:
            ledger.stage_plan_units(
                project_id=project_id,
                plan=current_plan,
                generation_unit_ids=payload.generation_unit_ids,
                storyboard=scoped,
            )
            request_payload = _generation_unit_task_request(
                project_id=project_id,
                plan=current_plan,
                storyboard=scoped,
                series_bible=series_bible,
                project_aspect_ratio=str(
                    (
                        creative_workflow.get("brief")
                        if isinstance(creative_workflow.get("brief"), dict)
                        else {}
                    ).get("aspect_ratio")
                    or "9:16"
                ),
                generation_unit_ids=payload.generation_unit_ids,
                idempotency_key=payload.idempotency_key,
            )
            batch, deduplicated = task_service.submit(
                owner_user_id=project.owner_user_id,
                project_id=project_id,
                request=request_payload,
            )
        except GenerationUnitLedgerError as exc:
            db.rollback()
            raise HTTPException(
                status_code=409,
                detail={"code": exc.code, "message": exc.message, **exc.details},
            ) from None
        except TaskConflict as exc:
            raise HTTPException(
                status_code=409,
                detail=_task_conflict_detail(exc),
            ) from None
        submitted_items = list(
            db.scalars(select(TaskItem).where(TaskItem.batch_id == batch.id))
        )
        ledger.attach_task_items(project_id=project_id, task_items=submitted_items)
        db.commit()
        try:
            write_generation_execution_snapshot(
                workbench=workbench,
                snapshot=ledger.snapshot(project_id),
            )
        except Exception:
            generation_unit_logger.exception(
                "generation execution snapshot export failed project_id=%s",
                project_id,
            )
        task_worker.notify()
        task = task_service.batch_response(batch, include_items=True)
        return TaskAcceptedResponse(
            task_id=batch.id,
            status=batch.status,
            deduplicated=deduplicated,
            task=task,
        )

    @app.post(
        "/api/projects/{project_id}/shots/generate",
        status_code=202,
        response_model=TaskAcceptedResponse,
    )
    def generate_storyboard_shots(
        project_id: str,
        payload: ShotBatchGenerateRequest,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
    ) -> TaskAcceptedResponse:
        _require_approved_creative_workflow(workbench, project_id)
        submission_mode = _task_submission_mode(db, project_id)
        if submission_mode == "v2" and not settings.generation_units_v2:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "generation_submission_mode_conflict",
                    "existing_mode": "v2",
                    "requested_mode": "v1",
                },
            )
        if settings.generation_units_v2:
            _require_generation_units_v2(
                db=db,
                settings=settings,
                client_contract_version=GENERATION_UNITS_CONTRACT_VERSION,
            )
        # Keep the pre-v2 native-duration confirmation compatible for single-shot
        # callers; multi-shot plans must use the generation-units endpoint.
        legacy_native_duration_submission = False
        if (
            settings.generation_units_v2
            and payload.duration_strategy == "accept_model_duration"
        ):
            if payload.generation_plan_id is None:
                legacy_native_duration_submission = len(payload.shot_ids) == 1
            else:
                legacy_candidate = _read_generation_plan_candidate(
                    workbench=workbench,
                    project_id=project_id,
                    plan_id=payload.generation_plan_id,
                )
                legacy_native_duration_submission = all(
                    len(unit.source_shot_ids) == 1
                    for unit in legacy_candidate.generation_plan.generation_units
                )
        if legacy_native_duration_submission and submission_mode == "v2":
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "generation_submission_mode_conflict",
                    "existing_mode": "v2",
                    "requested_mode": "v1",
                },
            )
        if settings.generation_units_v2 and not legacy_native_duration_submission:
            submitted_candidate: GenerationPlanCandidate | None = None
            if payload.generation_plan_id is not None:
                submitted_candidate = _read_generation_plan_candidate(
                    workbench=workbench,
                    project_id=project_id,
                    plan_id=payload.generation_plan_id,
                )
                submitted_multi_shot_units = [
                    unit.id
                    for unit in submitted_candidate.generation_plan.generation_units
                    if len(unit.source_shot_ids) != 1
                ]
                if submitted_multi_shot_units:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "generation_units_v2_required",
                            "message": (
                                "This plan contains multi-shot generation units; "
                                "submit generation unit IDs through the v2 endpoint"
                            ),
                            "generation_unit_ids": submitted_multi_shot_units,
                        },
                    )
            plan_request = GenerationPlanPreviewRequest(
                contract_version=GENERATION_UNITS_CONTRACT_VERSION,
                video_model=payload.video_model
                or _continuity_video_model(
                    workbench.read_artifact(project_id, "continuity_plan.json"),
                    None,
                ),
                shot_ids=payload.shot_ids,
                confirmed_strategy=payload.duration_strategy,
            )
            plan = preview_generation_plan(
                project_id=project_id,
                payload=plan_request,
                project=project,
                workbench=workbench,
                db=db,
                settings=settings,
            )
            multi_shot_units = [
                unit.id
                for unit in plan.generation_units
                if len(unit.source_shot_ids) != 1
            ]
            if multi_shot_units:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "generation_units_v2_required",
                        "message": (
                            "This plan contains multi-shot generation units; submit "
                            "generation unit IDs through the v2 endpoint"
                        ),
                        "generation_unit_ids": multi_shot_units,
                    },
                )
            if (
                payload.generation_plan_id is not None
                and payload.generation_plan_id != plan.id
            ):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "generation_plan_stale",
                        "generation_plan": plan.model_dump(mode="json"),
                    },
                )
            return generate_generation_units(
                project_id=project_id,
                payload=GenerationUnitsGenerateRequest(
                    generation_plan_id=plan.id,
                    generation_unit_ids=[
                        unit.id
                        for unit in plan.generation_units
                        if unit.status == "planned"
                    ],
                    idempotency_key=payload.idempotency_key,
                ),
                project=project,
                workbench=workbench,
                db=db,
                settings=settings,
            )
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
        creative_workflow = workbench.read_artifact(
            project_id, "creative_workflow.json"
        ) or {}
        if not isinstance(storyboard, dict) or not isinstance(series_bible, dict):
            raise HTTPException(status_code=404, detail="Project not found")
        video_model = _continuity_video_model(continuity_plan, payload.video_model)
        scoped_storyboard = _storyboard_for_scope(
            storyboard,
            _render_scope(project.project_type, continuity_plan),
        )
        scoped_ids = {
            str(shot["id"])
            for shot in scoped_storyboard.get("shots", [])
            if isinstance(shot, dict) and shot.get("id")
        }
        outside_scope = sorted(set(payload.shot_ids) - scoped_ids)
        if outside_scope:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "selected_shots_outside_generation_scope",
                    "shot_ids": outside_scope,
                },
            )
        service = TaskService(db, events)
        existing = service.find_owned_by_idempotency(
            project.owner_user_id,
            project_id,
            payload.idempotency_key,
        )
        if existing is not None:
            original_snapshot = existing.request_snapshot.get("snapshot")
            original_shot_ids = (
                original_snapshot.get("selected_shot_ids")
                if isinstance(original_snapshot, dict)
                else None
            )
            original_model = (
                original_snapshot.get("video_model")
                if isinstance(original_snapshot, dict)
                else None
            )
            original_plan_id = (
                original_snapshot.get("generation_plan_id")
                if isinstance(original_snapshot, dict)
                else None
            )
            original_duration_strategy = (
                original_snapshot.get("duration_strategy")
                if isinstance(original_snapshot, dict)
                else None
            )
            if (
                existing.task_type != "storyboard_video.generate"
                or not isinstance(original_shot_ids, list)
                or set(original_shot_ids) != set(payload.shot_ids)
                or (
                    payload.generation_plan_id is not None
                    and payload.generation_plan_id != original_plan_id
                )
                or payload.duration_strategy != original_duration_strategy
                or (
                    payload.video_model is not None
                    and payload.video_model != original_model
                )
            ):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "idempotency_conflict",
                        "message": (
                            "Idempotency key was already used for a different "
                            "task submission"
                        ),
                    },
                )
            task = service.batch_response(existing, include_items=True)
            return TaskAcceptedResponse(
                task_id=existing.id,
                status=existing.status,
                deduplicated=True,
                task=task,
            )
        shots_by_id = {
            str(shot["id"]): shot
            for shot in scoped_storyboard.get("shots", [])
            if isinstance(shot, dict) and shot.get("id")
        }
        try:
            generation_revisions = {
                shot_id: service.next_generation_revision(
                    owner_user_id=project.owner_user_id,
                    project_id=project_id,
                    target_entity_type="shot_video",
                    target_entity_id=shot_id,
                    target_entity_version=int(shots_by_id[shot_id].get("version") or 1),
                    model=video_model,
                )
                for shot_id in payload.shot_ids
            }
        except TaskConflict as exc:
            raise HTTPException(
                status_code=409,
                detail=_task_conflict_detail(exc),
            ) from None
        _require_video_reconciliation(db, settings)
        _require_generation_frame_dependencies(
            workbench=workbench,
            project_id=project_id,
            storyboard=scoped_storyboard,
            series_bible=series_bible,
            shot_ids=payload.shot_ids,
            allow_external_waiting=len(payload.shot_ids) > 1,
        )
        try:
            generation_plan = build_generation_plan(
                storyboard=scoped_storyboard,
                model_id=video_model,
                shot_ids=payload.shot_ids,
                target_duration_seconds=_creative_target_duration(creative_workflow),
                confirmed_strategy=payload.duration_strategy,
                profile_resolver=VideoModelDurationService(db).effective_profile,
            )
        except ValueError as exc:
            raise HTTPException(
                status_code=422,
                detail={"code": "generation_plan_shots_invalid", "message": str(exc)},
            ) from None
        request_payload, external_missing_keys = _build_shot_video_submission(
            workbench=workbench,
            project=project,
            storyboard=storyboard,
            series_bible=series_bible,
            continuity_plan=continuity_plan,
            creative_workflow=creative_workflow,
            payload=payload,
            generation_plan=generation_plan,
            generation_revisions=generation_revisions,
        )
        if len(request_payload.items) == 1 and external_missing_keys:
            dependency = request_payload.items[0].input.get("dependency") or {}
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "previous_shot_missing",
                    "message": PREVIOUS_SHOT_MISSING_MESSAGE,
                    "previous_shot_id": dependency.get("previous_shot_id"),
                },
            )
        if (
            payload.generation_plan_id is not None
            and payload.generation_plan_id != generation_plan.id
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "generation_plan_stale",
                    "generation_plan": generation_plan.model_dump(mode="json"),
                },
            )
        if generation_plan.requires_confirmation:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "generation_plan_confirmation_required",
                    "generation_plan": generation_plan.model_dump(mode="json"),
                },
            )
        if not generation_plan.can_generate:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "generation_plan_blocked",
                    "generation_plan": generation_plan.model_dump(mode="json"),
                },
            )
        workbench.write_artifact(
            project_id,
            "generation_plan.json",
            generation_plan.model_dump(mode="json"),
        )
        try:
            batch, deduplicated = service.submit(
                owner_user_id=project.owner_user_id,
                project_id=project_id,
                request=request_payload,
            )
        except TaskConflict as exc:
            raise HTTPException(
                status_code=409,
                detail=_task_conflict_detail(exc),
            ) from None
        if not deduplicated and external_missing_keys:
            submitted = service.batch_response(batch, include_items=True)
            waiting_ids = {
                item.id
                for item in submitted.items or []
                if item.idempotency_key in external_missing_keys
            }
            service.mark_external_dependency_waiting(
                batch_id=batch.id,
                item_ids=waiting_ids,
            )
            batch = service.require_owned_batch(
                batch.id, project.owner_user_id, project_id
            )
        task_worker.notify()
        task = service.batch_response(batch, include_items=True)
        return TaskAcceptedResponse(
            task_id=batch.id,
            status=batch.status,
            deduplicated=deduplicated,
            task=task,
        )

    @app.post(
        "/api/projects/{project_id}/shots/{shot_id}/regenerate",
        status_code=202,
        response_model=TaskAcceptedResponse,
        openapi_extra=_json_request_openapi(ShotRegenerateRequest),
    )
    async def regenerate_shot(
        request: Request,
        project_id: str,
        shot_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
    ) -> TaskAcceptedResponse:
        payload = await parse_json_request(request, ShotRegenerateRequest)
        _require_approved_creative_workflow(workbench, project_id)
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        shot = next(
            (
                item
                for item in (storyboard or {}).get("shots", [])
                if isinstance(item, dict) and str(item.get("id")) == shot_id
            ),
            None,
        )
        if shot is None:
            raise HTTPException(status_code=404, detail=f"Shot '{shot_id}' not found")
        regeneration_key = payload.idempotency_key or (
            f"shot-regenerate:{shot_id}:{int(shot.get('version') or 1)}:"
            f"{uuid.uuid4().hex}"
        )
        return generate_storyboard_shots(
            project_id=project_id,
            payload=ShotBatchGenerateRequest(
                shot_ids=[shot_id],
                idempotency_key=regeneration_key,
                video_model=payload.video_model,
            ),
            project=project,
            workbench=workbench,
            db=db,
            settings=settings,
        )

    @app.post(
        "/api/projects/{project_id}/render/prepare",
        openapi_extra=_json_request_openapi(RenderProjectRequest),
    )
    async def prepare_project_render(
        request: Request,
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        payload = await parse_json_request(request, RenderProjectRequest)
        _require_approved_creative_workflow(workbench, project_id)
        migrated_duration_shot_ids = synchronize_project_video_durations(
            media_store=workbench, project_id=project_id
        )
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        if storyboard is None or series_bible is None:
            raise HTTPException(status_code=404, detail="Project not found")
        continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
        render_scope = _render_scope(project.project_type, continuity_plan)
        scoped_storyboard, selected_shot_ids = _storyboard_for_render(
            storyboard,
            render_scope,
            payload.selected_shot_ids,
        )
        if not scoped_storyboard.get("shots"):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "active_episode_storyboard_missing",
                    "episode_number": render_scope["episode_number"],
                },
            )
        production = _production_snapshot(
            workbench,
            project,
            db,
            selected_shot_ids=selected_shot_ids,
            describe_next_render=True,
        )
        active_job = production.get("active_job")
        if (
            isinstance(active_job, dict)
            and active_job.get("status") == "running"
            and not active_job.get("resume_available")
        ):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "render_in_progress",
                    "job_id": active_job.get("id"),
                },
            )
        return {
            "project_id": project_id,
            **production,
            "estimated_units": 0,
            "available_units": available_units(db, project.owner_user_id),
            "estimate_status": "not_required",
            "duration_compatibility": {
                "reprobed_shot_ids": migrated_duration_shot_ids,
                "uses_full_source_by_default": True,
            },
        }

    @app.post(
        "/api/projects/{project_id}/composition",
        status_code=202,
        response_model=TaskAcceptedResponse,
        openapi_extra=_json_request_openapi(RenderProjectRequest),
    )
    async def compose_project(
        request: Request,
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> TaskAcceptedResponse:
        payload = await parse_json_request(request, RenderProjectRequest)
        if payload.idempotency_key is None:
            raise HTTPException(
                status_code=422,
                detail={"code": "idempotency_key_required"},
            )
        project = _lock_owned_project_after_parse(
            request=request,
            db=db,
            project_id=project_id,
            authorized_project=project,
        )
        _require_approved_creative_workflow(workbench, project_id)
        synchronize_project_video_durations(
            media_store=workbench, project_id=project_id
        )
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
        creative_workflow = workbench.read_artifact(
            project_id, "creative_workflow.json"
        ) or {}
        if not isinstance(storyboard, dict) or not isinstance(series_bible, dict):
            raise HTTPException(status_code=404, detail="Project not found")
        render_scope = _render_scope(project.project_type, continuity_plan)
        scoped_storyboard, selected_shot_ids = _storyboard_for_render(
            storyboard,
            render_scope,
            payload.selected_shot_ids,
        )
        if not selected_shot_ids:
            raise HTTPException(
                status_code=409,
                detail={"code": "active_episode_storyboard_missing"},
            )
        workflow_settings = read_workflow_settings(workbench, project_id)
        render_runtime = workflow_settings["render_runtime"]
        if payload.render_runtime is not None and payload.render_runtime != render_runtime:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "render_runtime_locked",
                    "locked_runtime": render_runtime,
                    "requested_runtime": payload.render_runtime,
                },
            )
        production = _production_snapshot(
            workbench,
            project,
            db,
            selected_shot_ids=selected_shot_ids,
        )
        readiness = production["readiness"]
        if not readiness["ready"]:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "composition_not_ready",
                    "readiness": readiness,
                },
            )

        active_statuses = {
            "queued",
            "running",
            "waiting_dependency",
            "awaiting_payment",
        }
        active = (
            db.query(TaskBatch)
            .filter(
                TaskBatch.owner_user_id == project.owner_user_id,
                TaskBatch.project_id == project_id,
                TaskBatch.task_type == COMPOSITION_TASK_TYPE,
                TaskBatch.status.in_(active_statuses),
            )
            .order_by(TaskBatch.created_at.desc(), TaskBatch.id.desc())
            .first()
        )
        if active is not None:
            active_ids = (active.request_snapshot.get("snapshot") or {}).get(
                "selected_shot_ids"
            )
            if isinstance(active_ids, list) and active_ids == selected_shot_ids:
                task = TaskService(db).batch_response(active, include_items=True)
                return TaskAcceptedResponse(
                    task_id=active.id,
                    status=active.status,
                    deduplicated=True,
                    task=task,
                )
            raise HTTPException(
                status_code=409,
                detail={"code": "render_in_progress", "task_id": active.id},
            )

        project_aspect_ratio = str(
            (
                creative_workflow.get("brief")
                if isinstance(creative_workflow.get("brief"), dict)
                else {}
            ).get("aspect_ratio")
            or "9:16"
        )
        scoped_shots = [
            shot
            for shot in scoped_storyboard.get("shots", [])
            if isinstance(shot, dict)
        ]
        shot_versions = {
            str(shot["id"]): int(shot.get("version") or 1)
            for shot in scoped_shots
        }
        unit_state = _generation_unit_render_state(
            workbench=workbench,
            project_id=project_id,
            db=db,
            scoped_storyboard=scoped_storyboard,
            project_aspect_ratio=project_aspect_ratio,
        )
        if unit_state is None:
            active_units: list[VideoGenerationUnit] = []
            shot_media_paths = {
                str(shot["id"]): _usable_shot_media(
                    workbench=workbench,
                    project_id=project_id,
                    shot=shot,
                    aspect_ratio=project_aspect_ratio,
                )
                for shot in scoped_shots
            }
            generation_unit_revisions: dict[str, int] = {}
            generation_unit_media_paths: dict[str, str] = {}
            media_references = [
                {
                    "shot_id": shot_id,
                    "shot_version": shot_versions[shot_id],
                    "path": path,
                }
                for shot_id, path in shot_media_paths.items()
            ]
        else:
            active_units = unit_state["active_units"]
            shot_media_paths = {}
            generation_unit_revisions = {
                unit.id: unit.revision for unit in active_units
            }
            generation_unit_media_paths = {
                unit.id: str(unit.output_path) for unit in active_units
            }
            media_references = [
                {
                    "generation_unit_id": unit.id,
                    "generation_unit_revision": unit.revision,
                    "source_shot_ids": list(unit.source_shot_ids_json),
                    "source_beat_ids": list(unit.source_beat_ids_json),
                    "source_segment_ids": list(unit.source_segment_ids_json or []),
                    "path": str(unit.output_path),
                }
                for unit in active_units
            ]
        episode_number = render_scope["episode_number"]
        output_filename = (
            f"episode-{int(episode_number):03d}.mp4"
            if render_scope["kind"] == "episode"
            else "final.mp4"
        )
        pipeline_inputs = {
            name: workbench.read_artifact(project_id, f"{name}.json") or {}
            for name in (
                "proposal_packet",
                "scene_plan",
                "asset_manifest",
                "edit_decisions",
            )
        }
        if active_units:
            pipeline_inputs["asset_manifest"] = _generation_unit_asset_manifest(
                pipeline_inputs["asset_manifest"], active_units
            )
        render_output_spec = _render_plan_output_spec(
            creative_workflow,
            scoped_storyboard,
            _report_for_scope(
                workbench.read_artifact(project_id, "render_report.json"),
                render_scope,
            ),
        )
        frozen_snapshot = {
            "purpose": "final_composition",
            "selected_shot_ids": selected_shot_ids,
            "shot_versions": shot_versions,
            "shot_media_paths": shot_media_paths,
            "generation_unit_revisions": generation_unit_revisions,
            "generation_unit_media_paths": generation_unit_media_paths,
            "media_references": media_references,
            "storyboard": deepcopy(scoped_storyboard),
            "series_bible": deepcopy(series_bible),
            "continuity_plan": deepcopy(continuity_plan),
            "pipeline_inputs": pipeline_inputs,
            "render_scope": render_scope,
            "render_runtime": render_runtime,
            "render_output_spec": render_output_spec,
            "project_aspect_ratio": project_aspect_ratio,
            "target_duration_seconds": _creative_target_duration(
                creative_workflow
            ),
            "video_model": payload.video_model,
            "output_filename": output_filename,
        }
        fingerprint = hashlib.sha256(
            json.dumps(
                {
                    "selected_shot_ids": selected_shot_ids,
                    "shot_versions": shot_versions,
                    "shot_media_paths": shot_media_paths,
                    "generation_unit_revisions": generation_unit_revisions,
                    "generation_unit_media_paths": generation_unit_media_paths,
                    "render_runtime": render_runtime,
                    "render_output_spec": render_output_spec,
                },
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        submission = TaskSubmitRequest(
            idempotency_key=payload.idempotency_key,
            task_type=COMPOSITION_TASK_TYPE,
            project_version=1,
            snapshot=frozen_snapshot,
            items=[
                TaskItemSubmit(
                    idempotency_key=f"composition:{fingerprint[:48]}",
                    task_type=COMPOSITION_TASK_TYPE,
                    input={
                        "selected_shot_ids": selected_shot_ids,
                        "render_runtime": render_runtime,
                        "output_filename": output_filename,
                        "fingerprint": fingerprint,
                    },
                    model=render_runtime,
                    max_attempts=3,
                )
            ],
        )
        service = TaskService(db, events)
        try:
            batch, deduplicated = service.submit(
                owner_user_id=project.owner_user_id,
                project_id=project_id,
                request=submission,
            )
        except TaskConflict as exc:
            raise HTTPException(
                status_code=409,
                detail={"code": exc.code, "message": exc.message},
            ) from None
        task_worker.notify()
        task = service.batch_response(batch, include_items=True)
        return TaskAcceptedResponse(
            task_id=batch.id,
            status=batch.status,
            deduplicated=deduplicated,
            task=task,
        )

    @app.post(
        "/api/projects/{project_id}/render",
        openapi_extra=_json_request_openapi(RenderProjectRequest),
    )
    async def render_project(
        request: Request,
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        bus: EventBus = Depends(get_events),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
        newapi: NewApiClient = Depends(get_newapi_client),
    ) -> dict[str, Any]:
        payload = await parse_json_request(request, RenderProjectRequest)
        project = _lock_owned_project_after_parse(
            request=request,
            db=db,
            project_id=project_id,
            authorized_project=project,
        )
        _require_approved_creative_workflow(workbench, project_id)
        synchronize_project_video_durations(
            media_store=workbench, project_id=project_id
        )
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
        if storyboard is None or series_bible is None:
            raise HTTPException(status_code=404, detail="Project not found")
        render_scope = _render_scope(project.project_type, continuity_plan)
        scoped_storyboard, selected_shot_ids = _storyboard_for_render(
            storyboard,
            render_scope,
            payload.selected_shot_ids,
        )
        if not scoped_storyboard.get("shots"):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "active_episode_storyboard_missing",
                    "episode_number": render_scope["episode_number"],
                },
            )

        workflow_settings = read_workflow_settings(workbench, project_id)
        render_runtime = workflow_settings["render_runtime"]
        if payload.render_runtime is not None and payload.render_runtime != render_runtime:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "render_runtime_locked",
                    "locked_runtime": render_runtime,
                    "requested_runtime": payload.render_runtime,
                },
            )
        pipeline_inputs = {
            name: workbench.read_artifact(project_id, f"{name}.json") or {}
            for name in (
                "proposal_packet",
                "scene_plan",
                "asset_manifest",
                "edit_decisions",
            )
        }
        creative_workflow = workbench.read_artifact(
            project_id, "creative_workflow.json"
        ) or {}
        project_aspect_ratio = str(
            (
                creative_workflow.get("brief")
                if isinstance(creative_workflow.get("brief"), dict)
                else {}
            ).get("aspect_ratio")
            or "9:16"
        )
        unit_state = _generation_unit_render_state(
            workbench=workbench,
            project_id=project_id,
            db=db,
            scoped_storyboard=scoped_storyboard,
            project_aspect_ratio=project_aspect_ratio,
        )
        active_render_units = (
            unit_state["active_units"] if unit_state is not None else []
        )
        if unit_state is not None and unit_state["blockers"]:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "composition_not_ready",
                    "readiness": {
                        "ready": False,
                        "selected_shot_ids": selected_shot_ids,
                        "blockers": unit_state["blockers"],
                    },
                },
            )
        if active_render_units:
            pipeline_inputs["asset_manifest"] = _generation_unit_asset_manifest(
                pipeline_inputs["asset_manifest"], active_render_units
            )
        if unit_state is None:
            project_dir = workbench.project_dir(project_id)
            missing_video_operations = {
                operation_for_shot(shot)
                for shot in scoped_storyboard.get("shots", [])
                if isinstance(shot, dict)
                and not (
                    shot.get("status") != "stale"
                    and (
                        existing_output := sanitize_project_path(
                            project_dir, shot.get("output_path")
                        )
                    )
                    is not None
                    and (project_dir / existing_output).is_file()
                    and media_matches_aspect_ratio(
                        project_dir / existing_output,
                        shot.get("aspect_ratio") or project_aspect_ratio,
                    )
                )
            }
            duration_service = VideoModelDurationService(db)
            if any(
                duration_service.effective_profile(
                    payload.video_model,
                    operation,
                ).duration_mode
                == "unknown"
                for operation in missing_video_operations
            ):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "video_model_contract_unknown",
                        "message": (
                            "管理员尚未为当前视频模型配置单次生成时长，"
                            "无法创建付费生成任务。"
                        ),
                        "provider": "newapi",
                        "model_id": payload.video_model,
                        "duration_configuration_status": "unconfigured",
                    },
                )
        render_output_spec = _render_plan_output_spec(
            creative_workflow,
            scoped_storyboard,
            _report_for_scope(
                workbench.read_artifact(project_id, "render_report.json"),
                render_scope,
                accept_legacy_output=not any(
                    isinstance(shot, dict)
                    and shot.get("episode_number") is not None
                    for shot in storyboard.get("shots", [])
                ),
            ),
        )

        render_shot_versions = {
            str(shot.get("id")): shot.get("version")
            for shot in scoped_storyboard.get("shots", [])
            if isinstance(shot, dict)
        }
        render_unit_revisions = {
            unit.id: unit.revision for unit in active_render_units
        }

        try:
            if payload.billing_job_id is None:
                parent = db.query(GenerationJob).filter(
                    GenerationJob.user_id == project.owner_user_id,
                    GenerationJob.project_id == project_id,
                    GenerationJob.chargeable.is_(False),
                    GenerationJob.operation == "render",
                    GenerationJob.status == "running",
                ).order_by(GenerationJob.created_at.desc()).first()
                if parent is not None and not payload.resume_existing:
                    raise HTTPException(
                        status_code=409,
                        detail={"code": "render_in_progress", "job_id": parent.id},
                    )
                if parent is not None and payload.resume_existing:
                    recoverable = db.query(GenerationJob.id).filter(
                        GenerationJob.parent_job_id == parent.id,
                        GenerationJob.user_id == project.owner_user_id,
                        GenerationJob.project_id == project_id,
                        GenerationJob.status.in_((
                            "payment_required_quote",
                            "reference_recovery_pending",
                            "result_pending",
                            "receipt_pending",
                        )),
                    ).first()
                    shots = [
                        shot for shot in scoped_storyboard.get("shots", [])
                        if isinstance(shot, dict)
                    ]
                    project_dir = workbench.project_dir(project_id)
                    ready_for_composition = bool(shots) and (
                        not unit_state["blockers"]
                        if unit_state is not None
                        else all(
                        (
                            shot.get("status") != "stale"
                            and
                            (relative := sanitize_project_path(
                                project_dir, shot.get("output_path")
                            )) is not None
                            and (project_dir / relative).is_file()
                            and media_matches_aspect_ratio(
                                project_dir / relative,
                                shot.get("aspect_ratio") or project_aspect_ratio,
                            )
                        )
                        for shot in shots
                        )
                    )
                    if recoverable is None and not ready_for_composition:
                        raise HTTPException(
                            status_code=409,
                            detail={"code": "render_in_progress", "job_id": parent.id},
                        )
                if parent is None:
                    parent = BillingService(
                        db, settings, workbench.inspect_staged_artifact
                    ).create_parent_job(
                        user_id=project.owner_user_id,
                        project_id=project_id,
                        operation="render",
                    )
                retry_job_id = None
                retry_child = None
            else:
                retry_child = db.query(GenerationJob).filter(
                    GenerationJob.id == payload.billing_job_id,
                    GenerationJob.user_id == project.owner_user_id,
                    GenerationJob.project_id == project_id,
                    GenerationJob.status == "payment_required_quote",
                ).one_or_none()
                if retry_child is None or retry_child.parent_job_id is None:
                    raise HTTPException(status_code=404, detail="Billing job not found")
                parent = db.get(GenerationJob, retry_child.parent_job_id)
                retry_job_id = retry_child.id
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=500, detail="Project update failed") from None
        job_id = parent.id
        db.commit()

        def emit(stage: str, status: str, message: str) -> None:
            public_message = PROJECT_RENDER_FAILED if status == "failed" else message
            bus.emit(
                project_id,
                job_id=job_id,
                stage=stage,
                status=status,
                message=public_message,
            )

        project_dir = workbench.project_dir(project_id)
        episode_number = render_scope["episode_number"]
        output_filename = (
            f"episode-{int(episode_number):03d}.mp4"
            if render_scope["kind"] == "episode"
            else "final.mp4"
        )
        staged_final_path = (
            project_dir / "renders" / f".{parent.id}.{output_filename}.pending.mp4"
        )
        generated_shot_paths = []
        for shot in (
            scoped_storyboard.get("shots", [])
            if unit_state is None
            else []
        ):
            existing_output = sanitize_project_path(project_dir, shot.get("output_path"))
            if (
                shot.get("status") != "stale"
                and existing_output is not None
                and (project_dir / existing_output).exists()
                and media_matches_aspect_ratio(
                    project_dir / existing_output,
                    shot.get("aspect_ratio") or project_aspect_ratio,
                )
            ):
                continue
            generated_shot_paths.append(
                f"assets/video/{str(shot.get('id', 'shot'))}.mp4"
            )
        render_changed_paths = [
            *STORYBOARD_ARTIFACT_PATHS,
            *WORKFLOW_ARTIFACT_PATHS,
            "artifacts/render_report.json",
            "artifacts/edit_timeline.json",
            "artifacts/render_plan.json",
            "artifacts/final_review.json",
            f"renders/{output_filename}",
            *generated_shot_paths,
        ]

        def generate_missing_shot(shot: dict[str, Any]) -> dict[str, Any]:
            _require_approved_creative_workflow(workbench, project_id)
            operation = f"shot:{shot.get('id')}"
            existing = db.query(GenerationJob).filter(
                GenerationJob.parent_job_id == parent.id,
                GenerationJob.user_id == project.owner_user_id,
                GenerationJob.project_id == project_id,
                GenerationJob.capability == "video",
                GenerationJob.operation == operation,
            ).order_by(GenerationJob.created_at.desc()).first()
            child_job_id = existing.id if existing is not None else None
            if retry_child is not None and retry_child.operation == operation:
                child_job_id = retry_job_id
            return run_single_shot_generation(
                db=db,
                newapi=newapi,
                settings=settings,
                media_store=workbench,
                user_id=project.owner_user_id,
                project_id=project_id,
                parent_job_id=parent.id,
                project_dir=workbench.project_dir(project_id),
                shot=shot,
                series_bible=series_bible,
                video_model=payload.video_model,
                billing_job_id=child_job_id,
                project_aspect_ratio=project_aspect_ratio,
            )

        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project_id,
            operation="render-preflight",
            changed_paths=render_changed_paths,
            failure_detail="Project update failed",
        ):
            pass

        emit("render", "running", "Starting final render")
        try:
            result = render_short_drama_project(
                project_dir=workbench.project_dir(project_id),
                series_bible=series_bible,
                storyboard=scoped_storyboard,
                continuity_plan=continuity_plan,
                video_model=payload.video_model,
                render_runtime=render_runtime,  # type: ignore[arg-type]
                emit_event=emit,
                generate_missing_shot=generate_missing_shot,
                composition_output_path=staged_final_path,
                persist_render_report=False,
                persist_execution_artifacts=False,
                pipeline_inputs=pipeline_inputs,
                render_output_spec=render_output_spec,
                project_id=project_id,
                project_aspect_ratio=project_aspect_ratio,
                target_duration_seconds=_creative_target_duration(
                    creative_workflow
                ),
            )
        except (
            PaymentRequiredQuote,
            ProviderResultPending,
            ProviderResultUnavailable,
            ProviderPricingUnavailable,
            ProviderPricingUnstable,
            NewApiCallError,
            NewApiRateLimited,
        ):
            staged_final_path.unlink(missing_ok=True)
            raise
        except Exception as exc:
            staged_final_path.unlink(missing_ok=True)
            failed_parent = db.query(GenerationJob).filter(
                GenerationJob.id == parent.id
            ).with_for_update().one_or_none()
            if failed_parent is not None:
                failed_parent.status = "failed"
            db.commit()
            emit("render", "failed", PROJECT_RENDER_FAILED)
            raise HTTPException(status_code=500, detail=PROJECT_RENDER_FAILED) from exc

        render_stale = False
        try:
            with _project_mutation(
                db=db,
                workbench=workbench,
                project_id=project_id,
                operation="render",
                changed_paths=render_changed_paths,
                failure_detail="Project update failed",
            ):
                owner_user_id = project.owner_user_id
                project = db.query(ProjectRecord).filter(
                    ProjectRecord.id == project_id,
                    ProjectRecord.owner_user_id == owner_user_id,
                ).with_for_update().one()
                parent = db.query(GenerationJob).filter(
                    GenerationJob.id == parent.id,
                    GenerationJob.project_id == project_id,
                    GenerationJob.chargeable.is_(False),
                ).with_for_update().one()
                _require_approved_creative_workflow(workbench, project_id)
                current_storyboard = workbench.read_artifact(
                    project_id, "episode_storyboard.json"
                )
                current_continuity_plan = workbench.read_artifact(
                    project_id, "continuity_plan.json"
                )
                current_render_scope = _render_scope(
                    project.project_type,
                    current_continuity_plan,
                )
                current_versions = {
                    str(shot.get("id")): shot.get("version")
                    for shot in (current_storyboard or {}).get("shots", [])
                    if isinstance(shot, dict)
                    and str(shot.get("id")) in render_shot_versions
                }
                current_unit_revisions = {
                    unit.id: unit.revision
                    for unit in db.scalars(
                        select(VideoGenerationUnit).where(
                            VideoGenerationUnit.project_id == project_id,
                            VideoGenerationUnit.id.in_(list(render_unit_revisions)),
                            VideoGenerationUnit.active.is_(True),
                            VideoGenerationUnit.status == "complete",
                        )
                    )
                }
                render_stale = (
                    current_versions != render_shot_versions
                    or current_unit_revisions != render_unit_revisions
                    or current_render_scope != render_scope
                )
                if render_stale:
                    parent.status = "partial_failure"
                else:
                    result["storyboard"] = _merge_rendered_storyboard(
                        current_storyboard,
                        result["storyboard"],
                    )
                    final_path = project_dir / "renders" / output_filename
                    replace_atomic_output(
                        staged_final_path,
                        final_path,
                        final_path.parent.resolve(strict=True),
                    )
                    result["final_path"] = str(final_path)
                    result["render_report"]["outputs"][0]["path"] = str(
                        final_path
                    )
                    if result.get("final_review"):
                        result["final_review"]["output_path"] = str(final_path)
                        result["render_report"]["final_review_ref"] = (
                            "artifacts/final_review.json"
                        )
                    result["render_report"] = _merge_episode_render_report(
                        workbench.read_artifact(project_id, "render_report.json"),
                        result["render_report"],
                        render_scope,
                        selected_shot_ids,
                    )
                    report = evaluate_storyboard_consistency(
                        series_bible, result["storyboard"]
                    )
                    apply_consistency_scores(result["storyboard"], report)
                    workbench.write_artifact(
                        project_id,
                        "episode_storyboard.json",
                        result["storyboard"],
                    )
                    workbench.write_artifact(
                        project_id, "consistency_report.json", report
                    )
                    workbench.write_artifact(
                        project_id,
                        "render_report.json",
                        result["render_report"],
                    )
                    for artifact_name, artifact_data in (
                        ("edit_timeline.json", result.get("edit_timeline")),
                        ("render_plan.json", result.get("render_plan")),
                        ("final_review.json", result.get("final_review")),
                    ):
                        if artifact_data is not None:
                            workbench.write_artifact(
                                project_id, artifact_name, artifact_data
                            )
                    project.updated_at = datetime.now(timezone.utc)
                    parent.status = (
                        "partial_failure"
                        if result.get("partial_failure")
                        else "complete"
                    )
        finally:
            staged_final_path.unlink(missing_ok=True)
        if render_stale:
            raise ProviderResultPending("project changed during final composition")
        project_dir = workbench.project_dir(project_id)
        response_storyboard = _sanitize_storyboard_response(project_dir, result["storyboard"])
        response_render_report = _sanitize_render_report_response(project_dir, result["render_report"])
        response_final_path = sanitize_project_path(project_dir, result["final_path"])
        response_outputs = [
            _sanitize_generation_output(project_dir, output) if isinstance(output, dict) else output
            for output in result["outputs"]
        ]
        event = bus.emit(project_id, job_id=job_id, stage="render", status="complete", message="Final video rendered")
        return {
            "job_id": job_id,
            "event": event,
            "project": _project_data(project),
            "storyboard": response_storyboard,
            "consistency_report": report,
            "render_report": response_render_report,
            "final_path": response_final_path,
            "outputs": response_outputs,
            "production": _production_snapshot(workbench, project, db),
        }

    @app.get("/api/projects/{project_id}/events")
    async def project_events(
        project_id: str,
        project: Annotated[
            ProjectRecord,
            Depends(_require_owned_user, scope="function"),
        ],
        bus: EventBus = Depends(get_events),
    ) -> StreamingResponse:
        return StreamingResponse(bus.stream(project_id), media_type="text/event-stream")

    return app
