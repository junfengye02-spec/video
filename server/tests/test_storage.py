import hashlib
import os
import uuid
from types import SimpleNamespace

import pytest

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
        assert destination.temporary_path.parent == (
            projects_root / project_id / "assets" / "video" / ".hidden"
        )
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
    assert not list(artifact.path.parent.glob("*.partial"))

    restarted = WorkbenchStore(projects_root=projects_root)
    inspected = restarted.inspect_staged_artifact(artifact.locator)
    assert inspected.locator == artifact.locator
    assert inspected.sha256 == digest
    assert inspected.source_reference == artifact.source_reference
    assert inspected.capability == "video"
    assert restarted.exists(artifact.locator, sha256=digest)


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
