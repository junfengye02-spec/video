from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from server.app.media_retention import cleanup_expired_media


NOW = datetime(2026, 7, 8, tzinfo=UTC)
OLD_TIME = datetime(2026, 7, 1, tzinfo=UTC).timestamp()
FRESH_TIME = datetime(2026, 7, 8, tzinfo=UTC).timestamp()
RETENTION = timedelta(days=1)


def _write_file(path: Path, data: bytes = b"media") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _set_mtime(path: Path, timestamp: float) -> None:
    os.utime(path, (timestamp, timestamp))


def _link_directory(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except (NotImplementedError, OSError) as exc:
        if os.name != "nt":
            pytest.skip(f"directory symlinks are not available: {exc}")

    import subprocess

    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"directory links are not available: {result.stderr or result.stdout}")


def test_cleanup_deletes_expired_project_videos_and_preserves_non_video_assets(tmp_path):
    projects_root = tmp_path / "projects"
    project = projects_root / "p1"
    old_image = _write_file(project / "assets" / "images" / "character" / "lin.png")
    old_video = _write_file(project / "assets" / "video" / "shot.mp4")
    old_audio = _write_file(project / "assets" / "audio" / "voice.wav")
    old_render = _write_file(project / "renders" / "final.mp4")
    hidden_video = _write_file(
        project / "assets" / "video" / ".hidden" / ("a" * 32) / "video.mp4"
    )
    hidden_provider_result = _write_file(
        project / ".billing-results" / ("b" * 32) / "response.bin"
    )
    video_intent = _write_file(
        project / ".billing-results" / "video-intents" / f"{'c' * 32}.json",
        b"{}",
    )
    fresh_video = _write_file(project / "assets" / "video" / "fresh.mp4")
    artifact = _write_file(project / "artifacts" / "episode_storyboard.json", b"{}")
    outside_media_dir = _write_file(project / "assets" / "documents" / "notes.mp4")
    video_metadata = _write_file(project / "assets" / "video" / "manifest.json", b"{}")

    for path in [
        old_image,
        old_video,
        old_audio,
        old_render,
        hidden_video,
        hidden_provider_result,
        video_intent,
        artifact,
        outside_media_dir,
        video_metadata,
    ]:
        _set_mtime(path, OLD_TIME)
    _set_mtime(fresh_video, FRESH_TIME)

    deleted = cleanup_expired_media(projects_root, now=NOW, retention=RETENTION)

    assert set(deleted) == {
        old_video,
        old_render,
        hidden_video,
        hidden_provider_result,
    }
    for path in [
        old_image,
        old_audio,
        fresh_video,
        artifact,
        outside_media_dir,
        video_intent,
        video_metadata,
    ]:
        assert path.exists()


def test_repeated_cleanup_is_idempotent_and_keeps_non_video_media(tmp_path):
    projects_root = tmp_path / "projects"
    project = projects_root / "p1"
    durable_files = [
        _write_file(project / "assets" / "images" / "generated" / "old.png"),
        _write_file(project / "assets" / "audio" / "voice.wav"),
    ]
    expired_videos = [
        _write_file(project / "assets" / "video" / "shot.mp4"),
        _write_file(project / "renders" / "final.mp4"),
    ]
    for path in [*durable_files, *expired_videos]:
        _set_mtime(path, OLD_TIME)

    assert set(cleanup_expired_media(projects_root, now=NOW, retention=RETENTION)) == set(
        expired_videos
    )
    assert cleanup_expired_media(projects_root, now=NOW, retention=RETENTION) == []
    assert all(path.exists() for path in durable_files)
    assert all(not path.exists() for path in expired_videos)


def test_default_retention_is_twenty_four_hours(tmp_path, monkeypatch):
    projects_root = tmp_path / "projects"
    project = projects_root / "p1"
    expired = _write_file(project / "assets" / "video" / "expired.mp4")
    fresh = _write_file(project / "renders" / "fresh.mp4")
    monkeypatch.setattr(
        "server.app.media_retention.MEDIA_RETENTION_HOURS",
        24,
    )
    _set_mtime(expired, (NOW - timedelta(hours=25)).timestamp())
    _set_mtime(fresh, (NOW - timedelta(hours=23)).timestamp())

    assert cleanup_expired_media(projects_root, now=NOW) == [expired]
    assert fresh.exists()


def test_cleanup_does_not_follow_project_symlink_outside_projects_root(tmp_path):
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    outside_project = tmp_path / "outside-project"
    outside_video = _write_file(outside_project / "assets" / "video" / "escape.mp4")
    _set_mtime(outside_video, OLD_TIME)

    linked_project = projects_root / "linked"
    _link_directory(linked_project, outside_project)

    deleted = cleanup_expired_media(projects_root, now=NOW, retention=RETENTION)

    assert deleted == []
    assert outside_video.exists()
