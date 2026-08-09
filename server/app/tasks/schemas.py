from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


MAX_TASK_ITEM_SNAPSHOT_BYTES = 256 * 1024
MAX_TASK_BATCH_SNAPSHOT_BYTES = 512 * 1024
MAX_TASK_SUBMISSION_BYTES = 1024 * 1024


class TaskItemSubmit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: str = Field(min_length=1, max_length=128)
    task_type: str | None = Field(default=None, min_length=1, max_length=64)
    input: dict[str, Any] = Field(default_factory=dict)
    references: list[dict[str, Any]] = Field(default_factory=list, max_length=50)
    model: str | None = Field(default=None, min_length=1, max_length=255)
    target_entity_type: str | None = Field(default=None, min_length=1, max_length=64)
    target_entity_id: str | None = Field(default=None, min_length=1, max_length=128)
    target_entity_version: int | None = Field(default=None, ge=1)
    depends_on: list[str] = Field(default_factory=list, max_length=100)
    max_attempts: int = Field(default=3, ge=1, le=10)
    billing_job_id: str | None = Field(default=None, min_length=32, max_length=32)
    settlement_key: str | None = Field(
        default=None, min_length=32, max_length=64, pattern=r"^[0-9a-f]+$"
    )
    generation_key: str | None = Field(
        default=None, min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$"
    )
    generation_revision: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def validate_target_version(self) -> "TaskItemSubmit":
        values = (
            self.target_entity_type,
            self.target_entity_id,
            self.target_entity_version,
        )
        if any(value is not None for value in values) and not all(
            value is not None for value in values
        ):
            raise ValueError(
                "target entity type, id, and version must be supplied together"
            )
        if len(self.depends_on) != len(set(self.depends_on)):
            raise ValueError("depends_on must not contain duplicates")
        if _json_size(
            {"input": self.input, "references": self.references}
        ) > MAX_TASK_ITEM_SNAPSHOT_BYTES:
            raise ValueError("task item snapshot is too large")
        return self


class TaskSubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: str = Field(min_length=1, max_length=128)
    task_type: str = Field(min_length=1, max_length=64)
    project_version: int = Field(ge=1)
    snapshot_version: int = Field(default=1, ge=1)
    snapshot: dict[str, Any] = Field(default_factory=dict)
    billing_job_id: str | None = Field(default=None, min_length=32, max_length=32)
    items: list[TaskItemSubmit] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_item_keys_and_dependencies(self) -> "TaskSubmitRequest":
        keys = [item.idempotency_key for item in self.items]
        if len(keys) != len(set(keys)):
            raise ValueError("item idempotency keys must be unique")
        known = set(keys)
        for item in self.items:
            if item.idempotency_key in item.depends_on:
                raise ValueError("task item cannot depend on itself")
            unknown = set(item.depends_on) - known
            if unknown:
                raise ValueError("task dependency must reference an item in the batch")
        _reject_dependency_cycle(self.items)
        if _json_size(self.snapshot) > MAX_TASK_BATCH_SNAPSHOT_BYTES:
            raise ValueError("task batch snapshot is too large")
        if _json_size(self.model_dump(mode="json")) > MAX_TASK_SUBMISSION_BYTES:
            raise ValueError("task submission is too large")
        return self


class TaskDependencyResponse(BaseModel):
    item_id: str
    status: str


class TaskItemResponse(BaseModel):
    id: str
    batch_id: str
    position: int
    task_type: str
    status: str
    idempotency_key: str
    snapshot_version: int
    project_version: int
    input: dict[str, Any]
    references: list[dict[str, Any]]
    model: str | None
    target_entity_type: str | None
    target_entity_id: str | None
    target_entity_version: int | None
    attempt_count: int
    max_attempts: int
    progress: int
    retryable: bool
    error_code: str | None
    error_message: str | None
    result: dict[str, Any] | None
    billing_job_id: str | None
    settlement_key: str
    generation_key: str | None
    generation_revision: int
    provider_wait_started_at: datetime | None
    provider_next_poll_at: datetime | None
    provider_poll_count: int
    dependencies: list[TaskDependencyResponse]
    created_at: datetime
    updated_at: datetime


class TaskBatchResponse(BaseModel):
    id: str
    project_id: str
    task_type: str
    status: str
    idempotency_key: str
    snapshot_version: int
    project_version: int
    snapshot: dict[str, Any]
    progress: int
    total_items: int
    completed_items: int
    failed_items: int
    billing_job_id: str | None
    error_code: str | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime
    items: list[TaskItemResponse] | None = None


class TaskAcceptedResponse(BaseModel):
    task_id: str
    status: str
    deduplicated: bool
    task: TaskBatchResponse


class ShotBatchGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    shot_ids: list[str] = Field(min_length=1, max_length=100)
    idempotency_key: str = Field(min_length=1, max_length=128)
    video_model: str | None = Field(default=None, min_length=1, max_length=255)
    generation_plan_id: str | None = Field(
        default=None, min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$"
    )
    duration_strategy: Literal["accept_model_duration"] | None = None

    @model_validator(mode="after")
    def validate_shot_ids(self) -> "ShotBatchGenerateRequest":
        normalized = [shot_id.strip() for shot_id in self.shot_ids]
        if any(not shot_id or len(shot_id) > 128 for shot_id in normalized):
            raise ValueError("shot identifiers are invalid")
        if len(normalized) != len(set(normalized)):
            raise ValueError("shot identifiers must be unique")
        self.shot_ids = normalized
        return self


class TaskListResponse(BaseModel):
    tasks: list[TaskBatchResponse]


def _reject_dependency_cycle(items: list[TaskItemSubmit]) -> None:
    graph = {item.idempotency_key: item.depends_on for item in items}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(key: str) -> None:
        if key in visiting:
            raise ValueError("task dependencies must be acyclic")
        if key in visited:
            return
        visiting.add(key)
        for dependency in graph[key]:
            visit(dependency)
        visiting.remove(key)
        visited.add(key)

    for key in graph:
        visit(key)


def _json_size(value: Any) -> int:
    return len(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    )
