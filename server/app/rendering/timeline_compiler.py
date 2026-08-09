from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from server.app.rendering.compiler import (
    MediaProbe,
    RenderPlanCompileError,
    compile_render_plan,
)
from server.app.rendering.models import (
    RenderAudioPlan,
    RenderClip,
    RenderMusicTrack,
    RenderOutputSpec,
    RenderPlan,
    RenderSourceAudio,
    RenderTimedAudioTrack,
    RenderTransition,
)
from server.app.rendering.probe import probe_media
from server.app.rendering.timeline_models import (
    EditTimeline,
    RationalTime,
    RationalTimeRange,
    TimelineClip,
    TimelineGap,
    TimelineMediaReference,
    TimelineOutputSpec,
    TimelineTrack,
    TimelineTransition,
)


def compile_legacy_edit_timeline(
    *,
    project_id: str,
    project_dir: str | Path,
    storyboard: dict[str, Any],
    asset_manifest: dict[str, Any],
    edit_decisions: dict[str, Any],
    output: RenderOutputSpec | dict[str, Any],
    media_probe: MediaProbe = probe_media,
) -> EditTimeline:
    cached_probe: dict[tuple[str, bool], dict[str, Any]] = {}

    def probe(path: str | Path, *, require_video: bool = True) -> dict[str, Any]:
        key = (str(Path(path).resolve()), require_video)
        if key not in cached_probe:
            if media_probe is probe_media:
                cached_probe[key] = probe_media(path, require_video=require_video)
            else:
                cached_probe[key] = media_probe(path)
        return cached_probe[key]

    plan = compile_render_plan(
        project_id=project_id,
        project_dir=project_dir,
        storyboard=storyboard,
        asset_manifest=asset_manifest,
        edit_decisions=edit_decisions,
        output=output,
        media_probe=probe,
    )
    timeline_output = _timeline_output(plan.output)
    output_rate = timeline_output.time(0)
    media_references: list[TimelineMediaReference] = []
    items: list[TimelineClip | TimelineGap] = []
    cursor_frames = 0

    for clip in plan.clips:
        start_frames = _frames(clip.timeline_start_seconds, output_rate)
        if start_frames < cursor_frames:
            raise RenderPlanCompileError(
                "legacy primary cuts overlap; use separate v2 tracks"
            )
        if start_frames > cursor_frames:
            items.append(
                TimelineGap(
                    id=f"gap-before-{clip.id}",
                    duration=timeline_output.time(start_frames - cursor_frames),
                )
            )

        media = probe(clip.source_path)
        source_fps = float(media.get("fps") or plan.output.fps)
        source_rate = RationalTime.from_fps(0, source_fps)
        reference_id = f"media-{clip.id}"
        available_duration = _frames(clip.source_duration_seconds, source_rate)
        media_references.append(
            TimelineMediaReference(
                id=reference_id,
                path=clip.source_path,
                kind="video",
                available_range=RationalTimeRange(
                    start=source_rate.model_copy(update={"value": 0}),
                    duration=source_rate.model_copy(
                        update={"value": available_duration}
                    ),
                ),
                has_audio=clip.source_has_audio,
                probe_hash=_probe_hash(media),
                metadata={
                    "width": media.get("video_width"),
                    "height": media.get("video_height"),
                    "video_codec": media.get("video_codec"),
                    "audio_codec": media.get("audio_codec"),
                    "generation_unit_id": clip.generation_unit_id,
                    "generation_unit_revision": clip.generation_unit_revision,
                    "source_shot_ids": clip.source_shot_ids,
                    "source_beat_ids": clip.source_beat_ids,
                    "source_segment_ids": clip.source_segment_ids,
                },
            )
        )
        duration_frames = _frames(clip.timeline_duration_seconds, output_rate)
        source_start_frames = _frames(clip.source_in_seconds, source_rate)
        source_duration_frames = _frames(
            clip.source_out_seconds - clip.source_in_seconds,
            source_rate,
        )
        timeline_clip = TimelineClip(
            id=clip.id,
            media_reference_id=reference_id,
            source_range=RationalTimeRange(
                start=source_rate.model_copy(update={"value": source_start_frames}),
                duration=source_rate.model_copy(
                    update={"value": source_duration_frames}
                ),
            ),
            timeline_duration=timeline_output.time(duration_frames),
            source_audio=clip.source_audio,
            metadata={
                "shot_id": clip.shot_id,
                "generation_unit_id": clip.generation_unit_id,
                "generation_unit_revision": clip.generation_unit_revision,
                "source_shot_ids": clip.source_shot_ids,
                "source_beat_ids": clip.source_beat_ids,
                "source_segment_ids": clip.source_segment_ids,
            },
        )
        items.append(timeline_clip)
        cursor_frames = start_frames + duration_frames

    transitions: list[TimelineTransition] = []
    plan_clips = plan.clips
    for index in range(1, len(plan_clips)):
        previous = plan_clips[index - 1]
        current = plan_clips[index]
        transition = current.transition_in
        if transition.type == "cut":
            transition = previous.transition_out
        if transition.type == "cut" or transition.duration_seconds <= 0:
            continue
        total_frames = max(1, _frames(transition.duration_seconds, output_rate))
        in_offset, out_offset = _allocate_transition_handles(
            total_frames=total_frames,
            output=timeline_output,
            previous=previous,
            current=current,
        )
        transitions.append(
            TimelineTransition(
                id=f"transition-{previous.id}-{current.id}",
                from_item_id=previous.id,
                to_item_id=current.id,
                type=transition.type,
                in_offset=timeline_output.time(in_offset),
                out_offset=timeline_output.time(out_offset),
            )
        )

    tracks = [
        TimelineTrack(
            id="video-primary",
            kind="video",
            role="primary",
            items=items,
        )
    ]
    audio_references, audio_tracks = _audio_tracks_from_plan(
        plan=plan,
        output=timeline_output,
        probe=probe,
    )
    media_references.extend(audio_references)
    tracks.extend(audio_tracks)

    return EditTimeline(
        project_id=project_id,
        revision=plan.storyboard_revision,
        output=timeline_output,
        media_references=media_references,
        tracks=tracks,
        transitions=transitions,
        render_runtime=plan.render_runtime,
        renderer_family=plan.renderer_family,
        metadata={
            "source": (
                "generation-unit-ledger"
                if any(clip.generation_unit_id for clip in plan.clips)
                else "legacy-edit-decisions"
            ),
            "audio_plan": plan.audio.model_dump(mode="json"),
        },
    )


