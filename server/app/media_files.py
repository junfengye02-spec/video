from __future__ import annotations

import mimetypes
import os
import shutil
import stat
import tempfile
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
    try:
        descriptor, temporary, expected_parent = create_atomic_output(
            destination,
            suffix=".upload",
        )
    except BaseException:
        try:
            await upload.close()
        except BaseException:
            pass
        raise
    total = 0
    close_attempted = False
    error_raised = False
    try:
        with os.fdopen(descriptor, "wb") as handle:
            while True:
                chunk = await upload.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(status_code=413, detail="Uploaded media is too large")
                handle.write(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        close_attempted = True
        await upload.close()
        replace_atomic_output(temporary, destination, expected_parent)
    except BaseException:
        error_raised = True
        raise
    finally:
        try:
            if not close_attempted:
                close_attempted = True
                await upload.close()
        except BaseException:
            if not error_raised:
                raise
        finally:
            temporary.unlink(missing_ok=True)


def copy_media_file_atomic(source: Path, destination: Path) -> None:
    source_parent = source.parent.resolve(strict=True)
    _validate_atomic_path(source, source_parent, require_exists=True)
    descriptor, temporary, expected_parent = create_atomic_output(
        destination,
        suffix=".copy",
    )
    try:
        with source.open("rb") as reader, os.fdopen(descriptor, "wb") as writer:
            shutil.copyfileobj(reader, writer, length=1024 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
        replace_atomic_output(temporary, destination, expected_parent)
    finally:
        temporary.unlink(missing_ok=True)


def create_atomic_output(destination: Path, *, suffix: str) -> tuple[int, Path, Path]:
    parent = destination.parent
    expected_parent = _ensure_unaliased_directory(parent)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=suffix,
        dir=parent,
    )
    return descriptor, Path(temporary_name), expected_parent


def replace_atomic_output(
    temporary: Path,
    destination: Path,
    expected_parent: Path,
) -> None:
    _validate_atomic_path(temporary, expected_parent, require_exists=True)
    _validate_atomic_path(destination, expected_parent, require_exists=False)
    os.replace(temporary, destination)


def atomic_write_text(destination: Path, content: str, *, encoding: str = "utf-8") -> None:
    descriptor, temporary, expected_parent = create_atomic_output(
        destination,
        suffix=".write",
    )
    try:
        with os.fdopen(descriptor, "w", encoding=encoding) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        replace_atomic_output(temporary, destination, expected_parent)
    finally:
        temporary.unlink(missing_ok=True)


def _validate_atomic_path(path: Path, expected_parent: Path, *, require_exists: bool) -> None:
    parent = path.parent
    if _is_link_or_junction(parent) or not parent.is_dir():
        raise ValueError("Project workspace path is invalid")
    if parent.resolve(strict=True) != expected_parent:
        raise ValueError("Project workspace path is invalid")
    if _is_link_or_junction(path):
        raise ValueError("Project workspace path is invalid")
    try:
        path_stat = path.stat(follow_symlinks=False)
    except FileNotFoundError:
        if require_exists:
            raise ValueError("Project workspace path is invalid") from None
        return
    if not stat.S_ISREG(path_stat.st_mode) or path_stat.st_nlink != 1:
        raise ValueError("Project workspace path is invalid")


def _is_link_or_junction(path: Path) -> bool:
    return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())


def _ensure_unaliased_directory(directory: Path) -> Path:
    missing: list[Path] = []
    existing = directory
    while not existing.exists():
        if _is_link_or_junction(existing) or existing.parent == existing:
            raise ValueError("Project workspace path is invalid")
        missing.append(existing)
        existing = existing.parent

    _validate_unaliased_directory(existing)
    for path in reversed(missing):
        _validate_unaliased_directory(path.parent)
        path.mkdir()
        _validate_unaliased_directory(path)
    return directory.resolve(strict=True)


def _validate_unaliased_directory(directory: Path) -> None:
    if _is_link_or_junction(directory) or not directory.is_dir():
        raise ValueError("Project workspace path is invalid")
    if not _same_path(directory, directory.resolve(strict=True)):
        raise ValueError("Project workspace path is invalid")


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))
