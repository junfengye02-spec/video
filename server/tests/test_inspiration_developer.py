import json

from server.app.inspiration_developer import (
    normalize_inspiration_result,
    prepare_inspiration_request,
)
from server.app.models import InspirationMessage


def test_prepare_inspiration_request_preserves_conversation_and_project_context():
    request = prepare_inspiration_request(
        title="Rain Letter",
        project_type="single_video",
        messages=[
            InspirationMessage(role="user", content="A courier finds a letter from tomorrow."),
            InspirationMessage(role="assistant", content="Who is the audience?"),
            InspirationMessage(role="user", content="Young suspense fans."),
        ],
        model="gpt-5.5",
    )

    payload = json.loads(request.content)
    assert payload["model"] == "gpt-5.5"
    assert "creative producer" in payload["messages"][0]["content"]
    assert "Working title: Rain Letter" in payload["messages"][1]["content"]
    assert payload["messages"][-1] == {
        "role": "user",
        "content": "Young suspense fans.",
    }


def test_prepare_inspiration_request_exposes_series_length_constraints():
    request = prepare_inspiration_request(
        title="Rain Letter",
        project_type="long_series",
        messages=[InspirationMessage(role="user", content="A mystery series")],
        model="gpt-5.5",
    )

    payload = json.loads(request.content)
    context = payload["messages"][1]["content"]
    assert "12-24 episodes" in context
    assert "series bible" in payload["messages"][0]["content"].lower()
    assert "project type in the system context is authoritative" in payload["messages"][0]["content"].lower()
    assert "duration_seconds means the target duration of one episode" in payload["messages"][0]["content"]


def test_normalize_inspiration_result_returns_a_stable_structured_brief():
    result = normalize_inspiration_result(
        """
        ```json
        {
          "reply": "The direction is clear and ready for planning.",
          "ready_to_confirm": true,
          "brief": {
            "title": "Letter from Tomorrow",
            "logline": "A courier receives a letter from tomorrow.",
            "duration_seconds": "60",
            "aspect_ratio": "9:16",
            "must_have": "rainy night",
            "open_questions": []
          }
        }
        ```
        """
    )

    assert result["ready_to_confirm"] is True
    assert result["brief"]["duration_seconds"] == 60
    assert result["brief"]["must_have"] == ["rainy night"]
    assert result["brief"]["visual_style"] == ""
    assert result["brief"]["narrative_beats"] == []


def test_normalize_inspiration_result_does_not_treat_false_string_as_ready():
    result = normalize_inspiration_result(
        json.dumps(
            {
                "reply": "We still need to settle the ending.",
                "ready_to_confirm": "false",
                "brief": {},
            }
        )
    )

    assert result["ready_to_confirm"] is False


def test_ready_brief_normalizes_stable_narrative_beats_without_provider_duration():
    result = normalize_inspiration_result(
        json.dumps(
            {
                "reply": "Ready.",
                "ready_to_confirm": True,
                "brief": {
                    "duration_seconds": 30,
                    "narrative_beats": [
                        {
                            "summary": f"Beat {index}",
                            "requested_duration_seconds": 10,
                        }
                        for index in range(1, 7)
                    ],
                },
            }
        )
    )

    beats = result["brief"]["narrative_beats"]
    assert [beat["id"] for beat in beats] == [
        f"beat-{index}" for index in range(1, 7)
    ]
    assert [beat["index"] for beat in beats] == list(range(1, 7))
    assert all(beat["recommended_duration_seconds"] == 5 for beat in beats)
    assert all(beat["duration_range_seconds"] == (4.0, 6.0) for beat in beats)
    assert all("requested_duration_seconds" not in beat for beat in beats)


def test_narrative_beat_reason_requires_an_explicit_protection_flag():
    result = normalize_inspiration_result(
        json.dumps(
            {
                "reply": "Ready.",
                "ready_to_confirm": True,
                "brief": {
                    "duration_seconds": 20,
                    "narrative_beats": [
                        {
                            "summary": "A visually important establishing beat.",
                            "recommended_duration_seconds": 10,
                            "must_complete_action": False,
                            "must_preserve_emotion": False,
                            "cannot_split_reason": "This beat is important to the story.",
                        },
                        {
                            "summary": "A single uninterrupted emotional reaction.",
                            "recommended_duration_seconds": 10,
                            "must_complete_action": False,
                            "must_preserve_emotion": True,
                            "cannot_split_reason": "The reaction must remain continuous.",
                        },
                    ],
                },
            }
        )
    )

    beats = result["brief"]["narrative_beats"]
    assert beats[0]["cannot_split_reason"] is None
    assert beats[1]["cannot_split_reason"] == "The reaction must remain continuous."


def test_normalize_inspiration_result_splits_overlong_beats_into_short_shots():
    result = normalize_inspiration_result(
        json.dumps(
            {
                "reply": "Ready.",
                "ready_to_confirm": True,
                "brief": {
                    "duration_seconds": 60,
                    "narrative_beats": [
                        {
                            "id": "beat-long",
                            "summary": "The photographer reaches the ridge and waits for sunrise.",
                            "recommended_duration_seconds": 16,
                            "must_complete_action": True,
                            "cannot_split_reason": "The final decision should land cleanly.",
                        }
                    ],
                },
            }
        )
    )

    beats = result["brief"]["narrative_beats"]
    assert [beat["id"] for beat in beats] == ["beat-long-1", "beat-long-2"]
    assert [beat["recommended_duration_seconds"] for beat in beats] == [8.0, 8.0]
    assert all(beat["recommended_duration_seconds"] <= 10 for beat in beats)
    assert beats[0]["can_merge_with_next"] is True
    assert beats[1]["must_complete_action"] is True
    assert beats[1]["cannot_split_reason"] is not None


def test_inspiration_prompt_requests_narrative_beats_but_not_provider_duration():
    request = prepare_inspiration_request(
        title="Rain Letter",
        project_type="single_video",
        messages=[InspirationMessage(role="user", content="A 30 second mystery")],
        model="gpt-5.5",
    )

    system_prompt = json.loads(request.content)["messages"][0]["content"]
    assert "narrative_beats" in system_prompt
    assert "requested_duration_seconds" not in system_prompt
    assert "cannot_split_reason must be null" in system_prompt
    assert "Each narrative beat is exactly one storyboard shot" in system_prompt
    assert "between 4 and 10 seconds" in system_prompt
    assert "split" in system_prompt
    assert "multiple ordered beats" in system_prompt
    assert "visible opening condition" in system_prompt
    assert "visible ending condition" in system_prompt
    assert "Do not add camera, lens, lighting" in system_prompt
