import json
import os

import pytest

from server.app.billing.service import ProviderPricingUnavailable
from server.app.video_model_profiles import (
    VideoModelDurationConfiguration,
    VideoModelProfile,
    video_model_profile as build_video_model_profile,
)
from server.app.openmontage_runner import (
    _scope_edit_decisions_to_storyboard,
    build_pipeline_inputs,
    build_video_selector_inputs,
    compile_shot_prompt,
    compose_final_video,
    prepare_billed_shot_request,
    prepare_video_generation_request,
    render_short_drama_project,
    run_single_shot_generation,
    write_pipeline_artifacts,
)


@pytest.fixture(autouse=True)
def verified_test_video_profiles(monkeypatch):
    def resolve(model_id, operation, *, provider="newapi", db=None):
        if model_id in {"omni_flash-10s", "sora_v2"}:
            duration = 10 if model_id == "omni_flash-10s" else 12
            return build_video_model_profile(
                model_id,
                operation,
                provider=provider,
                duration_configuration=VideoModelDurationConfiguration(
                    provider=provider,
                    model_id=model_id,
                    call_duration_seconds=duration,
                    version=1,
                ),
            )
        if model_id in {"veo_3_1-lite", "veo_3_1-fast-fl", "video-model"}:
            return VideoModelProfile(
                provider=provider,
                model_id=model_id,
                operation=operation,
                duration_mode="flexible",
                min_duration_seconds=1,
                max_duration_seconds=60,
                contract_source="verified_override",
                profile_revision="test-flexible-v1",
            )
        return build_video_model_profile(model_id, operation, provider=provider)

    monkeypatch.setattr("server.app.openmontage_runner.video_model_profile", resolve)


def _write_keyframe(tmp_path, name):
    path = tmp_path / "assets" / "images" / "generated" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"image")
    return path


def test_selector_inputs_use_explicit_first_last_fields_only_for_capable_provider(tmp_path):
    first = _write_keyframe(tmp_path, "first.png")
    last = _write_keyframe(tmp_path, "last.png")
    shot = {
        "id": "s2",
        "continuity": {
            "mode": "carry",
            "first_frame": {"asset_id": "first", "status": "ready"},
            "last_frame": {"asset_id": "last", "status": "ready"},
        },
    }
    inputs = build_video_selector_inputs(
        project_dir=tmp_path,
        shot=shot,
        prompt="continue the action",
        video_model="veo_3_1-fast-fl",
        output_path=tmp_path / "assets" / "video" / "s2.mp4",
        asset_lookup={
            "first": {"reference_images": ["assets/images/generated/first.png"]},
            "last": {"reference_images": ["assets/images/generated/last.png"]},
        },
        providers=[{"supports": {"first_last_frame_to_video": True}}],
    )

    assert inputs["operation"] == "first_last_frame_to_video"
    assert inputs["first_frame_path"] == str(first.resolve())
    assert inputs["last_frame_path"] == str(last.resolve())
    assert "reference_image_paths" not in inputs


def test_selector_inputs_inherit_project_aspect_ratio_and_generation_size(tmp_path):
    inputs = build_video_selector_inputs(
        project_dir=tmp_path,
        shot={"id": "s1"},
        prompt="wide establishing shot",
        video_model="omni_flash-10s",
        output_path=tmp_path / "assets" / "video" / "s1.mp4",
        asset_lookup={},
        project_aspect_ratio="16:9",
    )

    assert inputs["aspect_ratio"] == "16:9"
    assert inputs["size"] == "1280x720"


def test_explicit_shot_aspect_ratio_overrides_project_default(tmp_path):
    inputs = build_video_selector_inputs(
        project_dir=tmp_path,
        shot={"id": "s1", "aspect_ratio": "1:1"},
        prompt="square insert shot",
        video_model="omni_flash-10s",
        output_path=tmp_path / "assets" / "video" / "s1.mp4",
        asset_lookup={},
        project_aspect_ratio="16:9",
    )

    assert inputs["aspect_ratio"] == "1:1"
    assert inputs["size"] == "1080x1080"


def test_selector_inputs_degrade_first_last_to_honest_reference_operation(tmp_path):
    first = _write_keyframe(tmp_path, "first.png")
    last = _write_keyframe(tmp_path, "last.png")
    ordinary = _write_keyframe(tmp_path, "ordinary.png")
    inputs = build_video_selector_inputs(
        project_dir=tmp_path,
        shot={
            "id": "s2",
            "asset_ids": ["ordinary"],
            "continuity": {
                "mode": "carry",
                "first_frame": {"asset_id": "first", "status": "ready"},
                "last_frame": {"asset_id": "last", "status": "ready"},
            },
        },
        prompt="continue the action",
        video_model="omni_flash-10s",
        output_path=tmp_path / "assets" / "video" / "s2.mp4",
        asset_lookup={
            "first": {"reference_images": ["assets/images/generated/first.png"]},
            "last": {"reference_images": ["assets/images/generated/last.png"]},
            "ordinary": {"reference_images": ["assets/images/generated/ordinary.png"]},
        },
        providers=[{"supports": {"reference_to_video": True}}],
    )

    assert inputs["operation"] == "reference_to_video"
    assert inputs["degraded_from_operation"] == "first_last_frame_to_video"
    assert inputs["reference_image_paths"] == [
        str(first.resolve()),
        str(last.resolve()),
        str(ordinary.resolve()),
    ]
    assert inputs["frame_reference_roles"] == ["start_frame", "end_frame"]
    assert inputs["asset_reference_roles"] == [
        {
            "image_index": 3,
            "asset_id": "ordinary",
            "kind": "asset",
            "label": "ordinary",
        }
    ]
    assert "first_frame_path" not in inputs


