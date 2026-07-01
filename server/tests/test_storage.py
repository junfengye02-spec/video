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

