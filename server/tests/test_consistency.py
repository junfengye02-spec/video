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


def test_consistency_accepts_identity_with_a_distinctive_visual_lock_cue():
    series_bible = {
        "characters": [
            {
                "id": "c1",
                "name": "Lin",
                "visual_lock": "red coat, short hair",
                "locked": True,
            }
        ],
        "assets": [],
    }
    storyboard = {
        "shots": [
            {
                "id": "s1",
                "characters": ["c1"],
                "prompt": "Lin turns toward camera in her red coat",
                "location": "alley",
                "shot_language": {
                    "shot_size": "medium",
                    "camera_movement": "static",
                },
            }
        ]
    }

    report = evaluate_storyboard_consistency(series_bible, storyboard)

    assert report == {"score": 100, "issues": []}


def test_consistency_flags_missing_shot_language():
    series_bible = {"characters": [], "assets": []}
    storyboard = {
        "shots": [
            {"id": "s1", "characters": [], "prompt": "Alley shot", "location": "alley", "shot_language": {}}
        ]
    }

    report = evaluate_storyboard_consistency(series_bible, storyboard)

    assert any(issue["code"] == "missing_shot_language" for issue in report["issues"])


def test_consistency_flags_unknown_asset_reference():
    series_bible = {"characters": [], "assets": [{"id": "asset-known"}]}
    storyboard = {
        "shots": [
            {
                "id": "s1",
                "characters": [],
                "prompt": "Alley shot",
                "location": "alley",
                "asset_ids": ["asset-missing"],
                "shot_language": {"shot_size": "wide", "camera_movement": "static"},
            }
        ]
    }

    report = evaluate_storyboard_consistency(series_bible, storyboard)

    assert any(issue["code"] == "unknown_asset" for issue in report["issues"])
