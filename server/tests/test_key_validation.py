from server.app.key_validation import validate_gateway_models


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = payload or {"data": [{"id": "gpt-5.5"}, {"id": "gpt-image-2"}, {"id": "omni_flash-10s"}]}
        self.text = "provider error"

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError("provider error")

    def json(self):
        return self._payload


def test_validate_gateway_models_checks_each_key(monkeypatch):
    calls = []

    def fake_get(url, headers, timeout):
        calls.append(headers["Authorization"])
        return FakeResponse()

    monkeypatch.setattr("server.app.key_validation.requests.get", fake_get)

    result = validate_gateway_models(
        base_url="https://api.0000238.xyz",
        text_key="text-key",
        image_key="image-key",
        video_key="video-key",
        text_model="gpt-5.5",
        image_model="gpt-image-2",
        video_model="omni_flash-10s",
    )

    assert result["valid"] is True
    assert calls == ["Bearer text-key", "Bearer image-key", "Bearer video-key"]


def test_validate_gateway_models_reports_missing_model(monkeypatch):
    def fake_get(url, headers, timeout):
        return FakeResponse(payload={"data": [{"id": "gpt-5.5"}]})

    monkeypatch.setattr("server.app.key_validation.requests.get", fake_get)

    result = validate_gateway_models(
        base_url="https://api.0000238.xyz",
        text_key="text-key",
        image_key="image-key",
        video_key="video-key",
        text_model="gpt-5.5",
        image_model="gpt-image-2",
        video_model="omni_flash-10s",
    )

    assert result["valid"] is False
    assert "gpt-image-2" in result["errors"][0]
