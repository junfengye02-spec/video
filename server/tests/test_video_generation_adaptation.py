from __future__ import annotations

import json

import pytest

from server.app.video_generation_adaptation import (
    VideoGenerationAdaptationError,
    VideoGenerationAdaptationRequest,
    adaptation_cache_key,
    load_cached_adaptation,
    prepare_video_generation_adaptation_request,
    resolve_cached_adaptation,
    validate_adaptation_result,
)


def _request(**overrides):
    values = {
        "storyboard_revision": "sha256:" + "a" * 64,
        "beat_content_hash": "sha256:" + "b" * 64,
        "model_id": "video-model",
        "profile_revision": "profile-v1",
        "call_duration_seconds": 5,
        "segment_count": 2,
        "requested_segment_ids": ["segment-1", "segment-2"],
        "source_beat_id": "beat-1",
        "source_shot_id": "shot-1",
        "confirmed_beats": [{"id": "beat-1", "summary": "Open the letter"}],
        "current_beat": {"id": "beat-1", "summary": "Open the letter"},
        "previous_beat": None,
        "next_beat": None,
        "storyboard_shot": {"id": "shot-1", "prompt": "Open the letter"},
        "series_bible": {
            "characters": [{"id": "lin"}],
            "assets": [{"id": "letter", "kind": "prop"}],
        },
        "immutable_story_facts": ["Open the letter"],
        "immutable_story_facts_hash": "sha256:" + "c" * 64,
    }
    values.update(overrides)
    return VideoGenerationAdaptationRequest.model_validate(values)


def _result(request):
    return {
        "task_type": "video_generation_adaptation",
        "immutable_story_facts_hash": request.immutable_story_facts_hash,
        "preserved_story_facts": request.immutable_story_facts,
        "segments": [
            {
                "id": segment_id,
                "source_beat_id": request.source_beat_id,
                "source_shot_id": request.source_shot_id,
                "segment_index": index,
                "segment_count": request.segment_count,
                "start_state": "closed" if index == 1 else "half-open",
                "action_progress": f"progress {index}",
                "end_state": "half-open" if index == 1 else "open",
                "prompt": f"part {index}",
                "continuity_requirements": ["same letter"],
                "introduced_story_facts": [],
                "immutable_story_facts_hash": request.immutable_story_facts_hash,
            }
            for index, segment_id in enumerate(request.requested_segment_ids, start=1)
        ],
    }


def test_adaptation_cache_hits_for_identical_preview_and_skips_model_call():
    request = _request()
    cache = {}
    calls = []

    def generate(value):
        calls.append(value)
        return _result(value)

    first = resolve_cached_adaptation(
        request,
        load=cache.get,
        save=cache.__setitem__,
        generate=generate,
    )
    second = resolve_cached_adaptation(
        request,
        load=cache.get,
        save=cache.__setitem__,
        generate=generate,
    )

    assert first == second
    assert len(calls) == 1
    assert list(cache) == [adaptation_cache_key(request)]


def test_model_specific_cache_reuses_and_migrates_legacy_result():
    request = _request()
    legacy_key = adaptation_cache_key(request)
    selected_model_key = adaptation_cache_key(request, text_model="planner-b")
    cache = {legacy_key: _result(request)}
    calls = []

    result = resolve_cached_adaptation(
        request,
        load=cache.get,
        save=cache.__setitem__,
        generate=lambda value: calls.append(value),
        text_model="planner-b",
    )

    assert result == validate_adaptation_result(request, cache[legacy_key])
    assert not calls
    assert cache[selected_model_key] == result.model_dump(mode="json")


def test_legacy_cache_loader_validates_before_migration():
    request = _request()
    legacy_key = adaptation_cache_key(request)
    cache = {legacy_key: _result(request)}
    selected_model_key = adaptation_cache_key(request, text_model="planner-a")

    result = load_cached_adaptation(
        request,
        load=cache.get,
        save=cache.__setitem__,
        text_model="planner-a",
    )

    assert result is not None
    assert selected_model_key in cache


def test_adaptation_rejects_deleted_or_changed_immutable_story_facts():
    request = _request(
        immutable_story_facts=["Open the letter", "Lin remains in the study"]
    )
    result = _result(request)
    result["preserved_story_facts"] = ["Open a different letter"]

    with pytest.raises(
        VideoGenerationAdaptationError,
        match="video_generation_adaptation_story_fact_changed",
    ):
        validate_adaptation_result(request, result)


def test_adaptation_uses_an_independent_strict_structured_text_request():
    request = _request()
    prepared = prepare_video_generation_adaptation_request(
        request,
        text_model="planning-model",
    )
    body = json.loads(prepared.content)
    schema = body["response_format"]["json_schema"]
    supplied = json.loads(body["messages"][1]["content"])
    system_prompt = body["messages"][0]["content"]

    assert prepared.path == "/v1/chat/completions"
    assert body["model"] == "planning-model"
    assert schema["name"] == "video_generation_adaptation"
    assert schema["strict"] is True
    assert schema["schema"]["properties"]["task_type"] == {
        "type": "string",
        "const": "video_generation_adaptation",
    }
    assert "preserved_story_facts" in schema["schema"]["required"]
    assert supplied["task_type"] == "video_generation_adaptation"
    assert supplied["confirmed_beats"] == request.confirmed_beats
    assert supplied["storyboard_shot"] == request.storyboard_shot
    assert supplied["series_bible"] == request.series_bible
    assert "executable video-model instruction" in system_prompt
    assert "camera framing/angle/lens/movement/focus" in system_prompt
    assert "identity/wardrobe/style drift" in system_prompt


def test_adaptation_cache_key_naturally_invalidates_on_required_contract_inputs():
    original = _request()
    original_key = adaptation_cache_key(original)

    assert adaptation_cache_key(original, text_model="planner-a") != (
        adaptation_cache_key(original, text_model="planner-b")
    )

    assert (
        adaptation_cache_key(_request(storyboard_revision="sha256:" + "d" * 64))
        != original_key
    )
    assert (
        adaptation_cache_key(_request(beat_content_hash="sha256:" + "e" * 64))
        != original_key
    )
    assert adaptation_cache_key(_request(model_id="different-model")) != original_key
    assert adaptation_cache_key(_request(profile_revision="profile-v2")) != original_key
    assert (
        adaptation_cache_key(
            _request(
                segment_count=3,
                requested_segment_ids=["segment-1", "segment-2", "segment-3"],
            )
        )
        != original_key
    )
    assert (
        adaptation_cache_key(
            _request(series_bible={"characters": [{"id": "chen"}], "assets": []})
        )
        != original_key
    )
    assert (
        adaptation_cache_key(
            _request(next_beat={"id": "beat-2", "summary": "Chen enters"})
        )
        != original_key
    )
    assert (
        adaptation_cache_key(
            _request(
                immutable_story_facts=["Open the letter", "Lin stays seated"],
                immutable_story_facts_hash="sha256:" + "f" * 64,
            )
        )
        != original_key
    )
