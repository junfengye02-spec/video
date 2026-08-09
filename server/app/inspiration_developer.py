from __future__ import annotations

import math
from typing import Any

from server.app.billing.execution import (
    StagedProviderResult,
    execute_billed_provider_call,
    finalize_billed_sync_result,
    retry_payment_required_quote,
)
from server.app.model_output_normalization import parse_model_json
from server.app.models import CreativeBrief, InspirationMessage
from server.app.provider.newapi import PreparedNewApiRequest


SYSTEM_PROMPT = """You are the creative producer inside OpenMontage.
Develop the user's rough video idea through a concise conversation before any storyboard is made.
Preserve the user's intent. Ask no more than two high-impact questions in one reply, and do not
repeat questions already answered. When there is enough information to plan a coherent video,
set ready_to_confirm to true and summarize the proposed video clearly. Match the user's language.

Return exactly one JSON object with:
- reply: the conversational response to show the user
- ready_to_confirm: boolean
- brief: an object containing title, logline, audience, format, duration_seconds, aspect_ratio,
  genre, tone, visual_style, story_outline, must_have, open_questions, and narrative_beats

Use an empty string or null for unknown scalar fields and arrays for must_have/open_questions.
When ready_to_confirm is true, narrative_beats must be an ordered array that covers the complete
story without omissions. Each beat must contain id, index, summary, recommended_duration_seconds,
duration_range_seconds as [minimum, maximum], can_merge_with_next, must_complete_action,
must_preserve_emotion, and cannot_split_reason. Beat durations are narrative pacing guidance only;
derive them from the target duration and content complexity, and do not include video-provider
request parameters in the brief. Each narrative beat is exactly one storyboard shot, so keep every
beat between 4 and 10 seconds. Never put a 10+ second action or emotional arc into one beat; split
it into multiple ordered beats with distinct progress, handoff, or reaction states. Set
must_complete_action or must_preserve_emotion only when the user explicitly requires that action
or emotion to remain continuous. Set cannot_split_reason only when one of those explicit hard
constraints is true; otherwise cannot_split_reason must be null. Narrative importance by itself
does not make a beat indivisible.
Each summary must be concrete enough for the later storyboard planner to expand without inventing
plot facts. In 1-3 sentences, state the visible opening condition, named subject and location, the
ordered physical action or reaction, the visible ending condition, and the handoff to the next beat.
Include important props and spatial relationships. Avoid vague summaries such as "the tension
rises", "they continue", or "a cinematic moment" unless the visible behavior causing it is stated.
Do not add camera, lens, lighting, or provider instructions here; the storyboard planner owns those.
For mini_series, keep the brief suitable for a compact 3-8 episode arc. For long_series, keep it
suitable for a durable 12-24 episode arc with evolving relationships and inherited state. For
single_video, keep it self-contained and do not propose episode planning. The later planner will
turn the confirmed brief into a series bible, relationship map, episode outlines, and prompts.
The project type in the system context is authoritative. Make brief.format consistent with it.
For a series, duration_seconds means the target duration of one episode, while story_outline
describes the overall series arc and its cross-episode progression. For single_video,
duration_seconds and story_outline both describe the one final video.
Do not create a storyboard, shot list, character prompt, scene prompt, or prop prompt yet.
Do not return markdown fences or commentary outside the JSON object."""


MAX_NARRATIVE_BEAT_SECONDS = 10.0


def prepare_inspiration_request(
    *,
    title: str,
    project_type: str,
    messages: list[InspirationMessage],
    model: str,
) -> PreparedNewApiRequest:
    conversation = [
        {"role": message.role, "content": message.content.strip()}
        for message in messages
    ]
    constraints = {
        "mini_series": "Series constraint: compact serialized arc, 3-8 episodes.",
        "long_series": "Series constraint: durable serialized arc, 12-24 episodes.",
        "single_video": "Single-video constraint: one self-contained story, no episodes.",
    }.get(project_type.strip(), "Single-video constraint: one self-contained story, no episodes.")
    return PreparedNewApiRequest.json(
        "POST",
        "/v1/chat/completions",
        {
            "model": model,
            "temperature": 0.6,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "system",
                    "content": (
                        f"Working title: {title.strip()}\n"
                        f"Project type: {project_type.strip()}\n{constraints}"
                    ),
                },
                *conversation,
            ],
        },
    )


