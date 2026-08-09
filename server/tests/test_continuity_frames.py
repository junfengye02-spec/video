from __future__ import annotations

from server.app.continuity_frames import (
    KeyframeGenerationCoordinator,
    build_continuity_prompt,
    invalidate_inherited_frames,
    resolve_continuity,
    resolve_video_frame_operation,
)


def _shot(shot_id: str, version: int, *, continuity: dict | None = None) -> dict:
    return {
        "id": shot_id,
        "version": version,
        "prompt": f"shot {shot_id}",
        "continuity": continuity or {},
    }


def test_carry_inherits_previous_tail_but_cut_does_not():
    previous = _shot(
        "s1",
        3,
        continuity={
            "mode": "carry",
            "last_frame": {
                "asset_id": "tail-1",
                "version": 2,
                "status": "ready",
                "source": "generated",
            },
        },
    )
    carry = resolve_continuity(
        _shot("s2", 1, continuity={"mode": "carry", "inherit_previous_tail": True}),
        previous,
    )
    cut = resolve_continuity(
        _shot("s3", 1, continuity={"mode": "cut", "inherit_previous_tail": True}),
        previous,
    )

    assert carry["first_frame"] == {
        "asset_id": "tail-1",
        "version": 2,
        "status": "ready",
        "source": "inherited",
        "origin_shot_id": "s1",
        "origin_shot_version": 3,
        "origin_frame_version": 2,
    }
    assert cut["first_frame"] is None


def test_explicit_first_frame_wins_over_inherited_tail():
    previous = _shot(
        "s1",
        1,
        continuity={
            "mode": "carry",
            "last_frame": {"asset_id": "tail-1", "version": 1, "status": "ready"},
        },
    )
    resolved = resolve_continuity(
        _shot(
            "s2",
            1,
            continuity={
                "mode": "carry",
                "inherit_previous_tail": True,
                "first_frame": {
                    "asset_id": "explicit-2",
                    "version": 4,
                    "status": "ready",
                },
            },
        ),
        previous,
    )

    assert resolved["first_frame"]["asset_id"] == "explicit-2"
    assert resolved["first_frame"]["source"] == "user"
    assert "origin_shot_id" not in resolved["first_frame"]


def test_explicit_user_asset_id_wins_and_removal_falls_back_to_inherited_asset_id():
    with_user = resolve_continuity(
        _shot(
            "s2",
            1,
                continuity={
                    "mode": "carry",
                    "inherit_previous_tail": True,
                    "explicit_user_first_frame_asset_id": "user-upload",
                "inherited_first_frame_asset_id": "tail-extracted",
            },
        )
    )
    after_remove = resolve_continuity(
        _shot(
            "s2",
            1,
                continuity={
                    "mode": "carry",
                    "inherit_previous_tail": True,
                    "explicit_user_first_frame_asset_id": None,
                "inherited_first_frame_asset_id": "tail-extracted",
            },
        )
    )

    assert with_user["first_frame"]["asset_id"] == "user-upload"
    assert with_user["first_frame"]["source"] == "user"
    assert after_remove["first_frame"]["asset_id"] == "tail-extracted"
    assert after_remove["first_frame"]["source"] == "inherited"


def test_persisted_inherited_frame_is_inactive_for_cut_or_disabled_carry():
    persisted = {
        "inherited_first_frame_asset_id": "tail-extracted",
        "first_frame": {
            "asset_id": "tail-extracted",
            "version": 2,
            "status": "ready",
            "source": "inherited",
            "origin_shot_id": "s1",
            "origin_shot_version": 1,
            "origin_frame_version": 2,
        },
    }

    cut = resolve_continuity(
        _shot("s2", 1, continuity={**persisted, "mode": "cut", "inherit_previous_tail": True})
    )
    disabled = resolve_continuity(
        _shot("s2", 1, continuity={**persisted, "mode": "carry", "inherit_previous_tail": False})
    )

    assert cut["first_frame"] is None
    assert disabled["first_frame"] is None
    assert cut["inherited_first_frame_asset_id"] == "tail-extracted"
    assert disabled["inherited_first_frame_asset_id"] == "tail-extracted"


def test_upstream_regeneration_marks_inherited_downstream_stale():
    shots = [
        _shot(
            "s1",
            2,
            continuity={
                "last_frame": {"asset_id": "tail-new", "version": 3, "status": "ready"}
            },
        ),
        _shot(
            "s2",
            1,
            continuity={
                "mode": "carry",
                "first_frame": {
                    "asset_id": "tail-old",
                    "version": 2,
                    "status": "ready",
                    "source": "inherited",
                    "origin_shot_id": "s1",
                    "origin_shot_version": 1,
                    "origin_frame_version": 2,
                },
            },
        ),
    ]

    invalidate_inherited_frames(shots, upstream_shot_id="s1", upstream_version=2, upstream_frame_version=3)

    assert shots[1]["continuity"]["first_frame"]["status"] == "stale"
    assert shots[1]["continuity"]["stale"] is True
    assert shots[1]["continuity"]["first_frame"]["asset_id"] == "tail-old"


def test_continuity_prompt_locks_direction_and_scene_state():
    prompt = build_continuity_prompt(
        {
            "mode": "carry",
            "motion_direction": "screen-left to screen-right",
            "subject_pose": "right hand still holding the envelope",
            "gaze": "toward the doorway",
            "lighting": "cool window light from camera left",
            "scene_state": "rain on the glass, envelope open",
        }
    )

    assert "screen-left to screen-right" in prompt
    assert "right hand still holding the envelope" in prompt
    assert "Do not reverse the established motion direction" in prompt


def test_provider_capability_detection_is_explicit_and_degrades_legally():
    providers = [
        {
            "supports": {"reference_to_video": True},
            "input_schema": {"properties": {"reference_image_paths": {}}},
        }
    ]
    assert resolve_video_frame_operation("first", "last", providers) == "reference_to_video"
    assert resolve_video_frame_operation("first", "last", [{"supports": {"first_last_frame_to_video": True}}]) == "first_last_frame_to_video"
    assert resolve_video_frame_operation(None, None, providers) == "text_to_video"
    assert resolve_video_frame_operation(
        "first", None, [{"supports": {"image_to_video": True}}]
    ) == "image_to_video"


def test_keyframe_generation_quotes_once_deduplicates_and_preserves_old_refs_on_failure():
    coordinator = KeyframeGenerationCoordinator()
    calls: list[str] = []
    quotes: list[str] = []
    old = {"first_frame": {"asset_id": "old-first", "status": "ready"}}

    def quote():
        quotes.append("quote")
        return {"quote_id": "q1"}

    def generate(_quote):
        calls.append("generate")
        raise RuntimeError("provider failed")

    failed = coordinator.request(
        shot_id="s1",
        shot_version=2,
        prompt="tail frame",
        existing=old,
        quote=quote,
        generate=generate,
    )
    duplicate = coordinator.request(
        shot_id="s1",
        shot_version=2,
        prompt="tail frame",
        existing=old,
        quote=quote,
        generate=generate,
    )

    assert failed.status == "failed"
    assert failed.references == old
    assert duplicate.status == "failed"
    assert quotes == ["quote"]
    assert calls == ["generate"]
