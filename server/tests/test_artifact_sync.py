import json

import pytest

from server.app.artifact_sync import read_workflow_settings, rewrite_workflow_artifacts, sync_asset_shot_ids
from server.app.storage import WorkbenchStore
from server.app.video_model_profiles import (
    VideoModelDurationConfiguration,
    video_model_profile as build_video_model_profile,
)


@pytest.fixture(autouse=True)
def verified_test_video_profiles(monkeypatch):
    def resolve(model_id, operation, *, provider="newapi", db=None):
        return build_video_model_profile(
            model_id,
            operation,
            provider=provider,
            duration_configuration=VideoModelDurationConfiguration(
                provider=provider,
                model_id=model_id,
                call_duration_seconds=10,
                version=1,
            ),
        )

    monkeypatch.setattr("server.app.openmontage_runner.video_model_profile", resolve)


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


def test_sync_asset_shot_ids_dedupes_repeated_asset_ids_per_shot():
    assets = [
        {"id": "asset-c1", "kind": "character", "label": "Lin", "shot_ids": []},
    ]
    storyboard = {
        "shots": [
            {"id": "s1", "asset_ids": ["asset-c1", "asset-c1"]},
            {"id": "s2", "asset_ids": ["asset-c1"]},
        ]
    }

    synced = sync_asset_shot_ids(assets, storyboard)

    assert synced[0]["shot_ids"] == ["s1", "s2"]


def test_sync_asset_shot_ids_preserves_valid_reverse_links_for_legacy_storyboards():
    assets = [
        {
            "id": "asset-c1",
            "kind": "character",
            "label": "Lin",
            "shot_ids": ["s1", "deleted-shot"],
        },
    ]
    storyboard = {"shots": [{"id": "s1", "asset_ids": []}]}

    synced = sync_asset_shot_ids(assets, storyboard)

    assert synced[0]["shot_ids"] == ["s1"]


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


def test_rewrite_workflow_artifacts_keeps_fixed_model_native_duration(tmp_path):
    store = WorkbenchStore(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    project = store.create_project("Twelve seconds", "short_drama")
    store.write_artifact(
        project.id,
        "creative_workflow.json",
        {"brief": {"duration_seconds": 12}},
    )

    rewrite_workflow_artifacts(
        workbench=store,
        project_id=project.id,
        series_bible={"characters": [], "assets": []},
        storyboard={
            "shots": [
                {"id": "s1", "index": 1, "characters": []},
                {"id": "s2", "index": 2, "characters": []},
                {"id": "s3", "index": 3, "characters": []},
            ]
        },
        render_runtime="ffmpeg",
        video_model="omni_flash-10s",
    )

    edits = store.read_artifact(project.id, "edit_decisions.json")
    assert edits is not None
    assert [cut["timeline_duration_seconds"] for cut in edits["cuts"]] == [10, 10, 10]
    assert edits["total_duration_seconds"] == 30


def test_rewrite_target_duration_does_not_replace_explicit_edit_timing(tmp_path):
    store = WorkbenchStore(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    project = store.create_project("Explicit timing", "short_drama")
    store.write_artifact(project.id, "creative_workflow.json", {"brief": {"duration_seconds": 12}})
    store.write_artifact(
        project.id,
        "edit_decisions.json",
        {
            "cuts": [{
                "id": "cut-s1",
                "source": "s1-video",
                "in_seconds": 1,
                "out_seconds": 4.5,
                "source_in_seconds": 1,
                "source_out_seconds": 4.5,
                "timeline_start_seconds": 0,
                "timeline_duration_seconds": 3.5,
            }]
        },
    )

    rewrite_workflow_artifacts(
        workbench=store,
        project_id=project.id,
        series_bible={"characters": [], "assets": []},
        storyboard={"shots": [{"id": "s1", "index": 1, "characters": [], "duration_seconds": 5}]},
        render_runtime="ffmpeg",
        video_model="omni_flash-10s",
    )

    edits = store.read_artifact(project.id, "edit_decisions.json")
    assert edits is not None
    assert edits["cuts"][0]["timeline_duration_seconds"] == 3.5


def test_read_workflow_settings_prefers_existing_artifacts(tmp_path):
    store = WorkbenchStore(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    project = store.create_project("Rain Alley", "short_drama")
    store.write_artifact(project.id, "edit_decisions.json", {"render_runtime": "remotion"})
    store.write_artifact(project.id, "asset_manifest.json", {"assets": [{"model": "veo_3_1-lite"}]})
    store.write_artifact(project.id, "proposal_packet.json", {"cost_estimate": {"line_items": [{"model": "omni_flash-10s"}]}})

    settings = read_workflow_settings(store, project.id)

    assert settings == {"render_runtime": "remotion", "video_model": "veo_3_1-lite"}


def test_rewrite_preserves_manual_edit_and_audio_decisions(tmp_path):
    store = WorkbenchStore(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    project = store.create_project("Rain Alley", "short_drama")
    storyboard = {
        "shots": [
            {
                "id": "s1",
                "index": 1,
                "duration_seconds": 5,
                "prompt": "Updated prompt",
                "characters": [],
            }
        ]
    }
    store.write_artifact(
        project.id,
        "edit_decisions.json",
        {
            "version": "1.0",
            "render_runtime": "ffmpeg",
            "cuts": [
                {
                    "id": "cut-s1",
                    "source": "s1-video",
                    "in_seconds": 1,
                    "out_seconds": 4.5,
                    "source_in_seconds": 1,
                    "source_out_seconds": 4.5,
                    "timeline_start_seconds": 0,
                    "timeline_duration_seconds": 3.5,
                    "transition_in": "cut",
                    "transition_out": "fade_through_black",
                    "transition_duration": 0.4,
                    "source_audio": {"policy": "mix", "volume": 0.85},
                }
            ],
            "audio": {
                "source": {"default_policy": "preserve", "default_volume": 1},
                "target_lufs": -16,
            },
        },
    )

    rewrite_workflow_artifacts(
        workbench=store,
        project_id=project.id,
        series_bible={"characters": [], "assets": []},
        storyboard=storyboard,
        render_runtime="remotion",
        video_model="omni_flash-10s",
    )

    edits = store.read_artifact(project.id, "edit_decisions.json")
    assert edits is not None
    assert edits["render_runtime"] == "remotion"
    assert edits["cuts"][0]["source_in_seconds"] == 1
    assert edits["cuts"][0]["timeline_duration_seconds"] == 3.5
    assert edits["cuts"][0]["transition_out"] == "fade_through_black"
    assert edits["cuts"][0]["source_audio"] == {"policy": "mix", "volume": 0.85}
    assert edits["audio"]["target_lufs"] == -16
