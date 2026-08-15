from __future__ import annotations

import base64
import json
import mimetypes
import os
import shutil
import subprocess
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from lib.shot_prompt_builder import build_shot_prompt
from server.app.continuity_frames import (
    build_continuity_prompt,
    resolve_continuity,
    resolve_video_frame_operation,
)
from server.app.keyring import key_environment
from server.app.media_files import (
    atomic_write_text,
    create_atomic_output,
    replace_atomic_output,
)
from server.app.billing.execution import (
    PaymentRequiredQuote,
    ProviderGenerationFailed,
    ProviderPricingUnstable,
    ProviderResultPending,
    execute_billed_provider_call,
    retry_payment_required_quote,
)
from server.app.billing.models import GenerationJob
from server.app.billing.reconciliation import resume_reconcile_publish_job
from server.app.billing.service import (
    BillingService,
    ExistingProviderOperation,
    ProviderPricingUnavailable,
)
from server.app.generation_units.models import VideoGenerationUnit
from server.app.generation_units.publication import (
    generation_unit_billing_operation,
)
from server.app.provider.newapi import (
    NewApiCallError,
    NewApiRateLimited,
    InvalidNewApiResponse,
    PreparedNewApiRequest,
)
from server.app.rendering import (
    compile_legacy_edit_timeline,
    compile_render_plan_from_timeline,
    execute_render_plan,
    generation_unit_timeline_assets,
)
from server.app.rendering.probe import probe_media
from server.app.video_model_profiles import operation_for_shot, video_model_profile
from tools.video._shared import probe_output

RenderRuntime = Literal["remotion", "hyperframes", "ffmpeg"]
DEFAULT_VIDEO_MODEL = "omni_flash-10s"
REFERENCE_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
DEFAULT_SHOT_ASPECT_RATIO = "9:16"
VIDEO_GENERATION_SIZES = {
    "16:9": "1280x720",
    "9:16": "720x1280",
    "1:1": "1080x1080",
    "4:3": "960x720",
    "3:4": "720x960",
}
VIDEO_OUTPUT_SIZES = {
    "16:9": (1920, 1080),
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
    "4:3": (1440, 1080),
    "3:4": (1080, 1440),
}
NEWAPI_VIDEO_PROVIDER_CONTRACTS = [
    {"supports": {"reference_to_video": True}},
]
VIDEO_FRAME_CONTRACT_UNSUPPORTED_CODE = "video_frame_contract_unsupported"
VIDEO_FRAME_CONTRACT_UNSUPPORTED_MESSAGE = (
    "当前视频模型通道不支持原生首帧/尾帧约束，无法保证分镜连续性，请更换支持该能力的视频模型。"
)


class VideoFrameContractUnsupported(RuntimeError):
    def __init__(self, required_operation: str, actual_operation: str) -> None:
        super().__init__(VIDEO_FRAME_CONTRACT_UNSUPPORTED_MESSAGE)
        self.code = VIDEO_FRAME_CONTRACT_UNSUPPORTED_CODE
        self.message = VIDEO_FRAME_CONTRACT_UNSUPPORTED_MESSAGE
        self.required_operation = required_operation
        self.actual_operation = actual_operation


def normalize_aspect_ratio(value: Any, *, default: str = DEFAULT_SHOT_ASPECT_RATIO) -> str:
    normalized = str(value or default).strip().replace("/", ":")
    return normalized if normalized in VIDEO_GENERATION_SIZES else default


def video_generation_size(aspect_ratio: Any) -> str:
    return VIDEO_GENERATION_SIZES[normalize_aspect_ratio(aspect_ratio)]


def video_output_size(aspect_ratio: Any) -> tuple[int, int]:
    return VIDEO_OUTPUT_SIZES[normalize_aspect_ratio(aspect_ratio)]


def media_matches_aspect_ratio(path: str | Path, aspect_ratio: Any) -> bool:
    try:
        media = probe_media(path)
    except Exception:
        # Leave opaque test doubles and not-yet-probed media reusable; the
        # authoritative render probe will reject unreadable files later.
        return True
    width = int(media.get("video_width") or 0)
    height = int(media.get("video_height") or 0)
    if width <= 0 or height <= 0:
        return False
    target_width, target_height = (
        int(part)
        for part in normalize_aspect_ratio(aspect_ratio).split(":")
    )
    return abs(width / height - target_width / target_height) <= 0.01


def _shot_aspect_ratio(
    shot: dict[str, Any],
    project_aspect_ratio: str | None = None,
) -> str:
    return normalize_aspect_ratio(
        shot.get("aspect_ratio") or project_aspect_ratio,
    )


def _shot_duration_seconds(shot: dict[str, Any], default: float = 5) -> float:
    for key in (
        "timeline_duration_seconds",
        "source_duration_seconds",
        "requested_duration_seconds",
        "duration_seconds",
    ):
        try:
            duration = float(shot.get(key))
        except (TypeError, ValueError):
            continue
        if duration > 0:
            return duration
    return default


def _generation_duration_seconds(
    shot: dict[str, Any],
    video_model: str,
    *,
    db=None,
) -> float:
    try:
        requested = float(shot.get("requested_duration_seconds"))
    except (TypeError, ValueError):
        requested = 0
    if requested > 0:
        return requested

    profile = video_model_profile(
        video_model,
        operation_for_shot(shot),
        db=db,
    )
    if profile.duration_mode == "fixed" and profile.fixed_duration_seconds:
        return profile.fixed_duration_seconds

    try:
        desired = float(shot.get("duration_seconds"))
    except (TypeError, ValueError):
        desired = None
    if desired is not None and desired <= 0:
        desired = None
    if profile.duration_mode == "supported_values" and profile.supported_duration_seconds:
        values = sorted(profile.supported_duration_seconds)
        if desired is None:
            return values[0]
        return min(values, key=lambda value: (abs(value - desired), value))
    if profile.duration_mode == "flexible":
        if desired is None:
            desired = profile.min_duration_seconds
        if desired is not None:
            minimum = profile.min_duration_seconds or desired
            maximum = profile.max_duration_seconds or desired
            return min(max(desired, minimum), maximum)
    raise VideoFrameContractUnsupported("verified_duration_contract", "unknown")


def _planned_timeline_duration_seconds(
    shot: dict[str, Any], requested_duration_seconds: float
) -> float:
    for key in ("timeline_duration_seconds", "source_duration_seconds"):
        try:
            duration = float(shot.get(key))
        except (TypeError, ValueError):
            continue
        if duration > 0:
            return duration
    return requested_duration_seconds


def _newapi_provider_contracts(video_model: str) -> list[dict[str, Any]]:
    image = video_model_profile(video_model, "image_to_video")
    first_last = video_model_profile(video_model, "first_last_frame_to_video")
    return [
        {
            "supports": {
                "reference_to_video": True,
                "image_to_video": image.supports_start_frame,
                "first_last_frame_to_video": (
                    first_last.supports_start_frame and first_last.supports_end_frame
                ),
            },
            "max_reference_images": first_last.max_reference_images,
        }
    ]


def _provider_reference_image_limit(providers: list[Any]) -> int | None:
    limits: list[int] = []
    for provider in providers:
        value = (
            provider.get("max_reference_images")
            if isinstance(provider, dict)
            else getattr(provider, "max_reference_images", None)
        )
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            limits.append(value)
    return min(limits) if limits else None


def _selector_image_paths(selector_inputs: dict[str, Any]) -> list[str]:
    paths: list[str] = []
    for key in ("first_frame_path", "last_frame_path", "reference_image_path"):
        value = selector_inputs.get(key)
        if isinstance(value, str) and value and value not in paths:
            paths.append(value)
    for value in selector_inputs.get("reference_image_paths", []):
        if isinstance(value, str) and value and value not in paths:
            paths.append(value)
    return paths


def _with_target_shot_durations(
    shots: list[dict[str, Any]], target_duration_seconds: int | None
) -> list[dict[str, Any]]:
    """Keep narrative shots free of duration values until a model plan exists."""
    del target_duration_seconds
    return [dict(shot) for shot in shots]


def _scope_edit_decisions_to_storyboard(
    edit_decisions: dict[str, Any],
    storyboard: dict[str, Any],
) -> dict[str, Any]:
    """Rebase frozen cuts when an episode or an explicit shot subset is rendered."""
    shots = sorted(
        [shot for shot in storyboard.get("shots", []) if isinstance(shot, dict)],
        key=lambda shot: int(shot.get("index", 0)),
    )
    cuts = [
        cut for cut in edit_decisions.get("cuts", []) if isinstance(cut, dict)
    ]
    if not shots or not cuts:
        return dict(edit_decisions)
    cuts_by_id = {str(cut.get("id")): cut for cut in cuts if cut.get("id")}
    cuts_by_source = {
        str(cut.get("source")): cut for cut in cuts if cut.get("source")
    }
    scoped_cuts: list[dict[str, Any]] = []
    cursor = 0.0
    for shot in shots:
        shot_id = str(shot.get("id") or "")
        cut = cuts_by_id.get(f"cut-{shot_id}") or cuts_by_source.get(
            f"{shot_id}-video"
        )
        if cut is None:
            continue
        scoped = dict(cut)
        duration_policy = str(scoped.get("duration_policy") or "full_source")
        source_in = scoped.get("source_in_seconds", scoped.get("in_seconds", 0))
        try:
            if duration_policy == "full_source" and shot.get(
                "source_duration_seconds"
            ) is not None:
                duration = float(shot["source_duration_seconds"])
                source_in = 0
            elif scoped.get("timeline_duration_seconds") is not None:
                duration = float(scoped["timeline_duration_seconds"])
            else:
                source_out = scoped.get("source_out_seconds", scoped.get("out_seconds"))
                duration = float(source_out) - float(source_in)
        except (TypeError, ValueError):
            duration = float(_shot_duration_seconds(shot))
        if duration <= 0:
            duration = float(_shot_duration_seconds(shot))
        scoped["timeline_start_seconds"] = cursor
        scoped["timeline_duration_seconds"] = duration
        scoped["source_in_seconds"] = float(source_in or 0)
        if duration_policy == "full_source":
            scoped["source_out_seconds"] = scoped["source_in_seconds"] + duration
            scoped["duration_policy"] = "full_source"
            scoped["speed"] = 1
        elif scoped.get("source_out_seconds") is None:
            scoped["source_out_seconds"] = scoped["source_in_seconds"] + duration
        scoped_cuts.append(scoped)
        cursor += duration
    if not scoped_cuts:
        return dict(edit_decisions)
    scoped_decisions = dict(edit_decisions)
    scoped_decisions["cuts"] = scoped_cuts
    scoped_decisions["total_duration_seconds"] = cursor
    return scoped_decisions


