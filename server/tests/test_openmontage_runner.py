import json
import os

from server.app.openmontage_runner import (
    build_pipeline_inputs,
    compile_shot_prompt,
    compose_final_video,
    run_single_shot_generation,
    write_pipeline_artifacts,
)


def test_build_pipeline_inputs_maps_storyboard_to_openmontage_artifacts():
    series_bible = {"characters": [{"id": "c1", "name": "Lin", "visual_lock": "red coat"}]}
    storyboard = {"shots": [{"id": "s1", "prompt": "Lin in red coat runs", "characters": ["c1"]}]}

    result = build_pipeline_inputs(series_bible, storyboard, render_runtime="remotion")

    assert result["scene_plan"]["scenes"][0]["description"] == "Lin in red coat runs"
    assert result["proposal_packet"]["production_plan"]["render_runtime"] == "remotion"


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

    final_path = compose_final_video(tmp_path, storyboard)

    assert final_path.name == "final.mp4"
    assert final_path.exists()


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

    compose_final_video(tmp_path, storyboard)

    assert captured["cmd"][0] == str(bundled_ffmpeg)


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
