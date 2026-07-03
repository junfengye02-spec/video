import json

from server.app.artifact_sync import read_workflow_settings, rewrite_workflow_artifacts, sync_asset_shot_ids
from server.app.storage import WorkbenchStore


def test_sync_asset_shot_ids_derives_links_from_storyboard():
    assets = [
        {"id": "asset-c1", "kind": "character", "label": "Lin", "shot_ids": []},
        {"id": "asset-prop", "kind": "prop", "label": "Envelope", "shot_ids": ["old"]},
    ]
    storyboard = {
        "shots": [
            {"id": "s1", "asset_ids": ["asset-c1", "asset-prop"]},
            {"id": "s2", "asset_ids": ["asset-c1"]},
        ]
    }

    synced = sync_asset_shot_ids(assets, storyboard)

    assert synced[0]["shot_ids"] == ["s1", "s2"]
    assert synced[1]["shot_ids"] == ["s1"]


def test_rewrite_workflow_artifacts_refreshes_scene_plan_after_shot_change(tmp_path):
    store = WorkbenchStore(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    project = store.create_project("Rain Alley", "short_drama")
    series_bible = {"characters": [], "assets": [], "style_lock": "rainy neon"}
    storyboard = {
        "shots": [
            {
                "id": "s1",
                "scene_id": "scene-1",
                "index": 1,
                "beat": "Hook",
                "prompt": "Updated prompt",
                "characters": [],
                "shot_language": {"shot_size": "wide"},
                "shot_intent": "Establish the alley.",
            }
        ]
    }

    rewrite_workflow_artifacts(
        workbench=store,
        project_id=project.id,
        series_bible=series_bible,
        storyboard=storyboard,
        render_runtime="ffmpeg",
        video_model="omni_flash-10s",
    )

    scene_plan = json.loads((store.artifact_dir(project.id) / "scene_plan.json").read_text(encoding="utf-8"))
    assert scene_plan["scenes"][0]["description"] == "Updated prompt"
    assert scene_plan["scenes"][0]["shot_language"]["shot_size"] == "wide"


def test_read_workflow_settings_prefers_existing_artifacts(tmp_path):
    store = WorkbenchStore(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    project = store.create_project("Rain Alley", "short_drama")
    store.write_artifact(project.id, "edit_decisions.json", {"render_runtime": "remotion"})
    store.write_artifact(project.id, "asset_manifest.json", {"assets": [{"model": "veo_3_1-lite"}]})
    store.write_artifact(project.id, "proposal_packet.json", {"cost_estimate": {"line_items": [{"model": "omni_flash-10s"}]}})

    settings = read_workflow_settings(store, project.id)

    assert settings == {"render_runtime": "remotion", "video_model": "veo_3_1-lite"}
