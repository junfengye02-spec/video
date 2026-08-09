from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any


PROMPT_CONTRACT_VERSION = 1


def compile_generation_unit_prompt(
    unit: Mapping[str, Any] | Any,
    ordered_shots: Sequence[Mapping[str, Any]],
    *,
    series_bible: Mapping[str, Any] | None = None,
) -> str:
    """Compile one immutable provider prompt from every ordered source beat."""

    contract = generation_unit_prompt_contract(
        unit,
        ordered_shots,
        series_bible=series_bible,
    )
    lines = [
        "GENERATION UNIT CONTRACT",
        (
            "Create one continuous video clip containing every ordered narrative beat "
            "below. Preserve their order and do not omit, duplicate, or summarize a beat."
        ),
    ]
    locks = contract["shared_locks"]
    if locks["style"]:
        lines.append(f"Shared style lock: {locks['style']}")
    if locks["characters"]:
        lines.append(
            "Shared character locks: "
            + "; ".join(
                f"{item['name']}: {item['visual_lock']}" for item in locks["characters"]
            )
        )
    if locks["scenes"]:
        lines.append("Shared scene locks: " + "; ".join(locks["scenes"]))
    if locks["assets"]:
        lines.append(
            "Shared asset locks: "
            + "; ".join(f"{item['label']} ({item['kind']})" for item in locks["assets"])
        )

    lines.append(
        "Execution requirements: show observable physical action in chronological order; "
        "keep motion, weight, contact, cloth, weather, and object interaction physically "
        "credible; preserve established screen direction and spatial relationships."
    )
    lines.append(
        "Negative constraints: do not add subjects or props; do not change identity, face, "
        "body proportions, wardrobe, prop count, scene geometry, lighting logic, or visual "
        "style; do not skip actions, create unexplained jump cuts, deform anatomy or objects, "
        "or introduce impossible motion."
    )

    lines.append("ORDERED NARRATIVE BEATS")
    for index, segment in enumerate(contract["segments"], start=1):
        lines.append(
            f"Segment {index} [segment={segment['segment_id'] or 'legacy'}, "
            f"shot={segment['shot_id']}, beat={segment['beat_id']}]:"
        )
        lines.append(str(segment["prompt"]))
        if segment["start_state"]:
            lines.append(f"Start state: {segment['start_state']}")
        lines.append(f"Action progress: {segment['action_progress']}")
        if segment["end_state"]:
            lines.append(f"End state: {segment['end_state']}")
        if segment["continuity_requirements"]:
            lines.append(
                "Continuity requirements: "
                + "; ".join(segment["continuity_requirements"])
            )
        lines.append(f"Transition semantics: {segment['transition_semantics']}")
        if segment["shot_language"]:
            lines.append(
                "Shot language: "
                + json.dumps(
                    segment["shot_language"],
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
            )
        if segment["location"]:
            lines.append(f"Location/scene: {segment['location']}")
        if segment["props"]:
            lines.append("Beat props: " + ", ".join(segment["props"]))
        if segment["must_complete_action"]:
            lines.append(
                "Action continuity: complete this beat's action before advancing."
            )
        if segment["must_preserve_emotion"]:
            lines.append(
                "Emotion continuity: preserve the emotional state into the next beat."
            )

    lines.append(
        "Continuity rule: shared identity, wardrobe, scene geometry, style, and asset "
        "appearance remain locked across the whole clip. A cut or match cut changes "
        "camera language only; it does not reset identity or narrative state."
    )
    return "\n".join(lines)


def generation_unit_prompt_contract(
    unit: Mapping[str, Any] | Any,
    ordered_shots: Sequence[Mapping[str, Any]],
    *,
    series_bible: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    raw_unit = _mapping(unit)
    source_ids = [str(value) for value in raw_unit.get("source_shot_ids") or []]
    actual_ids = [str(shot.get("id") or "") for shot in ordered_shots]
    if not source_ids or actual_ids != source_ids:
        raise ValueError("generation unit shots must match source_shot_ids in order")

    prompt_segments = raw_unit.get("prompt_segments") or []
    raw_segments = [
        dict(segment) for segment in prompt_segments if isinstance(segment, Mapping)
    ]
    segment_shot_ids = [
        str(segment.get("source_shot_id") or segment.get("shot_id") or "")
        for segment in raw_segments
    ]
    if raw_segments and _ordered_unique(segment_shot_ids) != source_ids:
        raise ValueError("generation unit prompt segments must cover every source shot")
    frozen_segment_ids = [
        str(value) for value in raw_unit.get("source_segment_ids") or []
    ]
    if frozen_segment_ids and frozen_segment_ids != [
        str(segment.get("id") or "") for segment in raw_segments
    ]:
        raise ValueError(
            "generation unit prompt segments must match source segment IDs"
        )

    bible = series_bible or {}
    characters = {
        str(item.get("id")): item
        for item in bible.get("characters", [])
        if isinstance(item, Mapping) and item.get("id")
    }
    assets = {
        str(item.get("id")): item
        for item in bible.get("assets", [])
        if isinstance(item, Mapping) and item.get("id")
    }
    character_ids = _ordered_unique(
        str(value)
        for shot in ordered_shots
        for value in shot.get("characters", []) or []
    )
    asset_ids = _ordered_unique(
        str(value)
        for shot in ordered_shots
        for value in shot.get("asset_ids", []) or []
    )
    scenes = _ordered_unique(
        str(value)
        for shot in ordered_shots
        for value in (shot.get("scene_id"), shot.get("location"))
        if value
    )

    shots_by_id = {str(shot.get("id") or ""): shot for shot in ordered_shots}
    frozen_segments = raw_segments or [
        {
            "source_shot_id": str(shot.get("id") or ""),
            "source_beat_id": str(shot.get("beat_id") or shot.get("id") or ""),
        }
        for shot in ordered_shots
    ]
    segments: list[dict[str, Any]] = []
    for index, frozen in enumerate(frozen_segments):
        shot_id = str(frozen.get("source_shot_id") or frozen.get("shot_id") or "")
        shot = shots_by_id.get(shot_id)
        if shot is None:
            raise ValueError(
                "generation unit prompt segment references an unknown shot"
            )
        transition = str(frozen.get("transition") or _transition(shot))
        prompt = str(
            frozen.get("prompt") or shot.get("prompt") or shot.get("beat") or ""
        ).strip()
        if not prompt:
            raise ValueError("generation unit prompt segment is empty")
        segments.append(
            {
                "segment_id": str(frozen.get("id") or ""),
                "sequence": frozen.get("sequence", index + 1),
                "segment_index": frozen.get("segment_index", 1),
                "segment_count": frozen.get("segment_count", 1),
                "shot_id": shot_id,
                "beat_id": str(
                    frozen.get("source_beat_id")
                    or frozen.get("beat_id")
                    or shot.get("beat_id")
                    or shot_id
                ),
                "prompt": prompt,
                "recommended_duration_seconds": frozen.get(
                    "recommended_content_duration_seconds",
                    frozen.get(
                        "recommended_duration_seconds",
                        shot.get("recommended_duration_seconds"),
                    ),
                ),
                "transition": transition,
                "transition_semantics": _transition_semantics(transition, index),
                "continuity_requirements": list(
                    frozen.get("continuity_requirements") or []
                ),
                "start_state": str(frozen.get("start_state") or ""),
                "action_progress": str(frozen.get("action_progress") or prompt),
                "end_state": str(frozen.get("end_state") or ""),
                "shot_language": (
                    dict(shot.get("shot_language") or {})
                    if isinstance(shot.get("shot_language"), Mapping)
                    else {}
                ),
                "location": str(shot.get("location") or shot.get("scene_id") or ""),
                "props": [str(value) for value in shot.get("props", []) or []],
                "must_complete_action": bool(shot.get("must_complete_action")),
                "must_preserve_emotion": bool(shot.get("must_preserve_emotion")),
            }
        )

    return {
        "version": PROMPT_CONTRACT_VERSION,
        "generation_unit_id": str(raw_unit.get("id") or ""),
        "revision": int(raw_unit.get("revision") or 1),
        "source_shot_ids": source_ids,
        "source_beat_ids": _ordered_unique(segment["beat_id"] for segment in segments),
        "source_segment_ids": frozen_segment_ids,
        "shared_locks": {
            "style": str(bible.get("style_lock") or ""),
            "characters": [
                {
                    "id": character_id,
                    "name": str(
                        characters.get(character_id, {}).get("name") or character_id
                    ),
                    "visual_lock": str(
                        characters.get(character_id, {}).get("visual_lock")
                        or "preserve established identity and appearance"
                    ),
                }
                for character_id in character_ids
            ],
            "scenes": scenes,
            "assets": [
                {
                    "id": asset_id,
                    "label": str(assets.get(asset_id, {}).get("label") or asset_id),
                    "kind": str(assets.get(asset_id, {}).get("kind") or "asset"),
                    "reference_images": [
                        str(value)
                        for value in assets.get(asset_id, {}).get(
                            "reference_images", []
                        )
                    ],
                }
                for asset_id in asset_ids
            ],
        },
        "segments": segments,
    }


def _mapping(value: Mapping[str, Any] | Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    if hasattr(value, "model_dump"):
        dumped = value.model_dump(mode="json")
        if isinstance(dumped, Mapping):
            return dumped
    raise TypeError("generation unit must be a mapping or Pydantic model")


def _ordered_unique(values: Any) -> list[str]:
    result: list[str] = []
    for value in values:
        if value and value not in result:
            result.append(value)
    return result


def _transition(shot: Mapping[str, Any]) -> str:
    continuity = shot.get("continuity")
    mode = continuity.get("mode") if isinstance(continuity, Mapping) else None
    return (
        "continuous"
        if mode == "carry"
        else "match_cut"
        if mode == "match_cut"
        else "cut"
    )


def _transition_semantics(transition: str, index: int) -> str:
    if index == 0:
        return "Open the clip in this beat's established state."
    if transition == "continuous":
        return "Continue the same action and emotional state without a camera cut."
    if transition == "match_cut":
        return (
            "Use a motivated match cut while preserving identity, action, and emotion."
        )
    return (
        "Use an explicit camera cut while preserving narrative and identity continuity."
    )