def test_user_first_frame_precedes_inherited_and_ordinary_references(tmp_path):
    user = _write_keyframe(tmp_path, "user.png")
    inherited = _write_keyframe(tmp_path, "inherited.png")
    ordinary = _write_keyframe(tmp_path, "ordinary.png")
    assets = {
        "user": {"reference_images": ["assets/images/generated/user.png"]},
        "inherited": {"reference_images": ["assets/images/generated/inherited.png"]},
        "ordinary": {"reference_images": ["assets/images/generated/ordinary.png"]},
    }
    base_shot = {
        "id": "s2",
        "asset_ids": ["ordinary"],
        "continuity": {
            "mode": "carry",
            "inherit_previous_tail": True,
            "explicit_user_first_frame_asset_id": "user",
            "inherited_first_frame_asset_id": "inherited",
        },
    }

    explicit = build_video_selector_inputs(
        project_dir=tmp_path,
        shot=base_shot,
        prompt="continue",
        video_model="omni_flash-10s",
        output_path=tmp_path / "assets" / "video" / "s2.mp4",
        asset_lookup=assets,
        providers=[{"supports": {"reference_to_video": True}}],
    )
    inherited_fallback = build_video_selector_inputs(
        project_dir=tmp_path,
        shot={
            **base_shot,
            "continuity": {
                **base_shot["continuity"],
                "explicit_user_first_frame_asset_id": None,
            },
        },
        prompt="continue",
        video_model="omni_flash-10s",
        output_path=tmp_path / "assets" / "video" / "s2.mp4",
        asset_lookup=assets,
        providers=[{"supports": {"reference_to_video": True}}],
    )

    assert explicit["reference_image_paths"] == [str(user.resolve()), str(ordinary.resolve())]
    assert explicit["referenced_asset_ids"] == ["user", "ordinary"]
    assert explicit["frame_reference_roles"] == ["start_frame"]
    assert str(inherited.resolve()) not in explicit["reference_image_paths"]
    assert inherited_fallback["reference_image_paths"] == [
        str(inherited.resolve()),
        str(ordinary.resolve()),
    ]
    assert inherited_fallback["frame_reference_roles"] == ["start_frame"]


def test_single_effective_first_frame_uses_image_to_video_when_supported(tmp_path):
    first = _write_keyframe(tmp_path, "first.png")
    inputs = build_video_selector_inputs(
        project_dir=tmp_path,
        shot={
            "id": "s2",
            "continuity": {"explicit_user_first_frame_asset_id": "first"},
        },
        prompt="continue",
        video_model="omni_flash-10s",
        output_path=tmp_path / "assets" / "video" / "s2.mp4",
        asset_lookup={
            "first": {"reference_images": ["assets/images/generated/first.png"]},
        },
        providers=[{"supports": {"image_to_video": True}}],
    )

    assert inputs["operation"] == "image_to_video"
    assert inputs["reference_image_path"] == str(first.resolve())
    assert inputs["referenced_asset_ids"] == ["first"]


def test_billed_newapi_request_separates_boundary_and_character_image_roles(tmp_path):
    _write_keyframe(tmp_path, "first.png")
    _write_keyframe(tmp_path, "last.png")
    _write_keyframe(tmp_path, "ordinary.png")
    request = prepare_billed_shot_request(
        project_dir=tmp_path,
        shot={
            "id": "s2",
            "asset_ids": ["ordinary"],
            "prompt": "Lin crosses the room.",
            "continuity": {
                "mode": "carry",
                "first_frame": {"asset_id": "first", "status": "ready"},
                "last_frame": {"asset_id": "last", "status": "ready"},
            },
        },
        series_bible={
            "characters": [],
            "assets": [
                {"id": "first", "reference_images": ["assets/images/generated/first.png"]},
                {"id": "last", "reference_images": ["assets/images/generated/last.png"]},
                {
                    "id": "ordinary",
                    "label": "unrelated character board",
                    "kind": "character",
                    "reference_images": ["assets/images/generated/ordinary.png"],
                },
            ],
        },
    )

    body = json.loads(request.content)
    assert len(body["images"]) == 3
    assert "ATTACHED IMAGE 1 = START FRAME GUIDE" in body["prompt"]
    assert "ATTACHED IMAGE 2 = END FRAME GUIDE" in body["prompt"]
    assert (
        "ATTACHED IMAGE 3 = CHARACTER IDENTITY REFERENCE for unrelated character board"
        in body["prompt"]
    )
    assert "Never swap, merge, or average the two image roles" in body["prompt"]
    assert "ordinary.png" not in body["prompt"]
    assert "Ignore that image's pose, background, camera" in body["prompt"]


def test_billed_newapi_request_guides_single_start_frame(tmp_path):
    _write_keyframe(tmp_path, "first.png")

    request = prepare_billed_shot_request(
        project_dir=tmp_path,
        shot={
            "id": "s2",
            "prompt": "Continue the movement.",
            "continuity": {
                "mode": "carry",
                "inherit_previous_tail": True,
                "first_frame": {
                    "asset_id": "first",
                    "status": "ready",
                    "source": "inherited",
                },
            },
        },
        series_bible={
            "characters": [],
            "assets": [
                {"id": "first", "reference_images": ["assets/images/generated/first.png"]},
            ],
        },
    )

    body = json.loads(request.content)
    assert len(body["images"]) == 1
    assert "ATTACHED IMAGE 1 = START FRAME GUIDE" in body["prompt"]
    assert "END FRAME GUIDE" not in body["prompt"]