def compile_render_plan_from_timeline(
    *,
    timeline: EditTimeline,
    project_dir: str | Path,
) -> RenderPlan:
    project_path = Path(project_dir).resolve()
    references = {reference.id: reference for reference in timeline.media_references}
    primary_tracks = [
        track
        for track in timeline.tracks
        if track.enabled and track.kind == "video" and track.role == "primary"
    ]
    if len(primary_tracks) != 1:
        raise RenderPlanCompileError("render plan requires one primary video track")
    primary = primary_tracks[0]
    transitions_by_boundary = {
        (transition.from_item_id, transition.to_item_id): transition
        for transition in timeline.transitions
    }
    incoming = {
        transition.to_item_id: transition for transition in timeline.transitions
    }
    outgoing = {
        transition.from_item_id: transition for transition in timeline.transitions
    }

    clips: list[RenderClip] = []
    cursor_frames = 0
    previous_clip_id: str | None = None
    for item in primary.items:
        if isinstance(item, TimelineGap):
            cursor_frames += item.duration.value
            previous_clip_id = None
            continue
        reference = references[item.media_reference_id]
        source = _resolve_project_path(project_path, reference.path)
        media = probe_media(source)
        source_in = item.source_range.start.seconds()
        source_out = source_in + item.source_range.duration.seconds()
        transition_in = incoming.get(item.id)
        transition_out = outgoing.get(item.id)
        handle_before = transition_in.in_offset.seconds() if transition_in else 0.0
        handle_after = transition_out.out_offset.seconds() if transition_out else 0.0
        if source_in + 0.001 < handle_before:
            raise RenderPlanCompileError(
                f"clip {item.id} has insufficient leading transition handle"
            )
        if source_out + handle_after > float(media["duration_seconds"]) + 0.001:
            raise RenderPlanCompileError(
                f"clip {item.id} has insufficient trailing transition handle"
            )
        transition_in_model = _render_transition(transition_in)
        transition_out_model = _render_transition(transition_out)
        if previous_clip_id is not None:
            boundary = transitions_by_boundary.get((previous_clip_id, item.id))
            if boundary is not None:
                transition_in_model = _render_transition(boundary)
        clips.append(
            RenderClip(
                id=item.id,
                shot_id=str(item.metadata.get("shot_id") or item.id),
                generation_unit_id=item.metadata.get("generation_unit_id"),
                generation_unit_revision=item.metadata.get("generation_unit_revision"),
                source_shot_ids=[
                    str(value) for value in item.metadata.get("source_shot_ids") or []
                ],
                source_beat_ids=[
                    str(value) for value in item.metadata.get("source_beat_ids") or []
                ],
                source_segment_ids=[
                    str(value)
                    for value in item.metadata.get("source_segment_ids") or []
                ],
                source_path=str(source),
                source_duration_seconds=float(media["duration_seconds"]),
                source_has_audio=bool(media.get("has_audio")),
                source_width=int(media.get("video_width") or 0),
                source_height=int(media.get("video_height") or 0),
                source_in_seconds=source_in,
                source_out_seconds=source_out,
                source_handle_before_seconds=handle_before,
                source_handle_after_seconds=handle_after,
                timeline_start_seconds=timeline.output.time(cursor_frames).seconds(),
                timeline_duration_seconds=item.timeline_duration.seconds(),
                transition_in=transition_in_model,
                transition_out=transition_out_model,
                source_audio=item.source_audio,
            )
        )
        cursor_frames += item.timeline_duration.value
        previous_clip_id = item.id

    total_duration = timeline.output.time(cursor_frames).seconds()
    audio_plan = _audio_plan_from_timeline(
        timeline=timeline,
        references=references,
        project_path=project_path,
        total_duration=total_duration,
    )
    return RenderPlan(
        project_id=timeline.project_id,
        storyboard_revision=timeline.revision,
        total_duration_seconds=total_duration,
        output=RenderOutputSpec(
            width=timeline.output.width,
            height=timeline.output.height,
            fps=timeline.output.fps,
            format=timeline.output.format,
            video_codec=timeline.output.video_codec,
            audio_codec=timeline.output.audio_codec,
        ),
        clips=clips,
        audio=audio_plan,
        renderer_family=timeline.renderer_family,
        render_runtime=timeline.render_runtime,
    )


