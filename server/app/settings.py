from __future__ import annotations

from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_DB_PATH = ROOT_DIR / "workbench.sqlite3"
DEFAULT_PROJECTS_ROOT = ROOT_DIR / "projects"
DEFAULT_SYAPI_BASE_URL = "https://api.0000238.xyz"
MEDIA_RETENTION_DAYS = 3
PUBLIC_DISABLE_GLOBAL_LATEST = True
