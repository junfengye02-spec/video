from pathlib import Path

import pytest

from server.app.rendering.compiler import RenderPlanCompileError, compile_render_plan


def _project(tmp_path: Path):
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
        "cuts": [
            {
                "id": "cut-s1",
                "source": "s1-video",
                "source_in_seconds": 1,
                "source_out_seconds": 5,
                "timeline_start_seconds": 0,
                "timeline_duration_seconds": 4,
                "duration_policy": "explicit_trim",
                "transition_out": "dissolve",
                "transition_duration": 0.2,
            },
            {
                "id": "cut-s2",
                "source": "s2-video",
                "source_in_seconds": 2,
                "source_out_seconds": 8,
                "timeline_start_seconds": 4,
                "timeline_duration_seconds": 6,
                "duration_policy": "explicit_trim",
            },
        ],
    }
    return storyboard, manifest, edits


def _probe(_path):
    return {
        "duration_seconds": 10,
        "has_audio": True,
        "video_width": 720,
        "video_height": 1280,
    }


def test_compile_render_plan_separates_source_and_timeline_ranges(tmp_path):
    storyboard, manifest, edits = _project(tmp_path)

    plan = compile_render_plan(
        project_id="p1",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest=manifest,
        edit_decisions=edits,
        output={"width": 720, "height": 1280, "fps": 30},
        media_probe=_probe,
    )

    assert plan.total_duration_seconds == 10
    assert [clip.timeline_start_seconds for clip in plan.clips] == [0, 4]
    assert [clip.timeline_duration_seconds for clip in plan.clips] == [4, 6]
    assert [(clip.source_in_seconds, clip.source_out_seconds) for clip in plan.clips] == [
        (1, 5),
        (2, 8),
    ]
    assert plan.clips[0].transition_out.type == "dissolve"
    assert plan.clips[0].transition_out.duration_seconds == 0.2
    assert plan.clips[0].source_has_audio is True
    assert (plan.clips[0].source_width, plan.clips[0].source_height) == (720, 1280)


def test_compile_render_plan_preserves_source_audio_by_default(tmp_path):
    storyboard, manifest, edits = _project(tmp_path)

    plan = compile_render_plan(
        project_id="p1",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest=manifest,
        edit_decisions=edits,
        output={"width": 1920, "height": 1080},
        media_probe=_probe,
    )

    assert plan.audio.source_audio_default == "preserve"
    assert [clip.source_audio.policy for clip in plan.clips] == [
        "preserve",
        "preserve",
    ]


def test_compile_render_plan_supports_per_clip_audio_policy(tmp_path):
    storyboard, manifest, edits = _project(tmp_path)
    edits["audio"] = {
        "source": {"default_policy": "mix", "default_volume": 0.9}
    }
    edits["cuts"][1]["source_audio"] = {"policy": "replace", "volume": 0}

    plan = compile_render_plan(
        project_id="p1",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest=manifest,
        edit_decisions=edits,
        output={"width": 720, "height": 1280},
        media_probe=_probe,
    )

    assert plan.clips[0].source_audio.policy == "mix"
    assert plan.clips[0].source_audio.volume == 0.9
    assert plan.clips[1].source_audio.policy == "replace"
    assert plan.clips[1].source_audio.volume == 0


def test_compile_render_plan_resolves_timed_audio_assets(tmp_path):
    storyboard, manifest, edits = _project(tmp_path)
    audio_path = tmp_path / "assets" / "audio" / "voice.wav"
    audio_path.parent.mkdir(parents=True)
    audio_path.write_bytes(b"audio")
    manifest["assets"].append(
        {"id": "voice-1", "path": "assets/audio/voice.wav"}
    )
    edits["audio"] = {
        "source": {"default_policy": "mix"},
        "narration": {
            "segments": [
                {
                    "asset_id": "voice-1",
                    "start_seconds": 1.5,
                    "end_seconds": 3.5,
                    "volume": 0.8,
                }
            ]
        },
    }

    plan = compile_render_plan(
        project_id="p1",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest=manifest,
        edit_decisions=edits,
        output={"width": 720, "height": 1280, "fps": 30},
        media_probe=_probe,
    )

    assert plan.audio.source_audio_default == "mix"
    assert plan.audio.narration[0].source_path == str(audio_path.resolve())
    assert plan.audio.narration[0].timeline_start_seconds == 1.5


def test_compile_render_plan_rejects_source_range_beyond_media(tmp_path):
    storyboard, manifest, edits = _project(tmp_path)
    edits["cuts"][1]["source_out_seconds"] = 12

    with pytest.raises(RenderPlanCompileError, match="exceeds available media"):
        compile_render_plan(
            project_id="p1",
            project_dir=tmp_path,
            storyboard=storyboard,
            asset_manifest=manifest,
            edit_decisions=edits,
            output={"width": 720, "height": 1280},
            media_probe=_probe,
        )


def test_compile_render_plan_does_not_treat_legacy_ranges_as_explicit_edits(tmp_path):
    storyboard, manifest, edits = _project(tmp_path)
    for cut in edits["cuts"]:
        cut["in_seconds"] = cut.pop("source_in_seconds")
        cut["out_seconds"] = cut.pop("source_out_seconds")
        cut.pop("timeline_start_seconds")
        cut.pop("timeline_duration_seconds")
        cut.pop("duration_policy")

    plan = compile_render_plan(
        project_id="p1",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest=manifest,
        edit_decisions=edits,
        output={"width": 720, "height": 1280},
        media_probe=_probe,
    )

    assert [(clip.source_in_seconds, clip.source_out_seconds) for clip in plan.clips] == [
        (0, 10),
        (0, 10),
    ]
    assert [clip.timeline_start_seconds for clip in plan.clips] == [0, 10]
    assert [clip.timeline_duration_seconds for clip in plan.clips] == [10, 10]


def test_compile_render_plan_allows_only_explicit_retime_to_change_speed(tmp_path):
    storyboard, manifest, edits = _project(tmp_path)
    edits["cuts"][0].update(
        {
            "duration_policy": "explicit_retime",
            "source_in_seconds": 0,
            "source_out_seconds": 10,
            "timeline_duration_seconds": 5,
        }
    )
    edits["cuts"][1]["timeline_start_seconds"] = 5

    plan = compile_render_plan(
        project_id="p1",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest=manifest,
        edit_decisions=edits,
        output={"width": 720, "height": 1280},
        media_probe=_probe,
    )

    assert plan.clips[0].duration_policy == "explicit_retime"
    assert plan.clips[0].playback_rate == 2
