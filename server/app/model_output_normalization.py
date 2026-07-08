from __future__ import annotations

import re
from typing import Any

from server.app.models import ShotLanguage

_ALLOWED_LENSES = {14, 24, 35, 50, 85, 135, 200}


def normalize_shot_language(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    cleaned = {key: item for key, item in value.items() if item not in ("", None)}
    lens_mm = _normalize_lens_mm(cleaned.get("lens_mm"))
    if lens_mm is None:
        cleaned.pop("lens_mm", None)
    else:
        cleaned["lens_mm"] = lens_mm
    try:
        normalized = ShotLanguage(**cleaned)
    except Exception:
        return None
    payload = normalized.model_dump(exclude_none=True)
    return payload or None


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