def test_billed_start_frame_assigns_scene_and_prop_images_narrow_roles(tmp_path):
    _write_keyframe(tmp_path, "first.png")
    _write_keyframe(tmp_path, "station.png")
    _write_keyframe(tmp_path, "station-alt.png")
    _write_keyframe(tmp_path, "case.png")

    request = prepare_billed_shot_request(
        project_dir=tmp_path,
        shot={
            "id": "s2",
            "asset_ids": ["station", "case"],
            "prompt": "Lin opens the case in the station.",
            "continuity": {
                "mode": "carry",
                "first_frame": {"asset_id": "first", "status": "ready"},
            },
        },
        series_bible={
            "characters": [],
            "assets": [
                {"id": "first", "reference_images": ["assets/images/generated/first.png"]},
                {
                    "id": "station",
                    "kind": "scene",
                    "label": "Central Station",
                    "reference_images": [
                        "assets/images/generated/station.png",
                        "assets/images/generated/station-alt.png",
                    ],
                },
                {
                    "id": "case",
                    "kind": "prop",
                    "label": "sealed case",
                    "reference_images": ["assets/images/generated/case.png"],
                },
            ],
        },
    )

    body = json.loads(request.content)
    assert len(body["images"]) == 4
    assert "ATTACHED IMAGE 1 = START FRAME GUIDE" in body["prompt"]
    assert "ATTACHED IMAGE 2 = SCENE IDENTITY REFERENCE for Central Station" in body["prompt"]
    assert "ATTACHED IMAGE 3 = PROP APPEARANCE REFERENCE for sealed case" in body["prompt"]
    assert "ATTACHED IMAGE 4 = SCENE IDENTITY REFERENCE for Central Station" in body["prompt"]
    assert "station.png" not in body["prompt"]
    assert "station-alt.png" not in body["prompt"]
    assert "case.png" not in body["prompt"]


def test_billed_request_includes_all_assets_linked_back_to_the_current_shot(tmp_path):
    _write_keyframe(tmp_path, "first.png")
    _write_keyframe(tmp_path, "hero.png")
    _write_keyframe(tmp_path, "station.png")
    _write_keyframe(tmp_path, "case.png")
    _write_keyframe(tmp_path, "other-shot.png")

    request = prepare_billed_shot_request(
        project_dir=tmp_path,
        shot={
            "id": "s2",
            "prompt": "The hero opens the case in the station.",
            "continuity": {
                "mode": "carry",
                "first_frame": {"asset_id": "first", "status": "ready"},
            },
        },
        series_bible={
            "characters": [],
            "assets": [
                {
                    "id": "first",
                    "reference_images": ["assets/images/generated/first.png"],
                },
                {
                    "id": "hero",
                    "kind": "character",
                    "label": "the hero",
                    "shot_ids": ["s2"],
                    "reference_images": ["assets/images/generated/hero.png"],
                },
                {
                    "id": "station",
                    "kind": "scene",
                    "label": "Central Station",
                    "shot_ids": ["s2"],
                    "reference_images": ["assets/images/generated/station.png"],
                },
                {
                    "id": "case",
                    "kind": "prop",
                    "label": "sealed case",
                    "shot_ids": ["s2"],
                    "reference_images": ["assets/images/generated/case.png"],
                },
                {
                    "id": "unrelated",
                    "kind": "prop",
                    "label": "other shot prop",
                    "shot_ids": ["s9"],
                    "reference_images": ["assets/images/generated/other-shot.png"],
                },
            ],
        },
    )

    body = json.loads(request.content)
    assert len(body["images"]) == 4
    assert "ATTACHED IMAGE 1 = START FRAME GUIDE" in body["prompt"]
    assert "ATTACHED IMAGE 2 = CHARACTER IDENTITY REFERENCE for the hero" in body["prompt"]
    assert "ATTACHED IMAGE 3 = SCENE IDENTITY REFERENCE for Central Station" in body["prompt"]
    assert "ATTACHED IMAGE 4 = PROP APPEARANCE REFERENCE for sealed case" in body["prompt"]
    assert "other shot prop" not in body["prompt"]


def test_provider_declared_reference_image_limit_is_honored(tmp_path):
    first = _write_keyframe(tmp_path, "first.png")
    station = _write_keyframe(tmp_path, "station.png")
    case = _write_keyframe(tmp_path, "case.png")
    extra = _write_keyframe(tmp_path, "extra.png")

    inputs = build_video_selector_inputs(
        project_dir=tmp_path,
        shot={
            "id": "s2",
            "asset_ids": ["station", "case", "extra"],
            "continuity": {
                "mode": "carry",
                "first_frame": {"asset_id": "first", "status": "ready"},
            },
        },
        prompt="Continue the action.",
        video_model="omni_flash-10s",
        output_path=tmp_path / "assets" / "video" / "s2.mp4",
        asset_lookup={
            "first": {"reference_images": ["assets/images/generated/first.png"]},
            "station": {
                "kind": "scene",
                "reference_images": ["assets/images/generated/station.png"],
            },
            "case": {
                "kind": "prop",
                "reference_images": ["assets/images/generated/case.png"],
            },
            "extra": {
                "kind": "prop",
                "reference_images": ["assets/images/generated/extra.png"],
            },
        },
        providers=[
            {
                "supports": {"reference_to_video": True},
                "max_reference_images": 3,
            }
        ],
    )

    assert inputs["reference_image_paths"] == [
        str(first.resolve()),
        str(station.resolve()),
        str(case.resolve()),
    ]
    assert str(extra.resolve()) not in inputs["reference_image_paths"]


