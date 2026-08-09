from __future__ import annotations

from typing import Any

from server.app.generation_units.schemas import GenerationExecutionSnapshot

from server.app.openmontage_runner import DEFAULT_VIDEO_MODEL, build_pipeline_inputs
from server.app.storage import WorkbenchStore

DEFAULT_RENDER_RUNTIME = "ffmpeg"


def sync_asset_shot_ids(assets: list[dict[str, Any]], storyboard: dict[str, Any]) -> list[dict[str, Any]]:
    shot_ids_by_asset: dict[str, list[str]] = {}
    available_shot_ids: set[str] = set()
    for shot in storyboard.get("shots", []):
        shot_id = str(shot.get("id"))
        available_shot_ids.add(shot_id)
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
        asset_id = str(asset.get("id"))
        forward_links = shot_ids_by_asset.get(asset_id)
        if forward_links is not None:
            next_asset["shot_ids"] = forward_links
        else:
            # Older generated storyboards can have an empty shot.asset_ids while
            # the resource correctly records its shots. Preserve only links to
            # shots that still exist instead of erasing that usable relationship.
            next_asset["shot_ids"] = [
                shot_id
                for value in (asset.get("shot_ids") or [])
                if (shot_id := str(value)) in available_shot_ids
            ]
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
    db=None,
) -> None:
    existing = {
        name: workbench.read_artifact(project_id, f"{name}.json") or {}
        for name in (
            "proposal_packet",
            "scene_plan",
            "asset_manifest",
            "edit_decisions",
        )
    }
    creative_workflow = workbench.read_artifact(project_id, "creative_workflow.json") or {}
    brief = creative_workflow.get("brief") if isinstance(creative_workflow, dict) else None
    try:
        target_duration = (
            int(brief["duration_seconds"])
            if isinstance(brief, dict)
            and brief.get("duration_seconds") not in (None, "")
            else None
        )
    except (TypeError, ValueError):
        target_duration = None
    project_aspect_ratio = (
        str(brief.get("aspect_ratio"))
        if isinstance(brief, dict) and brief.get("aspect_ratio")
        else None
    )
    # A creative target does not authorize evenly redistributing shot time.
    refresh_timeline = False
    pipeline_inputs = build_pipeline_inputs(
        series_bible,
        storyboard,
        continuity_plan=continuity_plan,
        render_runtime=render_runtime,  # type: ignore[arg-type]
        video_model=video_model,
        target_duration_seconds=target_duration,
        project_aspect_ratio=project_aspect_ratio,
        db=db,
    )
    generated_proposal = pipeline_inputs["proposal_packet"]
    pipeline_inputs["proposal_packet"] = _merge_mapping(
        generated_proposal,
        existing["proposal_packet"],
    )
    for generated_key in ("cost_estimate",):
        generated_value = generated_proposal.get(generated_key)
        if generated_value is not None:
            pipeline_inputs["proposal_packet"][generated_key] = generated_value
    production_plan = pipeline_inputs["proposal_packet"].setdefault(
        "production_plan", {}
    )
    production_plan["render_runtime"] = render_runtime
    generated_production_plan = generated_proposal.get("production_plan", {})
    if generated_production_plan.get("stages") is not None:
        production_plan["stages"] = generated_production_plan["stages"]
    pipeline_inputs["scene_plan"] = _merge_keyed_artifact(
        pipeline_inputs["scene_plan"],
        existing["scene_plan"],
        collection="scenes",
    )
    pipeline_inputs["asset_manifest"] = _merge_keyed_artifact(
        pipeline_inputs["asset_manifest"],
        existing["asset_manifest"],
        collection="assets",
    )
    pipeline_inputs["edit_decisions"] = _merge_edit_decisions(
        pipeline_inputs["edit_decisions"],
        existing["edit_decisions"],
        render_runtime=render_runtime,
        refresh_timeline=refresh_timeline,
    )
    for name, data in pipeline_inputs.items():
        workbench.write_artifact(project_id, f"{name}.json", data)


def write_generation_execution_snapshot(
    *,
    workbench: WorkbenchStore,
    snapshot: GenerationExecutionSnapshot,
) -> None:
    """Export the authoritative DB ledger for debugging and project snapshots."""
    workbench.write_artifact(
        snapshot.project_id,
        "generation_execution.json",
        snapshot.model_dump(mode="json"),
    )


def _merge_mapping(
    generated: dict[str, Any], existing: dict[str, Any]
) -> dict[str, Any]:
    merged = dict(generated)
    for key, value in existing.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge_mapping(merged[key], value)
        else:
            merged[key] = value
    return merged


def _merge_keyed_artifact(
    generated: dict[str, Any],
    existing: dict[str, Any],
    *,
    collection: str,
) -> dict[str, Any]:
    merged = _merge_mapping(existing, generated)
    generated_items = [
        item for item in generated.get(collection, []) if isinstance(item, dict)
    ]
    existing_by_id = {
        str(item.get("id")): item
        for item in existing.get(collection, [])
        if isinstance(item, dict) and item.get("id")
    }
    merged[collection] = [
        _merge_mapping(existing_by_id.get(str(item.get("id")), {}), item)
        for item in generated_items
    ]
    return merged


def _merge_edit_decisions(
    generated: dict[str, Any],
    existing: dict[str, Any],
    *,
    render_runtime: str,
    refresh_timeline: bool = False,
) -> dict[str, Any]:
    merged = _merge_mapping(generated, existing)
    existing_cuts = [
        cut for cut in existing.get("cuts", []) if isinstance(cut, dict)
    ]
    by_id = {
        str(cut.get("id")): cut for cut in existing_cuts if cut.get("id")
    }
    by_source = {
        str(cut.get("source")): cut
        for cut in existing_cuts
        if cut.get("source")
    }
    merged["cuts"] = []
    for cut in generated.get("cuts", []):
        if not isinstance(cut, dict):
            continue
        previous = by_id.get(str(cut.get("id"))) or by_source.get(
            str(cut.get("source"))
        )
        merged_cut = _merge_mapping(cut, previous or {})
        if refresh_timeline:
            for key in (
                "out_seconds",
                "source_out_seconds",
                "timeline_start_seconds",
                "timeline_duration_seconds",
            ):
                if key in cut:
                    merged_cut[key] = cut[key]
        merged["cuts"].append(merged_cut)
    merged["render_runtime"] = render_runtime
    total_duration = max(
        (
            float(cut.get("timeline_start_seconds", 0))
            + float(
                cut.get("timeline_duration_seconds")
                or float(cut.get("out_seconds", 0))
                - float(cut.get("in_seconds", 0))
            )
            for cut in merged["cuts"]
        ),
        default=0,
    )
    if refresh_timeline:
        total_duration = float(generated.get("total_duration_seconds") or total_duration)
    if total_duration > 0:
        merged["total_duration_seconds"] = total_duration
    else:
        merged.pop("total_duration_seconds", None)
    return merged
