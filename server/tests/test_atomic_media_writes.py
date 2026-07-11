import asyncio
import os
import subprocess
from pathlib import Path

import pytest

from server.app.media_files import save_upload_file
from server.app.openmontage_runner import compose_final_video, run_single_shot_generation


def _hardlink_file_or_skip(link: Path, target: Path) -> None:
    try:
        os.link(target, link)
    except (NotImplementedError, OSError) as exc:
        pytest.skip(f"hardlinks are not available: {exc}")


def _link_directory_or_skip(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except (NotImplementedError, OSError) as exc:
        if os.name != "nt":
            pytest.skip(f"directory links are not available: {exc}")
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"directory links are not available: {result.stderr or result.stdout}")


def test_upload_rejects_destination_swapped_to_hardlink_before_replace(tmp_path):
    destination = tmp_path / "assets" / "images" / "asset.png"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"old")
    outside = tmp_path / "outside-upload.bin"
    outside.write_bytes(b"outside-sentinel")

    class SwappingUpload:
        reads = 0

        async def read(self, _size):
            self.reads += 1
            return b"uploaded" if self.reads == 1 else b""

        async def close(self):
            destination.unlink()
            _hardlink_file_or_skip(destination, outside)

    with pytest.raises(ValueError, match="Project workspace path is invalid"):
        asyncio.run(save_upload_file(SwappingUpload(), destination, 1024))

    assert outside.read_bytes() == b"outside-sentinel"
    assert not list(destination.parent.glob(f".{destination.name}.*.upload"))


def test_upload_rejects_destination_under_linked_ancestor(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    outside = tmp_path / "outside"
    outside_images = outside / "images"
    outside_images.mkdir(parents=True)
    sentinel = outside_images / "asset.png"
    sentinel.write_bytes(b"outside-sentinel")
    _link_directory_or_skip(project / "assets", outside)
    destination = project / "assets" / "images" / "asset.png"

    class Upload:
        reads = 0

        async def read(self, _size):
            self.reads += 1
            return b"uploaded" if self.reads == 1 else b""

        async def close(self):
            return None

    with pytest.raises(ValueError, match="Project workspace path is invalid"):
        asyncio.run(save_upload_file(Upload(), destination, 1024))

    assert sentinel.read_bytes() == b"outside-sentinel"
    assert not list(outside_images.glob(f".{destination.name}.*.upload"))


def test_upload_rejects_linked_ancestor_before_creating_external_parent(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    _link_directory_or_skip(project / "assets", outside)
    destination = project / "assets" / "missing" / "asset.png"
    close_calls = 0

    class Upload:
        async def read(self, _size):
            return b""

        async def close(self):
            nonlocal close_calls
            close_calls += 1

    with pytest.raises(ValueError, match="Project workspace path is invalid"):
        asyncio.run(save_upload_file(Upload(), destination, 1024))

    assert not (outside / "missing").exists()
    assert close_calls == 1


def test_upload_close_failure_is_not_retried_and_cleans_temporary(tmp_path):
    destination = tmp_path / "assets" / "images" / "asset.png"
    close_calls = 0

    class FailingCloseUpload:
        reads = 0

        async def read(self, _size):
            self.reads += 1
            return b"uploaded" if self.reads == 1 else b""

        async def close(self):
            nonlocal close_calls
            close_calls += 1
            if close_calls == 1:
                raise RuntimeError("close failed")
            raise RuntimeError("closed twice")

    with pytest.raises(RuntimeError, match="close failed"):
        asyncio.run(save_upload_file(FailingCloseUpload(), destination, 1024))

    assert close_calls == 1
    assert not list(destination.parent.glob(f".{destination.name}.*.upload"))


def test_generation_rejects_destination_swapped_to_hardlink_before_replace(
    tmp_path, monkeypatch
):
    destination = tmp_path / "assets" / "video" / "s1.mp4"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"old")
    outside = tmp_path / "outside-generation.bin"
    outside.write_bytes(b"outside-sentinel")

    class FakeResult:
        success = True
        data = {"url": "https://video.example/s1.mp4"}
        cost_usd = 0.4

    class SwappingSelector:
        def execute(self, inputs):
            temporary = Path(inputs["output_path"])
            temporary.write_bytes(b"generated")
            destination.unlink()
            _hardlink_file_or_skip(destination, outside)
            FakeResult.data["output"] = str(temporary)
            return FakeResult()

    monkeypatch.setattr("tools.video.video_selector.VideoSelector", SwappingSelector)

    with pytest.raises(ValueError, match="Project workspace path is invalid"):
        run_single_shot_generation(
            project_dir=tmp_path,
            shot={"id": "s1", "prompt": "Lin runs", "characters": []},
            series_bible={"characters": []},
            video_key="video-key",
            base_url="https://api.example.com",
        )

    assert outside.read_bytes() == b"outside-sentinel"
    assert not list(destination.parent.glob(f".{destination.name}.*.generate"))


def test_generation_cleans_temporary_when_selector_inputs_fail(tmp_path, monkeypatch):
    destination = tmp_path / "assets" / "video" / "s1.mp4"

    def fail_inputs(**_kwargs):
        raise RuntimeError("selector inputs failed")

    monkeypatch.setattr(
        "server.app.openmontage_runner.build_video_selector_inputs",
        fail_inputs,
    )

    with pytest.raises(RuntimeError, match="selector inputs failed"):
        run_single_shot_generation(
            project_dir=tmp_path,
            shot={"id": "s1", "prompt": "Lin runs", "characters": []},
            series_bible={"characters": []},
            video_key="video-key",
            base_url="https://api.example.com",
        )

    assert not list(destination.parent.glob(f".{destination.name}.*.generate"))


def test_compose_rejects_destination_swapped_to_hardlink_before_replace(
    tmp_path, monkeypatch
):
    shot = tmp_path / "assets" / "video" / "s1.mp4"
    shot.parent.mkdir(parents=True)
    shot.write_bytes(b"shot")
    destination = tmp_path / "renders" / "final.mp4"
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"old")
    outside = tmp_path / "outside-compose.bin"
    outside.write_bytes(b"outside-sentinel")

    def fake_run(cmd, **_kwargs):
        temporary = Path(cmd[-1])
        temporary.write_bytes(b"rendered")
        destination.unlink()
        _hardlink_file_or_skip(destination, outside)

    monkeypatch.setattr("server.app.openmontage_runner.subprocess.run", fake_run)

    with pytest.raises(ValueError, match="Project workspace path is invalid"):
        compose_final_video(
            tmp_path,
            {"shots": [{"id": "s1", "index": 1, "output_path": str(shot)}]},
        )

    assert outside.read_bytes() == b"outside-sentinel"
    assert not list(destination.parent.glob(f".{destination.name}.*.render"))
