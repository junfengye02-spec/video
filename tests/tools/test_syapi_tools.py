import base64

from tools.graphics.syapi_image import SyapiImage
from tools.video.syapi_video import SyapiVideo


class FakeResponse:
    def __init__(self, *, json_data=None, content=b"", ok=True, status_code=200, text=""):
        self._json_data = json_data or {}
        self.content = content
        self.ok = ok
        self.status_code = status_code
        self.text = text

    def json(self):
        return self._json_data

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(self.text or f"HTTP {self.status_code}")


def test_syapi_image_sync_writes_base64(monkeypatch, tmp_path):
    monkeypatch.setenv("SYAPI_API_KEY", "test-key")
    output_path = tmp_path / "image.png"
    encoded = base64.b64encode(b"png-bytes").decode("ascii")
    captured = {}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured["headers"] = kwargs["headers"]
        captured["json"] = kwargs["json"]
        return FakeResponse(json_data={"data": [{"b64_json": encoded}]})

    monkeypatch.setattr("requests.post", fake_post)

    result = SyapiImage().execute(
        {
            "prompt": "a character portrait",
            "model": "image2",
            "size": "720x1280",
            "output_path": str(output_path),
        }
    )

    assert result.success
    assert output_path.read_bytes() == b"png-bytes"
    assert captured["url"] == "https://api.0000238.xyz/v1/images/generations"
    assert captured["headers"]["Authorization"] == "Bearer test-key"
    assert captured["json"]["model"] == "image2"
    assert captured["json"]["size"] == "720x1280"


def test_syapi_image_default_base_url_is_current_gateway(monkeypatch):
    monkeypatch.delenv("SYAPI_BASE_URL", raising=False)

    assert SyapiImage()._base_url() == "https://api.0000238.xyz"


def test_syapi_image_async_polls_and_downloads_url(monkeypatch, tmp_path):
    monkeypatch.setenv("SYAPI_API_KEY", "test-key")
    output_path = tmp_path / "async.png"
    calls = {"get": 0}

    def fake_post(url, **kwargs):
        assert url == "https://api.0000238.xyz/v1/videos"
        assert kwargs["json"]["model"] == "gpt-image-2"
        return FakeResponse(json_data={"id": "task_img", "status": "queued"})

    def fake_get(url, **kwargs):
        if url == "https://api.0000238.xyz/v1/videos/task_img":
            calls["get"] += 1
            if calls["get"] == 1:
                return FakeResponse(json_data={"id": "task_img", "status": "in_progress"})
            return FakeResponse(json_data={"id": "task_img", "status": "completed", "url": "https://cdn.example/img.png"})
        if url == "https://cdn.example/img.png":
            return FakeResponse(content=b"downloaded-image")
        raise AssertionError(url)

    monkeypatch.setattr("requests.post", fake_post)
    monkeypatch.setattr("requests.get", fake_get)
    monkeypatch.setattr("time.sleep", lambda _: None)

    result = SyapiImage().execute(
        {
            "prompt": "a vertical character portrait",
            "model": "gpt-image-2",
            "aspect_ratio": "9:16",
            "output_path": str(output_path),
        }
    )

    assert result.success
    assert output_path.read_bytes() == b"downloaded-image"
    assert result.data["task_id"] == "task_img"


def test_syapi_video_polls_and_downloads_video(monkeypatch, tmp_path):
    monkeypatch.setenv("SYAPI_API_KEY", "test-key")
    output_path = tmp_path / "clip.mp4"
    calls = {"get": 0}

    def fake_post(url, **kwargs):
        assert url == "https://api.0000238.xyz/v1/videos"
        assert kwargs["json"]["model"] == "omni_flash-10s"
        assert kwargs["json"]["size"] == "720x1280"
        return FakeResponse(json_data={"id": "task_vid", "status": "queued"})

    def fake_get(url, **kwargs):
        if url == "https://api.0000238.xyz/v1/videos/task_vid":
            calls["get"] += 1
            if calls["get"] == 1:
                return FakeResponse(json_data={"id": "task_vid", "status": "processing", "progress": 45})
            return FakeResponse(
                json_data={
                    "id": "task_vid",
                    "status": "completed",
                    "video": {"url": "https://cdn.example/clip.mp4"},
                }
            )
        if url == "https://cdn.example/clip.mp4":
            return FakeResponse(content=b"mp4-bytes")
        raise AssertionError(url)

    monkeypatch.setattr("requests.post", fake_post)
    monkeypatch.setattr("requests.get", fake_get)
    monkeypatch.setattr("time.sleep", lambda _: None)

    result = SyapiVideo().execute(
        {
            "prompt": "short comedic family drama clip",
            "model_variant": "omni_flash-10s",
            "size": "720x1280",
            "output_path": str(output_path),
        }
    )

    assert result.success
    assert output_path.read_bytes() == b"mp4-bytes"
    assert result.data["task_id"] == "task_vid"


