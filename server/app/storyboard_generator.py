from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import requests

from server.app.billing.execution import (
    StagedProviderResult,
    execute_billed_provider_call,
    finalize_billed_sync_result,
    retry_payment_required_quote,
)
from server.app.billing.models import GenerationJob
from server.app.model_output_normalization import complete_shot_language, parse_model_json
from server.app.models import (
    EpisodeOutlineItem,
    NarrativeBeat,
    ProjectType,
    Shot,
    ShotContinuity,
)
from server.app.provider.newapi import PreparedNewApiRequest


PLANNING_MAX_COMPLETION_TOKENS = 12000


@dataclass(frozen=True, slots=True)
class StoryboardGenerationResult:
    job_id: str
    value: dict[str, Any]


SYSTEM_PROMPT = """Create a production-ready short-drama plan as JSON only.
Return one JSON object with series_bible, continuity_plan, and storyboard. The series_bible must include title, mode,
project_brief, worldview, main_arc, style_lock, visual_rules, characters, and assets.
It must also include series_prompt, a reusable series-level generation prompt, and relationship_map,
an array of concise character relationship facts.
continuity_plan must include episodes for mini_series and long_series. Each episode must include
episode_number, title, goal, conflict, twist, cliffhanger, inherited_state, prompt, and outline.
The series_bible must also include sound_plan with narration, dialogue, ambience,
music_direction, prompt, and storyboard_prompt_integration.
Every character must include id, name, role, visual_lock, voice, reference_images, and locked.
visual_lock is the reusable character image-generation prompt and must specify identity, age,
appearance, hairstyle, wardrobe, accessories, proportions, palette, and consistency constraints.
Assets must cover every character, recurring scene, and prop used by the storyboard. Every asset must include
id, kind (character, scene, or prop), label, description, prompt, reference_images, shot_ids, and version.
Scene prompts must lock architecture, layout, entrances, fixed objects, time, weather, lighting,
and palette. Prop prompts must lock shape, scale, material, wear, markings, and colors.
Every shot must include id, scene_id, index, beat, prompt, characters, location, props,
shot_intent, shot_language, continuity, beat_id, recommended_duration_seconds,
duration_range_seconds, can_merge_with_next, must_complete_action,
must_preserve_emotion, and cannot_split_reason. continuity must include mode and
inherit_previous_tail. Use mode=cut and inherit_previous_tail=false for the first shot or a
deliberate time/location cut. Use mode=carry and inherit_previous_tail=true for adjacent shots
that continue the same action; use match_cut only for an intentional visual match transition.
For mini_series and long_series, every storyboard shot must
also include episode_number. The initial storyboard is for episode 1; later episode outlines
remain in continuity_plan until they are developed into their own storyboards.
Treat beat and prompt as different fields. beat is a compact narrative summary for humans. prompt
is a detailed, executable video-generation instruction and must not merely repeat or paraphrase
beat. Write each prompt as 6-10 concrete clauses in the user's language, with enough detail to
generate the shot without guessing. Every prompt must explicitly cover:
- the subject identity, locked appearance, wardrobe, current pose, gaze, and emotional state;
- the scene, time of day, weather, spatial layout, background activity, and material details;
- the visible action in chronological order, including the physical start state and final state;
- shot size, camera height and angle, lens or focal character, camera movement, focus behavior,
  and composition or subject placement;
- lighting direction and quality, color palette, texture, atmosphere, and motion realism;
- relevant props and their exact positions or interactions with the subject;
- continuity from the previous shot and the visual handoff to the next shot when applicable;
- negative constraints: preserve identity, wardrobe, prop count, scene geometry, screen direction,
  and style; do not add people or objects, skip required actions, introduce unexplained cuts,
  distort anatomy, drift style, or create impossible motion.
Use observable visual and physical language instead of abstract literary adjectives. Keep actions
feasible within recommended_duration_seconds. Align every prompt with the character, scene, prop,
worldview, and visual-style locks.
shot_language must use these fields when relevant:
shot_size, camera_movement, lens_mm, lighting_key, depth_of_field, color_temperature.
Allowed shot_size values: extreme_wide, wide, medium_wide, medium, medium_close, close_up,
extreme_close_up, over_shoulder, insert, establishing.
Allowed camera_movement values: static, pan_left, pan_right, tilt_up, tilt_down, dolly_in,
dolly_out, tracking_left, tracking_right, crane_up, crane_down, handheld, steadicam, whip_pan,
orbital, zoom_in, zoom_out, rack_focus.
Allowed lens_mm values: 14, 24, 35, 50, 85, 135, 200.
Allowed lighting_key values: high_key, low_key, natural, golden_hour, blue_hour, tungsten_warm,
neon, silhouette, rim_lit, volumetric, overcast_soft.
Allowed depth_of_field values: shallow, medium, deep.
Allowed color_temperature values: cool, neutral, warm, mixed.
Keep non-prompt planning fields compact so the response can be generated reliably: prefer short
factual strings for metadata, limit episode outlines to the essential goal/conflict/turn/cliffhanger
beats, and avoid repeating the same world facts across metadata fields. Do not shorten shot prompts;
their execution detail is the production contract.
Do not return history fields, markdown fences, arrays as series_bible, language names,
or extra commentary. If unsure, omit an optional shot_language field instead of inventing one.
Return no markdown fences and no commentary."""


