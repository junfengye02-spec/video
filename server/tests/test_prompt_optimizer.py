from server.app.prompt_optimizer import optimize_text_prompt


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
