import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from server.app.db.base import Base
from server.app.video_model_profiles import (
    VideoModelDurationConfiguration,
    VideoModelProfile,
    build_generation_plan as _build_generation_plan,
    model_profiles,
    operation_for_shot,
    video_model_profile,
)
from server.app.video_model_settings.service import bootstrap_verified_duration_settings


def _test_profile_resolver(model_id, operation, provider):
    fixed = {
        "omni_flash-10s": 10,
        "sora_v2": 12,
        "sora-2-12s": 12,
    }
    if model_id in fixed:
        return video_model_profile(
            model_id,
            operation,
            provider=provider,
            duration_configuration=VideoModelDurationConfiguration(
                provider=provider,
                model_id=model_id,
                call_duration_seconds=fixed[model_id],
                version=1,
            ),
        )
    if model_id == "video-model-flexible":
        return VideoModelProfile(
            provider=provider,
            model_id=model_id,
            operation=operation,
            duration_mode="flexible",
            min_duration_seconds=2,
            max_duration_seconds=20,
            contract_source="verified_override",
            profile_revision="test-flexible-v1",
        )
    if model_id == "video-model-values":
        return VideoModelProfile(
            provider=provider,
            model_id=model_id,
            operation=operation,
            duration_mode="supported_values",
            supported_duration_seconds=[4, 6, 8, 10],
            contract_source="verified_override",
            profile_revision="test-values-v1",
        )
    return video_model_profile(model_id, operation, provider=provider)


def build_generation_plan(**kwargs):
    kwargs.setdefault("profile_resolver", _test_profile_resolver)
    return _build_generation_plan(**kwargs)


@pytest.fixture
def duration_db():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        bootstrap_verified_duration_settings(db)
        db.commit()
        yield db
    engine.dispose()


def _storyboard(*shots: dict) -> dict:
    return {"shots": list(shots)}


def _shot(shot_id: str, index: int, prompt: str, **extra) -> dict:
    return {
        "id": shot_id,
        "index": index,
        "beat": prompt,
        "prompt": prompt,
        "status": "ready",
        "continuity": {"mode": "cut", "inherit_previous_tail": False},
        **extra,
    }


def test_catalog_profiles_are_keyed_by_model_and_operation(duration_db):
    text = video_model_profile("omni_flash-10s", "text_to_video", db=duration_db)
    first_last = video_model_profile(
        "omni_flash-10s", "first_last_frame_to_video", db=duration_db
    )

    assert text.fixed_duration_seconds == 10
    assert text.supports_start_frame is False
    assert text.supports_sequential_beats is True
    assert text.supports_multi_shot_prompt is True
    assert text.max_narrative_beats_per_unit == 2
    assert text.profile_revision
    assert text.profile_revision == first_last.profile_revision
    assert first_last.fixed_duration_seconds == 10
    assert first_last.supports_start_frame is False
    assert first_last.supports_end_frame is False
    assert first_last.max_reference_images is None
    sora = video_model_profile("sora_v2", "text_to_video", db=duration_db)
    assert sora.fixed_duration_seconds == 12
    assert sora.supports_sequential_beats is True
    assert sora.max_narrative_beats_per_unit == 2
    assert (
        video_model_profile(
            "sora-2-12s", "text_to_video", db=duration_db
        ).fixed_duration_seconds
        == 12
    )


def test_newapi_profiles_never_advertise_unverified_native_frame_controls(duration_db):
    profiles = model_profiles(
        ["omni_flash-10s", "veo_3_1-lite", "veo_3_1-fast-fl", "video-model"],
        db=duration_db,
    )

    assert profiles
    assert all(profile.supports_start_frame is False for profile in profiles)
    assert all(profile.supports_end_frame is False for profile in profiles)


def test_unknown_catalog_model_is_returned_as_unknown_instead_of_guessed(duration_db):
    profiles = model_profiles(["provider-added-model"], db=duration_db)

    assert len(profiles) == 1
    assert profiles[0].model_id == "provider-added-model"
    assert profiles[0].duration_mode == "unknown"
    assert profiles[0].supports_sequential_beats is False
    assert profiles[0].max_narrative_beats_per_unit == 1


