import math
import wave
from array import array

import pytest

from server.app.rendering.audio import render_audio_master
from server.app.rendering.models import (
    RenderAudioPlan,
    RenderClip,
    RenderMusicTrack,
    RenderOutputSpec,
    RenderPlan,
    RenderTimedAudioTrack,
)
from server.app.rendering.probe import probe_media
from tools.base_tool import resolve_command_path


def _tone(path, *, frequency: float, duration: float = 1.0):
    sample_rate = 48000
    samples = array(
        "h",
        (
            round(9000 * math.sin(2 * math.pi * frequency * index / sample_rate))
            for index in range(round(sample_rate * duration))
        ),
    )
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(samples.tobytes())


@pytest.mark.skipif(resolve_command_path("ffmpeg") is None, reason="ffmpeg unavailable")
def test_audio_master_uses_stems_ducking_and_two_pass_loudness(tmp_path):
    dialogue = tmp_path / "dialogue.wav"
    music = tmp_path / "music.wav"
    _tone(dialogue, frequency=440)
    _tone(music, frequency=220)
    placeholder_video = tmp_path / "visual.mp4"
    placeholder_video.write_bytes(b"unused")
    plan = RenderPlan(
        project_id="p1",
        storyboard_revision="r1",
        total_duration_seconds=1,
        output=RenderOutputSpec(width=720, height=1280, fps=30),
        clips=[
            RenderClip(
                id="c1",
                shot_id="s1",
                source_path=str(placeholder_video),
                source_duration_seconds=1,
                source_has_audio=False,
                source_in_seconds=0,
                source_out_seconds=1,
                timeline_start_seconds=0,
                timeline_duration_seconds=1,
            )
        ],
        audio=RenderAudioPlan(
            dialogue=[
                RenderTimedAudioTrack(
                    id="dialogue-1",
                    source_path=str(dialogue),
                    timeline_start_seconds=0.2,
                    timeline_end_seconds=0.8,
                )
            ],
            music=RenderMusicTrack(
                source_path=str(music),
                volume=0.25,
                ducking={
                    "enabled": True,
                    "reduction_db": 9,
                    "attack_ms": 50,
                    "release_ms": 100,
                },
            ),
        ),
        render_runtime="remotion",
    )
    output = tmp_path / "audio-master.wav"

    report = render_audio_master(plan, output)
    media = probe_media(output, require_video=False)

    assert media["has_audio"] is True
    assert media["duration_seconds"] == pytest.approx(1, abs=0.05)
    assert report["dialogue_tracks"] == 1
    assert report["ducking_mode"] == "timeline-envelope"
    assert report["loudness_normalization"]["passes"] == 2
    assert report["loudness_normalization"]["true_peak_db"] == -1.5
