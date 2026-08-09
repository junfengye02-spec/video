from server.app.mock_runner import build_mock_short_drama, update_mock_shot


def test_mock_runner_builds_characters_and_shots():
    result = build_mock_short_drama("urban reversal short drama, rain night, lead finds the truth")

    assert len(result["series_bible"]["characters"]) >= 2
    assert len(result["storyboard"]["shots"]) >= 4
    assert result["storyboard"]["shots"][0]["status"] == "ready"


def test_mock_runner_keeps_completed_video_when_metadata_changes():
    storyboard = {
        "shots": [
            {
                "id": "s1",
                "version": 1,
                "status": "complete",
                "output_path": "assets/video/s1.mp4",
                "output_url": "https://video.example/s1.mp4",
                "prompt": "Original",
                "characters": [],
                "props": [],
                "history": [],
            }
        ]
    }

    shot = update_mock_shot(
        storyboard,
        "s1",
        {"prompt": "Updated"},
        source="prompt_edit",
    )

    assert shot["status"] == "complete"
    assert shot["output_path"] == "assets/video/s1.mp4"
    assert shot["output_url"] == "https://video.example/s1.mp4"
