from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from server.app.consistency import apply_consistency_scores, evaluate_storyboard_consistency


def build_mock_short_drama(prompt: str) -> dict[str, Any]:
    theme = prompt.strip() or "urban reversal short drama"
    characters = [
        {
            "id": "c1",
            "name": "Lin",
            "role": "lead investigator",
            "visual_lock": "red coat, short hair",
            "voice": None,
            "reference_images": [],
            "locked": True,
        },
        {
            "id": "c2",
            "name": "Chen",
            "role": "boss hiding the truth",
            "visual_lock": "black suit, silver glasses",
            "voice": None,
            "reference_images": [],
            "locked": True,
        },
        {
            "id": "c3",
            "name": "Aunt Mei",
            "role": "neighbor with the clue",
            "visual_lock": "gray scarf, warm eyes",
            "voice": None,
            "reference_images": [],
            "locked": False,
        },
    ]
    style_lock = "rainy neon suspense, vertical short drama, high contrast"
    beats = [
        (
            "Rain-night hook",
            "Lin in red coat, short hair finds a soaked envelope under neon rain",
            "Introduce Lin's mystery and the first clue.",
            {
                "shot_size": "medium_close",
                "camera_movement": "dolly_in",
                "lens_mm": 50,
                "depth_of_field": "shallow",
                "lighting_key": "neon",
                "color_temperature": "cool",
            },
        ),
        (
            "Conflict rises",
            "Chen in black suit, silver glasses blocks Lin at the office elevator",
            "Show Chen interrupting Lin before she can act on the clue.",
            {
                "shot_size": "medium",
                "camera_movement": "tracking_right",
                "lens_mm": 35,
                "depth_of_field": "medium",
                "lighting_key": "low_key",
                "color_temperature": "mixed",
            },
        ),
        (
            "Clue revealed",
            "Aunt Mei with gray scarf, warm eyes shows Lin a hidden recording",
            "Reveal the witness and deepen the conspiracy.",
            {
                "shot_size": "over_shoulder",
                "camera_movement": "rack_focus",
                "lens_mm": 85,
                "depth_of_field": "shallow",
                "lighting_key": "overcast_soft",
                "color_temperature": "neutral",
            },
        ),
        (
            "Reversal",
            "Lin in red coat, short hair confronts Chen beside the alley billboard",
            "Flip the power dynamic as Lin confronts Chen with evidence.",
            {
                "shot_size": "medium_wide",
                "camera_movement": "handheld",
                "lens_mm": 35,
                "depth_of_field": "medium",
                "lighting_key": "neon",
                "color_temperature": "cool",
            },
        ),
        (
            "Cliffhanger",
            "Lin in red coat, short hair walks into dawn holding the evidence",
            "Leave the ending open while Lin moves toward the next reveal.",
            {
                "shot_size": "wide",
                "camera_movement": "dolly_out",
                "lens_mm": 24,
                "depth_of_field": "deep",
                "lighting_key": "blue_hour",
                "color_temperature": "cool",
            },
        ),
    ]

    shots = []
    for index, (beat, shot_prompt, shot_intent, shot_language) in enumerate(beats, start=1):
        character_ids = ["c1"]
        if index in (2, 4):
            character_ids.append("c2")
        if index == 3:
            character_ids.append("c3")

        location = "rainy neon alley" if index != 2 else "office elevator lobby"
        props = ["envelope", "phone"] if index in (1, 3, 5) else ["security badge"]
        prompt_text = f"{shot_prompt}. Story seed: {theme}. Style: {style_lock}"
        shots.append(
            {
                "id": f"s{index}",
                "scene_id": f"scene-{(index + 1) // 2}",
                "index": index,
                "beat": beat,
                "prompt": prompt_text,
                "characters": character_ids,
                "location": location,
                "props": props,
                "shot_intent": shot_intent,
                "shot_language": shot_language,
                "status": "ready",
                "consistency_score": 100,
                "output_url": None,
                "output_path": None,
                "asset_ids": [],
                "aspect_ratio": "9:16",
                "visual_style": style_lock,
                "version": 1,
                "history": [
                    {
                        "version": 1,
                        "source": "create",
                        "prompt": prompt_text,
                        "characters": list(character_ids),
                        "location": location,
                        "props": list(props),
                        "asset_ids": [],
                        "shot_intent": shot_intent,
                        "shot_language": shot_language,
                        "updated_at": _utc_now(),
                    }
                ],
            }
        )

    series_bible = {
        "title": _title_from_prompt(theme),
        "mode": "short_drama",
        "style_lock": style_lock,
        "characters": characters,
    }
    storyboard = {"shots": shots}
    report = evaluate_storyboard_consistency(series_bible, storyboard)
    apply_consistency_scores(storyboard, report)

    return {
        "series_bible": series_bible,
        "storyboard": storyboard,
        "consistency_report": report,
    }


def update_mock_shot(
    storyboard: dict[str, Any],
    shot_id: str,
    edits: dict[str, Any],
    source: str = "prompt_edit",
) -> dict[str, Any]:
    clearable_keys = {"episode_number", "location", "shot_intent", "shot_language"}
    editable_keys = (
        "episode_number",
        "prompt",
        "characters",
        "location",
        "props",
        "asset_ids",
        "shot_intent",
        "shot_language",
        "continuity",
    )
    for shot in storyboard.get("shots", []):
        if shot.get("id") != shot_id:
            continue
        changed_fields: dict[str, Any] = {}
        for key in editable_keys:
            if key not in edits:
                continue
            value = edits[key]
            if value is None and key not in clearable_keys:
                continue
            if shot.get(key) == value:
                continue
            changed_fields[key] = value
        if not changed_fields:
            return shot
        version = int(shot.get("version", 1)) + 1
        history = list(shot.get("history", []))
        history.append(
            {
                "version": version - 1,
                "source": source,
                "prompt": shot.get("prompt", ""),
                "characters": list(shot.get("characters", [])),
                "location": shot.get("location"),
                "props": list(shot.get("props", [])),
                "asset_ids": list(shot.get("asset_ids", [])),
                "shot_intent": shot.get("shot_intent"),
                "shot_language": shot.get("shot_language"),
                "continuity": shot.get("continuity") or {
                    "mode": "cut",
                    "inherit_previous_tail": False,
                },
                "updated_at": _utc_now(),
            }
        )
        for key, value in changed_fields.items():
            shot[key] = value
        shot["version"] = version
        shot["status"] = (
            "complete"
            if shot.get("output_path") or shot.get("output_url")
            else "ready"
        )
        shot["history"] = history
        return shot
    raise KeyError(f"Shot '{shot_id}' not found")


def regenerate_mock_shot(storyboard: dict[str, Any], shot_id: str, edits: dict[str, Any] | None = None) -> dict[str, Any]:
    edits = edits or {}
    if "prompt" not in edits:
        for shot in storyboard.get("shots", []):
            if shot.get("id") == shot_id:
                version = int(shot.get("version", 1)) + 1
                edits["prompt"] = f"{shot.get('prompt', '').split(' Variant ')[0]} Variant {version}: tighter framing and clearer emotion."
                break
    return update_mock_shot(storyboard, shot_id, edits, source="regenerate")


def _title_from_prompt(prompt: str) -> str:
    cleaned = prompt.replace("\n", " ").strip()
    return cleaned[:32] if cleaned else "Short Drama"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
