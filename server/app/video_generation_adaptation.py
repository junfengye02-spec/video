from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from server.app.model_output_normalization import parse_model_json
from server.app.provider.newapi import PreparedNewApiRequest


ADAPTATION_TASK_TYPE = "video_generation_adaptation"
ADAPTATION_CACHE_CONTRACT_VERSION = 2


class VideoGenerationAdaptationError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class VideoGenerationAdaptationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    task_type: Literal["video_generation_adaptation"] = ADAPTATION_TASK_TYPE
    storyboard_revision: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    beat_content_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    model_id: str = Field(min_length=1)
    profile_revision: str = Field(min_length=1)
    call_duration_seconds: float = Field(gt=0)
    segment_count: int = Field(ge=2)
    requested_segment_ids: list[str] = Field(min_length=2)
    source_beat_id: str = Field(min_length=1)
    source_shot_id: str = Field(min_length=1)
    confirmed_beats: list[dict[str, Any]] = Field(min_length=1)
    current_beat: dict[str, Any]
    previous_beat: dict[str, Any] | None = None
    next_beat: dict[str, Any] | None = None
    storyboard_shot: dict[str, Any]
    series_bible: dict[str, Any]
    immutable_story_facts: list[str] = Field(min_length=1)
    immutable_story_facts_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")

    @model_validator(mode="after")
    def validate_segment_ids(self) -> "VideoGenerationAdaptationRequest":
        if len(self.requested_segment_ids) != self.segment_count:
            raise ValueError("requested segment IDs must match segment_count")
        if len(set(self.requested_segment_ids)) != self.segment_count:
            raise ValueError("requested segment IDs must be unique")
        return self


class AdaptedSegment(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1)
    source_beat_id: str = Field(min_length=1)
    source_shot_id: str = Field(min_length=1)
    segment_index: int = Field(ge=1)
    segment_count: int = Field(ge=2)
    start_state: str = Field(min_length=1)
    action_progress: str = Field(min_length=1)
    end_state: str = Field(min_length=1)
    prompt: str = Field(min_length=1)
    continuity_requirements: list[str] = Field(min_length=1)
    introduced_story_facts: list[str] = Field(default_factory=list)
    immutable_story_facts_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class VideoGenerationAdaptationResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    task_type: Literal["video_generation_adaptation"] = ADAPTATION_TASK_TYPE
    immutable_story_facts_hash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    preserved_story_facts: list[str] = Field(min_length=1)
    segments: list[AdaptedSegment] = Field(min_length=2)


LoadAdaptation = Callable[[str], Mapping[str, Any] | None]
SaveAdaptation = Callable[[str, dict[str, Any]], Any]
GenerateAdaptation = Callable[
    [VideoGenerationAdaptationRequest],
    VideoGenerationAdaptationResult | Mapping[str, Any],
]


def adaptation_cache_key(
    request: VideoGenerationAdaptationRequest,
    *,
    text_model: str | None = None,
) -> str:
    payload = {
        "contract_version": ADAPTATION_CACHE_CONTRACT_VERSION,
        "request": request.model_dump(mode="json"),
    }
    if text_model:
        payload["text_model"] = text_model
    return "video-adaptation-" + _digest(payload)


def load_cached_adaptation(
    request: VideoGenerationAdaptationRequest,
    *,
    load: LoadAdaptation,
    save: SaveAdaptation,
    text_model: str | None = None,
) -> VideoGenerationAdaptationResult | None:
    """Load a validated adaptation and migrate a legacy cache when needed.

    Before the planner cache key included the selected text model, existing
    projects stored the same request under the model-free key.  A selected
    model must still be part of new cache keys, but a validated legacy result
    is safe to reuse because the adaptation contract is fully checked against
    the current request below.
    """
    key = adaptation_cache_key(request, text_model=text_model)
    cached = load(key)
    source_key = key
    if cached is None and text_model:
        legacy_key = adaptation_cache_key(request)
        if legacy_key != key:
            cached = load(legacy_key)
            source_key = legacy_key
    if cached is None:
        return None

    result = validate_adaptation_result(request, cached)
    if source_key != key:
        save(key, result.model_dump(mode="json"))
    return result


