from __future__ import annotations

from sqlalchemy import (
    CheckConstraint,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from server.app.db.base import Base, TimestampMixin


class VideoModelDurationSetting(TimestampMixin, Base):
    __tablename__ = "video_model_duration_settings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    model_id: Mapped[str] = mapped_column(String(200), nullable=False)
    call_duration_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    updated_by: Mapped[str | None] = mapped_column(
        String(32),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    __table_args__ = (
        UniqueConstraint(
            "provider",
            "model_id",
            name="uq_video_model_duration_settings_provider_model",
        ),
        CheckConstraint(
            "call_duration_seconds > 0",
            name="ck_video_model_duration_settings_positive_duration",
        ),
        CheckConstraint(
            "version >= 1",
            name="ck_video_model_duration_settings_version",
        ),
    )