def prepare_storyboard_request(
    *,
    title: str,
    prompt: str,
    model: str,
    shot_count: int | None = None,
    project_type: ProjectType | str = "single_video",
    narrative_beats: Sequence[Mapping[str, Any] | NarrativeBeat] | None = None,
) -> PreparedNewApiRequest:
    project_instruction = _project_type_instruction(project_type)
    beat_instruction = _narrative_beat_instruction(narrative_beats)
    return PreparedNewApiRequest.json(
        "POST",
        "/v1/chat/completions",
        {
            "model": model,
            "temperature": 0.4,
            "reasoning_effort": "low",
            "max_completion_tokens": PLANNING_MAX_COMPLETION_TOKENS,
            "stream": True,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        f"Title: {title.strip()}\nBrief: {prompt.strip()}\n"
                        f"{project_instruction}\n"
                        f"{beat_instruction}\n"
                        f"{_billing_shot_count_instruction(shot_count)}"
                    ),
                },
            ],
        },
    )


def generate_short_drama_storyboard_billed(
    *,
    db,
    newapi,
    settings,
    media_store,
    user_id: str,
    project_id: str,
    title: str,
    prompt: str,
    model: str,
    shot_count: int | None = None,
    project_type: ProjectType | str = "single_video",
    narrative_beats: Sequence[Mapping[str, Any] | NarrativeBeat] | None = None,
    billing_job_id: str | None = None,
) -> dict[str, Any]:
    return generate_short_drama_storyboard_billed_result(
        db=db,
        newapi=newapi,
        settings=settings,
        media_store=media_store,
        user_id=user_id,
        project_id=project_id,
        title=title,
        prompt=prompt,
        model=model,
        shot_count=shot_count,
        project_type=project_type,
        narrative_beats=narrative_beats,
        billing_job_id=billing_job_id,
    ).value