def resolve_cached_adaptation(
    request: VideoGenerationAdaptationRequest,
    *,
    load: LoadAdaptation,
    save: SaveAdaptation,
    generate: GenerateAdaptation,
    text_model: str | None = None,
) -> VideoGenerationAdaptationResult:
    key = adaptation_cache_key(request, text_model=text_model)
    cached = load_cached_adaptation(
        request,
        load=load,
        save=save,
        text_model=text_model,
    )
    if cached is not None:
        return cached
    result = validate_adaptation_result(request, generate(request))
    save(key, result.model_dump(mode="json"))
    return result


def validate_adaptation_result(
    request: VideoGenerationAdaptationRequest,
    value: VideoGenerationAdaptationResult | Mapping[str, Any],
) -> VideoGenerationAdaptationResult:
    try:
        result = (
            value
            if isinstance(value, VideoGenerationAdaptationResult)
            else VideoGenerationAdaptationResult.model_validate(value)
        )
    except ValueError as exc:
        raise VideoGenerationAdaptationError(
            "video_generation_adaptation_invalid",
            "text model output does not match the adaptation schema",
        ) from exc
    if result.immutable_story_facts_hash != request.immutable_story_facts_hash:
        raise VideoGenerationAdaptationError(
            "video_generation_adaptation_story_fact_changed",
            "immutable story facts hash changed",
        )
    if result.preserved_story_facts != request.immutable_story_facts:
        raise VideoGenerationAdaptationError(
            "video_generation_adaptation_story_fact_changed",
            "immutable story facts were deleted, reordered, or changed",
        )
    if len(result.segments) != request.segment_count:
        raise VideoGenerationAdaptationError(
            "video_generation_adaptation_invalid",
            "text model returned the wrong segment count",
        )
    if [segment.id for segment in result.segments] != request.requested_segment_ids:
        raise VideoGenerationAdaptationError(
            "video_generation_adaptation_invalid",
            "text model changed segment identifiers or order",
        )
    for expected_index, segment in enumerate(result.segments, start=1):
        if (
            segment.segment_index != expected_index
            or segment.segment_count != request.segment_count
            or segment.source_beat_id != request.source_beat_id
            or segment.source_shot_id != request.source_shot_id
            or segment.immutable_story_facts_hash != request.immutable_story_facts_hash
        ):
            raise VideoGenerationAdaptationError(
                "video_generation_adaptation_invalid",
                "text model changed source mapping, order, or coverage",
            )
        if segment.introduced_story_facts:
            raise VideoGenerationAdaptationError(
                "video_generation_adaptation_story_fact_changed",
                "text model introduced new story facts",
            )
        if expected_index > 1:
            previous = result.segments[expected_index - 2]
            if previous.end_state.strip() != segment.start_state.strip():
                raise VideoGenerationAdaptationError(
                    "video_generation_adaptation_continuity_invalid",
                    "adjacent segment states do not connect exactly",
                )
    return result


ADAPTATION_OUTPUT_JSON_SCHEMA: dict[str, Any] = {
    "name": "video_generation_adaptation",
    "strict": True,
    "schema": {
        "type": "object",
        "required": [
            "task_type",
            "immutable_story_facts_hash",
            "preserved_story_facts",
            "segments",
        ],
        "properties": {
            "task_type": {"type": "string", "const": ADAPTATION_TASK_TYPE},
            "immutable_story_facts_hash": {"type": "string"},
            "preserved_story_facts": {
                "type": "array",
                "items": {"type": "string"},
            },
            "segments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": [
                        "id",
                        "source_beat_id",
                        "source_shot_id",
                        "segment_index",
                        "segment_count",
                        "start_state",
                        "action_progress",
                        "end_state",
                        "prompt",
                        "continuity_requirements",
                        "introduced_story_facts",
                        "immutable_story_facts_hash",
                    ],
                    "properties": {
                        "id": {"type": "string"},
                        "source_beat_id": {"type": "string"},
                        "source_shot_id": {"type": "string"},
                        "segment_index": {"type": "integer"},
                        "segment_count": {"type": "integer"},
                        "start_state": {"type": "string"},
                        "action_progress": {"type": "string"},
                        "end_state": {"type": "string"},
                        "prompt": {"type": "string"},
                        "continuity_requirements": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "introduced_story_facts": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "immutable_story_facts_hash": {"type": "string"},
                    },
                    "additionalProperties": False,
                },
            },
        },
        "additionalProperties": False,
    },
}