def test_compile_shot_prompt_includes_carry_locks():
    prompt = compile_shot_prompt(
        {
            "prompt": "Lin exits the room.",
            "characters": [],
            "continuity": {
                "mode": "carry",
                "motion_direction": "screen-left to screen-right",
                "subject_pose": "running with the envelope in her right hand",
                "gaze": "toward the stairwell",
                "lighting": "window light from camera left",
                "scene_state": "door open behind her",
            },
        },
        character_lookup={},
        style_lock=None,
    )

    assert "Continuity locks:" in prompt
    assert "Do not reverse the established motion direction" in prompt


def test_prepare_video_generation_request_freezes_exact_server_payload():
    request = prepare_video_generation_request(
        model="omni_flash-10s",
        prompt="Lin runs",
        size="720x1280",
        seconds=4,
        images=["data:image/png;base64,aW1hZ2U="],
    )

    assert request.path == "/v1/videos"
    assert request.content == (
        b'{"images":["data:image/png;base64,aW1hZ2U="],"model":"omni_flash-10s",'
        b'"prompt":"Lin runs","seconds":"4","size":"720x1280"}'
    )
    assert b"key" not in request.content.lower()
    assert b"base_url" not in request.content.lower()


def test_render_uses_one_billed_callback_per_missing_shot_and_reuses_existing(tmp_path, monkeypatch):
    existing = tmp_path / "assets" / "video" / "s1.mp4"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"existing")
    generated = []
    storyboard = {
        "shots": [
            {"id": "s1", "index": 1, "output_path": str(existing), "output_url": None},
            {"id": "s2", "index": 2, "prompt": "two", "characters": []},
            {"id": "s3", "index": 3, "prompt": "three", "characters": []},
        ]
    }

    def generate_missing_shot(shot):
        generated.append(shot["id"])
        path = tmp_path / "assets" / "video" / f"{shot['id']}.mp4"
        path.write_bytes(shot["id"].encode())
        return {
            "shot_id": shot["id"],
            "output_path": str(path),
            "tool_result": {"billing_job_id": f"job-{shot['id']}"},
            "cost_usd": 0.0,
        }

    monkeypatch.setattr(
        "server.app.openmontage_runner.compose_final_video",
        lambda project_dir, storyboard: existing,
    )
    result = render_short_drama_project(
        project_dir=tmp_path,
        series_bible={"characters": []},
        storyboard=storyboard,
        generate_missing_shot=generate_missing_shot,
    )

    assert generated == ["s2", "s3"]
    assert [item["shot_id"] for item in result["outputs"]] == ["s1", "s2", "s3"]


def test_render_regenerates_stale_shot_even_when_previous_video_exists(
    tmp_path, monkeypatch
):
    existing = tmp_path / "assets" / "video" / "s1.mp4"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"old video")
    storyboard = {
        "shots": [
            {
                "id": "s1",
                "index": 1,
                "status": "stale",
                "output_path": str(existing),
                "output_url": None,
            }
        ]
    }
    generated = []

    def generate_missing_shot(shot):
        generated.append(shot["id"])
        existing.write_bytes(b"new video")
        return {
            "shot_id": shot["id"],
            "output_path": str(existing),
            "tool_result": {"url": None},
            "cost_usd": 0.0,
        }

    monkeypatch.setattr(
        "server.app.openmontage_runner.compose_final_video",
        lambda project_dir, storyboard: existing,
    )

    result = render_short_drama_project(
        project_dir=tmp_path,
        series_bible={"characters": []},
        storyboard=storyboard,
        generate_missing_shot=generate_missing_shot,
    )

    assert generated == ["s1"]
    assert existing.read_bytes() == b"new video"
    assert storyboard["shots"][0]["status"] == "complete"
    assert result["outputs"][0]["tool_result"]["url"] is None


def test_render_preserves_successful_children_when_another_child_fails_no_charge(
    tmp_path, monkeypatch
):
    storyboard = {
        "shots": [
            {"id": "s1", "index": 1, "prompt": "one", "characters": []},
            {"id": "s2", "index": 2, "prompt": "two", "characters": []},
        ]
    }

    def generate_missing_shot(shot):
        if shot["id"] == "s2":
            raise ProviderPricingUnavailable("no price")
        path = tmp_path / "assets" / "video" / "s1.mp4"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"success")
        return {
            "shot_id": "s1",
            "output_path": str(path),
            "tool_result": {"billing_job_id": "a" * 32},
            "cost_usd": 0.0,
        }

    monkeypatch.setattr(
        "server.app.openmontage_runner.compose_final_video",
        lambda project_dir, storyboard: tmp_path / "assets" / "video" / "s1.mp4",
    )
    result = render_short_drama_project(
        project_dir=tmp_path,
        series_bible={"characters": []},
        storyboard=storyboard,
        generate_missing_shot=generate_missing_shot,
    )

    assert storyboard["shots"][0]["status"] == "complete"
    assert storyboard["shots"][1]["status"] == "failed"
    assert result["partial_failure"] is True
    assert [item["shot_id"] for item in result["outputs"]] == ["s1"]