def generate_short_drama_storyboard_billed_result(
    *,
    db,
    newapi,
    settings,
    media_store,
    user_id: str,
    project_id: str,
    title: str,
    prompt: str,
    model: str,
    shot_count: int | None = None,
    project_type: ProjectType | str = "single_video",
    narrative_beats: Sequence[Mapping[str, Any] | NarrativeBeat] | None = None,
    billing_job_id: str | None = None,
    settlement_key: str | None = None,
) -> StoryboardGenerationResult:
    request = prepare_storyboard_request(
        title=title,
        prompt=prompt,
        model=model,
        shot_count=shot_count,
        project_type=project_type,
        narrative_beats=narrative_beats,
    )
    call = {
        "db": db,
        "newapi": newapi,
        "settings": settings,
        "artifact_inspector": media_store.inspect_staged_artifact,
        "user_id": user_id,
        "project_id": project_id,
        "capability": "text",
        "operation": "storyboard_generation",
        "request": request,
    }
    stable_job_id = billing_job_id or settlement_key
    existing = db.get(GenerationJob, stable_job_id) if stable_job_id else None
    if existing is not None:
        if (
            existing.user_id != user_id
            or existing.project_id != project_id
            or not existing.chargeable
            or existing.capability != "text"
            or existing.operation != "storyboard_generation"
        ):
            raise ValueError("Storyboard billing job does not match the task")
        if existing.status == "billed" and existing.result_visible:
            if not existing.result_locator:
                raise ValueError("Storyboard billing result is missing")
            return StoryboardGenerationResult(
                job_id=existing.id,
                value=_parse_billed_storyboard_response(
                    media_store.read_staged_sync_result(existing.result_locator),
                    title=title,
                    project_type=project_type,
                    narrative_beats=narrative_beats,
                ),
            )
        if existing.status != "payment_required_quote":
            from server.app.billing.execution import ProviderResultPending

            raise ProviderResultPending(
                "storyboard billing result is not ready", existing.id
            )
        context = retry_payment_required_quote(job_id=existing.id, **call)
    elif billing_job_id is None:
        context = execute_billed_provider_call(
            parent_job_id=None,
            job_id=settlement_key,
            **call,
        )
    else:
        context = retry_payment_required_quote(job_id=billing_job_id, **call)

    def persist_hidden(job_id, response):
        value = _parse_billed_storyboard_response(
            response.content,
            title=title,
            project_type=project_type,
            narrative_beats=narrative_beats,
        )
        artifact = media_store.stage_sync_result(
            project_id=project_id,
            job_id=job_id,
            operation="storyboard_generation",
            capability="text",
            source_reference=context.execution.reference_id,
            content=response.content,
        )
        return StagedProviderResult(artifact.locator, artifact.sha256, value)

    staged = finalize_billed_sync_result(
        db=db,
        newapi=newapi,
        settings=settings,
        artifact_inspector=media_store.inspect_staged_artifact,
        context=context,
        persist_hidden=persist_hidden,
    )
    return StoryboardGenerationResult(job_id=context.job_id, value=staged.value)


def _parse_billed_storyboard_response(
    response_content: bytes,
    *,
    title: str,
    project_type: ProjectType | str,
    narrative_beats: Sequence[Mapping[str, Any] | NarrativeBeat] | None,
) -> dict[str, Any]:
    try:
        envelope = json.loads(response_content)
        content = envelope["choices"][0]["message"]["content"]
    except Exception:
        raise ValueError("storyboard generator returned an invalid result") from None
    value = _parse_json_object(str(content))
    _normalize_storyboard(
        value,
        title,
        project_type,
        narrative_beats=narrative_beats,
    )
    return value


def generate_short_drama_storyboard(
    *,
    title: str,
    prompt: str,
    model: str,
    base_url: str,
    api_key: str,
    shot_count: int | None = None,
    project_type: ProjectType | str = "single_video",
    narrative_beats: Sequence[Mapping[str, Any] | NarrativeBeat] | None = None,
) -> dict[str, Any]:
    shot_count_instruction = _shot_count_instruction(shot_count)
    project_instruction = _project_type_instruction(project_type)
    beat_instruction = _narrative_beat_instruction(narrative_beats)
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
                    "content": (
                        f"Title: {title.strip()}\nBrief: {prompt.strip()}\n"
                        f"{project_instruction}\n{beat_instruction}\n"
                        f"{shot_count_instruction}"
                    ),
                },
            ],
        },
        timeout=600,
    )
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"]
    data = _parse_json_object(str(content))
    _normalize_storyboard(
        data,
        title,
        project_type,
        narrative_beats=narrative_beats,
    )
    return data


def _parse_json_object(content: str) -> dict[str, Any]:
    parsed = parse_model_json(content)
    if isinstance(parsed, list):
        return {"series_bible": {}, "storyboard": {"shots": parsed}}
    if not isinstance(parsed, dict):
        raise ValueError("Storyboard generator returned a non-object JSON value")
    return parsed


