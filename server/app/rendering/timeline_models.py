from __future__ import annotations

from fractions import Fraction
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator

from server.app.rendering.models import RenderSourceAudio


class RationalTime(BaseModel):
    value: Annotated[int, Field(ge=0)]
    rate_numerator: Annotated[int, Field(gt=0)]
    rate_denominator: Annotated[int, Field(gt=0)] = 1

    @classmethod
    def from_seconds(
        cls,
        seconds: float,
        *,
        rate_numerator: int,
        rate_denominator: int = 1,
    ) -> "RationalTime":
        frames = round(seconds * rate_numerator / rate_denominator)
        return cls(
            value=max(0, frames),
            rate_numerator=rate_numerator,
            rate_denominator=rate_denominator,
        )

    @classmethod
    def from_fps(cls, value: int, fps: float) -> "RationalTime":
        rate = Fraction(str(fps)).limit_denominator(1001)
        return cls(
            value=value,
            rate_numerator=rate.numerator,
            rate_denominator=rate.denominator,
        )

    def seconds(self) -> float:
        return self.value * self.rate_denominator / self.rate_numerator

    def same_rate(self, other: "RationalTime") -> bool:
        return (
            self.rate_numerator * other.rate_denominator
            == other.rate_numerator * self.rate_denominator
        )


class RationalTimeRange(BaseModel):
    start: RationalTime
    duration: RationalTime

    @model_validator(mode="after")
    def validate_range(self) -> "RationalTimeRange":
        if self.duration.value <= 0:
            raise ValueError("duration must contain at least one frame")
        if not self.start.same_rate(self.duration):
            raise ValueError("range start and duration must use the same rate")
        return self


class TimelineOutputSpec(BaseModel):
    width: Annotated[int, Field(gt=0)]
    height: Annotated[int, Field(gt=0)]
    frame_rate_numerator: Annotated[int, Field(gt=0)] = 30
    frame_rate_denominator: Annotated[int, Field(gt=0)] = 1
    format: Literal["mp4"] = "mp4"
    video_codec: str = "h264"
    audio_codec: str = "aac"

    @property
    def fps(self) -> float:
        return self.frame_rate_numerator / self.frame_rate_denominator

    def time(self, value: int) -> RationalTime:
        return RationalTime(
            value=value,
            rate_numerator=self.frame_rate_numerator,
            rate_denominator=self.frame_rate_denominator,
        )


class TimelineMediaReference(BaseModel):
    id: str
    path: str
    kind: Literal["video", "audio", "image"]
    available_range: RationalTimeRange | None = None
    has_audio: bool | None = None
    probe_hash: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class TimelineClip(BaseModel):
    type: Literal["clip"] = "clip"
    id: str
    media_reference_id: str
    source_range: RationalTimeRange
    timeline_duration: RationalTime
    source_audio: RenderSourceAudio = Field(default_factory=RenderSourceAudio)
    speed: Annotated[float, Field(gt=0)] = 1.0
    metadata: dict[str, Any] = Field(default_factory=dict)


class TimelineGap(BaseModel):
    type: Literal["gap"] = "gap"
    id: str
    duration: RationalTime


TimelineItem = Annotated[TimelineClip | TimelineGap, Field(discriminator="type")]


class TimelineTrack(BaseModel):
    id: str
    kind: Literal["video", "audio", "subtitle"]
    role: Literal[
        "primary",
        "overlay",
        "subtitle",
        "dialogue",
        "narration",
        "music",
        "sfx",
        "ambience",
    ]
    items: list[TimelineItem] = Field(default_factory=list)
    enabled: bool = True
    volume: Annotated[float, Field(ge=0, le=2)] = 1.0
    metadata: dict[str, Any] = Field(default_factory=dict)

    def duration_frames(self, output: TimelineOutputSpec) -> int:
        total = 0
        for item in self.items:
            value = item.timeline_duration if isinstance(item, TimelineClip) else item.duration
            if not value.same_rate(output.time(0)):
                raise ValueError("track item does not use the output timebase")
            total += value.value
        return total


class TimelineTransition(BaseModel):
    id: str
    from_item_id: str
    to_item_id: str
    type: Literal["dissolve", "fade_through_black"]
    in_offset: RationalTime
    out_offset: RationalTime
    audio_curve: Literal["linear", "equal_power"] = "equal_power"

    @model_validator(mode="after")
    def validate_offsets(self) -> "TimelineTransition":
        if not self.in_offset.same_rate(self.out_offset):
            raise ValueError("transition offsets must use the same rate")
        if self.in_offset.value + self.out_offset.value <= 0:
            raise ValueError("transition must consume at least one frame")
        return self


class EditTimeline(BaseModel):
    version: Literal["2.0"] = "2.0"
    project_id: str
    revision: str
    output: TimelineOutputSpec
    media_references: list[TimelineMediaReference] = Field(default_factory=list)
    tracks: list[TimelineTrack] = Field(min_length=1)
    transitions: list[TimelineTransition] = Field(default_factory=list)
    render_runtime: Literal["remotion", "hyperframes", "ffmpeg"]
    renderer_family: str = "cinematic-trailer"
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_timeline(self) -> "EditTimeline":
        media_ids = [reference.id for reference in self.media_references]
        if len(media_ids) != len(set(media_ids)):
            raise ValueError("media reference ids must be unique")

        items: dict[str, TimelineClip | TimelineGap] = {}
        adjacency: set[tuple[str, str]] = set()
        item_track: dict[str, str] = {}
        for track in self.tracks:
            previous_id: str | None = None
            for item in track.items:
                if item.id in items:
                    raise ValueError("timeline item ids must be unique")
                items[item.id] = item
                item_track[item.id] = track.id
                if isinstance(item, TimelineClip) and item.media_reference_id not in media_ids:
                    raise ValueError("timeline clip has an unknown media reference")
                if previous_id is not None:
                    adjacency.add((previous_id, item.id))
                previous_id = item.id
            track.duration_frames(self.output)

        incoming: dict[str, int] = {}
        outgoing: dict[str, int] = {}
        seen_boundaries: set[tuple[str, str]] = set()
        output_rate = self.output.time(0)
        for transition in self.transitions:
            boundary = (transition.from_item_id, transition.to_item_id)
            if boundary not in adjacency:
                raise ValueError("transition items must be adjacent on one track")
            if boundary in seen_boundaries:
                raise ValueError("timeline boundary has more than one transition")
            seen_boundaries.add(boundary)
            if item_track[boundary[0]] != item_track[boundary[1]]:
                raise ValueError("transition items must share one track")
            if not transition.in_offset.same_rate(output_rate):
                raise ValueError("transition must use the output timebase")
            left = items[boundary[0]]
            right = items[boundary[1]]
            if not isinstance(left, TimelineClip) or not isinstance(right, TimelineClip):
                raise ValueError("transitions currently require two clips")
            if transition.out_offset.value > left.timeline_duration.value:
                raise ValueError("transition out offset exceeds the left clip")
            if transition.in_offset.value > right.timeline_duration.value:
                raise ValueError("transition in offset exceeds the right clip")
            outgoing[left.id] = transition.out_offset.value
            incoming[right.id] = transition.in_offset.value

        for item_id, item in items.items():
            if not isinstance(item, TimelineClip):
                continue
            if incoming.get(item_id, 0) + outgoing.get(item_id, 0) > item.timeline_duration.value:
                raise ValueError("transitions overlap inside a clip")
        return self

    def total_duration(self) -> RationalTime:
        frames = max(
            (
                track.duration_frames(self.output)
                for track in self.tracks
                if track.enabled
            ),
            default=0,
        )
        return self.output.time(frames)
