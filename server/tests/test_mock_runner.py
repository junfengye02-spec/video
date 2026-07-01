from server.app.mock_runner import build_mock_short_drama


def test_mock_runner_builds_characters_and_shots():
    result = build_mock_short_drama("urban reversal short drama, rain night, lead finds the truth")

    assert len(result["series_bible"]["characters"]) >= 2
    assert len(result["storyboard"]["shots"]) >= 4
    assert result["storyboard"]["shots"][0]["status"] == "ready"
