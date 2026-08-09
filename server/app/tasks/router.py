from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.db.session import get_db
from server.app.projects.repository import ProjectRepository
from server.app.tasks.schemas import (
    TaskAcceptedResponse,
    TaskBatchResponse,
    TaskListResponse,
    TaskSubmitRequest,
)
from server.app.tasks.service import TaskConflict, TaskNotFound, TaskService
from server.app.tasks.worker import TaskWorker


router = APIRouter(prefix="/api/projects/{project_id}/tasks", tags=["tasks"])


def get_task_worker(request: Request) -> TaskWorker:
    worker = getattr(request.app.state, "task_worker", None)
    if not isinstance(worker, TaskWorker):
        raise HTTPException(status_code=503, detail="Task worker is unavailable")
    return worker


@router.post("", status_code=202, response_model=TaskAcceptedResponse)
def submit_task(
    project_id: str,
    payload: TaskSubmitRequest,
    current: CurrentUser = Depends(require_csrf),
    db: Session = Depends(get_db),
    worker: TaskWorker = Depends(get_task_worker),
) -> TaskAcceptedResponse:
    ProjectRepository(db).require_owned_for_read(project_id, current.id)
    task_types = {payload.task_type} | {
        item.task_type for item in payload.items if item.task_type is not None
    }
    unsupported = sorted(
        task_type for task_type in task_types if not worker.supports(task_type)
    )
    if unsupported:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "task_type_unsupported",
                "task_types": unsupported,
            },
        )
    internal_only = sorted(
        task_type
        for task_type in task_types
        if not worker.supports_client_submission(task_type)
    )
    if internal_only:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "task_type_not_client_submittable",
                "task_types": internal_only,
            },
        )
    try:
        worker.validate_client_submission(payload)
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail={"code": "task_input_invalid"},
        ) from None
    service = TaskService(db, request_events(worker))
    try:
        batch, deduplicated = service.submit(
            owner_user_id=current.id,
            project_id=project_id,
            request=payload,
        )
    except TaskConflict as exc:
        status_code = 404 if exc.code == "billing_job_not_found" else 409
        raise HTTPException(
            status_code=status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from None
    worker.notify()
    task = service.batch_response(batch, include_items=True)
    return TaskAcceptedResponse(
        task_id=batch.id,
        status=batch.status,
        deduplicated=deduplicated,
        task=task,
    )


@router.get("", response_model=TaskListResponse)
def list_tasks(
    project_id: str,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    include_items: bool = False,
    current: CurrentUser = Depends(require_user),
    db: Session = Depends(get_db),
) -> TaskListResponse:
    ProjectRepository(db).require_owned_for_read(project_id, current.id)
    service = TaskService(db)
    return TaskListResponse(
        tasks=[
            service.batch_response(batch, include_items=include_items)
            for batch in service.list_owned(current.id, project_id, limit=limit)
        ]
    )


@router.get("/{task_id}", response_model=TaskBatchResponse)
def get_task(
    project_id: str,
    task_id: str,
    current: CurrentUser = Depends(require_user),
    db: Session = Depends(get_db),
) -> TaskBatchResponse:
    ProjectRepository(db).require_owned_for_read(project_id, current.id)
    service = TaskService(db)
    try:
        batch = service.require_owned_batch(task_id, current.id, project_id)
    except TaskNotFound:
        raise HTTPException(status_code=404, detail="Task not found") from None
    return service.batch_response(batch, include_items=True)


@router.post(
    "/{task_id}/items/{item_id}/retry",
    status_code=202,
    response_model=TaskBatchResponse,
)
def retry_task_item(
    project_id: str,
    task_id: str,
    item_id: str,
    current: CurrentUser = Depends(require_csrf),
    db: Session = Depends(get_db),
    worker: TaskWorker = Depends(get_task_worker),
) -> TaskBatchResponse:
    ProjectRepository(db).require_owned_for_read(project_id, current.id)
    service = TaskService(db, request_events(worker))
    try:
        service.retry_owned_item(
            batch_id=task_id,
            item_id=item_id,
            owner_user_id=current.id,
            project_id=project_id,
        )
        batch = service.require_owned_batch(task_id, current.id, project_id)
    except TaskNotFound:
        raise HTTPException(status_code=404, detail="Task not found") from None
    except TaskConflict as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": exc.code, "message": exc.message},
        ) from None
    worker.notify()
    return service.batch_response(batch, include_items=True)


def request_events(worker: TaskWorker):
    return worker.events
