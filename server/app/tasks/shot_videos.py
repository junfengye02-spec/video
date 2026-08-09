from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractContextManager
from copy import deepcopy
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from server.app.billing.execution import (
    PaymentRequiredQuote,
    ProviderPricingUnstable,
    ProviderResultPending,
    ProviderResultUnavailable,
)
from server.app.billing.models import GenerationJob
from server.app.billing.service import ProviderPricingUnavailable
from server.app.continuity_frames import (
    resolve_continuity,
    resolve_shot_generation_frame_requirements,
)
from server.app.keyframe_service import (
    TailFrameBinding,
    TailFrameVersionConflict,
    ensure_shot_tail_frame,
)
from server.app.media_files import safe_project_media_file
from server.app.openmontage_runner import (
    VideoFrameContractUnsupported,
    generate_billed_shot,
)
from server.app.projects.repository import ProjectRepository
from server.app.provider.newapi import NewApiCallError, NewApiRateLimited
from server.app.storage import WorkbenchStore
from server.app.tasks.service import (
    PREVIOUS_SHOT_MISSING_CODE,
    PREVIOUS_SHOT_MISSING_MESSAGE,
    SHOT_FRAME_DEPENDENCIES_MISSING_CODE,
    SHOT_FRAME_DEPENDENCIES_MISSING_MESSAGE,
    TaskService,
)
from server.app.tasks.worker import (
    PermanentTaskError,
    PublishOutcome,
    RetryableTaskError,
    TaskAwaitingPayment,
    TaskExecutionContext,
    TaskExecutionResult,
    TaskWaitingDependency,
    TaskWaitingProvider,
)
from server.app.wallet.service import InsufficientBalance


SHOT_VIDEO_TASK_TYPE = "shot_video.generate"


def dependency_tail_asset(
    media_store: WorkbenchStore,
    project_id: str,
    previous_shot: dict[str, Any],
    expected_version: int,
) -> dict[str, Any] | None:
    if int(previous_shot.get("version") or 1) != expected_version:
        return None
    continuity = resolve_continuity(previous_shot)
    frame = continuity.get("last_frame")
    if not isinstance(frame, dict) or frame.get("status") != "ready":
        return None
    asset_id = str(frame.get("asset_id") or "")
    if not asset_id:
        return None
    asset = next(
        (
            item
            for item in media_store.read_asset_library(project_id)
            if isinstance(item, dict) and str(item.get("id")) == asset_id
        ),
        None,
    )
    if (
        asset is None
        or asset.get("source_type") != "video_frame"
        or asset.get("status") != "ready"
    ):
        return None
    provenance = asset.get("provenance")
    if (
        not isinstance(provenance, dict)
        or provenance.get("shot_id") != str(previous_shot.get("id"))
        or provenance.get("video_version") != expected_version
    ):
        return None
    references = asset.get("reference_images")
    if not isinstance(references, list) or not references:
        return None
    try:
        path = safe_project_media_file(
            media_store.project_dir(project_id), str(references[0])
        )
    except (HTTPException, ValueError):
        return None
    return asset if path.is_file() else None


def previous_video_is_available(
    media_store: WorkbenchStore,
    project_id: str,
    previous_shot: dict[str, Any],
    expected_version: int,
) -> bool:
    if (
        int(previous_shot.get("version") or 1) != expected_version
        or previous_shot.get("status") != "complete"
    ):
        return False
    try:
        path = safe_project_media_file(
            media_store.project_dir(project_id),
            str(previous_shot.get("output_path") or ""),
        )
    except (HTTPException, ValueError):
        return False
    return path.is_file()


