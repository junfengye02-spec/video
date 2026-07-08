from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from server.app.settings import DEFAULT_SYAPI_BASE_URL

ProjectType = Literal["single_video", "mini_series", "long_series"]


class Project(BaseModel):
    id: str
    title: str
    mode: Literal["short_drama", "general_video"]
    project_type: ProjectType = "single_video"
    created_at: str
    updated_at: str


class GatewayKey(BaseModel):
    masked: str
    provider: Literal["syapi"] = "syapi"
    base_url: str
    valid: bool = True


ShotSize = Literal[
    "extreme_wide",
    "wide",
    "medium_wide",
    "medium",
    "medium_close",
    "close_up",
    "extreme_close_up",
    "over_shoulder",
    "insert",
    "establishing",
]

CameraMovement = Literal[
    "static",
    "pan_left",
    "pan_right",
    "tilt_up",
    "tilt_down",
    "dolly_in",
    "dolly_out",
    "tracking_left",
    "tracking_right",
    "crane_up",
    "crane_down",
    "handheld",
    "steadicam",
    "whip_pan",
    "orbital",
    "zoom_in",
    "zoom_out",
    "rack_focus",
]


class ShotLanguage(BaseModel):
    shot_size: ShotSize | None = None
    camera_movement: CameraMovement | None = None
    lens_mm: Literal[14, 24, 35, 50, 85, 135, 200] | None = None
    lighting_key: Literal[
        "high_key",
        "low_key",
        "natural",
        "golden_hour",
        "blue_hour",
        "tungsten_warm",
        "neon",
        "silhouette",
        "rim_lit",
        "volumetric",
        "overcast_soft",
    ] | None = None
    depth_of_field: Literal["shallow", "medium", "deep"] | None = None
    color_temperature: Literal["cool", "neutral", "warm", "mixed"] | None = None


class ShotRevision(BaseModel):
    version: int
    source: Literal["create", "prompt_edit", "regenerate"]
    prompt: str
    characters: list[str] = Field(default_factory=list)
    location: str | None = None
    props: list[str] = Field(default_factory=list)
    asset_ids: list[str] = Field(default_factory=list)
    shot_intent: str | None = None
    shot_language: ShotLanguage | None = None
    updated_at: str


class ShotSaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str | None = None
    characters: list[str] | None = None
    location: str | None = None
    props: list[str] | None = None
    asset_ids: list[str] | None = None
    shot_intent: str | None = None
    shot_language: ShotLanguage | None = None


class ShotRegenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    video_key: str = Field(min_length=1)
    base_url: str = "https://api.0000238.xyz"
    video_model: str = "omni_flash-10s"

    @field_validator("video_key")
    @classmethod
    def reject_blank_video_key(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("video_key must not be blank")
        return stripped


class ContinuitySeriesBible(BaseModel):
    worldview: str = ""
    main_arc: str = ""
    style_lock: str = ""
    visual_rules: str = ""
    taboos: list[str] = Field(default_factory=list)
    locations: list[str] = Field(default_factory=list)
    props: list[str] = Field(default_factory=list)
    relationship_map: list[str] = Field(default_factory=list)


class EpisodeOutlineItem(BaseModel):
    episode_number: int = 1
    title: str = ""
    goal: str = ""
    conflict: str = ""
    twist: str = ""
    cliffhanger: str = ""
    inherited_state: list[str] = Field(default_factory=list)
    locked: bool = False


class StoryState(BaseModel):
    character_knowledge: list[str] = Field(default_factory=list)
    relationship_changes: list[str] = Field(default_factory=list)
    active_foreshadowing: list[str] = Field(default_factory=list)
    resolved_foreshadowing: list[str] = Field(default_factory=list)
    prop_state: list[str] = Field(default_factory=list)
    character_status: list[str] = Field(default_factory=list)
    current_locations: list[str] = Field(default_factory=list)


class ContinuityPlan(BaseModel):
    project_type: ProjectType = "single_video"
    active_episode_number: int | None = None
    series_bible: ContinuitySeriesBible = Field(default_factory=ContinuitySeriesBible)
    episodes: list[EpisodeOutlineItem] = Field(default_factory=list)
    story_state: StoryState = Field(default_factory=StoryState)


class PromptOptimizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target: Literal["project", "shot", "asset"]
    target_id: str
    source_text: str = Field(min_length=1)
    text_key: str = Field(min_length=1)
    base_url: str = DEFAULT_SYAPI_BASE_URL
    text_model: str = "gpt-5.5"
    mode: Literal["text", "shot_json"] = "text"

    @field_validator("base_url")
    @classmethod
    def default_blank_base_url(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            return DEFAULT_SYAPI_BASE_URL
        return stripped

    @field_validator("text_key")
    @classmethod
    def reject_blank_text_key(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("text_key must not be blank")
        return stripped


class PromptOptimizeResponse(BaseModel):
    project_id: str
    model: str
    optimized_text: str
    notes: list[str] = Field(default_factory=list)
    shot_intent: str | None = None
    shot_language: ShotLanguage | None = None


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
    shot_intent: str | None = None
    shot_language: ShotLanguage | None = None
    status: Literal["draft", "ready", "generating", "complete", "failed"] = "draft"
    consistency_score: int = 100
    output_url: str | None = None
    output_path: str | None = None
    asset_ids: list[str] = Field(default_factory=list)
    version: int = 1
    history: list[ShotRevision] = Field(default_factory=list)


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
