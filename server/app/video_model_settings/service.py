from __future__ import annotations

import hashlib
import json
import math
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from server.app.auth.models import AdminAuditLog
from server.app.video_model_profiles import (
    VideoModelDurationConfiguration,
    VideoModelProfile,
    VideoOperation,
    video_model_profile,
)
from server.app.video_model_settings.models import VideoModelDurationSetting


class VideoModelDurationConflict(ValueError):
    def __init__(self, current_version: int | None):
        super().__init__("video model duration setting version conflict")
        self.current_version = current_version


BOOTSTRAP_VIDEO_MODEL_DURATIONS: tuple[tuple[str, str, float], ...] = (
    ("newapi", "omni_flash-10s", 10.0),
    ("newapi", "sora-2-12s", 12.0),
    ("newapi", "sora_2", 12.0),
    ("newapi", "sora_v2", 12.0),
    ("newapi", "sora_v2_pro", 12.0),
)


def bootstrap_verified_duration_settings(db: Session) -> None:
    existing = {
        (provider, model_id)
        for provider, model_id in db.execute(
            select(
                VideoModelDurationSetting.provider,
                VideoModelDurationSetting.model_id,
            )
        ).all()
    }
    now = datetime.now(timezone.utc)
    for provider, model_id, duration in BOOTSTRAP_VIDEO_MODEL_DURATIONS:
        if (provider, model_id) in existing:
            continue
        setting_id = hashlib.sha256(
            f"{provider}\0{model_id}".encode("utf-8")
        ).hexdigest()[:32]
        db.add(
            VideoModelDurationSetting(
                id=setting_id,
                provider=provider,
                model_id=model_id,
                call_duration_seconds=duration,
                version=1,
                updated_by=None,
                created_at=now,
                updated_at=now,
            )
        )
    db.flush()


def _configuration(
    setting: VideoModelDurationSetting,
) -> VideoModelDurationConfiguration:
    return VideoModelDurationConfiguration(
        provider=setting.provider,
        model_id=setting.model_id,
        call_duration_seconds=setting.call_duration_seconds,
        version=setting.version,
    )


def _setting_snapshot(setting: VideoModelDurationSetting) -> dict[str, object]:
    configuration = _configuration(setting)
    return {
        "provider": setting.provider,
        "model_id": setting.model_id,
        "call_duration_seconds": setting.call_duration_seconds,
        "version": setting.version,
        "profile_revision": video_model_profile(
            setting.model_id,
            "text_to_video",
            provider=setting.provider,
            duration_configuration=configuration,
        ).profile_revision,
        "updated_by": setting.updated_by,
        "updated_at": setting.updated_at.isoformat(),
    }


def _compact_json(value: dict[str, object]) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _audit_object_id(provider: str, model_id: str) -> str:
    return hashlib.sha256(f"{provider}\0{model_id}".encode("utf-8")).hexdigest()