def _normalize_storyboard(
    data: dict[str, Any],
    title: str,
    project_type: ProjectType | str = "single_video",
    *,
    narrative_beats: Sequence[Mapping[str, Any] | NarrativeBeat] | None = None,
) -> None:
    confirmed_beats = _normalize_narrative_beats(narrative_beats)
    if isinstance(data.get("series_bible"), list):
        data["series_bible"] = next(
            (item for item in data["series_bible"] if isinstance(item, dict)),
            {},
        )
    if not isinstance(data.get("series_bible"), dict):
        data["series_bible"] = {}
    series_bible = data.setdefault("series_bible", {})
    series_bible.setdefault("title", title)
    series_bible.setdefault("mode", "short_drama")
    series_bible.setdefault("project_brief", "")
    series_bible.setdefault("worldview", "")
    series_bible.setdefault("main_arc", "")
    series_bible.setdefault("style_lock", "")
    series_bible.setdefault("visual_rules", "")
    series_bible["series_prompt"] = str(series_bible.get("series_prompt") or "").strip()
    series_bible["relationship_map"] = _normalize_string_list(
        series_bible.get("relationship_map")
    )
    if str(project_type or "single_video") == "single_video":
        series_bible["series_prompt"] = ""
    series_bible["sound_plan"] = _normalize_sound_plan(series_bible.get("sound_plan"))
    series_bible.setdefault("characters", [])
    if not isinstance(series_bible.get("characters"), list):
        series_bible["characters"] = []
    if not isinstance(series_bible.get("assets"), list):
        series_bible["assets"] = []
    if isinstance(data.get("storyboard"), list):
        data["storyboard"] = {"shots": data["storyboard"]}
    if not isinstance(data.get("storyboard"), dict):
        data["storyboard"] = {}
    storyboard = data.setdefault("storyboard", {})
    if not isinstance(storyboard.get("shots"), list):
        storyboard["shots"] = []
    shots = storyboard.setdefault("shots", [])
    if confirmed_beats and len(shots) != len(confirmed_beats):
        raise ValueError(
            "Storyboard generator must return exactly one shot per confirmed narrative beat"
        )
    data["continuity_plan"] = _normalize_continuity_plan(
        data.get("continuity_plan"),
        series_bible,
        project_type,
    )
    default_episode_number = (
        1 if str(project_type or "single_video") != "single_video" else None
    )
    for index, shot in enumerate(shots, start=1):
        if not isinstance(shot, dict):
            raise ValueError("Storyboard generator returned a non-object shot")
        shot.setdefault("id", f"s{index}")
        shot.setdefault("scene_id", f"scene-{index}")
        shot.setdefault("index", index)
        if default_episode_number is not None:
            episode_number = _safe_int(
                shot.get("episode_number"), default_episode_number
            )
            shot["episode_number"] = max(1, episode_number)
        else:
            shot["episode_number"] = None
        shot.setdefault("beat", f"Shot {index}")
        confirmed_beat = confirmed_beats[index - 1] if confirmed_beats else None
        if confirmed_beat is not None:
            supplied_beat_id = str(shot.get("beat_id") or "").strip()
            if supplied_beat_id and supplied_beat_id != confirmed_beat.id:
                raise ValueError("Storyboard shot order does not match confirmed narrative beats")
            shot["beat_id"] = confirmed_beat.id
            shot["recommended_duration_seconds"] = (
                confirmed_beat.recommended_duration_seconds
            )
            shot["duration_range_seconds"] = list(
                confirmed_beat.duration_range_seconds
            )
            shot["can_merge_with_next"] = confirmed_beat.can_merge_with_next
            shot["must_complete_action"] = confirmed_beat.must_complete_action
            shot["must_preserve_emotion"] = confirmed_beat.must_preserve_emotion
            shot["cannot_split_reason"] = confirmed_beat.cannot_split_reason
        else:
            shot["beat_id"] = str(shot.get("beat_id") or "").strip() or None
            shot["recommended_duration_seconds"] = _positive_float(
                shot.get("recommended_duration_seconds")
            )
            shot["duration_range_seconds"] = _normalize_duration_range(
                shot.get("duration_range_seconds"),
                shot["recommended_duration_seconds"],
            )
            shot["can_merge_with_next"] = bool(
                shot.get("can_merge_with_next") is True
            )
            shot["must_complete_action"] = bool(
                shot.get("must_complete_action") is True
            )
            shot["must_preserve_emotion"] = bool(
                shot.get("must_preserve_emotion") is True
            )
            cannot_split_reason = str(shot.get("cannot_split_reason") or "").strip()
            shot["cannot_split_reason"] = cannot_split_reason or None
        shot.setdefault("location", None)
        shot.setdefault("shot_intent", None)
        shot["prompt"] = _normalize_shot_prompt(shot)
        shot["characters"] = _normalize_string_list(shot.get("characters"))
        shot["props"] = _normalize_string_list(shot.get("props"))
        shot.setdefault("status", "ready")
        shot.setdefault("consistency_score", 100)
        shot.setdefault("output_url", None)
        shot.setdefault("output_path", None)
        shot["asset_ids"] = _normalize_string_list(shot.get("asset_ids"))
        shot["shot_language"] = complete_shot_language(
            shot.get("shot_language"),
            shot.get("beat"),
            shot.get("prompt"),
            shot.get("shot_intent"),
            shot.get("location"),
        )
        previous_shot = shots[index - 2] if index > 1 else None
        same_episode_as_previous = bool(
            isinstance(previous_shot, dict)
            and previous_shot.get("episode_number") == shot.get("episode_number")
        )
        shot["continuity"] = _normalize_shot_continuity(
            shot.get("continuity"),
            has_previous_same_episode=same_episode_as_previous,
        )
        shot.setdefault("version", 1)
        shot["history"] = [_history_entry(shot)]
        Shot(**shot)
    _ensure_series_characters(series_bible, shots)
    _normalize_series_characters(series_bible)
    _normalize_series_assets(series_bible)
    _ensure_series_assets(series_bible, shots)
    _link_shots_to_series_assets(series_bible, shots)


