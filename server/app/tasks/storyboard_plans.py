from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Any

from sqlalchemy.orm import Session

from server.app.billing.execution import (
    PaymentRequiredQuote,
    ProviderPricingUnstable,
    ProviderResultPending,
    ProviderResultUnavailable,
)
from server.app.billing.service import ProviderPricingUnavailable
from server.app.projects.repository import ProjectRepository
from server.app.provider.newapi import (
    InvalidNewApiResponse,
    NewApiCallError,
    NewApiRateLimited,
)
from server.app.storage import WorkbenchStore
from server.app.storyboard_generator import generate_short_drama_storyboard_billed_result
from server.app.tasks.worker import (
    RetryableTaskError,
    TaskAwaitingPayment,
    TaskExecutionContext,
    TaskExecutionResult,
    TaskWaitingProvider,
)
from server.app.wallet.service import InsufficientBalance


STORYBOARD_PLAN_TASK_TYPE = "storyboard.plan"


def execute_storyboard_plan(
    context: TaskExecutionContext,
    *,
    session_factory: Callable[[], Session],
    media_store: WorkbenchStore,
    settings_factory: Callable[[], Any],
    newapi_context: Callable[[Any], AbstractContextManager[Any]],
) -> TaskExecutionResult:
    payload = context.input_snapshot
    context.report_progress(5)
    try:
        with session_factory() as db:
            project = ProjectRepository(db).require_owned_for_read(
                context.project_id, context.owner_user_id
            )
            settings = settings_factory()
            with newapi_context(settings) as newapi:
                generated = generate_short_drama_storyboard_billed_result(
                    db=db,
                    newapi=newapi,
                    settings=settings,
                    media_store=media_store,
                    user_id=context.owner_user_id,
                    project_id=context.project_id,
                    title=project.title,
                    prompt=str(payload["prompt"]),
                    model=str(payload["text_model"]),
                    shot_count=payload.get("shot_count"),
                    project_type=str(payload["project_type"]),
                    narrative_beats=payload.get("narrative_beats"),
                    billing_job_id=context.billing_job_id,
                    settlement_key=context.settlement_key,
                )
    except PaymentRequiredQuote as exc:
        raise TaskAwaitingPayment(exc.job_id) from None
    except InsufficientBalance:
        raise TaskAwaitingPayment() from None
    except ProviderResultPending as exc:
        raise TaskWaitingProvider(
            exc.job_id or context.billing_job_id or context.settlement_key
        ) from None
    except (ProviderPricingUnstable, ProviderPricingUnavailable, NewApiRateLimited) as exc:
        raise RetryableTaskError(
            "provider_pricing_unavailable",
            "Storyboard provider pricing is temporarily unavailable",
            retry_delay_seconds=0.5,
        ) from exc
    except (ProviderResultUnavailable, NewApiCallError, InvalidNewApiResponse, ValueError) as exc:
        raise RetryableTaskError(
            "storyboard_generation_failed",
            "Text model storyboard generation failed",
            retry_delay_seconds=0.5,
        ) from exc

    context.report_progress(85)
    return TaskExecutionResult(
        {
            "billing_job_id": generated.job_id,
            "plan": generated.value,
            "request_fingerprint": str(payload["request_fingerprint"]),
        }
    )