def develop_inspiration_billed(
    *,
    db,
    newapi,
    settings,
    media_store,
    user_id: str,
    project_id: str,
    title: str,
    project_type: str,
    messages: list[InspirationMessage],
    model: str,
    billing_job_id: str | None = None,
) -> dict[str, Any]:
    request = prepare_inspiration_request(
        title=title,
        project_type=project_type,
        messages=messages,
        model=model,
    )
    call = {
        "db": db,
        "newapi": newapi,
        "settings": settings,
        "artifact_inspector": media_store.inspect_staged_artifact,
        "user_id": user_id,
        "project_id": project_id,
        "capability": "text",
        "operation": "inspiration_chat",
        "request": request,
    }
    context = (
        execute_billed_provider_call(parent_job_id=None, **call)
        if billing_job_id is None
        else retry_payment_required_quote(job_id=billing_job_id, **call)
    )

    def persist_hidden(job_id, response):
        try:
            content = response.json()["choices"][0]["message"]["content"]
        except Exception:
            raise ValueError("inspiration developer returned an invalid result") from None
        value = normalize_inspiration_result(content)
        artifact = media_store.stage_sync_result(
            project_id=project_id,
            job_id=job_id,
            operation="inspiration_chat",
            capability="text",
            source_reference=context.execution.reference_id,
            content=response.content,
        )
        return StagedProviderResult(artifact.locator, artifact.sha256, value)

    return finalize_billed_sync_result(
        db=db,
        newapi=newapi,
        settings=settings,
        artifact_inspector=media_store.inspect_staged_artifact,
        context=context,
        persist_hidden=persist_hidden,
    ).value


def normalize_inspiration_result(content: Any) -> dict[str, Any]:
    parsed = parse_model_json(content)
    if isinstance(parsed, list):
        parsed = next((item for item in parsed if isinstance(item, dict)), {})
    if not isinstance(parsed, dict):
        raise ValueError("Inspiration developer returned a non-object JSON value")

    reply = str(parsed.get("reply") or "").strip()
    if not reply:
        raise ValueError("Inspiration developer returned an empty reply")
    ready_to_confirm = _normalize_ready_to_confirm(parsed.get("ready_to_confirm"))
    raw_brief = parsed.get("brief") if isinstance(parsed.get("brief"), dict) else {}
    brief = CreativeBrief.model_validate(
        _clean_brief(raw_brief, ready_to_confirm=ready_to_confirm)
    ).model_dump()
    return {
        "reply": reply,
        "ready_to_confirm": ready_to_confirm,
        "brief": brief,
    }


def _normalize_ready_to_confirm(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "1"}
    if isinstance(value, (int, float)):
        return value == 1
    return False


def _clean_brief(
    value: dict[str, Any], *, ready_to_confirm: bool = False
) -> dict[str, Any]:
    cleaned = {
        key: value.get(key)
        for key in (
            "title",
            "logline",
            "audience",
            "format",
            "duration_seconds",
            "aspect_ratio",
            "genre",
            "tone",
            "visual_style",
            "story_outline",
            "must_have",
            "open_questions",
            "narrative_beats",
        )
        if key in value
    }
    for key in (
        "title",
        "logline",
        "audience",
        "format",
        "aspect_ratio",
        "genre",
        "tone",
        "visual_style",
        "story_outline",
    ):
        if key in cleaned:
            cleaned[key] = str(cleaned[key] or "").strip()
    for key in ("must_have", "open_questions"):
        raw_items = cleaned.get(key)
        if isinstance(raw_items, list):
            cleaned[key] = [str(item).strip() for item in raw_items if str(item).strip()]
        elif isinstance(raw_items, str) and raw_items.strip():
            cleaned[key] = [raw_items.strip()]
        else:
            cleaned[key] = []
    duration = cleaned.get("duration_seconds")
    if duration not in (None, ""):
        try:
            cleaned["duration_seconds"] = int(duration)
        except (TypeError, ValueError):
            cleaned["duration_seconds"] = None
    cleaned["narrative_beats"] = _clean_narrative_beats(
        cleaned.get("narrative_beats"),
        target_duration_seconds=cleaned.get("duration_seconds"),
        ready_to_confirm=ready_to_confirm,
    )
    return cleaned


