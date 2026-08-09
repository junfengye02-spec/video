from __future__ import annotations

from collections import Counter

import pytest

from schemas.artifacts import validate_artifact
from server.app.video_model_profiles import (
    VideoModelDurationConfiguration,
    build_generation_plan as _build_generation_plan,
    video_model_profile,
)


_FIXED_TEST_DURATIONS = {
    "omni_flash-10s": 10,
    "sora_v2": 12,
    "catalog-new-10s": 10,
    "video-model-5s-adaptive": 5,
    "video-model-5s-single-beat": 5,
}


def _test_profile_resolver(model_id, operation, provider):
    if model_id in _FIXED_TEST_DURATIONS:
        return video_model_profile(
            model_id,
            operation,
            provider=provider,
            duration_configuration=VideoModelDurationConfiguration(
                provider=provider,
                model_id=model_id,
                call_duration_seconds=_FIXED_TEST_DURATIONS[model_id],
                version=1,
            ),
        )
    return video_model_profile(model_id, operation, provider=provider)


def build_generation_plan(**kwargs):
    kwargs.setdefault("profile_resolver", _test_profile_resolver)
    return _build_generation_plan(**kwargs)


def _shot(shot_id: str, index: int, **overrides) -> dict:
    return {
        "id": shot_id,
        "scene_id": "scene-1",
        "index": index,
        "beat_id": f"beat-{index}",
        "beat": f"Beat {index}",
        "prompt": f"Perform beat {index}.",
        "status": "ready",
        "version": 1,
        "episode_number": 1,
        "recommended_duration_seconds": 5,
        "duration_range_seconds": [4, 6],
        "can_merge_with_next": True,
        "must_complete_action": False,
        "must_preserve_emotion": False,
        "cannot_split_reason": None,
        "continuity": {"mode": "cut", "inherit_previous_tail": False},
        **overrides,
    }


def _storyboard(count: int = 6, **shot_overrides) -> dict:
    return {
        "shots": [
            _shot(f"s{index}", index, **shot_overrides) for index in range(1, count + 1)
        ]
    }


def _source_shot_groups(plan) -> list[list[str]]:
    return [unit.source_shot_ids for unit in plan.generation_units]


def test_omni_groups_six_five_second_beats_into_three_ten_second_units():
    plan = build_generation_plan(
        storyboard=_storyboard(),
        model_id="omni_flash-10s",
        target_duration_seconds=30,
    )

    assert _source_shot_groups(plan) == [
        ["s1", "s2"],
        ["s3", "s4"],
        ["s5", "s6"],
    ]
    assert plan.storyboard_shot_count == 6
    assert plan.generation_unit_count == 3
    assert plan.native_total_duration_seconds == 30
    assert plan.duration_difference_seconds == 0
    assert plan.compatible_with_target is True
    assert plan.requires_confirmation is False
    assert plan.can_generate is True


def test_sora_returns_three_native_twelve_second_units_and_blocks_for_confirmation():
    plan = build_generation_plan(
        storyboard=_storyboard(),
        model_id="sora_v2",
        target_duration_seconds=30,
    )

    assert _source_shot_groups(plan) == [
        ["s1", "s2"],
        ["s3", "s4"],
        ["s5", "s6"],
    ]
    assert plan.native_total_duration_seconds == 36
    assert plan.duration_difference_seconds == 6
    assert plan.compatible_with_target is False
    assert plan.requires_confirmation is True
    assert plan.can_generate is False
    assert {
        "accept_longer_duration",
        "revise_or_merge_storyboard",
        "choose_compatible_model",
    }.issubset(plan.adaptation_options)


def test_five_second_single_beat_model_keeps_six_units_and_thirty_seconds():
    plan = build_generation_plan(
        storyboard=_storyboard(),
        model_id="video-model-5s-single-beat",
        target_duration_seconds=30,
    )

    assert _source_shot_groups(plan) == [[f"s{index}"] for index in range(1, 7)]
    assert plan.generation_unit_count == 6
    assert plan.native_total_duration_seconds == 30
    assert plan.can_generate is True


