from __future__ import annotations

from typing import Any

from server.app.openmontage_runner import DEFAULT_VIDEO_MODEL, build_pipeline_inputs
from server.app.storage import WorkbenchStore

DEFAULT_RENDER_RUNTIME = "ffmpeg"


def sync_asset_shot_ids(assets: list[dict[str, Any]], storyboard: dict[str, Any]) -> list[dict[str, Any]]:
    shot_ids_by_asset: dict[str, list[str]] = {}
    for shot in storyboard.get("shots", []):
        shot_id = str(shot.get("id"))
        seen_asset_ids: set[str] = set()
        for asset_id in shot.get("asset_ids", []) or []:
            asset_key = str(asset_id)
            if asset_key in seen_asset_ids:
                continue
            seen_asset_ids.add(asset_key)
            shot_ids_by_asset.setdefault(asset_key, []).append(shot_id)

    synced = []
    for asset in assets:
        next_asset = dict(asset)
        next_asset["shot_ids"] = shot_ids_by_asset.get(str(asset.get("id")), [])
        synced.append(next_asset)
    return synced


def read_workflow_settings(
    workbench: WorkbenchStore,
    project_id: str,
    *,
    default_render_runtime: str = DEFAULT_RENDER_RUNTIME,
    default_video_model: str = DEFAULT_VIDEO_MODEL,
) -> dict[str, str]:
    edit_decisions = workbench.read_artifact(project_id, "edit_decisions.json") or {}
    asset_manifest = workbench.read_artifact(project_id, "asset_manifest.json") or {}
    proposal_packet = workbench.read_artifact(project_id, "proposal_packet.json") or {}
    production_plan = proposal_packet.get("production_plan", {})

    render_runtime = str(
        edit_decisions.get("render_runtime")
        or production_plan.get("render_runtime")
        or default_render_runtime
    )
    video_model = _read_video_model(asset_manifest, proposal_packet) or default_video_model
    return {"render_runtime": render_runtime, "video_model": video_model}


def _read_video_model(asset_manifest: dict[str, Any], proposal_packet: dict[str, Any]) -> str | None:
    for asset in asset_manifest.get("assets", []):
        model = asset.get("model")
        if model:
            return str(model)

    for line_item in proposal_packet.get("cost_estimate", {}).get("line_items", []):
        model = line_item.get("model")
        if model:
            return str(model)

    for stage in proposal_packet.get("production_plan", {}).get("stages", []):
        for tool in stage.get("tools", []):
            model = tool.get("model")
            if model:
                return str(model)

    return None


def rewrite_workflow_artifacts(
    *,
    workbench: WorkbenchStore,
    project_id: str,
    series_bible: dict[str, Any],
    storyboard: dict[str, Any],
    render_runtime: str,
    video_model: str,
    continuity_plan: dict[str, Any] | None = None,
) -> None:
    pipeline_inputs = build_pipeline_inputs(
        series_bible,
        storyboard,
        continuity_plan=continuity_plan,
        render_runtime=render_runtime,  # type: ignore[arg-type]
        video_model=video_model,
    )
    for name, data in pipeline_inputs.items():
        workbench.write_artifact(project_id, f"{name}.json", data)
