from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractContextManager
from copy import deepcopy
from typing import Any

from sqlalchemy.orm import Session

from server.app.billing.execution import (
    PaymentRequiredQuote,
    ProviderGenerationFailed,
    ProviderPricingUnstable,
    ProviderResultPending,
    ProviderResultUnavailable,
)
from server.app.billing.models import GenerationJob
from server.app.billing.service import ProviderPricingUnavailable
from server.app.generation_units.models import VideoGenerationUnit
from server.app.generation_units.prompt import PROMPT_CONTRACT_VERSION
from server.app.generation_units.publication import (
    generation_unit_billing_operation,
)
from server.app.openmontage_runner import generate_billed_generation_unit
from server.app.projects.repository import ProjectRepository
from server.app.provider.newapi import NewApiCallError, NewApiRateLimited
from server.app.storage import WorkbenchStore
from server.app.tasks.service import (
    GENERATION_UNIT_VIDEO_TASK_TYPE,
    PREVIOUS_GENERATION_UNIT_MISSING_CODE,
    PREVIOUS_GENERATION_UNIT_MISSING_MESSAGE,
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


def execute_generation_unit_video(
    context: TaskExecutionContext,
    *,
    session_factory: Callable[[], Session],
    media_store: WorkbenchStore,
    settings_factory: Callable[[], Any],
    newapi_context: Callable[[Any], AbstractContextManager[Any]],
) -> TaskExecutionResult:
    payload = deepcopy(context.input_snapshot)
    with session_factory() as db:
        ProjectRepository(db).require_owned_for_read(
            context.project_id, context.owner_user_id
        )
        record = _load_and_validate_snapshot(db, context, payload)
        if _already_published(media_store, record):
            return TaskExecutionResult(
                _result_from_record(record, context.settlement_key)
            )

    source_shots = deepcopy(payload["source_shots"])
    series_bible = deepcopy(context.batch_snapshot.get("series_bible"))
    if not isinstance(series_bible, dict):
        raise PermanentTaskError(
            "generation_unit_snapshot_invalid",
            "Frozen generation unit series bible is invalid",
        )
    dependency = payload.get("dependency")
    if isinstance(dependency, dict):
        _apply_previous_unit_tail(
            context=context,
            dependency=dependency,
            source_shots=source_shots,
            series_bible=series_bible,
            session_factory=session_factory,
            media_store=media_store,
        )

    frozen_unit = dict(payload["generation_unit"])
    frozen_unit["source_shot_versions"] = dict(payload["source_shot_versions"])
    frozen_unit["profile_revision"] = str(payload["profile_revision"])
    context.report_progress(5)
    try:
        with session_factory() as db:
            settings = settings_factory()
            with newapi_context(settings) as newapi:
                output = generate_billed_generation_unit(
                    db=db,
                    newapi=newapi,
                    settings=settings,
                    media_store=media_store,
                    user_id=context.owner_user_id,
                    project_id=context.project_id,
                    project_dir=media_store.project_dir(context.project_id),
                    generation_unit=frozen_unit,
                    source_shots=source_shots,
                    compiled_prompt=str(payload["compiled_prompt"]),
                    series_bible=series_bible,
                    generation_key=str(context.generation_key),
                    billing_job_id=context.billing_job_id,
                    settlement_key=context.settlement_key,
                    project_aspect_ratio=str(
                        context.batch_snapshot.get("project_aspect_ratio") or "9:16"
                    ),
                )
    except PaymentRequiredQuote as exc:
        raise TaskAwaitingPayment(exc.job_id) from None
    except InsufficientBalance:
        raise TaskAwaitingPayment() from None
    except ProviderResultPending as exc:
        billing_job_id = exc.job_id or context.billing_job_id or context.settlement_key
        with session_factory() as db:
            job = db.get(GenerationJob, billing_job_id)
            if job is not None and job.status in {
                "payment_required",
                "payment_required_quote",
            }:
                raise TaskAwaitingPayment(job.id) from None
            record = _load_and_validate_snapshot(db, context, payload)
            if _already_published(media_store, record):
                return TaskExecutionResult(
                    _result_from_record(record, context.settlement_key)
                )
        raise TaskWaitingProvider(billing_job_id, poll_delay_seconds=5) from exc
    except (
        ProviderPricingUnstable,
        ProviderPricingUnavailable,
        NewApiRateLimited,
    ) as exc:
        raise RetryableTaskError(
            "provider_pricing_unavailable",
            "Video provider pricing is temporarily unavailable",
            retry_delay_seconds=0.25,
        ) from exc
    except ProviderGenerationFailed as exc:
        raise PermanentTaskError(
            exc.status,
            "Video provider generation failed without a charge",
            billing_job_id=exc.job_id,
        ) from None
    except (ProviderResultUnavailable, NewApiCallError) as exc:
        raise RetryableTaskError(
            "provider_call_failed",
            "Video provider call failed",
            retry_delay_seconds=0.25,
        ) from exc

    context.report_progress(90)
    return TaskExecutionResult(output)


def publish_generation_unit_video(
    context: TaskExecutionContext,
    result: dict[str, Any],
    target_version: int | None,
    *,
    session_factory: Callable[[], Session],
    media_store: WorkbenchStore,
) -> PublishOutcome:
    if (
        target_version is None
        or context.target_entity_type != "generation_unit"
        or context.target_entity_id is None
    ):
        return PublishOutcome.STALE
    with session_factory() as db:
        record = db.get(
            VideoGenerationUnit,
            (context.project_id, context.target_entity_id, target_version),
        )
        if record is None:
            return PublishOutcome.STALE
        expected_job_id = result.get("billing_job_id") or context.billing_job_id
        if (
            record.execution_key != context.generation_key
            or record.task_item_id != context.item_id
            or record.status != "complete"
            or not record.active
            or record.billing_job_id != expected_job_id
            or not record.output_asset_id
            or not record.output_path
            or not (
                media_store.project_dir(context.project_id) / record.output_path
            ).is_file()
        ):
            return PublishOutcome.STALE
        publication = (record.diagnostics_json or {}).get("publication")
        return (
            PublishOutcome.ALREADY_PUBLISHED
            if isinstance(publication, dict)
            and publication.get("billing_job_id") == expected_job_id
            else PublishOutcome.PUBLISHED
        )


def _load_and_validate_snapshot(
    db: Session,
    context: TaskExecutionContext,
    payload: dict[str, Any],
) -> VideoGenerationUnit:
    if (
        context.task_type != GENERATION_UNIT_VIDEO_TASK_TYPE
        or context.target_entity_type != "generation_unit"
        or context.target_entity_id is None
        or context.target_entity_version is None
        or context.generation_key is None
    ):
        raise PermanentTaskError(
            "generation_unit_snapshot_invalid",
            "Generation unit task identity is invalid",
        )
    record = db.get(
        VideoGenerationUnit,
        (
            context.project_id,
            context.target_entity_id,
            context.target_entity_version,
        ),
    )
    raw_unit = payload.get("generation_unit")
    source_shots = payload.get("source_shots")
    versions = payload.get("source_shot_versions")
    frozen_source_segment_ids = payload.get("source_segment_ids")
    prompt_contract = payload.get("prompt_contract")
    requested_duration = payload.get("requested_duration_seconds")
    if (
        record is None
        or not isinstance(raw_unit, dict)
        or not isinstance(source_shots, list)
        or not all(isinstance(shot, dict) for shot in source_shots)
        or not isinstance(versions, dict)
        or not isinstance(frozen_source_segment_ids, list)
        or not isinstance(prompt_contract, dict)
        or prompt_contract.get("version") != PROMPT_CONTRACT_VERSION
        or not isinstance(payload.get("compiled_prompt"), str)
        or not payload["compiled_prompt"].strip()
    ):
        raise PermanentTaskError(
            "generation_unit_snapshot_invalid",
            "Frozen generation unit task inputs are invalid",
        )
    source_ids = [str(value) for value in raw_unit.get("source_shot_ids") or []]
    source_beat_ids = [str(value) for value in raw_unit.get("source_beat_ids") or []]
    source_segment_ids = [
        str(value) for value in raw_unit.get("source_segment_ids") or []
    ]
    try:
        requested_matches = (
            abs(float(record.requested_duration_seconds) - float(requested_duration))
            <= 0.000001
        )
    except (TypeError, ValueError):
        requested_matches = False
    expected_operation = generation_unit_billing_operation(record.id, record.revision)
    if (
        record.task_item_id != context.item_id
        or record.execution_key != context.generation_key
        or record.id != raw_unit.get("id")
        or record.revision != raw_unit.get("revision")
        or record.revision != payload.get("ledger_revision")
        or record.source_shot_ids_json != source_ids
        or record.source_beat_ids_json != source_beat_ids
        or list(record.source_segment_ids_json or []) != source_segment_ids
        or frozen_source_segment_ids != source_segment_ids
        or record.source_shot_versions_json != versions
        or [str(shot.get("id")) for shot in source_shots] != source_ids
        or {str(shot.get("id")): int(shot.get("version") or 1) for shot in source_shots}
        != versions
        or record.profile_revision != payload.get("profile_revision")
        or raw_unit.get("profile", {}).get("profile_revision")
        != record.profile_revision
        or not requested_matches
        or record.model_id != context.model
        or record.model_id != raw_unit.get("model_id")
        or record.operation != raw_unit.get("operation")
        or prompt_contract.get("generation_unit_id") != record.id
        or prompt_contract.get("revision") != record.revision
        or prompt_contract.get("source_shot_ids") != source_ids
        or prompt_contract.get("source_beat_ids") != source_beat_ids
        or prompt_contract.get("source_segment_ids") != source_segment_ids
        or context.settlement_key != context.generation_key[:32]
        or expected_operation
        != f"generation_unit:{context.target_entity_id}:v{context.target_entity_version}"
        or context.batch_snapshot.get("generation_plan_id") != record.plan_id
        or (context.batch_snapshot.get("profile_revisions") or {}).get(record.id)
        != record.profile_revision
    ):
        raise PermanentTaskError(
            "generation_unit_snapshot_stale",
            "Frozen generation unit task inputs do not match the execution ledger",
        )
    return record


def _already_published(
    media_store: WorkbenchStore, record: VideoGenerationUnit
) -> bool:
    return bool(
        record.status == "complete"
        and record.active
        and record.billing_job_id
        and record.output_asset_id
        and record.output_path
        and (media_store.project_dir(record.project_id) / record.output_path).is_file()
    )


def _result_from_record(
    record: VideoGenerationUnit, settlement_key: str
) -> dict[str, Any]:
    return {
        "generation_unit_id": record.id,
        "generation_unit_revision": record.revision,
        "source_shot_ids": list(record.source_shot_ids_json),
        "source_beat_ids": list(record.source_beat_ids_json),
        "source_segment_ids": list(record.source_segment_ids_json or []),
        "output_asset_id": record.output_asset_id,
        "output_path": record.output_path,
        "billing_job_id": record.billing_job_id,
        "operation": generation_unit_billing_operation(record.id, record.revision),
        "requested_duration_seconds": record.requested_duration_seconds,
        "source_duration_seconds": record.source_duration_seconds,
        "publication_status": "published",
        "settlement_key": settlement_key,
    }


def _apply_previous_unit_tail(
    *,
    context: TaskExecutionContext,
    dependency: dict[str, Any],
    source_shots: list[dict[str, Any]],
    series_bible: dict[str, Any],
    session_factory: Callable[[], Session],
    media_store: WorkbenchStore,
) -> None:
    previous_id = str(dependency.get("previous_generation_unit_id") or "")
    previous_revision = int(dependency.get("previous_generation_unit_revision") or 0)
    with session_factory() as db:
        previous = db.get(
            VideoGenerationUnit,
            (context.project_id, previous_id, previous_revision),
        )
        tail = (
            (previous.diagnostics_json or {}).get("tail_frame")
            if previous is not None
            else None
        )
        if (
            previous is None
            or previous.status != "complete"
            or not previous.active
            or not previous.output_path
            or not isinstance(tail, dict)
        ):
            raise TaskWaitingDependency(
                PREVIOUS_GENERATION_UNIT_MISSING_CODE,
                PREVIOUS_GENERATION_UNIT_MISSING_MESSAGE,
            )
    if not dependency.get("inherit_previous_tail"):
        return
    tail_path = str(tail.get("path") or "")
    if (
        not tail_path
        or not (media_store.project_dir(context.project_id) / tail_path).is_file()
    ):
        raise TaskWaitingDependency(
            PREVIOUS_GENERATION_UNIT_MISSING_CODE,
            PREVIOUS_GENERATION_UNIT_MISSING_MESSAGE,
        )
    asset_id = str(tail.get("asset_id") or "")
    asset = {
        "id": asset_id,
        "kind": "scene",
        "label": f"{previous_id} tail frame",
        "source_type": "video_frame",
        "status": "ready",
        "reference_images": [tail_path],
        "provenance": {
            "generation_unit_id": previous_id,
            "generation_unit_revision": previous_revision,
            "media_sha256": tail.get("media_sha256"),
        },
    }
    assets = [
        item
        for item in series_bible.get("assets", [])
        if isinstance(item, dict) and str(item.get("id")) != asset_id
    ]
    assets.append(asset)
    series_bible["assets"] = assets
    continuity = dict(source_shots[0].get("continuity") or {})
    continuity.update(
        {
            "inherited_first_frame_asset_id": asset_id,
            "first_frame": {
                "asset_id": asset_id,
                "version": previous_revision,
                "status": "ready",
                "source": "generation_unit_tail",
                "origin_generation_unit_id": previous_id,
                "origin_generation_unit_revision": previous_revision,
            },
            "stale": False,
        }
    )
    source_shots[0]["continuity"] = continuity
