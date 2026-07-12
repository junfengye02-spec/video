from __future__ import annotations

import hashlib
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from time import monotonic
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from server.app.billing.lease import (
    FencedReconciliationClaim,
    ReconciliationClaimLost,
    claim_reconciliation,
    heartbeat_claim,
    reschedule_claim,
)
from server.app.billing.models import GenerationJob
from server.app.billing.service import BillingService, InvalidBillingState
from server.app.core.config import get_settings
from server.app.projects.models import ProjectRecord
from server.app.provider.newapi import NewApiClient
from server.app.storage import WorkbenchStore
from tools.video._shared import probe_output


class InvalidVideoArtifact(RuntimeError):
    pass


class _StaleVideoPublication(RuntimeError):
    pass


_SHOT_OPERATION = re.compile(r"^shot:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$")
_RECOVERY_LEASE_SECONDS = 300
_HEARTBEAT_SECONDS = 30
_PENDING_CHILD_STATUSES = {
    "reserved",
    "submitted_ambiguous",
    "reference_recovery_pending",
    "receipt_pending",
    "result_pending",
    "payment_required",
    "payment_required_quote",
}


class _ClaimHeartbeat:
    def __init__(self, db: Session, claim: FencedReconciliationClaim) -> None:
        self.db = db
        self.claim = claim
        self.last_heartbeat = monotonic()

    def __call__(self, *, force: bool = False) -> None:
        now = monotonic()
        if not force and now - self.last_heartbeat < _HEARTBEAT_SECONDS:
            return
        if not heartbeat_claim(
            self.db,
            self.claim,
            lease_seconds=_RECOVERY_LEASE_SECONDS,
        ):
            raise ReconciliationClaimLost(
                "video reconciliation ownership was lost"
            )
        self.last_heartbeat = now


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


def _recompute_parent_status(
    db: Session,
    parent_job_id: str | None,
    media_store: WorkbenchStore,
    storyboard: dict,
) -> None:
    if parent_job_id is None:
        return
    parent = db.scalar(
        select(GenerationJob)
        .where(GenerationJob.id == parent_job_id)
        .with_for_update()
    )
    if parent is None or parent.chargeable:
        raise InvalidBillingState("video publication parent is invalid")
    children = db.scalars(
        select(GenerationJob)
        .where(GenerationJob.parent_job_id == parent_job_id)
        .with_for_update()
    ).all()
    if any(child.status in _PENDING_CHILD_STATUSES for child in children):
        parent.status = "running"
        return
    shots = {
        str(shot.get("id")): shot
        for shot in storyboard.get("shots", [])
        if isinstance(shot, dict)
    }
    stale_or_failed = any(child.status != "billed" for child in children)
    for child in children:
        operation = _SHOT_OPERATION.fullmatch(child.operation)
        if child.status != "billed" or operation is None:
            continue
        try:
            intent = media_store.read_video_generation_intent(
                child.project_id, child.id
            )
        except ValueError:
            stale_or_failed = True
            continue
        shot = shots.get(operation.group(1))
        if shot is None or intent.shot_version != shot.get("version"):
            stale_or_failed = True
    parent.status = "partial_failure" if stale_or_failed else "running"


def resume_billed_video_job(
    db: Session,
    client: NewApiClient,
    job_id: str,
    media_store: WorkbenchStore,
    *,
    settings=None,
    claim: FencedReconciliationClaim | None = None,
) -> Literal["pending", "completed", "failed"]:
    settings = settings or get_settings()
    claimed_here = claim is None
    claim = claim or claim_reconciliation(
        db,
        job_id=job_id,
        reason="provider_completion",
        lease_seconds=_RECOVERY_LEASE_SECONDS,
    )
    if claim is None:
        return "pending"
    heartbeat = _ClaimHeartbeat(db, claim)
    outcome: Literal["pending", "completed", "failed"] = "pending"
    try:
        heartbeat(force=True)
        snapshot = _snapshot_video_job(db, job_id)
        if snapshot.result_staged:
            outcome = "completed"
            return outcome

        committed = media_store.deterministic_video_artifact(
            snapshot.project_id, snapshot.id
        )
        if committed is not None:
            if (
                committed.capability != "video"
                or committed.source_reference != snapshot.provider_reference_id
            ):
                raise InvalidVideoArtifact(
                    "deterministic video artifact does not match billing job"
                )
            BillingService(
                db,
                settings,
                media_store.inspect_staged_artifact,
            ).stage_result(
                snapshot.id,
                committed.locator,
                committed.sha256,
                claim=claim,
            )
            outcome = "completed"
            return outcome

        heartbeat(force=True)
        task = client.get_video_task(
            snapshot.token_alias,
            snapshot.provider_reference_id,
        )
        heartbeat(force=True)
        if task.status in {"queued", "in_progress", "unknown"}:
            return outcome
        if task.status == "failed":
            outcome = "failed"
            return outcome
        if task.status != "completed":
            raise InvalidVideoArtifact("provider returned an invalid video task status")

        with media_store.hidden_video_destination(
            snapshot.project_id,
            snapshot.operation,
            artifact_id=snapshot.id,
        ) as destination:
            client.download_video_content(
                snapshot.token_alias,
                snapshot.provider_reference_id,
                destination.temporary_path,
                progress_callback=heartbeat,
            )
            heartbeat(force=True)
            _verify_video(destination.temporary_path)
            artifact = destination.commit(
                sha256=_sha256_file(destination.temporary_path),
                source_reference=snapshot.provider_reference_id,
            )
        BillingService(
            db,
            settings,
            media_store.inspect_staged_artifact,
        ).stage_result(
            snapshot.id,
            artifact.locator,
            artifact.sha256,
            claim=claim,
        )
        outcome = "completed"
        return outcome
    finally:
        if claimed_here:
            reschedule_claim(
                db,
                claim,
                delay_seconds=0 if outcome == "completed" else 5,
            )


