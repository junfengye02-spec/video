from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from server.app.artifact_sync import read_workflow_settings, rewrite_workflow_artifacts, sync_asset_shot_ids
from server.app.consistency import apply_consistency_scores, evaluate_storyboard_consistency
from server.app.events import EventBus
from server.app.key_validation import validate_gateway_models
from server.app.keyring import key_environment, mask_key
from server.app.mock_runner import build_mock_short_drama, regenerate_mock_shot, update_mock_shot
from server.app.models import PromptOptimizeRequest, PromptOptimizeResponse, ShotRegenerateRequest, ShotSaveRequest
from server.app.openmontage_runner import (
    REFERENCE_IMAGE_EXTENSIONS,
    render_short_drama_project,
    run_single_shot_generation,
)
from server.app.prompt_optimizer import optimize_text_prompt
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
    decorated = dict(output)
    if "output_path" in decorated:
        decorated["output_path"] = sanitize_project_path(project_dir, decorated.get("output_path"))
    if "reference_image_paths" in decorated:
        decorated["reference_image_paths"] = [
            relative_path
            for reference in decorated.get("reference_image_paths", [])
            if (relative_path := sanitize_project_path(project_dir, reference)) is not None
        ]
    return decorated


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
    store = WorkbenchStore(db_path=Path(db_path), projects_root=Path(projects_root))
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

    @app.post("/api/projects/short-drama")
    def create_short_drama_project(
        payload: ShortDramaRequest,
        workbench: WorkbenchStore = Depends(get_store),
    ) -> dict[str, Any]:
        key_environment(payload.video_key, payload.base_url)
        try:
            result = generate_short_drama_storyboard(
                title=payload.title,
                prompt=payload.prompt,
                model=payload.text_model,
                base_url=payload.base_url,
                api_key=payload.text_key,
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Text model storyboard generation failed: {exc}") from exc

        result["consistency_report"] = evaluate_storyboard_consistency(
            result["series_bible"],
            result["storyboard"],
        )
        apply_consistency_scores(result["storyboard"], result["consistency_report"])

        project = workbench.create_project(title=payload.title, mode="short_drama")
        _persist_storyboard_state(
            workbench=workbench,
            project_id=project.id,
            storyboard=result["storyboard"],
            series_bible=result["series_bible"],
            consistency_report=result["consistency_report"],
        )
        rewrite_workflow_artifacts(
            workbench=workbench,
            project_id=project.id,
            series_bible=result["series_bible"],
            storyboard=result["storyboard"],
            render_runtime="ffmpeg",
            video_model=payload.video_model,
        )

        return {"project": project.model_dump(), **result}

    @app.get("/api/projects/{project_id}")
    def get_project(
        project_id: str,
        workbench: WorkbenchStore = Depends(get_store),
    ) -> dict[str, Any]:
        project = workbench.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        render_report = workbench.read_artifact(project_id, "render_report.json")
        final_path = None
        if render_report and render_report.get("outputs"):
            final_path = render_report["outputs"][0].get("path")
        return {
            "project": project.model_dump(),
            "series_bible": workbench.read_artifact(project_id, "series_bible.json"),
            "storyboard": workbench.read_artifact(project_id, "episode_storyboard.json"),
            "consistency_report": workbench.read_artifact(project_id, "consistency_report.json"),
            "render_report": render_report,
            "final_path": final_path,
        }

    @app.patch("/api/projects/{project_id}/shots/{shot_id}")
    def save_shot(
        project_id: str,
        shot_id: str,
        payload: ShotSaveRequest,
        workbench: WorkbenchStore = Depends(get_store),
        bus: EventBus = Depends(get_events),
    ) -> dict[str, Any]:
        project = workbench.get_project(project_id)
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        if project is None or storyboard is None or series_bible is None:
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
        )
        event = bus.emit(project_id, job_id=job_id, stage="save", status="complete", message="Shot saved")
        return {"job_id": job_id, "event": event, "shot": shot, "storyboard": storyboard, "consistency_report": report}

    @app.post("/api/projects/{project_id}/prompt-optimize", response_model=PromptOptimizeResponse)
    def optimize_prompt(
        project_id: str,
        payload: PromptOptimizeRequest,
        workbench: WorkbenchStore = Depends(get_store),
    ) -> PromptOptimizeResponse:
        project = workbench.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
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
        payload: ShotRegenerateRequest,
        workbench: WorkbenchStore = Depends(get_store),
        bus: EventBus = Depends(get_events),
    ) -> dict[str, Any]:
        if not payload.video_key:
            raise HTTPException(status_code=422, detail="video_key is required for shot regeneration")
        key_environment(payload.video_key, payload.base_url)
        project = workbench.get_project(project_id)
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        if project is None or storyboard is None or series_bible is None:
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
        )
        event = bus.emit(project_id, job_id=job_id, stage="regenerate", status="complete", message="Shot regenerated")
        project_dir = workbench.project_dir(project_id)
        response_storyboard = storyboard
        response_shot = shot
        generation = _sanitize_generation_output(project_dir, output)
        return {
            "job_id": job_id,
            "event": event,
            "shot": response_shot,
            "storyboard": response_storyboard,
            "consistency_report": report,
            "generation": generation,
        }

    @app.post("/api/projects/{project_id}/render")
    def render_project(
        project_id: str,
        payload: RenderProjectRequest,
        workbench: WorkbenchStore = Depends(get_store),
        bus: EventBus = Depends(get_events),
    ) -> dict[str, Any]:
        project = workbench.get_project(project_id)
        storyboard = workbench.read_artifact(project_id, "episode_storyboard.json")
        series_bible = workbench.read_artifact(project_id, "series_bible.json")
        if project is None or storyboard is None or series_bible is None:
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
        event = bus.emit(project_id, job_id=job_id, stage="render", status="complete", message="Final video rendered")
        return {
            "job_id": job_id,
            "event": event,
            "project": project.model_dump(),
            "storyboard": result["storyboard"],
            "consistency_report": report,
            "render_report": result["render_report"],
            "final_path": result["final_path"],
            "outputs": result["outputs"],
        }

    @app.get("/api/projects/{project_id}/events")
    async def project_events(project_id: str, bus: EventBus = Depends(get_events)) -> StreamingResponse:
        return StreamingResponse(bus.stream(project_id), media_type="text/event-stream")

    return app