def execute_shot_video(
    context: TaskExecutionContext,
    *,
    session_factory: Callable[[], Session],
    media_store: WorkbenchStore,
    settings_factory: Callable[[], Any],
    newapi_context: Callable[[Any], AbstractContextManager[Any]],
    events: Any = None,
) -> TaskExecutionResult:
    payload = context.input_snapshot
    shot = deepcopy(payload["shot"])
    series_bible = deepcopy(payload["series_bible"])
    expected_version = int(context.target_entity_version or shot.get("version") or 1)

    with session_factory() as db:
        ProjectRepository(db).require_owned_for_read(
            context.project_id, context.owner_user_id
        )
    current_shot = _current_shot(media_store, context.project_id, str(shot["id"]))
    if current_shot is None or int(current_shot.get("version") or 1) != expected_version:
        raise PermanentTaskError(
            "stale_entity_version",
            "Task result was not generated because the shot changed",
        )

    requirements = resolve_shot_generation_frame_requirements(
        shot,
        regeneration=payload.get("generation_mode") == "regenerate",
    )
    if requirements.regeneration and not requirements.regeneration_frames_ready:
        raise PermanentTaskError(
            SHOT_FRAME_DEPENDENCIES_MISSING_CODE,
            SHOT_FRAME_DEPENDENCIES_MISSING_MESSAGE,
        )

    _require_explicit_first_frame(
        shot=shot,
        series_bible=series_bible,
        media_store=media_store,
        project_id=context.project_id,
    )
    if requirements.regeneration:
        _require_regeneration_frame_assets(
            continuity=requirements.continuity,
            series_bible=series_bible,
            media_store=media_store,
            project_id=context.project_id,
        )

    dependency = payload.get("dependency")
    if isinstance(dependency, dict) and dependency.get("required") is True:
        shot, series_bible = _apply_previous_tail(
            context=context,
            dependency=dependency,
            shot=shot,
            series_bible=series_bible,
            session_factory=session_factory,
            media_store=media_store,
            events=events,
        )

    context.report_progress(5)
    try:
        with session_factory() as db:
            settings = settings_factory()
            with newapi_context(settings) as newapi:
                output = generate_billed_shot(
                    db=db,
                    newapi=newapi,
                    settings=settings,
                    media_store=media_store,
                    user_id=context.owner_user_id,
                    project_id=context.project_id,
                    parent_job_id=None,
                    project_dir=media_store.project_dir(context.project_id),
                    shot=shot,
                    series_bible=series_bible,
                    video_model=str(payload["video_model"]),
                    billing_job_id=context.billing_job_id,
                    settlement_key=context.settlement_key,
                    project_aspect_ratio=str(payload["aspect_ratio"]),
                )
    except PaymentRequiredQuote as exc:
        raise TaskAwaitingPayment(exc.job_id) from None
    except InsufficientBalance:
        raise TaskAwaitingPayment() from None
    except ProviderResultPending as exc:
        billing_job_id = exc.job_id or context.billing_job_id or context.item_id
        with session_factory() as db:
            job = db.get(GenerationJob, billing_job_id)
            if job is not None and job.status in {
                "payment_required",
                "payment_required_quote",
            }:
                raise TaskAwaitingPayment(job.id) from None
            if job is not None and job.status == "billed" and job.result_visible:
                current = _current_shot(
                    media_store, context.project_id, str(shot["id"])
                )
                if current is None or int(current.get("version") or 1) != expected_version:
                    return TaskExecutionResult(
                        {
                            "billing_job_id": job.id,
                            "shot_id": str(shot["id"]),
                            "shot_version": expected_version,
                            "publication_status": "stale",
                            "settlement_key": context.settlement_key,
                        }
                    )
        raise TaskWaitingProvider(billing_job_id, poll_delay_seconds=5) from exc
    except (ProviderPricingUnstable, ProviderPricingUnavailable, NewApiRateLimited) as exc:
        raise RetryableTaskError(
            "provider_pricing_unavailable",
            "Video provider pricing is temporarily unavailable",
            retry_delay_seconds=0.25,
        ) from exc
    except VideoFrameContractUnsupported as exc:
        raise PermanentTaskError(exc.code, exc.message) from None
    except (ProviderResultUnavailable, NewApiCallError) as exc:
        raise RetryableTaskError(
            "provider_call_failed",
            "Video provider call failed",
            retry_delay_seconds=0.25,
        ) from exc

    billing_job_id = str(output["tool_result"]["billing_job_id"])
    context.report_progress(85)
    try:
        with session_factory() as db:
            tail = ensure_shot_tail_frame(
                db=db,
                media_store=media_store,
                owner_user_id=context.owner_user_id,
                project_id=context.project_id,
                shot_id=str(shot["id"]),
                expected_shot_version=expected_version,
            )
            TaskService(db, events).release_external_shot_dependencies(
                project_id=context.project_id,
                previous_shot_id=str(shot["id"]),
                previous_shot_version=expected_version,
            )
    except TailFrameVersionConflict:
        return TaskExecutionResult(
            {
                "billing_job_id": billing_job_id,
                "shot_id": str(shot["id"]),
                "shot_version": expected_version,
                "publication_status": "stale",
                "settlement_key": context.settlement_key,
            }
        )
    except Exception as exc:
        raise RetryableTaskError(
            "tail_frame_extraction_failed",
            "Video completed, but its tail frame could not be extracted",
            retry_delay_seconds=0.25,
        ) from exc

    return TaskExecutionResult(
        {
            "billing_job_id": billing_job_id,
            "shot_id": str(shot["id"]),
            "shot_version": expected_version,
            "output_path": output["output_path"],
            "operation": output["operation"],
            "referenced_asset_ids": output.get("referenced_asset_ids", []),
            "tail_frame": _tail_result(tail),
            "publication_status": "published",
            "settlement_key": context.settlement_key,
        }
    )


