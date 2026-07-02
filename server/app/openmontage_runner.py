from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Literal

from lib.shot_prompt_builder import build_shot_prompt
from server.app.keyring import key_environment

RenderRuntime = Literal["remotion", "hyperframes", "ffmpeg"]
DEFAULT_VIDEO_MODEL = "omni_flash-10s"


def compile_shot_prompt(
    shot: dict[str, Any],
    character_lookup: dict[str, dict[str, Any]],
    style_lock: str | None,
    asset_lookup: dict[str, dict[str, Any]] | None = None,
) -> str:
    prompt_parts = [str(shot.get("prompt", "")).strip()]
    shot_language = shot.get("shot_language") or {}
    shot_language_scene = {
        "description": str(shot.get("prompt", "")).strip(),
        "shot_language": shot_language,
        "texture_keywords": shot.get("texture_keywords", []),
    }
    shot_language_prompt = build_shot_prompt(
        shot_language_scene,
        {"visual_language": {"aesthetic": style_lock or ""}},
    )
    if (
        _has_meaningful_shot_language(shot_language)
        and shot_language_prompt
        and shot_language_prompt != prompt_parts[0]
    ):
        prompt_parts.append(f"Shot language: {shot_language_prompt}")
    if shot.get("shot_intent"):
        prompt_parts.append(f"Shot intent: {shot['shot_intent']}")
    locks: list[str] = []
    for character_id in shot.get("characters", []):
        character = character_lookup.get(str(character_id))
        visual_lock = character.get("visual_lock") if character else None
        if visual_lock and str(visual_lock) not in prompt_parts[0]:
            locks.append(f"{character.get('name', character_id)}: {visual_lock}")
    if locks:
        prompt_parts.append("Character locks: " + "; ".join(locks))
    if style_lock:
        prompt_parts.append(f"Style lock: {style_lock}")
    if shot.get("location"):
        prompt_parts.append(f"Location: {shot['location']}")
    if shot.get("props"):
        prompt_parts.append("Props: " + ", ".join(str(prop) for prop in shot["props"]))
    asset_ids = shot.get("asset_ids") or []
    if asset_lookup and asset_ids:
        reference_lines = []
        for asset_id in asset_ids:
            asset = asset_lookup.get(str(asset_id))
            if not asset:
                continue
            reference_images = asset.get("reference_images", [])
            if reference_images:
                reference_lines.append(
                    f"{asset.get('label', asset_id)} ({asset.get('kind', 'asset')}) -> "
                    + ", ".join(str(reference) for reference in reference_images)
                )
        if reference_lines:
            prompt_parts.append("Reference assets: " + "; ".join(reference_lines))
    return ". ".join(part for part in prompt_parts if part)


def _has_meaningful_shot_language(shot_language: Any) -> bool:
    if not isinstance(shot_language, dict):
        return False

    for value in shot_language.values():
        if isinstance(value, str) and value.strip():
            return True
        if isinstance(value, (list, tuple, set)) and any(
            isinstance(item, str) and item.strip() or item not in (None, "", [], {}, ())
            for item in value
        ):
            return True
        if value not in (None, "", [], {}, ()):
            return True

    return False


