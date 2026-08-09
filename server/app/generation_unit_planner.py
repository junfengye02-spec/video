from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Literal

from server.app.video_generation_adaptation import (
    GenerateAdaptation,
    VideoGenerationAdaptationRequest,
    stable_hash,
    validate_adaptation_result,
)
from server.app.video_model_profiles import (
    GenerationSegment,
    GenerationPlan,
    GenerationPlanIssue,
    GenerationUnit,
    VideoModelProfile,
    VideoOperation,
    operation_for_shot,
    video_model_profile,
)


ConfirmedStrategy = Literal["accept_model_duration", "accept_longer_duration"]
ProfileResolver = Callable[[str, VideoOperation, str], VideoModelProfile]
_PROTECTED_STATUSES = {"queued", "running", "waiting_provider", "complete"}
_BLOCKING_ISSUES = {
    "beat_cannot_split",
    "generation_partition_impossible",
    "video_generation_adaptation_required",
    "video_model_contract_unknown",
}
_AUTO_SPLIT_THRESHOLD_SECONDS = 10.0


def build_generation_plan(
    *,
    storyboard: Mapping[str, Any],
    model_id: str,
    shot_ids: Sequence[str] | None = None,
    target_duration_seconds: float | None = None,
    provider: str = "newapi",
    operation: VideoOperation | None = None,
    model_profile: VideoModelProfile | None = None,
    profile_resolver: ProfileResolver | None = None,
    protected_units: Sequence[GenerationUnit | Mapping[str, Any]] = (),
    requested_regeneration_unit_ids: Sequence[str] = (),
    confirmed_strategy: ConfirmedStrategy | None = None,
    confirmed_beats: Sequence[Mapping[str, Any]] | None = None,
    series_bible: Mapping[str, Any] | None = None,
    adaptation_planner: GenerateAdaptation | None = None,
) -> GenerationPlan:
    ordered = _ordered_shots(storyboard)
    shots = _select_shots(ordered, shot_ids)
    requested_ids = [str(shot["id"]) for shot in shots]
    target = _positive_number(target_duration_seconds)
    storyboard_revision = _storyboard_revision(storyboard)
    requested_regeneration_ids = sorted(
        {str(unit_id) for unit_id in requested_regeneration_unit_ids}
    )
    if model_profile is not None:
        _validate_profile_override(
            model_profile,
            provider=provider,
            model_id=model_id,
            operation=operation,
        )

    positions = {str(shot["id"]): index for index, shot in enumerate(shots)}
    shots_by_id = {str(shot["id"]): shot for shot in shots}
    issues: list[GenerationPlanIssue] = []
    protected = _normalize_protected_units(
        protected_units,
        requested_regeneration_ids=set(requested_regeneration_ids),
        shots=shots,
        positions=positions,
        shots_by_id=shots_by_id,
        profile_resolver=profile_resolver,
        storyboard_revision=storyboard_revision,
    )
    replacement_sources = _requested_replacement_sources(
        protected_units,
        requested_regeneration_ids=set(requested_regeneration_ids),
    )
    protected_segments_by_shot, fully_protected_shot_ids = _protected_segment_coverage(
        protected
    )
    pending = [
        shot for shot in shots if str(shot["id"]) not in fully_protected_shot_ids
    ]
    pending_ids = [str(shot["id"]) for shot in pending]

    protected_native_duration = sum(
        unit.requested_duration_seconds or 0 for unit in protected
    )
    pending_target = (
        max(target - protected_native_duration, 0) if target is not None else None
    )
    pending_recommendation = sum(_recommended_duration(shot) or 0 for shot in pending)
    planned: list[GenerationUnit] = []
    planned_segments: list[GenerationSegment] = []
    next_sequence = 1
    for run in _pending_runs(pending, positions):
        run_recommendation = sum(_recommended_duration(shot) or 0 for shot in run)
        run_target = run_recommendation or None
        if pending_target is not None:
            if pending_recommendation > 0:
                run_target = (
                    pending_target * run_recommendation / pending_recommendation
                )
            elif pending:
                run_target = pending_target * len(run) / len(pending)
        run_units, run_segments, run_issues = _plan_run(
            run,
            provider=provider,
            model_id=model_id,
            operation=operation,
            model_profile=model_profile,
            profile_resolver=profile_resolver,
            target_hint=run_target,
            storyboard_revision=storyboard_revision,
            sequence_start=next_sequence,
            confirmed_beats=confirmed_beats,
            series_bible=series_bible,
            adaptation_planner=adaptation_planner,
            protected_segments_by_shot=protected_segments_by_shot,
        )
        planned.extend(run_units)
        planned_segments.extend(run_segments)
        next_sequence += len(run_segments)
        issues.extend(run_issues)
    planned_with_replacements: list[GenerationUnit] = []
    for unit in planned:
        replacement = next(
            (
                replacement_sources[key]
                for key in _replacement_source_keys(unit.model_dump(mode="json"))
                if key in replacement_sources
            ),
            None,
        )
        if replacement is None:
            planned_with_replacements.append(unit)
            continue
        replaced_id, replaced_revision = replacement
        planned_with_replacements.append(
            unit.model_copy(
                update={
                    "revision": (
                        replaced_revision + 1
                        if unit.id == replaced_id
                        else unit.revision
                    ),
                    "replaces_unit_id": replaced_id,
                }
            )
        )
    planned = planned_with_replacements

    units = sorted(
        [*protected, *planned],
        key=lambda unit: (
            positions[unit.source_shot_ids[0]],
            min(segment.sequence for segment in unit.prompt_segments),
            unit.id,
        ),
    )
    generation_segments = sorted(
        [
            *(segment for unit in protected for segment in unit.prompt_segments),
            *planned_segments,
        ],
        key=lambda segment: (
            positions[segment.source_shot_id],
            segment.sequence,
            segment.id,
        ),
    )
    _validate_exact_coverage(
        [segment.id for segment in generation_segments],
        units,
    )
    for unit in planned:
        issues.extend(_profile_issues(unit))

    durations = [unit.requested_duration_seconds for unit in units]
    complete_duration_plan = bool(durations) and all(
        duration is not None for duration in durations
    )
    native_total = (
        round(sum(duration for duration in durations if duration is not None), 3)
        if complete_duration_plan
        else None
    )
    compatible = bool(
        complete_duration_plan
        and (target is None or math.isclose(native_total or 0, target, abs_tol=0.05))
    )
    duration_difference = (
        round((native_total or 0) - target, 3)
        if native_total is not None and target is not None
        else None
    )
    mismatch = bool(target is not None and complete_duration_plan and not compatible)
    if mismatch:
        issues.append(
            GenerationPlanIssue(
                code="target_duration_incompatible",
                message=(
                    f"所选分镜按模型原生时长预计生成 {native_total:g} 秒，"
                    f"与 {target:g} 秒的创意目标不一致。"
                ),
            )
        )

    accepted_mismatch = confirmed_strategy in {
        "accept_model_duration",
        "accept_longer_duration",
    }
    has_pending_generation = any(unit.status == "planned" for unit in planned)
    has_blocker = any(issue.code in _BLOCKING_ISSUES for issue in issues)
    # A fully retained project may legitimately be shorter than its original
    # creative target.  There is no provider call left to confirm in that
    # case, so a duration mismatch must not block reuse of the existing media.
    requires_confirmation = bool(
        mismatch and not accepted_mismatch and has_pending_generation
    )
    can_generate = bool(
        not has_blocker
        and complete_duration_plan
        and (not mismatch or accepted_mismatch or not has_pending_generation)
    )
    adaptation_options = _adaptation_options(
        issues=issues,
        mismatch=mismatch,
    )
    canonical = _plan_hash_payload(
        storyboard_revision=storyboard_revision,
        provider=provider,
        model_id=model_id,
        operation=operation,
        target=target,
        shots=shots,
        units=units,
        protected_ids=[unit.id for unit in protected],
        requested_regeneration_ids=requested_regeneration_ids,
        confirmed_strategy=confirmed_strategy,
    )
    plan_id = _hash(canonical)
    covered_shot_ids = [
        shot_id
        for shot_id in requested_ids
        if any(shot_id in unit.source_shot_ids for unit in units)
    ]
    return GenerationPlan(
        id=plan_id,
        storyboard_revision=storyboard_revision,
        provider=provider,
        model_id=model_id,
        shot_ids=requested_ids,
        storyboard_shot_count=len(requested_ids),
        generation_unit_count=len(units),
        protected_generation_unit_ids=[unit.id for unit in protected],
        pending_shot_ids=pending_ids,
        covered_shot_ids=covered_shot_ids,
        covered_segment_ids=[segment.id for segment in generation_segments],
        target_duration_seconds=target,
        native_total_duration_seconds=native_total,
        timeline_total_duration_seconds=native_total,
        duration_difference_seconds=duration_difference,
        compatible_with_target=compatible,
        requires_confirmation=requires_confirmation,
        can_generate=can_generate,
        confirmed_strategy=confirmed_strategy,
        issues=issues,
        adaptation_options=adaptation_options,
        generation_segments=generation_segments,
        generation_units=units,
    )


