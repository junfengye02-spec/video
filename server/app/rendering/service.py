from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from server.app.media_files import create_atomic_output, replace_atomic_output
from server.app.rendering.audio import render_audio_master
from server.app.rendering.ffmpeg import render_ffmpeg_visual
from server.app.rendering.models import RenderPlan
from server.app.rendering.remotion import render_remotion_visual
from server.app.rendering.review import review_rendered_output
from tools.base_tool import resolve_command_path


class RenderExecutionError(RuntimeError):
    pass


class RenderQualityError(RenderExecutionError):
    def __init__(self, review: dict[str, Any]):
        super().__init__("final review did not pass")
        self.review = review


def execute_render_plan(
    *,
    plan: RenderPlan,
    output_path: str | Path,
    proposal_packet: dict[str, Any] | None = None,
) -> dict[str, Any]:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".workbench-render-",
        dir=output.parent,
    ) as temporary_dir:
        temp = Path(temporary_dir)
        visual_path = temp / "visual.mp4"
        audio_path = temp / "audio_master.wav"
        muxed_path = temp / "muxed.mp4"

        if plan.render_runtime == "remotion":
            visual_result = render_remotion_visual(plan, visual_path)
        elif plan.render_runtime == "ffmpeg":
            visual_result = render_ffmpeg_visual(plan, visual_path)
        else:
            raise RenderExecutionError(
                "HyperFrames Render Plan execution is not yet available; refusing "
                "to swap the locked runtime silently."
            )
        audio_result = render_audio_master(plan, audio_path)
        _mux(visual_path, audio_path, muxed_path, plan.total_duration_seconds)

        descriptor, staged, expected_parent = create_atomic_output(
            output,
            suffix=".render",
        )
        os.close(descriptor)
        try:
            shutil.copyfile(muxed_path, staged)
            replace_atomic_output(staged, output, expected_parent)
        finally:
            staged.unlink(missing_ok=True)

    review = review_rendered_output(
        plan=plan,
        output_path=output,
        proposal_packet=proposal_packet,
    )
    result = {
        "output_path": str(output),
        "visual": visual_result,
        "audio": audio_result,
        "final_review": review,
    }
    if review["status"] != "pass":
        raise RenderQualityError(review)
    return result


def _mux(video: Path, audio: Path, output: Path, duration: float) -> None:
    ffmpeg = resolve_command_path("ffmpeg")
    if ffmpeg is None:
        raise RenderExecutionError("ffmpeg is unavailable for final mux")
    command = [
        ffmpeg,
        "-y",
        "-i",
        str(video),
        "-i",
        str(audio),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-t",
        f"{duration:.6f}",
        "-movflags",
        "+faststart",
        str(output),
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RenderExecutionError("final mux command failed") from exc
    if result.returncode != 0 or not output.is_file() or output.stat().st_size <= 0:
        detail = (result.stderr or result.stdout or "").strip()[-3000:]
        raise RenderExecutionError(f"final mux failed: {detail}")
