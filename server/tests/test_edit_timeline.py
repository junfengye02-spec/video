from pathlib import Path

import pytest

from schemas.artifacts import validate_artifact

from server.app.rendering.compiler import RenderPlanCompileError
from server.app.rendering.timeline_compiler import (
    compile_legacy_edit_timeline,
    compile_render_plan_from_timeline,
)
from server.app.rendering.timeline_models import (
    EditTimeline,
    RationalTime,
    RationalTimeRange,
    TimelineClip,
    TimelineMediaReference,
    TimelineOutputSpec,
    TimelineTrack,
    TimelineTransition,
)


def _legacy_project(tmp_path: Path):
    video_dir = tmp_path / "assets" / "video"
    video_dir.mkdir(parents=True)
    for shot_id in ("s1", "s2"):
        (video_dir / f"{shot_id}.mp4").write_bytes(b"video")
    storyboard = {
        "shots": [
            {"id": "s1", "index": 1, "duration_seconds": 4},
            {"id": "s2", "index": 2, "duration_seconds": 6},
        ]
    }
    manifest = {
        "assets": [
            {"id": "s1-video", "path": "assets/video/s1.mp4"},
            {"id": "s2-video", "path": "assets/video/s2.mp4"},
        ]
    }
    edits = {
        "render_runtime": "remotion",
        "renderer_family": "cinematic-trailer",
        "audio": {"source": {"default_policy": "preserve"}},
        "cuts": [
            {
                "id": "cut-s1",
                "source": "s1-video",
                "duration_policy": "explicit_trim",
                "source_in_seconds": 1,
                "source_out_seconds": 5,
                "timeline_start_seconds": 0,
                "timeline_duration_seconds": 4,
                "transition_out": "dissolve",
                "transition_duration": 0.2,
            },
            {
                "id": "cut-s2",
                "source": "s2-video",
                "duration_policy": "explicit_trim",
                "source_in_seconds": 2,
                "source_out_seconds": 8,
                "timeline_start_seconds": 4,
                "timeline_duration_seconds": 6,
                "transition_in": "dissolve",
                "transition_duration": 0.2,
            },
        ],
    }
    return storyboard, manifest, edits


def _probe(_path):
    return {
        "duration_seconds": 10,
        "fps": 24,
        "has_audio": True,
        "video_width": 720,
        "video_height": 1280,
        "video_codec": "h264",
        "audio_codec": "aac",
    }


def test_legacy_compiler_creates_frame_exact_timeline_and_boundary_transition(tmp_path):
    storyboard, manifest, edits = _legacy_project(tmp_path)

    timeline = compile_legacy_edit_timeline(
        project_id="p1",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest=manifest,
        edit_decisions=edits,
        output={"width": 720, "height": 1280, "fps": 30},
        media_probe=_probe,
    )

    assert timeline.version == "2.0"
    assert timeline.total_duration().value == 300
    assert timeline.total_duration().seconds() == 10
    assert [item.id for item in timeline.tracks[0].items] == ["cut-s1", "cut-s2"]
    assert len(timeline.transitions) == 1
    transition = timeline.transitions[0]
    assert transition.from_item_id == "cut-s1"
    assert transition.to_item_id == "cut-s2"
    assert transition.in_offset.value + transition.out_offset.value == 6
    validate_artifact("edit_timeline", timeline.model_dump(mode="json"))


def test_timeline_compiles_back_to_render_plan_with_handles(tmp_path, monkeypatch):
    storyboard, manifest, edits = _legacy_project(tmp_path)
    timeline = compile_legacy_edit_timeline(
        project_id="p1",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest=manifest,
        edit_decisions=edits,
        output={"width": 720, "height": 1280, "fps": 30},
        media_probe=_probe,
    )
    monkeypatch.setattr(
        "server.app.rendering.timeline_compiler.probe_media",
        _probe,
    )

    plan = compile_render_plan_from_timeline(
        timeline=timeline,
        project_dir=tmp_path,
    )

    assert plan.total_duration_seconds == 10
    assert plan.clips[0].source_handle_after_seconds == pytest.approx(0.1)
    assert plan.clips[1].source_handle_before_seconds == pytest.approx(0.1)
    assert plan.clips[1].transition_in.duration_seconds == pytest.approx(0.2)
    assert plan.audio.source_audio_default == "preserve"


def test_legacy_compiler_uses_available_trailing_handle_when_source_starts_at_zero(tmp_path):
    storyboard, manifest, edits = _legacy_project(tmp_path)
    edits["cuts"][0]["source_in_seconds"] = 0
    edits["cuts"][0]["source_out_seconds"] = 4
    edits["cuts"][1]["source_in_seconds"] = 0
    edits["cuts"][1]["source_out_seconds"] = 6

    timeline = compile_legacy_edit_timeline(
        project_id="p1",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest=manifest,
        edit_decisions=edits,
        output={"width": 720, "height": 1280, "fps": 30},
        media_probe=_probe,
    )

    transition = timeline.transitions[0]
    assert transition.in_offset.value == 0
    assert transition.out_offset.value == 6


