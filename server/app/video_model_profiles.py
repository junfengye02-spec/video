from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from math import isfinite
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy.orm import Session


VideoOperation = Literal[
    "text_to_video",
    "image_to_video",
    "first_last_frame_to_video",
    "extend",
]
DurationMode = Literal["fixed", "supported_values", "flexible", "unknown"]
ContractSource = Literal[
    "provider_catalog",
    "verified_override",
    "admin_configuration",
]
DurationConfigurationStatus = Literal["configured", "unconfigured"]


class VideoModelDurationConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)

    provider: str
    model_id: str
    call_duration_seconds: float = Field(gt=0)
    version: int = Field(ge=1)


class VideoModelProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    provider: str
    model_id: str
    operation: VideoOperation
    duration_mode: DurationMode
    fixed_duration_seconds: float | None = Field(default=None, gt=0)
    supported_duration_seconds: list[float] = Field(default_factory=list)
    min_duration_seconds: float | None = Field(default=None, gt=0)
    max_duration_seconds: float | None = Field(default=None, gt=0)
    supports_start_frame: bool = False
    supports_end_frame: bool = False
    supports_extend: bool = False
    supports_sequential_beats: bool = False
    supports_multi_shot_prompt: bool = False
    max_narrative_beats_per_unit: int = Field(default=1, ge=1)
    max_reference_images: int | None = Field(default=None, ge=1)
    contract_source: ContractSource
    profile_revision: str
    duration_configuration_status: DurationConfigurationStatus = "unconfigured"


