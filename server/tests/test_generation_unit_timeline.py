from __future__ import annotations

from server.app.rendering import compile_legacy_edit_timeline, compile_render_plan


def _unit_inputs(tmp_path):
    shots = [
        {"id": f"s{index}", "index": index, "beat_id": f"b{index}"}
        for index in range(1, 7)
    ]
    assets = []
    for index in range(3):
        unit_id = f"unit-{index + 1}"
        path = tmp_path / "assets" / "video" / "units" / unit_id / "v1.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"unit-{index + 1}".encode())
        source_shot_ids = [f"s{index * 2 + 1}", f"s{index * 2 + 2}"]
        source_beat_ids = [f"b{index * 2 + 1}", f"b{index * 2 + 2}"]
        assets.append(
            {
                "id": f"asset-{unit_id}",
                "type": "video",
                "path": path.relative_to(tmp_path).as_posix(),
                "source_tool": "newapi",
                "scene_id": unit_id,
                "metadata": {
                    "generation_unit_id": unit_id,
                    "revision": 1,
                    "source_shot_ids": source_shot_ids,
                    "source_beat_ids": source_beat_ids,
                    "source_segment_ids": [
                        f"segment-{index * 2 + 1}",
                        f"segment-{index * 2 + 2}",
                    ],
                    "segment_sequences": [index * 2 + 1, index * 2 + 2],
                    "active": True,
                    "status": "complete",
                },
            }
        )
    return (
        {"shots": shots},
        {
            "version": "1.0",
            "assets": assets,
            "metadata": {"generation_units_v2": True},
        },
        {"version": "1.0", "cuts": [], "render_runtime": "ffmpeg"},
    )


def _probe(_path):
    return {
        "duration_seconds": 10.0,
        "has_audio": True,
        "video_width": 720,
        "video_height": 1280,
        "fps": 30,
        "video_codec": "h264",
        "audio_codec": "aac",
    }


def test_generation_unit_timeline_deduplicates_multi_shot_media(tmp_path):
    storyboard, manifest, edit_decisions = _unit_inputs(tmp_path)
    output = {
        "width": 720,
        "height": 1280,
        "fps": 30,
        "format": "mp4",
        "video_codec": "h264",
        "audio_codec": "aac",
    }

    plan = compile_render_plan(
        project_id="project-unit-timeline",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest=manifest,
        edit_decisions=edit_decisions,
        output=output,
        media_probe=_probe,
    )
    timeline = compile_legacy_edit_timeline(
        project_id="project-unit-timeline",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest=manifest,
        edit_decisions=edit_decisions,
        output=output,
        media_probe=_probe,
    )

    assert len(plan.clips) == 3
    assert plan.total_duration_seconds == 30
    assert [clip.generation_unit_id for clip in plan.clips] == [
        "unit-1",
        "unit-2",
        "unit-3",
    ]
    assert all(clip.timeline_duration_seconds == 10 for clip in plan.clips)
    assert all(clip.source_in_seconds == 0 for clip in plan.clips)
    assert all(clip.source_out_seconds == 10 for clip in plan.clips)
    assert all(clip.playback_rate == 1 for clip in plan.clips)
    primary = next(track for track in timeline.tracks if track.role == "primary")
    assert len(primary.items) == 3
    assert timeline.metadata["source"] == "generation-unit-ledger"
    assert [item.metadata["source_shot_ids"] for item in primary.items] == [
        ["s1", "s2"],
        ["s3", "s4"],
        ["s5", "s6"],
    ]


def test_generation_unit_timeline_never_falls_back_to_duplicate_shot_outputs(tmp_path):
    storyboard, manifest, edit_decisions = _unit_inputs(tmp_path)
    storyboard["shots"][0]["output_path"] = manifest["assets"][0]["path"]
    manifest["assets"][2]["metadata"]["active"] = False

    try:
        compile_render_plan(
            project_id="project-unit-timeline",
            project_dir=tmp_path,
            storyboard=storyboard,
            asset_manifest=manifest,
            edit_decisions=edit_decisions,
            output={"width": 720, "height": 1280},
            media_probe=_probe,
        )
    except RuntimeError as exc:
        assert "do not cover storyboard shot s5" in str(exc)
    else:
        raise AssertionError("v2 unit timeline unexpectedly fell back to shot media")


def test_one_beat_two_segment_units_are_both_rendered_in_segment_order(tmp_path):
    storyboard = {"shots": [{"id": "s1", "index": 1, "beat_id": "beat-long"}]}
    assets = []
    for sequence in (2, 1):
        unit_id = f"unit-{sequence}"
        path = tmp_path / "assets" / "video" / "units" / unit_id / "v1.mp4"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(unit_id.encode())
        assets.append(
            {
                "id": f"asset-{unit_id}",
                "type": "video",
                "path": path.relative_to(tmp_path).as_posix(),
                "source_tool": "newapi",
                "scene_id": unit_id,
                "metadata": {
                    "generation_unit_id": unit_id,
                    "revision": 1,
                    "source_shot_ids": ["s1"],
                    "source_beat_ids": ["beat-long"],
                    "source_segment_ids": [f"segment-{sequence}"],
                    "segment_sequences": [sequence],
                    "active": True,
                    "status": "complete",
                },
            }
        )

    plan = compile_render_plan(
        project_id="project-long-beat",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest={
            "version": "1.0",
            "assets": assets,
            "metadata": {"generation_units_v2": True},
        },
        edit_decisions={"version": "1.0", "cuts": [], "render_runtime": "ffmpeg"},
        output={"width": 720, "height": 1280, "fps": 30},
        media_probe=lambda _path: {**_probe(_path), "duration_seconds": 5.0},
    )

    assert [clip.generation_unit_id for clip in plan.clips] == ["unit-1", "unit-2"]
    assert [clip.timeline_duration_seconds for clip in plan.clips] == [5, 5]
    assert plan.total_duration_seconds == 10


def test_underfilled_unit_uses_full_probed_source_duration_without_trim_or_speed(
    tmp_path,
):
    storyboard = {"shots": [{"id": "s1", "index": 1, "beat_id": "b1"}]}
    path = tmp_path / "assets" / "video" / "units" / "unit-1" / "v1.mp4"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"probe-me")
    manifest = {
        "version": "1.0",
        "assets": [
            {
                "id": "asset-unit-1",
                "type": "video",
                "path": path.relative_to(tmp_path).as_posix(),
                "metadata": {
                    "generation_unit_id": "unit-1",
                    "revision": 1,
                    "source_shot_ids": ["s1"],
                    "source_beat_ids": ["b1"],
                    "source_segment_ids": ["segment-1"],
                    "segment_sequences": [1],
                    "active": True,
                    "status": "complete",
                },
            }
        ],
        "metadata": {"generation_units_v2": True},
    }

    plan = compile_render_plan(
        project_id="project-probed-duration",
        project_dir=tmp_path,
        storyboard=storyboard,
        asset_manifest=manifest,
        edit_decisions={"version": "1.0", "cuts": [], "render_runtime": "ffmpeg"},
        output={"width": 720, "height": 1280, "fps": 30},
        media_probe=lambda _path: {**_probe(_path), "duration_seconds": 10.005},
    )

    assert plan.total_duration_seconds == 10.005
    assert plan.clips[0].source_duration_seconds == 10.005
    assert plan.clips[0].timeline_duration_seconds == 10.005
    assert plan.clips[0].source_in_seconds == 0
    assert plan.clips[0].source_out_seconds == 10.005
    assert plan.clips[0].playback_rate == 1
