import subprocess
from pathlib import Path

from tools.avatar.lip_sync import LipSync


def test_lip_sync_passes_manual_face_box(monkeypatch, tmp_path):
    wav2lip_dir = tmp_path / "Wav2Lip"
    checkpoints_dir = wav2lip_dir / "checkpoints"
    checkpoints_dir.mkdir(parents=True)
    (wav2lip_dir / "inference.py").write_text("# fake inference\n", encoding="utf-8")
    (checkpoints_dir / "wav2lip.pth").write_bytes(b"fake checkpoint")

    video_path = tmp_path / "input.mp4"
    audio_path = tmp_path / "audio.wav"
    output_path = tmp_path / "out.mp4"
    video_path.write_bytes(b"fake video")
    audio_path.write_bytes(b"fake audio")

    monkeypatch.setenv("WAV2LIP_PATH", str(wav2lip_dir))

    captured = {}

    def fake_run_command(cmd, *, timeout=None, cwd=None):
        captured["cmd"] = cmd
        captured["timeout"] = timeout
        captured["cwd"] = cwd
        output_path.write_bytes(b"fake output")
        return subprocess.CompletedProcess(cmd, 0)

    tool = LipSync()
    monkeypatch.setattr(tool, "run_command", fake_run_command)

    result = tool.execute(
        {
            "video_path": str(video_path),
            "audio_path": str(audio_path),
            "output_path": str(output_path),
            "box": [20, 345, 165, 470],
        }
    )

    assert result.success
    assert captured["cmd"][-5:] == ["--box", "20", "345", "165", "470"]
    assert captured["cwd"] == wav2lip_dir
