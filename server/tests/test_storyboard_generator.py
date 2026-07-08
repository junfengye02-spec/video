from server.app.storyboard_generator import generate_short_drama_storyboard


class FakeResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "choices": [
                {
                    "message": {
                        "content": """
{
  "series_bible": {
    "title": "Rain Alley",
    "mode": "short_drama",
    "style_lock": "rainy neon suspense",
    "characters": [
      {
        "id": "c1",
        "name": "Lin",
        "role": "lead investigator",
        "visual_lock": "red coat, short hair",
        "voice": null,
        "reference_images": [],
        "locked": true
      }
    ]
  },
  "storyboard": {
    "shots": [
      {
        "id": "s1",
        "scene_id": "scene-1",
        "index": 1,
        "beat": "Envelope reveal",
        "prompt": "Lin in red coat, short hair finds a soaked envelope.",
        "characters": ["c1"],
        "location": "rainy neon alley",
        "props": ["envelope"],
        "shot_intent": "Reveal the inciting clue.",
        "shot_language": {
          "shot_size": "medium_close",
          "camera_movement": "dolly_in",
          "lens_mm": 50,
          "depth_of_field": "shallow",
          "lighting_key": "neon",
          "color_temperature": "cool"
        }
      }
    ]
  }
}
"""
                    }
                }
            ]
        }


def test_generate_short_drama_storyboard_posts_structured_prompt(monkeypatch):
    captured = {}

    def fake_post(url, headers, json, timeout):
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("server.app.storyboard_generator.requests.post", fake_post)

    result = generate_short_drama_storyboard(
        title="Rain Alley",
        prompt="rain-night urban reversal short drama",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
    )

    shot = result["storyboard"]["shots"][0]
    assert captured["url"] == "https://api.0000238.xyz/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer text-key"
    assert captured["json"]["model"] == "gpt-5.5"
    assert "shot_language" in captured["json"]["messages"][0]["content"]
    assert shot["shot_language"]["shot_size"] == "medium_close"
    assert shot["shot_intent"] == "Reveal the inciting clue."


def test_generate_short_drama_storyboard_uses_requested_shot_count(monkeypatch):
    captured = {}

    def fake_post(url, headers, json, timeout):
        captured["json"] = json
        return FakeResponse()

    monkeypatch.setattr("server.app.storyboard_generator.requests.post", fake_post)

    generate_short_drama_storyboard(
        title="Rain Alley",
        prompt="rain-night urban reversal short drama",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
        shot_count=7,
    )

    assert "Shots: 7" in captured["json"]["messages"][1]["content"]


def test_generate_short_drama_storyboard_normalizes_list_lens_and_missing_characters(monkeypatch):
    class ListResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": """
[
  {
    "id": "s1",
    "scene_id": "scene-1",
    "index": 1,
    "beat": "Office reveal",
    "prompt": "Boss Chen opens the KPI report.",
    "characters": ["boss_chen"],
    "location": "glass office",
    "props": ["KPI report"],
    "shot_intent": "Reveal the hidden metric trap.",
    "shot_language": {
      "shot_size": "medium_close",
      "camera_movement": "dolly_in",
      "lens_mm": "35mm"
    }
  }
]
"""
                        }
                    }
                ]
            }

    monkeypatch.setattr("server.app.storyboard_generator.requests.post", lambda *args, **kwargs: ListResponse())

    result = generate_short_drama_storyboard(
        title="Blind Date KPI",
        prompt="office family comedy",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
    )

    shot = result["storyboard"]["shots"][0]
    assert shot["shot_language"]["lens_mm"] == 35
    assert result["series_bible"]["characters"][0]["id"] == "boss_chen"
