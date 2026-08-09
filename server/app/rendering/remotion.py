from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from server.app.media_files import atomic_write_text
from server.app.rendering.models import RenderPlan


class RemotionRenderError(RuntimeError):
    pass


def render_remotion_visual(plan: RenderPlan, output_path: str | Path) -> dict[str, Any]:
    npx = shutil.which("npx.cmd") or shutil.which("npx")
    if npx is None:
        raise RemotionRenderError("npx is unavailable")
    composer_dir = Path(__file__).resolve().parents[3] / "remotion-composer"
    entry = composer_dir / "src" / "index.tsx"
    if not entry.is_file():
        raise RemotionRenderError("Remotion composer is missing")

    output = Path(output_path).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    props_path = output.parent / f".{output.stem}.workbench-render-plan.json"
    public_dir = output.parent / f".{output.stem}.workbench-public"
    public_dir.mkdir(parents=True, exist_ok=True)
    payload = plan.model_dump(mode="json")
    for index, clip in enumerate(payload["clips"]):
        source = Path(clip["source_path"]).resolve()
        staged_name = f"{index:04d}-{source.name}"
        staged = public_dir / staged_name
        try:
            os.link(source, staged)
        except OSError:
            shutil.copy2(source, staged)
        clip["source_path"] = staged_name
    atomic_write_text(
        props_path,
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    command = [
        npx,
        "remotion",
        "render",
        str(entry),
        "WorkbenchRenderer",
        str(output),
        f"--props={props_path}",
        "--codec=h264",
        "--crf=20",
        "--concurrency=2",
        f"--public-dir={public_dir}",
    ]
    browser_executable = _browser_executable()
    if browser_executable is not None:
        command.append(f"--browser-executable={browser_executable}")
    try:
        result = subprocess.run(
            command,
            cwd=composer_dir,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=900,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RemotionRenderError("Remotion render command failed") from exc
    finally:
        props_path.unlink(missing_ok=True)
        shutil.rmtree(public_dir, ignore_errors=True)
    if result.returncode != 0 or not output.is_file() or output.stat().st_size <= 0:
        detail = (result.stderr or result.stdout or "").strip()[-3000:]
        raise RemotionRenderError(f"Remotion render failed: {detail}")
    return {"path": str(output), "runtime": "remotion"}


def _browser_executable() -> str | None:
    candidates = [
        shutil.which("chrome"),
        shutil.which("chrome.exe"),
        str(Path("C:/Program Files/Google/Chrome/Application/chrome.exe")),
        str(Path("C:/Program Files (x86)/Google/Chrome/Application/chrome.exe")),
        str(Path.home() / "AppData/Local/Google/Chrome/Application/chrome.exe"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    return None
