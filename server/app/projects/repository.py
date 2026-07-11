from __future__ import annotations

import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from server.app.projects.models import ProjectRecord


class ProjectRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(
        self,
        *,
        owner_user_id: str,
        title: str,
        mode: str,
        project_type: str,
    ) -> ProjectRecord:
        record = ProjectRecord(
            id=uuid.uuid4().hex,
            owner_user_id=owner_user_id,
            title=title,
            mode=mode,
            project_type=project_type,
        )
        self.db.add(record)
        self.db.flush()
        return record

    def list(self, owner_user_id: str) -> list[ProjectRecord]:
        return list(
            self.db.scalars(
                select(ProjectRecord)
                .where(ProjectRecord.owner_user_id == owner_user_id)
                .order_by(ProjectRecord.updated_at.desc(), ProjectRecord.id.desc())
            )
        )

    def get_owned(self, project_id: str, owner_user_id: str) -> ProjectRecord | None:
        return self.db.scalar(
            select(ProjectRecord).where(
                ProjectRecord.id == project_id,
                ProjectRecord.owner_user_id == owner_user_id,
            )
        )

    def get_owned_for_update(
        self,
        project_id: str,
        owner_user_id: str,
    ) -> ProjectRecord | None:
        return self.db.scalar(
            select(ProjectRecord)
            .where(
                ProjectRecord.id == project_id,
                ProjectRecord.owner_user_id == owner_user_id,
            )
            .with_for_update()
        )

    def require_owned(self, project_id: str, owner_user_id: str) -> ProjectRecord:
        project = self.get_owned(project_id, owner_user_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return project

    def require_owned_for_update(
        self,
        project_id: str,
        owner_user_id: str,
    ) -> ProjectRecord:
        project = self.get_owned_for_update(project_id, owner_user_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return project
