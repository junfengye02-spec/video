from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[2]
PROCESS_GATE = (
    REPO_ROOT / "server" / "tests" / "fixtures" / "generation_units_process_gate.py"
)
BUNDLED_FFMPEG_DIR = (
    REPO_ROOT
    / "remotion-composer"
    / "node_modules"
    / "@remotion"
    / "compositor-win32-x64-msvc"
)


def _ffmpeg_binaries() -> tuple[Path, Path]:
    ffmpeg = BUNDLED_FFMPEG_DIR / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    ffprobe = BUNDLED_FFMPEG_DIR / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
    if not ffmpeg.is_file() or not ffprobe.is_file():
        pytest.skip("Remotion's real ffmpeg/ffprobe binaries are unavailable")
    return ffmpeg, ffprobe


def _run(
    command: list[str],
    *,
    env: dict[str, str] | None = None,
    expected: int = 0,
    timeout: float = 60,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=REPO_ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )
    assert result.returncode == expected, (
        command,
        result.returncode,
        result.stdout[-4000:],
        result.stderr[-4000:],
    )
    return result


def _make_video(
    *,
    ffmpeg: Path,
    directory: Path,
    name: str,
    color: tuple[int, int, int],
    frames: int,
) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    image_path = directory / f"{name}.png"
    video_path = directory / f"{name}.mp4"
    image = Image.new("RGB", (320, 180), color)
    for x in range(0, 320, 16):
        for y in range(0, 180, 16):
            if (x // 16 + y // 16) % 3 == 0:
                image.paste(
                    tuple(min(255, channel + 35) for channel in color),
                    (x, y, min(320, x + 8), min(180, y + 8)),
                )
    image.save(image_path)
    _run(
        [
            str(ffmpeg),
            "-y",
            "-loop",
            "1",
            "-framerate",
            "30",
            "-i",
            str(image_path),
            "-frames:v",
            str(frames),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(video_path),
        ]
    )
    return video_path


def _artifact_dir() -> Path | None:
    value = os.environ.get("GENERATION_UNITS_GATE_ARTIFACTS")
    return Path(value).resolve() if value else None


def _copy_json_artifact(path: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, destination)


def test_real_ffmpeg_generation_unit_timeline_and_render(tmp_path, monkeypatch):
    ffmpeg, ffprobe = _ffmpeg_binaries()
    monkeypatch.setenv(
        "PATH", f"{BUNDLED_FFMPEG_DIR}{os.pathsep}{os.environ.get('PATH', '')}"
    )
    from server.app.openmontage_runner import render_short_drama_project
    from server.app.rendering.probe import probe_media

    project = tmp_path / "real-ffmpeg-project"
    source_dir = project / "assets" / "video" / "units"
    definitions = [
        ("unit-1", (180, 35, 45), 24),
        ("unit-2", (30, 145, 85), 30),
        ("unit-3", (35, 80, 185), 36),
    ]
    assets = []
    source_probes = []
    for index, (unit_id, color, frames) in enumerate(definitions):
        path = _make_video(
            ffmpeg=ffmpeg,
            directory=source_dir / unit_id,
            name="v1",
            color=color,
            frames=frames,
        )
        probe = probe_media(path)
        source_probes.append(probe)
        assets.append(
            {
                "id": f"asset-{unit_id}",
                "type": "video",
                "path": path.relative_to(project).as_posix(),
                "source_tool": "strict_fake_provider",
                "scene_id": unit_id,
                "requested_duration_seconds": 10,
                "source_duration_seconds": probe["duration_seconds"],
                "duration_seconds": probe["duration_seconds"],
                "format": "mp4",
                "metadata": {
                    "generation_unit_id": unit_id,
                    "revision": 1,
                    "source_shot_ids": [f"s{index * 2 + 1}", f"s{index * 2 + 2}"],
                    "source_beat_ids": [f"b{index * 2 + 1}", f"b{index * 2 + 2}"],
                    "active": True,
                    "status": "complete",
                },
            }
        )

    storyboard = {
        "version": "1.0",
        "revision": "real-ffmpeg-gate",
        "aspect_ratio": "16:9",
        "shots": [
            {"id": f"s{index}", "index": index, "beat_id": f"b{index}"}
            for index in range(1, 7)
        ],
    }
    manifest = {
        "version": "1.0",
        "assets": assets,
        "total_cost_usd": 0,
        "metadata": {"generation_units_v2": True},
    }
    edit_decisions = {
        "version": "1.0",
        "cuts": [],
        "render_runtime": "ffmpeg",
        "audio": {"source": {"default_policy": "preserve"}},
    }
    target_duration = 4.0
    final_path = project / "renders" / "final.mp4"
    result = render_short_drama_project(
        project_dir=project,
        series_bible={"version": "1.0", "assets": []},
        storyboard=storyboard,
        render_runtime="ffmpeg",
        composition_output_path=final_path,
        persist_render_report=False,
        persist_execution_artifacts=False,
        pipeline_inputs={
            "asset_manifest": manifest,
            "edit_decisions": edit_decisions,
            "proposal_packet": {
                "production_plan": {"render_runtime": "ffmpeg"}
            },
        },
        render_output_spec={
            "width": 320,
            "height": 180,
            "fps": 30,
            "format": "mp4",
            "video_codec": "h264",
            "audio_codec": "aac",
        },
        project_id="real-ffmpeg-generation-units",
        project_aspect_ratio="16:9",
        target_duration_seconds=target_duration,
    )

    render_plan = result["render_plan"]
    edit_timeline = result["edit_timeline"]
    report_output = result["render_report"]["outputs"][0]
    final_probe = probe_media(final_path)
    primary = next(track for track in edit_timeline["tracks"] if track["role"] == "primary")
    expected_total = sum(probe["duration_seconds"] for probe in source_probes)

    assert len(render_plan["clips"]) == 3
    assert len(primary["items"]) == 3
    assert [clip["generation_unit_id"] for clip in render_plan["clips"]] == [
        "unit-1",
        "unit-2",
        "unit-3",
    ]
    assert [clip["source_shot_ids"] for clip in render_plan["clips"]] == [
        ["s1", "s2"],
        ["s3", "s4"],
        ["s5", "s6"],
    ]
    for clip, probe in zip(render_plan["clips"], source_probes, strict=True):
        assert clip["duration_policy"] == "full_source"
        assert clip["source_in_seconds"] == 0
        assert clip["source_out_seconds"] == pytest.approx(probe["duration_seconds"])
        assert clip["timeline_duration_seconds"] == pytest.approx(
            probe["duration_seconds"]
        )
        assert clip["playback_rate"] == 1
    assert render_plan["total_duration_seconds"] == pytest.approx(expected_total)
    assert final_probe["duration_seconds"] == pytest.approx(expected_total, abs=2 / 30)
    assert report_output["duration_seconds"] == pytest.approx(
        final_probe["duration_seconds"]
    )
    assert report_output["target_duration_seconds"] == target_duration
    assert report_output["duration_difference_seconds"] == round(
        final_probe["duration_seconds"] - target_duration, 3
    )
    assert result["final_review"]["status"] == "pass"

    evidence = {
        "ffmpeg_version": _run([str(ffmpeg), "-version"]).stdout.splitlines()[0],
        "ffprobe_version": _run([str(ffprobe), "-version"]).stdout.splitlines()[0],
        "storyboard_shot_count": 6,
        "generation_unit_count": 3,
        "timeline_clip_count": len(primary["items"]),
        "source_durations_seconds": [probe["duration_seconds"] for probe in source_probes],
        "timeline_duration_seconds": render_plan["total_duration_seconds"],
        "final_duration_seconds": final_probe["duration_seconds"],
        "target_duration_seconds": target_duration,
        "duration_difference_seconds": report_output["duration_difference_seconds"],
        "full_source": True,
        "playback_rate": 1,
    }
    artifact_dir = _artifact_dir()
    if artifact_dir is not None:
        output_dir = artifact_dir / "ffmpeg"
        output_dir.mkdir(parents=True, exist_ok=True)
        (output_dir / "qa-summary.json").write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        for name, value in (
            ("asset_manifest.json", manifest),
            ("edit_timeline.json", edit_timeline),
            ("render_plan.json", render_plan),
            ("render_report.json", result["render_report"]),
            ("final_ffprobe.json", final_probe),
            ("source_ffprobe.json", source_probes),
        ):
            (output_dir / name).write_text(
                json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        shutil.copy2(final_path, output_dir / "final.mp4")
        for index, asset in enumerate(assets, start=1):
            shutil.copy2(project / asset["path"], output_dir / f"unit-{index}.mp4")


def _database_url(path: Path) -> str:
    return f"sqlite+pysqlite:///{path.resolve().as_posix()}"


def _process_env(state_dir: Path, provider_url: str = "http://127.0.0.1:1"):
    _, _ = _ffmpeg_binaries()
    env = os.environ.copy()
    env.update(
        DATABASE_URL=_database_url(state_dir / "generation-units.sqlite3"),
        ENVIRONMENT="test",
        AUTH_HMAC_SECRET="x" * 32,
        PYTHONPATH=str(REPO_ROOT),
        GENERATION_UNITS_PROVIDER_URL=provider_url,
        PATH=f"{BUNDLED_FFMPEG_DIR}{os.pathsep}{env.get('PATH', '')}",
    )
    return env


def _gate_command(mode: str, state_dir: Path, provider_url: str, *extra: str):
    return [
        sys.executable,
        str(PROCESS_GATE),
        mode,
        "--state-dir",
        str(state_dir),
        "--provider-url",
        provider_url,
        *extra,
    ]


def _start_provider(state_dir: Path, media_path: Path):
    port_file = state_dir / "provider-port.json"
    port_file.unlink(missing_ok=True)
    process = subprocess.Popen(
        [
            sys.executable,
            str(PROCESS_GATE),
            "provider",
            "--state-dir",
            str(state_dir),
            "--provider-state",
            str(state_dir / "provider-state.json"),
            "--media-path",
            str(media_path),
            "--port-file",
            str(port_file),
        ],
        cwd=REPO_ROOT,
        env=_process_env(state_dir),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            raise AssertionError((process.returncode, stdout, stderr))
        if port_file.is_file():
            base_url = json.loads(port_file.read_text(encoding="utf-8"))["base_url"]
            try:
                if httpx.get(f"{base_url}/health", timeout=0.5).status_code == 200:
                    return process, base_url
            except httpx.HTTPError:
                pass
        time.sleep(0.03)
    process.terminate()
    raise TimeoutError("strict fake provider did not start")


def _stop_provider(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _set_provider_mode(state_dir: Path, mode: str) -> None:
    path = state_dir / "provider-state.json"
    state = json.loads(path.read_text(encoding="utf-8"))
    state["mode"] = mode
    temporary = path.with_suffix(".mode.tmp")
    temporary.write_text(json.dumps(state, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def _snapshot(state_dir: Path, label: str) -> dict:
    return json.loads(
        (state_dir / "snapshots" / f"{label}.json").read_text(encoding="utf-8")
    )


def test_generation_unit_worker_and_provider_process_crash_recovery(tmp_path_factory):
    ffmpeg, _ffprobe = _ffmpeg_binaries()
    state_dir = tmp_path_factory.mktemp("gu")
    media_path = _make_video(
        ffmpeg=ffmpeg,
        directory=state_dir,
        name="strict-provider-video",
        color=(70, 120, 190),
        frames=30,
    )
    provider = None
    try:
        provider, provider_url = _start_provider(state_dir, media_path)
        arm = state_dir / "crash-after-accept.arm"
        crash_env = _process_env(state_dir, provider_url)
        crash_env.update(
            GENERATION_UNITS_EXECUTE_ARM=str(arm),
            GENERATION_UNITS_CRASH_AFTER_ACCEPT="1",
        )
        _run(
            _gate_command("submit-crash", state_dir, provider_url),
            env=crash_env,
            expected=91,
            timeout=45,
        )

        _run(
            _gate_command(
                "expire",
                state_dir,
                provider_url,
                "--label",
                "after-worker-crash",
            ),
            env=_process_env(state_dir, provider_url),
        )
        _run(
            _gate_command(
                "worker-until",
                state_dir,
                provider_url,
                "--expected",
                "waiting_provider",
                "--label",
                "waiting-provider",
            ),
            env=_process_env(state_dir, provider_url),
            timeout=45,
        )
        waiting = _snapshot(state_dir, "waiting-provider")
        waiting_item = next(item for item in waiting["items"] if item["status"] == "waiting_provider")
        original_job = next(job for job in waiting["jobs"] if job["id"] == waiting_item["billing_job_id"])
        waiting_unit = next(unit for unit in waiting["units"] if unit["revision"] == 1)
        assert waiting_unit["billing_job_id"] == original_job["id"]
        assert len(
            [
                job
                for job in waiting["jobs"]
                if job["operation"].startswith("generation_unit:")
            ]
        ) == 1

        reference_recovered_result = state_dir / "reference-recovered-reconcile.json"
        _run(
            _gate_command(
                "reconcile",
                state_dir,
                provider_url,
                "--job-id",
                original_job["id"],
                "--output",
                str(reference_recovered_result),
                "--label",
                "reference-recovered",
            ),
            env=_process_env(state_dir, provider_url),
        )
        assert json.loads(reference_recovered_result.read_text(encoding="utf-8")) == {
            "error": None,
            "outcome": "pending",
        }
        reference_recovered = _snapshot(state_dir, "reference-recovered")
        original_job = next(
            job for job in reference_recovered["jobs"] if job["id"] == original_job["id"]
        )
        assert original_job["provider_reference_id"].startswith("task_")

        _stop_provider(provider)
        provider = None
        _run(
            _gate_command(
                "expire",
                state_dir,
                provider_url,
                "--label",
                "before-provider-down-poll",
            ),
            env=_process_env(state_dir, provider_url),
        )
        provider_down_result = state_dir / "provider-down-reconcile.json"
        _run(
            _gate_command(
                "reconcile",
                state_dir,
                provider_url,
                "--job-id",
                original_job["id"],
                "--output",
                str(provider_down_result),
                "--label",
                "provider-down",
            ),
            env=_process_env(state_dir, provider_url),
        )
        down = json.loads(provider_down_result.read_text(encoding="utf-8"))
        assert down["outcome"] == "error"
        assert "strict fake provider is unavailable" in down["error"]
        assert next(
            item for item in _snapshot(state_dir, "provider-down")["items"]
            if item["id"] == waiting_item["id"]
        )["status"] == "waiting_provider"

        _set_provider_mode(state_dir, "completed")
        provider, provider_url = _start_provider(state_dir, media_path)
        _run(
            _gate_command(
                "expire",
                state_dir,
                provider_url,
                "--label",
                "before-provider-recovery",
            ),
            env=_process_env(state_dir, provider_url),
        )
        provider_recovered_result = state_dir / "provider-recovered-reconcile.json"
        _run(
            _gate_command(
                "reconcile",
                state_dir,
                provider_url,
                "--job-id",
                original_job["id"],
                "--output",
                str(provider_recovered_result),
                "--label",
                "provider-recovered",
            ),
            env=_process_env(state_dir, provider_url),
            timeout=45,
        )
        recovered = json.loads(provider_recovered_result.read_text(encoding="utf-8"))
        assert recovered == {"error": None, "outcome": "completed"}
        _run(
            _gate_command(
                "worker-until",
                state_dir,
                provider_url,
                "--expected",
                "complete",
                "--label",
                "initial-complete",
            ),
            env=_process_env(state_dir, provider_url),
            timeout=45,
        )
        initial_complete = _snapshot(state_dir, "initial-complete")
        provider_state = json.loads(
            (state_dir / "provider-state.json").read_text(encoding="utf-8")
        )
        assert len(
            [
                job
                for job in initial_complete["jobs"]
                if job["operation"].startswith("generation_unit:")
            ]
        ) == 1
        assert initial_complete["consume_job_ids"].count(original_job["id"]) == 1
        assert provider_state["quote_count"] == 1
        assert provider_state["execute_attempt_count"] == 1
        assert provider_state["execute_count"] == 1
        assert provider_state["duplicate_execute_attempt_count"] == 0
        assert provider_state["download_count"] == 1
        active_v1 = next(unit for unit in initial_complete["units"] if unit["revision"] == 1)
        assert active_v1["status"] == "complete" and active_v1["active"] is True
        assert active_v1["billing_job_id"] == original_job["id"]

        replacement_arm = state_dir / "replacement-failure.arm"
        replacement_env = _process_env(state_dir, provider_url)
        replacement_env.update(
            GENERATION_UNITS_EXECUTE_ARM=str(replacement_arm),
            GENERATION_UNITS_FAIL_REVISION="2",
        )
        _run(
            _gate_command(
                "replacement-fail",
                state_dir,
                provider_url,
                "--label",
                "replacement-failed",
            ),
            env=replacement_env,
            timeout=45,
        )
        replacement_failed = _snapshot(state_dir, "replacement-failed")
        failed_v1 = next(unit for unit in replacement_failed["units"] if unit["revision"] == 1)
        failed_v2 = next(unit for unit in replacement_failed["units"] if unit["revision"] == 2)
        assert failed_v1["active"] is True and failed_v1["status"] == "complete"
        assert failed_v2["active"] is False and failed_v2["status"] == "failed"
        assert failed_v2["billing_job_id"] is not None
        old_output = state_dir / "projects" / replacement_failed["project_id"] / failed_v1["output_path"]
        assert old_output.is_file()
        provider_after_failure = json.loads(
            (state_dir / "provider-state.json").read_text(encoding="utf-8")
        )
        assert provider_after_failure["quote_count"] == 2
        assert provider_after_failure["execute_count"] == 2
        assert provider_after_failure["download_count"] == 2
        assert (
            replacement_failed["consume_job_ids"].count(
                failed_v2["billing_job_id"]
            )
            == 1
        )

        _run(
            _gate_command(
                "expire",
                state_dir,
                provider_url,
                "--label",
                "before-replacement-retry",
            ),
            env=_process_env(state_dir, provider_url),
        )
        _run(
            _gate_command(
                "retry-replacement",
                state_dir,
                provider_url,
                "--label",
                "replacement-complete",
            ),
            env=_process_env(state_dir, provider_url),
            timeout=45,
        )
        replacement_complete = _snapshot(state_dir, "replacement-complete")
        current_v1 = next(unit for unit in replacement_complete["units"] if unit["revision"] == 1)
        current_v2 = next(unit for unit in replacement_complete["units"] if unit["revision"] == 2)
        assert current_v1["active"] is False and old_output.is_file()
        assert current_v2["active"] is True and current_v2["status"] == "complete"
        assert current_v2["billing_job_id"] == failed_v2["billing_job_id"]
        assert sum(unit["active"] for unit in replacement_complete["units"]) == 1
        provider_after_success = json.loads(
            (state_dir / "provider-state.json").read_text(encoding="utf-8")
        )
        assert provider_after_success["quote_count"] == 2
        assert provider_after_success["execute_attempt_count"] == 2
        assert provider_after_success["execute_count"] == 2
        assert provider_after_success["duplicate_execute_attempt_count"] == 0
        assert provider_after_success["download_count"] == 2
        assert (
            replacement_complete["consume_job_ids"].count(
                current_v2["billing_job_id"]
            )
            == 1
        )

        project_dir = state_dir / "projects" / replacement_complete["project_id"]
        manifest = json.loads(
            (project_dir / "artifacts" / "asset_manifest.json").read_text(encoding="utf-8")
        )
        active_asset = next(
            asset
            for asset in manifest["assets"]
            if asset.get("metadata", {}).get("generation_unit_id") == current_v2["id"]
            and asset.get("metadata", {}).get("active") is True
        )
        assert active_asset["source_duration_seconds"] == pytest.approx(
            current_v2["source_duration_seconds"]
        )
        assert active_asset["duration_seconds"] == pytest.approx(
            current_v2["source_duration_seconds"]
        )
        assert (project_dir / current_v2["output_path"]).is_file()

        artifact_dir = _artifact_dir()
        if artifact_dir is not None:
            output_dir = artifact_dir / "crash-recovery"
            output_dir.mkdir(parents=True, exist_ok=True)
            (output_dir / "qa-summary.json").write_text(
                json.dumps(
                    {
                        "worker_exit_code": 91,
                        "generation_unit_id": current_v2["id"],
                        "original_billing_job_id": original_job["id"],
                        "original_provider_reference_id": original_job[
                            "provider_reference_id"
                        ],
                        "provider_interruption_outcome": down["outcome"],
                        "provider_quote_count": provider_after_success["quote_count"],
                        "provider_execute_count": provider_after_success[
                            "execute_count"
                        ],
                        "duplicate_provider_execute_attempt_count": (
                            provider_after_success[
                                "duplicate_execute_attempt_count"
                            ]
                        ),
                        "v1_wallet_consume_count": replacement_complete[
                            "consume_job_ids"
                        ].count(current_v1["billing_job_id"]),
                        "v2_wallet_consume_count": replacement_complete[
                            "consume_job_ids"
                        ].count(current_v2["billing_job_id"]),
                        "replacement_failure_preserved_v1": (
                            failed_v1["active"] is True
                            and failed_v2["active"] is False
                        ),
                        "final_active_revision": current_v2["revision"],
                        "active_revision_count": sum(
                            unit["active"]
                            for unit in replacement_complete["units"]
                            if unit["id"] == current_v2["id"]
                        ),
                        "retained_v1_exists": old_output.is_file(),
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            for path in [
                state_dir / "scenario.json",
                state_dir / "provider-state.json",
                reference_recovered_result,
                provider_down_result,
                provider_recovered_result,
                project_dir / "artifacts" / "asset_manifest.json",
                project_dir / "artifacts" / "generation_execution.json",
            ]:
                if path.is_file():
                    _copy_json_artifact(path, output_dir / path.name)
            for snapshot_path in sorted((state_dir / "snapshots").glob("*.json")):
                _copy_json_artifact(
                    snapshot_path, output_dir / "snapshots" / snapshot_path.name
                )
            shutil.copy2(media_path, output_dir / "strict-provider-video.mp4")
            shutil.copy2(old_output, output_dir / "retained-v1.mp4")
            shutil.copy2(
                project_dir / current_v2["output_path"], output_dir / "active-v2.mp4"
            )
    finally:
        if provider is not None:
            _stop_provider(provider)