def publish_shot_video(
    context: TaskExecutionContext,
    result: dict[str, Any],
    target_version: int | None,
    *,
    media_store: WorkbenchStore,
) -> PublishOutcome:
    if result.get("publication_status") == "stale" or target_version is None:
        return PublishOutcome.STALE
    shot = _current_shot(media_store, context.project_id, str(context.target_entity_id))
    if shot is None or int(shot.get("version") or 1) != target_version:
        return PublishOutcome.STALE
    tail = result.get("tail_frame")
    continuity = resolve_continuity(shot)
    if (
        shot.get("status") != "complete"
        or not shot.get("output_path")
        or not isinstance(tail, dict)
        or continuity.get("last_frame_asset_id") != tail.get("asset_id")
    ):
        return PublishOutcome.STALE
    return PublishOutcome.PUBLISHED


def _apply_previous_tail(
    *,
    context: TaskExecutionContext,
    dependency: dict[str, Any],
    shot: dict[str, Any],
    series_bible: dict[str, Any],
    session_factory: Callable[[], Session],
    media_store: WorkbenchStore,
    events: Any,
) -> tuple[dict[str, Any], dict[str, Any]]:
    previous_id = str(dependency["previous_shot_id"])
    previous_version = int(dependency["previous_shot_version"])
    previous = _current_shot(media_store, context.project_id, previous_id)
    if previous is None or int(previous.get("version") or 1) != previous_version:
        raise TaskWaitingDependency(
            PREVIOUS_SHOT_MISSING_CODE, PREVIOUS_SHOT_MISSING_MESSAGE
        )
    asset = dependency_tail_asset(
        media_store, context.project_id, previous, previous_version
    )
    if asset is None and previous_video_is_available(
        media_store, context.project_id, previous, previous_version
    ):
        try:
            with session_factory() as db:
                ensure_shot_tail_frame(
                    db=db,
                    media_store=media_store,
                    owner_user_id=context.owner_user_id,
                    project_id=context.project_id,
                    shot_id=previous_id,
                    expected_shot_version=previous_version,
                )
                TaskService(db, events).release_external_shot_dependencies(
                    project_id=context.project_id,
                    previous_shot_id=previous_id,
                    previous_shot_version=previous_version,
                )
        except TailFrameVersionConflict:
            raise TaskWaitingDependency(
                PREVIOUS_SHOT_MISSING_CODE, PREVIOUS_SHOT_MISSING_MESSAGE
            ) from None
        except Exception as exc:
            raise RetryableTaskError(
                "tail_frame_extraction_failed",
                "Previous shot tail frame could not be extracted",
                retry_delay_seconds=0.25,
            ) from exc
        previous = _current_shot(media_store, context.project_id, previous_id)
        asset = (
            dependency_tail_asset(
                media_store, context.project_id, previous, previous_version
            )
            if previous is not None
            else None
        )
    if asset is None:
        raise TaskWaitingDependency(
            PREVIOUS_SHOT_MISSING_CODE, PREVIOUS_SHOT_MISSING_MESSAGE
        )

    previous_continuity = resolve_continuity(previous)
    previous_frame = previous_continuity["last_frame"]
    continuity = resolve_continuity(shot)
    continuity.update(
        {
            "inherited_first_frame_asset_id": asset["id"],
            "first_frame": {
                "asset_id": asset["id"],
                "version": int(previous_frame.get("version") or 1),
                "status": "ready",
                "source": "inherited",
                "origin_shot_id": previous_id,
                "origin_shot_version": previous_version,
                "origin_frame_version": int(previous_frame.get("version") or 1),
            },
            "stale": False,
        }
    )
    shot["continuity"] = continuity
    assets = [
        item
        for item in series_bible.get("assets", [])
        if isinstance(item, dict) and str(item.get("id")) != str(asset["id"])
    ]
    assets.append(deepcopy(asset))
    series_bible["assets"] = assets
    return shot, series_bible


