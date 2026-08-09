from __future__ import annotations

import re
from typing import Any


def evaluate_storyboard_consistency(
    series_bible: dict[str, Any],
    storyboard: dict[str, Any],
) -> dict[str, Any]:
    characters = {
        character.get("id"): character
        for character in series_bible.get("characters", [])
        if character.get("id")
    }
    assets = {
        asset.get("id"): asset
        for asset in series_bible.get("assets", [])
        if asset.get("id")
    }
    shots = storyboard.get("shots", [])
    issues: list[dict[str, str | None]] = []

    previous_aspect_ratio = None
    previous_visual_style = None
    for shot in shots:
        shot_id = shot.get("id")
        prompt = str(shot.get("prompt", ""))

        for character_id in shot.get("characters", []):
            character = characters.get(character_id)
            if character is None:
                issues.append(
                    _issue(
                        shot_id,
                        "error",
                        "unknown_character",
                        f"Shot references unknown character '{character_id}'.",
                    )
                )
                continue

            visual_lock = str(character.get("visual_lock", "")).strip()
            if (
                character.get("locked")
                and visual_lock
                and not _prompt_carries_visual_lock(prompt, character, visual_lock)
            ):
                issues.append(
                    _issue(
                        shot_id,
                        "warning",
                        "missing_visual_lock",
                        f"Locked character {character.get('name', character_id)} is missing visual lock.",
                    )
                )

        if not shot.get("location"):
            issues.append(
                _issue(
                    shot_id,
                    "warning",
                    "missing_location",
                    "Shot has no location.",
                )
            )

        shot_language = shot.get("shot_language") or {}
        if not shot_language.get("shot_size") or not shot_language.get("camera_movement"):
            issues.append(
                _issue(
                    shot_id,
                    "warning",
                    "missing_shot_language",
                    "Shot is missing shot size or camera movement.",
                )
            )

        for asset_id in shot.get("asset_ids", []) or []:
            if asset_id not in assets:
                issues.append(
                    _issue(
                        shot_id,
                        "error",
                        "unknown_asset",
                        f"Shot references unknown asset '{asset_id}'.",
                    )
                )

        aspect_ratio = shot.get("aspect_ratio")
        if previous_aspect_ratio and aspect_ratio and aspect_ratio != previous_aspect_ratio:
            issues.append(
                _issue(
                    shot_id,
                    "warning",
                    "aspect_ratio_shift",
                    "Adjacent shots change aspect ratio.",
                )
            )
        if aspect_ratio:
            previous_aspect_ratio = aspect_ratio

        visual_style = shot.get("visual_style")
        if previous_visual_style and visual_style and visual_style != previous_visual_style:
            issues.append(
                _issue(
                    shot_id,
                    "warning",
                    "visual_style_shift",
                    "Adjacent shots change visual style.",
                )
            )
        if visual_style:
            previous_visual_style = visual_style

    score = max(0, 100 - sum(_penalty(issue["severity"]) for issue in issues))
    return {"score": score, "issues": issues}


def apply_consistency_scores(storyboard: dict[str, Any], report: dict[str, Any]) -> dict[str, Any]:
    penalties_by_shot: dict[str, int] = {}
    for issue in report.get("issues", []):
        shot_id = issue.get("shot_id")
        if shot_id:
            penalties_by_shot[shot_id] = penalties_by_shot.get(shot_id, 0) + _penalty(issue.get("severity"))
    for shot in storyboard.get("shots", []):
        shot["consistency_score"] = max(0, 100 - penalties_by_shot.get(shot.get("id"), 0))
    return storyboard


def _issue(shot_id: str | None, severity: str, code: str, message: str) -> dict[str, str | None]:
    return {
        "shot_id": shot_id,
        "severity": severity,
        "code": code,
        "message": message,
    }


def _prompt_carries_visual_lock(
    prompt: str,
    character: dict[str, Any],
    visual_lock: str,
) -> bool:
    normalized_prompt = prompt.casefold()
    if visual_lock.casefold() in normalized_prompt:
        return True

    identity_anchors = {
        str(character.get(key) or "").strip().casefold()
        for key in ("id", "name")
    } - {""}
    if not any(anchor in normalized_prompt for anchor in identity_anchors):
        return False

    lock_without_identity = visual_lock.casefold()
    for anchor in identity_anchors:
        lock_without_identity = lock_without_identity.replace(anchor, " ")

    cues: set[str] = set()
    for fragment in re.split(r"[\s,，。;；:：、/]+", lock_without_identity):
        compact = fragment.strip()
        if len(compact) < 3:
            continue
        cues.add(compact)
        if not compact.isascii():
            cues.update(compact[index:index + 3] for index in range(len(compact) - 2))
    return any(cue in normalized_prompt for cue in cues)


def _penalty(severity: str | None) -> int:
    if severity == "error":
        return 25
    if severity == "warning":
        return 10
    return 3
