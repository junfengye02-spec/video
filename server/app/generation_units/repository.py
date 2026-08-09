from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from server.app.generation_units.models import VideoGenerationUnit


PROTECTED_UNIT_STATUSES = ("queued", "running", "waiting_provider", "complete")


class GenerationUnitRepository:
    def __init__(self, db: Session):
        self.db = db

    def count_project(self, project_id: str) -> int:
        return int(
            self.db.scalar(
                select(func.count())
                .select_from(VideoGenerationUnit)
                .where(VideoGenerationUnit.project_id == project_id)
            )
            or 0
        )

    def list_project(self, project_id: str) -> list[VideoGenerationUnit]:
        return list(
            self.db.scalars(
                select(VideoGenerationUnit)
                .where(VideoGenerationUnit.project_id == project_id)
                .order_by(
                    VideoGenerationUnit.created_at,
                    VideoGenerationUnit.id,
                    VideoGenerationUnit.revision,
                )
            )
        )

    def list_protected(self, project_id: str) -> list[VideoGenerationUnit]:
        return list(
            self.db.scalars(
                select(VideoGenerationUnit)
                .where(
                    VideoGenerationUnit.project_id == project_id,
                    VideoGenerationUnit.status.in_(PROTECTED_UNIT_STATUSES),
                )
                .order_by(
                    VideoGenerationUnit.created_at,
                    VideoGenerationUnit.id,
                    VideoGenerationUnit.revision,
                )
            )
        )

    def list_active(self, project_id: str) -> list[VideoGenerationUnit]:
        return list(
            self.db.scalars(
                select(VideoGenerationUnit)
                .where(
                    VideoGenerationUnit.project_id == project_id,
                    VideoGenerationUnit.active.is_(True),
                )
                .order_by(
                    VideoGenerationUnit.created_at,
                    VideoGenerationUnit.id,
                    VideoGenerationUnit.revision,
                )
            )
        )

    def get(
        self, project_id: str, unit_id: str, revision: int
    ) -> VideoGenerationUnit | None:
        return self.db.get(VideoGenerationUnit, (project_id, unit_id, revision))

    def list_by_keys(
        self, project_id: str, keys: Sequence[tuple[str, int]]
    ) -> list[VideoGenerationUnit]:
        if not keys:
            return []
        requested = set(keys)
        return [
            unit
            for unit in self.db.scalars(
                select(VideoGenerationUnit).where(
                    VideoGenerationUnit.project_id == project_id,
                    VideoGenerationUnit.id.in_([unit_id for unit_id, _ in keys]),
                )
            )
            if (unit.id, unit.revision) in requested
        ]

    def add(self, unit: VideoGenerationUnit) -> VideoGenerationUnit:
        self.db.add(unit)
        return unit
