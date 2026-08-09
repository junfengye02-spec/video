from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from PIL import Image

from server.app.continuity_frames import extract_tail_frame
from tools.base_tool import resolve_command_path


def _video_with_black_tail(tmp_path: Path) -> Path:
    ffmpeg = resolve_command_path("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg is unavailable")
    frames = tmp_path / "frames"
    frames.mkdir()
    for index in range(10):
        color = (220, 35, 35) if index < 8 else (0, 0, 0)
        Image.new("RGB", (64, 48), color).save(frames / f"{index:02d}.png")
    output = tmp_path / "source.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-framerate",
            "10",
            "-i",
            str(frames / "%02d.png"),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(output),
        ],
        check=True,
        capture_output=True,
    )
    return output


def test_tail_frame_extraction_backtracks_over_black_frames_and_costs_zero(tmp_path):
    video = _video_with_black_tail(tmp_path)
    output_dir = tmp_path / "assets" / "images" / "keyframes"

    result = extract_tail_frame(
        video_path=video,
        output_dir=output_dir,
        shot_id="s1",
        video_version=4,
    )

    assert result.status == "ready"
    assert result.provider_cost_units == 0
    assert result.backtrack_frames >= 2
    assert result.sample_time_seconds < 0.8
    assert result.width == 64
    assert result.height == 48
    with Image.open(result.path) as image:
        red, green, blue = image.convert("RGB").resize((1, 1)).getpixel((0, 0))
    assert red > green * 3
    assert red > blue * 3


def test_tail_frame_extraction_is_idempotent_for_same_video_version_and_hash(tmp_path):
    video = _video_with_black_tail(tmp_path)
    output_dir = tmp_path / "assets" / "images" / "keyframes"
    first = extract_tail_frame(
        video_path=video,
        output_dir=output_dir,
        shot_id="s1",
        video_version=4,
    )
    first_mtime = first.path.stat().st_mtime_ns

    second = extract_tail_frame(
        video_path=video,
        output_dir=output_dir,
        shot_id="s1",
        video_version=4,
    )

    assert second.reused is True
    assert second.path == first.path
    assert second.video_sha256 == first.video_sha256
    assert second.path.stat().st_mtime_ns == first_mtime


def test_failed_extraction_preserves_existing_tail_frame(tmp_path):
    output_dir = tmp_path / "assets" / "images" / "keyframes"
    output_dir.mkdir(parents=True)
    existing = output_dir / "existing.png"
    Image.new("RGB", (64, 48), (20, 120, 200)).save(existing)
    before = existing.read_bytes()
    damaged = tmp_path / "damaged.mp4"
    damaged.write_bytes(b"not a video")

    with pytest.raises(ValueError, match="could not be probed"):
        extract_tail_frame(
            video_path=damaged,
            output_dir=output_dir,
            shot_id="s1",
            video_version=5,
        )

    assert existing.read_bytes() == before

