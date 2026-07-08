from __future__ import annotations

import mimetypes
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm"}
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_VIDEO_BYTES = 500 * 1024 * 1024


def safe_project_file(project_dir: Path, relative_path: str) -> Path:
    root = project_dir.resolve()
    candidate = (root / relative_path).resolve()
    if root != candidate and root not in candidate.parents:
        raise HTTPException(status_code=400, detail="Media path must stay inside the project directory")
    return candidate


def safe_project_media_file(project_dir: Path, relative_path: str) -> Path:
    candidate = safe_project_file(project_dir, relative_path)
    relative = candidate.relative_to(project_dir.resolve())
    parts = relative.parts
    suffix = candidate.suffix.lower()
    if parts[:1] == ("renders",) and len(parts) == 2 and candidate.stem == "final" and suffix in VIDEO_EXTENSIONS:
        return candidate
    if parts[:2] == ("assets", "images") and suffix in IMAGE_EXTENSIONS:
        return candidate
    if parts[:2] == ("assets", "video") and suffix in VIDEO_EXTENSIONS:
        return candidate
    raise HTTPException(status_code=404, detail="Media file not found")


def relative_project_path(project_dir: Path, file_path: str | Path) -> str:
    root = project_dir.resolve()
    candidate = Path(file_path)
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = candidate.resolve()
    if root != candidate and root not in candidate.parents:
        raise HTTPException(status_code=400, detail="Media path must stay inside the project directory")
    return candidate.relative_to(root).as_posix()


def media_content_type(path: Path) -> str:
    content_type, _ = mimetypes.guess_type(path.name)
    return content_type or "application/octet-stream"


def media_download_url(project_id: str, relative_path: str) -> str:
    encoded = quote(relative_path.replace("\\", "/"), safe="/")
    return f"/api/projects/{project_id}/media/{encoded}"


def safe_project_media_destination(project_dir: Path, relative_dir: str | Path, filename: str) -> Path:
    base_dir = (project_dir / relative_dir).resolve()
    destination = (base_dir / filename).resolve()
    if destination.parent != base_dir:
        raise HTTPException(status_code=400, detail="Media path must stay inside the project directory")
    return destination


def validate_upload_extension(filename: str, allowed_extensions: set[str]) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix not in allowed_extensions:
        allowed = ", ".join(sorted(allowed_extensions))
        raise HTTPException(status_code=415, detail=f"Unsupported media type. Allowed extensions: {allowed}")
    return suffix


async def save_upload_file(upload: object, destination: Path, max_bytes: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with destination.open("wb") as handle:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                destination.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="Uploaded media is too large")
            handle.write(chunk)
    await upload.close()
