from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import requests

from server.app.models import Shot


SYSTEM_PROMPT = """Create short-drama storyboard JSON only.
Return one JSON object with series_bible and storyboard.
Every shot must include id, scene_id, index, beat, prompt, characters, location, props,
shot_intent, and shot_language.
shot_language must use these fields when relevant:
shot_size, camera_movement, lens_mm, lighting_key, depth_of_field, color_temperature.
Use the exact enum vocabulary from OpenMontage scene_plan.schema.json.
Return no markdown fences and no commentary."""


def generate_short_drama_storyboard(
    *,
    title: str,
    prompt: str,
    model: str,
    base_url: str,
    api_key: str,
) -> dict[str, Any]:
    response = requests.post(
        f"{base_url.rstrip('/')}/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "temperature": 0.4,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": f"Title: {title.strip()}\nBrief: {prompt.strip()}\nShots: 5",
                },
            ],
        },
        timeout=90,
    )
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"]
    data = _parse_json_object(str(content))
    _normalize_storyboard(data, title)
    return data


def _parse_json_object(content: str) -> dict[str, Any]:
    stripped = content.strip()
    if stripped.startswith("```"):
        stripped = stripped.strip("`")
        if stripped.startswith("json"):
            stripped = stripped[4:].strip()
    parsed = json.loads(stripped)
    if not isinstance(parsed, dict):
        raise ValueError("Storyboard generator returned a non-object JSON value")
    return parsed


def _normalize_storyboard(data: dict[str, Any], title: str) -> None:
    series_bible = data.setdefault("series_bible", {})
    series_bible.setdefault("title", title)
    series_bible.setdefault("mode", "short_drama")
    series_bible.setdefault("characters", [])
    storyboard = data.setdefault("storyboard", {})
    shots = storyboard.setdefault("shots", [])
    for index, shot in enumerate(shots, start=1):
        shot.setdefault("id", f"s{index}")
        shot.setdefault("scene_id", f"scene-{index}")
        shot.setdefault("index", index)
        shot.setdefault("characters", [])
        shot.setdefault("props", [])
        shot.setdefault("status", "ready")
        shot.setdefault("consistency_score", 100)
        shot.setdefault("output_url", None)
        shot.setdefault("output_path", None)
        shot.setdefault("asset_ids", [])
        shot.setdefault("version", 1)
        shot.setdefault("history", [_history_entry(shot)])
        Shot(**shot)


def _history_entry(shot: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": 1,
        "source": "create",
        "prompt": str(shot.get("prompt", "")),
        "characters": list(shot.get("characters", [])),
        "location": shot.get("location"),
        "props": list(shot.get("props", [])),
        "asset_ids": list(shot.get("asset_ids", [])),
        "shot_intent": shot.get("shot_intent"),
        "shot_language": shot.get("shot_language"),
        "updated_at": datetime.now(UTC).isoformat(),
    }
