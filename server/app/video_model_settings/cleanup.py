from __future__ import annotations

from typing import Protocol

from sqlalchemy.orm import Session

from server.app.video_model_settings.service import VideoModelDurationService


class VideoModelCatalog(Protocol):
    def list_models(self, kind: str) -> list[str]: ...


def delete_missing_video_model_settings(
    db: Session,
    newapi: VideoModelCatalog,
) -> list[str]:
    catalog_ids = set(newapi.list_models("video"))
    deleted = _delete_missing_video_model_settings(db, catalog_ids)
    db.commit()
    return deleted


def _delete_missing_video_model_settings(
    db: Session,
    catalog_ids: set[str],
) -> list[str]:
    service = VideoModelDurationService(db)
    deleted: list[str] = []
    for setting in service.list(provider="newapi"):
        if setting.model_id in catalog_ids:
            continue
        service.delete(
            provider=setting.provider,
            model_id=setting.model_id,
            expected_version=setting.version,
            updated_by=None,
            reason="automatic cleanup: model missing from NewAPI catalog",
        )
        deleted.append(setting.model_id)
    return deleted


def synchronize_video_model_settings(
    db: Session,
    newapi: VideoModelCatalog,
) -> list[str]:
    catalog_ids = set(newapi.list_models("video"))
    deleted = _delete_missing_video_model_settings(db, catalog_ids)
    from server.app.video_model_settings.service import (
        bootstrap_verified_duration_settings,
    )

    bootstrap_verified_duration_settings(db, catalog_ids=catalog_ids)
    db.commit()
    return deleted
