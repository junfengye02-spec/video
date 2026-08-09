from server.app.rendering import ffmpeg
from server.app.rendering.models import RenderClip, RenderOutputSpec, RenderPlan, RenderTransition


def test_ffmpeg_runtime_preserves_transitions_when_xfade_is_unavailable(monkeypatch, tmp_path):
    source = tmp_path / "shot.mp4"
    source.write_bytes(b"placeholder")
    plan = RenderPlan(
        project_id="p1",
        storyboard_revision="r1",
        total_duration_seconds=2,
        output=RenderOutputSpec(width=1280, height=720),
        clips=[
            RenderClip(
                id="c1",
                shot_id="s1",
                source_path=str(source),
                source_duration_seconds=1,
                source_in_seconds=0,
                source_out_seconds=1,
                timeline_start_seconds=0,
                timeline_duration_seconds=1,
                transition_out=RenderTransition(type="dissolve", duration_seconds=0.2),
            ),
            RenderClip(
                id="c2",
                shot_id="s2",
                source_path=str(source),
                source_duration_seconds=1,
                source_in_seconds=0,
                source_out_seconds=1,
                timeline_start_seconds=1,
                timeline_duration_seconds=1,
                transition_in=RenderTransition(type="dissolve", duration_seconds=0.2),
            ),
        ],
        render_runtime="ffmpeg",
    )
    fallback = {"path": "remotion-output", "runtime": "remotion"}

    def remotion(_plan, _output):
        return fallback

    monkeypatch.setattr(ffmpeg, "render_remotion_visual", remotion)
    monkeypatch.setattr(ffmpeg, "_filter_available", lambda _ffmpeg, _name: False)

    result = ffmpeg.render_ffmpeg_visual(plan, tmp_path / "final.mp4")

    assert result == fallback


def test_ffmpeg_runtime_falls_back_when_bundled_filters_cannot_letterbox(
    monkeypatch, tmp_path
):
    source = tmp_path / "portrait.mp4"
    source.write_bytes(b"placeholder")
    plan = RenderPlan(
        project_id="p1",
        storyboard_revision="r1",
        total_duration_seconds=1,
        output=RenderOutputSpec(width=1920, height=1080),
        clips=[
            RenderClip(
                id="c1",
                shot_id="s1",
                source_path=str(source),
                source_duration_seconds=1,
                source_width=720,
                source_height=1280,
                source_in_seconds=0,
                source_out_seconds=1,
                timeline_start_seconds=0,
                timeline_duration_seconds=1,
            )
        ],
        render_runtime="ffmpeg",
    )
    fallback = {"path": "remotion-output", "runtime": "remotion"}
    monkeypatch.setattr(ffmpeg, "render_remotion_visual", lambda _plan, _output: fallback)
    monkeypatch.setattr(
        ffmpeg,
        "_filter_available",
        lambda _ffmpeg, name: name not in {"pad", "setsar"},
    )

    result = ffmpeg.render_ffmpeg_visual(plan, tmp_path / "final.mp4")

    assert result == fallback


def test_full_ffmpeg_filter_contains_mismatched_shot_without_stretching(tmp_path):
    source = tmp_path / "portrait.mp4"
    source.write_bytes(b"placeholder")
    clip = RenderClip(
        id="c1",
        shot_id="s1",
        source_path=str(source),
        source_duration_seconds=1,
        source_width=720,
        source_height=1280,
        source_in_seconds=0,
        source_out_seconds=1,
        timeline_start_seconds=0,
        timeline_duration_seconds=1,
    )
    plan = RenderPlan(
        project_id="p1",
        storyboard_revision="r1",
        total_duration_seconds=1,
        output=RenderOutputSpec(width=1920, height=1080),
        clips=[clip],
        render_runtime="ffmpeg",
    )

    filter_graph = ffmpeg._video_filter(0, clip, plan, "v0", bundled=False)

    assert "force_original_aspect_ratio=decrease" in filter_graph
    assert "pad=1920:1080" in filter_graph