def test_non_mergeable_boundary_keeps_every_shot_and_returns_longer_option():
    storyboard = _storyboard()
    storyboard["shots"][0]["can_merge_with_next"] = False

    plan = build_generation_plan(
        storyboard=storyboard,
        model_id="omni_flash-10s",
        target_duration_seconds=30,
    )

    assert plan.generation_unit_count == 4
    assert plan.native_total_duration_seconds == 40
    assert plan.requires_confirmation is True
    assert plan.can_generate is False
    assert Counter(
        shot_id for unit in plan.generation_units for shot_id in unit.source_shot_ids
    ) == Counter(f"s{index}" for index in range(1, 7))


def test_every_selected_shot_is_covered_exactly_once():
    plan = build_generation_plan(
        storyboard=_storyboard(),
        model_id="omni_flash-10s",
        target_duration_seconds=30,
    )

    coverage = Counter(
        shot_id for unit in plan.generation_units for shot_id in unit.source_shot_ids
    )
    assert coverage == Counter(plan.shot_ids)
    assert plan.covered_shot_ids == plan.shot_ids


def test_identical_inputs_produce_a_stable_plan_and_unit_ids():
    storyboard = _storyboard()

    first = build_generation_plan(
        storyboard=storyboard,
        model_id="omni_flash-10s",
        target_duration_seconds=30,
    )
    second = build_generation_plan(
        storyboard=storyboard,
        model_id="omni_flash-10s",
        target_duration_seconds=30,
    )

    assert first.id == second.id
    assert [unit.id for unit in first.generation_units] == [
        unit.id for unit in second.generation_units
    ]


def test_protected_units_remain_frozen_and_only_pending_shots_are_replanned():
    protected = {
        "id": "existing-u1",
        "revision": 2,
        "status": "complete",
        "source_shot_ids": ["s1", "s2"],
        "source_beat_ids": ["beat-1", "beat-2"],
        "provider": "newapi",
        "model_id": "omni_flash-10s",
        "operation": "text_to_video",
        "requested_duration_seconds": 10,
        "output_asset_id": "asset-u1",
        "output_path": "assets/video/units/existing-u1/v2.mp4",
        "billing_job_id": "billing-u1",
        "task_item_id": "task-u1",
    }

    plan = build_generation_plan(
        storyboard=_storyboard(),
        model_id="sora_v2",
        target_duration_seconds=34,
        protected_units=[protected],
    )

    frozen = plan.generation_units[0]
    assert frozen.id == "existing-u1"
    assert frozen.revision == 2
    assert frozen.model_id == "omni_flash-10s"
    assert frozen.output_asset_id == "asset-u1"
    assert plan.protected_generation_unit_ids == ["existing-u1"]
    assert plan.pending_shot_ids == ["s3", "s4", "s5", "s6"]
    assert _source_shot_groups(plan) == [
        ["s1", "s2"],
        ["s3", "s4"],
        ["s5", "s6"],
    ]

    replacement = build_generation_plan(
        storyboard=_storyboard(),
        model_id="sora_v2",
        target_duration_seconds=36,
        protected_units=[protected],
        requested_regeneration_unit_ids=["existing-u1"],
    )
    assert replacement.protected_generation_unit_ids == []
    assert replacement.generation_units[0].replaces_unit_id == "existing-u1"


def test_same_unit_regeneration_advances_the_execution_revision():
    original = build_generation_plan(
        storyboard=_storyboard(),
        model_id="omni_flash-10s",
        target_duration_seconds=30,
    )
    protected = [
        unit.model_copy(update={"status": "complete"})
        for unit in original.generation_units
    ]
    replaced = protected[0]

    replacement = build_generation_plan(
        storyboard=_storyboard(),
        model_id="omni_flash-10s",
        target_duration_seconds=30,
        protected_units=protected,
        requested_regeneration_unit_ids=[replaced.id],
    )
    regenerated = replacement.generation_units[0]

    assert regenerated.id == replaced.id
    assert regenerated.revision == replaced.revision + 1
    assert regenerated.replaces_unit_id == replaced.id


