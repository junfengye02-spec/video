import base64

from tools.graphics.openai_image import OpenAIImage


class FakeResponse:
    def __init__(self, b64_json):
        self._json_data = {"data": [{"b64_json": b64_json}]}

    def json(self):
        return self._json_data

    def raise_for_status(self):
        return None


def test_openai_image_supports_gpt_image_2(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.example.test/v1")
    output_path = tmp_path / "image.png"
    encoded = base64.b64encode(b"png-bytes").decode("ascii")
    captured = {}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured["headers"] = kwargs["headers"]
        captured["json"] = kwargs["json"]
        return FakeResponse(encoded)

    monkeypatch.setattr("requests.post", fake_post)

    result = OpenAIImage().execute(
        {
            "prompt": "a test image",
            "model": "gpt-image-2",
            "quality": "low",
            "size": "1024x1024",
            "output_path": str(output_path),
        }
    )

    assert result.success
    assert output_path.read_bytes() == b"png-bytes"
    assert captured["url"] == "https://api.example.test/v1/images/generations"
    assert captured["headers"]["Authorization"] == "Bearer test-key"
    assert captured["json"] == {
        "model": "gpt-image-2",
        "prompt": "a test image",
        "size": "1024x1024",
    }


def test_openai_image_writes_to_output_dir_and_filename(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.example.test/v1")
    output_dir = tmp_path / "assets" / "images"
    encoded = base64.b64encode(b"png-bytes").decode("ascii")

    def fake_post(url, **kwargs):
        return FakeResponse(encoded)

    monkeypatch.setattr("requests.post", fake_post)

    result = OpenAIImage().execute(
        {
            "prompt": "a test image",
            "model": "gpt-image-2",
            "size": "1024x1024",
            "output_dir": str(output_dir),
            "filename": "scene.png",
        }
    )

    expected = output_dir / "scene.png"
    assert result.success
    assert expected.read_bytes() == b"png-bytes"
    assert result.artifacts == [str(expected)]
    assert result.data["output"] == str(expected)
