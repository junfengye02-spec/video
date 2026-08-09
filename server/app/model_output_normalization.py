from __future__ import annotations

import json
import re
from typing import Any

from server.app.models import ShotLanguage

_ALLOWED_LENSES = {14, 24, 35, 50, 85, 135, 200}
_ALLOWED_SHOT_SIZES = {
    "extreme_wide",
    "wide",
    "medium_wide",
    "medium",
    "medium_close",
    "close_up",
    "extreme_close_up",
    "over_shoulder",
    "insert",
    "establishing",
}
_ALLOWED_CAMERA_MOVEMENTS = {
    "static",
    "pan_left",
    "pan_right",
    "tilt_up",
    "tilt_down",
    "dolly_in",
    "dolly_out",
    "tracking_left",
    "tracking_right",
    "crane_up",
    "crane_down",
    "handheld",
    "steadicam",
    "whip_pan",
    "orbital",
    "zoom_in",
    "zoom_out",
    "rack_focus",
}
_ALLOWED_LIGHTING_KEYS = {
    "high_key",
    "low_key",
    "natural",
    "golden_hour",
    "blue_hour",
    "tungsten_warm",
    "neon",
    "silhouette",
    "rim_lit",
    "volumetric",
    "overcast_soft",
}
_ALLOWED_DEPTHS = {"shallow", "medium", "deep"}
_ALLOWED_COLOR_TEMPERATURES = {"cool", "neutral", "warm", "mixed"}

_SHOT_SIZE_ALIASES = {
    "big_close_up": "extreme_close_up",
    "closeup": "close_up",
    "close_up_shot": "close_up",
    "close_shot": "close_up",
    "establishing_shot": "establishing",
    "extreme_closeup": "extreme_close_up",
    "extreme_close_up_shot": "extreme_close_up",
    "extreme_wide_shot": "extreme_wide",
    "full_shot": "wide",
    "medium_close_shot": "medium_close",
    "medium_closeup": "medium_close",
    "medium_shot": "medium",
    "medium_wide_shot": "medium_wide",
    "over_the_shoulder": "over_shoulder",
    "ots": "over_shoulder",
    "wide_shot": "wide",
}
_CAMERA_MOVEMENT_ALIASES = {
    "camera_push_in": "dolly_in",
    "dolly_push_in": "dolly_in",
    "push": "dolly_in",
    "push_in": "dolly_in",
    "pushin": "dolly_in",
    "pull": "dolly_out",
    "pull_back": "dolly_out",
    "pull_out": "dolly_out",
    "pullout": "dolly_out",
    "rackfocus": "rack_focus",
    "steady_cam": "steadicam",
    "tracking": "tracking_left",
    "truck_left": "tracking_left",
    "truck_right": "tracking_right",
    "whip": "whip_pan",
    "whippan": "whip_pan",
}
_LIGHTING_ALIASES = {
    "blue_hour_light": "blue_hour",
    "golden_hour_light": "golden_hour",
    "high_key_light": "high_key",
    "low_key_light": "low_key",
    "natural_light": "natural",
    "neon_light": "neon",
    "rim_light": "rim_lit",
    "rim_lighting": "rim_lit",
    "soft_overcast": "overcast_soft",
    "tungsten": "tungsten_warm",
    "warm_tungsten": "tungsten_warm",
}
_COLOR_TEMPERATURE_ALIASES = {
    "cool_light": "cool",
    "mixed_light": "mixed",
    "mixed_lighting": "mixed",
    "neutral_light": "neutral",
    "warm_light": "warm",
}


def parse_model_json(content: Any) -> Any:
    stripped = str(content).strip()
    fence_match = re.search(r"```(?:json)?\s*(.*?)```", stripped, flags=re.IGNORECASE | re.DOTALL)
    if fence_match:
        stripped = fence_match.group(1).strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        for index, character in enumerate(stripped):
            if character not in "[{":
                continue
            try:
                parsed, _ = decoder.raw_decode(stripped[index:])
            except json.JSONDecodeError:
                continue
            return parsed
        raise


