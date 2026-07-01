import json

from server.app.openmontage_runner import (
    build_pipeline_inputs,
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
