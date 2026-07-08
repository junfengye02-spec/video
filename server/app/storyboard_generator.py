from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import requests

from server.app.model_output_normalization import normalize_shot_language
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
    shot_count: int | None = None,
) -> dict[str, Any]:
    requested_shot_count = _requested_shot_count(shot_count)
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
                    "content": f"Title: {title.strip()}\nBrief: {prompt.strip()}\nShots: {requested_shot_count}",
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
    if isinstance(parsed, list):
        return {"series_bible": {}, "storyboard": {"shots": parsed}}
    if not isinstance(parsed, dict):
        raise ValueError("Storyboard generator returned a non-object JSON value")
    return parsed


def _normalize_storyboard(data: dict[str, Any], title: str) -> None:
    if not isinstance(data.get("series_bible"), dict):
        data["series_bible"] = {}
    series_bible = data.setdefault("series_bible", {})
    series_bible.setdefault("title", title)
    series_bible.setdefault("mode", "short_drama")
    series_bible.setdefault("characters", [])
    if not isinstance(series_bible.get("characters"), list):
        series_bible["characters"] = []
    if isinstance(data.get("storyboard"), list):
        data["storyboard"] = {"shots": data["storyboard"]}
    if not isinstance(data.get("storyboard"), dict):
        data["storyboard"] = {}
    storyboard = data.setdefault("storyboard", {})
    if not isinstance(storyboard.get("shots"), list):
        storyboard["shots"] = []
    shots = storyboard.setdefault("shots", [])
    for index, shot in enumerate(shots, start=1):
        if not isinstance(shot, dict):
            raise ValueError("Storyboard generator returned a non-object shot")
        shot.setdefault("id", f"s{index}")
        shot.setdefault("scene_id", f"scene-{index}")
        shot.setdefault("index", index)
        shot["characters"] = _normalize_string_list(shot.get("characters"))
        shot.setdefault("props", [])
        shot.setdefault("status", "ready")
        shot.setdefault("consistency_score", 100)
        shot.setdefault("output_url", None)
        shot.setdefault("output_path", None)
        shot.setdefault("asset_ids", [])
        shot["shot_language"] = normalize_shot_language(shot.get("shot_language"))
        shot.setdefault("version", 1)
        shot.setdefault("history", [_history_entry(shot)])
        Shot(**shot)
    _ensure_series_characters(series_bible, shots)


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


def _requested_shot_count(shot_count: int | None) -> int:
    if shot_count is None:
        return 5
    return min(max(int(shot_count), 1), 60)


def _normalize_string_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _ensure_series_characters(series_bible: dict[str, Any], shots: list[dict[str, Any]]) -> None:
    characters = series_bible.setdefault("characters", [])
    known_ids = {
        str(character.get("id"))
        for character in characters
        if isinstance(character, dict) and character.get("id")
    }
    for character_id in _ordered_character_ids(shots):
        if character_id in known_ids:
            continue
        name = _humanize_id(character_id)
        characters.append(
            {
                "id": character_id,
                "name": name,
                "role": "unspecified",
                "visual_lock": f"{name}; maintain a consistent appearance across shots",
                "voice": None,
                "reference_images": [],
                "locked": True,
            }
        )
        known_ids.add(character_id)


def _ordered_character_ids(shots: list[dict[str, Any]]) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for shot in shots:
        for character_id in shot.get("characters", []):
            value = str(character_id).strip()
            if value and value not in seen:
                ordered.append(value)
                seen.add(value)
    return ordered


def _humanize_id(value: str) -> str:
    words = [word for word in value.replace("-", "_").split("_") if word]
    if not words:
        return value
    return " ".join(word.capitalize() for word in words)
