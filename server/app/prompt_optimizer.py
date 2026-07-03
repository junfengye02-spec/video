from __future__ import annotations

import json
from typing import Any

import requests

from server.app.settings import DEFAULT_SYAPI_BASE_URL


def _build_user_message(source_text: str, context: dict[str, Any] | None = None) -> str:
    context = context or {}
    lines = [
        f"Target: {context.get('target', 'project')}",
        f"Target ID: {context.get('target_id', '')}",
    ]
    if context.get("mode") == "shot_json":
        lines.append(
            "Return JSON only with prompt, shot_intent, and shot_language. "
            "shot_language must use OpenMontage enum values."
        )
    else:
        lines.append("Return only the revised prompt text.")
    lines.append("")
    lines.append(source_text.strip())
    return "\n".join(lines)


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

    if context and context.get("mode") == "shot_json":
        parsed = json.loads(str(content).strip())
        optimized_text = str(parsed.get("prompt", "")).strip() or source_text.strip()
        return {
            "optimized_text": optimized_text,
            "shot_intent": parsed.get("shot_intent"),
            "shot_language": parsed.get("shot_language"),
            "notes": ["rewritten by text model as structured shot JSON"],
        }

    return {
        "optimized_text": str(content).strip(),
        "notes": ["rewritten by text model"],
    }
