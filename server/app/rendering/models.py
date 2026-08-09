from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator


SourceAudioPolicy = Literal["preserve", "mix", "replace", "mute"]
TransitionType = Literal["cut", "dissolve", "fade_through_black"]
DurationPolicy = Literal["full_source", "explicit_trim", "explicit_retime"]


class RenderTransition(BaseModel):
    type: TransitionType = "cut"
    duration_seconds: Annotated[float, Field(ge=0, le=5)] = 0

    @model_validator(mode="after")
    def cut_has_no_duration(self) -> "RenderTransition":
        if self.type == "cut" and self.duration_seconds != 0:
            return self.model_copy(update={"duration_seconds": 0.0})
        return self


class RenderSourceAudio(BaseModel):
    policy: SourceAudioPolicy = "preserve"
    volume: Annotated[float, Field(ge=0, le=2)] = 1.0


class RenderMusicTrack(BaseModel):
    source_path: str
    volume: Annotated[float, Field(ge=0, le=2)] = 0.15
    source_in_seconds: Annotated[float, Field(ge=0)] = 0
    fade_in_seconds: Annotated[float, Field(ge=0, le=30)] = 0.3
    fade_out_seconds: Annotated[float, Field(ge=0, le=30)] = 0.8
    ducking: bool | dict = True


class RenderTimedAudioTrack(BaseModel):
    id: str
    source_path: str
    timeline_start_seconds: Annotated[float, Field(ge=0)] = 0
    timeline_end_seconds: Annotated[float | None, Field(gt=0)] = None
    source_in_seconds: Annotated[float, Field(ge=0)] = 0
    volume: Annotated[float, Field(ge=0, le=2)] = 1.0

    @model_validator(mode="after")
    def validate_timeline_range(self) -> "RenderTimedAudioTrack":
        if (
            self.timeline_end_seconds is not None
            and self.timeline_end_seconds <= self.timeline_start_seconds
        ):
            raise ValueError(
                "timeline_end_seconds must be after timeline_start_seconds"
            )
        return self


class RenderAudioPlan(BaseModel):
    source_audio_default: SourceAudioPolicy = "preserve"
    source_audio_volume: Annotated[float, Field(ge=0, le=2)] = 1.0
    source_audio_transition_seconds: Annotated[float, Field(ge=0, le=2)] = 0.08
    music: RenderMusicTrack | None = None
    dialogue: list[RenderTimedAudioTrack] = Field(default_factory=list)
    narration: list[RenderTimedAudioTrack] = Field(default_factory=list)
    sfx: list[RenderTimedAudioTrack] = Field(default_factory=list)
    ambience: list[RenderTimedAudioTrack] = Field(default_factory=list)
    target_lufs: Annotated[float, Field(ge=-70, le=0)] = -14
    true_peak_db: Annotated[float, Field(ge=-12, le=0)] = -1.5
    loudness_range_lu: Annotated[float, Field(ge=1, le=50)] = 11


class RenderClip(BaseModel):
    id: str
    shot_id: str
    generation_unit_id: str | None = None
    generation_unit_revision: Annotated[int, Field(ge=1)] | None = None
    source_shot_ids: list[str] = Field(default_factory=list)
    source_beat_ids: list[str] = Field(default_factory=list)
    source_segment_ids: list[str] = Field(default_factory=list)
    source_path: str
    source_duration_seconds: Annotated[float, Field(gt=0)]
    source_has_audio: bool = False
    source_width: Annotated[int, Field(ge=0)] = 0
    source_height: Annotated[int, Field(ge=0)] = 0
    source_in_seconds: Annotated[float, Field(ge=0)]
    source_out_seconds: Annotated[float, Field(gt=0)]
    source_handle_before_seconds: Annotated[float, Field(ge=0)] = 0
    source_handle_after_seconds: Annotated[float, Field(ge=0)] = 0
    timeline_start_seconds: Annotated[float, Field(ge=0)]
    timeline_duration_seconds: Annotated[float, Field(gt=0)]
    duration_policy: DurationPolicy = "full_source"
    playback_rate: Annotated[float, Field(gt=0, le=16)] = 1
    transition_in: RenderTransition = Field(default_factory=RenderTransition)
    transition_out: RenderTransition = Field(default_factory=RenderTransition)
    source_audio: RenderSourceAudio = Field(default_factory=RenderSourceAudio)

    @model_validator(mode="after")
    def validate_ranges(self) -> "RenderClip":
        if self.source_out_seconds <= self.source_in_seconds:
            raise ValueError("source_out_seconds must be after source_in_seconds")
        if self.source_out_seconds > self.source_duration_seconds + 0.001:
            raise ValueError("source range exceeds source media duration")
        if self.source_in_seconds + 0.001 < self.source_handle_before_seconds:
            raise ValueError("source media has insufficient leading transition handle")
        if (
            self.source_out_seconds + self.source_handle_after_seconds
            > self.source_duration_seconds + 0.001
        ):
            raise ValueError("source media has insufficient trailing transition handle")
        if (
            self.duration_policy != "explicit_retime"
            and abs(self.playback_rate - 1) > 0.001
        ):
            raise ValueError("playback_rate requires explicit_retime")
        if (
            self.duration_policy != "explicit_retime"
            and self.source_out_seconds - self.source_in_seconds + 0.001
            < self.timeline_duration_seconds
        ):
            raise ValueError("source range is shorter than timeline duration")
        source_window = self.source_out_seconds - self.source_in_seconds
        if (
            self.duration_policy == "explicit_retime"
            and abs(source_window / self.timeline_duration_seconds - self.playback_rate)
            > 0.01
        ):
            raise ValueError("playback_rate does not match the explicit retime window")
        return self


class RenderOutputSpec(BaseModel):
    width: Annotated[int, Field(gt=0)]
    height: Annotated[int, Field(gt=0)]
    fps: Annotated[float, Field(gt=0, le=120)] = 30
    format: Literal["mp4"] = "mp4"
    video_codec: str = "h264"
    audio_codec: str = "aac"


class RenderPlan(BaseModel):
    version: Literal["1.0"] = "1.0"
    project_id: str
    storyboard_revision: str
    total_duration_seconds: Annotated[float, Field(gt=0)]
    output: RenderOutputSpec
    clips: list[RenderClip] = Field(min_length=1)
    audio: RenderAudioPlan = Field(default_factory=RenderAudioPlan)
    renderer_family: str = "cinematic-trailer"
    render_runtime: Literal["remotion", "hyperframes", "ffmpeg"]

    @model_validator(mode="after")
    def validate_timeline(self) -> "RenderPlan":
        ordered = sorted(self.clips, key=lambda clip: clip.timeline_start_seconds)
        previous_start = -1.0
        for clip in ordered:
            if clip.timeline_start_seconds < previous_start:
                raise ValueError("clips must have stable timeline ordering")
            previous_start = clip.timeline_start_seconds
        computed_total = max(
            clip.timeline_start_seconds + clip.timeline_duration_seconds
            for clip in ordered
        )
        if abs(computed_total - self.total_duration_seconds) > 0.01:
            raise ValueError("total duration does not match clip timeline")
        return self