class VideoModelDurationService:
    def __init__(self, db: Session):
        self.db = db

    def get(
        self,
        *,
        provider: str,
        model_id: str,
    ) -> VideoModelDurationSetting | None:
        return self.db.scalar(
            select(VideoModelDurationSetting)
            .where(
                VideoModelDurationSetting.provider == provider,
                VideoModelDurationSetting.model_id == model_id,
            )
            .execution_options(populate_existing=True)
        )

    def list(self, *, provider: str | None = None) -> list[VideoModelDurationSetting]:
        statement = select(VideoModelDurationSetting)
        if provider is not None:
            statement = statement.where(VideoModelDurationSetting.provider == provider)
        return list(
            self.db.scalars(
                statement.order_by(
                    VideoModelDurationSetting.provider,
                    VideoModelDurationSetting.model_id,
                )
            ).all()
        )

    def configuration(
        self,
        *,
        provider: str,
        model_id: str,
    ) -> VideoModelDurationConfiguration | None:
        setting = self.get(provider=provider, model_id=model_id)
        return None if setting is None else _configuration(setting)

    def configuration_map(
        self,
        *,
        provider: str | None = None,
    ) -> dict[tuple[str, str], VideoModelDurationConfiguration]:
        return {
            (setting.provider, setting.model_id): _configuration(setting)
            for setting in self.list(provider=provider)
        }

    def effective_profile(
        self,
        model_id: str,
        operation: VideoOperation,
        provider: str = "newapi",
    ) -> VideoModelProfile:
        return video_model_profile(
            model_id,
            operation,
            provider=provider,
            duration_configuration=self.configuration(
                provider=provider,
                model_id=model_id,
            ),
        )

    def effective_profile_revision(
        self,
        model_id: str,
        operation: VideoOperation,
        provider: str = "newapi",
    ) -> str:
        return self.effective_profile(model_id, operation, provider).profile_revision

    def update(
        self,
        *,
        provider: str,
        model_id: str,
        call_duration_seconds: float,
        expected_version: int,
        updated_by: str,
        reason: str,
    ) -> VideoModelDurationSetting:
        provider = provider.strip()
        model_id = model_id.strip()
        reason = reason.strip()
        if not provider or len(provider) > 64:
            raise ValueError("provider is invalid")
        if (
            not model_id
            or len(model_id) > 200
            or any(ord(char) < 32 for char in model_id)
        ):
            raise ValueError("model_id is invalid")
        if not reason or len(reason) > 500:
            raise ValueError("reason is invalid")
        if expected_version < 0:
            raise ValueError("expected_version must be non-negative")
        duration = float(call_duration_seconds)
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError("call_duration_seconds must be a finite positive number")

        existing = self.get(provider=provider, model_id=model_id)
        before = None if existing is None else _setting_snapshot(existing)
        now = datetime.now(timezone.utc)
        if existing is None:
            if expected_version != 0:
                raise VideoModelDurationConflict(None)
            setting = VideoModelDurationSetting(
                id=uuid.uuid4().hex,
                provider=provider,
                model_id=model_id,
                call_duration_seconds=duration,
                version=1,
                updated_by=updated_by,
                created_at=now,
                updated_at=now,
            )
            try:
                with self.db.begin_nested():
                    self.db.add(setting)
                    self.db.flush()
            except IntegrityError:
                current = self.get(provider=provider, model_id=model_id)
                raise VideoModelDurationConflict(
                    None if current is None else current.version
                ) from None
        else:
            if existing.version != expected_version:
                raise VideoModelDurationConflict(existing.version)
            result = self.db.execute(
                update(VideoModelDurationSetting)
                .where(
                    VideoModelDurationSetting.id == existing.id,
                    VideoModelDurationSetting.version == expected_version,
                )
                .values(
                    call_duration_seconds=duration,
                    version=expected_version + 1,
                    updated_by=updated_by,
                    updated_at=now,
                )
                .execution_options(synchronize_session=False)
            )
            if result.rowcount != 1:
                self.db.expire_all()
                current = self.get(provider=provider, model_id=model_id)
                raise VideoModelDurationConflict(
                    None if current is None else current.version
                )
            self.db.expire(existing)
            setting = self.get(provider=provider, model_id=model_id)
            if setting is None:
                raise VideoModelDurationConflict(None)

        after = {**_setting_snapshot(setting), "reason": reason}
        self.db.add(
            AdminAuditLog(
                id=uuid.uuid4().hex,
                admin_user_id=updated_by,
                action="video_model_duration.update",
                object_type="video_model_duration_setting",
                object_id=_audit_object_id(provider, model_id),
                before_json=None if before is None else _compact_json(before),
                after_json=_compact_json(after),
                ip_address=None,
            )
        )
        self.db.flush()
        return setting


__all__ = [
    "BOOTSTRAP_VIDEO_MODEL_DURATIONS",
    "VideoModelDurationConflict",
    "VideoModelDurationService",
    "bootstrap_verified_duration_settings",
]
