import json

import pytest

from server.app.prompt_optimizer import (
    optimize_text_prompt,
    prepare_prompt_optimization_request,
)


@pytest.mark.parametrize(
    ("asset_kind", "required_phrases"),
    [
        (
            "character",
            (
                "character turnaround/model sheet",
                "front, three-quarter, profile, and back full-body views",
                "same face and identity",
                "hairstyle, costume, accessories",
                "neutral pose and expression",
            ),
        ),
        (
            "scene",
            (
                "environment continuity board",
                "wide establishing",
                "eye-level master",
                "side or reverse angle",
                "architecture, entrances, fixed props, spatial layout",
                "time of day, lighting, weather",
            ),
        ),
        (
            "prop",
            (
                "prop turnaround/reference sheet",
                "front, three-quarter, side or back",
                "material/detail views",
                "shape, scale, materials, wear, markings, and colors",
            ),
        ),
    ],
)
def test_asset_prompt_optimization_request_is_kind_specific(
    asset_kind, required_phrases
):
    request = prepare_prompt_optimization_request(
        source_text="A detective in a rainy alley.",
        model="gpt-5.5",
        context={
            "target": "asset",
            "target_id": "image-generation-draft",
            "mode": "text",
            "asset_kind": asset_kind,
        },
    )

    payload = json.loads(request.content)
    user_message = payload["messages"][1]["content"]
    assert "image-generation prompt" in user_message
    assert "visual consistency in a short drama" in user_message
    for phrase in required_phrases:
        assert phrase in user_message
    assert "unrelated objects, captions, labels, logos, or watermarks" in user_message
    assert "Return only the revised prompt text" in user_message


def test_optimize_text_prompt_can_return_structured_shot_json(monkeypatch):
    class StructuredResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": """
{
  "prompt": "Lin in red coat opens the soaked envelope under neon rain.",
  "shot_intent": "Push into the clue as Lin realizes the betrayal.",
  "shot_language": {
    "shot_size": "close_up",
    "camera_movement": "dolly_in",
    "lens_mm": 85,
    "depth_of_field": "shallow"
  }
}
"""
                        }
                    }
                ]
            }

    monkeypatch.setattr("server.app.prompt_optimizer.requests.post", lambda **kwargs: StructuredResponse())

    result = optimize_text_prompt(
        source_text="Lin opens envelope.",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
        context={"target": "shot", "target_id": "s1", "mode": "shot_json"},
    )

    assert result["optimized_text"].startswith("Lin in red coat")
    assert result["shot_intent"].startswith("Push into")
    assert result["shot_language"]["camera_movement"] == "dolly_in"


def test_structured_shot_optimizer_requests_an_executable_detailed_prompt():
    request = prepare_prompt_optimization_request(
        source_text="Lin opens envelope.",
        model="gpt-5.5",
        context={"target": "shot", "target_id": "s1", "mode": "shot_json"},
    )

    user_message = json.loads(request.content)["messages"][1]["content"]
    assert "detailed executable video-generation instruction" in user_message
    assert "chronological visible action" in user_message
    assert "camera height/angle/framing/lens/movement/focus" in user_message
    assert "negative constraints against new people or objects" in user_message


def test_optimize_text_prompt_keeps_text_mode_response_without_shot_fields(monkeypatch):
    class TextResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": "Tighten the alley prompt around Lin's discovery and the rain-soaked envelope."
                        }
                    }
                ]
            }

    monkeypatch.setattr("server.app.prompt_optimizer.requests.post", lambda **kwargs: TextResponse())

    result = optimize_text_prompt(
        source_text="Lin opens envelope.",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
    )

    assert result == {
        "optimized_text": "Tighten the alley prompt around Lin's discovery and the rain-soaked envelope.",
        "notes": ["rewritten by text model"],
    }


def test_optimize_text_prompt_structured_mode_falls_back_to_source_text_when_prompt_missing(monkeypatch):
    class StructuredResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": """
{
  "shot_intent": "Push into the clue as Lin realizes the betrayal.",
  "shot_language": {
    "shot_size": "close_up"
  }
}
"""
                        }
                    }
                ]
            }

    monkeypatch.setattr("server.app.prompt_optimizer.requests.post", lambda **kwargs: StructuredResponse())

    result = optimize_text_prompt(
        source_text="Lin opens envelope.",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
        context={"target": "shot", "target_id": "s1", "mode": "shot_json"},
    )

    assert result["optimized_text"] == "Lin opens envelope."
    assert result["shot_intent"].startswith("Push into")


def test_optimize_text_prompt_structured_mode_drops_non_object_shot_language(monkeypatch):
    class StructuredResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": """
{
  "prompt": "Lin enters the office and spots the KPI trap.",
  "shot_intent": "Clarify the character objective.",
  "shot_language": "ENGLISH"
}
"""
                        }
                    }
                ]
            }

    monkeypatch.setattr("server.app.prompt_optimizer.requests.post", lambda **kwargs: StructuredResponse())

    result = optimize_text_prompt(
        source_text="Lin opens envelope.",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
        context={"target": "shot", "target_id": "s1", "mode": "shot_json"},
    )

    assert result["optimized_text"].startswith("Lin enters")
    assert result["shot_language"] is None


def test_optimize_text_prompt_structured_mode_normalizes_fenced_array_response(monkeypatch):
    class FencedArrayResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": """
```json
[
  {
    "prompt": "Lin rushes into the proxy office under warm practical light.",
    "shot_intent": "Make the first beat feel urgent and funny.",
    "shot_language": {
      "shot_size": "medium_shot",
      "camera_movement": "push in",
      "lens_mm": "50mm",
      "lighting_key": "mixed",
      "depth_of_field": "shallow"
    }
  }
]
```
"""
                        }
                    }
                ]
            }

    monkeypatch.setattr("server.app.prompt_optimizer.requests.post", lambda **kwargs: FencedArrayResponse())

    result = optimize_text_prompt(
        source_text="Lin enters.",
        model="gpt-5.5",
        base_url="https://api.0000238.xyz",
        api_key="text-key",
        context={"target": "shot", "target_id": "s1", "mode": "shot_json"},
    )

    assert result["optimized_text"].startswith("Lin rushes")
    assert result["shot_intent"].startswith("Make the first")
    assert result["shot_language"]["shot_size"] == "medium"
    assert result["shot_language"]["camera_movement"] == "dolly_in"
    assert result["shot_language"]["lens_mm"] == 50
    assert result["shot_language"]["color_temperature"] == "mixed"
