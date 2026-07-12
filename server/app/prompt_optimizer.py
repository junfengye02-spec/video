from __future__ import annotations

import json
from typing import Any

import requests

from server.app.billing.execution import (
    StagedProviderResult,
    execute_billed_provider_call,
    finalize_billed_sync_result,
    retry_payment_required_quote,
)
from server.app.model_output_normalization import normalize_shot_language
from server.app.provider.newapi import PreparedNewApiRequest
from server.app.settings import DEFAULT_SYAPI_BASE_URL


def _build_user_message(source_text: str, context: dict[str, Any] | None = None) -> str:
    context = context or {}
    lines = [
        f"Target: {context.get('target', 'project')}",
        f"Target ID: {context.get('target_id', '')}",
    ]
    if context.get("mode") == "shot_json":
        lines.append(
            "Return exactly one JSON object with prompt, shot_intent, and shot_language. "
            "shot_language must use OpenMontage enum values."
        )
    else:
        lines.append("Return only the revised prompt text.")
    lines.append("")
    lines.append(source_text.strip())
    return "\n".join(lines)


def prepare_prompt_optimization_request(
    source_text: str,
    model: str,
    context: dict[str, Any] | None = None,
) -> PreparedNewApiRequest:
    return PreparedNewApiRequest.json(
        "POST",
        "/v1/chat/completions",
        {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "You optimize prompts for OpenMontage. Keep the user's intent while improving clarity.",
                },
                {
                    "role": "user",
                    "content": _build_user_message(source_text, context=context),
                },
            ],
        },
    )


def _optimization_result(content: Any, source_text: str, context: dict[str, Any] | None):
    if context and context.get("mode") == "shot_json":
        parsed = json.loads(str(content).strip())
        optimized_text = str(parsed.get("prompt", "")).strip() or source_text.strip()
        return {
            "optimized_text": optimized_text,
            "shot_intent": parsed.get("shot_intent"),
            "shot_language": _normalize_structured_shot_language(
                parsed.get("shot_language")
            ),
            "notes": ["rewritten by text model as structured shot JSON"],
        }
    return {
        "optimized_text": str(content).strip(),
        "notes": ["rewritten by text model"],
    }


def _normalize_structured_shot_language(value: Any) -> dict[str, Any] | None:
    normalized = normalize_shot_language(value)
    if normalized is not None or not isinstance(value, dict):
        return normalized
    cleaned: dict[str, Any] = {}
    for field in (
        "shot_size",
        "camera_movement",
        "lens_mm",
        "lighting_key",
        "depth_of_field",
        "color_temperature",
    ):
        candidate = normalize_shot_language({field: value.get(field)})
        if candidate is not None and field in candidate:
            cleaned[field] = candidate[field]
    return cleaned or None


def optimize_text_prompt_billed(
    *, db, newapi, settings, media_store, user_id: str, project_id: str,
    source_text: str, model: str, context: dict[str, Any] | None = None,
    billing_job_id: str | None = None,
) -> dict[str, Any]:
    request = prepare_prompt_optimization_request(source_text, model, context)
    call = {
        "db": db,
        "newapi": newapi,
        "settings": settings,
        "artifact_inspector": media_store.inspect_staged_artifact,
        "user_id": user_id,
        "project_id": project_id,
        "capability": "text",
        "operation": "prompt_optimization",
        "request": request,
    }
    context_result = (
        execute_billed_provider_call(parent_job_id=None, **call)
        if billing_job_id is None
        else retry_payment_required_quote(job_id=billing_job_id, **call)
    )

    def persist_hidden(job_id, response):
        try:
            content = response.json()["choices"][0]["message"]["content"]
        except Exception:
            raise ValueError("prompt optimizer returned an invalid result") from None
        value = _optimization_result(content, source_text, context)
        artifact = media_store.stage_sync_result(
            project_id=project_id,
            job_id=job_id,
            operation="prompt_optimization",
            capability="text",
            source_reference=context_result.execution.reference_id,
            content=response.content,
        )
        return StagedProviderResult(artifact.locator, artifact.sha256, value)

    staged = finalize_billed_sync_result(
        db=db,
        newapi=newapi,
        settings=settings,
        artifact_inspector=media_store.inspect_staged_artifact,
        context=context_result,
        persist_hidden=persist_hidden,
    )
    return staged.value


def optimize_text_prompt(
    source_text: str,
    model: str,
    base_url: str,
    api_key: str,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_base_url = base_url.strip() or DEFAULT_SYAPI_BASE_URL
    response = requests.post(
        url=f"{normalized_base_url.rstrip('/')}/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "You optimize prompts for OpenMontage. Keep the user's intent while improving clarity.",
                },
                {
                    "role": "user",
                    "content": _build_user_message(source_text, context=context),
                },
            ],
        },
        timeout=60,
    )
    response.raise_for_status()
    payload = response.json()
    content = payload["choices"][0]["message"]["content"]

    return _optimization_result(content, source_text, context)
