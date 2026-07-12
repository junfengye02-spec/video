from __future__ import annotations

import logging
import re
import uuid
from contextlib import asynccontextmanager, contextmanager
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, AsyncIterator, Iterator

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from python_multipart.exceptions import MultipartParseError
from redis import Redis
from sqlalchemy.orm import Session
from starlette.datastructures import FormData, UploadFile

from server.app.admin.billing_router import router as admin_billing_router
from server.app.artifact_sync import read_workflow_settings, rewrite_workflow_artifacts, sync_asset_shot_ids
from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.auth.router import get_provisioner, router as auth_router
from server.app.billing.models import GenerationJob
from server.app.billing.execution import (
    PaymentRequiredQuote,
    ProviderPricingUnstable,
    ProviderResultPending,
    ProviderResultUnavailable,
)
from server.app.billing.service import BillingService, ProviderPricingUnavailable
from server.app.core.config import AppSettings, get_settings
from server.app.consistency import apply_consistency_scores, evaluate_storyboard_consistency
from server.app.events import EventBus
from server.app.media_files import (
    IMAGE_EXTENSIONS,
    MAX_IMAGE_BYTES,
    media_content_type,
    media_download_url,
    replace_atomic_output,
    relative_project_path,
    safe_project_media_destination,
    safe_project_media_file,
    save_upload_file,
    validate_upload_extension,
)
from server.app.mock_runner import build_mock_short_drama, regenerate_mock_shot, update_mock_shot
from server.app.models import (
    ContinuityPlan,
    CredentialFreeRequest,
    ImageGenerationRequest,
    ImageGenerationResponse,
    ProjectType,
    PromptOptimizeRequest,
    PromptOptimizeResponse,
    ShotRegenerateRequest,
    ShotSaveRequest,
)
from server.app.openmontage_runner import (
    REFERENCE_IMAGE_EXTENSIONS,
    generate_billed_shot as run_single_shot_generation,
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
from server.app.provider.image_generation import generate_billed_project_image
from server.app.provider.newapi import NewApiCallError, NewApiClient, NewApiRateLimited
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
)
from server.app.storyboard_generator import (
    generate_short_drama_storyboard_billed as generate_short_drama_storyboard,
)
from server.app.storage import ProjectRecoveryRequired, WorkbenchStore
from server.app.wallet.provisioning import WalletProvisioner
from server.app.wallet.router import router as wallet_router
from server.app.wallet.service import InsufficientBalance

DEFAULT_TEXT_MODEL = "gpt-5.5"
DEFAULT_IMAGE_MODEL = "gpt-image-2"
DEFAULT_VIDEO_MODEL = "omni_flash-10s"
STORYBOARD_GENERATION_FAILED = "Text model storyboard generation failed"
PROMPT_OPTIMIZATION_FAILED = "Text model prompt optimization failed"
SHOT_GENERATION_FAILED = "Shot generation failed"
PROJECT_RENDER_FAILED = "Project render failed"
project_delete_logger = logging.getLogger("server.app.project_delete")
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


def get_newapi_client(
    settings: AppSettings = Depends(get_settings),
) -> Iterator[NewApiClient]:
    client = NewApiClient(settings)
    try:
        yield client
    finally:
        client.close()


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


def _default_continuity_plan(project_type: ProjectType | str) -> dict[str, Any]:
    plan = ContinuityPlan(project_type=project_type).model_dump()
    if project_type != "single_video":
        plan["active_episode_number"] = 1
    return plan


