from __future__ import annotations

from sqlalchemy import ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from server.app.db.base import Base, TimestampMixin


class ProjectRecord(TimestampMixin, Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_user_id: Mapped[str | None] = mapped_column(
        String(32),
        ForeignKey("users.id"),
        nullable=False,
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    mode: Mapped[str] = mapped_column(String(32), nullable=False)
    project_type: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        Index("ix_projects_owner_user_id", "owner_user_id"),
    )