def test_build_pipeline_inputs_maps_storyboard_to_openmontage_artifacts():
    series_bible = {"characters": [{"id": "c1", "name": "Lin", "visual_lock": "red coat"}]}
    storyboard = {"shots": [{"id": "s1", "prompt": "Lin in red coat runs", "characters": ["c1"]}]}

    result = build_pipeline_inputs(series_bible, storyboard, render_runtime="remotion")

    assert result["scene_plan"]["scenes"][0]["description"] == "Lin in red coat runs"
    assert result["proposal_packet"]["production_plan"]["render_runtime"] == "remotion"


def test_build_pipeline_inputs_records_project_aspect_ratio():
    result = build_pipeline_inputs(
        {"characters": []},
        {"shots": [{"id": "s1", "characters": []}]},
        project_aspect_ratio="16:9",
    )

    assert result["scene_plan"]["scenes"][0]["metadata"]["aspect_ratio"] == "16:9"
    assert result["asset_manifest"]["assets"][0]["resolution"] == "1280x720"


def test_build_pipeline_inputs_uses_fixed_model_duration_over_legacy_storyboard_values():
    storyboard = {
        "shots": [
            {"id": "s1", "index": 1, "duration_seconds": 4, "characters": []},
            {"id": "s2", "index": 2, "duration_seconds": 6, "characters": []},
        ]
    }

    result = build_pipeline_inputs({"characters": []}, storyboard)

    scenes = result["scene_plan"]["scenes"]
    assert [(scene["start_seconds"], scene["end_seconds"]) for scene in scenes] == [
        (0, 10),
        (10, 20),
    ]
    assert [
        asset["requested_duration_seconds"]
        for asset in result["asset_manifest"]["assets"]
    ] == [
        10,
        10,
    ]
    assert all(
        "duration_seconds" not in asset
        for asset in result["asset_manifest"]["assets"]
    )
    assert [cut["out_seconds"] for cut in result["edit_decisions"]["cuts"]] == [10, 10]
    assert result["proposal_packet"]["concept_options"][0]["target_duration_seconds"] == 20


def test_scoped_edit_decisions_remove_unselected_cuts_and_rebase_the_timeline():
    storyboard = {
        "shots": [
            {"id": "s1", "index": 1, "duration_seconds": 4, "characters": []},
            {"id": "s2", "index": 2, "duration_seconds": 6, "characters": []},
            {"id": "s3", "index": 3, "duration_seconds": 3, "characters": []},
        ]
    }
    inputs = build_pipeline_inputs({"characters": []}, storyboard)

    scoped = _scope_edit_decisions_to_storyboard(
        inputs["edit_decisions"],
        {"shots": [storyboard["shots"][0], storyboard["shots"][2]]},
    )

    assert [cut["id"] for cut in scoped["cuts"]] == ["cut-s1", "cut-s3"]
    assert [cut["timeline_start_seconds"] for cut in scoped["cuts"]] == [0, 10]
    assert scoped["total_duration_seconds"] == 20


def test_build_pipeline_inputs_does_not_distribute_brief_duration_across_shots():
    storyboard = {
        "shots": [
            {"id": "s1", "index": 1, "characters": []},
            {"id": "s2", "index": 2, "characters": []},
            {"id": "s3", "index": 3, "characters": []},
        ]
    }

    result = build_pipeline_inputs(
        {"characters": []}, storyboard, target_duration_seconds=12
    )

    assert [cut["timeline_duration_seconds"] for cut in result["edit_decisions"]["cuts"]] == [10, 10, 10]
    assert result["edit_decisions"]["total_duration_seconds"] == 30
    assert result["proposal_packet"]["concept_options"][0]["target_duration_seconds"] == 30


def test_build_pipeline_inputs_does_not_mix_legacy_duration_with_fixed_model_duration():
    storyboard = {
        "shots": [
            {"id": "s1", "index": 1, "duration_seconds": 5, "characters": []},
            {"id": "s2", "index": 2, "characters": []},
        ]
    }

    result = build_pipeline_inputs(
        {"characters": []}, storyboard, target_duration_seconds=12
    )

    assert [cut["timeline_duration_seconds"] for cut in result["edit_decisions"]["cuts"]] == [10, 10]


def test_build_pipeline_inputs_includes_shot_asset_references():
    series_bible = {
        "characters": [{"id": "c1", "name": "Lin", "visual_lock": "red coat"}],
        "assets": [
            {
                "id": "asset-c1-ref",
                "kind": "character",
                "label": "Lin reference",
                "reference_images": ["projects/p1/assets/images/characters/c1.png"],
            }
        ],
    }
    storyboard = {
        "shots": [
            {
                "id": "s1",
                "prompt": "Lin runs",
                "characters": ["c1"],
                "asset_ids": ["asset-c1-ref"],
            }
        ]
    }

    result = build_pipeline_inputs(series_bible, storyboard)

    prompt = result["asset_manifest"]["assets"][0]["prompt"]
    assert "projects/p1/assets/images/characters/c1.png" in prompt


def test_build_pipeline_inputs_includes_continuity_plan_keyword():
    continuity_plan = {
        "project_type": "mini_series",
        "series_bible": {"worldview": "Rainy noir."},
        "episodes": [{"episode_number": 1, "goal": "Open the mystery."}],
    }

    result = build_pipeline_inputs(
        {"characters": []},
        {"shots": []},
        continuity_plan=continuity_plan,
        render_runtime="ffmpeg",
    )

    assert result["continuity_plan"] == continuity_plan
    assert result["edit_decisions"]["render_runtime"] == "ffmpeg"


