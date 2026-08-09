import json

from server.app.storyboard_generator import (
    PLANNING_MAX_COMPLETION_TOKENS,
    _normalize_storyboard,
    generate_short_drama_storyboard,
    prepare_storyboard_request,
)


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


def test_prepare_storyboard_request_streams_with_bounded_low_reasoning_output():
    request = prepare_storyboard_request(
        title="Rain Alley",
        prompt="A serialized warning from tomorrow.",
        model="gpt-5.4",
        project_type="long_series",
    )

    payload = json.loads(request.content)

    assert payload["stream"] is True
    assert payload["reasoning_effort"] == "low"
    assert payload["max_completion_tokens"] == PLANNING_MAX_COMPLETION_TOKENS
    assert "Prefer 12 episodes" in payload["messages"][1]["content"]
    system_prompt = payload["messages"][0]["content"]
    assert "Keep non-prompt planning fields compact" in system_prompt
    assert "inherit_previous_tail" in system_prompt
    assert "beat and prompt as different fields" in system_prompt
    assert "camera height and angle" in system_prompt
    assert "do not add people or objects" in system_prompt
    assert PLANNING_MAX_COMPLETION_TOKENS >= 12000


def test_storyboard_request_includes_confirmed_narrative_beat_contract():
    beats = [
        {
            "id": "beat-1",
            "index": 1,
            "summary": "The envelope arrives.",
            "recommended_duration_seconds": 5,
            "duration_range_seconds": [4, 6],
            "can_merge_with_next": False,
            "must_complete_action": True,
            "must_preserve_emotion": False,
            "cannot_split_reason": "The envelope must be opened in one action.",
        }
    ]

    request = prepare_storyboard_request(
        title="Rain Letter",
        prompt="A courier receives tomorrow's letter.",
        model="gpt-5.5",
        narrative_beats=beats,
    )

    payload = json.loads(request.content)
    user_prompt = payload["messages"][1]["content"]
    assert "beat-1" in user_prompt
    assert "exactly one storyboard shot per narrative beat" in user_prompt
    assert "requested_duration_seconds" not in user_prompt


def test_storyboard_normalization_preserves_beat_identity_and_constraints():
    beats = [
        {
            "id": f"beat-{index}",
            "index": index,
            "summary": f"Beat {index}",
            "recommended_duration_seconds": 5,
            "duration_range_seconds": [4, 6],
            "can_merge_with_next": index == 1,
            "must_complete_action": index == 1,
            "must_preserve_emotion": index == 2,
            "cannot_split_reason": "Hold the reaction" if index == 2 else None,
        }
        for index in range(1, 3)
    ]
    data = {
        "series_bible": {},
        "storyboard": {
            "shots": [
                {"beat": "First", "prompt": "First.", "characters": [], "props": []},
                {"beat": "Second", "prompt": "Second.", "characters": [], "props": []},
            ]
        },
    }

    _normalize_storyboard(data, "Rain Letter", narrative_beats=beats)

    shots = data["storyboard"]["shots"]
    assert [shot["beat_id"] for shot in shots] == ["beat-1", "beat-2"]
    assert [shot["recommended_duration_seconds"] for shot in shots] == [5, 5]
    assert shots[0]["can_merge_with_next"] is True
    assert shots[0]["must_complete_action"] is True
    assert shots[1]["must_preserve_emotion"] is True
    assert shots[1]["cannot_split_reason"] == "Hold the reaction"


def test_storyboard_without_narrative_beats_remains_readable_and_conservative():
    data = {
        "series_bible": {},
        "storyboard": {
            "shots": [
                {"beat": "Legacy", "prompt": "Legacy.", "characters": [], "props": []}
            ]
        },
    }

    _normalize_storyboard(data, "Legacy")

    shot = data["storyboard"]["shots"][0]
    assert shot["beat_id"] is None
    assert shot["can_merge_with_next"] is False


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
    assert captured["timeout"] == 600
    assert "shot_language" in captured["json"]["messages"][0]["content"]
    assert shot["shot_language"]["shot_size"] == "medium_close"
    assert shot["shot_intent"] == "Reveal the inciting clue."
    assert shot["asset_ids"] == [
        "character-c1",
        "scene-rainy-neon-alley",
        "prop-envelope",
    ]
    assert shot["history"][0]["asset_ids"] == shot["asset_ids"]


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