_SYSTEM_PROMPT = """You perform video generation adaptation planning.
Split one confirmed narrative beat into exactly the requested ordered visual segments.
Return strict JSON matching the supplied schema. Preserve every immutable story fact, character,
scene, prop, dialogue, and causal relationship. Do not add, remove, or alter plot facts. Use extra
native video time only for action development, reaction, pause, camera movement, or transition.
Each segment must advance the same action, and each next start_state must exactly equal the prior
end_state. Echo all supplied IDs, hashes, and immutable_story_facts exactly in preserved_story_facts.
introduced_story_facts must be an empty array.
Each segment prompt is an executable video-model instruction, not a short beat label. It must state
the locked subject and appearance, location and spatial relationship, the exact action progression
for only that segment, camera framing/angle/lens/movement/focus, lighting/color/material cues, the
required start and end state, and continuity with adjacent segments. End with explicit negative
constraints against new subjects or props, identity/wardrobe/style drift, skipped actions, jump cuts,
anatomy distortion, object deformation, and physically impossible motion. Use concrete observable
language and preserve all facts supplied in storyboard_shot and series_bible.
Do not return markdown or commentary."""


def prepare_video_generation_adaptation_request(
    request: VideoGenerationAdaptationRequest,
    *,
    text_model: str,
) -> PreparedNewApiRequest:
    return PreparedNewApiRequest.json(
        "POST",
        "/v1/chat/completions",
        {
            "model": text_model,
            "temperature": 0.2,
            "response_format": {
                "type": "json_schema",
                "json_schema": ADAPTATION_OUTPUT_JSON_SCHEMA,
            },
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": json.dumps(
                        request.model_dump(mode="json"),
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                },
            ],
        },
    )


def generate_video_generation_adaptation_billed(
    *,
    db: Any,
    newapi: Any,
    settings: Any,
    media_store: Any,
    user_id: str,
    project_id: str,
    request: VideoGenerationAdaptationRequest,
    text_model: str,
    billing_job_id: str | None = None,
) -> VideoGenerationAdaptationResult:
    from server.app.billing.execution import (
        StagedProviderResult,
        execute_billed_provider_call,
        finalize_billed_sync_result,
        retry_payment_required_quote,
    )

    provider_request = prepare_video_generation_adaptation_request(
        request,
        text_model=text_model,
    )
    call = {
        "db": db,
        "newapi": newapi,
        "settings": settings,
        "artifact_inspector": media_store.inspect_staged_artifact,
        "user_id": user_id,
        "project_id": project_id,
        "capability": "text",
        "operation": ADAPTATION_TASK_TYPE,
        "request": provider_request,
    }
    context = (
        execute_billed_provider_call(parent_job_id=None, **call)
        if billing_job_id is None
        else retry_payment_required_quote(job_id=billing_job_id, **call)
    )

    def persist_hidden(job_id: str, response: Any) -> Any:
        try:
            content = response.json()["choices"][0]["message"]["content"]
        except Exception:
            raise VideoGenerationAdaptationError(
                "video_generation_adaptation_invalid",
                "text provider returned an invalid response envelope",
            ) from None
        parsed = parse_model_json(content)
        result = validate_adaptation_result(
            request,
            parsed if isinstance(parsed, Mapping) else {},
        )
        artifact = media_store.stage_sync_result(
            project_id=project_id,
            job_id=job_id,
            operation=ADAPTATION_TASK_TYPE,
            capability="text",
            source_reference=context.execution.reference_id,
            content=response.content,
        )
        return StagedProviderResult(artifact.locator, artifact.sha256, result)

    value = finalize_billed_sync_result(
        db=db,
        newapi=newapi,
        settings=settings,
        artifact_inspector=media_store.inspect_staged_artifact,
        context=context,
        persist_hidden=persist_hidden,
    ).value
    return validate_adaptation_result(request, value)


def stable_hash(value: Any) -> str:
    return "sha256:" + _digest(value)


def _digest(value: Any) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