def test_write_pipeline_artifacts_writes_openmontage_json_files(tmp_path):
    pipeline_inputs = build_pipeline_inputs(
        {"characters": [{"id": "c1", "name": "Lin", "visual_lock": "red coat"}]},
        {"shots": [{"id": "s1", "prompt": "Lin in red coat runs", "characters": ["c1"]}]},
        render_runtime="remotion",
    )

    paths = write_pipeline_artifacts(tmp_path, pipeline_inputs)

    assert paths["scene_plan"].name == "scene_plan.json"
    assert json.loads(paths["proposal_packet"].read_text(encoding="utf-8"))["version"] == "1.0"


def test_compose_final_video_uses_generated_shot_outputs(tmp_path, monkeypatch):
    from server.app import openmontage_runner as runner

    shot_video = tmp_path / "assets" / "video" / "s1.mp4"
    shot_video.parent.mkdir(parents=True)
    shot_video.write_bytes(b"fake shot")
    storyboard = {"shots": [{"id": "s1", "output_path": str(shot_video)}]}

    def fake_run(cmd, capture_output, text, encoding, errors, timeout, check):
        output = tmp_path / "renders" / "final.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"fake final")

        class Proc:
            stdout = ""
            stderr = ""

        return Proc()

    monkeypatch.setattr("server.app.openmontage_runner.subprocess.run", fake_run)
    monkeypatch.setattr(
        runner,
        "_probe_compose_input",
        lambda _path: {"has_audio": False, "duration_seconds": 10.0},
    )

    final_path = compose_final_video(tmp_path, storyboard)

    assert final_path.name == "final.mp4"
    assert final_path.exists()


def test_compose_final_video_normalizes_and_reencodes_inputs(tmp_path, monkeypatch):
    from server.app import openmontage_runner as runner

    first = tmp_path / "assets" / "video" / "s1.mp4"
    second = tmp_path / "assets" / "video" / "s2.mp4"
    first.parent.mkdir(parents=True)
    first.write_bytes(b"first")
    second.write_bytes(b"second")
    storyboard = {
        "shots": [
            {"id": "s1", "index": 1, "output_path": str(first)},
            {"id": "s2", "index": 2, "output_path": str(second)},
        ]
    }
    captured = {}

    def fake_run(cmd, capture_output, text, encoding, errors, timeout, check):
        captured["cmd"] = cmd
        output = tmp_path / "renders" / "final.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"fake final")

        class Proc:
            stdout = ""
            stderr = ""

        return Proc()

    monkeypatch.setattr("server.app.openmontage_runner.subprocess.run", fake_run)
    monkeypatch.setattr(
        runner,
        "_probe_compose_input",
        lambda _path: {"has_audio": False, "duration_seconds": 10.0},
    )

    compose_final_video(tmp_path, storyboard)

    cmd = captured["cmd"]
    assert cmd.count("-i") == 2
    assert "-filter_complex" in cmd
    assert "scale=1080:1920" in cmd[cmd.index("-filter_complex") + 1]
    assert "concat=n=2:v=1:a=0" in cmd[cmd.index("-filter_complex") + 1]
    assert "libx264" in cmd
    assert not any(cmd[index:index + 2] == ["-c", "copy"] for index in range(len(cmd) - 1))


def test_compose_final_video_uses_remotion_bundled_ffmpeg_when_path_missing(tmp_path, monkeypatch):
    from server.app import openmontage_runner as runner

    bundled_dir = tmp_path / "remotion-ffmpeg"
    bundled_dir.mkdir()
    bundled_ffmpeg = bundled_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    bundled_ffmpeg.write_bytes(b"fake ffmpeg")

    shot_video = tmp_path / "assets" / "video" / "s1.mp4"
    shot_video.parent.mkdir(parents=True)
    shot_video.write_bytes(b"fake shot")
    storyboard = {"shots": [{"id": "s1", "output_path": str(shot_video)}]}
    captured = {}

    def fake_run(cmd, capture_output, text, encoding, errors, timeout, check):
        captured["cmd"] = cmd
        output = tmp_path / "renders" / "final.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"fake final")

        class Proc:
            stdout = ""
            stderr = ""

        return Proc()

    monkeypatch.setattr("shutil.which", lambda _: None)
    monkeypatch.setattr(runner, "_remotion_compositor_dir", lambda: bundled_dir, raising=False)
    monkeypatch.setattr("server.app.openmontage_runner.subprocess.run", fake_run)
    monkeypatch.setattr(
        runner,
        "_probe_compose_input",
        lambda _path: {"has_audio": False, "duration_seconds": 10.0},
    )

    compose_final_video(tmp_path, storyboard)

    assert captured["cmd"][0] == str(bundled_ffmpeg)


def test_bundled_ffmpeg_compose_command_uses_supported_filters(tmp_path, monkeypatch):
    from server.app import openmontage_runner as runner

    bundled_ffmpeg = (
        tmp_path
        / "remotion-composer"
        / "node_modules"
        / "@remotion"
        / "compositor-win32-x64-msvc"
        / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    )
    bundled_ffmpeg.parent.mkdir(parents=True)
    bundled_ffmpeg.write_bytes(b"fake ffmpeg")
    monkeypatch.setattr(runner, "_resolve_ffmpeg_executable", lambda: str(bundled_ffmpeg))
    monkeypatch.setattr(
        runner,
        "_probe_compose_input",
        lambda _path: {"has_audio": False, "duration_seconds": 10.0},
    )

    cmd = runner._build_ffmpeg_compose_command(
        [tmp_path / "s1.mp4", tmp_path / "s2.mp4"],
        tmp_path / "final.mp4",
    )

    filter_complex = cmd[cmd.index("-filter_complex") + 1]
    assert "scale=1080:1920" in filter_complex
    assert "concat=n=2:v=1:a=0" in filter_complex
    assert "pad=" not in filter_complex
    assert "setsar" not in filter_complex
    assert "fps=" not in filter_complex


