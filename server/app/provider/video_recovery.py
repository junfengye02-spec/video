from __future__ import annotations

import hashlib
import shutil
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from sqlalchemy.orm import Session

from server.app.billing.models import GenerationJob
from server.app.billing.service import BillingService, InvalidBillingState
from server.app.core.config import get_settings
from server.app.provider.newapi import NewApiClient
from server.app.storage import WorkbenchStore
from tools.video._shared import probe_output


class InvalidVideoArtifact(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class VideoJobSnapshot:
    id: str
    token_alias: str
    provider_reference_id: str
    project_id: str
    operation: str
    result_staged: bool


def _snapshot_video_job(db: Session, job_id: str) -> VideoJobSnapshot:
    job = db.get(GenerationJob, job_id)
    if (
        job is None
        or not job.chargeable
        or job.capability != "video"
        or job.token_alias is None
        or job.provider_reference_type != "task"
        or job.provider_reference_id is None
    ):
        db.rollback()
        raise InvalidBillingState("video recovery job is invalid")
    snapshot = VideoJobSnapshot(
        id=job.id,
        token_alias=job.token_alias,
        provider_reference_id=job.provider_reference_id,
        project_id=job.project_id,
        operation=job.operation,
        result_staged=job.result_staged,
    )
    db.commit()
    return snapshot


def _sha256_file(path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_video(path) -> None:
    metadata = probe_output(path)
    if not isinstance(metadata, dict) or metadata.get("file_size_bytes", 0) <= 0:
        raise InvalidVideoArtifact("downloaded video is empty or invalid")
    if shutil.which("ffprobe") and metadata.get("video_width", 0) <= 0:
        raise InvalidVideoArtifact("downloaded content is not a valid video")


def resume_billed_video_job(
    db: Session,
    client: NewApiClient,
    job_id: str,
    media_store: WorkbenchStore,
    *,
    settings=None,
) -> Literal["pending", "completed", "failed"]:
    settings = settings or get_settings()
    snapshot = _snapshot_video_job(db, job_id)
    if snapshot.result_staged:
        return "completed"

    task = client.get_video_task(
        snapshot.token_alias,
        snapshot.provider_reference_id,
    )
    if task.status in {"queued", "in_progress", "unknown"}:
        return "pending"
    if task.status == "failed":
        return "failed"
    if task.status != "completed":
        raise InvalidVideoArtifact("provider returned an invalid video task status")

    with media_store.hidden_video_destination(
        snapshot.project_id, snapshot.operation
    ) as destination:
        client.download_video_content(
            snapshot.token_alias,
            snapshot.provider_reference_id,
            destination.temporary_path,
        )
        _verify_video(destination.temporary_path)
        artifact = destination.commit(
            sha256=_sha256_file(destination.temporary_path),
            source_reference=snapshot.provider_reference_id,
        )
    BillingService(
        db,
        settings,
        media_store.inspect_staged_artifact,
    ).stage_result(snapshot.id, artifact.locator, artifact.sha256)
    return "completed"


def recover_provider_reference(
    db: Session,
    client: NewApiClient,
    job_id: str,
    now: datetime,
    *,
    settings=None,
):
    from server.app.billing.reconciliation import recover_provider_reference as recover

    return recover(db, client, job_id, now, settings=settings)