def _audio_tracks_from_plan(
    *,
    plan: RenderPlan,
    output: TimelineOutputSpec,
    probe,
) -> tuple[list[TimelineMediaReference], list[TimelineTrack]]:
    references: list[TimelineMediaReference] = []
    tracks: list[TimelineTrack] = []
    entries = (
        ("dialogue", plan.audio.dialogue),
        ("narration", plan.audio.narration),
        ("sfx", plan.audio.sfx),
        ("ambience", plan.audio.ambience),
    )
    for role, role_tracks in entries:
        for index, timed in enumerate(role_tracks):
            reference, track = _timed_audio_timeline_track(
                role=role,
                index=index,
                timed=timed,
                total_duration=plan.total_duration_seconds,
                output=output,
                probe=probe,
            )
            if reference is not None and track is not None:
                references.append(reference)
                tracks.append(track)

    if plan.audio.music is not None:
        music = plan.audio.music
        media = probe(music.source_path, require_video=False)
        available = float(media["duration_seconds"]) - music.source_in_seconds
        if available <= 0:
            raise RenderPlanCompileError("music source starts beyond available media")
        reference_id = "audio-music-media"
        source_frames = max(1, _frames(available, output.time(0)))
        references.append(
            TimelineMediaReference(
                id=reference_id,
                path=music.source_path,
                kind="audio",
                available_range=RationalTimeRange(
                    start=output.time(0),
                    duration=output.time(source_frames),
                ),
                has_audio=True,
                probe_hash=_probe_hash(media),
                metadata={"audio_codec": media.get("audio_codec")},
            )
        )
        tracks.append(
            TimelineTrack(
                id="audio-music",
                kind="audio",
                role="music",
                items=[
                    TimelineClip(
                        id="audio-music-clip",
                        media_reference_id=reference_id,
                        source_range=RationalTimeRange(
                            start=output.time(
                                _frames(music.source_in_seconds, output.time(0))
                            ),
                            duration=output.time(source_frames),
                        ),
                        timeline_duration=output.time(
                            max(1, _frames(plan.total_duration_seconds, output.time(0)))
                        ),
                        source_audio=RenderSourceAudio(
                            policy="preserve",
                            volume=music.volume,
                        ),
                        metadata={"loop": True},
                    )
                ],
                metadata={
                    "fade_in_seconds": music.fade_in_seconds,
                    "fade_out_seconds": music.fade_out_seconds,
                    "ducking": music.ducking,
                },
            )
        )
    return references, tracks