def test_unknown_legacy_profile_on_a_protected_unit_does_not_block_pending_work():
    legacy = {
        "id": "legacy-u1",
        "status": "complete",
        "source_shot_ids": ["s1"],
        "source_beat_ids": ["beat-1"],
        "provider": "legacy",
        "model_id": "legacy_unknown",
        "operation": "text_to_video",
        "requested_duration_seconds": 5,
    }

    plan = build_generation_plan(
        storyboard=_storyboard(),
        model_id="video-model-5s-single-beat",
        target_duration_seconds=30,
        protected_units=[legacy],
    )

    assert plan.can_generate is True
    assert not any(
        issue.code == "video_model_contract_unknown" for issue in plan.issues
    )


def test_dynamic_programming_keeps_distinct_duration_subtotals_until_final_score():
    plan = build_generation_plan(
        storyboard=_storyboard(),
        model_id="omni_flash-10s",
        target_duration_seconds=60,
    )

    assert plan.generation_unit_count == 3
    assert plan.native_total_duration_seconds == 30
    assert plan.duration_difference_seconds == -30


def test_profile_revision_and_requested_regeneration_are_part_of_plan_hash():
    storyboard = _storyboard()
    profile = _test_profile_resolver("omni_flash-10s", "text_to_video", "newapi")
    first = build_generation_plan(
        storyboard=storyboard,
        model_id=profile.model_id,
        model_profile=profile,
        target_duration_seconds=30,
    )
    revised = build_generation_plan(
        storyboard=storyboard,
        model_id=profile.model_id,
        model_profile=profile.model_copy(update={"profile_revision": "test-revision"}),
        target_duration_seconds=30,
    )
    regenerated = build_generation_plan(
        storyboard=storyboard,
        model_id=profile.model_id,
        model_profile=profile,
        target_duration_seconds=30,
        requested_regeneration_unit_ids=["missing-unit"],
    )

    assert first.id != revised.id
    assert first.id != regenerated.id


def test_no_split_beat_can_still_be_generated_as_a_single_unit():
    storyboard = _storyboard(count=2)
    storyboard["shots"][0]["must_complete_action"] = True

    plan = build_generation_plan(
        storyboard=storyboard,
        model_id="video-model-5s-single-beat",
        target_duration_seconds=10,
    )

    assert plan.can_generate is True
    assert not any(
        issue.code == "generation_partition_impossible" for issue in plan.issues
    )
    assert Counter(
        shot_id for unit in plan.generation_units for shot_id in unit.source_shot_ids
    ) == Counter(["s1", "s2"])


def test_no_split_beats_do_not_block_single_beat_longer_model_partition():
    storyboard = _storyboard(count=5)
    protected = {
        "must_complete_action": True,
        "must_preserve_emotion": False,
        "cannot_split_reason": "The action must finish in one beat.",
    }
    storyboard["shots"][0].update(protected)
    storyboard["shots"][2].update(protected)
    storyboard["shots"][3].update(protected)

    plan = build_generation_plan(
        storyboard=storyboard,
        model_id="video-model-5s-single-beat",
        target_duration_seconds=25,
    )

    assert plan.can_generate is True
    assert plan.generation_unit_count == 5
    assert plan.native_total_duration_seconds == 25
    assert not any(
        issue.code == "generation_partition_impossible" for issue in plan.issues
    )


def test_generation_plan_and_execution_snapshot_schemas_accept_v2_contracts():
    plan = build_generation_plan(
        storyboard=_storyboard(),
        model_id="omni_flash-10s",
        target_duration_seconds=30,
    )
    validate_artifact("generation_plan", plan.model_dump(mode="json"))
    validate_artifact(
        "generation_execution",
        {
            "version": "1.0",
            "project_id": "project-1",
            "updated_at": "2026-07-24T12:00:00Z",
            "active_generation_unit_ids": ["unit-1"],
            "generation_units": [
                {
                    "id": "unit-1",
                    "plan_id": plan.id,
                    "revision": 1,
                    "status": "complete",
                    "source_shot_ids": ["s1", "s2"],
                    "source_shot_versions": {"s1": 1, "s2": 1},
                    "source_beat_ids": ["beat-1", "beat-2"],
                    "source_segment_ids": ["segment-1", "segment-2"],
                    "provider": "newapi",
                    "model_id": "omni_flash-10s",
                    "operation": "text_to_video",
                    "requested_duration_seconds": 10,
                    "source_duration_seconds": 10.1,
                    "timeline_duration_seconds": 10.1,
                    "output_asset_id": "asset-1",
                    "output_path": "assets/video/units/unit-1/v1.mp4",
                    "task_item_id": "task-1",
                    "billing_job_id": "billing-1",
                    "replaces_unit_id": None,
                    "created_at": "2026-07-24T11:00:00Z",
                    "updated_at": "2026-07-24T12:00:00Z",
                }
            ],
        },
    )


