import hashlib
import json
import os
import uuid
from types import SimpleNamespace

import pytest

import server.app.storage as storage
from server.app.storage import WorkbenchStore


def test_store_creates_project_and_artifact_dirs(tmp_path):
    store = WorkbenchStore(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    project = store.create_project(title="Rain Alley", mode="short_drama")

    assert project.title == "Rain Alley"
    assert (tmp_path / "projects" / project.id / "artifacts").is_dir()
    assert (tmp_path / "projects" / project.id / "assets" / "images").is_dir()
    assert (tmp_path / "projects" / project.id / "assets" / "video").is_dir()
    assert (tmp_path / "projects" / project.id / "renders").is_dir()


def test_hidden_video_commit_is_verified_durable_and_restart_readable(tmp_path):
    projects_root = tmp_path / "projects"
    project_id = uuid.uuid4().hex
    store = WorkbenchStore(projects_root=projects_root)

    with store.hidden_video_destination(project_id, "shot:s1") as destination:
        assert destination.temporary_path.parent.parent == (
            projects_root / project_id / "assets" / "video" / ".hidden"
        )
        assert destination.temporary_path.parent.name.endswith(".partial")
        destination.temporary_path.write_bytes(b"valid-video-payload")
        digest = hashlib.sha256(b"valid-video-payload").hexdigest()
        artifact = destination.commit(
            sha256=digest,
            source_reference="task_00000000000000000000000000000001",
        )

    assert artifact.project_id == project_id
    assert artifact.operation == "shot:s1"
    assert artifact.source_reference == "task_00000000000000000000000000000001"
    assert artifact.hidden is True
    assert artifact.sha256 == digest
    assert artifact.path.read_bytes() == b"valid-video-payload"
    assert artifact.path.name == "video.mp4"
    assert artifact.path.parent.name == artifact.locator.rsplit(":", 1)[-1]
    assert {path.name for path in artifact.path.parent.iterdir()} == {
        "metadata.json",
        "video.mp4",
    }
    assert not list(artifact.path.parent.glob("*.partial"))

    restarted = WorkbenchStore(projects_root=projects_root)
    inspected = restarted.inspect_staged_artifact(artifact.locator)
    assert inspected.locator == artifact.locator
    assert inspected.sha256 == digest
    assert inspected.source_reference == artifact.source_reference
    assert inspected.capability == "video"
    assert restarted.exists(artifact.locator, sha256=digest)


def test_video_generation_intent_contains_only_exact_binding_fields(tmp_path):
    store = WorkbenchStore(projects_root=tmp_path / "projects")
    project_id = uuid.uuid4().hex
    job_id = uuid.uuid4().hex

    intent = store.record_video_generation_intent(
        project_id=project_id,
        job_id=job_id,
        shot_id="s1",
        shot_version=3,
    )

    path = (
        store.project_dir(project_id)
        / ".billing-results"
        / "video-intents"
        / f"{job_id}.json"
    )
    assert json.loads(path.read_text(encoding="utf-8")) == {
        "project_id": project_id,
        "job_id": job_id,
        "shot_id": "s1",
        "shot_version": 3,
    }
    assert store.read_video_generation_intent(project_id, job_id) == intent


def test_store_restart_restores_active_project_mutation(tmp_path):
    projects_root = tmp_path / "projects"
    project_id = uuid.uuid4().hex
    store = WorkbenchStore(projects_root=projects_root)
    store._ensure_project_dirs(project_id)
    storyboard = store.artifact_dir(project_id) / "episode_storyboard.json"
    public_video = store.project_dir(project_id) / "assets" / "video" / "s1.mp4"
    storyboard.write_bytes(b"before")

    store.begin_project_mutation(
        project_id,
        operation="publish-billed-video",
        changed_paths=[
            "artifacts/episode_storyboard.json",
            "assets/video/s1.mp4",
        ],
    )
    storyboard.write_bytes(b"after")
    public_video.write_bytes(b"uncommitted-public-video")

    restarted = WorkbenchStore(projects_root=projects_root)

    assert storyboard.read_bytes() == b"before"
    assert not public_video.exists()
    assert not (projects_root / ".recovery").exists()
    restarted.assert_project_available(project_id)


def test_hidden_video_publish_failure_never_exposes_half_artifact(
    tmp_path, monkeypatch
):
    store = WorkbenchStore(projects_root=tmp_path / "projects")
    project_id = uuid.uuid4().hex
    artifact_id = "2" * 32
    monkeypatch.setattr(
        "server.app.storage.uuid.uuid4", lambda: SimpleNamespace(hex=artifact_id)
    )

    with pytest.raises(OSError, match="could not be published"):
        with store.hidden_video_destination(project_id, "shot:s6") as destination:
            destination.temporary_path.write_bytes(b"downloaded")
            monkeypatch.setattr(
                storage.os,
                "rename",
                lambda *_args: (_ for _ in ()).throw(OSError("crash before rename")),
            )
            destination.commit(
                sha256=hashlib.sha256(b"downloaded").hexdigest(),
                source_reference="task_00000000000000000000000000000006",
            )

    locator = f"workbench-hidden-video:{project_id}:{artifact_id}"
    hidden = store.project_dir(project_id) / "assets" / "video" / ".hidden"
    assert not store.exists(locator)
    assert not (hidden / artifact_id).exists()
    assert not list(hidden.glob(f".{artifact_id}*"))


def test_hidden_video_hash_mismatch_cleans_partial_without_replacing_artifact(tmp_path):
    store = WorkbenchStore(projects_root=tmp_path / "projects")
    project_id = uuid.uuid4().hex

    with pytest.raises(ValueError, match="hash"):
        with store.hidden_video_destination(project_id, "shot:s2") as destination:
            destination.temporary_path.write_bytes(b"downloaded")
            destination.commit(
                sha256="0" * 64,
                source_reference="task_00000000000000000000000000000002",
            )

    hidden = store.project_dir(project_id) / "assets" / "video" / ".hidden"
    assert not list(hidden.glob("*.partial"))
    assert not list(hidden.glob("*.mp4"))
    assert not list(hidden.glob("*.json"))


def test_hidden_video_destination_rejects_linked_or_hardlinked_staging(tmp_path):
    store = WorkbenchStore(projects_root=tmp_path / "projects")
    project_id = uuid.uuid4().hex

    with store.hidden_video_destination(project_id, "shot:s3") as destination:
        destination.temporary_path.write_bytes(b"downloaded")
        external = tmp_path / "external.bin"
        try:
            os.link(destination.temporary_path, external)
        except OSError:
            pytest.skip("hard links are unavailable on this filesystem")
        digest = hashlib.sha256(b"downloaded").hexdigest()
        with pytest.raises(ValueError, match="hard link"):
            destination.commit(
                sha256=digest,
                source_reference="task_00000000000000000000000000000003",
            )
    assert external.read_bytes() == b"downloaded"


def test_hidden_video_destination_rejects_linked_directory(tmp_path):
    store = WorkbenchStore(projects_root=tmp_path / "projects")
    project_id = uuid.uuid4().hex
    video_dir = store.project_dir(project_id) / "assets" / "video"
    video_dir.mkdir(parents=True)
    external = tmp_path / "external"
    external.mkdir()
    try:
        (video_dir / ".hidden").symlink_to(external, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are unavailable on this system")

    with pytest.raises(ValueError, match="directory"):
        store.hidden_video_destination(project_id, "shot:s4")
    assert not list(external.iterdir())


def test_hidden_video_collision_preserves_existing_artifact(tmp_path, monkeypatch):
    store = WorkbenchStore(projects_root=tmp_path / "projects")
    project_id = uuid.uuid4().hex
    artifact_id = "1" * 32
    monkeypatch.setattr(
        "server.app.storage.uuid.uuid4", lambda: SimpleNamespace(hex=artifact_id)
    )
    digest = hashlib.sha256(b"original").hexdigest()
    with store.hidden_video_destination(project_id, "shot:s5") as destination:
        destination.temporary_path.write_bytes(b"original")
        artifact = destination.commit(
            sha256=digest,
            source_reference="task_00000000000000000000000000000004",
        )

    with pytest.raises(ValueError, match="already exists"):
        with store.hidden_video_destination(project_id, "shot:s5") as destination:
            destination.temporary_path.write_bytes(b"replacement")
            destination.commit(
                sha256=hashlib.sha256(b"replacement").hexdigest(),
                source_reference="task_00000000000000000000000000000004",
            )

    assert artifact.path.read_bytes() == b"original"
    assert store.exists(artifact.locator, sha256=digest)