def test_generate_short_drama_storyboard_includes_project_type_episode_contract(monkeypatch):
    captured = {}

    def fake_post(url, headers, json, timeout):
        captured["json"] = json
        return FakeResponse()

    monkeypatch.setattr("server.app.storyboard_generator.requests.post", fake_post)

    result = generate_short_drama_storyboard(
        title="Rain Alley",
        prompt="rain-night urban reversal short drama",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
        project_type="mini_series",
    )

    user_message = captured["json"]["messages"][1]["content"]
    assert "Project type: mini_series" in user_message
    assert "3-8 episodes" in user_message
    assert "series_prompt" in captured["json"]["messages"][0]["content"]
    assert "continuity_plan" in captured["json"]["messages"][0]["content"]
    assert len(result["continuity_plan"]["episodes"]) == 3


def test_generate_short_drama_storyboard_uses_distinct_long_series_contract(monkeypatch):
    captured = {}

    def fake_post(url, headers, json, timeout):
        captured["json"] = json
        return FakeResponse()

    monkeypatch.setattr("server.app.storyboard_generator.requests.post", fake_post)

    result = generate_short_drama_storyboard(
        title="Rain Alley",
        prompt="rain-night urban reversal short drama",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
        project_type="long_series",
    )

    user_message = captured["json"]["messages"][1]["content"]
    assert "Project type: long_series" in user_message
    assert "12-24 episodes" in user_message
    assert "3-8 episodes" not in user_message
    assert len(result["continuity_plan"]["episodes"]) == 12


def test_generate_short_drama_storyboard_normalizes_episode_prompt_and_outline(monkeypatch):
    class SeriesResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [{"message": {"content": """{
                  "series_bible": {"series_prompt": "Keep the mystery escalating.", "characters": []},
                  "continuity_plan": {"episodes": [{
                    "episode_number": 1, "title": "The clue", "goal": "Find it",
                    "conflict": "The clock", "twist": "It was staged", "cliffhanger": "A second letter",
                    "inherited_state": [], "prompt": "Episode prompt", "outline": "Three beats"
                  }]},
                  "storyboard": {"shots": []}
                }"""}}]
            }

    monkeypatch.setattr("server.app.storyboard_generator.requests.post", lambda *args, **kwargs: SeriesResponse())

    result = generate_short_drama_storyboard(
        title="Rain Alley",
        prompt="mini series",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
        project_type="mini_series",
    )

    assert result["series_bible"]["series_prompt"] == "Keep the mystery escalating."
    assert result["continuity_plan"]["episodes"][0]["prompt"] == "Episode prompt"
    assert result["continuity_plan"]["episodes"][0]["outline"] == "Three beats"
    assert len(result["continuity_plan"]["episodes"]) >= 3


def test_generate_short_drama_storyboard_lets_model_choose_shot_count_by_default(monkeypatch):
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
    )

    user_message = captured["json"]["messages"][1]["content"]
    assert "Shots: 5" not in user_message
    assert "derive natural shot boundaries" in user_message
    assert "Do not use a default count" in user_message
    assert "recommended numeric range" in user_message


