from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from server.app.settings import MEDIA_RETENTION_HOURS


VIDEO_ROOTS = (
    Path("assets/video"),
    Path("renders"),
)
TRANSIENT_JOB_ROOTS = (
    Path(".billing-results"),
    Path("assets/video/.hidden"),
)
VIDEO_SUFFIXES = frozenset({".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"})
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
    max_age = retention or timedelta(hours=MEDIA_RETENTION_HOURS)
    cutoff = current.timestamp() - max_age.total_seconds()
    root = projects_root.resolve(strict=False)
    deleted: list[Path] = []

    if not root.exists():
        return deleted

    for project_dir in root.iterdir():
        resolved_project_dir = project_dir.resolve(strict=False)
        if not project_dir.is_dir() or not _is_under(resolved_project_dir, root):
            continue

        for video_root_name in VIDEO_ROOTS:
            video_root = (project_dir / video_root_name).resolve(strict=False)
            if not _is_under(video_root, resolved_project_dir):
                continue
            if video_root.is_symlink() or not video_root.is_dir():
                continue
            for path in video_root.rglob("*"):
                if path.suffix.lower() not in VIDEO_SUFFIXES:
                    continue
                _delete_expired_file(
                    path,
                    allowed_root=video_root,
                    cutoff=cutoff,
                    deleted=deleted,
                )

        for transient_root_name in TRANSIENT_JOB_ROOTS:
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
                    _delete_expired_file(
                        path,
                        allowed_root=resolved_job_dir,
                        cutoff=cutoff,
                        deleted=deleted,
                    )

    return deleted


def _delete_expired_file(
    path: Path,
    *,
    allowed_root: Path,
    cutoff: float,
    deleted: list[Path],
) -> None:
    if path.is_symlink() or not path.is_file():
        return
    resolved_path = path.resolve(strict=False)
    if not _is_under(resolved_path, allowed_root):
        return
    if path.stat().st_mtime >= cutoff:
        return
    path.unlink()
    deleted.append(path)