def compile_shot_prompt(
    shot: dict[str, Any],
    character_lookup: dict[str, dict[str, Any]],
    style_lock: str | None,
    asset_lookup: dict[str, dict[str, Any]] | None = None,
) -> str:
    prompt_parts = [str(shot.get("prompt", "")).strip()]
    shot_language = shot.get("shot_language") or {}
    shot_language_scene = {
        "description": str(shot.get("prompt", "")).strip(),
        "shot_language": shot_language,
        "texture_keywords": shot.get("texture_keywords", []),
    }
    shot_language_prompt = build_shot_prompt(
        shot_language_scene,
        {"visual_language": {"aesthetic": style_lock or ""}},
    )
    if (
        _has_meaningful_shot_language(shot_language)
        and shot_language_prompt
        and shot_language_prompt != prompt_parts[0]
    ):
        prompt_parts.append(f"Shot language: {shot_language_prompt}")
    if shot.get("shot_intent"):
        prompt_parts.append(f"Shot intent: {shot['shot_intent']}")
    locks: list[str] = []
    for character_id in shot.get("characters", []):
        character = character_lookup.get(str(character_id))
        visual_lock = character.get("visual_lock") if character else None
        if visual_lock and str(visual_lock) not in prompt_parts[0]:
            locks.append(f"{character.get('name', character_id)}: {visual_lock}")
    if locks:
        prompt_parts.append("Character locks: " + "; ".join(locks))
    if style_lock:
        prompt_parts.append(f"Style lock: {style_lock}")
    if shot.get("location"):
        prompt_parts.append(f"Location: {shot['location']}")
    if shot.get("props"):
        prompt_parts.append("Props: " + ", ".join(str(prop) for prop in shot["props"]))
    continuity_prompt = build_continuity_prompt(shot.get("continuity"))
    if continuity_prompt:
        prompt_parts.append(continuity_prompt)
    asset_ids = resolve_shot_asset_ids(shot, asset_lookup or {})
    if asset_lookup and asset_ids:
        reference_lines = []
        for asset_id in asset_ids:
            asset = asset_lookup.get(str(asset_id))
            if not asset:
                continue
            reference_images = asset.get("reference_images", [])
            if reference_images:
                reference_lines.append(
                    f"{asset.get('label', asset_id)} ({asset.get('kind', 'asset')}) -> "
                    + ", ".join(str(reference) for reference in reference_images)
                )
        if reference_lines:
            prompt_parts.append("Reference assets: " + "; ".join(reference_lines))
    return ". ".join(part for part in prompt_parts if part)


def _has_meaningful_shot_language(shot_language: Any) -> bool:
    if not isinstance(shot_language, dict):
        return False

    for value in shot_language.values():
        if isinstance(value, str) and value.strip():
            return True
        if isinstance(value, (list, tuple, set)) and any(
            isinstance(item, str) and item.strip() or item not in (None, "", [], {}, ())
            for item in value
        ):
            return True
        if value not in (None, "", [], {}, ()):
            return True

    return False


def _resolve_project_reference_image(project_path: Path, reference: Any) -> Path | None:
    if not isinstance(reference, str) or not reference.strip():
        return None

    raw_path = Path(reference.strip())
    candidate = raw_path if raw_path.is_absolute() else project_path / raw_path
    try:
        resolved_project = project_path.resolve()
        resolved_candidate = candidate.resolve()
        resolved_candidate.relative_to(resolved_project)
    except (OSError, ValueError):
        return None

    if resolved_candidate.suffix.lower() not in REFERENCE_IMAGE_EXTENSIONS:
        return None
    if not resolved_candidate.is_file():
        return None
    return resolved_candidate


def resolve_shot_asset_ids(
    shot: dict[str, Any],
    asset_lookup: dict[str, dict[str, Any]],
) -> list[str]:
    """Resolve both sides of the shot-to-asset relationship without loading series-wide assets."""
    resolved: list[str] = []
    seen: set[str] = set()

    for value in shot.get("asset_ids") or []:
        asset_id = str(value).strip()
        if asset_id and asset_id in asset_lookup and asset_id not in seen:
            resolved.append(asset_id)
            seen.add(asset_id)

    shot_id = str(shot.get("id") or "").strip()
    if not shot_id:
        return resolved
    for asset_id, asset in asset_lookup.items():
        if asset_id in seen or not isinstance(asset, dict):
            continue
        linked_shot_ids = {
            str(value).strip()
            for value in (asset.get("shot_ids") or [])
            if str(value).strip()
        }
        if shot_id in linked_shot_ids:
            resolved.append(asset_id)
            seen.add(asset_id)
    return resolved


def resolve_shot_reference_image_paths(
    project_dir: str | Path,
    shot: dict[str, Any],
    asset_lookup: dict[str, dict[str, Any]],
    max_images: int | None = None,
) -> list[str]:
    project_path = Path(project_dir)
    references: list[str] = []
    seen: set[str] = set()
    references_by_asset: list[list[str]] = []

    for asset_id in resolve_shot_asset_ids(shot, asset_lookup):
        asset = asset_lookup.get(asset_id)
        if not asset:
            continue
        asset_references: list[str] = []
        for reference in asset.get("reference_images") or []:
            resolved = _resolve_project_reference_image(project_path, reference)
            if resolved is None:
                continue
            resolved_text = str(resolved)
            if resolved_text in seen or resolved_text in asset_references:
                continue
            asset_references.append(resolved_text)
        if asset_references:
            references_by_asset.append(asset_references)

    view_index = 0
    while max_images is None or len(references) < max_images:
        added = False
        for asset_references in references_by_asset:
            if view_index >= len(asset_references):
                continue
            resolved_text = asset_references[view_index]
            if resolved_text not in seen:
                references.append(resolved_text)
                seen.add(resolved_text)
                added = True
                if max_images is not None and len(references) >= max_images:
                    return references
        if not added:
            break
        view_index += 1

    return references


def resolve_shot_keyframe_paths(
    project_dir: str | Path,
    shot: dict[str, Any],
    asset_lookup: dict[str, dict[str, Any]],
) -> tuple[str | None, str | None, str | None, str | None]:
    project_path = Path(project_dir)
    continuity = resolve_continuity(shot)

    def resolve_frame(name: str) -> str | None:
        frame = continuity.get(name)
        if not isinstance(frame, dict) or frame.get("status") != "ready":
            return None
        asset = asset_lookup.get(str(frame.get("asset_id") or ""))
        if not asset:
            return None
        for reference in asset.get("reference_images") or []:
            resolved = _resolve_project_reference_image(project_path, reference)
            if resolved is not None:
                return str(resolved)
        return None

    first_frame = continuity.get("first_frame")
    last_frame = continuity.get("last_frame")
    return (
        resolve_frame("first_frame"),
        resolve_frame("last_frame"),
        str(first_frame.get("asset_id")) if isinstance(first_frame, dict) else None,
        str(last_frame.get("asset_id")) if isinstance(last_frame, dict) else None,
    )


def build_video_selector_inputs(
    *,
    project_dir: str | Path,
    shot: dict[str, Any],
    prompt: str,
    video_model: str,
    output_path: str | Path,
    asset_lookup: dict[str, dict[str, Any]],
    providers: list[Any] | None = None,
    project_aspect_ratio: str | None = None,
    db=None,
) -> dict[str, Any]:
    ordinary_references = resolve_shot_reference_image_paths(
        project_dir,
        shot,
        asset_lookup,
    )
    (
        first_frame_path,
        last_frame_path,
        first_frame_asset_id,
        last_frame_asset_id,
    ) = resolve_shot_keyframe_paths(
        project_dir, shot, asset_lookup
    )
    provider_contracts = (
        providers
        if providers is not None
        else [{"supports": {"reference_to_video": True}}]
    )
    reference_image_limit = _provider_reference_image_limit(provider_contracts)
    operation = resolve_video_frame_operation(
        first_frame_path,
        last_frame_path,
        provider_contracts,
    )
    if operation == "text_to_video" and ordinary_references:
        operation = "reference_to_video"
    aspect_ratio = _shot_aspect_ratio(shot, project_aspect_ratio)
    inputs: dict[str, Any] = {
        "prompt": prompt,
        "preferred_provider": "syapi",
        "operation": operation,
        "model_variant": video_model,
        "aspect_ratio": aspect_ratio,
        "size": video_generation_size(aspect_ratio),
        "duration": f"{_generation_duration_seconds(shot, video_model, db=db):g}",
        "output_path": str(output_path),
    }
    if operation == "first_last_frame_to_video":
        inputs["first_frame_path"] = first_frame_path
        inputs["last_frame_path"] = last_frame_path
        inputs["referenced_asset_ids"] = [
            asset_id
            for asset_id in (first_frame_asset_id, last_frame_asset_id)
            if asset_id
        ]
    elif operation == "image_to_video":
        inputs["reference_image_path"] = first_frame_path
        inputs["referenced_asset_ids"] = (
            [first_frame_asset_id] if first_frame_asset_id else []
        )
    elif operation == "reference_to_video":
        reference_image_paths: list[str] = []
        referenced_asset_ids: list[str] = []
        frame_roles: list[str] = []
        asset_reference_roles: list[dict[str, Any]] = []
        frame_references = [
            (first_frame_path, first_frame_asset_id),
            (last_frame_path, last_frame_asset_id),
        ]
        for role, (path, asset_id) in zip(
            ("start_frame", "end_frame"), frame_references, strict=True
        ):
            if not path:
                continue
            if (
                path not in reference_image_paths
                and reference_image_limit is not None
                and len(reference_image_paths) >= reference_image_limit
            ):
                continue
            if path in reference_image_paths:
                existing_index = reference_image_paths.index(path)
                frame_roles[existing_index] = "start_and_end_frame"
            else:
                reference_image_paths.append(path)
                frame_roles.append(role)
            if asset_id and asset_id not in referenced_asset_ids:
                referenced_asset_ids.append(asset_id)
        ordinary_assets_by_path: dict[str, tuple[str, dict[str, Any]]] = {}
        for asset_id in resolve_shot_asset_ids(shot, asset_lookup):
            asset = asset_lookup.get(asset_id)
            if not asset:
                continue
            for reference in asset.get("reference_images") or []:
                resolved = _resolve_project_reference_image(
                    Path(project_dir), reference
                )
                if resolved is not None:
                    ordinary_assets_by_path.setdefault(
                        str(resolved), (asset_id, asset)
                    )
        for path in ordinary_references:
            if (
                path in reference_image_paths
                or (
                    reference_image_limit is not None
                    and len(reference_image_paths) >= reference_image_limit
                )
            ):
                continue
            reference_image_paths.append(path)
            asset_entry = ordinary_assets_by_path.get(path)
            if asset_entry is None:
                continue
            asset_id, asset = asset_entry
            if asset_id not in referenced_asset_ids:
                referenced_asset_ids.append(asset_id)
            asset_reference_roles.append(
                {
                    "image_index": len(reference_image_paths),
                    "asset_id": asset_id,
                    "kind": str(asset.get("kind") or "asset"),
                    "label": str(asset.get("label") or asset_id),
                }
            )
        if reference_image_paths:
            inputs["reference_image_paths"] = reference_image_paths
            inputs["referenced_asset_ids"] = referenced_asset_ids
        if frame_roles:
            inputs["frame_reference_roles"] = frame_roles
        if asset_reference_roles:
            inputs["asset_reference_roles"] = asset_reference_roles
        if first_frame_path and last_frame_path:
            inputs["degraded_from_operation"] = "first_last_frame_to_video"
        elif first_frame_path:
            inputs["degraded_from_operation"] = "image_to_video"
        elif last_frame_path:
            inputs["degraded_from_operation"] = "last_frame_to_video"
    return inputs


