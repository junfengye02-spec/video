from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Project(BaseModel):
    id: str
    title: str
    mode: Literal["short_drama", "general_video"]
    created_at: str
    updated_at: str


class GatewayKey(BaseModel):
    masked: str
    provider: Literal["syapi"] = "syapi"
    base_url: str
    valid: bool = True


class Character(BaseModel):
    id: str
    name: str
    role: str
    visual_lock: str
    voice: str | None = None
    reference_images: list[str] = Field(default_factory=list)
    locked: bool = True


class Shot(BaseModel):
    id: str
    scene_id: str
    index: int
    beat: str
    prompt: str
    characters: list[str] = Field(default_factory=list)
    location: str | None = None
    props: list[str] = Field(default_factory=list)
    status: Literal["draft", "ready", "generating", "complete", "failed"] = "draft"
    consistency_score: int = 100
    output_url: str | None = None
    output_path: str | None = None


class ConsistencyIssue(BaseModel):
    shot_id: str | None = None
    severity: Literal["info", "warning", "error"] = "warning"
    code: str
    message: str


class ConsistencyReport(BaseModel):
    score: int
    issues: list[ConsistencyIssue] = Field(default_factory=list)


class JobEvent(BaseModel):
    id: str
    job_id: str
    project_id: str
    stage: str
    status: str
    message: str
    created_at: str


class Job(BaseModel):
    id: str
    project_id: str
    stage: str
    status: Literal["queued", "running", "complete", "failed"] = "queued"
    events: list[JobEvent] = Field(default_factory=list)