def test_timeline_rejects_non_adjacent_transition():
    output = TimelineOutputSpec(width=720, height=1280)
    source_rate = RationalTime(value=0, rate_numerator=30)
    reference = TimelineMediaReference(
        id="media-1",
        path="assets/video/a.mp4",
        kind="video",
        available_range=RationalTimeRange(
            start=source_rate,
            duration=source_rate.model_copy(update={"value": 300}),
        ),
    )
    clips = [
        TimelineClip(
            id=f"c{index}",
            media_reference_id="media-1",
            source_range=RationalTimeRange(
                start=source_rate,
                duration=source_rate.model_copy(update={"value": 30}),
            ),
            timeline_duration=output.time(30),
        )
        for index in range(3)
    ]

    with pytest.raises(ValueError, match="adjacent"):
        EditTimeline(
            project_id="p1",
            revision="r1",
            output=output,
            media_references=[reference],
            tracks=[TimelineTrack(id="v1", kind="video", role="primary", items=clips)],
            transitions=[
                TimelineTransition(
                    id="t1",
                    from_item_id="c0",
                    to_item_id="c2",
                    type="dissolve",
                    in_offset=output.time(3),
                    out_offset=output.time(3),
                )
            ],
            render_runtime="remotion",
        )


def test_legacy_compiler_rejects_transition_without_handles(tmp_path):
    storyboard, manifest, edits = _legacy_project(tmp_path)
    edits["cuts"][0]["duration_policy"] = "explicit_retime"
    edits["cuts"][0]["source_in_seconds"] = 0
    edits["cuts"][0]["source_out_seconds"] = 10
    edits["cuts"][1]["duration_policy"] = "explicit_retime"
    edits["cuts"][1]["source_in_seconds"] = 0
    edits["cuts"][1]["source_out_seconds"] = 10

    with pytest.raises(RenderPlanCompileError, match="handle frames"):
        compile_legacy_edit_timeline(
            project_id="p1",
            project_dir=tmp_path,
            storyboard=storyboard,
            asset_manifest=manifest,
            edit_decisions=edits,
            output={"width": 720, "height": 1280, "fps": 30},
            media_probe=_probe,
        )


def test_audio_stems_become_authoritative_timeline_tracks_and_round_trip(
    tmp_path, monkeypatch
):
    storyboard, manifest, edits = _legacy_project(tmp_path)
    audio_dir = tmp_path / "assets" / "audio"
    audio_dir.mkdir(parents=True)
    for asset_id in ("dialogue", "narration", "music", "sfx", "ambience"):
        path = audio_dir / f"{asset_id}.wav"
        path.write_bytes(b"audio")
        manifest["assets"].append(
            {"id": asset_id, "path": f"assets/audio/{asset_id}.wav"}
        )
    edits["audio"] = {
        "source": {"default_policy": "preserve"},
        "dialogue": {
            "segments": [{"asset_id": "dialogue", "start_seconds": 0, "end_seconds": 2}]
        },
        "narration": {
            "segments": [{"asset_id": "narration", "start_seconds": 2, "end_seconds": 4}]
        },
        "music": {"asset_id": "music", "volume": 0.2, "ducking": True},
        "sfx": [{"asset_id": "sfx", "start_seconds": 4, "end_seconds": 5}],
        "ambience": [
            {"asset_id": "ambience", "start_seconds": 0, "end_seconds": 10}
        ],
    }

    timeline = compile_legacy_edit_timeline(
        project_id="p1",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest=manifest,
        edit_decisions=edits,
        output={"width": 720, "height": 1280, "fps": 30},
        media_probe=_probe,
    )

    audio_roles = {
        track.role for track in timeline.tracks if track.kind == "audio"
    }
    assert audio_roles == {"dialogue", "narration", "music", "sfx", "ambience"}
    assert sum(reference.kind == "audio" for reference in timeline.media_references) == 5
    validate_artifact("edit_timeline", timeline.model_dump(mode="json"))

    monkeypatch.setattr("server.app.rendering.timeline_compiler.probe_media", _probe)
    plan = compile_render_plan_from_timeline(timeline=timeline, project_dir=tmp_path)

    assert len(plan.audio.dialogue) == 1
    assert len(plan.audio.narration) == 1
    assert len(plan.audio.sfx) == 1
    assert len(plan.audio.ambience) == 1
    assert plan.audio.music is not None
    assert plan.audio.music.ducking is True