def build_pipeline_inputs(
    series_bible: dict[str, Any],
    storyboard: dict[str, Any],
    render_runtime: RenderRuntime = "remotion",
    video_model: str = DEFAULT_VIDEO_MODEL,
) -> dict[str, dict[str, Any]]:
    characters = series_bible.get("characters", [])
    character_lookup = {str(character.get("id")): character for character in characters}
    asset_lookup = {str(asset.get("id")): asset for asset in series_bible.get("assets", [])}
    style_lock = series_bible.get("style_lock") or "vertical short drama, cinematic continuity"
    shots = sorted(storyboard.get("shots", []), key=lambda shot: int(shot.get("index", 0)))

    scenes = []
    assets = []
    cuts = []
    for zero_index, shot in enumerate(shots):
        shot_id = str(shot.get("id") or f"s{zero_index + 1}")
        scene_id = str(shot.get("scene_id") or shot_id)
        start_seconds = zero_index * 5
        end_seconds = start_seconds + 5
        compiled_prompt = compile_shot_prompt(shot, character_lookup, style_lock, asset_lookup)

        scenes.append(
            {
                "id": scene_id,
                "type": "generated",
                "description": str(shot.get("prompt", "")),
                "start_seconds": start_seconds,
                "end_seconds": end_seconds,
                "framing": "vertical 9:16 short drama shot",
                "movement": "cinematic subject motion with clear emotional beat",
                "narrative_role": _narrative_role(zero_index, len(shots)),
                "information_role": str(shot.get("beat", "story beat")),
                "hero_moment": zero_index == max(len(shots) - 2, 0),
                "texture_keywords": ["rain", "neon", "high contrast"],
                "shot_language": shot.get("shot_language") or {},
                "shot_intent": shot.get("shot_intent"),
                "required_assets": [
                    {
                        "type": "video",
                        "description": compiled_prompt,
                        "source": "generate",
                    }
                ],
                "metadata": {
                    "shot_id": shot_id,
                    "characters": shot.get("characters", []),
                    "aspect_ratio": shot.get("aspect_ratio", "9:16"),
                },
            }
        )

        asset_id = f"{shot_id}-video"
        assets.append(
            {
                "id": asset_id,
                "type": "video",
                "path": f"assets/video/{shot_id}.mp4",
                "source_tool": "syapi_video",
                "scene_id": scene_id,
                "prompt": compiled_prompt,
                "model": video_model,
                "cost_usd": 0,
                "duration_seconds": 5,
                "resolution": "720x1280",
                "format": "mp4",
                "provider": "syapi",
                "generation_summary": "Mapped from short-drama storyboard shot.",
            }
        )
        cuts.append(
            {
                "id": f"cut-{shot_id}",
                "source": asset_id,
                "in_seconds": 0,
                "out_seconds": 5,
                "layer": "primary",
                "transition_in": "cut" if zero_index == 0 else "dissolve",
                "transition_out": "dissolve",
                "transition_duration": 0.2,
                "reason": str(shot.get("beat", "story beat")),
            }
        )

    proposal_packet = _build_proposal_packet(series_bible, shots, render_runtime, video_model)
    scene_plan = {"version": "1.0", "style_playbook": "cinematic", "scenes": scenes}
    asset_manifest = {"version": "1.0", "assets": assets, "total_cost_usd": 0}
    edit_decisions = {
        "version": "1.0",
        "cuts": cuts,
        "renderer_family": "cinematic-trailer",
        "render_runtime": render_runtime,
        "composition_mode": "templated",
        "subtitles": {
            "enabled": True,
            "style": "sentence",
            "position": "bottom-center",
            "max_words_per_line": 8,
        },
    }

    return {
        "proposal_packet": proposal_packet,
        "scene_plan": scene_plan,
        "asset_manifest": asset_manifest,
        "edit_decisions": edit_decisions,
    }


def write_pipeline_artifacts(
    project_dir: str | Path,
    pipeline_inputs: dict[str, dict[str, Any]],
) -> dict[str, Path]:
    artifact_dir = Path(project_dir) / "artifacts"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    written: dict[str, Path] = {}
    for name, data in pipeline_inputs.items():
        path = artifact_dir / f"{name}.json"
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        written[name] = path
    return written