def _clean_narrative_beats(
    value: Any,
    *,
    target_duration_seconds: Any,
    ready_to_confirm: bool,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    raw_beats = [beat for beat in value if isinstance(beat, dict)]
    if not raw_beats:
        return []
    try:
        target = float(target_duration_seconds)
    except (TypeError, ValueError):
        target = 0
    derived_duration = target / len(raw_beats) if target > 0 else 5.0
    used_ids: set[str] = set()
    result: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_beats, start=1):
        beat_id = str(raw.get("id") or f"beat-{index}").strip() or f"beat-{index}"
        if beat_id in used_ids:
            beat_id = f"beat-{index}"
        used_ids.add(beat_id)
        summary = str(
            raw.get("summary") or raw.get("beat") or raw.get("title") or f"Beat {index}"
        ).strip()
        recommended = _positive_float(raw.get("recommended_duration_seconds"))
        if recommended is None:
            recommended = derived_duration
        duration_range = raw.get("duration_range_seconds")
        minimum = maximum = None
        if isinstance(duration_range, (list, tuple)) and len(duration_range) == 2:
            minimum = _positive_float(duration_range[0])
            maximum = _positive_float(duration_range[1])
        if minimum is None or maximum is None or minimum > maximum:
            minimum = recommended * 0.8
            maximum = recommended * 1.2
        minimum = min(minimum, recommended)
        maximum = max(maximum, recommended)
        must_complete_action = _bool_value(
            raw.get("must_complete_action"), default=False
        )
        must_preserve_emotion = _bool_value(
            raw.get("must_preserve_emotion"), default=False
        )
        cannot_split_reason = str(raw.get("cannot_split_reason") or "").strip()
        if not (must_complete_action or must_preserve_emotion):
            cannot_split_reason = ""
        chunk_count = max(
            1,
            math.ceil(recommended / MAX_NARRATIVE_BEAT_SECONDS),
        )
        if chunk_count == 1:
            result.append(
                {
                    "id": beat_id,
                    "index": len(result) + 1,
                    "summary": summary,
                    "recommended_duration_seconds": round(recommended, 3),
                    "duration_range_seconds": (
                        round(minimum, 3),
                        round(maximum, 3),
                    ),
                    "can_merge_with_next": _bool_value(
                        raw.get("can_merge_with_next"), default=index < len(raw_beats)
                    ),
                    "must_complete_action": must_complete_action,
                    "must_preserve_emotion": must_preserve_emotion,
                    "cannot_split_reason": cannot_split_reason or None,
                }
            )
            continue

        chunk_duration = recommended / chunk_count
        for chunk_index in range(1, chunk_count + 1):
            chunk_id = f"{beat_id}-{chunk_index}"
            while chunk_id in used_ids:
                chunk_id = f"{chunk_id}-part"
            used_ids.add(chunk_id)
            is_last = chunk_index == chunk_count
            result.append(
                {
                    "id": chunk_id,
                    "index": len(result) + 1,
                    "summary": f"{summary} (part {chunk_index}/{chunk_count})",
                    "recommended_duration_seconds": round(chunk_duration, 3),
                    "duration_range_seconds": (
                        round(chunk_duration * 0.8, 3),
                        round(chunk_duration * 1.2, 3),
                    ),
                    "can_merge_with_next": (
                        True
                        if not is_last
                        else _bool_value(
                            raw.get("can_merge_with_next"),
                            default=index < len(raw_beats),
                        )
                    ),
                    "must_complete_action": must_complete_action if is_last else False,
                    "must_preserve_emotion": must_preserve_emotion if is_last else False,
                    "cannot_split_reason": cannot_split_reason if is_last else None,
                }
            )
    for index, beat in enumerate(result, start=1):
        beat["index"] = index
    return result if ready_to_confirm or result else []


def _positive_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _bool_value(value: Any, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "yes", "1"}:
            return True
        if normalized in {"false", "no", "0"}:
            return False
    if isinstance(value, (int, float)):
        return value == 1
    return default