def _workflow_artifacts(workbench: WorkbenchStore, project_id: str) -> list[dict[str, Any]]:
    entries = [
        ("proposal_packet", "proposal_packet.json"),
        ("scene_plan", "scene_plan.json"),
        ("asset_manifest", "asset_manifest.json"),
        ("edit_decisions", "edit_decisions.json"),
        ("render_report", "render_report.json"),
        ("continuity_plan", "continuity_plan.json"),
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


def _project_snapshot(workbench: WorkbenchStore, project: ProjectRecord) -> dict[str, Any]:
    project_dir = workbench.project_dir(project.id)
    storyboard = workbench.read_artifact(project.id, "episode_storyboard.json") or {"shots": []}
    series_bible = workbench.read_artifact(project.id, "series_bible.json") or {"characters": [], "assets": []}
    series_bible = dict(series_bible)
    series_bible["assets"] = [
        _decorate_asset_media(project.id, project_dir, asset)
        for asset in series_bible.get("assets", [])
    ]
    render_report = workbench.read_artifact(project.id, "render_report.json")
    response_storyboard = _sanitize_storyboard_response(project_dir, storyboard)
    response_render_report = (
        _sanitize_render_report_response(project_dir, render_report) if render_report else None
    )
    final_path = None
    if response_render_report and response_render_report.get("outputs"):
        final_path = response_render_report["outputs"][0].get("path")
    return {
        "project": _project_data(project),
        "series_bible": series_bible,
        "storyboard": response_storyboard,
        "consistency_report": workbench.read_artifact(project.id, "consistency_report.json") or {"score": 100, "issues": []},
        "continuity_plan": workbench.read_artifact(project.id, "continuity_plan.json") or _default_continuity_plan(project.project_type),
        "workflow_artifacts": _workflow_artifacts(workbench, project.id),
        "render_report": response_render_report,
        "final_path": final_path,
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


class RenderProjectRequest(CredentialFreeRequest):
    text_model: str = DEFAULT_TEXT_MODEL
    image_model: str = DEFAULT_IMAGE_MODEL
    video_model: str = DEFAULT_VIDEO_MODEL
    render_runtime: str = "ffmpeg"
    billing_job_id: str | None = Field(default=None, min_length=32, max_length=32)


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
    async def provider_result_pending_handler(_request, _exc):
        return JSONResponse(
            status_code=409,
            content={"code": "provider_result_pending"},
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
    app.dependency_overrides[get_provisioner] = WalletProvisioner
    app.include_router(wallet_router)
    app.include_router(payment_router)
    app.include_router(admin_billing_router)
    store = WorkbenchStore(projects_root=Path(projects_root), db_path=Path(db_path))
    events = EventBus()
    app.state.store = store
    app.state.events = events

    def get_store() -> WorkbenchStore:
        return app.state.store

    def get_events() -> EventBus:
        return app.state.events

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
        response_model=ImageGenerationResponse,
        openapi_extra=_json_request_openapi(ImageGenerationRequest),
    )
    async def generate_project_image(
        request: Request,
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
        newapi: NewApiClient = Depends(get_newapi_client),
    ) -> ImageGenerationResponse:
        payload = await parse_json_request(request, ImageGenerationRequest)
        result = generate_billed_project_image(
            db=db,
            newapi=newapi,
            settings=settings,
            media_store=workbench,
            user_id=project.owner_user_id,
            project_id=project_id,
            prompt=payload.prompt,
            model=payload.model,
            count=payload.count,
            size=payload.size,
            quality=payload.quality,
            billing_job_id=payload.billing_job_id,
        )
        return ImageGenerationResponse(
            job_id=result.job_id,
            images=list(result.images),
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
                "characters": [],
                "assets": [],
            }
            storyboard = {"shots": []}
            continuity_plan = _default_continuity_plan(payload.project_type)
            consistency_report = {"score": 100, "issues": []}
            _persist_storyboard_state(
                workbench=workbench,
                project_id=project.id,
                storyboard=storyboard,
                series_bible=series_bible,
                consistency_report=consistency_report,
            )
            workbench.write_artifact(project.id, "continuity_plan.json", continuity_plan)
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
            workbench.write_asset_library(
                project.id,
                list(artifacts["series_bible.json"]["assets"]),
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
            continuity_plan = _default_continuity_plan(payload.project_type)
            _persist_storyboard_state(
                workbench=workbench,
                project_id=project.id,
                storyboard=result["storyboard"],
                series_bible=result["series_bible"],
                consistency_report=result["consistency_report"],
            )
            workbench.write_artifact(project.id, "continuity_plan.json", continuity_plan)
            rewrite_workflow_artifacts(
                workbench=workbench,
                project_id=project.id,
                series_bible=result["series_bible"],
                storyboard=result["storyboard"],
                render_runtime="ffmpeg",
                video_model=payload.video_model,
                continuity_plan=continuity_plan,
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
        raise HTTPException(status_code=404, detail="Global latest project is disabled")

    @app.get("/api/projects/{project_id}")
    def get_project(
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_reader)],
        workbench: WorkbenchStore = Depends(get_store),
    ) -> dict[str, Any]:
        return _project_snapshot(workbench, project)

    @app.delete("/api/projects/{project_id}", status_code=204)
    def delete_project(
        project_id: str,
        current: CurrentUser = Depends(require_csrf),
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> Response:
        project = ProjectRepository(db).delete_owned(project_id, current.id)
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
                rewrite_workflow_artifacts(
                    workbench=workbench,
                    project_id=project_id,
                    series_bible=series_bible,
                    storyboard=storyboard,
                    render_runtime="ffmpeg",
                    video_model=DEFAULT_VIDEO_MODEL,
                    continuity_plan=plan,
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
            asset_id = f"asset-{uuid.uuid4().hex}"
            project_dir = workbench.project_dir(project_id)
            output_path = safe_project_media_destination(
                project_dir,
                Path("assets") / "images" / kind,
                f"{asset_id}{suffix}",
            )
            relative_path = relative_project_path(project_dir, output_path)
            project = _lock_owned_project_after_parse(
                request=request,
                db=db,
                project_id=project_id,
                authorized_project=project,
            )
            series_bible = workbench.read_artifact(project_id, "series_bible.json")
            if series_bible is None:
                raise HTTPException(status_code=404, detail="Project not found")
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
                asset_data = {
                    "id": asset_id,
                    "kind": kind,
                    "label": label,
                    "description": description,
                    "prompt": prompt,
                    "reference_images": [relative_path],
                    "media_urls": [media_download_url(project_id, relative_path)],
                    "shot_ids": [],
                    "version": 1,
                }
                assets = workbench.read_asset_library(project_id)
                assets.append(asset_data)
                workbench.write_asset_library(project_id, assets)
                series_bible["assets"] = assets
                workbench.write_artifact(project_id, "series_bible.json", series_bible)
                storyboard = workbench.read_artifact(project_id, "episode_storyboard.json") or {"shots": []}
                continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
                rewrite_workflow_artifacts(
                    workbench=workbench,
                    project_id=project_id,
                    series_bible=series_bible,
                    storyboard=storyboard,
                    render_runtime="ffmpeg",
                    video_model=DEFAULT_VIDEO_MODEL,
                    continuity_plan=continuity_plan,
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
                }
        return response_data

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
                            and intent.shot_version == shot.get("version")
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
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
        if storyboard is None or series_bible is None:
            raise HTTPException(status_code=404, detail="Project not found")
        job_id = uuid.uuid4().hex
        try:
            shot = update_mock_shot(storyboard, shot_id, edits=payload.model_dump(exclude_unset=True))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        report = evaluate_storyboard_consistency(series_bible, storyboard)
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
                context={"target": payload.target, "target_id": payload.target_id, "mode": payload.mode},
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
        "/api/projects/{project_id}/shots/{shot_id}/regenerate",
        openapi_extra=_json_request_openapi(ShotRegenerateRequest),
    )
    async def regenerate_shot(
        request: Request,
        project_id: str,
        shot_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        workbench: WorkbenchStore = Depends(get_store),
        bus: EventBus = Depends(get_events),
        db: Session = Depends(get_db),
        settings: AppSettings = Depends(get_settings),
        newapi: NewApiClient = Depends(get_newapi_client),
    ) -> dict[str, Any]:
        payload = await parse_json_request(request, ShotRegenerateRequest)
        project = _lock_owned_project_after_parse(
            request=request,
            db=db,
            project_id=project_id,
            authorized_project=project,
        )
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
        if storyboard is None or series_bible is None:
            raise HTTPException(status_code=404, detail="Project not found")
        job_id = uuid.uuid4().hex
        bus.emit(project_id, job_id=job_id, stage="regenerate", status="running", message="Regenerating shot")
        shot = next((item for item in storyboard.get("shots", []) if item.get("id") == shot_id), None)
        if shot is None:
            message = f"Shot '{shot_id}' not found"
            bus.emit(project_id, job_id=job_id, stage="regenerate", status="failed", message=message)
            raise HTTPException(status_code=404, detail=message)
        shot_version = shot.get("version")
        generation_shot = deepcopy(shot)
        generation_shot["status"] = "generating"
        generation_shot["output_path"] = None
        generation_shot["output_url"] = None
        generation_series_bible = deepcopy(series_bible)
        owner_user_id = project.owner_user_id
        regenerate_changed_paths = [
            *STORYBOARD_ARTIFACT_PATHS,
            *WORKFLOW_ARTIFACT_PATHS,
            f"assets/video/{shot_id}.mp4",
        ]
        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project_id,
            operation="shot_regenerate",
            changed_paths=regenerate_changed_paths,
            failure_detail="Project update failed",
        ):
            pass
        try:
            output = run_single_shot_generation(
                db=db,
                newapi=newapi,
                settings=settings,
                media_store=workbench,
                user_id=owner_user_id,
                project_id=project_id,
                parent_job_id=None,
                project_dir=workbench.project_dir(project_id),
                shot=generation_shot,
                series_bible=generation_series_bible,
                video_model=payload.video_model,
                billing_job_id=payload.billing_job_id,
            )
        except _BILLING_CONTROL_ERRORS:
            raise
        except Exception as exc:
            project = _lock_owned_project_after_parse(
                request=request,
                db=db,
                project_id=project_id,
                authorized_project=project,
            )
            storyboard = workbench.read_artifact(
                project_id, "episode_storyboard.json"
            )
            series_bible = workbench.read_artifact(project_id, "series_bible.json")
            shot = next(
                (
                    item
                    for item in (storyboard or {}).get("shots", [])
                    if item.get("id") == shot_id
                ),
                None,
            )
            if (
                storyboard is not None
                and series_bible is not None
                and shot is not None
                and shot.get("version") == shot_version
            ):
                with _project_mutation(
                    db=db,
                    workbench=workbench,
                    project_id=project_id,
                    operation="shot_regenerate",
                    changed_paths=regenerate_changed_paths,
                    failure_detail="Project update failed",
                ):
                    shot["status"] = "failed"
                    shot["output_path"] = None
                    shot["output_url"] = None
                    report = evaluate_storyboard_consistency(series_bible, storyboard)
                    apply_consistency_scores(storyboard, report)
                    series_bible["assets"] = sync_asset_shot_ids(series_bible.get("assets", []), storyboard)
                    workflow_settings = read_workflow_settings(workbench, project_id, default_video_model=payload.video_model)
                    continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
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
                        video_model=payload.video_model,
                        continuity_plan=continuity_plan,
                    )
                    project.updated_at = datetime.now(timezone.utc)
            else:
                db.commit()
            bus.emit(
                project_id,
                job_id=job_id,
                stage="regenerate",
                status="failed",
                message=SHOT_GENERATION_FAILED,
            )
            raise HTTPException(status_code=500, detail=SHOT_GENERATION_FAILED) from exc

        project = _lock_owned_project_after_parse(
            request=request,
            db=db,
            project_id=project_id,
            authorized_project=project,
        )
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        shot = next(
            (
                item
                for item in (storyboard or {}).get("shots", [])
                if item.get("id") == shot_id
            ),
            None,
        )
        if (
            storyboard is None
            or series_bible is None
            or shot is None
            or shot.get("version") != shot_version
        ):
            db.commit()
            raise ProviderResultPending(
                "video generation result is detached from the current shot"
            )
        with _project_mutation(
            db=db,
            workbench=workbench,
            project_id=project_id,
            operation="shot_regenerate",
            changed_paths=regenerate_changed_paths,
            failure_detail="Project update failed",
        ):
            shot["status"] = "complete"
            shot["output_path"] = shot.get("output_path") or output["output_path"]
            shot["output_url"] = output["tool_result"].get("url")
            report = evaluate_storyboard_consistency(series_bible, storyboard)
            apply_consistency_scores(storyboard, report)
            series_bible["assets"] = sync_asset_shot_ids(series_bible.get("assets", []), storyboard)
            workflow_settings = read_workflow_settings(workbench, project_id, default_video_model=payload.video_model)
            continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
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
                video_model=payload.video_model,
                continuity_plan=continuity_plan,
            )
            project.updated_at = datetime.now(timezone.utc)
        event = bus.emit(project_id, job_id=job_id, stage="regenerate", status="complete", message="Shot regenerated")
        project_dir = workbench.project_dir(project_id)
        response_storyboard = _sanitize_storyboard_response(project_dir, storyboard)
        response_shot = _sanitize_shot_response(project_dir, shot)
        return {
            "job_id": job_id,
            "event": event,
            "shot": response_shot,
            "storyboard": response_storyboard,
            "consistency_report": report,
            "generation": _sanitize_generation_output(project_dir, output),
        }

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
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
        if storyboard is None or series_bible is None:
            raise HTTPException(status_code=404, detail="Project not found")

        render_shot_versions = {
            str(shot.get("id")): shot.get("version")
            for shot in storyboard.get("shots", [])
            if isinstance(shot, dict)
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
        staged_final_path = (
            project_dir / "renders" / f".{parent.id}.final.pending.mp4"
        )
        generated_shot_paths = []
        for shot in storyboard.get("shots", []):
            existing_output = sanitize_project_path(project_dir, shot.get("output_path"))
            if existing_output is not None and (project_dir / existing_output).exists():
                continue
            generated_shot_paths.append(
                f"assets/video/{str(shot.get('id', 'shot'))}.mp4"
            )
        render_changed_paths = [
            *STORYBOARD_ARTIFACT_PATHS,
            *WORKFLOW_ARTIFACT_PATHS,
            "artifacts/render_report.json",
            "renders/final.mp4",
            *generated_shot_paths,
        ]

        def generate_missing_shot(shot: dict[str, Any]) -> dict[str, Any]:
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
                storyboard=storyboard,
                continuity_plan=continuity_plan,
                video_model=payload.video_model,
                render_runtime="ffmpeg",
                emit_event=emit,
                generate_missing_shot=generate_missing_shot,
                composition_output_path=staged_final_path,
                persist_render_report=False,
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
                current_storyboard = workbench.read_artifact(
                    project_id, "episode_storyboard.json"
                )
                current_versions = {
                    str(shot.get("id")): shot.get("version")
                    for shot in (current_storyboard or {}).get("shots", [])
                    if isinstance(shot, dict)
                }
                render_stale = current_versions != render_shot_versions
                if render_stale:
                    parent.status = "partial_failure"
                else:
                    result["storyboard"] = current_storyboard
                    final_path = project_dir / "renders" / "final.mp4"
                    replace_atomic_output(
                        staged_final_path,
                        final_path,
                        final_path.parent.resolve(strict=True),
                    )
                    result["final_path"] = str(final_path)
                    result["render_report"]["outputs"][0]["path"] = str(
                        final_path
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