def run_single_shot_generation(
    *,
    project_dir: str | Path,
    shot: dict[str, Any],
    series_bible: dict[str, Any],
    video_key: str,
    base_url: str,
    video_model: str = DEFAULT_VIDEO_MODEL,
    emit_event: Callable[[str, str, str], None] | None = None,
) -> dict[str, Any]:
    """Generate one shot through OpenMontage selectors using a per-call key context."""

    from tools.video.video_selector import VideoSelector

    project_path = Path(project_dir)
    character_lookup = {
        str(character.get("id")): character
        for character in series_bible.get("characters", [])
    }
    asset_lookup = {
        str(asset.get("id")): asset
        for asset in series_bible.get("assets", [])
    }
    prompt = compile_shot_prompt(
        shot,
        character_lookup,
        series_bible.get("style_lock"),
        asset_lookup,
    )
    shot_id = str(shot.get("id", "shot"))
    output_path = project_path / "assets" / "video" / f"{shot_id}.mp4"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if emit_event:
        emit_event("assets", "running", f"Generating video for {shot_id}")

    with _patched_environment(key_environment(video_key, base_url)):
        result = VideoSelector().execute(
            {
                "prompt": prompt,
                "preferred_provider": "syapi",
                "operation": "text_to_video",
                "model_variant": video_model,
                "aspect_ratio": str(shot.get("aspect_ratio", "9:16")),
                "duration": "5",
                "output_path": str(output_path),
            }
        )

    if not result.success:
        if emit_event:
            emit_event("assets", "failed", result.error or f"Generation failed for {shot_id}")
        raise RuntimeError(result.error or f"Generation failed for {shot_id}")

    if emit_event:
        emit_event("assets", "complete", f"Generated video for {shot_id}")

    return {
        "shot_id": shot_id,
        "output_path": result.data.get("output") or str(output_path),
        "tool_result": result.data,
        "cost_usd": result.cost_usd,
    }


def run_pipeline_handoff(
    *,
    project_dir: str | Path,
    series_bible: dict[str, Any],
    storyboard: dict[str, Any],
    gateway_key: str,
    base_url: str,
    render_runtime: RenderRuntime = "remotion",
    video_model: str = DEFAULT_VIDEO_MODEL,
    emit_event: Callable[[str, str, str], None] | None = None,
) -> dict[str, Any]:
    """Prepare artifacts and generate storyboard shots through existing selectors."""

    pipeline_inputs = build_pipeline_inputs(series_bible, storyboard, render_runtime, video_model)
    written = write_pipeline_artifacts(project_dir, pipeline_inputs)

    outputs = []
    for stage in ("proposal", "scene_plan", "assets", "edit"):
        if emit_event:
            emit_event(stage, "complete", f"Wrote {stage} handoff artifact")

    for shot in storyboard.get("shots", []):
        outputs.append(
            run_single_shot_generation(
                project_dir=project_dir,
                shot=shot,
                series_bible=series_bible,
                video_key=gateway_key,
                base_url=base_url,
                video_model=video_model,
                emit_event=emit_event,
            )
        )

    if emit_event:
        emit_event("compose", "queued", "Shot assets are ready for composition")

    return {
        "artifacts": {key: str(path) for key, path in written.items()},
        "outputs": outputs,
    }


