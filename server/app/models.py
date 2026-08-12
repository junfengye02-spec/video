from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ProjectType = Literal["single_video", "mini_series", "long_series"]
PlanSectionId = Literal[
    "worldview",
    "characters",
    "scenes",
    "props",
    "sound",
    "storyboard",
]
PlanSectionStatus = Literal["pending", "approved", "changes_requested"]
PLAN_SECTION_IDS: tuple[PlanSectionId, ...] = (
    "worldview",
    "characters",
    "scenes",
    "props",
    "sound",
    "storyboard",
)


class CredentialFreeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def discard_legacy_provider_credentials(cls, value: Any) -> Any:
        if not isinstance(value, Mapping):
            return value
        return {
            key: item
            for key, item in value.items()
            if key not in {"text_key", "image_key", "video_key", "base_url"}
        }


class InspirationAttachment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=32, max_length=32, pattern=r"^[0-9a-f]{32}$")
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(min_length=1, max_length=255)
    size: int = Field(ge=0, le=20 * 1024 * 1024)
    url: str = Field(min_length=1, max_length=4000)


class InspirationMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str = Field(default="", max_length=6000)
    attachments: list[InspirationAttachment] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def require_content_or_attachment(self) -> "InspirationMessage":
        if not self.content.strip() and not self.attachments:
            raise ValueError("message content or attachment is required")
        return self


