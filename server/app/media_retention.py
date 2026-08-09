from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from server.app.settings import MEDIA_RETENTION_DAYS


TRANSIENT_ROOTS = (
    Path(".billing-results"),
    Path("assets/video/.hidden"),
)
_TRANSIENT_JOB_ID = re.compile(r"^[0-9a-f]{32}$")


def _is_under(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def cleanup_expired_media(
    projects_root: Path,
    now: datetime | None = None,
    retention: timedelta | None = None,
) -> list[Path]:
    current = now or datetime.now(timezone.utc)
    max_age = retention or timedelta(days=MEDIA_RETENTION_DAYS)
    cutoff = current.timestamp() - max_age.total_seconds()
    root = projects_root.resolve(strict=False)
    deleted: list[Path] = []

    if not root.exists():
        return deleted

    for project_dir in root.iterdir():
        resolved_project_dir = project_dir.resolve(strict=False)
        if not project_dir.is_dir() or not _is_under(resolved_project_dir, root):
            continue

        for transient_root_name in TRANSIENT_ROOTS:
            transient_root = (project_dir / transient_root_name).resolve(strict=False)
            if not _is_under(transient_root, resolved_project_dir):
                continue
            if transient_root.is_symlink() or not transient_root.is_dir():
                continue

            for job_dir in transient_root.iterdir():
                if (
                    _TRANSIENT_JOB_ID.fullmatch(job_dir.name) is None
                    or job_dir.is_symlink()
                    or not job_dir.is_dir()
                ):
                    continue
                resolved_job_dir = job_dir.resolve(strict=False)
                if not _is_under(resolved_job_dir, transient_root):
                    continue

                for path in job_dir.rglob("*"):
                    resolved_path = path.resolve(strict=False)
                    if (
                        path.is_symlink()
                        or not path.is_file()
                        or not _is_under(resolved_path, resolved_job_dir)
                    ):
                        continue
                    if path.stat().st_mtime >= cutoff:
                        continue
                    path.unlink()
                    deleted.append(path)

    return deleted