def _current_shot(
    media_store: WorkbenchStore, project_id: str, shot_id: str
) -> dict[str, Any] | None:
    storyboard = media_store.read_artifact(project_id, "episode_storyboard.json")
    return next(
        (
            shot
            for shot in (storyboard or {}).get("shots", [])
            if isinstance(shot, dict) and str(shot.get("id")) == shot_id
        ),
        None,
    )


def _require_explicit_first_frame(
    *,
    shot: dict[str, Any],
    series_bible: dict[str, Any],
    media_store: WorkbenchStore,
    project_id: str,
) -> None:
    continuity = resolve_continuity(shot)
    asset_id = continuity.get("explicit_user_first_frame_asset_id")
    if not asset_id:
        return
    if not _frame_asset_is_available(
        asset_id=str(asset_id),
        series_bible=series_bible,
        media_store=media_store,
        project_id=project_id,
    ):
        raise PermanentTaskError(
            "first_frame_unavailable",
            "The explicitly selected first frame is unavailable",
        )


def _require_regeneration_frame_assets(
    *,
    continuity: dict[str, Any],
    series_bible: dict[str, Any],
    media_store: WorkbenchStore,
    project_id: str,
) -> None:
    for frame_name in ("first_frame", "last_frame"):
        frame = continuity.get(frame_name)
        asset_id = frame.get("asset_id") if isinstance(frame, dict) else None
        if not asset_id or not _frame_asset_is_available(
            asset_id=str(asset_id),
            series_bible=series_bible,
            media_store=media_store,
            project_id=project_id,
        ):
            raise PermanentTaskError(
                SHOT_FRAME_DEPENDENCIES_MISSING_CODE,
                SHOT_FRAME_DEPENDENCIES_MISSING_MESSAGE,
            )


def _frame_asset_is_available(
    *,
    asset_id: str,
    series_bible: dict[str, Any],
    media_store: WorkbenchStore,
    project_id: str,
) -> bool:
    asset = next(
        (
            item
            for item in series_bible.get("assets", [])
            if isinstance(item, dict) and str(item.get("id")) == str(asset_id)
        ),
        None,
    )
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
            media_store.project_dir(project_id), str(references[0])
        )
    except (HTTPException, ValueError):
        return False
    return path.is_file()


def _tail_result(tail: TailFrameBinding) -> dict[str, Any]:
    return {
        "asset_id": tail.asset_id,
        "path": tail.path,
        "media_sha256": tail.media_sha256,
        "sample_time_seconds": tail.sample_time_seconds,
        "frame_version": tail.frame_version,
        "reused": tail.reused,
        "provider_cost_units": tail.provider_cost_units,
    }