def test_configured_catalog_model_packs_underfilled_beats_without_static_capability():
    storyboard = {
        "shots": [
            _shot("s1", 1, recommended_duration_seconds=3),
            _shot("s2", 2, recommended_duration_seconds=4),
        ]
    }

    plan = build_generation_plan(
        storyboard=storyboard,
        model_id="catalog-new-10s",
        target_duration_seconds=10,
    )

    assert _source_shot_groups(plan) == [["s1", "s2"]]
    assert plan.generation_units[0].source_beat_ids == ["beat-1", "beat-2"]
    assert plan.generation_units[0].requested_duration_seconds == 10
    assert plan.generation_units[0].timeline_duration_seconds == 10
    assert plan.native_total_duration_seconds == 10


def test_ordered_packing_uses_stable_ab_cd_partition_for_plan_example():
    storyboard = {
        "shots": [
            _shot("s1", 1, recommended_duration_seconds=3),
            _shot("s2", 2, recommended_duration_seconds=4),
            _shot("s3", 3, recommended_duration_seconds=6),
            _shot("s4", 4, recommended_duration_seconds=4),
        ]
    }

    first = build_generation_plan(storyboard=storyboard, model_id="catalog-new-10s")
    second = build_generation_plan(storyboard=storyboard, model_id="catalog-new-10s")

    assert _source_shot_groups(first) == [["s1", "s2"], ["s3", "s4"]]
    assert [unit.requested_duration_seconds for unit in first.generation_units] == [
        10,
        10,
    ]
    assert first.native_total_duration_seconds == 20
    assert [unit.id for unit in first.generation_units] == [
        unit.id for unit in second.generation_units
    ]


def test_packing_has_no_fixed_beat_count_limit_and_respects_non_mergeable_boundary():
    mergeable = {
        "shots": [
            _shot(f"s{index}", index, recommended_duration_seconds=2)
            for index in range(1, 5)
        ]
    }
    packed = build_generation_plan(
        storyboard=mergeable,
        model_id="catalog-new-10s",
    )
    assert _source_shot_groups(packed) == [["s1", "s2", "s3", "s4"]]

    mergeable["shots"][1]["can_merge_with_next"] = False
    bounded = build_generation_plan(
        storyboard=mergeable,
        model_id="catalog-new-10s",
    )
    assert _source_shot_groups(bounded) == [["s1", "s2"], ["s3", "s4"]]


def _adaptation_result(request, *, introduced_story_facts=None):
    segment_ids = list(request.requested_segment_ids)
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
                "start_state": "letter sealed" if index == 1 else "letter half open",
                "action_progress": (
                    "The hand reaches and starts opening the letter."
                    if index == 1
                    else "The hand finishes opening the same letter."
                ),
                "end_state": "letter half open" if index == 1 else "letter open",
                "prompt": f"Continuous visual action part {index}.",
                "continuity_requirements": ["same hand", "same sealed letter"],
                "introduced_story_facts": introduced_story_facts or [],
                "immutable_story_facts_hash": request.immutable_story_facts_hash,
            }
            for index, segment_id in enumerate(segment_ids, start=1)
        ],
    }


