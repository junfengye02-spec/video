from pydantic import ValidationError

from server.app.models import Shot, ShotLanguage, ShotRegenerateRequest, ShotSaveRequest


def test_shot_accepts_structured_shot_language():
    shot = Shot(
        id="s1",
        scene_id="scene-1",
        index=1,
        beat="Lin finds the envelope",
        prompt="Lin in red coat finds a soaked envelope.",
        characters=["c1"],
        location="rainy alley",
        shot_intent="Start with a tense clue reveal.",
        shot_language={
            "shot_size": "medium_close",
            "camera_movement": "dolly_in",
            "lens_mm": 50,
            "depth_of_field": "shallow",
            "lighting_key": "neon",
            "color_temperature": "cool",
        },
    )

    assert shot.shot_language.shot_size == "medium_close"
    assert shot.shot_language.camera_movement == "dolly_in"
    assert shot.shot_intent == "Start with a tense clue reveal."


def test_shot_language_rejects_unknown_values():
    try:
        ShotLanguage(shot_size="mega_close")
    except ValidationError as exc:
        assert "shot_size" in str(exc)
    else:
        raise AssertionError("invalid shot_size was accepted")


def test_shot_save_accepts_partial_shot_language():
    payload = ShotSaveRequest(
        shot_language={"shot_size": "wide", "camera_movement": "static"},
        shot_intent="Establish the alley before the confrontation.",
    )

    assert payload.shot_language.shot_size == "wide"
    assert payload.shot_intent.startswith("Establish")


def test_shot_regenerate_request_rejects_metadata_fields():
    try:
        ShotRegenerateRequest(
            video_key="vid-test-key-1234567890abcdef",
            shot_intent="Should not be allowed here",
        )
    except ValidationError as exc:
        assert "shot_intent" in str(exc)
    else:
        raise AssertionError("metadata field was accepted by regenerate request")