def require_native_video_frame_contract(
    shot: dict[str, Any], selector_inputs: dict[str, Any]
) -> None:
    continuity = resolve_continuity(shot)
    first_frame = continuity.get("first_frame")
    last_frame = continuity.get("last_frame")
    first_required = bool(
        isinstance(first_frame, dict) and first_frame.get("status") == "ready"
    )
    last_required = bool(
        isinstance(last_frame, dict) and last_frame.get("status") == "ready"
    )
    if not first_required and not last_required:
        return
    required_operation = (
        "first_last_frame_to_video"
        if first_required and last_required
        else "image_to_video"
        if first_required
        else "last_frame_to_video"
    )
    actual_operation = str(selector_inputs.get("operation") or "text_to_video")
    if actual_operation == required_operation:
        return
    roles = selector_inputs.get("frame_reference_roles")
    expected_roles = {
        "first_last_frame_to_video": (["start_frame", "end_frame"], ["start_and_end_frame"]),
        "image_to_video": (["start_frame"],),
        "last_frame_to_video": (["end_frame"],),
    }
    if (
        actual_operation == "reference_to_video"
        and selector_inputs.get("degraded_from_operation") == required_operation
        and isinstance(roles, list)
        and any(roles == list(expected) for expected in expected_roles[required_operation])
    ):
        return
    raise VideoFrameContractUnsupported(required_operation, actual_operation)


def _reference_guided_frame_prompt(
    base_prompt: str, selector_inputs: dict[str, Any]
) -> str:
    roles = selector_inputs.get("frame_reference_roles")
    if not isinstance(roles, list) or not roles:
        return base_prompt

    lines = [
        "BOUNDARY FRAME REFERENCE CONTRACT:",
        (
            "Every attached image has one explicit role below. Boundary-frame images control "
            "temporal state, camera, composition, pose, and scene state. Asset reference images "
            "control only the named object's identity and appearance. Never blend, exchange, or "
            "transfer constraints between these roles."
        ),
    ]
    for image_index, role in enumerate(roles, start=1):
        if role == "start_frame":
            lines.append(
                f"ATTACHED IMAGE {image_index} = START FRAME GUIDE. Begin from this exact "
                "temporal state as closely as possible: preserve camera position, framing, "
                "subject identity and count, pose, gaze, placement, lighting, scene state, and "
                "motion direction, then continue the action naturally."
            )
        elif role == "end_frame":
            lines.append(
                f"ATTACHED IMAGE {image_index} = END FRAME GUIDE. Progress continuously toward "
                "this temporal state and settle on its framing, subject identity and count, pose, "
                "placement, lighting, and scene state at the final visible frame."
            )
        elif role == "start_and_end_frame":
            lines.append(
                f"ATTACHED IMAGE {image_index} = START AND END FRAME GUIDE. Begin from this "
                "state, perform the requested motion continuously, and return to this state at "
                "the final visible frame."
            )
    if roles == ["start_frame", "end_frame"]:
        lines.append(
            "Never swap, merge, or average the two image roles. Interpolate a single continuous "
            "shot from image 1 to image 2; do not use a cut, dissolve, morph, duplicate subject, "
            "or insert an unrelated scene."
        )
    asset_roles = selector_inputs.get("asset_reference_roles")
    if isinstance(asset_roles, list):
        for item in asset_roles:
            if not isinstance(item, dict):
                continue
            image_index = item.get("image_index")
            kind = str(item.get("kind") or "asset").lower()
            label = str(item.get("label") or item.get("asset_id") or "asset")
            if kind == "character":
                lines.append(
                    f"ATTACHED IMAGE {image_index} = CHARACTER IDENTITY REFERENCE for {label}. "
                    "Use only this character's identity, face, body proportions, hairstyle, "
                    "wardrobe, accessories, and palette. Ignore that image's pose, background, "
                    "camera, lighting, composition, text, and any other person."
                )
            elif kind == "scene":
                lines.append(
                    f"ATTACHED IMAGE {image_index} = SCENE IDENTITY REFERENCE for {label}. Use "
                    "only its architecture, spatial layout, fixed structures, materials, and "
                    "environment palette. Ignore its camera framing, people, movable props, text, "
                    "lighting state, and action."
                )
            elif kind == "prop":
                lines.append(
                    f"ATTACHED IMAGE {image_index} = PROP APPEARANCE REFERENCE for {label}. Use "
                    "only the prop's shape, scale, material, wear, markings, and colors. Ignore "
                    "hands, people, background, camera, lighting, composition, and text."
                )
            else:
                lines.append(
                    f"ATTACHED IMAGE {image_index} = ASSET APPEARANCE REFERENCE for {label}. Use "
                    "only the named asset's stable visual identity; ignore pose, background, "
                    "camera, lighting, composition, unrelated objects, and text."
                )
    lines.append(
        "Boundary-frame roles always take priority for the first and final temporal states. "
        "Follow the shot instructions below for motion and action."
    )
    return "\n".join(lines) + "\n\nSHOT INSTRUCTIONS:\n" + base_prompt


def _finalize_video_prompt(
    *,
    shot: dict[str, Any],
    character_lookup: dict[str, dict[str, Any]],
    style_lock: str | None,
    selector_inputs: dict[str, Any],
) -> str:
    if not selector_inputs.get("frame_reference_roles"):
        return str(selector_inputs.get("prompt") or "")
    clean_prompt = compile_shot_prompt(
        shot,
        character_lookup,
        style_lock,
        asset_lookup=None,
    )
    guided_prompt = _reference_guided_frame_prompt(clean_prompt, selector_inputs)
    selector_inputs["prompt"] = guided_prompt
    return guided_prompt


def prepare_video_generation_request(
    *,
    model: str,
    prompt: str,
    size: str,
    seconds: float,
    images: list[str] | None = None,
) -> PreparedNewApiRequest:
    body: dict[str, object] = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "seconds": f"{seconds:g}",
    }
    if images:
        body["images"] = list(images)
    return PreparedNewApiRequest.json("POST", "/v1/videos", body)


