from __future__ import annotations

import os
from pathlib import Path

import pytest

import tools.base_tool as base_tool_module
from tools.base_tool import BaseTool, ToolStatus
from tools.video.video_compose import VideoCompose


class _FfmpegProbeTool(BaseTool):
    name = "ffmpeg_probe_tool"
    dependencies = ["cmd:ffmpeg", "cmd:ffprobe"]
    capabilities = ["test"]
    input_schema = {"type": "object"}

    def execute(self, inputs):
        raise NotImplementedError


def test_cmd_dependencies_accept_remotion_bundled_ffmpeg_and_ffprobe(
    monkeypatch,
):
    project_root = Path(__file__).resolve().parent.parent.parent
    bundled_dir = (
        project_root
        / "remotion-composer"
        / "node_modules"
        / "@remotion"
        / "compositor-win32-x64-msvc"
    )
    required = [
        bundled_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg"),
        bundled_dir / ("ffprobe.exe" if os.name == "nt" else "ffprobe"),
    ]
    if not all(path.exists() for path in required):
        pytest.skip("Remotion bundled ffmpeg/ffprobe is not installed in this checkout")

    monkeypatch.setattr("tools.base_tool.shutil.which", lambda _: None)

    tool = _FfmpegProbeTool()

    assert tool.get_status() == ToolStatus.AVAILABLE


def test_video_compose_reports_ffmpeg_unavailable_without_any_binary(monkeypatch):
    monkeypatch.setattr("tools.base_tool.shutil.which", lambda _: None)
    monkeypatch.setattr(
        base_tool_module,
        "remotion_bundled_command_path",
        lambda command_name: None,
        raising=False,
    )

    info = VideoCompose().get_info()

    assert info["render_engines"]["ffmpeg"] is False