def _timed_audio_timeline_track(
    *,
    role: str,
    index: int,
    timed: RenderTimedAudioTrack,
    total_duration: float,
    output: TimelineOutputSpec,
    probe,
) -> tuple[TimelineMediaReference | None, TimelineTrack | None]:
    if timed.timeline_start_seconds >= total_duration:
        return None, None
    media = probe(timed.source_path, require_video=False)
    available = float(media["duration_seconds"]) - timed.source_in_seconds
    requested = (
        timed.timeline_end_seconds - timed.timeline_start_seconds
        if timed.timeline_end_seconds is not None
        else available
    )
    duration = min(available, requested, total_duration - timed.timeline_start_seconds)
    if duration <= 0:
        raise RenderPlanCompileError(f"{role} source has no usable timeline duration")
    reference_id = f"audio-{role}-{index + 1}-media"
    reference = TimelineMediaReference(
        id=reference_id,
        path=timed.source_path,
        kind="audio",
        available_range=RationalTimeRange(
            start=output.time(0),
            duration=output.time(
                max(1, _frames(float(media["duration_seconds"]), output.time(0)))
            ),
        ),
        has_audio=True,
        probe_hash=_probe_hash(media),
        metadata={"audio_codec": media.get("audio_codec")},
    )
    start_frames = _frames(timed.timeline_start_seconds, output.time(0))
    items: list[TimelineClip | TimelineGap] = []
    if start_frames > 0:
        items.append(
            TimelineGap(
                id=f"gap-before-audio-{role}-{index + 1}",
                duration=output.time(start_frames),
            )
        )
    items.append(
        TimelineClip(
            id=f"audio-{role}-{index + 1}",
            media_reference_id=reference_id,
            source_range=RationalTimeRange(
                start=output.time(_frames(timed.source_in_seconds, output.time(0))),
                duration=output.time(max(1, _frames(duration, output.time(0)))),
            ),
            timeline_duration=output.time(max(1, _frames(duration, output.time(0)))),
            source_audio=RenderSourceAudio(policy="preserve", volume=timed.volume),
            metadata={"source_track_id": timed.id},
        )
    )
    return reference, TimelineTrack(
        id=f"audio-{role}-{index + 1}",
        kind="audio",
        role=role,
        items=items,
    )