def build_pipeline_inputs(
    series_bible: dict[str, Any],
    storyboard: dict[str, Any],
    continuity_plan: dict[str, Any] | None = None,
    render_runtime: RenderRuntime = "remotion",
    video_model: str = DEFAULT_VIDEO_MODEL,
    target_duration_seconds: int | None = None,
    project_aspect_ratio: str | None = None,
    db=None,
) -> dict[str, dict[str, Any]]:
    characters = series_bible.get("characters", [])
    character_lookup = {str(character.get("id")): character for character in characters}
    asset_lookup = {str(asset.get("id")): asset for asset in series_bible.get("assets", [])}
    style_lock = series_bible.get("style_lock") or "vertical short drama, cinematic continuity"
    shots = _with_target_shot_durations(
        sorted(storyboard.get("shots", []), key=lambda shot: int(shot.get("index", 0))),
        target_duration_seconds,
    )

    scenes = []
    assets = []
    cuts = []
    timeline_cursor = 0
    for zero_index, shot in enumerate(shots):
        shot_id = str(shot.get("id") or f"s{zero_index + 1}")
        scene_id = str(shot.get("scene_id") or shot_id)
        try:
            requested_duration = _generation_duration_seconds(
                shot,
                video_model,
                db=db,
            )
        except VideoFrameContractUnsupported:
            requested_duration = None
        duration_seconds = (
            _planned_timeline_duration_seconds(shot, requested_duration)
            if requested_duration is not None
            else _shot_duration_seconds(shot)
        )
        try:
            source_duration = float(shot.get("source_duration_seconds"))
        except (TypeError, ValueError):
            source_duration = 0
        if requested_duration is not None:
            shot["requested_duration_seconds"] = requested_duration
        else:
            shot.pop("requested_duration_seconds", None)
        shot["timeline_duration_seconds"] = duration_seconds
        start_seconds = timeline_cursor
        end_seconds = start_seconds + duration_seconds
        timeline_cursor = end_seconds
        compiled_prompt = compile_shot_prompt(shot, character_lookup, style_lock, asset_lookup)
        shot_aspect_ratio = _shot_aspect_ratio(shot, project_aspect_ratio)

        scenes.append(
            {
                "id": scene_id,
                "type": "generated",
                "description": str(shot.get("prompt", "")),
                "start_seconds": start_seconds,
                "end_seconds": end_seconds,
                "framing": f"{shot_aspect_ratio} cinematic shot",
                "movement": "cinematic subject motion with clear emotional beat",
                "narrative_role": _narrative_role(zero_index, len(shots)),
                "information_role": str(shot.get("beat", "story beat")),
                "hero_moment": zero_index == max(len(shots) - 2, 0),
                "texture_keywords": ["rain", "neon", "high contrast"],
                "shot_language": shot.get("shot_language") or {},
                "shot_intent": shot.get("shot_intent"),
                "required_assets": [
                    {
                        "type": "video",
                        "description": compiled_prompt,
                        "source": "generate",
                    }
                ],
                "metadata": {
                    "shot_id": shot_id,
                    "characters": shot.get("characters", []),
                    "aspect_ratio": shot_aspect_ratio,
                },
            }
        )

        asset_id = f"{shot_id}-video"
        asset_record = {
                "id": asset_id,
                "type": "video",
                "path": f"assets/video/{shot_id}.mp4",
                "source_tool": "syapi_video",
                "scene_id": scene_id,
                "prompt": compiled_prompt,
                "model": video_model,
                "cost_usd": 0,
                "resolution": video_generation_size(shot_aspect_ratio),
                "format": "mp4",
                "provider": "syapi",
                "generation_summary": "Mapped from short-drama storyboard shot.",
            }
        if requested_duration is not None:
            asset_record["requested_duration_seconds"] = requested_duration
        if source_duration > 0:
            asset_record["source_duration_seconds"] = source_duration
            asset_record["duration_seconds"] = source_duration
        assets.append(asset_record)
        cut = {
                "id": f"cut-{shot_id}",
                "source": asset_id,
                "in_seconds": 0,
                "out_seconds": duration_seconds,
                "source_in_seconds": 0,
                "source_out_seconds": duration_seconds,
                "timeline_start_seconds": start_seconds,
                "timeline_duration_seconds": duration_seconds,
                "duration_policy": "full_source",
                "requires_timeline_replan": False,
                "speed": 1,
                "layer": "primary",
                "transition_in": "cut" if zero_index == 0 else "dissolve",
                "transition_out": "dissolve",
                "transition_duration": 0.2,
                "reason": str(shot.get("beat", "story beat")),
            }
        if requested_duration is not None:
            cut["requested_duration_seconds"] = requested_duration
        if source_duration > 0:
            cut["source_duration_seconds"] = source_duration
        cuts.append(cut)

    proposal_packet = _build_proposal_packet(series_bible, shots, render_runtime, video_model)
    scene_plan = {"version": "1.0", "style_playbook": "cinematic", "scenes": scenes}
    asset_manifest = {"version": "1.0", "assets": assets, "total_cost_usd": 0}
    edit_decisions = {
        "version": "1.0",
        "cuts": cuts,
        "renderer_family": "cinematic-trailer",
        "render_runtime": render_runtime,
        "composition_mode": "templated",
        "audio": {
            "source": {
                "default_policy": "preserve",
                "default_volume": 1.0,
                "transition_seconds": 0.08,
            },
            "target_lufs": -14,
        },
        "subtitles": {
            "enabled": True,
            "style": "sentence",
            "position": "bottom-center",
            "max_words_per_line": 8,
        },
    }
    if timeline_cursor > 0:
        edit_decisions["total_duration_seconds"] = timeline_cursor

    inputs = {
        "proposal_packet": proposal_packet,
        "scene_plan": scene_plan,
        "asset_manifest": asset_manifest,
        "edit_decisions": edit_decisions,
    }
    if continuity_plan is not None:
        inputs["continuity_plan"] = continuity_plan
    return inputs


