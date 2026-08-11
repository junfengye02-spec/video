from __future__ import annotations

import os
from pathlib import Path


def _positive_int_env(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = ROOT_DIR / "workbench.sqlite3"
DEFAULT_PROJECTS_ROOT = ROOT_DIR / "projects"
DEFAULT_SYAPI_BASE_URL = "https://api.0000238.xyz"
MEDIA_RETENTION_HOURS = _positive_int_env("MEDIA_RETENTION_HOURS", 24)
MEDIA_CLEANUP_INTERVAL_SECONDS = _positive_int_env(
    "MEDIA_CLEANUP_INTERVAL_SECONDS", 60 * 60
)
PUBLIC_DISABLE_GLOBAL_LATEST = True
