from server.app.consistency import evaluate_storyboard_consistency


def test_consistency_flags_missing_locked_character_reference():
    series_bible = {
        "characters": [
            {"id": "c1", "name": "Lin", "visual_lock": "red coat, short hair", "locked": True}
        ]
    }
    storyboard = {
        "shots": [
            {"id": "s1", "characters": ["c1"], "prompt": "Lin runs through the rain"}
        ]
    }

    report = evaluate_storyboard_consistency(series_bible, storyboard)

    assert report["score"] < 100
    assert report["issues"][0]["code"] == "missing_visual_lock"