def render_short_drama_project(
    *,
    project_dir: str | Path,
    series_bible: dict[str, Any],
    storyboard: dict[str, Any],
    video_key: str,
    base_url: str,
    video_model: str = DEFAULT_VIDEO_MODEL,
    render_runtime: RenderRuntime = "ffmpeg",
    emit_event: Callable[[str, str, str], None] | None = None,
) -> dict[str, Any]:
    project_path = Path(project_dir)
    pipeline_inputs = build_pipeline_inputs(series_bible, storyboard, render_runtime, video_model)
    written = write_pipeline_artifacts(project_path, pipeline_inputs)
    outputs: list[dict[str, Any]] = []

    for stage in ("proposal", "scene_plan", "edit"):
        if emit_event:
            emit_event(stage, "complete", f"Wrote {stage} handoff artifact")

    shots = sorted(storyboard.get("shots", []), key=lambda shot: int(shot.get("index", 0)))
    for shot in shots:
        shot["status"] = "generating"
        if emit_event:
            emit_event("assets", "running", f"Generating shot {shot.get('id')}")
        output = run_single_shot_generation(
            project_dir=project_path,
            shot=shot,
            series_bible=series_bible,
            video_key=video_key,
            base_url=base_url,
            video_model=video_model,
            emit_event=emit_event,
        )
        shot["status"] = "complete"
        shot["output_path"] = output["output_path"]
        shot["output_url"] = output["tool_result"].get("url")
        outputs.append(output)

    if emit_event:
        emit_event("compose", "running", "Composing final video")
    final_path = compose_final_video(project_path, storyboard)
    if emit_event:
        emit_event("compose", "complete", "Final video rendered")

    duration = 5 * len(shots)
    render_report = {
        "version": "1.0",
        "outputs": [
            {
                "path": str(final_path),
                "format": "mp4",
                "resolution": "720x1280",
                "duration_seconds": duration,
            }
        ],
        "warnings": [],
        "verification_notes": [
            "Rendered from generated storyboard shot videos with FFmpeg concat.",
        ],
        "render_grammar": "cinematic-trailer",
    }
    (project_path / "artifacts").mkdir(parents=True, exist_ok=True)
    (project_path / "artifacts" / "render_report.json").write_text(
        json.dumps(render_report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    return {
        "artifacts": {key: str(path) for key, path in written.items()},
        "outputs": outputs,
        "final_path": str(final_path),
        "render_report": render_report,
        "storyboard": storyboard,
    }


def compose_final_video(project_dir: str | Path, storyboard: dict[str, Any]) -> Path:
    project_path = Path(project_dir)
    output_path = project_path / "renders" / "final.mp4"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    shot_paths = [
        Path(str(shot.get("output_path")))
        for shot in sorted(storyboard.get("shots", []), key=lambda item: int(item.get("index", 0)))
        if shot.get("output_path")
    ]
    if not shot_paths:
        raise RuntimeError("No generated shot videos found to compose.")
    missing = [path for path in shot_paths if not path.exists()]
    if missing:
        raise RuntimeError(f"Generated shot video missing: {missing[0]}")

    concat_file = output_path.parent / "concat.txt"
    concat_file.write_text(
        "\n".join(f"file '{_ffmpeg_concat_path(path)}'" for path in shot_paths),
        encoding="utf-8",
    )
    cmd = [
        _resolve_ffmpeg_executable(),
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(concat_file),
        "-c",
        "copy",
        str(output_path),
    ]
    subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,
        check=True,
    )
    return output_path


def _build_proposal_packet(
    series_bible: dict[str, Any],
    shots: list[dict[str, Any]],
    render_runtime: RenderRuntime,
    video_model: str,
) -> dict[str, Any]:
    title = str(series_bible.get("title") or "Short Drama")
    stages = [
        {
            "stage": "proposal",
            "tools": [],
            "approach": "Use the approved short-drama storyboard as the creative contract.",
        },
        {
            "stage": "scene_plan",
            "tools": [],
            "approach": "Map each storyboard shot to one generated OpenMontage scene.",
        },
        {
            "stage": "assets",
            "tools": [
                {
                    "tool_name": "syapi_video",
                    "role": "Generate one vertical drama clip per shot",
                    "provider": "syapi",
                    "available": True,
                    "estimated_cost_usd": 0,
                    "model": video_model,
                    "why_this_provider": "The user supplied a dedicated SYAPI video key for generation.",
                }
            ],
            "approach": f"Generate shot video assets with per-job video key context and model={video_model}.",
        },
        {
            "stage": "edit",
            "tools": [],
            "approach": "Order generated clips according to the storyboard waterfall.",
        },
        {
            "stage": "compose",
            "tools": [
                {
                    "tool_name": "video_compose",
                    "role": "Compose final short drama render",
                    "provider": "openmontage",
                    "available": True,
                    "estimated_cost_usd": 0,
                    "why_this_provider": "Existing OpenMontage composition contract.",
                }
            ],
            "approach": f"Compose with locked render_runtime={render_runtime}.",
        },
    ]

    return {
        "version": "1.0",
        "concept_options": [
            _concept_option("c1", title, "The clue appears before the viewer can look away.", shots),
            _concept_option("c2", f"{title}: Betrayal Cut", "The ally looks guilty until the reversal lands.", shots),
            _concept_option("c3", f"{title}: Evidence Trail", "Every prop becomes a clue in the final turn.", shots),
        ],
        "selected_concept": {
            "concept_id": "c1",
            "rationale": "Selected from the workbench storyboard as the current production path.",
            "modifications": [],
        },
        "production_plan": {
            "pipeline": "cinematic",
            "playbook": "cinematic",
            "stages": stages,
            "quality_tradeoffs": [
                {
                    "tradeoff": "Mock storyboard speed vs real provider generation latency",
                    "recommendation": "Use real generation for selected shots after reviewing consistency.",
                    "quality_impact": "Keeps iteration fast while preserving the OpenMontage handoff path.",
                }
            ],
            "alternative_paths": [
                {
                    "description": "Single-shot generation before whole-episode render",
                    "total_cost_usd": 0,
                    "quality_level": "standard",
                    "what_changes": "Only selected shots consume provider calls.",
                }
            ],
            "delivery_promise": {
                "promise_type": "motion_led",
                "motion_required": True,
                "source_required": False,
                "tone_mode": "cinematic short drama",
                "quality_floor": "draft",
                "approved_fallback": None,
            },
            "renderer_family": "cinematic-trailer",
            "render_runtime": render_runtime,
            "composition_mode": "templated",
            "music_source": {"source_type": "none", "estimated_cost_usd": 0},
            "decision_log_ref": "artifacts/decision_log.json",
        },
        "cost_estimate": {
            "total_estimated_usd": 0,
            "line_items": [
                {
                    "tool": "syapi_video",
                    "model": video_model,
                    "operation": "shot video generation",
                    "quantity": len(shots),
                    "estimated_usd": 0,
                    "notes": "Actual gateway cost depends on SYAPI model variant and account pricing.",
                }
            ],
            "budget_verdict": "no_budget_set",
            "savings_options": ["Regenerate only failed or high-risk shots."],
        },
        "approval": {"status": "pending"},
        "metadata": {"source": "short-drama-workbench"},
    }


def _concept_option(
    concept_id: str,
    title: str,
    hook: str,
    shots: list[dict[str, Any]],
) -> dict[str, Any]:
    beats = [str(shot.get("beat", "story beat")) for shot in shots[:3]]
    while len(beats) < 2:
        beats.append("story reversal")
    return {
        "id": concept_id,
        "title": title,
        "hook": hook,
        "narrative_structure": "story",
        "visual_approach": "Vertical cinematic short-drama scenes with tight continuity locks.",
        "suggested_playbook": "cinematic",
        "target_audience": "short-drama viewers",
        "target_platform": "tiktok",
        "target_duration_seconds": max(len(shots), 1) * 5,
        "key_points": beats,
        "core_message": "The truth was visible from the first clue.",
        "cta": "Watch the next episode.",
        "tone": "suspenseful",
        "grounded_in": ["workbench_storyboard"],
        "why_this_works": "It converts the storyboard waterfall into a compact hook, escalation, and reversal.",
    }


def _narrative_role(index: int, total: int) -> str:
    if index == 0:
        return "establish_context"
    if index >= total - 1:
        return "resolution"
    if index >= total - 2:
        return "deliver_payload"
    return "build_tension"


def _ffmpeg_concat_path(path: Path) -> str:
    return str(path.resolve()).replace("\\", "/").replace("'", "'\\''")


def _resolve_ffmpeg_executable() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg

    bundled = _remotion_compositor_dir() / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if bundled.exists():
        return str(bundled)

    return "ffmpeg"


def _remotion_compositor_dir() -> Path:
    return (
        Path(__file__).resolve().parents[2]
        / "remotion-composer"
        / "node_modules"
        / "@remotion"
        / "compositor-win32-x64-msvc"
    )


@contextmanager
def _patched_environment(values: dict[str, str]) -> Iterator[None]:
    previous = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, old_value in previous.items():
            if old_value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old_value