def _audio_plan_from_timeline(
    *,
    timeline: EditTimeline,
    references: dict[str, TimelineMediaReference],
    project_path: Path,
    total_duration: float,
) -> RenderAudioPlan:
    base = RenderAudioPlan.model_validate(timeline.metadata.get("audio_plan") or {})
    audio_tracks = [
        track for track in timeline.tracks if track.enabled and track.kind == "audio"
    ]
    if not audio_tracks:
        return base

    stems: dict[str, list[RenderTimedAudioTrack]] = {
        "dialogue": [],
        "narration": [],
        "sfx": [],
        "ambience": [],
    }
    music: RenderMusicTrack | None = None
    for track in audio_tracks:
        cursor_frames = 0
        for item in track.items:
            if isinstance(item, TimelineGap):
                cursor_frames += item.duration.value
                continue
            reference = references[item.media_reference_id]
            source = _resolve_project_path(project_path, reference.path)
            start = timeline.output.time(cursor_frames).seconds()
            end = min(total_duration, start + item.timeline_duration.seconds())
            volume = min(2.0, track.volume * item.source_audio.volume)
            if track.role == "music" and music is None:
                music = RenderMusicTrack(
                    source_path=str(source),
                    volume=volume,
                    source_in_seconds=item.source_range.start.seconds(),
                    fade_in_seconds=float(track.metadata.get("fade_in_seconds", 0.3)),
                    fade_out_seconds=float(track.metadata.get("fade_out_seconds", 0.8)),
                    ducking=track.metadata.get("ducking", True),
                )
            elif track.role in stems and end > start:
                stems[track.role].append(
                    RenderTimedAudioTrack(
                        id=str(item.metadata.get("source_track_id") or item.id),
                        source_path=str(source),
                        timeline_start_seconds=start,
                        timeline_end_seconds=end,
                        source_in_seconds=item.source_range.start.seconds(),
                        volume=volume,
                    )
                )
            cursor_frames += item.timeline_duration.value

    return base.model_copy(
        update={
            "music": music,
            "dialogue": stems["dialogue"],
            "narration": stems["narration"],
            "sfx": stems["sfx"],
            "ambience": stems["ambience"],
        }
    )


def _timeline_output(output: RenderOutputSpec) -> TimelineOutputSpec:
    rate = RationalTime.from_fps(0, output.fps)
    return TimelineOutputSpec(
        width=output.width,
        height=output.height,
        frame_rate_numerator=rate.rate_numerator,
        frame_rate_denominator=rate.rate_denominator,
        format=output.format,
        video_codec=output.video_codec,
        audio_codec=output.audio_codec,
    )


def _allocate_transition_handles(
    *,
    total_frames: int,
    output: TimelineOutputSpec,
    previous: RenderClip,
    current: RenderClip,
) -> tuple[int, int]:
    incoming_available = _frames(current.source_in_seconds, output.time(0))
    outgoing_available = _frames(
        previous.source_duration_seconds - previous.source_out_seconds,
        output.time(0),
    )
    preferred_in = (total_frames + 1) // 2
    in_offset = min(preferred_in, incoming_available)
    out_offset = min(total_frames - in_offset, outgoing_available)
    remaining = total_frames - in_offset - out_offset
    if remaining > 0:
        extra_in = min(remaining, incoming_available - in_offset)
        in_offset += extra_in
        remaining -= extra_in
    if remaining > 0:
        extra_out = min(remaining, outgoing_available - out_offset)
        out_offset += extra_out
        remaining -= extra_out
    if remaining > 0:
        raise RenderPlanCompileError(
            f"transition {previous.id} -> {current.id} lacks {remaining} handle frames"
        )
    return in_offset, out_offset


def _render_transition(transition: TimelineTransition | None) -> RenderTransition:
    if transition is None:
        return RenderTransition()
    return RenderTransition(
        type=transition.type,
        duration_seconds=transition.in_offset.seconds()
        + transition.out_offset.seconds(),
    )


def _frames(seconds: float, rate: RationalTime) -> int:
    return max(0, round(seconds * rate.rate_numerator / rate.rate_denominator))


def _probe_hash(media: dict[str, Any]) -> str:
    value = json.dumps(media, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _resolve_project_path(project_path: Path, value: str) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = project_path / candidate
    resolved = candidate.resolve()
    if resolved != project_path and project_path not in resolved.parents:
        raise RenderPlanCompileError("media path escapes the project workspace")
    if not resolved.is_file():
        raise RenderPlanCompileError("media source is missing")
    return resolved