def normalize_shot_language(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    cleaned = {key: item for key, item in value.items() if item not in ("", None)}
    _set_normalized(cleaned, "shot_size", _normalize_alias(cleaned.get("shot_size"), _ALLOWED_SHOT_SIZES, _SHOT_SIZE_ALIASES))
    _set_normalized(
        cleaned,
        "camera_movement",
        _normalize_alias(cleaned.get("camera_movement"), _ALLOWED_CAMERA_MOVEMENTS, _CAMERA_MOVEMENT_ALIASES),
    )
    lens_mm = _normalize_lens_mm(cleaned.get("lens_mm"))
    if lens_mm is None:
        cleaned.pop("lens_mm", None)
    else:
        cleaned["lens_mm"] = lens_mm
    lighting_key = _normalize_alias(cleaned.get("lighting_key"), _ALLOWED_LIGHTING_KEYS, _LIGHTING_ALIASES)
    if lighting_key is None:
        lighting_as_temperature = _normalize_alias(
            cleaned.get("lighting_key"),
            _ALLOWED_COLOR_TEMPERATURES,
            _COLOR_TEMPERATURE_ALIASES,
        )
        if lighting_as_temperature and "color_temperature" not in cleaned:
            cleaned["color_temperature"] = lighting_as_temperature
        cleaned.pop("lighting_key", None)
    else:
        cleaned["lighting_key"] = lighting_key
    _set_normalized(cleaned, "depth_of_field", _normalize_alias(cleaned.get("depth_of_field"), _ALLOWED_DEPTHS, {}))
    _set_normalized(
        cleaned,
        "color_temperature",
        _normalize_alias(cleaned.get("color_temperature"), _ALLOWED_COLOR_TEMPERATURES, _COLOR_TEMPERATURE_ALIASES),
    )
    try:
        normalized = ShotLanguage(**cleaned)
    except Exception:
        return None
    payload = normalized.model_dump(exclude_none=True)
    return payload or None


def complete_shot_language(value: Any, *context_parts: Any) -> dict[str, Any] | None:
    cleaned = normalize_shot_language(value) or {}
    context = " ".join(str(part or "") for part in context_parts).lower()
    had_unusable_lighting_key = isinstance(value, dict) and value.get("lighting_key") not in ("", None) and "lighting_key" not in cleaned

    if "shot_size" not in cleaned:
        cleaned["shot_size"] = _infer_shot_size(context)
    if "camera_movement" not in cleaned:
        cleaned["camera_movement"] = _infer_camera_movement(context)
    if "lens_mm" not in cleaned:
        cleaned["lens_mm"] = _infer_lens(cleaned.get("shot_size"))
    if "lighting_key" not in cleaned and not had_unusable_lighting_key:
        cleaned["lighting_key"] = _infer_lighting_key(context)
    if "depth_of_field" not in cleaned:
        cleaned["depth_of_field"] = _infer_depth_of_field(context, cleaned.get("shot_size"))
    if "color_temperature" not in cleaned:
        cleaned["color_temperature"] = _infer_color_temperature(context)

    return normalize_shot_language(cleaned)


def _set_normalized(payload: dict[str, Any], key: str, value: str | None) -> None:
    if value is None:
        payload.pop(key, None)
    else:
        payload[key] = value


def _normalize_alias(value: Any, allowed: set[str], aliases: dict[str, str]) -> str | None:
    key = _normalize_token(value)
    if not key:
        return None
    if key in aliases:
        return aliases[key]
    if key in allowed:
        return key
    if key.endswith("_shot") and key.removesuffix("_shot") in allowed:
        return key.removesuffix("_shot")
    return None


def _normalize_token(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")
    normalized = re.sub(r"_+", "_", normalized)
    return normalized or None


def _infer_shot_size(text: str) -> str:
    if _has_any(text, "extreme close", "macro", "insert detail"):
        return "extreme_close_up"
    if _has_any(text, "medium close", "medium-close"):
        return "medium_close"
    if _has_any(text, "close up", "close-up", "closeup", "tight shot"):
        return "close_up"
    if _has_any(text, "medium shot", "medium office", "medium blocking", "medium"):
        return "medium"
    if _has_any(text, "establishing"):
        return "establishing"
    if _has_any(text, "wide", "opening", "location"):
        return "wide"
    return "medium"


def _infer_camera_movement(text: str) -> str:
    if _has_any(text, "push in", "push-in", "dolly in", "dolly-in"):
        return "dolly_in"
    if _has_any(text, "pull out", "pull-out", "pull back", "dolly out", "dolly-out"):
        return "dolly_out"
    if "handheld" in text:
        return "handheld"
    if _has_any(text, "orbit", "circle around"):
        return "orbital"
    if _has_any(text, "pan left"):
        return "pan_left"
    if _has_any(text, "pan right"):
        return "pan_right"
    if _has_any(text, "zoom in"):
        return "zoom_in"
    if _has_any(text, "zoom out"):
        return "zoom_out"
    return "static"


def _infer_lens(shot_size: Any) -> int:
    if shot_size in {"extreme_close_up", "close_up", "insert"}:
        return 85
    if shot_size in {"medium_close", "over_shoulder"}:
        return 50
    if shot_size in {"wide", "medium_wide", "establishing"}:
        return 24
    if shot_size == "extreme_wide":
        return 14
    return 35


def _infer_lighting_key(text: str) -> str:
    if "neon" in text:
        return "neon"
    if _has_any(text, "golden hour", "sunset"):
        return "golden_hour"
    if _has_any(text, "blue hour"):
        return "blue_hour"
    if _has_any(text, "tungsten", "warm practical", "practical light"):
        return "tungsten_warm"
    if _has_any(text, "rim light", "rim-lit", "rim lit"):
        return "rim_lit"
    if "silhouette" in text:
        return "silhouette"
    if _has_any(text, "overcast", "soft daylight"):
        return "overcast_soft"
    if _has_any(text, "daylight", "natural"):
        return "natural"
    if _has_any(text, "dark", "night", "low-key", "low key"):
        return "low_key"
    return "natural"


def _infer_depth_of_field(text: str, shot_size: Any) -> str:
    if _has_any(text, "shallow", "bokeh"):
        return "shallow"
    if _has_any(text, "deep focus", "deep depth"):
        return "deep"
    if shot_size in {"close_up", "extreme_close_up", "medium_close", "insert"}:
        return "shallow"
    if shot_size in {"wide", "extreme_wide", "establishing"}:
        return "deep"
    return "medium"


def _infer_color_temperature(text: str) -> str:
    if _has_any(text, "mixed"):
        return "mixed"
    if _has_any(text, "warm", "tungsten", "golden hour", "sunset"):
        return "warm"
    if _has_any(text, "cool", "blue", "neon", "night"):
        return "cool"
    return "neutral"


def _has_any(text: str, *needles: str) -> bool:
    return any(needle in text for needle in needles)


def _normalize_lens_mm(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value in _ALLOWED_LENSES else None
    if isinstance(value, float) and value.is_integer():
        lens = int(value)
        return lens if lens in _ALLOWED_LENSES else None
    if isinstance(value, str):
        match = re.search(r"\d+", value)
        if not match:
            return None
        lens = int(match.group(0))
        return lens if lens in _ALLOWED_LENSES else None
    return None