def test_generated_storyboard_defaults_adjacent_shots_to_tail_carry(monkeypatch):
    class MultiShotResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": """
{
  "series_bible": {},
  "storyboard": {
    "shots": [
      {"id":"s1","scene_id":"scene-1","index":1,"beat":"start","prompt":"Start.","characters":[],"props":[]},
      {"id":"s2","scene_id":"scene-1","index":2,"beat":"continue","prompt":"Continue.","characters":[],"props":[]},
      {"id":"s3","scene_id":"scene-2","index":3,"beat":"later","prompt":"Later.","characters":[],"props":[],"continuity":{"mode":"cut","inherit_previous_tail":false}}
    ]
  }
}
"""
                        }
                    }
                ]
            }

    monkeypatch.setattr(
        "server.app.storyboard_generator.requests.post",
        lambda *args, **kwargs: MultiShotResponse(),
    )

    result = generate_short_drama_storyboard(
        title="Continuous Action",
        prompt="A person crosses a room in one action, then time jumps.",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
    )

    first, second, third = result["storyboard"]["shots"]
    assert first["continuity"]["mode"] == "cut"
    assert first["continuity"]["inherit_previous_tail"] is False
    assert second["continuity"]["mode"] == "carry"
    assert second["continuity"]["inherit_previous_tail"] is True
    assert second["history"][0]["continuity"] == second["continuity"]
    assert third["continuity"]["mode"] == "cut"
    assert third["continuity"]["inherit_previous_tail"] is False


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
    assert result["series_bible"]["characters"][0]["visual_lock"]
    assert {
        (asset["kind"], asset["label"])
        for asset in result["series_bible"]["assets"]
    } == {
        ("character", "Boss Chen"),
        ("scene", "glass office"),
        ("prop", "KPI report"),
    }
    assert all(asset["prompt"] for asset in result["series_bible"]["assets"])


def test_generate_short_drama_storyboard_sanitizes_common_llm_schema_drift(monkeypatch):
    class DriftResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": """
{
  "series_bible": [
    {
      "title": "Blind Date KPI",
      "mode": "short_drama",
      "characters": "Lin Xiaolu"
    }
  ],
  "storyboard": {
    "shots": [
      {
        "id": "s1",
        "scene_id": "scene-1",
        "index": 1,
        "beat": "Lin enters",
        "prompt": "Lin rushes into the proxy office.",
        "characters": "lin_xiaolu",
        "location": "old-neighborhood proxy office",
        "props": "blind-date KPI schedule",
        "shot_intent": "Start the episode with urgency.",
        "shot_language": {
          "shot_size": "medium_shot",
          "camera_movement": "push in",
          "lens_mm": "35",
          "lighting_key": "mixed",
          "depth_of_field": "shallow"
        },
        "history": [
          {
            "version": 1,
            "source": "create",
            "prompt": "bad model-supplied history",
            "characters": [],
            "props": [],
            "shot_language": {
              "shot_size": "medium_shot",
              "lens_mm": "35",
              "lighting_key": "mixed"
            },
            "updated_at": "bad"
          }
        ]
      }
    ]
  }
}
"""
                        }
                    }
                ]
            }

    monkeypatch.setattr("server.app.storyboard_generator.requests.post", lambda *args, **kwargs: DriftResponse())

    result = generate_short_drama_storyboard(
        title="Blind Date KPI",
        prompt="family proxy office comedy",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
    )

    shot = result["storyboard"]["shots"][0]
    assert result["series_bible"]["title"] == "Blind Date KPI"
    assert shot["characters"] == ["lin_xiaolu"]
    assert shot["props"] == ["blind-date KPI schedule"]
    assert shot["shot_language"]["shot_size"] == "medium"
    assert shot["shot_language"]["camera_movement"] == "dolly_in"
    assert shot["shot_language"]["lens_mm"] == 35
    assert "lighting_key" not in shot["shot_language"]
    assert shot["shot_language"]["color_temperature"] == "mixed"
    assert shot["history"][0]["prompt"] == "Lin rushes into the proxy office."


def test_generate_short_drama_storyboard_fills_missing_short_drama_shot_language(monkeypatch):
    class SparseLanguageResponse:
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
    "title": "Family Review Pending",
    "mode": "short_drama",
    "characters": []
  },
  "storyboard": {
    "shots": [
      {
        "id": "s1",
        "scene_id": "scene-1",
        "index": 1,
        "beat": "Opening office hook",
        "prompt": "Vertical 9:16 cinematic opening inside a tiny old-neighborhood agency. The door slams open and Lin rushes in under natural daylight. Handheld push-in with medium office comedy blocking.",
        "characters": ["lin_xiaolu"],
        "location": "old-neighborhood agency",
        "props": ["phone"],
        "shot_intent": "Deliver the first-three-second hook.",
        "shot_language": {
          "camera_movement": "push in"
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

    monkeypatch.setattr("server.app.storyboard_generator.requests.post", lambda *args, **kwargs: SparseLanguageResponse())

    result = generate_short_drama_storyboard(
        title="Family Review Pending",
        prompt="family pressure office comedy",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
    )

    shot_language = result["storyboard"]["shots"][0]["shot_language"]
    assert shot_language == {
        "shot_size": "medium",
        "camera_movement": "dolly_in",
        "lens_mm": 35,
        "lighting_key": "natural",
        "depth_of_field": "medium",
        "color_temperature": "neutral",
    }


def test_generate_short_drama_storyboard_fills_missing_shot_prompt(monkeypatch):
    class MissingPromptResponse:
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
    "title": "Family Review Pending",
    "mode": "short_drama",
    "characters": []
  },
  "storyboard": {
    "shots": [
      {
        "id": "s1",
        "scene_id": "scene-1",
        "index": 1,
        "beat": "Lin reveals the family group-chat pressure.",
        "characters": ["lin_xiaolu"],
        "location": "old-neighborhood agency",
        "props": ["phone"],
        "shot_intent": "Introduce the core family-pressure conflict.",
        "shot_language": {}
      }
    ]
  }
}
"""
                        }
                    }
                ]
            }

    monkeypatch.setattr("server.app.storyboard_generator.requests.post", lambda *args, **kwargs: MissingPromptResponse())

    result = generate_short_drama_storyboard(
        title="Family Review Pending",
        prompt="family pressure office comedy",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
    )

    shot = result["storyboard"]["shots"][0]
    assert shot["prompt"] == (
        "Lin reveals the family group-chat pressure. Location: old-neighborhood agency. "
        "Intent: Introduce the core family-pressure conflict."
    )
