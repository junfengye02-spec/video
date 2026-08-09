import json

from server.app.main import _default_continuity_plan, _merge_generated_continuity


def test_generated_visual_rules_are_readable_and_seed_portrait_preferences():
    plan = _default_continuity_plan("single_video")
    merged = _merge_generated_continuity(
        plan,
        {
            "visual_rules": {
                "aspect_ratio": "9:16",
                "duration_seconds": 20,
                "composition": "Keep the dancer centered",
            }
        },
        inherit_generation_preferences=True,
    )

    assert json.loads(merged["series_bible"]["visual_rules"]) == {
        "aspect_ratio": "9:16",
        "duration_seconds": 20,
        "composition": "Keep the dancer centered",
    }
    assert merged["generation_preferences"]["aspect_ratio"] == "9:16"
    assert merged["generation_preferences"]["image_size"] == "1024x1536"


def test_replanning_preserves_explicit_generation_preferences():
    plan = _default_continuity_plan("single_video")
    plan["generation_preferences"]["aspect_ratio"] = "4:3"
    plan["generation_preferences"]["image_size"] = "1536x1024"

    merged = _merge_generated_continuity(
        plan,
        {"visual_rules": {"aspect_ratio": "9:16"}},
    )

    assert merged["generation_preferences"]["aspect_ratio"] == "4:3"
    assert merged["generation_preferences"]["image_size"] == "1536x1024"


def test_generated_continuity_only_fills_empty_fields_and_preserves_locked_episodes():
    plan = _default_continuity_plan("mini_series")
    plan["series_bible"]["worldview"] = "User's world"
    plan["series_bible"]["relationship_map"] = ["User relationship"]
    plan["episodes"] = [{
        "episode_number": 1,
        "title": "User episode",
        "goal": "User goal",
        "conflict": "",
        "twist": "",
        "cliffhanger": "",
        "inherited_state": [],
        "prompt": "User prompt",
        "outline": "User outline",
        "locked": True,
    }]

    merged = _merge_generated_continuity(
        plan,
        {
            "worldview": "Generated world",
            "main_arc": "Generated arc",
            "relationship_map": ["Generated relationship"],
            "series_prompt": "Generated series prompt",
            "episodes": [
                {
                    "episode_number": 1,
                    "title": "Generated title",
                    "goal": "Generated goal",
                    "conflict": "Generated conflict",
                    "prompt": "Generated prompt",
                    "outline": "Generated outline",
                },
                {"episode_number": 2, "title": "Generated second"},
            ],
        },
    )

    assert merged["series_bible"]["worldview"] == "User's world"
    assert merged["series_bible"]["main_arc"] == "Generated arc"
    assert merged["series_bible"]["relationship_map"] == ["User relationship"]
    assert merged["series_bible"]["series_prompt"] == "Generated series prompt"
    assert merged["episodes"][0]["title"] == "User episode"
    assert merged["episodes"][0]["conflict"] == ""
    assert merged["episodes"][0]["prompt"] == "User prompt"
    assert merged["episodes"][0]["locked"] is True
    assert merged["episodes"][1]["title"] == "Generated second"


def test_generated_sound_does_not_replace_explicit_false_toggle():
    plan = _default_continuity_plan("single_video")
    plan["sound"]["storyboard_prompt_integration"] = False
    merged = _merge_generated_continuity(
        plan,
        {"sound_plan": {"storyboard_prompt_integration": True}},
        inherit_generation_preferences=True,
    )
    assert merged["sound"]["storyboard_prompt_integration"] is False