def _project_type_instruction(project_type: ProjectType | str) -> str:
    normalized = str(project_type or "single_video").strip()
    if normalized == "mini_series":
        return (
            "Project type: mini_series. Produce a tightly serialized short series with exactly "
            "3-8 episodes (episode outlines). Keep each episode compact, with a clear inherited "
            "state and cliffhanger. Prefer 3 episodes unless the brief explicitly requires more."
        )
    if normalized == "long_series":
        return (
            "Project type: long_series. Produce a durable long series with exactly 12-24 episodes "
            "(episode outlines). "
            "Track evolving relationships, inherited state, and a season-level arc across episodes. "
            "Prefer 12 episodes unless the brief explicitly requires more."
        )
    return (
        "Project type: single_video. Do not create episodes or series-only planning; keep one self-contained "
        "storyboard."
    )


def _normalize_continuity_plan(
    value: Any,
    series_bible: dict[str, Any],
    project_type: ProjectType | str,
) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    episodes_value = source.get("episodes")
    if not isinstance(episodes_value, list):
        episodes_value = series_bible.pop("episodes", None)
    if not isinstance(episodes_value, list):
        episodes_value = []

    normalized: list[dict[str, Any]] = []
    seen: set[int] = set()
    for index, raw in enumerate(episodes_value, start=1):
        if not isinstance(raw, dict):
            continue
        number = _safe_int(raw.get("episode_number"), index)
        if number < 1 or number in seen:
            number = index
        seen.add(number)
        item = EpisodeOutlineItem(
            episode_number=number,
            title=str(raw.get("title") or "").strip(),
            goal=str(raw.get("goal") or "").strip(),
            conflict=str(raw.get("conflict") or "").strip(),
            twist=str(raw.get("twist") or "").strip(),
            cliffhanger=str(raw.get("cliffhanger") or "").strip(),
            inherited_state=_normalize_string_list(raw.get("inherited_state")),
            prompt=str(raw.get("prompt") or "").strip(),
            outline=str(raw.get("outline") or "").strip(),
            locked=bool(raw.get("locked", False)),
        ).model_dump()
        normalized.append(item)

    minimum, maximum = _episode_bounds(project_type)
    if minimum:
        series_prompt = str(series_bible.get("series_prompt") or "").strip()
        main_arc = str(series_bible.get("main_arc") or "").strip()
        used_numbers = {item["episode_number"] for item in normalized}
        while len(normalized) < minimum:
            number = next(
                candidate
                for candidate in range(1, maximum + 1)
                if candidate not in used_numbers
            )
            used_numbers.add(number)
            normalized.append(
                EpisodeOutlineItem(
                    episode_number=number,
                    title=f"Episode {number}",
                    goal=main_arc or "Advance the series arc.",
                    conflict="Escalate the central conflict.",
                    cliffhanger="Leave a question that carries into the next episode.",
                    prompt=(
                        f"{series_prompt} Episode {number}: advance the arc while preserving continuity."
                    ).strip(),
                    outline="Goal, conflict, turning point, and cliffhanger for this episode.",
                ).model_dump()
            )
        normalized = sorted(
            normalized,
            key=lambda item: item["episode_number"],
        )[:maximum]
    return {
        **{key: value for key, value in source.items() if key != "episodes"},
        "project_type": str(project_type or "single_video"),
        "episodes": normalized if minimum else [],
    }


