import json

from tools.audio.syapi_kling_custom_voice import SyapiKlingCustomVoice
from tools.audio.syapi_minimax_tts import SyapiMiniMaxTTS
from tools.avatar.syapi_kling_lip_sync import SyapiKlingLipSync


class FakeResponse:
    def __init__(self, *, json_data=None, content=b"", ok=True, status_code=200, headers=None):
        self._json_data = json_data
        self.content = content
        self.ok = ok
        self.status_code = status_code
        self.headers = headers or {"Content-Type": "application/json"}

    def json(self):
        return self._json_data

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(f"HTTP {self.status_code}")


def test_syapi_minimax_tts_decodes_hex_audio(monkeypatch, tmp_path):
    monkeypatch.setenv("SYAPI_API_KEY", "test-key")
    monkeypatch.setenv("SYAPI_BASE_URL", "https://u1.syapi.cn")
    output = tmp_path / "line.mp3"
    captured = {}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured["payload"] = kwargs["json"]
        return FakeResponse(json_data={"data": {"audio": b"ID3test".hex()}, "base_resp": {"status_code": 0}})

    monkeypatch.setattr("requests.post", fake_post)
    monkeypatch.setattr(SyapiMiniMaxTTS, "_duration", staticmethod(lambda _: 2.8))

    result = SyapiMiniMaxTTS().execute(
        {
            "text": "晚饭前，能审完这个家吗？",
            "model": "speech-2.8-hd",
            "voice_id": "female-chengshu",
            "output_path": str(output),
        }
    )

    assert result.success
    assert captured["url"] == "https://u1.syapi.cn/minimax/v1/t2a_v2"
    assert captured["payload"]["model"] == "speech-2.8-hd"
    assert captured["payload"]["voice_setting"]["voice_id"] == "female-chengshu"
    assert output.read_bytes() == b"ID3test"


def test_syapi_kling_custom_voice_uploads_and_polls(monkeypatch, tmp_path):
    monkeypatch.setenv("SYAPI_API_KEY", "test-key")
    monkeypatch.setenv("SYAPI_BASE_URL", "https://u1.syapi.cn")
    reference = tmp_path / "reference.mp3"
    reference.write_bytes(b"audio")
    metadata = tmp_path / "voice.json"

    monkeypatch.setattr(
        "tools.audio.syapi_kling_custom_voice.upload_file",
        lambda _: "https://cdn.example/reference.mp3",
    )

    def fake_post(url, **kwargs):
        assert url == "https://u1.syapi.cn/kling/v1/general/custom-voices"
        assert kwargs["json"]["voice_url"] == "https://cdn.example/reference.mp3"
        return FakeResponse(json_data={"data": {"task_id": "voice-task", "task_status": "submitted"}})

    def fake_get(url, **kwargs):
        assert url == "https://u1.syapi.cn/kling/v1/general/custom-voices/voice-task"
        return FakeResponse(
            json_data={"data": {"task_id": "voice-task", "task_status": "succeed", "voice_id": "voice-123"}}
        )

    monkeypatch.setattr("requests.post", fake_post)
    monkeypatch.setattr("requests.get", fake_get)
    monkeypatch.setattr("time.sleep", lambda _: None)

    result = SyapiKlingCustomVoice().execute(
        {"voice_name": "hero-woman", "voice_path": str(reference), "metadata_path": str(metadata)}
    )

    assert result.success
    assert result.data["voice_id"] == "voice-123"
    assert json.loads(metadata.read_text(encoding="utf-8"))["model"] == "kling-custom-voices"


def test_syapi_kling_lip_sync_runs_recognition_and_downloads(monkeypatch, tmp_path):
    monkeypatch.setenv("SYAPI_API_KEY", "test-key")
    monkeypatch.setenv("SYAPI_BASE_URL", "https://u1.syapi.cn")
    video = tmp_path / "hero.mp4"
    audio = tmp_path / "line.mp3"
    output = tmp_path / "result.mp4"
    video.write_bytes(b"video")
    audio.write_bytes(b"audio")
    uploads = iter(["https://cdn.example/hero.mp4"])
    captured = {}

    monkeypatch.setattr("tools.avatar.syapi_kling_lip_sync.upload_file", lambda _: next(uploads))
    monkeypatch.setattr(SyapiKlingLipSync, "_audio_duration_ms", staticmethod(lambda _: 2800))

    def fake_post(url, **kwargs):
        if url.endswith("/identify-face"):
            return FakeResponse(json_data={"data": {"session_id": "session-1", "face_list": [{"face_id": "face-7"}]}})
        assert url.endswith("/advanced-lip-sync")
        captured["payload"] = kwargs["json"]
        return FakeResponse(json_data={"data": {"task_id": "lip-task", "task_status": "submitted"}})

    def fake_get(url, **kwargs):
        if url.endswith("/advanced-lip-sync/lip-task"):
            return FakeResponse(
                json_data={
                    "data": {
                        "task_status": "succeed",
                        "task_result": {"video_url": "https://cdn.example/result.mp4"},
                    }
                }
            )
        if url == "https://cdn.example/result.mp4":
            return FakeResponse(content=b"result-video", headers={"Content-Type": "video/mp4"})
        raise AssertionError(url)

    monkeypatch.setattr("requests.post", fake_post)
    monkeypatch.setattr("requests.get", fake_get)
    monkeypatch.setattr("time.sleep", lambda _: None)

    result = SyapiKlingLipSync().execute(
        {
            "video_path": str(video),
            "audio_path": str(audio),
            "audio_url": "https://cdn.example/line.mp3",
            "output_path": str(output),
            "sound_insert_time_ms": 500,
        }
    )

    assert result.success
    assert captured["payload"]["face_choose"][0]["face_id"] == "face-7"
    assert captured["payload"]["face_choose"][0]["sound_end_time"] == 2800
    assert captured["payload"]["face_choose"][0]["sound_insert_time"] == 500
    assert output.read_bytes() == b"result-video"


def test_syapi_kling_lip_sync_can_stop_after_recognition(monkeypatch, tmp_path):
    monkeypatch.setenv("SYAPI_API_KEY", "test-key")
    monkeypatch.setenv("SYAPI_BASE_URL", "https://u1.syapi.cn")
    video = tmp_path / "hero.mp4"
    metadata = tmp_path / "faces.json"
    video.write_bytes(b"video")

    monkeypatch.setattr(
        "tools.avatar.syapi_kling_lip_sync.upload_file", lambda _: "https://cdn.example/hero.mp4"
    )

    def fake_post(url, **kwargs):
        assert url.endswith("/identify-face")
        return FakeResponse(
            json_data={
                "data": {
                    "session_id": "session-1",
                    "face_list": [{"face_id": "foreground"}, {"face_id": "background"}],
                }
            }
        )

    monkeypatch.setattr("requests.post", fake_post)

    result = SyapiKlingLipSync().execute(
        {
            "video_path": str(video),
            "recognition_only": True,
            "metadata_path": str(metadata),
        }
    )

    assert result.success
    assert result.data["stage"] == "face_recognition"
    assert result.data["recognized_face_ids"] == ["foreground", "background"]
    assert json.loads(metadata.read_text(encoding="utf-8"))["session_id"] == "session-1"
