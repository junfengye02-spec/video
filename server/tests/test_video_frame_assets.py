from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from server.app.assets.service import MediaAssetRepository
from server.app.auth.models import User
from server.app.db.base import Base
from server.app.projects.models import ProjectRecord
from server.app.storage import WorkbenchStore


USER_ID = "f" * 32
PROJECT_ID = "10000000000040008000000000000001"


def _context(tmp_path):
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine, expire_on_commit=False)
    db.add(User(id=USER_ID, email="frames@example.com", password_hash="hash", role="user", status="active"))
    db.add(
        ProjectRecord(
            id=PROJECT_ID,
            owner_user_id=USER_ID,
            title="Frames",
            mode="short_drama",
            project_type="single_video",
        )
    )
    db.commit()
    store = WorkbenchStore(tmp_path / "projects")
    store._ensure_project_dirs(PROJECT_ID)
    return engine, db, store


def _frame(store, name: str) -> str:
    relative = f"assets/images/keyframes/{name}.png"
    path = store.project_dir(PROJECT_ID) / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"png")
    return relative


def test_video_tail_frame_asset_is_idempotent_and_exposes_provenance(tmp_path):
    engine, db, store = _context(tmp_path)
    repository = MediaAssetRepository(db, store)
    relative = _frame(store, "s1-v1-tail")

    first = repository.create_video_frame(
        owner_user_id=USER_ID,
        origin_project_id=PROJECT_ID,
        shot_id="s1",
        video_version=1,
        media_sha256="a" * 64,
        sample_time_seconds=4.9,
        storage_path=relative,
    )
    db.commit()
    second = repository.create_video_frame(
        owner_user_id=USER_ID,
        origin_project_id=PROJECT_ID,
        shot_id="s1",
        video_version=1,
        media_sha256="a" * 64,
        sample_time_seconds=4.9,
        storage_path=relative,
    )
    body = repository.serialize(second).model_dump(mode="json")

    assert second.id == first.id
    assert body["source_type"] == "video_frame"
    assert body["status"] == "ready"
    assert body["provenance"] == {
        "shot_id": "s1",
        "video_version": 1,
        "media_sha256": "a" * 64,
        "sample_time_seconds": 4.9,
    }
    db.close()
    engine.dispose()


def test_new_video_version_marks_old_tail_stale_without_deleting_media(tmp_path):
    engine, db, store = _context(tmp_path)
    repository = MediaAssetRepository(db, store)
    old_path = _frame(store, "s1-v1-tail")
    new_path = _frame(store, "s1-v2-tail")
    old = repository.create_video_frame(
        owner_user_id=USER_ID,
        origin_project_id=PROJECT_ID,
        shot_id="s1",
        video_version=1,
        media_sha256="a" * 64,
        sample_time_seconds=4.9,
        storage_path=old_path,
    )
    current = repository.create_video_frame(
        owner_user_id=USER_ID,
        origin_project_id=PROJECT_ID,
        shot_id="s1",
        video_version=2,
        media_sha256="b" * 64,
        sample_time_seconds=4.8,
        storage_path=new_path,
    )
    changed = repository.mark_video_frames_stale(
        origin_project_id=PROJECT_ID,
        shot_id="s1",
        current_video_version=2,
        current_media_sha256="b" * 64,
    )
    db.commit()

    assert changed == 1
    assert old.status == "stale"
    assert current.status == "ready"
    assert (store.project_dir(PROJECT_ID) / old_path).is_file()
    assert repository.serialize(old).status == "stale"
    db.close()
    engine.dispose()