def test_eight_second_beat_uses_two_ordered_five_second_units_from_fake_adapter():
    storyboard = {
        "shots": [
            _shot(
                "s1",
                1,
                beat_id="beat-long",
                beat="A hand opens the sealed letter.",
                prompt="A hand opens the sealed letter in one continuous scene.",
                recommended_duration_seconds=8,
                duration_range_seconds=[8, 8],
            )
        ]
    }
    calls = []

    def fake_adapter(request):
        calls.append(request)
        return _adaptation_result(request)

    plan = build_generation_plan(
        storyboard=storyboard,
        model_id="video-model-5s-adaptive",
        adaptation_planner=fake_adapter,
        confirmed_beats=[
            {
                "id": "beat-long",
                "summary": "A hand opens the sealed letter.",
                "recommended_duration_seconds": 8,
            }
        ],
        series_bible={"characters": [], "assets": []},
    )

    assert len(calls) == 1
    assert calls[0].segment_count == 2
    assert plan.generation_unit_count == 2
    assert plan.native_total_duration_seconds == 10
    assert len(plan.generation_segments) == 2
    assert [segment.sequence for segment in plan.generation_segments] == [1, 2]
    assert {segment.source_beat_id for segment in plan.generation_segments} == {
        "beat-long"
    }
    assert [unit.source_shot_ids for unit in plan.generation_units] == [
        ["s1"],
        ["s1"],
    ]
    assert [unit.source_segment_ids for unit in plan.generation_units] == [
        [plan.generation_segments[0].id],
        [plan.generation_segments[1].id],
    ]
    assert [unit.requested_duration_seconds for unit in plan.generation_units] == [
        5,
        5,
    ]


def test_adaptation_rejects_wrong_segment_count_and_introduced_story_facts():
    storyboard = {
        "shots": [
            _shot(
                "s1", 1, recommended_duration_seconds=8, duration_range_seconds=[8, 8]
            )
        ]
    }

    def wrong_count(request):
        result = _adaptation_result(request)
        result["segments"].pop()
        return result

    with pytest.raises(ValueError, match="video_generation_adaptation_invalid"):
        build_generation_plan(
            storyboard=storyboard,
            model_id="video-model-5s-adaptive",
            adaptation_planner=wrong_count,
        )

    with pytest.raises(
        ValueError, match="video_generation_adaptation_story_fact_changed"
    ):
        build_generation_plan(
            storyboard=storyboard,
            model_id="video-model-5s-adaptive",
            adaptation_planner=lambda request: _adaptation_result(
                request,
                introduced_story_facts=["A new villain enters the room."],
            ),
        )


def test_cannot_split_overlong_beat_returns_structured_blocker_without_calling_adapter():
    storyboard = {
        "shots": [
            _shot(
                "s1",
                1,
                recommended_duration_seconds=8,
                duration_range_seconds=[8, 8],
                must_complete_action=True,
            )
        ]
    }

    def unexpected_adapter(_request):
        raise AssertionError("cannot-split beat must not call the text adapter")

    plan = build_generation_plan(
        storyboard=storyboard,
        model_id="video-model-5s-adaptive",
        adaptation_planner=unexpected_adapter,
    )

    assert plan.can_generate is False
    assert plan.generation_unit_count == 0
    issue = next(issue for issue in plan.issues if issue.code == "beat_cannot_split")
    assert issue.shot_id == "s1"
    assert {"choose_longer_duration_model", "revise_narrative_beat"}.issubset(
        plan.adaptation_options
    )


def test_legacy_overlong_hard_beat_is_adapted_into_provider_sized_segments():
    storyboard = {
        "shots": [
            _shot(
                "s1",
                1,
                recommended_duration_seconds=16,
                duration_range_seconds=[14, 18],
                must_complete_action=True,
                cannot_split_reason="The action should land cleanly.",
            )
        ]
    }
    adapter_calls = []

    def adapt(request):
        adapter_calls.append(request)
        result = _adaptation_result(request)
        for index, segment in enumerate(result["segments"]):
            segment["start_state"] = f"state-{index}"
            segment["end_state"] = f"state-{index + 1}"
        return result

    plan = build_generation_plan(
        storyboard=storyboard,
        model_id="video-model-5s-adaptive",
        adaptation_planner=adapt,
    )

    assert len(adapter_calls) == 1
    assert plan.can_generate is True
    assert not any(issue.code == "beat_cannot_split" for issue in plan.issues)
    assert plan.generation_unit_count == 4