class GenerationSegment(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    source_shot_id: str
    source_beat_id: str
    sequence: int = Field(ge=1)
    segment_index: int = Field(ge=1)
    segment_count: int = Field(ge=1)
    recommended_content_duration_seconds: float | None = Field(default=None, gt=0)
    prompt: str = Field(min_length=1)
    transition: Literal["continuous", "cut", "match_cut"] = "cut"
    continuity_requirements: list[str] = Field(default_factory=list)
    start_state: str = Field(min_length=1)
    action_progress: str = Field(min_length=1)
    end_state: str = Field(min_length=1)


# Compatibility import name used by the existing prompt compiler.
GenerationPromptSegment = GenerationSegment


class GenerationUnit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    revision: int = Field(default=1, ge=1)
    status: Literal[
        "planned",
        "queued",
        "running",
        "waiting_provider",
        "complete",
        "failed",
        "stale",
    ] = "planned"
    shot_ids: list[str] = Field(min_length=1)
    source_shot_ids: list[str] = Field(min_length=1)
    source_beat_ids: list[str] = Field(min_length=1)
    source_segment_ids: list[str] = Field(min_length=1)
    prompt_segments: list[GenerationSegment] = Field(min_length=1)
    provider: str
    model_id: str
    operation: VideoOperation
    requested_duration_seconds: float | None = Field(default=None, gt=0)
    source_duration_seconds: float | None = Field(default=None, gt=0)
    timeline_duration_seconds: float | None = Field(default=None, gt=0)
    output_asset_id: str | None = None
    output_path: str | None = None
    billing_job_id: str | None = None
    task_item_id: str | None = None
    replaces_unit_id: str | None = None
    profile: VideoModelProfile

    @model_validator(mode="after")
    def validate_source_mapping(self) -> "GenerationUnit":
        if self.shot_ids != self.source_shot_ids:
            raise ValueError("shot_ids must match source_shot_ids")
        if len(self.source_shot_ids) != len(set(self.source_shot_ids)):
            raise ValueError("source shot IDs must be unique within a unit")
        if len(self.source_beat_ids) != len(set(self.source_beat_ids)):
            raise ValueError("source beat IDs must be unique within a unit")
        if self.source_segment_ids != [segment.id for segment in self.prompt_segments]:
            raise ValueError("prompt segments must match source segment IDs in order")
        prompt_shots = list(
            dict.fromkeys(segment.source_shot_id for segment in self.prompt_segments)
        )
        prompt_beats = list(
            dict.fromkeys(segment.source_beat_id for segment in self.prompt_segments)
        )
        if prompt_shots != self.source_shot_ids or prompt_beats != self.source_beat_ids:
            raise ValueError("segment source mapping must match unit source mapping")
        return self


class GenerationPlanIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    message: str
    shot_id: str | None = None
    unit_id: str | None = None


class GenerationPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal["1.0"] = "1.0"
    id: str
    storyboard_revision: str
    provider: str
    model_id: str
    shot_ids: list[str]
    storyboard_shot_count: int = Field(ge=0)
    generation_unit_count: int = Field(ge=0)
    protected_generation_unit_ids: list[str] = Field(default_factory=list)
    pending_shot_ids: list[str] = Field(default_factory=list)
    covered_shot_ids: list[str] = Field(default_factory=list)
    covered_segment_ids: list[str] = Field(default_factory=list)
    target_duration_seconds: float | None = Field(default=None, gt=0)
    native_total_duration_seconds: float | None = Field(default=None, gt=0)
    timeline_total_duration_seconds: float | None = Field(default=None, gt=0)
    duration_difference_seconds: float | None = None
    compatible_with_target: bool
    requires_confirmation: bool
    can_generate: bool
    confirmed_strategy: (
        Literal["accept_model_duration", "accept_longer_duration"] | None
    ) = None
    issues: list[GenerationPlanIssue] = Field(default_factory=list)
    adaptation_options: list[str] = Field(default_factory=list)
    generation_segments: list[GenerationSegment] = Field(default_factory=list)
    generation_units: list[GenerationUnit]


@dataclass(frozen=True, slots=True)
class _TechnicalCapability:
    provider: str
    model_id: str
    operation: VideoOperation
    supports_start_frame: bool = False
    supports_end_frame: bool = False
    supports_extend: bool = False
    supports_sequential_beats: bool = False
    supports_multi_shot_prompt: bool = False
    max_narrative_beats_per_unit: int = 1
    max_reference_images: int | None = None


def _capability(
    model_id: str,
    operation: VideoOperation,
    **kwargs: Any,
) -> _TechnicalCapability:
    return _TechnicalCapability("newapi", model_id, operation, **kwargs)


# This table intentionally contains no duration data. It records only verified
# transport/model capabilities that an administrator-entered duration cannot express.
_STATIC_CAPABILITIES = [
    _capability(
        "omni_flash-10s",
        "text_to_video",
        supports_sequential_beats=True,
        supports_multi_shot_prompt=True,
        max_narrative_beats_per_unit=2,
    ),
    _capability("omni_flash-10s", "image_to_video"),
    _capability("omni_flash-10s", "first_last_frame_to_video"),
    *[
        _capability(
            model_id,
            "text_to_video",
            supports_sequential_beats=True,
            supports_multi_shot_prompt=True,
            max_narrative_beats_per_unit=2,
        )
        for model_id in ("sora-2-12s", "sora_2", "sora_v2", "sora_v2_pro")
    ],
    *[
        _capability(model_id, operation)
        for model_id in ("veo_3_1-lite", "veo_3_1-fast-fl", "video-model")
        for operation in (
            "text_to_video",
            "image_to_video",
            "first_last_frame_to_video",
        )
    ],
]
_CAPABILITY_INDEX = {
    (capability.provider, capability.model_id, capability.operation): capability
    for capability in _STATIC_CAPABILITIES
}


def video_model_profile_revision(
    configuration: VideoModelDurationConfiguration,
) -> str:
    payload = {
        "provider": configuration.provider,
        "model_id": configuration.model_id,
        "version": configuration.version,
        "call_duration_seconds": configuration.call_duration_seconds,
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return f"video-model-duration-v{configuration.version}-{digest[:24]}"


def video_model_profile(
    model_id: str,
    operation: VideoOperation,
    *,
    provider: str = "newapi",
    db: Session | None = None,
    duration_configuration: VideoModelDurationConfiguration | None = None,
) -> VideoModelProfile:
    if db is not None:
        from server.app.video_model_settings.service import VideoModelDurationService

        duration_configuration = VideoModelDurationService(db).configuration(
            provider=provider,
            model_id=model_id,
        )
    capability = _CAPABILITY_INDEX.get((provider, model_id, operation))
    capability_values = (
        {}
        if capability is None
        else {
            "supports_start_frame": capability.supports_start_frame,
            "supports_end_frame": capability.supports_end_frame,
            "supports_extend": capability.supports_extend,
            "supports_sequential_beats": capability.supports_sequential_beats,
            "supports_multi_shot_prompt": capability.supports_multi_shot_prompt,
            "max_narrative_beats_per_unit": capability.max_narrative_beats_per_unit,
            "max_reference_images": capability.max_reference_images,
        }
    )
    if duration_configuration is not None:
        if (
            duration_configuration.provider != provider
            or duration_configuration.model_id != model_id
            or not isfinite(duration_configuration.call_duration_seconds)
        ):
            raise ValueError(
                "duration configuration does not match the requested model"
            )
        return VideoModelProfile(
            provider=provider,
            model_id=model_id,
            operation=operation,
            duration_mode="fixed",
            fixed_duration_seconds=duration_configuration.call_duration_seconds,
            contract_source="admin_configuration",
            profile_revision=video_model_profile_revision(duration_configuration),
            duration_configuration_status="configured",
            **capability_values,
        )
    return VideoModelProfile(
        provider=provider,
        model_id=model_id,
        operation=operation,
        duration_mode="unknown",
        contract_source="provider_catalog",
        profile_revision="provider-catalog-unknown-v1",
        duration_configuration_status="unconfigured",
        **capability_values,
    )


def model_profiles(
    model_ids: Iterable[str],
    *,
    provider: str = "newapi",
    db: Session | None = None,
) -> list[VideoModelProfile]:
    configurations: dict[tuple[str, str], VideoModelDurationConfiguration] = {}
    if db is not None:
        from server.app.video_model_settings.service import VideoModelDurationService

        configurations = VideoModelDurationService(db).configuration_map(
            provider=provider
        )
    result: list[VideoModelProfile] = []
    for model_id in model_ids:
        operations = [
            operation
            for (capability_provider, capability_model, operation) in _CAPABILITY_INDEX
            if capability_provider == provider and capability_model == model_id
        ]
        configuration = configurations.get((provider, model_id))
        result.extend(
            video_model_profile(
                model_id,
                operation,
                provider=provider,
                duration_configuration=configuration,
            )
            for operation in sorted(operations or ["text_to_video"])
        )
    return result


def operation_for_shot(shot: Mapping[str, Any]) -> VideoOperation:
    continuity = shot.get("continuity")
    value = continuity if isinstance(continuity, Mapping) else {}
    first = _ready_frame(value.get("first_frame"))
    last = _ready_frame(value.get("last_frame"))
    regeneration = str(shot.get("status") or "") == "complete"
    if regeneration and first and last:
        return "first_last_frame_to_video"
    if first or (
        value.get("mode") == "carry" and value.get("inherit_previous_tail") is True
    ):
        return "image_to_video"
    return "text_to_video"


def _ready_frame(value: Any) -> bool:
    return (
        isinstance(value, Mapping)
        and value.get("status") == "ready"
        and bool(value.get("asset_id"))
    )


from server.app.generation_unit_planner import build_generation_plan  # noqa: E402, F401
