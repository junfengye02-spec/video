from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from server.app.models import CredentialFreeRequest
from server.app.video_model_profiles import GenerationPlan, VideoOperation


class GenerationExecutionUnit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    plan_id: str
    revision: int = Field(ge=1)
    status: Literal[
        "planned",
        "queued",
        "running",
        "waiting_provider",
        "complete",
        "failed",
        "stale",
    ]
    active: bool | None = None
    source_shot_ids: list[str] = Field(min_length=1)
    source_shot_versions: dict[str, int]
    source_beat_ids: list[str] = Field(min_length=1)
    source_segment_ids: list[str] = Field(default_factory=list)
    prompt_segments: list[dict[str, Any]] = Field(default_factory=list)
    provider: str
    model_id: str
    operation: VideoOperation
    profile_revision: str | None = None
    profile: dict[str, Any] | None = None
    requested_duration_seconds: float | None = None
    source_duration_seconds: float | None = None
    timeline_duration_seconds: float | None = None
    output_asset_id: str | None = None
    output_path: str | None = None
    task_item_id: str | None = None
    billing_job_id: str | None = None
    replaces_unit_id: str | None = None
    diagnostics: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class GenerationExecutionSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal["1.0"] = "1.0"
    project_id: str
    updated_at: datetime
    active_generation_unit_ids: list[str]
    generation_units: list[GenerationExecutionUnit]


class GenerationPlanCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: str = "1.0"
    request: dict[str, Any]
    generation_plan: GenerationPlan


class GenerationUnitsGenerateRequest(CredentialFreeRequest):
    contract_version: int | None = Field(default=None, ge=1)
    generation_plan_id: str = Field(
        min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$"
    )
    generation_unit_ids: list[str] = Field(min_length=1, max_length=100)
    idempotency_key: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_unit_ids(self) -> "GenerationUnitsGenerateRequest":
        normalized = [unit_id.strip() for unit_id in self.generation_unit_ids]
        if any(not unit_id or len(unit_id) > 128 for unit_id in normalized):
            raise ValueError("generation unit identifiers are invalid")
        if len(normalized) != len(set(normalized)):
            raise ValueError("generation unit identifiers must be unique")
        self.generation_unit_ids = normalized
        return self