def test_full_source_ffmpeg_input_is_not_trimmed_to_a_storyboard_duration(
    monkeypatch, tmp_path
):
    source = tmp_path / "shot.mp4"
    source.write_bytes(b"placeholder")
    clip = RenderClip(
        id="c1",
        shot_id="s1",
        source_path=str(source),
        source_duration_seconds=10,
        source_width=1280,
        source_height=720,
        source_in_seconds=0,
        source_out_seconds=10,
        timeline_start_seconds=0,
        timeline_duration_seconds=10,
    )
    plan = RenderPlan(
        project_id="p1",
        storyboard_revision="r1",
        total_duration_seconds=10,
        output=RenderOutputSpec(width=1280, height=720),
        clips=[clip],
        render_runtime="ffmpeg",
    )
    captured = {}
    monkeypatch.setattr(ffmpeg, "resolve_command_path", lambda _name: "ffmpeg")
    monkeypatch.setattr(ffmpeg, "_filter_available", lambda _path, _name: True)
    monkeypatch.setattr(ffmpeg, "_run", lambda command: captured.setdefault("command", command))

    ffmpeg.render_ffmpeg_visual(plan, tmp_path / "final.mp4")

    command = captured["command"]
    assert command[:5] == ["ffmpeg", "-y", "-ss", "0.000000", "-i"]
    assert command.count("-t") == 1  # final timeline cap only; no per-input trim


def test_compact_bundled_filter_omits_filters_that_are_not_installed(tmp_path):
    source = tmp_path / "shot.mp4"
    source.write_bytes(b"placeholder")
    clip = RenderClip(
        id="c1",
        shot_id="s1",
        source_path=str(source),
        source_duration_seconds=10,
        source_width=1280,
        source_height=720,
        source_in_seconds=0,
        source_out_seconds=10,
        timeline_start_seconds=0,
        timeline_duration_seconds=10,
    )
    plan = RenderPlan(
        project_id="p1",
        storyboard_revision="r1",
        total_duration_seconds=10,
        output=RenderOutputSpec(width=1280, height=720),
        clips=[clip],
        render_runtime="ffmpeg",
    )

    filter_graph = ffmpeg._video_filter(
        0,
        clip,
        plan,
        "v0",
        bundled=True,
        setpts_available=False,
        format_available=False,
    )

    assert filter_graph == "[0:v:0]scale=1280:720[v0]"


def test_explicit_retime_falls_back_when_setpts_is_unavailable(
    monkeypatch, tmp_path
):
    source = tmp_path / "shot.mp4"
    source.write_bytes(b"placeholder")
    plan = RenderPlan(
        project_id="p1",
        storyboard_revision="r1",
        total_duration_seconds=5,
        output=RenderOutputSpec(width=1280, height=720),
        clips=[
            RenderClip(
                id="c1",
                shot_id="s1",
                source_path=str(source),
                source_duration_seconds=10,
                source_width=1280,
                source_height=720,
                source_in_seconds=0,
                source_out_seconds=10,
                timeline_start_seconds=0,
                timeline_duration_seconds=5,
                duration_policy="explicit_retime",
                playback_rate=2,
            )
        ],
        render_runtime="ffmpeg",
    )
    fallback = {"path": "remotion-output", "runtime": "remotion"}
    monkeypatch.setattr(ffmpeg, "resolve_command_path", lambda _name: "ffmpeg")
    monkeypatch.setattr(ffmpeg, "render_remotion_visual", lambda _plan, _output: fallback)
    monkeypatch.setattr(
        ffmpeg,
        "_filter_available",
        lambda _path, name: name not in {"setpts", "setsar", "format"},
    )

    assert ffmpeg.render_ffmpeg_visual(plan, tmp_path / "final.mp4") == fallback


def test_explicit_retime_adds_a_visible_setpts_filter(tmp_path):
    source = tmp_path / "shot.mp4"
    source.write_bytes(b"placeholder")
    clip = RenderClip(
        id="c1",
        shot_id="s1",
        source_path=str(source),
        source_duration_seconds=10,
        source_width=1280,
        source_height=720,
        source_in_seconds=0,
        source_out_seconds=10,
        timeline_start_seconds=0,
        timeline_duration_seconds=5,
        duration_policy="explicit_retime",
        playback_rate=2,
    )
    plan = RenderPlan(
        project_id="p1",
        storyboard_revision="r1",
        total_duration_seconds=5,
        output=RenderOutputSpec(width=1280, height=720),
        clips=[clip],
        render_runtime="ffmpeg",
    )

    filter_graph = ffmpeg._video_filter(0, clip, plan, "v0", bundled=False)

    assert "setpts=PTS/2.000000" in filter_graph
