from __future__ import annotations

import uuid
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from redis import Redis
from sqlalchemy.orm import Session

from server.app.artifact_sync import read_workflow_settings, rewrite_workflow_artifacts, sync_asset_shot_ids
from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.auth.router import router as auth_router
from server.app.core.config import AppSettings, get_settings
from server.app.consistency import apply_consistency_scores, evaluate_storyboard_consistency
from server.app.events import EventBus
from server.app.key_validation import validate_gateway_models
from server.app.keyring import key_environment, mask_key
from server.app.media_files import (
    IMAGE_EXTENSIONS,
    MAX_IMAGE_BYTES,
    media_content_type,
    media_download_url,
    relative_project_path,
    safe_project_media_destination,
    safe_project_media_file,
    save_upload_file,
    validate_upload_extension,
)
from server.app.mock_runner import build_mock_short_drama, regenerate_mock_shot, update_mock_shot
from server.app.models import (
    ContinuityPlan,
    ProjectType,
    PromptOptimizeRequest,
    PromptOptimizeResponse,
    ShotRegenerateRequest,
    ShotSaveRequest,
)
from server.app.openmontage_runner import (
    REFERENCE_IMAGE_EXTENSIONS,
    render_short_drama_project,
    run_single_shot_generation,
)
from server.app.prompt_optimizer import optimize_text_prompt
from server.app.projects.models import ProjectRecord
from server.app.projects.repository import ProjectRepository
from server.app.projects.schemas import (
    MAX_IMPORT_ARTIFACT_BYTES,
    ProjectCreateRequest,
    ProjectImportRequest,
    ProjectListResponse,
    ProjectResponse,
)
from server.app.db.session import get_db
from server.app.redis import get_redis
from server.app.settings import DEFAULT_DB_PATH, DEFAULT_PROJECTS_ROOT, DEFAULT_SYAPI_BASE_URL
from server.app.storyboard_generator import generate_short_drama_storyboard
from server.app.storage import WorkbenchStore

DEFAULT_TEXT_MODEL = "gpt-5.5"
DEFAULT_IMAGE_MODEL = "gpt-image-2"
DEFAULT_VIDEO_MODEL = "omni_flash-10s"


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
    current: CurrentUser = Depends(_require_function_user, scope="function"),
    db: Session = Depends(get_db, scope="function"),
) -> ProjectRecord:
    return ProjectRepository(db).require_owned(project_id, current.id)


def _require_owned_csrf(
    project_id: str,
    current: CurrentUser = Depends(require_csrf),
    db: Session = Depends(get_db),
) -> ProjectRecord:
    return ProjectRepository(db).require_owned(project_id, current.id)


async def _require_import_csrf(
    request: Request,
    current: CurrentUser = Depends(require_csrf),
) -> CurrentUser:
    if len(await request.body()) > MAX_IMPORT_ARTIFACT_BYTES:
        raise HTTPException(status_code=413, detail="Imported project JSON is too large")
    return current


class KeySessionRequest(BaseModel):
    text_key: str = Field(min_length=1)
    image_key: str = Field(min_length=1)
    video_key: str = Field(min_length=1)
    base_url: str = DEFAULT_SYAPI_BASE_URL
    text_model: str = DEFAULT_TEXT_MODEL
    image_model: str = DEFAULT_IMAGE_MODEL
    video_model: str = DEFAULT_VIDEO_MODEL


class ShortDramaRequest(BaseModel):
    title: str = Field(min_length=1)
    prompt: str = Field(min_length=1)
    project_type: ProjectType = "single_video"
    shot_count: int | None = Field(default=None, ge=1, le=60)
    text_key: str = Field(min_length=1)
    image_key: str = Field(min_length=1)
    video_key: str = Field(min_length=1)
    base_url: str = DEFAULT_SYAPI_BASE_URL
    text_model: str = DEFAULT_TEXT_MODEL
    image_model: str = DEFAULT_IMAGE_MODEL
    video_model: str = DEFAULT_VIDEO_MODEL


class RenderProjectRequest(BaseModel):
    text_key: str | None = None
    image_key: str | None = None
    video_key: str = Field(min_length=1)
    base_url: str = DEFAULT_SYAPI_BASE_URL
    text_model: str = DEFAULT_TEXT_MODEL
    image_model: str = DEFAULT_IMAGE_MODEL
    video_model: str = DEFAULT_VIDEO_MODEL
    render_runtime: str = "ffmpeg"


