from __future__ import annotations

import subprocess

import pytest
from PIL import Image
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from server.app.assets.models import MediaAsset
from server.app.auth.models import User
from server.app.db.base import Base
from server.app.keyframe_service import ensure_shot_tail_frame
from server.app.projects.models import ProjectRecord
from server.app.storage import WorkbenchStore
from tools.base_tool import resolve_command_path


USER_ID = "e" * 32
PROJECT_ID = "10000000000040008000000000000002"


def _write_video(path, color):
    ffmpeg = resolve_command_path("ffmpeg")
    if ffmpeg is None:
        pytest.skip("ffmpeg is unavailable")
    frames = path.parent / f"{path.stem}-frames"
    frames.mkdir(parents=True, exist_ok=True)
    for index in range(5):
        Image.new("RGB", (64, 48), color).save(frames / f"{index:02d}.png")
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-framerate",
            "5",
            "-i",
            str(frames / "%02d.png"),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _context(tmp_path):
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine, expire_on_commit=False)
    db.add(User(id=USER_ID, email="tail@example.com", password_hash="hash", role="user", status="active"))
    db.add(
        ProjectRecord(
            id=PROJECT_ID,
            owner_user_id=USER_ID,
            title="Tail",
            mode="short_drama",
            project_type="single_video",
        )
    )
    db.commit()
    store = WorkbenchStore(tmp_path / "projects")
    store._ensure_project_dirs(PROJECT_ID)
    video = store.project_dir(PROJECT_ID) / "assets" / "video" / "s1.mp4"
    _write_video(video, (220, 20, 20))
    store.write_artifact(
        PROJECT_ID,
        "episode_storyboard.json",
        {
            "shots": [
                {
                    "id": "s1",
                    "index": 1,
                    "version": 1,
                    "status": "complete",
                    "output_path": "assets/video/s1.mp4",
                    "continuity": {"mode": "carry", "inherit_previous_tail": True},
                },
                {
                    "id": "s2",
                    "index": 2,
                    "version": 1,
                    "status": "ready",
                    "continuity": {"mode": "carry", "inherit_previous_tail": True},
                },
            ]
        },
    )
    store.write_artifact(PROJECT_ID, "series_bible.json", {"assets": [], "characters": []})
    store.write_artifact(
        PROJECT_ID,
        "asset_manifest.json",
        {"version": "1.0", "assets": [{"id": "s1-video", "duration_seconds": 5}]},
    )
    store.write_artifact(
        PROJECT_ID,
        "edit_decisions.json",
        {
            "version": "1.0",
            "render_runtime": "ffmpeg",
            "cuts": [{
                "id": "cut-s1",
                "source": "s1-video",
                "in_seconds": 0,
                "out_seconds": 5,
                "timeline_duration_seconds": 5,
            }],
        },
    )
    store.write_artifact(
        PROJECT_ID,
        "generation_plan.json",
        {
            "generation_units": [{
                "shot_ids": ["s1"],
                "requested_duration_seconds": 10,
                "source_duration_seconds": None,
                "timeline_duration_seconds": 10,
            }],
        },
    )
    store.write_asset_library(PROJECT_ID, [])
    return engine, db, store, video


def test_completed_video_gets_free_tail_asset_and_next_shot_inherits_it(tmp_path):
    engine, db, store, _video = _context(tmp_path)

    binding = ensure_shot_tail_frame(
        db=db,
        media_store=store,
        owner_user_id=USER_ID,
        project_id=PROJECT_ID,
        shot_id="s1",
    )
    storyboard = store.read_artifact(PROJECT_ID, "episode_storyboard.json")
    first, second = storyboard["shots"]

    assert binding.provider_cost_units == 0
    assert first["continuity"]["last_frame_asset_id"] == binding.asset_id
    assert first["continuity"]["last_frame"]["source"] == "video_extract"
    assert second["continuity"]["inherited_first_frame_asset_id"] == binding.asset_id
    assert second["continuity"]["first_frame"]["source"] == "inherited"
    assert store.read_asset_library(PROJECT_ID)[0]["id"] == binding.asset_id
    assert first["requested_duration_seconds"] == 10
    assert first["source_duration_seconds"] == pytest.approx(1, abs=0.05)
    assert first["timeline_duration_seconds"] == first["source_duration_seconds"]
    manifest_asset = store.read_artifact(PROJECT_ID, "asset_manifest.json")["assets"][0]
    assert manifest_asset["source_duration_seconds"] == first["source_duration_seconds"]
    cut = store.read_artifact(PROJECT_ID, "edit_decisions.json")["cuts"][0]
    assert cut["duration_policy"] == "full_source"
    assert cut["source_out_seconds"] == first["source_duration_seconds"]
    assert cut["timeline_duration_seconds"] == first["source_duration_seconds"]
    assert cut["timeline_replanned_from_legacy"] is True
    db.close()
    engine.dispose()


def test_repeated_extract_is_idempotent_and_replacement_stales_old_binding(tmp_path):
    engine, db, store, video = _context(tmp_path)
    first = ensure_shot_tail_frame(
        db=db,
        media_store=store,
        owner_user_id=USER_ID,
        project_id=PROJECT_ID,
        shot_id="s1",
    )
    repeat = ensure_shot_tail_frame(
        db=db,
        media_store=store,
        owner_user_id=USER_ID,
        project_id=PROJECT_ID,
        shot_id="s1",
    )
    old_path = store.project_dir(PROJECT_ID) / first.path
    _write_video(video, (20, 40, 220))
    replacement = ensure_shot_tail_frame(
        db=db,
        media_store=store,
        owner_user_id=USER_ID,
        project_id=PROJECT_ID,
        shot_id="s1",
    )
    assets = list(db.scalars(select(MediaAsset).where(MediaAsset.source_type == "video_frame")))
    storyboard = store.read_artifact(PROJECT_ID, "episode_storyboard.json")

    assert repeat.asset_id == first.asset_id
    assert repeat.reused is True
    assert replacement.asset_id != first.asset_id
    assert {asset.id: asset.status for asset in assets} == {
        first.asset_id: "stale",
        replacement.asset_id: "ready",
    }
    assert old_path.is_file()
    assert storyboard["shots"][1]["continuity"]["first_frame"]["status"] == "stale"
    db.close()
    engine.dispose()