def _episode_bounds(project_type: ProjectType | str) -> tuple[int, int]:
    normalized = str(project_type or "single_video").strip()
    return {
        "mini_series": (3, 8),
        "long_series": (12, 24),
    }.get(normalized, (0, 0))


def _normalize_sound_plan(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    return {
        "narration": str(source.get("narration") or "").strip(),
        "dialogue": str(source.get("dialogue") or "").strip(),
        "ambience": str(source.get("ambience") or "").strip(),
        "music_direction": str(source.get("music_direction") or "").strip(),
        "prompt": str(source.get("prompt") or "").strip(),
        "storyboard_prompt_integration": bool(
            source.get("storyboard_prompt_integration", False)
        ),
    }


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
        "continuity": shot.get("continuity"),
        "beat_id": shot.get("beat_id"),
        "recommended_duration_seconds": shot.get(
            "recommended_duration_seconds"
        ),
        "duration_range_seconds": shot.get("duration_range_seconds"),
        "can_merge_with_next": shot.get("can_merge_with_next", False),
        "must_complete_action": shot.get("must_complete_action", False),
        "must_preserve_emotion": shot.get("must_preserve_emotion", False),
        "cannot_split_reason": shot.get("cannot_split_reason"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def _normalize_shot_continuity(
    value: Any,
    *,
    has_previous_same_episode: bool,
) -> dict[str, Any]:
    source = dict(value) if isinstance(value, dict) else {}
    default_mode = "carry" if has_previous_same_episode else "cut"
    mode = source.get("mode")
    if mode not in {"carry", "cut", "match_cut"}:
        mode = default_mode
    if mode == "carry" and not has_previous_same_episode:
        mode = "cut"
    source["mode"] = mode
    source["inherit_previous_tail"] = bool(
        mode == "carry"
        and has_previous_same_episode
        and source.get("inherit_previous_tail", True)
    )
    return ShotContinuity(**source).model_dump()


def _narrative_beat_instruction(
    value: Sequence[Mapping[str, Any] | NarrativeBeat] | None,
) -> str:
    beats = _normalize_narrative_beats(value)
    if not beats:
        return "Narrative beats: none supplied; derive conservative one-shot story beats."
    payload = [beat.model_dump(mode="json") for beat in beats]
    return (
        "Confirmed narrative beats: create exactly one storyboard shot per narrative beat, "
        "in the same order, preserving every beat ID and all duration, merge, action, and "
        "emotion constraints. Every beat should remain a compact 4-to-10-second shot; if a "
        "confirmed beat is longer, preserve its supplied beat boundary and do not invent a "
        "provider request duration. These are narrative timing suggestions, not provider request "
        "durations.\n"
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )


def _normalize_narrative_beats(
    value: Sequence[Mapping[str, Any] | NarrativeBeat] | None,
) -> list[NarrativeBeat]:
    if not value:
        return []
    beats = [
        item if isinstance(item, NarrativeBeat) else NarrativeBeat.model_validate(item)
        for item in value
    ]
    ordered = sorted(beats, key=lambda beat: (beat.index, beat.id))
    if [beat.index for beat in ordered] != list(range(1, len(ordered) + 1)):
        raise ValueError("confirmed narrative beat indexes must be consecutive")
    if len({beat.id for beat in ordered}) != len(ordered):
        raise ValueError("confirmed narrative beat IDs must be unique")
    return ordered


def _normalize_duration_range(
    value: Any, recommended_duration_seconds: float | None
) -> list[float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    minimum = _positive_float(value[0])
    maximum = _positive_float(value[1])
    if minimum is None or maximum is None or minimum > maximum:
        return None
    if recommended_duration_seconds is not None:
        minimum = min(minimum, recommended_duration_seconds)
        maximum = max(maximum, recommended_duration_seconds)
    return [minimum, maximum]


def _positive_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _billing_shot_count_instruction(shot_count: int | None) -> str:
    current_helper = globals().get("_shot_count_instruction")
    if callable(current_helper):
        return current_helper(shot_count)
    if shot_count is None:
        return (
            "Shots: derive natural shot boundaries from completed actions, scene changes, "
            "dialogue, emotional progression, and camera language. Do not use a default count."
        )
    requested = min(max(int(shot_count), 1), 60)
    return f"Shots: {requested}"


def _shot_count_instruction(shot_count: int | None) -> str:
    if shot_count is None:
        return (
            "Shots: derive natural shot boundaries from completed actions, scene changes, "
            "dialogue, emotional progression, and camera language. Do not use a default count "
            "or a recommended numeric range."
        )
    requested_shot_count = min(max(int(shot_count), 1), 60)
    return f"Shots: {requested_shot_count}"


def _normalize_shot_prompt(shot: dict[str, Any]) -> str:
    prompt = str(shot.get("prompt") or "").strip()
    if prompt:
        return prompt
    parts = [str(shot.get("beat") or "").strip()]
    location = str(shot.get("location") or "").strip()
    if location:
        parts.append(f"Location: {location}.")
    intent = str(shot.get("shot_intent") or "").strip()
    if intent:
        parts.append(f"Intent: {intent}")
    return " ".join(part for part in parts if part).strip() or "Create a cinematic short-drama shot for this beat."


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


def _normalize_series_characters(series_bible: dict[str, Any]) -> None:
    normalized: list[dict[str, Any]] = []
    for index, character in enumerate(series_bible.get("characters", []), start=1):
        if not isinstance(character, dict):
            continue
        name = str(character.get("name") or character.get("id") or f"Character {index}").strip()
        character_id = str(character.get("id") or _slug(name) or f"character-{index}").strip()
        role = str(character.get("role") or "unspecified").strip()
        visual_lock = str(character.get("visual_lock") or "").strip()
        if not visual_lock:
            visual_lock = (
                f"{name}, {role}; consistent face, age, body proportions, hairstyle, wardrobe, "
                "accessories, and color palette across every shot; neutral character reference sheet"
            )
        normalized.append(
            {
                "id": character_id,
                "name": name,
                "role": role,
                "visual_lock": visual_lock,
                "voice": character.get("voice"),
                "reference_images": _normalize_string_list(character.get("reference_images")),
                "locked": bool(character.get("locked", True)),
            }
        )
    series_bible["characters"] = normalized


def _normalize_series_assets(series_bible: dict[str, Any]) -> None:
    normalized: list[dict[str, Any]] = []
    for index, asset in enumerate(series_bible.get("assets", []), start=1):
        if not isinstance(asset, dict):
            continue
        kind = str(asset.get("kind") or "scene").strip().lower()
        if kind not in {"character", "scene", "prop"}:
            kind = "scene"
        label = str(asset.get("label") or asset.get("id") or f"Asset {index}").strip()
        asset_id = str(asset.get("id") or f"{kind}-{_slug(label) or index}").strip()
        description = str(asset.get("description") or "").strip()
        prompt = str(asset.get("prompt") or description).strip()
        if not prompt:
            prompt = (
                f"Environment continuity board for {label}; lock architecture, layout, lighting, "
                "weather, fixed objects, and palette."
                if kind == "scene"
                else f"Reference turnaround for {label}; lock shape, scale, materials, markings, wear, and colors."
            )
        normalized.append(
            {
                "id": asset_id,
                "kind": kind,
                "label": label,
                "description": description,
                "prompt": prompt,
                "reference_images": _normalize_string_list(asset.get("reference_images")),
                "shot_ids": _normalize_string_list(asset.get("shot_ids")),
                "version": max(1, _safe_int(asset.get("version"), 1)),
            }
        )
    series_bible["assets"] = normalized


def _ensure_series_assets(series_bible: dict[str, Any], shots: list[dict[str, Any]]) -> None:
    assets = series_bible.setdefault("assets", [])
    known = {
        (str(asset.get("kind")), str(asset.get("label") or "").strip().casefold())
        for asset in assets
        if isinstance(asset, dict)
    }
    style = str(series_bible.get("style_lock") or "").strip()
    worldview = str(series_bible.get("worldview") or "").strip()

    for character in series_bible.get("characters", []):
        if not isinstance(character, dict):
            continue
        character_id = str(character.get("id") or "").strip()
        label = str(character.get("name") or character_id).strip()
        if not character_id or not label:
            continue
        key = ("character", label.casefold())
        if key in known:
            continue
        assets.append(
            {
                "id": f"character-{character_id}",
                "kind": "character",
                "label": label,
                "description": str(character.get("role") or "").strip(),
                "prompt": str(character.get("visual_lock") or "").strip(),
                "reference_images": _normalize_string_list(
                    character.get("reference_images")
                ),
                "shot_ids": [
                    str(shot.get("id"))
                    for shot in shots
                    if character_id in shot.get("characters", [])
                ],
                "version": 1,
            }
        )
        known.add(key)

    for location in _ordered_locations(shots):
        key = ("scene", location.casefold())
        if key in known:
            continue
        shot_ids = [str(shot.get("id")) for shot in shots if shot.get("location") == location]
        context = "; ".join(part for part in (worldview, style) if part)
        assets.append(
            {
                "id": f"scene-{_slug(location)}",
                "kind": "scene",
                "label": location,
                "description": f"Recurring story location: {location}",
                "prompt": (
                    f"Environment continuity board for {location}; lock architecture, spatial layout, "
                    f"entrances, fixed objects, time of day, weather, lighting, and color palette. {context}"
                ).strip(),
                "reference_images": [],
                "shot_ids": shot_ids,
                "version": 1,
            }
        )
        known.add(key)

    for prop in _ordered_props(shots):
        key = ("prop", prop.casefold())
        if key in known:
            continue
        shot_ids = [str(shot.get("id")) for shot in shots if prop in shot.get("props", [])]
        assets.append(
            {
                "id": f"prop-{_slug(prop)}",
                "kind": "prop",
                "label": prop,
                "description": f"Recurring story prop: {prop}",
                "prompt": (
                    f"Prop turnaround and detail reference for {prop}; lock shape, scale, materials, "
                    "surface wear, markings, moving parts, and colors across every shot."
                ),
                "reference_images": [],
                "shot_ids": shot_ids,
                "version": 1,
            }
        )
        known.add(key)


def _link_shots_to_series_assets(
    series_bible: dict[str, Any], shots: list[dict[str, Any]]
) -> None:
    asset_ids_by_shot: dict[str, list[str]] = {}
    for asset in series_bible.get("assets", []):
        if not isinstance(asset, dict):
            continue
        asset_id = str(asset.get("id") or "").strip()
        if not asset_id:
            continue
        for value in asset.get("shot_ids") or []:
            shot_id = str(value).strip()
            if shot_id:
                asset_ids_by_shot.setdefault(shot_id, []).append(asset_id)

    for shot in shots:
        shot_id = str(shot.get("id") or "").strip()
        linked = _normalize_string_list(
            [*(shot.get("asset_ids") or []), *asset_ids_by_shot.get(shot_id, [])]
        )
        shot["asset_ids"] = linked
        history = shot.get("history")
        if isinstance(history, list) and history and isinstance(history[0], dict):
            history[0]["asset_ids"] = list(linked)


def _ordered_locations(shots: list[dict[str, Any]]) -> list[str]:
    return _ordered_values(
        str(shot.get("location") or "").strip() for shot in shots
    )


def _ordered_props(shots: list[dict[str, Any]]) -> list[str]:
    return _ordered_values(
        str(prop).strip()
        for shot in shots
        for prop in shot.get("props", [])
    )


def _ordered_values(values) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for value in values:
        key = value.casefold()
        if value and key not in seen:
            seen.add(key)
            ordered.append(value)
    return ordered


def _slug(value: str) -> str:
    cleaned = "".join(
        character.lower() if character.isascii() and character.isalnum() else "-"
        for character in value
    )
    readable = "-".join(part for part in cleaned.split("-") if part)
    if readable:
        return readable
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:12]


def _safe_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


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