def _ordered_shots(storyboard: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    raw_shots = storyboard.get("shots", [])
    if not isinstance(raw_shots, list):
        raise ValueError("storyboard shots must be an array")
    ordered = sorted(
        (shot for shot in raw_shots if isinstance(shot, Mapping) and shot.get("id")),
        key=lambda shot: (
            _safe_int(shot.get("episode_number"), 0),
            _safe_int(shot.get("index"), 0),
            str(shot.get("id")),
        ),
    )
    ids = [str(shot["id"]) for shot in ordered]
    if len(ids) != len(set(ids)):
        raise ValueError("storyboard shot IDs must be unique")
    return ordered


def _select_shots(
    ordered: Sequence[Mapping[str, Any]], shot_ids: Sequence[str] | None
) -> list[Mapping[str, Any]]:
    if shot_ids is None:
        selected = list(ordered)
    else:
        requested = [str(shot_id) for shot_id in shot_ids]
        if len(requested) != len(set(requested)):
            raise ValueError("generation plan shot IDs must be unique")
        requested_set = set(requested)
        selected = [shot for shot in ordered if str(shot["id"]) in requested_set]
        if len(selected) != len(requested_set):
            raise ValueError("generation plan contains unavailable shots")
    if not selected:
        raise ValueError("generation plan requires at least one shot")
    return selected


def _validate_profile_override(
    profile: VideoModelProfile,
    *,
    provider: str,
    model_id: str,
    operation: VideoOperation | None,
) -> None:
    if profile.provider != provider or profile.model_id != model_id:
        raise ValueError("model profile does not match provider and model")
    if operation is not None and profile.operation != operation:
        raise ValueError("model profile does not match the requested operation")


def _normalize_protected_units(
    values: Sequence[GenerationUnit | Mapping[str, Any]],
    *,
    requested_regeneration_ids: set[str],
    shots: Sequence[Mapping[str, Any]],
    positions: Mapping[str, int],
    shots_by_id: Mapping[str, Mapping[str, Any]],
    profile_resolver: ProfileResolver | None,
    storyboard_revision: str,
) -> list[GenerationUnit]:
    result: list[GenerationUnit] = []
    covered_segments: set[str] = set()
    for value in values:
        raw = (
            value.model_dump(mode="json")
            if isinstance(value, GenerationUnit)
            else dict(value)
        )
        unit_id = str(raw.get("id") or "")
        if not unit_id:
            raise ValueError("protected unit ID is required")
        if unit_id in requested_regeneration_ids:
            continue
        status = str(raw.get("status") or "complete")
        if status not in _PROTECTED_STATUSES:
            continue
        source_ids = [
            str(shot_id)
            for shot_id in (raw.get("source_shot_ids") or raw.get("shot_ids") or [])
        ]
        _validate_protected_mapping(
            unit_id,
            source_ids,
            raw.get("source_shot_versions"),
            positions=positions,
            shots_by_id=shots_by_id,
        )
        source_shots = [shots_by_id[shot_id] for shot_id in source_ids]
        unit_operation = _operation_value(raw.get("operation"))
        unit_provider = str(raw.get("provider") or "newapi")
        unit_model = str(raw.get("model_id") or "legacy_unknown")
        profile_value = raw.get("profile")
        profile = (
            VideoModelProfile.model_validate(profile_value)
            if isinstance(profile_value, Mapping)
            else _resolve_profile(
                profile_resolver,
                model_id=unit_model,
                operation=unit_operation,
                provider=unit_provider,
            )
        )
        prompt_segments = _normalize_generation_segments(
            raw.get("prompt_segments"),
            source_shots=source_shots,
            source_segment_ids=raw.get("source_segment_ids"),
            storyboard_revision=storyboard_revision,
            profile_revision=profile.profile_revision,
            sequence_start=positions[source_ids[0]] + 1,
            legacy_unit_id=unit_id,
        )
        source_segment_ids = [segment.id for segment in prompt_segments]
        overlap = covered_segments.intersection(source_segment_ids)
        if overlap:
            raise ValueError(
                "protected units overlap on segments: " + ", ".join(sorted(overlap))
            )
        covered_segments.update(source_segment_ids)
        result.append(
            GenerationUnit(
                id=unit_id,
                revision=max(_safe_int(raw.get("revision"), 1), 1),
                status=status,
                shot_ids=source_ids,
                source_shot_ids=source_ids,
                source_beat_ids=_source_beat_ids(
                    source_shots, raw.get("source_beat_ids")
                ),
                source_segment_ids=source_segment_ids,
                prompt_segments=prompt_segments,
                provider=unit_provider,
                model_id=unit_model,
                operation=unit_operation,
                requested_duration_seconds=_positive_number(
                    raw.get("requested_duration_seconds")
                ),
                source_duration_seconds=_positive_number(
                    raw.get("source_duration_seconds")
                ),
                timeline_duration_seconds=_positive_number(
                    raw.get("timeline_duration_seconds")
                ),
                output_asset_id=_optional_string(raw.get("output_asset_id")),
                output_path=_optional_string(raw.get("output_path")),
                billing_job_id=_optional_string(raw.get("billing_job_id")),
                task_item_id=_optional_string(raw.get("task_item_id")),
                replaces_unit_id=_optional_string(raw.get("replaces_unit_id")),
                profile=profile,
            )
        )
    return sorted(
        result,
        key=lambda unit: (
            positions[unit.source_shot_ids[0]],
            min(segment.sequence for segment in unit.prompt_segments),
            unit.id,
        ),
    )


def _validate_protected_mapping(
    unit_id: str,
    source_ids: Sequence[str],
    versions: Any,
    *,
    positions: Mapping[str, int],
    shots_by_id: Mapping[str, Mapping[str, Any]],
) -> None:
    if not source_ids or any(shot_id not in positions for shot_id in source_ids):
        raise ValueError(f"protected unit {unit_id} contains unavailable shots")
    indexes = [positions[shot_id] for shot_id in source_ids]
    if indexes != list(range(indexes[0], indexes[0] + len(indexes))):
        raise ValueError(f"protected unit {unit_id} must cover consecutive shots")
    episodes = {shots_by_id[shot_id].get("episode_number") for shot_id in source_ids}
    if len(episodes) != 1:
        raise ValueError(f"protected unit {unit_id} cannot cross episode boundaries")
    if isinstance(versions, Mapping):
        version_map = {str(key): _safe_int(value, 0) for key, value in versions.items()}
    elif isinstance(versions, list) and len(versions) == len(source_ids):
        version_map = {
            shot_id: _safe_int(version, 0)
            for shot_id, version in zip(source_ids, versions, strict=True)
        }
    else:
        version_map = {}
    for shot_id, expected in version_map.items():
        current = _safe_int(shots_by_id[shot_id].get("version"), 1)
        if expected != current:
            raise ValueError(
                f"protected unit {unit_id} references a stale shot version"
            )


def _protected_segment_coverage(
    units: Sequence[GenerationUnit],
) -> tuple[dict[str, set[str]], set[str]]:
    segment_ids_by_shot: dict[str, set[str]] = {}
    indexes_by_shot: dict[str, set[int]] = {}
    counts_by_shot: dict[str, set[int]] = {}
    for unit in units:
        for segment in unit.prompt_segments:
            shot_id = segment.source_shot_id
            segment_ids_by_shot.setdefault(shot_id, set()).add(segment.id)
            indexes_by_shot.setdefault(shot_id, set()).add(segment.segment_index)
            counts_by_shot.setdefault(shot_id, set()).add(segment.segment_count)

    fully_covered = {
        shot_id
        for shot_id, indexes in indexes_by_shot.items()
        if len(counts_by_shot[shot_id]) == 1
        and indexes == set(range(1, next(iter(counts_by_shot[shot_id])) + 1))
    }
    return segment_ids_by_shot, fully_covered


def _requested_replacement_sources(
    values: Sequence[GenerationUnit | Mapping[str, Any]],
    *,
    requested_regeneration_ids: set[str],
) -> dict[tuple[str, ...], tuple[str, int]]:
    candidates: dict[tuple[str, ...], set[tuple[str, int]]] = {}
    for value in values:
        raw = (
            value.model_dump(mode="json")
            if isinstance(value, GenerationUnit)
            else value
        )
        unit_id = str(raw.get("id") or "")
        if unit_id not in requested_regeneration_ids:
            continue
        source = (unit_id, max(_safe_int(raw.get("revision"), 1), 1))
        for key in _replacement_source_keys(raw):
            candidates.setdefault(key, set()).add(source)
    return {
        key: next(iter(sources))
        for key, sources in candidates.items()
        if len(sources) == 1
    }


def _replacement_source_keys(raw: Mapping[str, Any]) -> list[tuple[str, ...]]:
    keys: list[tuple[str, ...]] = []
    segment_ids = tuple(
        str(segment_id) for segment_id in (raw.get("source_segment_ids") or [])
    )
    if segment_ids:
        keys.append(("segments", *segment_ids))

    coverage: list[str] = []
    prompt_segments = raw.get("prompt_segments")
    if isinstance(prompt_segments, list):
        for segment in prompt_segments:
            if not isinstance(segment, Mapping):
                coverage = []
                break
            shot_id = str(
                segment.get("source_shot_id") or segment.get("shot_id") or ""
            )
            segment_index = _safe_int(segment.get("segment_index"), 0)
            segment_count = _safe_int(segment.get("segment_count"), 0)
            if not shot_id or segment_index <= 0 or segment_count <= 0:
                coverage = []
                break
            coverage.append(f"{shot_id}:{segment_index}/{segment_count}")
    if coverage:
        keys.append(("coverage", *coverage))

    shot_ids = tuple(
        str(shot_id)
        for shot_id in (raw.get("source_shot_ids") or raw.get("shot_ids") or [])
    )
    if shot_ids:
        keys.append(("shots", *shot_ids))
    return keys


def _pending_runs(
    pending: Sequence[Mapping[str, Any]], positions: Mapping[str, int]
) -> list[list[Mapping[str, Any]]]:
    runs: list[list[Mapping[str, Any]]] = []
    for shot in pending:
        if not runs:
            runs.append([shot])
            continue
        previous = runs[-1][-1]
        adjacent = positions[str(shot["id"])] == positions[str(previous["id"])] + 1
        same_episode = shot.get("episode_number") == previous.get("episode_number")
        if adjacent and same_episode:
            runs[-1].append(shot)
        else:
            runs.append([shot])
    return runs


def _plan_run(
    shots: Sequence[Mapping[str, Any]],
    *,
    provider: str,
    model_id: str,
    operation: VideoOperation | None,
    model_profile: VideoModelProfile | None,
    profile_resolver: ProfileResolver | None,
    target_hint: float | None,
    storyboard_revision: str,
    sequence_start: int,
    confirmed_beats: Sequence[Mapping[str, Any]] | None,
    series_bible: Mapping[str, Any] | None,
    adaptation_planner: GenerateAdaptation | None,
    protected_segments_by_shot: Mapping[str, set[str]],
) -> tuple[list[GenerationUnit], list[GenerationSegment], list[GenerationPlanIssue]]:
    issues: list[GenerationPlanIssue] = []
    operations = [_shot_operation(shot, operation) for shot in shots]
    profiles = [
        _profile_for_operation(
            model_profile,
            provider=provider,
            model_id=model_id,
            operation=shot_operation,
            profile_resolver=profile_resolver,
        )
        for shot_operation in operations
    ]
    segments: list[GenerationSegment] = []
    segment_shots: list[Mapping[str, Any]] = []
    segment_operations: list[VideoOperation] = []
    segment_profiles: list[VideoModelProfile] = []
    next_sequence = sequence_start
    for index, shot in enumerate(shots):
        created, segment_issues = _segments_for_shot(
            shot,
            all_shots=shots,
            profile=profiles[index],
            storyboard_revision=storyboard_revision,
            sequence_start=next_sequence,
            confirmed_beats=confirmed_beats,
            series_bible=series_bible,
            adaptation_planner=adaptation_planner,
        )
        issues.extend(segment_issues)
        segments.extend(created)
        segment_shots.extend([shot] * len(created))
        segment_operations.extend([operations[index]] * len(created))
        segment_profiles.extend([profiles[index]] * len(created))
        next_sequence += len(created)
    protected_segment_ids = set().union(
        *(protected_segments_by_shot.get(str(shot["id"]), set()) for shot in shots)
    )
    generated_segment_ids = {segment.id for segment in segments}
    missing_protected = protected_segment_ids - generated_segment_ids
    if missing_protected:
        raise ValueError(
            "protected generation segments no longer match the current segment plan"
        )
    if protected_segment_ids:
        keep = [
            index
            for index, segment in enumerate(segments)
            if segment.id not in protected_segment_ids
        ]
        segments = [segments[index] for index in keep]
        segment_shots = [segment_shots[index] for index in keep]
        segment_operations = [segment_operations[index] for index in keep]
        segment_profiles = [segment_profiles[index] for index in keep]
    if not segments:
        return [], [], issues
    if (
        segment_profiles
        and all(profile.duration_mode == "fixed" for profile in segment_profiles)
        and len({profile.profile_revision for profile in segment_profiles}) == 1
    ):
        groups = _fixed_partition(
            segments,
            shots=segment_shots,
            operations=segment_operations,
            profiles=segment_profiles,
        )
    else:
        groups = _singleton_partition(segments)
        if not _segment_partition_respects_no_split(segment_shots, segments, groups):
            groups = None
    if groups is None:
        issues.append(
            GenerationPlanIssue(
                code="generation_partition_impossible",
                message=(
                    "当前模型能力无法在不拆开受保护动作或情绪的前提下覆盖全部分镜。"
                ),
            )
        )
        groups = _singleton_partition(segments)

    desired_by_shot = dict(
        zip(
            (str(shot["id"]) for shot in shots),
            _desired_durations(shots, target_hint),
            strict=True,
        )
    )
    units: list[GenerationUnit] = []
    for start, end in groups:
        group_segments = list(segments[start:end])
        group_shots = list(segment_shots[start:end])
        group_operation = segment_operations[start]
        profile = segment_profiles[start]
        recommended = (
            sum(
                (desired_by_shot.get(segment.source_shot_id) or 0)
                / segment.segment_count
                for segment in group_segments
            )
            or None
        )
        duration = _duration_for_profile(profile, recommended)
        units.append(
            _new_unit(
                group_segments,
                group_shots,
                provider=provider,
                model_id=model_id,
                operation=group_operation,
                profile=profile,
                requested_duration_seconds=duration,
            )
        )
    return units, segments, issues


def _fixed_partition(
    segments: Sequence[GenerationSegment],
    *,
    shots: Sequence[Mapping[str, Any]],
    operations: Sequence[VideoOperation],
    profiles: Sequence[VideoModelProfile],
) -> tuple[tuple[int, int], ...] | None:
    candidates: dict[int, tuple[tuple[int, int], ...]] = {0: ()}
    count = len(segments)
    for start in range(count):
        previous = candidates.get(start)
        if previous is None:
            continue
        for end in range(start + 1, count + 1):
            if not _group_allowed(
                segments,
                shots=shots,
                start=start,
                end=end,
                operations=operations,
                profiles=profiles,
            ):
                continue
            if end < count and not _segment_boundary_allows_split(
                shots[end - 1],
                shots[end],
                segments[end - 1],
                segments[end],
            ):
                continue
            candidate = (*previous, (start, end))
            current = candidates.get(end)
            if current is None or _partition_rank(candidate) < _partition_rank(current):
                candidates[end] = candidate
    return candidates.get(count)


def _group_allowed(
    segments: Sequence[GenerationSegment],
    *,
    shots: Sequence[Mapping[str, Any]],
    start: int,
    end: int,
    operations: Sequence[VideoOperation],
    profiles: Sequence[VideoModelProfile],
) -> bool:
    profile = profiles[start]
    if any(operations[index] != operations[start] for index in range(start, end)):
        return False
    if any(profiles[index] != profile for index in range(start, end)):
        return False
    if end - start > 1:
        for index in range(start, end - 1):
            if (
                segments[index].segment_count > 1
                or segments[index + 1].segment_count > 1
            ):
                return False
            if shots[index].get("can_merge_with_next") is not True:
                return False
    fixed = profile.fixed_duration_seconds
    if fixed is None:
        return False
    recommended_content = sum(
        segment.recommended_content_duration_seconds or 0
        for segment in segments[start:end]
    )
    return recommended_content <= fixed + 0.05


def _singleton_partition(
    shots: Sequence[Mapping[str, Any]],
) -> tuple[tuple[int, int], ...]:
    return tuple((index, index + 1) for index in range(len(shots)))


def _segment_partition_respects_no_split(
    shots: Sequence[Mapping[str, Any]],
    segments: Sequence[GenerationSegment],
    groups: Sequence[tuple[int, int]],
) -> bool:
    return all(
        end == len(segments)
        or _segment_boundary_allows_split(
            shots[end - 1], shots[end], segments[end - 1], segments[end]
        )
        for _, end in groups
    )


def _segment_boundary_allows_split(
    left_shot: Mapping[str, Any],
    right_shot: Mapping[str, Any],
    left_segment: GenerationSegment,
    right_segment: GenerationSegment,
) -> bool:
    # A no-split constraint belongs to one beat.  It prevents that beat from
    # being divided into multiple adapted segments; it must not force the next
    # beat into the same provider request.  The latter is especially important
    # for models that only support one beat per call.
    if left_segment.source_shot_id != right_segment.source_shot_id:
        return True
    return not _shot_cannot_split(left_shot) or _auto_split_overlong_shot(left_shot)


def _partition_rank(groups: Sequence[tuple[int, int]]) -> tuple[Any, ...]:
    return (
        len(groups),
        tuple(-end for _, end in groups[:-1]),
    )


def _segments_for_shot(
    shot: Mapping[str, Any],
    *,
    all_shots: Sequence[Mapping[str, Any]],
    profile: VideoModelProfile,
    storyboard_revision: str,
    sequence_start: int,
    confirmed_beats: Sequence[Mapping[str, Any]] | None,
    series_bible: Mapping[str, Any] | None,
    adaptation_planner: GenerateAdaptation | None,
) -> tuple[list[GenerationSegment], list[GenerationPlanIssue]]:
    duration = _recommended_duration(shot)
    fixed = profile.fixed_duration_seconds
    segment_count = (
        math.ceil(duration / fixed)
        if duration is not None and fixed is not None and duration > fixed + 0.05
        else 1
    )
    if segment_count == 1:
        return [
            _deterministic_segment(
                shot,
                profile=profile,
                storyboard_revision=storyboard_revision,
                sequence=sequence_start,
            )
        ], []

    if _shot_cannot_split(shot) and not _auto_split_overlong_shot(shot):
        return [], [
            GenerationPlanIssue(
                code="beat_cannot_split",
                message=(
                    "该故事节拍长于当前模型单次时长且被标记为不可拆分；"
                    "请更换更长时长模型或修改故事节拍。"
                ),
                shot_id=str(shot["id"]),
            )
        ]
    if adaptation_planner is None:
        return [], [
            GenerationPlanIssue(
                code="video_generation_adaptation_required",
                message="超长故事节拍需要完成视频生成适配规划后才能创建任务。",
                shot_id=str(shot["id"]),
            )
        ]

    beat_id = str(shot.get("beat_id") or shot["id"])
    normalized_beats = _confirmed_beat_context(confirmed_beats, all_shots)
    current_index = next(
        (
            index
            for index, beat in enumerate(normalized_beats)
            if str(beat.get("id") or "") == beat_id
        ),
        -1,
    )
    current_beat = (
        normalized_beats[current_index] if current_index >= 0 else _beat_from_shot(shot)
    )
    previous_beat = normalized_beats[current_index - 1] if current_index > 0 else None
    next_beat = (
        normalized_beats[current_index + 1]
        if 0 <= current_index < len(normalized_beats) - 1
        else None
    )
    beat_content_hash = stable_hash(
        {
            "current_beat": current_beat,
            "storyboard_shot": _adaptation_shot_payload(shot),
        }
    )
    immutable_story_facts = _immutable_story_facts(shot, current_beat)
    immutable_story_facts_hash = stable_hash(immutable_story_facts)
    requested_segment_ids = [
        _stable_segment_id(
            storyboard_revision=storyboard_revision,
            shot=shot,
            profile_revision=profile.profile_revision,
            beat_content_hash=beat_content_hash,
            segment_index=index,
            segment_count=segment_count,
        )
        for index in range(1, segment_count + 1)
    ]
    request = VideoGenerationAdaptationRequest(
        storyboard_revision=storyboard_revision,
        beat_content_hash=beat_content_hash,
        model_id=profile.model_id,
        profile_revision=profile.profile_revision,
        call_duration_seconds=fixed,
        segment_count=segment_count,
        requested_segment_ids=requested_segment_ids,
        source_beat_id=beat_id,
        source_shot_id=str(shot["id"]),
        confirmed_beats=normalized_beats,
        current_beat=current_beat,
        previous_beat=previous_beat,
        next_beat=next_beat,
        storyboard_shot=_adaptation_shot_payload(shot),
        series_bible=dict(series_bible or {}),
        immutable_story_facts=immutable_story_facts,
        immutable_story_facts_hash=immutable_story_facts_hash,
    )
    adapted = validate_adaptation_result(request, adaptation_planner(request))
    per_segment_duration = duration / segment_count if duration is not None else None
    result: list[GenerationSegment] = []
    for offset, adapted_segment in enumerate(adapted.segments):
        result.append(
            GenerationSegment(
                id=adapted_segment.id,
                source_shot_id=adapted_segment.source_shot_id,
                source_beat_id=adapted_segment.source_beat_id,
                sequence=sequence_start + offset,
                segment_index=adapted_segment.segment_index,
                segment_count=adapted_segment.segment_count,
                recommended_content_duration_seconds=per_segment_duration,
                prompt=adapted_segment.prompt,
                transition=(
                    _shot_transition(shot)
                    if adapted_segment.segment_index == 1
                    else "continuous"
                ),
                continuity_requirements=adapted_segment.continuity_requirements,
                start_state=adapted_segment.start_state,
                action_progress=adapted_segment.action_progress,
                end_state=adapted_segment.end_state,
            )
        )
    return result, []


def _deterministic_segment(
    shot: Mapping[str, Any],
    *,
    profile: VideoModelProfile,
    storyboard_revision: str,
    sequence: int,
) -> GenerationSegment:
    beat_id = str(shot.get("beat_id") or shot["id"])
    prompt = str(shot.get("prompt") or shot.get("beat") or "").strip()
    if not prompt:
        raise ValueError("generation segment prompt must not be empty")
    beat_content_hash = stable_hash(_adaptation_shot_payload(shot))
    return GenerationSegment(
        id=_stable_segment_id(
            storyboard_revision=storyboard_revision,
            shot=shot,
            profile_revision=profile.profile_revision,
            beat_content_hash=beat_content_hash,
            segment_index=1,
            segment_count=1,
        ),
        source_shot_id=str(shot["id"]),
        source_beat_id=beat_id,
        sequence=sequence,
        segment_index=1,
        segment_count=1,
        recommended_content_duration_seconds=_recommended_duration(shot),
        prompt=prompt,
        transition=_shot_transition(shot),
        continuity_requirements=_continuity_requirements(shot),
        start_state=str(
            _continuity_value(shot, "scene_state")
            or f"Established state before {beat_id}"
        ),
        action_progress=prompt,
        end_state=f"Established state after {beat_id}",
    )


def _normalize_generation_segments(
    value: Any,
    *,
    source_shots: Sequence[Mapping[str, Any]],
    source_segment_ids: Any,
    storyboard_revision: str,
    profile_revision: str,
    sequence_start: int,
    legacy_unit_id: str,
) -> list[GenerationSegment]:
    raw_segments = (
        value
        if isinstance(value, list) and value
        else [
            {
                "shot_id": str(shot["id"]),
                "beat_id": str(shot.get("beat_id") or shot["id"]),
                "prompt": str(shot.get("prompt") or shot.get("beat") or "legacy beat"),
                "recommended_duration_seconds": _recommended_duration(shot),
                "transition": _shot_transition(shot),
            }
            for shot in source_shots
        ]
    )
    frozen_ids = (
        [str(item) for item in source_segment_ids]
        if isinstance(source_segment_ids, list)
        else []
    )
    if frozen_ids and len(frozen_ids) != len(raw_segments):
        raise ValueError("protected unit source segments do not match prompt segments")
    result: list[GenerationSegment] = []
    for offset, raw_value in enumerate(raw_segments):
        if not isinstance(raw_value, Mapping):
            raise ValueError("protected unit prompt segment is invalid")
        raw = dict(raw_value)
        if {
            "id",
            "source_shot_id",
            "source_beat_id",
            "sequence",
            "segment_index",
            "segment_count",
            "recommended_content_duration_seconds",
            "prompt",
            "transition",
            "continuity_requirements",
            "start_state",
            "action_progress",
            "end_state",
        }.issubset(raw):
            result.append(GenerationSegment.model_validate(raw))
            continue
        shot_id = str(raw.get("source_shot_id") or raw.get("shot_id") or "")
        beat_id = str(raw.get("source_beat_id") or raw.get("beat_id") or shot_id)
        prompt = str(raw.get("prompt") or "").strip() or "Legacy generated beat"
        segment_id = (
            frozen_ids[offset]
            if frozen_ids
            else "segment-legacy-"
            + _hash(
                {
                    "unit_id": legacy_unit_id,
                    "shot_id": shot_id,
                    "beat_id": beat_id,
                    "offset": offset,
                    "storyboard_revision": storyboard_revision,
                    "profile_revision": profile_revision,
                }
            )[:24]
        )
        result.append(
            GenerationSegment(
                id=segment_id,
                source_shot_id=shot_id,
                source_beat_id=beat_id,
                sequence=_safe_int(raw.get("sequence"), sequence_start + offset),
                segment_index=_safe_int(raw.get("segment_index"), 1),
                segment_count=_safe_int(raw.get("segment_count"), 1),
                recommended_content_duration_seconds=_positive_number(
                    raw.get("recommended_content_duration_seconds")
                    or raw.get("recommended_duration_seconds")
                ),
                prompt=prompt,
                transition=str(raw.get("transition") or "cut"),
                continuity_requirements=[
                    str(item)
                    for item in raw.get("continuity_requirements", [])
                    if str(item).strip()
                ],
                start_state=str(raw.get("start_state") or "Legacy start state"),
                action_progress=str(raw.get("action_progress") or prompt),
                end_state=str(raw.get("end_state") or "Legacy end state"),
            )
        )
    return result


def _stable_segment_id(
    *,
    storyboard_revision: str,
    shot: Mapping[str, Any],
    profile_revision: str,
    beat_content_hash: str,
    segment_index: int,
    segment_count: int,
) -> str:
    return (
        "segment-"
        + _hash(
            {
                "storyboard_revision": storyboard_revision,
                "source_shot_id": str(shot["id"]),
                "source_beat_id": str(shot.get("beat_id") or shot["id"]),
                "shot_version": _safe_int(shot.get("version"), 1),
                "profile_revision": profile_revision,
                "beat_content_hash": beat_content_hash,
                "segment_index": segment_index,
                "segment_count": segment_count,
            }
        )[:24]
    )


def _confirmed_beat_context(
    confirmed_beats: Sequence[Mapping[str, Any]] | None,
    shots: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    if confirmed_beats:
        return [dict(beat) for beat in confirmed_beats]
    return [_beat_from_shot(shot) for shot in shots]


def _beat_from_shot(shot: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": str(shot.get("beat_id") or shot["id"]),
        "summary": str(shot.get("beat") or shot.get("prompt") or ""),
        "recommended_duration_seconds": _recommended_duration(shot),
        "duration_range_seconds": shot.get("duration_range_seconds"),
        "can_merge_with_next": shot.get("can_merge_with_next") is True,
        "must_complete_action": shot.get("must_complete_action") is True,
        "must_preserve_emotion": shot.get("must_preserve_emotion") is True,
        "cannot_split_reason": shot.get("cannot_split_reason"),
    }


def _adaptation_shot_payload(shot: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: shot.get(key)
        for key in (
            "id",
            "version",
            "beat_id",
            "beat",
            "prompt",
            "scene_id",
            "characters",
            "location",
            "props",
            "asset_ids",
            "shot_intent",
            "shot_language",
            "continuity",
            "recommended_duration_seconds",
            "duration_range_seconds",
            "must_complete_action",
            "must_preserve_emotion",
            "cannot_split_reason",
        )
    }


def _immutable_story_facts(
    shot: Mapping[str, Any], current_beat: Mapping[str, Any]
) -> list[str]:
    values = [
        str(current_beat.get("summary") or "").strip(),
        str(shot.get("beat") or "").strip(),
        str(shot.get("prompt") or "").strip(),
        "characters=" + ",".join(str(item) for item in shot.get("characters", [])),
        "scene=" + str(shot.get("scene_id") or shot.get("location") or ""),
        "props=" + ",".join(str(item) for item in shot.get("props", [])),
    ]
    return list(dict.fromkeys(value for value in values if value and value != "="))


def _shot_cannot_split(shot: Mapping[str, Any]) -> bool:
    return bool(
        shot.get("cannot_split") is True
        or shot.get("must_complete_action") is True
        or shot.get("must_preserve_emotion") is True
    )


def _auto_split_overlong_shot(shot: Mapping[str, Any]) -> bool:
    duration = _recommended_duration(shot)
    return duration is not None and duration > _AUTO_SPLIT_THRESHOLD_SECONDS


def _continuity_value(shot: Mapping[str, Any], key: str) -> Any:
    continuity = shot.get("continuity")
    return continuity.get(key) if isinstance(continuity, Mapping) else None


def _shot_transition(
    shot: Mapping[str, Any],
) -> Literal["continuous", "cut", "match_cut"]:
    mode = _continuity_value(shot, "mode")
    return (
        "continuous"
        if mode == "carry"
        else "match_cut"
        if mode == "match_cut"
        else "cut"
    )


def _continuity_requirements(shot: Mapping[str, Any]) -> list[str]:
    requirements = [
        str(value).strip()
        for value in (
            _continuity_value(shot, "composition"),
            _continuity_value(shot, "subject_pose"),
            _continuity_value(shot, "gaze"),
            _continuity_value(shot, "motion_direction"),
            _continuity_value(shot, "lighting"),
            _continuity_value(shot, "scene_state"),
            shot.get("cannot_split_reason"),
        )
        if str(value or "").strip()
    ]
    return requirements


def _new_unit(
    segments: Sequence[GenerationSegment],
    shots: Sequence[Mapping[str, Any]],
    *,
    provider: str,
    model_id: str,
    operation: VideoOperation,
    profile: VideoModelProfile,
    requested_duration_seconds: float | None,
) -> GenerationUnit:
    source_shot_ids = list(
        dict.fromkeys(segment.source_shot_id for segment in segments)
    )
    source_beat_ids = list(
        dict.fromkeys(segment.source_beat_id for segment in segments)
    )
    source_segment_ids = [segment.id for segment in segments]
    shots_by_id = {str(shot["id"]): shot for shot in shots}
    canonical = {
        "provider": provider,
        "model_id": model_id,
        "operation": operation,
        "profile_revision": profile.profile_revision,
        "source_shot_ids": source_shot_ids,
        "source_shot_versions": [
            _safe_int(shots_by_id[shot_id].get("version"), 1)
            for shot_id in source_shot_ids
        ],
        "source_segment_ids": source_segment_ids,
        "requested_duration_seconds": requested_duration_seconds,
    }
    unit_id = "unit-" + _hash(canonical)[:24]
    return GenerationUnit(
        id=unit_id,
        revision=1,
        status="planned",
        shot_ids=source_shot_ids,
        source_shot_ids=source_shot_ids,
        source_beat_ids=source_beat_ids,
        source_segment_ids=source_segment_ids,
        prompt_segments=list(segments),
        provider=provider,
        model_id=model_id,
        operation=operation,
        requested_duration_seconds=requested_duration_seconds,
        timeline_duration_seconds=requested_duration_seconds,
        profile=profile,
    )


def _source_beat_ids(
    shots: Sequence[Mapping[str, Any]], value: Any = None
) -> list[str]:
    if isinstance(value, list) and value:
        return list(dict.fromkeys(str(beat_id) for beat_id in value))
    return list(dict.fromkeys(str(shot.get("beat_id") or shot["id"]) for shot in shots))


def _profile_for_operation(
    override: VideoModelProfile | None,
    *,
    provider: str,
    model_id: str,
    operation: VideoOperation,
    profile_resolver: ProfileResolver | None,
) -> VideoModelProfile:
    if override is not None and override.operation == operation:
        return override
    return _resolve_profile(
        profile_resolver,
        model_id=model_id,
        operation=operation,
        provider=provider,
    )


def _resolve_profile(
    resolver: ProfileResolver | None,
    *,
    model_id: str,
    operation: VideoOperation,
    provider: str,
) -> VideoModelProfile:
    if resolver is not None:
        return resolver(model_id, operation, provider)
    return video_model_profile(model_id, operation, provider=provider)


def _shot_operation(
    shot: Mapping[str, Any], override: VideoOperation | None
) -> VideoOperation:
    return override or operation_for_shot(shot)


def _operation_value(value: Any) -> VideoOperation:
    if value in {
        "text_to_video",
        "image_to_video",
        "first_last_frame_to_video",
        "extend",
    }:
        return value
    return "text_to_video"


def _profile_issues(unit: GenerationUnit) -> list[GenerationPlanIssue]:
    profile = unit.profile
    result: list[GenerationPlanIssue] = []
    if profile.duration_mode == "unknown":
        result.append(
            GenerationPlanIssue(
                code="video_model_contract_unknown",
                message=(
                    "管理员尚未为当前视频模型配置单次生成时长，无法创建付费生成任务。"
                ),
                shot_id=unit.source_shot_ids[0],
                unit_id=unit.id,
            )
        )
    if (
        unit.operation in {"image_to_video", "first_last_frame_to_video"}
        and not profile.supports_start_frame
    ):
        result.append(
            GenerationPlanIssue(
                code="video_model_start_frame_reference_guided",
                message=(
                    "当前通道没有已验证的原生首帧控制；生成时只能将首帧作为"
                    "独立参考图，无法保证严格首帧对齐。"
                ),
                shot_id=unit.source_shot_ids[0],
                unit_id=unit.id,
            )
        )
    if unit.operation == "first_last_frame_to_video" and not profile.supports_end_frame:
        result.append(
            GenerationPlanIssue(
                code="video_model_end_frame_reference_guided",
                message=(
                    "当前通道没有已验证的原生尾帧控制；生成时只能将尾帧作为"
                    "独立参考图，无法保证严格尾帧对齐。"
                ),
                shot_id=unit.source_shot_ids[0],
                unit_id=unit.id,
            )
        )
    return result


def _adaptation_options(
    *, issues: Sequence[GenerationPlanIssue], mismatch: bool
) -> list[str]:
    codes = {issue.code for issue in issues}
    options: list[str] = []
    unresolved_blocker = bool(codes.intersection(_BLOCKING_ISSUES))
    if mismatch and not unresolved_blocker:
        options.extend(
            [
                "accept_longer_duration",
                "revise_or_merge_storyboard",
                "choose_compatible_model",
                # Compatibility alias for the current Phase 4 API and UI.
                "accept_model_duration",
                "revise_storyboard",
            ]
        )
    else:
        options.append("choose_compatible_model")
    if unresolved_blocker:
        options.extend(["revise_or_merge_storyboard", "revise_storyboard"])
    if any(code.endswith("_reference_guided") for code in codes):
        options.append("use_reference_frame_guidance")
    if "beat_cannot_split" in codes:
        options.extend(["choose_longer_duration_model", "revise_narrative_beat"])
    if "video_generation_adaptation_required" in codes:
        options.append("run_video_generation_adaptation")
    return list(dict.fromkeys(options))


def _validate_exact_coverage(
    requested_segment_ids: Sequence[str], units: Sequence[GenerationUnit]
) -> None:
    coverage = Counter(
        segment_id for unit in units for segment_id in unit.source_segment_ids
    )
    expected = Counter(requested_segment_ids)
    if coverage != expected:
        raise ValueError(
            "generation units must cover every generation segment exactly once"
        )


def _plan_hash_payload(
    *,
    storyboard_revision: str,
    provider: str,
    model_id: str,
    operation: VideoOperation | None,
    target: float | None,
    shots: Sequence[Mapping[str, Any]],
    units: Sequence[GenerationUnit],
    protected_ids: Sequence[str],
    requested_regeneration_ids: Sequence[str],
    confirmed_strategy: ConfirmedStrategy | None,
) -> dict[str, Any]:
    return {
        "storyboard_revision": storyboard_revision,
        "provider": provider,
        "model_id": model_id,
        "operation": operation,
        "target_duration_seconds": target,
        "shots": [
            {
                "id": str(shot["id"]),
                "beat_id": str(shot.get("beat_id") or shot["id"]),
                "version": _safe_int(shot.get("version"), 1),
            }
            for shot in shots
        ],
        "protected_generation_unit_ids": list(protected_ids),
        "requested_regeneration_unit_ids": list(requested_regeneration_ids),
        "confirmed_strategy": (
            confirmed_strategy
            if confirmed_strategy == "accept_longer_duration"
            else None
        ),
        "units": [
            {
                "id": unit.id,
                "revision": unit.revision,
                "status": unit.status,
                "provider": unit.provider,
                "model_id": unit.model_id,
                "operation": unit.operation,
                "profile_revision": unit.profile.profile_revision,
                "source_shot_ids": unit.source_shot_ids,
                "source_beat_ids": unit.source_beat_ids,
                "source_segment_ids": unit.source_segment_ids,
                "requested_duration_seconds": unit.requested_duration_seconds,
                "replaces_unit_id": unit.replaces_unit_id,
            }
            for unit in units
        ],
    }


def _desired_durations(
    shots: Sequence[Mapping[str, Any]], target_hint: float | None
) -> list[float | None]:
    values = [_recommended_duration(shot) for shot in shots]
    unspecified = [index for index, value in enumerate(values) if value is None]
    target = _positive_number(target_hint)
    if target is None or not unspecified:
        return values
    remaining = target - sum(value or 0 for value in values)
    if remaining <= 0:
        return values
    weights = [_content_weight(shots[index]) for index in unspecified]
    weight_total = sum(weights)
    for index, weight in zip(unspecified, weights, strict=True):
        values[index] = remaining * weight / weight_total
    return values


def _duration_for_profile(
    profile: VideoModelProfile, desired: float | None
) -> float | None:
    if profile.duration_mode == "fixed":
        return profile.fixed_duration_seconds
    if profile.duration_mode == "supported_values":
        values = sorted(
            value for value in profile.supported_duration_seconds if value > 0
        )
        if not values:
            return None
        if desired is None:
            return values[0]
        return min(values, key=lambda value: (abs(value - desired), value))
    if profile.duration_mode == "flexible":
        value = desired or profile.min_duration_seconds
        if value is None:
            return None
        minimum = profile.min_duration_seconds or value
        maximum = profile.max_duration_seconds or value
        return round(min(max(value, minimum), maximum), 3)
    return None


def _recommended_duration(shot: Mapping[str, Any]) -> float | None:
    return _positive_number(shot.get("recommended_duration_seconds"))


def _duration_minimum(shot: Mapping[str, Any]) -> float:
    duration_range = shot.get("duration_range_seconds")
    if isinstance(duration_range, (list, tuple)) and duration_range:
        minimum = _positive_number(duration_range[0])
        if minimum is not None:
            return minimum
    return _recommended_duration(shot) or 0


def _content_weight(shot: Mapping[str, Any]) -> float:
    text = " ".join(
        str(shot.get(key) or "") for key in ("beat", "prompt", "shot_intent")
    )
    word_count = len(text.split())
    action_bonus = 4 if shot.get("must_complete_action") else 0
    return float(max(1, word_count + action_bonus))


def _storyboard_revision(storyboard: Mapping[str, Any]) -> str:
    canonical = json.dumps(
        storyboard,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _hash(value: Mapping[str, Any]) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _positive_number(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _optional_string(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None
