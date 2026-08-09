from __future__ import annotations

from collections.abc import Callable
from typing import Any, ContextManager

from sqlalchemy.orm import Session

from server.app.billing.execution import (
    PaymentRequiredQuote,
    ProviderPricingUnstable,
    ProviderResultPending,
    ProviderResultUnavailable,
)
from server.app.billing.service import ProviderPricingUnavailable
from server.app.provider.image_generation import generate_billed_project_image
from server.app.provider.newapi import NewApiCallError, NewApiRateLimited
from server.app.storage import WorkbenchStore
from server.app.tasks.worker import (
    RetryableTaskError,
    TaskAwaitingPayment,
    TaskExecutionContext,
    TaskExecutionResult,
)
from server.app.wallet.service import InsufficientBalance


def execute_resource_image(
    context: TaskExecutionContext,
    *,
    session_factory: Callable[[], Session],
    media_store: WorkbenchStore,
    settings_factory: Callable[[], Any],
    newapi_context: Callable[[Any], ContextManager[Any]],
) -> TaskExecutionResult:
    """Run the existing billed image flow from the immutable task snapshot."""
    payload = context.input_snapshot
    context.report_progress(5)
    try:
        with session_factory() as db:
            settings = settings_factory()
            with newapi_context(settings) as newapi:
                generated = generate_billed_project_image(
                    db=db,
                    newapi=newapi,
                    settings=settings,
                    media_store=media_store,
                    user_id=context.owner_user_id,
                    project_id=context.project_id,
                    prompt=str(payload["prompt"]),
                    model=str(payload["model"]),
                    count=int(payload["count"]),
                    size=str(payload["size"]),
                    quality=str(payload["quality"]),
                    billing_job_id=context.billing_job_id,
                    # The task item id is a stable, valid GenerationJob id.  It
                    # makes worker recovery resume the original provider charge.
                    settlement_key=context.item_id,
                )
    except PaymentRequiredQuote as exc:
        raise TaskAwaitingPayment(exc.job_id) from None
    except InsufficientBalance:
        # No provider reservation or hold exists yet.  The task remains
        # resumable after the wallet is funded, without charging in advance.
        raise TaskAwaitingPayment() from None
    except ProviderResultPending as exc:
        raise RetryableTaskError(
            "provider_result_pending",
            "Image provider result is still being reconciled",
            retry_delay_seconds=5,
        ) from exc
    except (ProviderPricingUnstable, ProviderPricingUnavailable, NewApiRateLimited) as exc:
        raise RetryableTaskError(
            "provider_pricing_unavailable",
            "Image provider pricing is temporarily unavailable",
            retry_delay_seconds=0.25,
        ) from exc
    except (ProviderResultUnavailable, NewApiCallError) as exc:
        raise RetryableTaskError(
            "provider_call_failed",
            "Image provider call failed",
            retry_delay_seconds=0.25,
        ) from exc

    context.report_progress(85)
    return TaskExecutionResult(
        {
            "billing_job_id": generated.job_id,
            "storage_paths": list(generated.paths),
            "asset": {
                "kind": str(payload["kind"]),
                "label": str(payload["label"]),
                "description": str(payload.get("description") or ""),
                "prompt": str(payload["prompt"]),
                "model": str(payload["model"]),
            },
            "settlement_key": context.settlement_key,
        }
    )