def test_ffmpeg_compose_command_preserves_audio_and_fills_mute_clips(tmp_path, monkeypatch):
    from server.app import openmontage_runner as runner

    monkeypatch.setattr(runner, "_resolve_ffmpeg_executable", lambda: "ffmpeg")
    monkeypatch.setattr(
        runner,
        "_probe_compose_input",
        lambda path: {
            "has_audio": path.name == "s1.mp4",
            "duration_seconds": 4.25 if path.name == "s1.mp4" else 3.5,
        },
        raising=False,
    )

    cmd = runner._build_ffmpeg_compose_command(
        [tmp_path / "s1.mp4", tmp_path / "s2.mp4"],
        tmp_path / "final.mp4",
    )

    filter_complex = cmd[cmd.index("-filter_complex") + 1]
    assert "[0:a:0]" in filter_complex
    assert "anullsrc=channel_layout=stereo:sample_rate=44100" in filter_complex
    assert "atrim=0:3.500" in filter_complex
    assert "concat=n=2:v=1:a=1[outv][outa]" in filter_complex
    assert cmd[cmd.index("-map") + 1] == "[outv]"
    assert cmd[cmd.index("-map", cmd.index("-map") + 1) + 1] == "[outa]"
    assert "aac" in cmd


def test_ffmpeg_compose_command_limits_each_clip_to_storyboard_duration(
    tmp_path, monkeypatch
):
    from server.app import openmontage_runner as runner

    monkeypatch.setattr(runner, "_resolve_ffmpeg_executable", lambda: "ffmpeg")
    monkeypatch.setattr(
        runner,
        "_probe_compose_input",
        lambda _path: {"has_audio": True, "duration_seconds": 10.005},
    )

    cmd = runner._build_ffmpeg_compose_command(
        [tmp_path / "s1.mp4", tmp_path / "s2.mp4"],
        tmp_path / "final.mp4",
        shot_durations=[4, 6],
    )

    filter_complex = cmd[cmd.index("-filter_complex") + 1]
    assert cmd[cmd.index(str(tmp_path / "s1.mp4")) - 3 : cmd.index(str(tmp_path / "s1.mp4"))] == [
        "-t",
        "4.000",
        "-i",
    ]
    assert cmd[cmd.index(str(tmp_path / "s2.mp4")) - 3 : cmd.index(str(tmp_path / "s2.mp4"))] == [
        "-t",
        "6.000",
        "-i",
    ]
    assert "[0:a:0]aresample=44100" in filter_complex
    assert "apad,atrim=0:4.000" in filter_complex
    assert "apad,atrim=0:6.000" in filter_complex
    assert cmd[-3:] == ["-t", "10.000", str(tmp_path / "final.mp4")]


def test_render_short_drama_project_reports_probed_output_metadata(tmp_path, monkeypatch):
    existing = tmp_path / "assets" / "video" / "s1.mp4"
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b"existing video")
    storyboard = {
        "shots": [
            {"id": "s1", "index": 1, "status": "complete", "output_path": str(existing), "characters": []}
        ]
    }

    def fake_compose_final_video(project_dir, storyboard):
        final = tmp_path / "renders" / "final.mp4"
        final.parent.mkdir(parents=True)
        final.write_bytes(b"final video")
        return final

    monkeypatch.setattr("server.app.openmontage_runner.compose_final_video", fake_compose_final_video)
    monkeypatch.setattr(
        "server.app.openmontage_runner.run_single_shot_generation",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("existing shot videos should be reused")),
    )
    monkeypatch.setattr(
        "server.app.openmontage_runner.probe_output",
        lambda path: {"duration_seconds": 12.34, "video_width": 1080, "video_height": 1920},
        raising=False,
    )

    result = render_short_drama_project(
        project_dir=tmp_path,
        series_bible={"characters": []},
        storyboard=storyboard,
        video_key="video-key",
        base_url="https://api.0000238.xyz",
        video_model="omni_flash-10s",
    )

    output = result["render_report"]["outputs"][0]
    assert output["duration_seconds"] == 12.34
    assert output["resolution"] == "1080x1920"
    assert result["outputs"] == [
        {
            "shot_id": "s1",
            "output_path": str(existing),
            "tool_result": {"url": None, "reused": True},
            "cost_usd": 0.0,
        }
    ]


def test_run_single_shot_generation_passes_video_model_and_key(tmp_path, monkeypatch):
    captured = {}

    class FakeResult:
        success = True
        data = {"output": str(tmp_path / "assets" / "video" / "s1.mp4"), "url": "https://video.example/s1.mp4"}
        cost_usd = 0.4

    class FakeVideoSelector:
        def execute(self, inputs):
            captured["inputs"] = inputs
            captured["env_key"] = __import__("os").environ.get("SYAPI_API_KEY")
            captured["env_base_url"] = __import__("os").environ.get("SYAPI_BASE_URL")
            return FakeResult()

    monkeypatch.setattr("tools.video.video_selector.VideoSelector", FakeVideoSelector)

    result = run_single_shot_generation(
        project_dir=tmp_path,
        shot={"id": "s1", "prompt": "Lin runs", "characters": []},
        series_bible={"characters": []},
        video_key="video-key",
        base_url="https://api.0000238.xyz",
        video_model="veo_3_1-lite",
    )

    assert result["shot_id"] == "s1"
    assert captured["env_key"] == "video-key"
    assert captured["env_base_url"] == "https://api.0000238.xyz"
    assert captured["inputs"]["model_variant"] == "veo_3_1-lite"


