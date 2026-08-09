from __future__ import annotations

from typing import Any

import requests

from server.app.billing.execution import (
    StagedProviderResult,
    execute_billed_provider_call,
    finalize_billed_sync_result,
    retry_payment_required_quote,
)
from server.app.model_output_normalization import normalize_shot_language, parse_model_json
from server.app.provider.newapi import PreparedNewApiRequest
from server.app.settings import DEFAULT_SYAPI_BASE_URL


_ASSET_KIND_INSTRUCTIONS = {
    "character": (
        "Create a short-drama character turnaround/model sheet with coordinated front, "
        "three-quarter, profile, and back full-body views. Keep the same face and identity, "
        "age, body proportions, hairstyle, costume, accessories, and color palette in every "
        "view. Use a neutral pose and expression, clean background, and even reference lighting."
    ),
    "scene": (
        "Create a short-drama environment continuity board with coordinated wide establishing, "
        "eye-level master, side or reverse angle, and key detail views. Keep architecture, "
        "entrances, fixed props, spatial layout, time of day, lighting, weather, and color palette "
        "consistent across every view."
    ),
    "prop": (
        "Create a short-drama prop turnaround/reference sheet with coordinated front, "
        "three-quarter, side or back, and material/detail views. Keep the object's shape, scale, "
        "materials, wear, markings, and colors consistent across every view."
    ),
}


def _build_user_message(source_text: str, context: dict[str, Any] | None = None) -> str:
    context = context or {}
    lines = [
        f"Target: {context.get('target', 'project')}",
        f"Target ID: {context.get('target_id', '')}",
    ]
    if context.get("mode") == "shot_json":
        lines.append(
            "Return exactly one JSON object with prompt, shot_intent, and shot_language. "
            "Do not return markdown fences, arrays, language names, history, or extra commentary. "
            "shot_language may contain only these optional fields: shot_size, camera_movement, "
            "lens_mm, lighting_key, depth_of_field, color_temperature. "
            "Allowed shot_size values: extreme_wide, wide, medium_wide, medium, medium_close, "
            "close_up, extreme_close_up, over_shoulder, insert, establishing. "
            "Allowed camera_movement values: static, pan_left, pan_right, tilt_up, tilt_down, "
            "dolly_in, dolly_out, tracking_left, tracking_right, crane_up, crane_down, handheld, "
            "steadicam, whip_pan, orbital, zoom_in, zoom_out, rack_focus. "
            "Allowed lens_mm values: 14, 24, 35, 50, 85, 135, 200. "
            "Allowed lighting_key values: high_key, low_key, natural, golden_hour, blue_hour, "
            "tungsten_warm, neon, silhouette, rim_lit, volumetric, overcast_soft. "
            "Allowed depth_of_field values: shallow, medium, deep. "
            "Allowed color_temperature values: cool, neutral, warm, mixed. "
            "If unsure, omit that shot_language field instead of inventing a value. "
            "Rewrite prompt as a detailed executable video-generation instruction in the source "
            "language, not a synopsis. Use 6-10 concrete clauses covering the locked subject and "
            "appearance, scene/time/weather/spatial layout, chronological visible action from start "
            "state to end state, camera height/angle/framing/lens/movement/focus, lighting/color/"
            "materials/atmosphere, prop positions and interactions, and continuity handoff. End with "
            "negative constraints against new people or objects, identity or wardrobe drift, skipped "
            "actions, unexplained cuts, anatomy or object deformation, style drift, and impossible "
            "motion. Keep all original plot facts and do not invent new story events."
        )
    elif context.get("target") == "asset":
        lines.append(
            "Rewrite this as a production-ready image-generation prompt for visual consistency "
            "in a short drama. Preserve the subject, identity, action, and intent. Improve concrete "
            "visual composition, lighting, color, materials, depth, and atmosphere only when they "
            "support the original request."
        )
        asset_kind_instruction = _ASSET_KIND_INSTRUCTIONS.get(context.get("asset_kind"))
        if asset_kind_instruction:
            lines.append(asset_kind_instruction)
        lines.append(
            "Do not add unrelated objects, captions, labels, logos, or watermarks. "
            "Return only the revised prompt text."
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
                    "content": (
                        "You optimize prompts for OpenMontage. Keep the user's intent while improving clarity. "
                        "When structured JSON is requested, output only a schema-compliant JSON object."
                    ),
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
        parsed = _parse_structured_shot_response(content)
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
                    "content": (
                        "You optimize prompts for OpenMontage. Keep the user's intent while improving clarity. "
                        "When structured JSON is requested, output only a schema-compliant JSON object."
                    ),
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


def _parse_structured_shot_response(content: Any) -> dict[str, Any]:
    parsed = parse_model_json(content)
    if isinstance(parsed, list):
        parsed = next((item for item in parsed if isinstance(item, dict)), {})
    if not isinstance(parsed, dict):
        raise ValueError("Prompt optimizer returned a non-object JSON value")
    return parsed