def test_fixed_model_plan_keeps_complete_native_duration_and_requires_confirmation():
    storyboard = _storyboard(
        _shot("s1", 1, "A short reveal."),
        _shot("s2", 2, "A longer action completes without interruption."),
        _shot("s3", 3, "The reaction lands."),
    )

    plan = build_generation_plan(
        storyboard=storyboard,
        model_id="omni_flash-10s",
        target_duration_seconds=20,
    )

    assert [unit.requested_duration_seconds for unit in plan.generation_units] == [
        10,
        10,
        10,
    ]
    assert plan.native_total_duration_seconds == 30
    assert plan.timeline_total_duration_seconds == 30
    assert plan.requires_confirmation is True
    assert plan.can_generate is False
    assert "accept_longer_duration" in plan.adaptation_options
    assert plan.issues[-1].message == (
        "所选分镜按模型原生时长预计生成 30 秒，与 20 秒的创意目标不一致。"
    )


def test_accepting_native_duration_confirms_without_rewriting_storyboard():
    storyboard = _storyboard(_shot("s1", 1, "Reveal."), _shot("s2", 2, "Resolve."))
    original = [dict(shot) for shot in storyboard["shots"]]

    plan = build_generation_plan(
        storyboard=storyboard,
        model_id="sora_v2",
        target_duration_seconds=30,
        confirmed_strategy="accept_model_duration",
    )

    assert plan.native_total_duration_seconds == 24
    assert plan.requires_confirmation is False
    assert storyboard["shots"] == original
    assert all("requested_duration_seconds" not in shot for shot in storyboard["shots"])


def test_flexible_duration_plan_uses_content_weights_instead_of_equal_split():
    storyboard = _storyboard(
        _shot("s1", 1, "Look up."),
        _shot(
            "s2",
            2,
            "Cross the crowded station, find the hidden case, open it, and read the letter.",
            must_complete_action=True,
        ),
    )

    plan = build_generation_plan(
        storyboard=storyboard,
        model_id="video-model-flexible",
        target_duration_seconds=18,
    )

    durations = [unit.requested_duration_seconds for unit in plan.generation_units]
    assert durations[0] != durations[1]
    assert sum(durations) == 18
    assert plan.compatible_with_target is True


def test_each_storyboard_shot_remains_its_own_generation_unit():
    storyboard = _storyboard(
        _shot("s1", 1, "One."),
        _shot("s2", 2, "Two."),
        _shot("s3", 3, "Three."),
    )

    plan = build_generation_plan(
        storyboard=storyboard,
        model_id="video-model-values",
        target_duration_seconds=19,
    )

    assert [unit.shot_ids for unit in plan.generation_units] == [["s1"], ["s2"], ["s3"]]


def test_continuity_requirements_select_native_frame_operations():
    carry = _shot("s2", 2, "Continue.")
    carry["continuity"] = {"mode": "carry", "inherit_previous_tail": True}
    completed = _shot(
        "s3",
        3,
        "Retry.",
        status="complete",
        output_path="assets/video/s3.mp4",
    )
    completed["continuity"] = {
        "mode": "cut",
        "inherit_previous_tail": False,
        "first_frame": {"asset_id": "first", "status": "ready"},
        "last_frame": {"asset_id": "last", "status": "ready"},
    }

    assert operation_for_shot(carry) == "image_to_video"
    assert operation_for_shot(completed) == "first_last_frame_to_video"


def test_generation_plan_marks_unverified_frames_as_reference_guided():
    completed = _shot(
        "s1",
        1,
        "Retry with fixed boundary frames.",
        status="complete",
        output_path="assets/video/s1.mp4",
    )
    completed["continuity"] = {
        "mode": "cut",
        "inherit_previous_tail": False,
        "first_frame": {"asset_id": "first", "status": "ready"},
        "last_frame": {"asset_id": "last", "status": "ready"},
    }

    plan = build_generation_plan(
        storyboard=_storyboard(completed),
        model_id="omni_flash-10s",
    )

    issue_codes = {issue.code for issue in plan.issues}
    assert plan.generation_units[0].requested_duration_seconds == 10
    assert plan.can_generate is True
    assert "video_model_start_frame_reference_guided" in issue_codes
    assert "video_model_end_frame_reference_guided" in issue_codes
    assert "use_reference_frame_guidance" in plan.adaptation_options


def test_generation_plan_id_changes_when_storyboard_changes():
    storyboard = _storyboard(_shot("s1", 1, "Original."))
    first = build_generation_plan(storyboard=storyboard, model_id="omni_flash-10s")
    storyboard["shots"][0]["prompt"] = "Changed."
    second = build_generation_plan(storyboard=storyboard, model_id="omni_flash-10s")

    assert first.storyboard_revision != second.storyboard_revision
    assert first.id != second.id