def write_pipeline_artifacts(
    project_dir: str | Path,
    pipeline_inputs: dict[str, dict[str, Any]],
) -> dict[str, Path]:
    artifact_dir = Path(project_dir) / "artifacts"
    written: dict[str, Path] = {}
    for name, data in pipeline_inputs.items():
        path = artifact_dir / f"{name}.json"
        atomic_write_text(
            path,
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        written[name] = path
    return written


def run_single_shot_generation(
    *,
    project_dir: str | Path,
    shot: dict[str, Any],
    series_bible: dict[str, Any],
    video_key: str,
    base_url: str,
    video_model: str = DEFAULT_VIDEO_MODEL,
    emit_event: Callable[[str, str, str], None] | None = None,
    project_aspect_ratio: str | None = None,
) -> dict[str, Any]:
    """Generate one shot through OpenMontage selectors using a per-call key context."""

    from tools.video.video_selector import VideoSelector

    project_path = Path(project_dir)
    character_lookup = {
        str(character.get("id")): character
        for character in series_bible.get("characters", [])
    }
    asset_lookup = {
        str(asset.get("id")): asset
        for asset in series_bible.get("assets", [])
    }
    prompt = compile_shot_prompt(
        shot,
        character_lookup,
        series_bible.get("style_lock"),
        asset_lookup,
    )
    shot_id = str(shot.get("id", "shot"))
    output_path = project_path / "assets" / "video" / f"{shot_id}.mp4"
    descriptor, temporary_output, expected_parent = create_atomic_output(
        output_path,
        suffix=f".generate{output_path.suffix}",
    )
    os.close(descriptor)
    try:
        selector = VideoSelector()
        provider_loader = getattr(selector, "_providers", None)
        providers = provider_loader() if callable(provider_loader) else []
        selector_inputs = build_video_selector_inputs(
            project_dir=project_path,
            shot=shot,
            prompt=prompt,
            video_model=video_model,
            output_path=temporary_output,
            asset_lookup=asset_lookup,
            providers=providers,
            project_aspect_ratio=project_aspect_ratio,
        )
        require_native_video_frame_contract(shot, selector_inputs)
        prompt = _finalize_video_prompt(
            shot=shot,
            character_lookup=character_lookup,
            style_lock=series_bible.get("style_lock"),
            selector_inputs=selector_inputs,
        )

        if emit_event:
            reference_count = len(selector_inputs.get("reference_image_paths", []))
            reference_count += int(bool(selector_inputs.get("first_frame_path")))
            reference_count += int(bool(selector_inputs.get("last_frame_path")))
            mode = selector_inputs["operation"]
            emit_event(
                "assets",
                "running",
                f"Generating video for {shot_id} with {mode} ({reference_count} reference images)",
            )

        with _patched_environment(key_environment(video_key, base_url)):
            result = selector.execute(selector_inputs)

        if not result.success:
            if emit_event:
                emit_event("assets", "failed", result.error or f"Generation failed for {shot_id}")
            raise RuntimeError(result.error or f"Generation failed for {shot_id}")
        replace_atomic_output(temporary_output, output_path, expected_parent)
    finally:
        temporary_output.unlink(missing_ok=True)

    result.data["output"] = str(output_path)

    if emit_event:
        emit_event("assets", "complete", f"Generated video for {shot_id}")

    return {
        "shot_id": shot_id,
        "output_path": str(output_path),
        "tool_result": result.data,
        "cost_usd": result.cost_usd,
        "operation": selector_inputs["operation"],
        "reference_image_paths": selector_inputs.get("reference_image_paths", []),
        "degraded_from_operation": selector_inputs.get("degraded_from_operation"),
        "referenced_asset_ids": selector_inputs.get("referenced_asset_ids", []),
    }


def _reference_image_data_uri(path_value: str) -> str:
    path = Path(path_value)
    content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{content_type};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"


def prepare_billed_shot_request(
    *,
    project_dir: str | Path,
    shot: dict[str, Any],
    series_bible: dict[str, Any],
    video_model: str = DEFAULT_VIDEO_MODEL,
    project_aspect_ratio: str | None = None,
    db=None,
) -> PreparedNewApiRequest:
    project_path = Path(project_dir)
    character_lookup = {
        str(character.get("id")): character
        for character in series_bible.get("characters", [])
    }
    asset_lookup = {
        str(asset.get("id")): asset
        for asset in series_bible.get("assets", [])
    }
    prompt = compile_shot_prompt(
        shot,
        character_lookup,
        series_bible.get("style_lock"),
        asset_lookup,
    )
    selector_inputs = build_video_selector_inputs(
        project_dir=project_path,
        shot=shot,
        prompt=prompt,
        video_model=video_model,
        output_path=project_path / "assets" / "video" / f"{shot.get('id', 'shot')}.mp4",
        asset_lookup=asset_lookup,
        providers=_newapi_provider_contracts(video_model),
        project_aspect_ratio=project_aspect_ratio,
        db=db,
    )
    require_native_video_frame_contract(shot, selector_inputs)
    prompt = _finalize_video_prompt(
        shot=shot,
        character_lookup=character_lookup,
        style_lock=series_bible.get("style_lock"),
        selector_inputs=selector_inputs,
    )
    images = [
        _reference_image_data_uri(path)
        for path in _selector_image_paths(selector_inputs)
    ]
    return prepare_video_generation_request(
        model=video_model,
        prompt=prompt,
        size=video_generation_size(selector_inputs["aspect_ratio"]),
        seconds=_generation_duration_seconds(shot, video_model, db=db),
        images=images,
    )


def generate_billed_shot(
    *,
    db,
    newapi,
    settings,
    media_store,
    user_id: str,
    project_id: str,
    parent_job_id: str | None,
    project_dir: str | Path,
    shot: dict[str, Any],
    series_bible: dict[str, Any],
    video_model: str = DEFAULT_VIDEO_MODEL,
    billing_job_id: str | None = None,
    settlement_key: str | None = None,
    project_aspect_ratio: str | None = None,
) -> dict[str, Any]:
    project_path = Path(project_dir)
    character_lookup = {
        str(character.get("id")): character
        for character in series_bible.get("characters", [])
    }
    asset_lookup = {
        str(asset.get("id")): asset
        for asset in series_bible.get("assets", [])
    }
    prompt = compile_shot_prompt(
        shot,
        character_lookup,
        series_bible.get("style_lock"),
        asset_lookup,
    )
    shot_id = str(shot.get("id", "shot"))
    selector_inputs = build_video_selector_inputs(
        project_dir=project_path,
        shot=shot,
        prompt=prompt,
        video_model=video_model,
        output_path=project_path / "assets" / "video" / f"{shot_id}.mp4",
        asset_lookup=asset_lookup,
        providers=_newapi_provider_contracts(video_model),
        project_aspect_ratio=project_aspect_ratio,
        db=db,
    )
    require_native_video_frame_contract(shot, selector_inputs)
    prompt = _finalize_video_prompt(
        shot=shot,
        character_lookup=character_lookup,
        style_lock=series_bible.get("style_lock"),
        selector_inputs=selector_inputs,
    )
    images = [
        _reference_image_data_uri(path)
        for path in _selector_image_paths(selector_inputs)
    ]
    request = prepare_video_generation_request(
        model=video_model,
        prompt=prompt,
        size=video_generation_size(selector_inputs["aspect_ratio"]),
        seconds=_generation_duration_seconds(shot, video_model, db=db),
        images=images,
    )
    operation = f"shot:{shot_id}"
    shot_version = int(shot.get("version", 1))

    def record_intent(job_id: str) -> None:
        media_store.record_video_generation_intent(
            project_id=project_id,
            job_id=job_id,
            shot_id=shot_id,
            shot_version=shot_version,
        )

    def discard_intent(job_id: str) -> None:
        media_store.delete_video_generation_intent(project_id, job_id)

    def validate_intent(job_id: str) -> None:
        intent = media_store.read_video_generation_intent(project_id, job_id)
        current_storyboard = media_store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        current_shot = next(
            (
                item
                for item in (current_storyboard or {}).get("shots", [])
                if isinstance(item, dict) and str(item.get("id")) == shot_id
            ),
            None,
        )
        if (
            intent.shot_id != shot_id
            or intent.shot_version != shot_version
            or current_shot is None
            or current_shot.get("version") != shot_version
        ):
            raise NewApiCallError(
                "video generation intent does not match current shot"
            )

    call = {
        "db": db,
        "newapi": newapi,
        "settings": settings,
        "artifact_inspector": media_store.inspect_staged_artifact,
        "user_id": user_id,
        "project_id": project_id,
        "capability": "video",
        "operation": operation,
        "request": request,
        "prepare_reservation": record_intent,
        "reservation_validator": validate_intent,
        "discard_reservation": discard_intent,
    }
    stable_job_id = billing_job_id or settlement_key
    existing_stable = db.get(GenerationJob, stable_job_id) if stable_job_id else None
    if existing_stable is not None:
        billing_job_id = existing_stable.id
    claim = None
    if billing_job_id is None:
        try:
            context = execute_billed_provider_call(
                parent_job_id=parent_job_id,
                job_id=settlement_key,
                **call,
            )
            job_id = context.job_id
            claim = context.claim
        except ExistingProviderOperation as exc:
            job_id = exc.job_id
    else:
        existing = db.get(GenerationJob, billing_job_id)
        if (
            existing is None
            or not existing.chargeable
            or existing.user_id != user_id
            or existing.project_id != project_id
            or existing.parent_job_id != parent_job_id
            or existing.capability != "video"
            or existing.operation != operation
            or existing.provider_method != request.method
            or existing.provider_route != request.path
            or existing.model != request.model
        ):
            db.rollback()
            raise NewApiCallError("video billing job is invalid")
        existing_status = existing.status
        db.commit()
        if existing_status == "payment_required_quote":
            context = retry_payment_required_quote(
                job_id=billing_job_id,
                parent_job_id=parent_job_id,
                **call,
            )
            job_id = context.job_id
            claim = context.claim
        elif existing_status == "payment_required":
            raise ProviderResultPending("video payment is pending", job_id=billing_job_id)
        elif existing_status != "billed" and existing_status.endswith("_no_charge"):
            raise ProviderGenerationFailed(billing_job_id, existing_status)
        else:
            job_id = billing_job_id
    try:
        intent = media_store.read_video_generation_intent(project_id, job_id)
    except ValueError:
        raise ProviderResultPending(
            "video generation binding is pending", job_id=job_id
        ) from None
    if intent.shot_id != shot_id or intent.shot_version != shot_version:
        raise NewApiCallError("video billing job does not match the current shot")
    if claim is None:
        BillingService(
            db, settings, media_store.inspect_staged_artifact
        ).validate_reserved_provider_call(
            job_id,
            user_id=user_id,
            project_id=project_id,
            parent_job_id=parent_job_id,
            reservation_validator=validate_intent,
        )
    try:
        outcome = resume_reconcile_publish_job(
            db,
            newapi,
            job_id,
            datetime.now(timezone.utc),
            settings=settings,
            media_store=media_store,
            claim=claim,
            pending_delay_seconds=0,
        )
    except InvalidNewApiResponse:
        raise ProviderResultPending("provider result is pending", job_id=job_id) from None
    if outcome == "pending":
        raise ProviderResultPending("provider result is pending", job_id=job_id)
    job = BillingService(
        db, settings, media_store.inspect_staged_artifact
    ).load_job(job_id)
    if job.status == "failed_no_charge" or job.status.endswith("_no_charge"):
        raise ProviderGenerationFailed(job_id, job.status)
    if not job.result_visible or job.result_locator is None:
        raise ProviderResultPending("provider result is pending", job_id=job_id)
    output_path = project_path / "assets" / "video" / f"{shot_id}.mp4"
    if not output_path.is_file():
        raise ProviderResultPending(
            "provider result is detached from current shot", job_id=job_id
        )
    try:
        source_duration = probe_media(output_path).get("duration_seconds")
    except Exception:
        # Tail-frame extraction performs the authoritative probe immediately
        # after publication. Keep provider publication idempotent until then.
        source_duration = None
    return {
        "shot_id": shot_id,
        "output_path": str(output_path),
        "tool_result": {"billing_job_id": job_id},
        "cost_usd": 0.0,
        "operation": selector_inputs["operation"],
        "reference_image_paths": selector_inputs.get("reference_image_paths", []),
        "degraded_from_operation": selector_inputs.get("degraded_from_operation"),
        "referenced_asset_ids": selector_inputs.get("referenced_asset_ids", []),
        "requested_duration_seconds": _generation_duration_seconds(
            shot, video_model, db=db
        ),
        "source_duration_seconds": source_duration,
    }


def generate_billed_generation_unit(
    *,
    db,
    newapi,
    settings,
    media_store,
    user_id: str,
    project_id: str,
    project_dir: str | Path,
    generation_unit: dict[str, Any],
    source_shots: list[dict[str, Any]],
    compiled_prompt: str,
    series_bible: dict[str, Any],
    generation_key: str,
    billing_job_id: str | None = None,
    settlement_key: str | None = None,
    project_aspect_ratio: str | None = None,
) -> dict[str, Any]:
    unit_id = str(generation_unit.get("id") or "")
    revision = int(generation_unit.get("revision") or 0)
    model_id = str(generation_unit.get("model_id") or "")
    requested_duration = float(
        generation_unit.get("requested_duration_seconds") or 0
    )
    source_ids = [str(value) for value in generation_unit.get("source_shot_ids") or []]
    if (
        not unit_id
        or revision < 1
        or not model_id
        or requested_duration <= 0
        or [str(shot.get("id") or "") for shot in source_shots] != source_ids
        or len(generation_key) != 64
    ):
        raise NewApiCallError("generation unit execution snapshot is invalid")

    project_path = Path(project_dir)
    asset_lookup = {
        str(asset.get("id")): asset
        for asset in series_bible.get("assets", [])
        if isinstance(asset, dict) and asset.get("id")
    }
    request_shot = _generation_unit_request_shot(
        generation_unit=generation_unit,
        source_shots=source_shots,
        compiled_prompt=compiled_prompt,
    )
    selector_inputs = build_video_selector_inputs(
        project_dir=project_path,
        shot=request_shot,
        prompt=compiled_prompt,
        video_model=model_id,
        output_path=(
            project_path
            / "assets"
            / "video"
            / "units"
            / unit_id
            / f"v{revision}.mp4"
        ),
        asset_lookup=asset_lookup,
        providers=_newapi_provider_contracts(model_id),
        project_aspect_ratio=project_aspect_ratio,
    )
    require_native_video_frame_contract(request_shot, selector_inputs)
    prompt = str(selector_inputs.get("prompt") or compiled_prompt)
    if selector_inputs.get("frame_reference_roles"):
        prompt = _reference_guided_frame_prompt(compiled_prompt, selector_inputs)
        selector_inputs["prompt"] = prompt
    images = [
        _reference_image_data_uri(path)
        for path in _selector_image_paths(selector_inputs)
    ]
    request = prepare_video_generation_request(
        model=model_id,
        prompt=prompt,
        size=video_generation_size(selector_inputs["aspect_ratio"]),
        seconds=requested_duration,
        images=images,
    )
    operation = generation_unit_billing_operation(unit_id, revision)

    def record_intent(job_id: str) -> None:
        media_store.record_generation_unit_video_intent(
            project_id=project_id,
            job_id=job_id,
            generation_unit_id=unit_id,
            generation_unit_revision=revision,
            generation_key=generation_key,
        )

    def discard_intent(job_id: str) -> None:
        media_store.delete_video_generation_intent(project_id, job_id)

    def validate_intent(job_id: str) -> None:
        intent = media_store.read_video_generation_intent(project_id, job_id)
        record = db.get(VideoGenerationUnit, (project_id, unit_id, revision))
        if (
            intent.generation_unit_id != unit_id
            or intent.generation_unit_revision != revision
            or intent.generation_key != generation_key
            or record is None
            or record.execution_key != generation_key
            or record.source_shot_ids_json != source_ids
            or record.source_shot_versions_json
            != generation_unit.get("source_shot_versions")
            or record.profile_revision != generation_unit.get("profile_revision")
            or record.requested_duration_seconds != requested_duration
            or record.model_id != model_id
            or record.operation != generation_unit.get("operation")
        ):
            raise NewApiCallError(
                "video generation intent does not match the generation unit ledger"
            )

    call = {
        "db": db,
        "newapi": newapi,
        "settings": settings,
        "artifact_inspector": media_store.inspect_staged_artifact,
        "user_id": user_id,
        "project_id": project_id,
        "capability": "video",
        "operation": operation,
        "request": request,
        "prepare_reservation": record_intent,
        "reservation_validator": validate_intent,
        "discard_reservation": discard_intent,
    }
    stable_job_id = billing_job_id or settlement_key
    existing_stable = db.get(GenerationJob, stable_job_id) if stable_job_id else None
    if existing_stable is not None:
        billing_job_id = existing_stable.id
    claim = None
    if billing_job_id is None:
        try:
            context = execute_billed_provider_call(
                parent_job_id=None,
                job_id=settlement_key,
                **call,
            )
            job_id = context.job_id
            claim = context.claim
        except ExistingProviderOperation as exc:
            job_id = exc.job_id
    else:
        existing = db.get(GenerationJob, billing_job_id)
        if (
            existing is None
            or not existing.chargeable
            or existing.user_id != user_id
            or existing.project_id != project_id
            or existing.parent_job_id is not None
            or existing.capability != "video"
            or existing.operation != operation
            or existing.provider_method != request.method
            or existing.provider_route != request.path
            or existing.model != request.model
        ):
            db.rollback()
            raise NewApiCallError("generation unit billing job is invalid")
        existing_status = existing.status
        db.commit()
        if existing_status == "payment_required_quote":
            context = retry_payment_required_quote(
                job_id=billing_job_id,
                parent_job_id=None,
                **call,
            )
            job_id = context.job_id
            claim = context.claim
        elif existing_status == "payment_required":
            raise ProviderResultPending(
                "video payment is pending", job_id=billing_job_id
            )
        elif existing_status != "billed" and existing_status.endswith("_no_charge"):
            raise ProviderGenerationFailed(billing_job_id, existing_status)
        else:
            job_id = billing_job_id

    validate_intent(job_id)
    bound_unit = db.get(VideoGenerationUnit, (project_id, unit_id, revision))
    if bound_unit is None or bound_unit.billing_job_id not in {None, job_id}:
        db.rollback()
        raise NewApiCallError("generation unit billing job binding is invalid")
    bound_unit.billing_job_id = job_id
    db.commit()
    if claim is None:
        BillingService(
            db, settings, media_store.inspect_staged_artifact
        ).validate_reserved_provider_call(
            job_id,
            user_id=user_id,
            project_id=project_id,
            parent_job_id=None,
            reservation_validator=validate_intent,
        )
    try:
        outcome = resume_reconcile_publish_job(
            db,
            newapi,
            job_id,
            datetime.now(timezone.utc),
            settings=settings,
            media_store=media_store,
            claim=claim,
            pending_delay_seconds=0,
        )
    except InvalidNewApiResponse:
        raise ProviderResultPending(
            "provider result is pending", job_id=job_id
        ) from None
    if outcome == "pending":
        raise ProviderResultPending("provider result is pending", job_id=job_id)
    job = BillingService(
        db, settings, media_store.inspect_staged_artifact
    ).load_job(job_id)
    if job.status.endswith("_no_charge"):
        raise ProviderGenerationFailed(job_id, job.status)
    published = db.get(VideoGenerationUnit, (project_id, unit_id, revision))
    if (
        published is None
        or published.status != "complete"
        or not published.active
        or published.billing_job_id != job_id
        or not published.output_path
    ):
        raise ProviderResultPending(
            "provider result is not yet bound to the generation unit", job_id=job_id
        )
    return {
        "generation_unit_id": unit_id,
        "generation_unit_revision": revision,
        "source_shot_ids": source_ids,
        "source_beat_ids": list(published.source_beat_ids_json),
        "source_segment_ids": list(published.source_segment_ids_json or []),
        "output_asset_id": published.output_asset_id,
        "output_path": published.output_path,
        "billing_job_id": job_id,
        "operation": operation,
        "provider_operation": selector_inputs["operation"],
        "requested_duration_seconds": requested_duration,
        "source_duration_seconds": published.source_duration_seconds,
        "referenced_asset_ids": selector_inputs.get("referenced_asset_ids", []),
        "publication_status": "published",
    }


def _generation_unit_request_shot(
    *,
    generation_unit: dict[str, Any],
    source_shots: list[dict[str, Any]],
    compiled_prompt: str,
) -> dict[str, Any]:
    first = dict(source_shots[0])
    last = source_shots[-1]
    continuity = dict(first.get("continuity") or {})
    last_continuity = last.get("continuity")
    if isinstance(last_continuity, dict) and isinstance(
        last_continuity.get("last_frame"), dict
    ):
        continuity["last_frame"] = deepcopy(last_continuity["last_frame"])
        continuity["last_frame_asset_id"] = last_continuity.get(
            "last_frame_asset_id"
        )
    first.update(
        {
            "id": str(generation_unit["id"]),
            "version": int(generation_unit["revision"]),
            "prompt": compiled_prompt,
            "requested_duration_seconds": generation_unit.get(
                "requested_duration_seconds"
            ),
            "continuity": continuity,
            "characters": _ordered_union(source_shots, "characters"),
            "asset_ids": _ordered_union(source_shots, "asset_ids"),
            "props": _ordered_union(source_shots, "props"),
        }
    )
    return first


def _ordered_union(values: list[dict[str, Any]], key: str) -> list[Any]:
    result: list[Any] = []
    for value in values:
        for item in value.get(key, []) or []:
            if item not in result:
                result.append(item)
    return result


def run_pipeline_handoff(
    *,
    project_dir: str | Path,
    series_bible: dict[str, Any],
    storyboard: dict[str, Any],
    gateway_key: str,
    base_url: str,
    continuity_plan: dict[str, Any] | None = None,
    render_runtime: RenderRuntime = "remotion",
    video_model: str = DEFAULT_VIDEO_MODEL,
    emit_event: Callable[[str, str, str], None] | None = None,
) -> dict[str, Any]:
    """Prepare artifacts and generate storyboard shots through existing selectors."""

    pipeline_inputs = build_pipeline_inputs(
        series_bible,
        storyboard,
        continuity_plan=continuity_plan,
        render_runtime=render_runtime,
        video_model=video_model,
    )
    written = write_pipeline_artifacts(project_dir, pipeline_inputs)

    outputs = []
    for stage in ("proposal", "scene_plan", "assets", "edit"):
        if emit_event:
            emit_event(stage, "complete", f"Wrote {stage} handoff artifact")

    for shot in storyboard.get("shots", []):
        outputs.append(
            run_single_shot_generation(
                project_dir=project_dir,
                shot=shot,
                series_bible=series_bible,
                video_key=gateway_key,
                base_url=base_url,
                video_model=video_model,
                emit_event=emit_event,
            )
        )

    if emit_event:
        emit_event("compose", "queued", "Shot assets are ready for composition")

    return {
        "artifacts": {key: str(path) for key, path in written.items()},
        "outputs": outputs,
    }


def render_short_drama_project(
    *,
    project_dir: str | Path,
    series_bible: dict[str, Any],
    storyboard: dict[str, Any],
    video_key: str | None = None,
    base_url: str | None = None,
    continuity_plan: dict[str, Any] | None = None,
    video_model: str = DEFAULT_VIDEO_MODEL,
    render_runtime: RenderRuntime = "ffmpeg",
    emit_event: Callable[[str, str, str], None] | None = None,
    generate_missing_shot: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    composition_output_path: str | Path | None = None,
    persist_render_report: bool = True,
    persist_execution_artifacts: bool = True,
    pipeline_inputs: dict[str, dict[str, Any]] | None = None,
    render_output_spec: dict[str, Any] | None = None,
    project_id: str | None = None,
    project_aspect_ratio: str | None = None,
    target_duration_seconds: float | None = None,
) -> dict[str, Any]:
    project_path = Path(project_dir)
    supplied_pipeline_inputs = pipeline_inputs is not None
    if pipeline_inputs is None:
        pipeline_inputs = build_pipeline_inputs(
            series_bible,
            storyboard,
            continuity_plan=continuity_plan,
            render_runtime=render_runtime,
            video_model=video_model,
            project_aspect_ratio=project_aspect_ratio,
        )
        written = write_pipeline_artifacts(project_path, pipeline_inputs)
    else:
        written = {}
    outputs: list[dict[str, Any]] = []
    provider_results_pending = False
    unit_assets = (
        generation_unit_timeline_assets(
            storyboard=storyboard,
            asset_manifest=pipeline_inputs.get("asset_manifest") or {},
        )
        if supplied_pipeline_inputs
        else None
    )

    for stage in ("proposal", "scene_plan", "edit"):
        if emit_event:
            emit_event(stage, "complete", f"Wrote {stage} handoff artifact")

    shots = sorted(storyboard.get("shots", []), key=lambda shot: int(shot.get("index", 0)))
    for unit_asset in unit_assets or []:
        metadata = unit_asset.get("metadata") or {}
        output_path = _project_media_path(project_path, unit_asset.get("path"))
        if output_path is None or not output_path.is_file():
            raise RuntimeError(
                f"Generation unit video missing: {metadata.get('generation_unit_id')}"
            )
        outputs.append(
            {
                "generation_unit_id": metadata.get("generation_unit_id"),
                "generation_unit_revision": metadata.get("revision"),
                "source_shot_ids": list(metadata.get("source_shot_ids") or []),
                "source_beat_ids": list(metadata.get("source_beat_ids") or []),
                "source_segment_ids": list(
                    metadata.get("source_segment_ids") or []
                ),
                "output_asset_id": unit_asset.get("id"),
                "output_path": str(output_path),
                "tool_result": {"reused": True},
                "cost_usd": 0.0,
            }
        )
        if emit_event:
            emit_event(
                "assets",
                "complete",
                f"Reused generation unit {metadata.get('generation_unit_id')}",
            )

    for shot in shots if unit_assets is None else []:
        existing_output = _project_media_path(project_path, shot.get("output_path"))
        if (
            shot.get("status") != "stale"
            and existing_output
            and existing_output.exists()
            and media_matches_aspect_ratio(
                existing_output,
                shot.get("aspect_ratio") or project_aspect_ratio,
            )
        ):
            shot["status"] = "complete"
            outputs.append(
                {
                    "shot_id": shot.get("id"),
                    "output_path": str(existing_output),
                    "tool_result": {"url": shot.get("output_url"), "reused": True},
                    "cost_usd": 0.0,
                }
            )
            if emit_event:
                emit_event("assets", "complete", f"Reused existing shot {shot.get('id')}")
            continue

        shot["status"] = "generating"
        if emit_event:
            emit_event("assets", "running", f"Generating shot {shot.get('id')}")
        try:
            if generate_missing_shot is not None:
                output = generate_missing_shot(shot)
            else:
                if video_key is None or base_url is None:
                    raise ValueError("server video provider is unavailable")
                output = run_single_shot_generation(
                    project_dir=project_path,
                    shot=shot,
                    series_bible=series_bible,
                    video_key=video_key,
                    base_url=base_url,
                    video_model=video_model,
                    project_aspect_ratio=project_aspect_ratio,
                    emit_event=emit_event,
                )
        except PaymentRequiredQuote:
            raise
        except ProviderResultPending:
            provider_results_pending = True
            continue
        except (
            ProviderPricingUnavailable,
            ProviderPricingUnstable,
            NewApiCallError,
            NewApiRateLimited,
        ):
            shot["status"] = "failed"
            if emit_event:
                emit_event("assets", "failed", "Shot generation failed")
            continue
        shot["status"] = "complete"
        shot["output_path"] = output["output_path"]
        shot["output_url"] = output["tool_result"].get("url")
        outputs.append(output)

    if provider_results_pending:
        raise ProviderResultPending("provider results are pending")

    if emit_event:
        emit_event("compose", "running", "Composing final video")
    final_review = None
    edit_timeline = None
    render_plan = None
    if supplied_pipeline_inputs:
        default_width, default_height = video_output_size(project_aspect_ratio)
        output_spec = render_output_spec or {
            "width": default_width,
            "height": default_height,
            "fps": 30,
            "format": "mp4",
            "video_codec": "h264",
            "audio_codec": "aac",
        }
        edit_decisions = _scope_edit_decisions_to_storyboard(
            dict(pipeline_inputs.get("edit_decisions") or {}),
            storyboard,
        )
        edit_decisions["render_runtime"] = render_runtime
        edit_timeline = compile_legacy_edit_timeline(
            project_id=project_id or project_path.name,
            project_dir=project_path,
            storyboard=storyboard,
            asset_manifest=pipeline_inputs.get("asset_manifest") or {},
            edit_decisions=edit_decisions,
            output=output_spec,
        )
        render_plan = compile_render_plan_from_timeline(
            timeline=edit_timeline,
            project_dir=project_path,
        )
        final_path = (
            Path(composition_output_path)
            if composition_output_path is not None
            else project_path / "renders" / "final.mp4"
        )
        execution = execute_render_plan(
            plan=render_plan,
            output_path=final_path,
            proposal_packet=pipeline_inputs.get("proposal_packet"),
        )
        final_review = execution["final_review"]
    elif composition_output_path is None:
        if project_aspect_ratio is None:
            final_path = compose_final_video(project_path, storyboard)
        else:
            final_path = compose_final_video(
                project_path,
                storyboard,
                project_aspect_ratio=project_aspect_ratio,
            )
    else:
        if project_aspect_ratio is None:
            final_path = compose_final_video(
                project_path,
                storyboard,
                output_path=Path(composition_output_path),
            )
        else:
            final_path = compose_final_video(
                project_path,
                storyboard,
                output_path=Path(composition_output_path),
                project_aspect_ratio=project_aspect_ratio,
            )
    if emit_event:
        emit_event("compose", "complete", "Final video rendered")

    render_report = {
        "version": "1.0",
        "outputs": [
            _render_report_output(
                final_path,
                fallback_duration_seconds=(
                    render_plan.total_duration_seconds
                    if render_plan is not None
                    else sum(_shot_duration_seconds(shot) for shot in shots)
                ),
                target_duration_seconds=target_duration_seconds,
            )
        ],
        "warnings": [],
        "verification_notes": [
            (
                "Rendered from a frozen frame-exact Render Plan with a centralized audio master."
                if render_plan is not None
                else "Rendered from generated storyboard shot videos with FFmpeg normalized concat."
            )
        ],
        "render_grammar": "cinematic-trailer",
    }
    if persist_render_report:
        atomic_write_text(
            project_path / "artifacts" / "render_report.json",
            json.dumps(render_report, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    if persist_execution_artifacts and edit_timeline is not None and render_plan is not None:
        for filename, data in (
            ("edit_timeline.json", edit_timeline.model_dump(mode="json")),
            ("render_plan.json", render_plan.model_dump(mode="json")),
            ("final_review.json", final_review),
        ):
            atomic_write_text(
                project_path / "artifacts" / filename,
                json.dumps(data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

    return {
        "artifacts": {key: str(path) for key, path in written.items()},
        "outputs": outputs,
        "final_path": str(final_path),
        "render_report": render_report,
        "edit_timeline": (
            edit_timeline.model_dump(mode="json") if edit_timeline is not None else None
        ),
        "render_plan": (
            render_plan.model_dump(mode="json") if render_plan is not None else None
        ),
        "final_review": final_review,
        "storyboard": storyboard,
        "partial_failure": any(shot.get("status") == "failed" for shot in shots),
    }


def compose_final_video(
    project_dir: str | Path,
    storyboard: dict[str, Any],
    *,
    output_path: Path | None = None,
    project_aspect_ratio: str | None = None,
) -> Path:
    project_path = Path(project_dir)
    output_path = output_path or project_path / "renders" / "final.mp4"
    output_width, output_height = video_output_size(
        storyboard.get("aspect_ratio") or project_aspect_ratio
    )
    shot_paths = [
        resolved_path
        for shot in sorted(
            storyboard.get("shots", []),
            key=lambda item: int(item.get("index", 0)),
        )
        if (
            resolved_path := _project_media_path(
                project_path, shot.get("output_path")
            )
        )
        is not None
    ]
    if not shot_paths:
        raise RuntimeError("No generated shot videos found to compose.")
    missing = [path for path in shot_paths if not path.exists()]
    if missing:
        raise RuntimeError(f"Generated shot video missing: {missing[0]}")

    descriptor, temporary_output, expected_parent = create_atomic_output(
        output_path,
        suffix=f".render{output_path.suffix}",
    )
    os.close(descriptor)
    try:
        cmd = _build_ffmpeg_compose_command(
            shot_paths,
            temporary_output,
            output_width=output_width,
            output_height=output_height,
        )
        subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
            check=True,
        )
        replace_atomic_output(temporary_output, output_path, expected_parent)
    finally:
        temporary_output.unlink(missing_ok=True)
    return output_path


def _render_report_output(
    final_path: Path,
    *,
    fallback_duration_seconds: float,
    target_duration_seconds: float | None = None,
) -> dict[str, Any]:
    try:
        metadata = probe_media(final_path)
    except Exception:
        metadata = probe_output(final_path)
    width = metadata.get("video_width")
    height = metadata.get("video_height")
    duration = metadata.get("duration_seconds", fallback_duration_seconds)
    result = {
        "path": str(final_path),
        "format": "mp4",
        "resolution": f"{width}x{height}" if width and height else "1080x1920",
        "duration_seconds": duration,
        "file_size_bytes": metadata.get("file_size_bytes") or final_path.stat().st_size,
    }
    if target_duration_seconds is not None and target_duration_seconds > 0:
        result["target_duration_seconds"] = target_duration_seconds
        result["duration_difference_seconds"] = round(
            float(duration) - target_duration_seconds,
            3,
        )
    for key, value in (
        ("codec", metadata.get("video_codec")),
        ("audio_codec", metadata.get("audio_codec")),
        ("fps", metadata.get("fps")),
    ):
        if value:
            result[key] = value
    return result


def _build_ffmpeg_compose_command(
    shot_paths: list[Path],
    output_path: Path,
    *,
    shot_durations: list[float] | None = None,
    output_width: int = 1080,
    output_height: int = 1920,
) -> list[str]:
    ffmpeg = _resolve_ffmpeg_executable()
    remotion_bundled = _is_remotion_bundled_ffmpeg(ffmpeg)
    input_profiles = [_probe_compose_input(path) for path in shot_paths]
    if remotion_bundled and any(
        not _profile_matches_aspect(profile, output_width, output_height)
        for profile in input_profiles
        if profile.get("video_width") and profile.get("video_height")
    ):
        raise RuntimeError(
            "Bundled FFmpeg cannot safely fit mismatched shot aspect ratios"
        )
    if shot_durations is None:
        target_durations = [
            _format_filter_duration(profile.get("duration_seconds"))
            for profile in input_profiles
        ]
        if any(duration is None for duration in target_durations):
            raise RuntimeError("Source video duration could not be probed")
    else:
        if len(shot_durations) != len(shot_paths):
            raise ValueError("shot durations must match shot paths")
        target_durations = [
            _format_filter_duration(duration)
            for duration in shot_durations
        ]
        if any(duration is None for duration in target_durations):
            raise ValueError("shot durations must be positive")
    normalized_durations = [str(duration) for duration in target_durations]
    should_emit_audio = any(profile["has_audio"] for profile in input_profiles)
    cmd = [ffmpeg, "-y"]
    for path, target_duration in zip(shot_paths, normalized_durations, strict=True):
        if shot_durations is not None:
            cmd.extend(["-t", target_duration])
        cmd.extend(["-i", str(path)])

    video_labels: list[str] = []
    audio_labels: list[str] = []
    filters: list[str] = []
    for index, _path in enumerate(shot_paths):
        target_duration = normalized_durations[index]
        video_label = f"v{index}"
        video_labels.append(f"[{video_label}]")
        filters.append(
            _build_video_normalize_filter(
                index,
                video_label,
                remotion_bundled,
                output_width=output_width,
                output_height=output_height,
                profile=input_profiles[index],
            )
        )
        if should_emit_audio:
            audio_label = f"a{index}"
            audio_labels.append(f"[{audio_label}]")
            filters.append(
                _build_audio_normalize_filter(
                    index,
                    audio_label,
                    input_profiles[index],
                    target_duration,
                )
            )

    if should_emit_audio:
        concat_inputs = "".join(
            f"{video_label}{audio_label}"
            for video_label, audio_label in zip(video_labels, audio_labels, strict=True)
        )
        filters.append(f"{concat_inputs}concat=n={len(shot_paths)}:v=1:a=1[outv][outa]")
        maps_and_audio_options = [
            "-map",
            "[outv]",
            "-map",
            "[outa]",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "44100",
            "-ac",
            "2",
        ]
    else:
        filters.append(f"{''.join(video_labels)}concat=n={len(shot_paths)}:v=1:a=0[outv]")
        maps_and_audio_options = ["-map", "[outv]"]

    cmd.extend(
        [
            "-filter_complex",
            ";".join(filters),
            *maps_and_audio_options,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-movflags",
            "+faststart",
            "-t",
            _format_filter_duration(sum(float(value) for value in target_durations))
            or "5.000",
            str(output_path),
        ]
    )
    return cmd


def _probe_compose_input(path: Path) -> dict[str, Any]:
    info: dict[str, Any] = {
        "has_audio": False,
        "duration_seconds": None,
        "video_width": 0,
        "video_height": 0,
    }
    ffprobe = _resolve_ffprobe_executable()
    try:
        proc = subprocess.run(
            [
                ffprobe,
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
            check=False,
        )
    except Exception:
        return info
    if getattr(proc, "returncode", 1) != 0:
        return info
    try:
        probe = json.loads(getattr(proc, "stdout", "") or "{}")
    except json.JSONDecodeError:
        return info

    info["has_audio"] = any(
        stream.get("codec_type") == "audio" for stream in probe.get("streams", [])
    )
    video_stream = next(
        (
            stream
            for stream in probe.get("streams", [])
            if stream.get("codec_type") == "video"
        ),
        {},
    )
    info["video_width"] = int(video_stream.get("width") or 0)
    info["video_height"] = int(video_stream.get("height") or 0)
    duration = _duration_from_probe(probe)
    if duration is not None:
        info["duration_seconds"] = duration
    return info


def _duration_from_probe(probe: dict[str, Any]) -> float | None:
    candidates: list[Any] = [probe.get("format", {}).get("duration")]
    candidates.extend(stream.get("duration") for stream in probe.get("streams", []))
    for candidate in candidates:
        try:
            duration = float(candidate)
        except (TypeError, ValueError):
            continue
        if duration > 0:
            return duration
    return None


def _build_audio_normalize_filter(
    index: int,
    label: str,
    profile: dict[str, Any],
    target_duration: str,
) -> str:
    if profile.get("has_audio"):
        return (
            f"[{index}:a:0]aresample=44100,aformat=channel_layouts=stereo"
            f",apad,atrim=0:{target_duration},asetpts=PTS-STARTPTS[{label}]"
        )
    return (
        "anullsrc=channel_layout=stereo:sample_rate=44100,"
        f"atrim=0:{target_duration},asetpts=PTS-STARTPTS[{label}]"
    )


def _format_filter_duration(value: Any) -> str | None:
    try:
        duration = float(value)
    except (TypeError, ValueError):
        return None
    if duration <= 0:
        return None
    return f"{duration:.3f}"


def _build_video_normalize_filter(
    index: int,
    label: str,
    remotion_bundled: bool,
    *,
    output_width: int,
    output_height: int,
    profile: dict[str, Any],
) -> str:
    if remotion_bundled:
        return (
            f"[{index}:v]scale={output_width}:{output_height},"
            f"format=yuv420p[{label}]"
        )
    if _profile_matches_aspect(profile, output_width, output_height):
        return (
            f"[{index}:v]scale={output_width}:{output_height},"
            f"setsar=1,fps=30,format=yuv420p[{label}]"
        )
    return (
        f"[{index}:v]"
        f"scale={output_width}:{output_height}:force_original_aspect_ratio=decrease,"
        f"pad={output_width}:{output_height}:(ow-iw)/2:(oh-ih)/2,"
        "setsar=1,fps=30,format=yuv420p"
        f"[{label}]"
    )


def _profile_matches_aspect(
    profile: dict[str, Any],
    output_width: int,
    output_height: int,
) -> bool:
    width = int(profile.get("video_width") or 0)
    height = int(profile.get("video_height") or 0)
    if width <= 0 or height <= 0:
        return True
    return abs(width / height - output_width / output_height) <= 0.01


def _is_remotion_bundled_ffmpeg(ffmpeg: str) -> bool:
    parts = {part.lower() for part in Path(ffmpeg).parts}
    return "remotion-composer" in parts and "@remotion" in parts


def _project_media_path(project_dir: Path, file_path: str | Path | None) -> Path | None:
    if not file_path:
        return None
    project_path = project_dir.resolve()
    candidate = Path(str(file_path))
    if not candidate.is_absolute():
        candidate = project_path / candidate
    resolved = candidate.resolve()
    if resolved == project_path or project_path in resolved.parents:
        return resolved
    return None


def _build_proposal_packet(
    series_bible: dict[str, Any],
    shots: list[dict[str, Any]],
    render_runtime: RenderRuntime,
    video_model: str,
) -> dict[str, Any]:
    title = str(series_bible.get("title") or "Short Drama")
    stages = [
        {
            "stage": "proposal",
            "tools": [],
            "approach": "Use the approved short-drama storyboard as the creative contract.",
        },
        {
            "stage": "scene_plan",
            "tools": [],
            "approach": "Map each storyboard shot to one generated OpenMontage scene.",
        },
        {
            "stage": "assets",
            "tools": [
                {
                    "tool_name": "syapi_video",
                    "role": "Generate one vertical drama clip per shot",
                    "provider": "syapi",
                    "available": True,
                    "estimated_cost_usd": 0,
                    "model": video_model,
                    "why_this_provider": "The user supplied a dedicated SYAPI video key for generation.",
                }
            ],
            "approach": f"Generate shot video assets with per-job video key context and model={video_model}.",
        },
        {
            "stage": "edit",
            "tools": [],
            "approach": "Order generated clips according to the storyboard waterfall.",
        },
        {
            "stage": "compose",
            "tools": [
                {
                    "tool_name": "video_compose",
                    "role": "Compose final short drama render",
                    "provider": "openmontage",
                    "available": True,
                    "estimated_cost_usd": 0,
                    "why_this_provider": "Existing OpenMontage composition contract.",
                }
            ],
            "approach": f"Compose with locked render_runtime={render_runtime}.",
        },
    ]

    return {
        "version": "1.0",
        "concept_options": [
            _concept_option("c1", title, "The clue appears before the viewer can look away.", shots),
            _concept_option("c2", f"{title}: Betrayal Cut", "The ally looks guilty until the reversal lands.", shots),
            _concept_option("c3", f"{title}: Evidence Trail", "Every prop becomes a clue in the final turn.", shots),
        ],
        "selected_concept": {
            "concept_id": "c1",
            "rationale": "Selected from the workbench storyboard as the current production path.",
            "modifications": [],
        },
        "production_plan": {
            "pipeline": "cinematic",
            "playbook": "cinematic",
            "stages": stages,
            "quality_tradeoffs": [
                {
                    "tradeoff": "Mock storyboard speed vs real provider generation latency",
                    "recommendation": "Use real generation for selected shots after reviewing consistency.",
                    "quality_impact": "Keeps iteration fast while preserving the OpenMontage handoff path.",
                }
            ],
            "alternative_paths": [
                {
                    "description": "Single-shot generation before whole-episode render",
                    "total_cost_usd": 0,
                    "quality_level": "standard",
                    "what_changes": "Only selected shots consume provider calls.",
                }
            ],
            "delivery_promise": {
                "promise_type": "motion_led",
                "motion_required": True,
                "source_required": False,
                "tone_mode": "cinematic short drama",
                "quality_floor": "draft",
                "approved_fallback": None,
            },
            "renderer_family": "cinematic-trailer",
            "render_runtime": render_runtime,
            "composition_mode": "templated",
            "music_source": {"source_type": "none", "estimated_cost_usd": 0},
            "decision_log_ref": "artifacts/decision_log.json",
        },
        "cost_estimate": {
            "total_estimated_usd": 0,
            "line_items": [
                {
                    "tool": "syapi_video",
                    "model": video_model,
                    "operation": "shot video generation",
                    "quantity": len(shots),
                    "estimated_usd": 0,
                    "notes": "Actual gateway cost depends on SYAPI model variant and account pricing.",
                }
            ],
            "budget_verdict": "no_budget_set",
            "savings_options": ["Regenerate only failed or high-risk shots."],
        },
        "approval": {"status": "pending"},
        "metadata": {"source": "short-drama-workbench"},
    }


def _concept_option(
    concept_id: str,
    title: str,
    hook: str,
    shots: list[dict[str, Any]],
) -> dict[str, Any]:
    beats = [str(shot.get("beat", "story beat")) for shot in shots[:3]]
    while len(beats) < 2:
        beats.append("story reversal")
    return {
        "id": concept_id,
        "title": title,
        "hook": hook,
        "narrative_structure": "story",
        "visual_approach": "Vertical cinematic short-drama scenes with tight continuity locks.",
        "suggested_playbook": "cinematic",
        "target_audience": "short-drama viewers",
        "target_platform": "tiktok",
        "target_duration_seconds": sum(
            _shot_duration_seconds(shot) for shot in shots
        )
        or 5,
        "key_points": beats,
        "core_message": "The truth was visible from the first clue.",
        "cta": "Watch the next episode.",
        "tone": "suspenseful",
        "grounded_in": ["workbench_storyboard"],
        "why_this_works": "It converts the storyboard waterfall into a compact hook, escalation, and reversal.",
    }


def _narrative_role(index: int, total: int) -> str:
    if index == 0:
        return "establish_context"
    if index >= total - 1:
        return "resolution"
    if index >= total - 2:
        return "deliver_payload"
    return "build_tension"


def _ffmpeg_concat_path(path: Path) -> str:
    return str(path.resolve()).replace("\\", "/").replace("'", "'\\''")


def _resolve_ffmpeg_executable() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg

    bundled = _remotion_compositor_dir() / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if bundled.exists():
        return str(bundled)

    return "ffmpeg"


def _resolve_ffprobe_executable() -> str:
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        return ffprobe

    ffmpeg_path = Path(_resolve_ffmpeg_executable())
    sibling_name = "ffprobe.exe" if os.name == "nt" else "ffprobe"
    sibling = ffmpeg_path.with_name(sibling_name)
    if sibling.exists():
        return str(sibling)

    bundled = _remotion_compositor_dir() / sibling_name
    if bundled.exists():
        return str(bundled)

    return "ffprobe"


def _remotion_compositor_dir() -> Path:
    return (
        Path(__file__).resolve().parents[2]
        / "remotion-composer"
        / "node_modules"
        / "@remotion"
        / "compositor-win32-x64-msvc"
    )


@contextmanager
def _patched_environment(values: dict[str, str]) -> Iterator[None]:
    previous = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, old_value in previous.items():
            if old_value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old_value