def publish_billed_video_result(
    db: Session,
    job_id: str,
    media_store: WorkbenchStore,
    *,
    claim: FencedReconciliationClaim | None = None,
) -> bool:
    job = db.get(GenerationJob, job_id)
    if job is None or job.capability != "video":
        db.rollback()
        raise InvalidBillingState("video publication job is invalid")
    if job.status != "billed" or not job.result_visible or job.result_locator is None:
        db.rollback()
        return False
    operation = _SHOT_OPERATION.fullmatch(job.operation)
    if operation is None:
        db.rollback()
        raise InvalidBillingState("video publication operation is invalid")
    project_id = job.project_id
    user_id = job.user_id
    result_locator = job.result_locator
    shot_id = operation.group(1)
    db.commit()
    relative_path = f"assets/video/{shot_id}.mp4"
    destination = media_store.project_dir(project_id) / relative_path
    publication: dict[str, object] = {}
    heartbeat = _ClaimHeartbeat(db, claim) if claim is not None else None
    if heartbeat is not None:
        heartbeat(force=True)

    def guard_publication() -> None:
        project = db.scalar(
            select(ProjectRecord)
            .where(ProjectRecord.id == project_id)
            .with_for_update()
        )
        current_job = db.scalar(
            select(GenerationJob)
            .where(GenerationJob.id == job_id)
            .with_for_update()
        )
        if (
            project is None
            or current_job is None
            or project.owner_user_id != user_id
            or current_job.project_id != project_id
            or current_job.status != "billed"
            or not current_job.result_visible
            or current_job.result_locator != result_locator
        ):
            raise InvalidBillingState("video publication state changed")
        BillingService(
            db,
            get_settings(),
            media_store.inspect_staged_artifact,
        )._require_claim_locked(current_job, claim)
        storyboard = media_store.read_artifact(
            project_id, "episode_storyboard.json"
        )
        if not isinstance(storyboard, dict) or not isinstance(
            storyboard.get("shots"), list
        ):
            raise InvalidVideoArtifact("video publication storyboard is unavailable")
        shot = next(
            (
                item
                for item in storyboard["shots"]
                if isinstance(item, dict) and str(item.get("id")) == shot_id
            ),
            None,
        )
        if shot is None:
            raise InvalidVideoArtifact("video publication shot is unavailable")
        try:
            intent = media_store.read_video_generation_intent(project_id, job_id)
        except ValueError:
            intent = None
        if (
            intent is None
            or intent.project_id != project_id
            or intent.job_id != job_id
            or intent.shot_id != shot_id
            or intent.shot_version != shot.get("version")
        ):
            _recompute_parent_status(
                db,
                current_job.parent_job_id,
                media_store,
                storyboard,
            )
            db.commit()
            raise _StaleVideoPublication
        journal = media_store.begin_project_mutation(
            project_id,
            operation="publish-billed-video",
            changed_paths=[
                "artifacts/episode_storyboard.json",
                relative_path,
            ],
        )
        publication.update(
            project=project,
            storyboard=storyboard,
            shot=shot,
            journal=journal,
        )

    committed = False
    try:
        media_store.publish_staged_video(
            result_locator,
            destination,
            progress_callback=heartbeat,
            commit_guard=guard_publication,
        )
        project = publication["project"]
        storyboard = publication["storyboard"]
        shot = publication["shot"]
        shot["status"] = "complete"
        shot["output_path"] = relative_path
        shot["output_url"] = None
        current_job = db.get(GenerationJob, job_id)
        _recompute_parent_status(
            db,
            current_job.parent_job_id,
            media_store,
            storyboard,
        )
        media_store.write_artifact(
            project_id, "episode_storyboard.json", storyboard
        )
        project.updated_at = datetime.now(timezone.utc)
        db.commit()
        committed = True
    except _StaleVideoPublication:
        return False
    except BaseException:
        journal = publication.get("journal")
        if journal is not None and not committed:
            journal.restore()
        db.rollback()
        raise
    publication["journal"].complete()
    return True


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
