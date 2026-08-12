from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from server.app.auth.models import User
from server.app.db.base import Base
from server.app.video_model_settings.cleanup import (
    delete_missing_video_model_settings,
    synchronize_video_model_settings,
)
from server.app.video_model_settings.service import (
    VideoModelDurationService,
    bootstrap_verified_duration_settings,
)


class Catalog:
    def list_models(self, kind: str) -> list[str]:
        assert kind == "video"
        return ["omni_flash-10s", "sora_2"]


def test_daily_cleanup_deletes_only_settings_missing_from_catalog():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        db.add(
            User(
                id="cleanup-admin-000000000000000",
                email="cleanup@example.com",
                password_hash="hash",
                role="admin",
                status="active",
            )
        )
        bootstrap_verified_duration_settings(db)
        db.commit()

        deleted = delete_missing_video_model_settings(db, Catalog())

        assert set(deleted) == {"sora-2-12s", "sora_v2", "sora_v2_pro"}
        remaining = {
            setting.model_id
            for setting in VideoModelDurationService(db).list(provider="newapi")
        }
        assert remaining == {"omni_flash-10s", "sora_2"}
    engine.dispose()


def test_daily_synchronization_does_not_recreate_deleted_missing_bootstrap_models():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        db.add(
            User(
                id="sync-admin-0000000000000000000",
                email="sync@example.com",
                password_hash="hash",
                role="admin",
                status="active",
            )
        )
        bootstrap_verified_duration_settings(db)
        db.commit()

        first = synchronize_video_model_settings(db, Catalog())
        second = synchronize_video_model_settings(db, Catalog())

        assert set(first) == {"sora-2-12s", "sora_v2", "sora_v2_pro"}
        assert second == []
        assert {
            setting.model_id
            for setting in VideoModelDurationService(db).list(provider="newapi")
        } == {"omni_flash-10s", "sora_2"}
    engine.dispose()