def test_descriptive_reason_without_protection_flags_does_not_block_adaptation():
    storyboard = {
        "shots": [
            _shot(
                "s1",
                1,
                recommended_duration_seconds=8,
                duration_range_seconds=[8, 8],
                cannot_split_reason="This beat is visually important.",
            )
        ]
    }
    adapter_calls = 0

    def adapt(request):
        nonlocal adapter_calls
        adapter_calls += 1
        return _adaptation_result(request)

    plan = build_generation_plan(
        storyboard=storyboard,
        model_id="video-model-5s-adaptive",
        adaptation_planner=adapt,
    )

    assert adapter_calls == 1
    assert plan.can_generate is True
    assert not any(issue.code == "beat_cannot_split" for issue in plan.issues)


def test_protected_units_may_share_a_beat_but_not_a_generation_segment():
    storyboard = {
        "shots": [
            _shot(
                "s1",
                1,
                beat_id="beat-long",
                recommended_duration_seconds=8,
                duration_range_seconds=[8, 8],
            )
        ]
    }
    profile = _test_profile_resolver(
        "video-model-5s-adaptive", "text_to_video", "newapi"
    )
    protected = []
    for index in (1, 2):
        segment_id = f"segment-{index}"
        protected.append(
            {
                "id": f"existing-u{index}",
                "revision": 1,
                "status": "complete",
                "source_shot_ids": ["s1"],
                "source_beat_ids": ["beat-long"],
                "source_segment_ids": [segment_id],
                "prompt_segments": [
                    {
                        "id": segment_id,
                        "source_shot_id": "s1",
                        "source_beat_id": "beat-long",
                        "sequence": index,
                        "segment_index": index,
                        "segment_count": 2,
                        "recommended_content_duration_seconds": 4,
                        "prompt": f"part {index}",
                        "transition": "continuous",
                        "continuity_requirements": ["same action"],
                        "start_state": "start",
                        "action_progress": f"progress {index}",
                        "end_state": "end",
                    }
                ],
                "provider": "newapi",
                "model_id": "video-model-5s-adaptive",
                "operation": "text_to_video",
                "requested_duration_seconds": 5,
                "source_duration_seconds": 5,
                "timeline_duration_seconds": 5,
                "profile": profile.model_dump(mode="json"),
            }
        )

    plan = build_generation_plan(
        storyboard=storyboard,
        model_id="video-model-5s-adaptive",
        protected_units=protected,
    )

    assert [unit.id for unit in plan.generation_units] == [
        "existing-u1",
        "existing-u2",
    ]
    assert plan.covered_segment_ids == ["segment-1", "segment-2"]

    protected[1]["source_segment_ids"] = ["segment-1"]
    protected[1]["prompt_segments"][0]["id"] = "segment-1"
    with pytest.raises(ValueError, match="segments"):
        build_generation_plan(
            storyboard=storyboard,
            model_id="video-model-5s-adaptive",
            protected_units=protected,
        )


def test_one_beat_two_units_can_regenerate_one_segment_without_replacing_its_sibling():
    storyboard = {
        "shots": [
            _shot(
                "s1",
                1,
                beat_id="beat-long",
                beat="A hand opens the sealed letter.",
                prompt="A hand opens the sealed letter in one continuous scene.",
                recommended_duration_seconds=8,
                duration_range_seconds=[8, 8],
            )
        ]
    }

    def fake_adapter(request):
        return _adaptation_result(request)

    original = build_generation_plan(
        storyboard=storyboard,
        model_id="video-model-5s-adaptive",
        adaptation_planner=fake_adapter,
    )
    protected = [
        unit.model_copy(update={"status": "complete"})
        for unit in original.generation_units
    ]
    replaced, sibling = protected

    replacement = build_generation_plan(
        storyboard=storyboard,
        model_id="video-model-5s-adaptive",
        protected_units=protected,
        requested_regeneration_unit_ids=[replaced.id],
        adaptation_planner=fake_adapter,
    )

    planned = [
        unit for unit in replacement.generation_units if unit.status == "planned"
    ]
    assert replacement.protected_generation_unit_ids == [sibling.id]
    assert len(planned) == 1
    assert planned[0].id == replaced.id
    assert planned[0].revision == replaced.revision + 1
    assert planned[0].replaces_unit_id == replaced.id
    assert planned[0].source_segment_ids == replaced.source_segment_ids
    assert replacement.covered_segment_ids == original.covered_segment_ids
