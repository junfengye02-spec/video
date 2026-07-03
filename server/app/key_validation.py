from __future__ import annotations

from typing import Any

import requests


def validate_gateway_models(
    *,
    base_url: str,
    text_key: str,
    image_key: str,
    video_key: str,
    text_model: str,
    image_model: str,
    video_model: str,
) -> dict[str, Any]:
    checks = [
        ("text", text_key, text_model),
        ("image", image_key, image_model),
        ("video", video_key, video_model),
    ]
    errors: list[str] = []
    for label, key, model in checks:
        try:
            model_ids = _list_models(base_url, key)
        except Exception as exc:
            errors.append(f"{label} key validation failed: {exc}")
            continue
        if model and model not in model_ids:
            errors.append(f"{label} model '{model}' was not returned by provider model list")
    return {"valid": not errors, "errors": errors}


def _list_models(base_url: str, api_key: str) -> set[str]:
    response = requests.get(
        f"{base_url.rstrip('/')}/v1/models",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    return {str(item.get("id")) for item in payload.get("data", []) if item.get("id")}