class NarrativeBeat(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    index: int = Field(ge=1)
    summary: str = Field(min_length=1, max_length=3000)
    recommended_duration_seconds: float = Field(gt=0, le=7200)
    duration_range_seconds: tuple[float, float]
    can_merge_with_next: bool = True
    must_complete_action: bool = False
    must_preserve_emotion: bool = False
    cannot_split_reason: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def validate_duration_range(self) -> "NarrativeBeat":
        minimum, maximum = self.duration_range_seconds
        if minimum <= 0 or maximum < minimum:
            raise ValueError("duration range must be positive and ordered")
        if not minimum <= self.recommended_duration_seconds <= maximum:
            raise ValueError("recommended duration must be inside its range")
        return self


class CreativeBrief(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(default="", max_length=255)
    logline: str = Field(default="", max_length=2000)
    audience: str = Field(default="", max_length=1000)
    format: str = Field(default="", max_length=1000)
    duration_seconds: int | None = Field(default=None, ge=1, le=7200)
    aspect_ratio: str = Field(default="9:16", max_length=32)
    genre: str = Field(default="", max_length=500)
    tone: str = Field(default="", max_length=1000)
    visual_style: str = Field(default="", max_length=3000)
    story_outline: str = Field(default="", max_length=6000)
    must_have: list[str] = Field(default_factory=list, max_length=30)
    open_questions: list[str] = Field(default_factory=list, max_length=10)
    narrative_beats: list[NarrativeBeat] = Field(default_factory=list, max_length=120)


class InspirationChatRequest(CredentialFreeRequest):
    messages: list[InspirationMessage] = Field(min_length=1, max_length=24)
    text_model: str = "gpt-5.5"
    billing_job_id: str | None = Field(default=None, min_length=32, max_length=32)


class InspirationIntentUpdateRequest(CredentialFreeRequest):
    control_end_frames: bool = False


class PlanSectionApproval(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: PlanSectionStatus = "pending"
    revision: int = Field(default=1, ge=1)
    feedback: str | None = Field(default=None, max_length=6000)
    updated_at: str | None = None


class StoryboardRevisionSession(BaseModel):
    model_config = ConfigDict(extra="forbid")

    section: Literal["storyboard"] = "storyboard"
    source: Literal["generation_plan_duration"] = "generation_plan_duration"
    started_at: str
    original_approved_at: str | None = None
    section_revision: int = Field(ge=1)


class CreativeWorkflow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    phase: Literal["inspiration", "plan_review", "approved"]
    messages: list[InspirationMessage] = Field(default_factory=list)
    brief: CreativeBrief | None = None
    ready_to_confirm: bool = False
    control_end_frames: bool = False
    text_model: str | None = Field(default=None, min_length=1, max_length=200)
    planned_asset_ids: list[str] = Field(default_factory=list)
    approved_at: str | None = None
    brief_confirmed_at: str | None = None
    plan_generated_at: str | None = None
    revision_session: StoryboardRevisionSession | None = None
    plan_sections: dict[PlanSectionId, PlanSectionApproval]


class PlanSectionUpdateRequest(CredentialFreeRequest):
    status: Literal["approved", "changes_requested"]
    feedback: str | None = Field(default=None, max_length=6000)
    revision: int = Field(ge=1)


class CreativePlanReviseRequest(CredentialFreeRequest):
    sections: list[PlanSectionId] = Field(min_length=1, max_length=len(PLAN_SECTION_IDS))
    feedback: str = Field(min_length=1, max_length=6000)
    text_model: str | None = Field(default=None, min_length=1, max_length=200)
    billing_job_id: str | None = Field(default=None, min_length=32, max_length=32)

    @field_validator("sections")
    @classmethod
    def sections_must_be_unique(
        cls,
        value: list[PlanSectionId],
    ) -> list[PlanSectionId]:
        if len(value) != len(set(value)):
            raise ValueError("sections must not contain duplicates")
        return value


class Project(BaseModel):
    id: str
    title: str
    mode: Literal["short_drama", "general_video"]
    project_type: ProjectType = "single_video"
    created_at: str
    updated_at: str


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


class ShotFrameReference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asset_id: str = Field(min_length=1, max_length=128)
    version: int = Field(default=1, ge=1)
    status: Literal["ready", "generating", "failed", "stale"] = "ready"
    source: Literal["user", "video_extract", "ai_generated", "inherited"] = "user"
    generation_job_id: str | None = Field(default=None, max_length=128)
    origin_shot_id: str | None = Field(default=None, max_length=128)
    origin_shot_version: int | None = Field(default=None, ge=1)
    origin_frame_version: int | None = Field(default=None, ge=1)


class ShotContinuity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["carry", "cut", "match_cut"] = "cut"
    inherit_previous_tail: bool = False
    explicit_user_first_frame_asset_id: str | None = Field(default=None, max_length=128)
    inherited_first_frame_asset_id: str | None = Field(default=None, max_length=128)
    last_frame_asset_id: str | None = Field(default=None, max_length=128)
    first_frame: ShotFrameReference | None = None
    last_frame: ShotFrameReference | None = None
    stale: bool = False
    composition: str = Field(default="", max_length=4000)
    subject_pose: str = Field(default="", max_length=4000)
    gaze: str = Field(default="", max_length=4000)
    motion_direction: str = Field(default="", max_length=4000)
    lighting: str = Field(default="", max_length=4000)
    scene_state: str = Field(default="", max_length=4000)


class ShotRevision(BaseModel):
    version: int
    source: Literal["create", "prompt_edit", "regenerate", "ai_generated_frame"]
    prompt: str
    characters: list[str] = Field(default_factory=list)
    location: str | None = None
    props: list[str] = Field(default_factory=list)
    asset_ids: list[str] = Field(default_factory=list)
    shot_intent: str | None = None
    shot_language: ShotLanguage | None = None
    continuity: ShotContinuity = Field(default_factory=ShotContinuity)
    beat_id: str | None = None
    recommended_duration_seconds: float | None = Field(default=None, gt=0)
    duration_range_seconds: tuple[float, float] | None = None
    can_merge_with_next: bool = False
    must_complete_action: bool = False
    must_preserve_emotion: bool = False
    cannot_split_reason: str | None = None
    updated_at: str


class ShotSaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    episode_number: int | None = Field(default=None, ge=1)
    prompt: str | None = None
    characters: list[str] | None = None
    location: str | None = None
    props: list[str] | None = None
    asset_ids: list[str] | None = None
    shot_intent: str | None = None
    shot_language: ShotLanguage | None = None
    continuity: ShotContinuity | None = None


class ShotRegenerateRequest(CredentialFreeRequest):
    video_model: str | None = Field(default=None, min_length=1, max_length=255)
    billing_job_id: str | None = Field(default=None, min_length=32, max_length=32)
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=128)


class ContinuitySeriesBible(BaseModel):
    worldview: str = ""
    main_arc: str = ""
    style_lock: str = ""
    visual_rules: str = ""
    series_prompt: str = ""
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
    prompt: str = ""
    outline: str = ""
    locked: bool = False


class StoryState(BaseModel):
    character_knowledge: list[str] = Field(default_factory=list)
    relationship_changes: list[str] = Field(default_factory=list)
    active_foreshadowing: list[str] = Field(default_factory=list)
    resolved_foreshadowing: list[str] = Field(default_factory=list)
    prop_state: list[str] = Field(default_factory=list)
    character_status: list[str] = Field(default_factory=list)
    current_locations: list[str] = Field(default_factory=list)


class ContinuitySound(BaseModel):
    narration: str = Field(default="", max_length=10_000)
    dialogue: str = Field(default="", max_length=10_000)
    ambience: str = Field(default="", max_length=10_000)
    music_direction: str = Field(default="", max_length=10_000)
    prompt: str = Field(default="", max_length=10_000)
    storyboard_prompt_integration: bool = False


class ProjectGenerationPreferences(BaseModel):
    image_model: str = Field(default="gpt-image-2", min_length=1, max_length=255)
    video_model: str = Field(default="omni_flash-10s", min_length=1, max_length=255)
    image_size: str = Field(default="1024x1024", min_length=1, max_length=64)
    image_quality: str = Field(default="standard", min_length=1, max_length=64)
    aspect_ratio: str = Field(default="16:9", min_length=1, max_length=32)


class ContinuityPlan(BaseModel):
    project_type: ProjectType = "single_video"
    active_episode_number: int | None = None
    series_bible: ContinuitySeriesBible = Field(default_factory=ContinuitySeriesBible)
    episodes: list[EpisodeOutlineItem] = Field(default_factory=list)
    story_state: StoryState = Field(default_factory=StoryState)
    sound: ContinuitySound = Field(default_factory=ContinuitySound)
    generation_preferences: ProjectGenerationPreferences = Field(
        default_factory=ProjectGenerationPreferences
    )


class PromptOptimizeRequest(CredentialFreeRequest):
    target: Literal["project", "shot", "asset"]
    target_id: str
    source_text: str = Field(min_length=1)
    asset_kind: Literal["character", "scene", "prop"] | None = None
    text_model: str = "gpt-5.5"
    mode: Literal["text", "shot_json"] = "text"
    billing_job_id: str | None = Field(default=None, min_length=32, max_length=32)


class ImageGenerationRequest(CredentialFreeRequest):
    prompt: str = Field(min_length=1, max_length=10000)
    model: str = Field(default="gpt-image-2", min_length=1, max_length=200)
    count: int = Field(default=1, ge=1, le=10)
    size: Literal["1024x1024", "1536x1024", "1024x1536"] = "1024x1024"
    quality: Literal["standard", "high"] = "standard"
    kind: Literal["character", "scene", "prop"] = "scene"
    label: str = Field(default="Generated image", min_length=1, max_length=255)
    description: str = Field(default="", max_length=10000)
    billing_job_id: str | None = Field(default=None, min_length=32, max_length=32)
    resource_ids: list[str] = Field(default_factory=list, max_length=100)
    shot_id: str | None = Field(default=None, min_length=1, max_length=128)
    frame_target: Literal["first", "last"] | None = None
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_generation_target(self) -> "ImageGenerationRequest":
        if (self.shot_id is None) != (self.frame_target is None):
            raise ValueError("shot_id and frame_target must be supplied together")
        if self.shot_id is not None and self.resource_ids:
            raise ValueError("shot frame generation cannot target project resources")
        if self.shot_id is not None and self.count != 1:
            raise ValueError("shot frame generation produces exactly one image")
        return self


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
    episode_number: int | None = Field(default=None, ge=1)
    beat_id: str | None = Field(default=None, max_length=128)
    beat: str
    prompt: str
    characters: list[str] = Field(default_factory=list)
    location: str | None = None
    props: list[str] = Field(default_factory=list)
    shot_intent: str | None = None
    shot_language: ShotLanguage | None = None
    status: Literal[
        "draft", "ready", "generating", "complete", "failed", "stale"
    ] = "draft"
    consistency_score: int = 100
    output_url: str | None = None
    output_path: str | None = None
    requested_duration_seconds: float | None = Field(default=None, gt=0)
    source_duration_seconds: float | None = Field(default=None, gt=0)
    timeline_duration_seconds: float | None = Field(default=None, gt=0)
    asset_ids: list[str] = Field(default_factory=list)
    continuity: ShotContinuity = Field(default_factory=ShotContinuity)
    recommended_duration_seconds: float | None = Field(default=None, gt=0)
    duration_range_seconds: tuple[float, float] | None = None
    can_merge_with_next: bool = False
    must_complete_action: bool = False
    must_preserve_emotion: bool = False
    cannot_split_reason: str | None = Field(default=None, max_length=2000)
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