def test_run_single_shot_generation_uses_reference_to_video_when_asset_images_exist(tmp_path, monkeypatch):
    image = tmp_path / "assets" / "images" / "character" / "lin.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"fake png")
    captured = {}

    class FakeResult:
        success = True
        data = {
            "output": str(tmp_path / "assets" / "video" / "s1.mp4"),
            "url": "https://video.example/s1.mp4",
            "operation": "reference_to_video",
        }
        cost_usd = 0.5

    class FakeVideoSelector:
        def execute(self, inputs):
            captured["inputs"] = inputs
            return FakeResult()

    monkeypatch.setattr("tools.video.video_selector.VideoSelector", FakeVideoSelector)

    result = run_single_shot_generation(
        project_dir=tmp_path,
        shot={
            "id": "s1",
            "prompt": "Lin opens the envelope.",
            "characters": [],
            "asset_ids": ["asset-lin"],
        },
        series_bible={
            "characters": [],
            "assets": [
                {
                    "id": "asset-lin",
                    "kind": "character",
                    "label": "Lin reference",
                    "reference_images": ["assets/images/character/lin.png"],
                }
            ],
        },
        video_key="video-key",
        base_url="https://api.0000238.xyz",
        video_model="omni_flash-10s",
    )

    assert captured["inputs"]["operation"] == "reference_to_video"
    assert captured["inputs"]["reference_image_paths"] == [str(image.resolve())]
    assert result["operation"] == "reference_to_video"
    assert result["reference_image_paths"] == [str(image.resolve())]


def test_run_single_shot_generation_keeps_text_to_video_without_existing_reference_images(tmp_path, monkeypatch):
    captured = {}

    class FakeResult:
        success = True
        data = {
            "output": str(tmp_path / "assets" / "video" / "s1.mp4"),
            "url": "https://video.example/s1.mp4",
            "operation": "text_to_video",
        }
        cost_usd = 0.4

    class FakeVideoSelector:
        def execute(self, inputs):
            captured["inputs"] = inputs
            return FakeResult()

    monkeypatch.setattr("tools.video.video_selector.VideoSelector", FakeVideoSelector)

    result = run_single_shot_generation(
        project_dir=tmp_path,
        shot={
            "id": "s1",
            "prompt": "Lin opens the envelope.",
            "characters": [],
            "asset_ids": ["asset-lin"],
        },
        series_bible={
            "characters": [],
            "assets": [
                {
                    "id": "asset-lin",
                    "kind": "character",
                    "label": "Lin reference",
                    "reference_images": ["assets/images/character/missing.png"],
                }
            ],
        },
        video_key="video-key",
        base_url="https://api.0000238.xyz",
        video_model="omni_flash-10s",
    )

    assert captured["inputs"]["operation"] == "text_to_video"
    assert "reference_image_paths" not in captured["inputs"]
    assert result["operation"] == "text_to_video"
    assert result["reference_image_paths"] == []


def test_run_single_shot_generation_prompt_includes_shot_language_and_asset_references(tmp_path, monkeypatch):
    captured = {}

    class FakeResult:
        success = True
        data = {"output": str(tmp_path / "assets" / "video" / "s1.mp4"), "url": "https://video.example/s1.mp4"}
        cost_usd = 0.5

    class FakeVideoSelector:
        def execute(self, inputs):
            captured["prompt"] = inputs["prompt"]
            return FakeResult()

    monkeypatch.setattr("tools.video.video_selector.VideoSelector", FakeVideoSelector)

    run_single_shot_generation(
        project_dir=tmp_path,
        shot={
            "id": "s1",
            "prompt": "Lin finds the envelope.",
            "characters": ["c1"],
            "asset_ids": ["asset-c1-ref"],
            "shot_intent": "Push into the clue as fear lands.",
            "shot_language": {
                "shot_size": "medium_close",
                "camera_movement": "dolly_in",
                "lens_mm": 50,
                "depth_of_field": "shallow",
            },
        },
        series_bible={
            "style_lock": "rainy neon suspense",
            "characters": [{"id": "c1", "name": "Lin", "visual_lock": "red coat"}],
            "assets": [
                {
                    "id": "asset-c1-ref",
                    "kind": "character",
                    "label": "Lin reference",
                    "reference_images": ["projects/p1/assets/images/characters/lin.png"],
                }
            ],
        },
        video_key="video-key",
        base_url="https://api.0000238.xyz",
        video_model="omni_flash-10s",
    )

    assert "medium close-up" in captured["prompt"]
    assert "slow dolly in toward subject" in captured["prompt"]
    assert "50mm lens" in captured["prompt"]
    assert "projects/p1/assets/images/characters/lin.png" in captured["prompt"]
    assert "Push into the clue" in captured["prompt"]


def test_compile_shot_prompt_skips_shot_language_label_without_structured_values():
    prompt = compile_shot_prompt(
        shot={"prompt": "Lin finds the envelope.", "characters": []},
        character_lookup={},
        style_lock="rainy neon suspense",
    )

    assert "Shot language:" not in prompt
    assert "Shot language: Lin finds the envelope." not in prompt
    assert "Style lock: rainy neon suspense" in prompt