def test_syapi_video_retries_transient_poll_http_errors(monkeypatch, tmp_path):
    monkeypatch.setenv("SYAPI_API_KEY", "test-key")
    output_path = tmp_path / "clip-after-500.mp4"
    calls = {"get": 0}

    def fake_post(url, **kwargs):
        return FakeResponse(json_data={"id": "task_retry", "status": "queued"})

    def fake_get(url, **kwargs):
        if url == "https://api.0000238.xyz/v1/videos/task_retry":
            calls["get"] += 1
            if calls["get"] == 1:
                return FakeResponse(ok=False, status_code=500, text="temporary gateway error")
            return FakeResponse(
                json_data={
                    "id": "task_retry",
                    "status": "completed",
                    "video_url": "https://cdn.example/retry.mp4",
                }
            )
        if url == "https://cdn.example/retry.mp4":
            return FakeResponse(content=b"retry-mp4-bytes")
        raise AssertionError(url)

    monkeypatch.setattr("requests.post", fake_post)
    monkeypatch.setattr("requests.get", fake_get)
    monkeypatch.setattr("time.sleep", lambda _: None)

    result = SyapiVideo().execute(
        {
            "prompt": "short comedic family drama clip",
            "model_variant": "omni_flash-10s",
            "size": "720x1280",
            "output_path": str(output_path),
        }
    )

    assert result.success
    assert calls["get"] == 2
    assert output_path.read_bytes() == b"retry-mp4-bytes"


def test_syapi_video_uses_configurable_submit_timeout(monkeypatch, tmp_path):
    monkeypatch.setenv("SYAPI_API_KEY", "test-key")
    monkeypatch.setenv("SYAPI_BASE_URL", "https://u.syapi.cn")
    output_path = tmp_path / "clip.mp4"
    captured = {}

    def fake_post(url, **kwargs):
        captured["timeout"] = kwargs["timeout"]
        return FakeResponse(json_data={"id": "task_timeout", "status": "queued"})

    def fake_get(url, **kwargs):
        if url == "https://u.syapi.cn/v1/videos/task_timeout":
            return FakeResponse(
                json_data={
                    "id": "task_timeout",
                    "status": "completed",
                    "video_url": "https://cdn.example/timeout.mp4",
                }
            )
        if url == "https://cdn.example/timeout.mp4":
            return FakeResponse(content=b"timeout-mp4-bytes")
        raise AssertionError(url)

    monkeypatch.setattr("requests.post", fake_post)
    monkeypatch.setattr("requests.get", fake_get)

    result = SyapiVideo().execute(
        {
            "prompt": "short comedic family drama clip",
            "model_variant": "omni_flash-10s",
            "submit_timeout_seconds": 180,
            "output_path": str(output_path),
        }
    )

    assert result.success
    assert captured["timeout"] == 180


def test_syapi_video_reports_failed_task(monkeypatch, tmp_path):
    monkeypatch.setenv("SYAPI_API_KEY", "test-key")

    def fake_post(url, **kwargs):
        return FakeResponse(json_data={"id": "task_bad", "status": "queued"})

    def fake_get(url, **kwargs):
        return FakeResponse(
            json_data={
                "id": "task_bad",
                "status": "failed",
                "error": {"message": "model not enabled"},
            }
        )

    monkeypatch.setattr("requests.post", fake_post)
    monkeypatch.setattr("requests.get", fake_get)
    monkeypatch.setattr("time.sleep", lambda _: None)

    result = SyapiVideo().execute(
        {
            "prompt": "test",
            "model_variant": "veo_3_1-lite",
            "output_path": str(tmp_path / "bad.mp4"),
        }
    )

    assert not result.success
    assert "model not enabled" in result.error


def test_syapi_video_default_base_url_is_current_gateway(monkeypatch):
    monkeypatch.delenv("SYAPI_BASE_URL", raising=False)

    assert SyapiVideo()._base_url() == "https://api.0000238.xyz"


def test_syapi_video_http_error_reports_endpoint_model_and_status(monkeypatch, tmp_path):
    monkeypatch.setenv("SYAPI_API_KEY", "test-key")
    monkeypatch.setenv("SYAPI_BASE_URL", "https://api.0000238.xyz")

    def fake_post(url, **kwargs):
        assert url == "https://api.0000238.xyz/v1/videos"
        assert kwargs["json"]["model"] == "omni_flash-10s"
        return FakeResponse(
            json_data={"error": {"message": "video model forbidden"}},
            ok=False,
            status_code=403,
            text="Forbidden",
        )

    monkeypatch.setattr("requests.post", fake_post)

    result = SyapiVideo().execute(
        {
            "prompt": "test",
            "model_variant": "omni_flash-10s",
            "output_path": str(tmp_path / "blocked.mp4"),
        }
    )

    assert not result.success
    assert "POST https://api.0000238.xyz/v1/videos" in result.error
    assert "status=403" in result.error
    assert "model=omni_flash-10s" in result.error
    assert "video model forbidden" in result.error


def test_syapi_video_http_error_explains_insufficient_quota(monkeypatch, tmp_path):
    monkeypatch.setenv("SYAPI_API_KEY", "test-key")
    monkeypatch.setenv("SYAPI_BASE_URL", "https://api.0000238.xyz")

    def fake_post(url, **kwargs):
        return FakeResponse(
            json_data={
                "error": {
                    "code": "fail_to_fetch_task",
                    "message": '{"code":"insufficient_user_quota","message":"预扣费额度失败, 用户剩余额度: ¥5.200000, 需要预扣费额度: ¥27.600000","data":null}',
                    "data": None,
                }
            },
            ok=False,
            status_code=403,
            text="Forbidden",
        )

    monkeypatch.setattr("requests.post", fake_post)

    result = SyapiVideo().execute(
        {
            "prompt": "test",
            "model_variant": "omni_flash-10s",
            "output_path": str(tmp_path / "quota.mp4"),
        }
    )

    assert not result.success
    assert "余额不足" in result.error
    assert "¥5.200000" in result.error
    assert "¥27.600000" in result.error