def create_app(
    db_path: str | Path = DEFAULT_DB_PATH,
    projects_root: str | Path = DEFAULT_PROJECTS_ROOT,
) -> FastAPI:
    app = FastAPI(title="OpenMontage Short Drama Workbench")
    app.include_router(auth_router)
    store = WorkbenchStore(projects_root=Path(projects_root), db_path=Path(db_path))
    events = EventBus()
    app.state.store = store
    app.state.events = events

    def get_store() -> WorkbenchStore:
        return app.state.store

    def get_events() -> EventBus:
        return app.state.events

    @app.post("/api/session/key")
    def save_gateway_key(payload: KeySessionRequest) -> dict[str, Any]:
        env = key_environment(payload.video_key, payload.base_url)
        validation = validate_gateway_models(
            base_url=payload.base_url,
            text_key=payload.text_key,
            image_key=payload.image_key,
            video_key=payload.video_key,
            text_model=payload.text_model,
            image_model=payload.image_model,
            video_model=payload.video_model,
        )
        if not validation["valid"]:
            raise HTTPException(status_code=400, detail="; ".join(validation["errors"]))
        return {
            "masked_keys": {
                "text": mask_key(payload.text_key),
                "image": mask_key(payload.image_key),
                "video": mask_key(payload.video_key),
            },
            "provider": "syapi",
            "base_url": env["SYAPI_BASE_URL"],
            "models": {
                "text": payload.text_model,
                "image": payload.image_model,
                "video": payload.video_model,
            },
            "valid": True,
        }

    @app.post("/api/projects")
    def create_draft_project(
        payload: ProjectCreateRequest,
        workbench: WorkbenchStore = Depends(get_store),
        current: CurrentUser = Depends(require_csrf),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        project = ProjectRepository(db).create(
            owner_user_id=current.id,
            title=payload.title,
            mode="short_drama",
            project_type=payload.project_type,
        )
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
        db.commit()
        return _project_snapshot(workbench, project)

    @app.post("/api/projects/import", status_code=201)
    def import_project(
        payload: ProjectImportRequest,
        workbench: WorkbenchStore = Depends(get_store),
        current: CurrentUser = Depends(_require_import_csrf),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        if payload.artifact_size_bytes() > MAX_IMPORT_ARTIFACT_BYTES:
            raise HTTPException(status_code=413, detail="Imported project JSON is too large")
        project = ProjectRepository(db).create(
            owner_user_id=current.id,
            title=payload.title,
            mode="short_drama",
            project_type=payload.project_type,
        )
        artifacts = payload.artifact_payloads()
        for filename, artifact in artifacts.items():
            workbench.write_artifact(project.id, filename, artifact)
        workbench.write_asset_library(
            project.id,
            list(artifacts["series_bible.json"]["assets"]),
        )
        db.commit()
        return _project_snapshot(workbench, project)

    @app.post("/api/projects/short-drama")
    def create_short_drama_project(
        payload: ShortDramaRequest,
        workbench: WorkbenchStore = Depends(get_store),
        current: CurrentUser = Depends(require_csrf),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        key_environment(payload.video_key, payload.base_url)
        try:
            result = generate_short_drama_storyboard(
                title=payload.title,
                prompt=payload.prompt,
                model=payload.text_model,
                base_url=payload.base_url,
                api_key=payload.text_key,
                shot_count=payload.shot_count,
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Text model storyboard generation failed: {exc}") from exc

        result["consistency_report"] = evaluate_storyboard_consistency(
            result["series_bible"],
            result["storyboard"],
        )
        apply_consistency_scores(result["storyboard"], result["consistency_report"])

        project = ProjectRepository(db).create(
            owner_user_id=current.id,
            title=payload.title,
            mode="short_drama",
            project_type=payload.project_type,
        )
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

        db.commit()
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
        project: Annotated[ProjectRecord, Depends(_require_owned_user)],
        workbench: WorkbenchStore = Depends(get_store),
    ) -> dict[str, Any]:
        return _project_snapshot(workbench, project)

    @app.patch("/api/projects/{project_id}/continuity")
    def save_continuity_plan(
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        payload: ContinuityPlan,
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        plan = payload.model_dump()
        plan["project_type"] = project.project_type
        if project.project_type == "single_video":
            plan["active_episode_number"] = None
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
        project.updated_at = datetime.now(UTC)
        db.commit()
        return {"project": _project_data(project), "continuity_plan": plan}

    @app.post("/api/projects/{project_id}/assets/upload")
    async def upload_reference_image(
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        kind: str = Form(...),
        label: str = Form(...),
        description: str = Form(""),
        prompt: str = Form(""),
        file: UploadFile = File(...),
        workbench: WorkbenchStore = Depends(get_store),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        if series_bible is None:
            raise HTTPException(status_code=404, detail="Project not found")
        if kind not in {"character", "scene", "prop"}:
            raise HTTPException(status_code=422, detail="Unsupported asset kind")
        suffix = validate_upload_extension(file.filename or "", IMAGE_EXTENSIONS)
        asset_id = f"asset-{uuid.uuid4().hex}"
        project_dir = workbench.project_dir(project_id)
        output_path = safe_project_media_destination(
            project_dir,
            Path("assets") / "images" / kind,
            f"{asset_id}{suffix}",
        )
        await save_upload_file(file, output_path, MAX_IMAGE_BYTES)
        relative_path = relative_project_path(project_dir, output_path)
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
        project.updated_at = datetime.now(UTC)
        db.commit()
        return {
            "media": {
                "path": relative_path,
                "media_url": media_download_url(project_id, relative_path),
                "filename": Path(relative_path).name,
                "content_type": media_content_type(output_path),
            },
            "asset": _decorate_asset_media(project_id, project_dir, asset_data),
        }

    @app.get("/api/projects/{project_id}/media/{relative_path:path}")
    def project_media(
        project_id: str,
        relative_path: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_user)],
        workbench: WorkbenchStore = Depends(get_store),
    ) -> FileResponse:
        media_path = safe_project_media_file(workbench.project_dir(project_id), relative_path)
        if not media_path.exists():
            raise HTTPException(status_code=404, detail="Media file not found")
        return FileResponse(media_path, media_type=media_content_type(media_path))

    @app.patch("/api/projects/{project_id}/shots/{shot_id}")
    def save_shot(
        project_id: str,
        shot_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        payload: ShotSaveRequest,
        workbench: WorkbenchStore = Depends(get_store),
        bus: EventBus = Depends(get_events),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
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
        project.updated_at = datetime.now(UTC)
        db.commit()
        event = bus.emit(project_id, job_id=job_id, stage="save", status="complete", message="Shot saved")
        return {"job_id": job_id, "event": event, "shot": shot, "storyboard": storyboard, "consistency_report": report}

    @app.post("/api/projects/{project_id}/prompt-optimize", response_model=PromptOptimizeResponse)
    def optimize_prompt(
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        payload: PromptOptimizeRequest,
        workbench: WorkbenchStore = Depends(get_store),
    ) -> PromptOptimizeResponse:
        try:
            result = optimize_text_prompt(
                source_text=payload.source_text,
                model=payload.text_model,
                base_url=payload.base_url,
                api_key=payload.text_key,
                context={"target": payload.target, "target_id": payload.target_id, "mode": payload.mode},
            )
            return PromptOptimizeResponse(project_id=project_id, model=payload.text_model, **result)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Text model prompt optimization failed: {exc}") from exc

    @app.post("/api/projects/{project_id}/shots/{shot_id}/regenerate")
    def regenerate_shot(
        project_id: str,
        shot_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        payload: ShotRegenerateRequest,
        workbench: WorkbenchStore = Depends(get_store),
        bus: EventBus = Depends(get_events),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        if not payload.video_key:
            raise HTTPException(status_code=422, detail="video_key is required for shot regeneration")
        key_environment(payload.video_key, payload.base_url)
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
        shot["status"] = "generating"
        shot["output_path"] = None
        shot["output_url"] = None
        try:
            output = run_single_shot_generation(
                project_dir=workbench.project_dir(project_id),
                shot=shot,
                series_bible=series_bible,
                video_key=payload.video_key,
                base_url=payload.base_url,
                video_model=payload.video_model,
            )
        except Exception as exc:
            shot["status"] = "failed"
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
            bus.emit(project_id, job_id=job_id, stage="regenerate", status="failed", message=str(exc))
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        shot["status"] = "complete"
        shot["output_path"] = output["output_path"]
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
        project.updated_at = datetime.now(UTC)
        db.commit()
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

    @app.post("/api/projects/{project_id}/render")
    def render_project(
        project_id: str,
        project: Annotated[ProjectRecord, Depends(_require_owned_csrf)],
        payload: RenderProjectRequest,
        workbench: WorkbenchStore = Depends(get_store),
        bus: EventBus = Depends(get_events),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        continuity_plan = workbench.read_artifact(project_id, "continuity_plan.json")
        if storyboard is None or series_bible is None:
            raise HTTPException(status_code=404, detail="Project not found")

        job_id = uuid.uuid4().hex

        def emit(stage: str, status: str, message: str) -> None:
            bus.emit(project_id, job_id=job_id, stage=stage, status=status, message=message)

        emit("render", "running", "Starting final render")
        try:
            result = render_short_drama_project(
                project_dir=workbench.project_dir(project_id),
                series_bible=series_bible,
                storyboard=storyboard,
                video_key=payload.video_key,
                base_url=payload.base_url,
                continuity_plan=continuity_plan,
                video_model=payload.video_model,
                render_runtime="ffmpeg",
                emit_event=emit,
            )
        except Exception as exc:
            emit("render", "failed", str(exc))
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        report = evaluate_storyboard_consistency(series_bible, result["storyboard"])
        apply_consistency_scores(result["storyboard"], report)
        workbench.write_artifact(project_id, "episode_storyboard.json", result["storyboard"])
        workbench.write_artifact(project_id, "consistency_report.json", report)
        workbench.write_artifact(project_id, "render_report.json", result["render_report"])
        project.updated_at = datetime.now(UTC)
        db.commit()
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
