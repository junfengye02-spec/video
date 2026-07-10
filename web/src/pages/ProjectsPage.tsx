import { Download, FilePlus2, FolderOpen, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { projectRoutes } from "../app/routes";
import { getStrings } from "../i18n";
import { exportProjectBackup, importProjectBackup } from "../localdb/exportProject";
import { deleteProject, listProjectSummaries } from "../localdb/projectStore";
import type { LocalProjectSummary } from "../localdb/types";
import { downloadBlob } from "../utils/downloadBlob";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ProjectsPage() {
  const strings = getStrings("zh").projectsPage;
  const navigate = useNavigate();
  const [projects, setProjects] = useState<LocalProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LocalProjectSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const deleteOpenerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let active = true;

    listProjectSummaries()
      .then((summaries) => {
        if (active) setProjects(summaries);
      })
      .catch((loadError: unknown) => {
        if (active) setError(errorMessage(loadError, strings.loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [strings.loadError]);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);

    try {
      await deleteProject(deleteTarget.id);
      setProjects((current) => current.filter((project) => project.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (deleteError) {
      setError(errorMessage(deleteError, strings.deleteError));
    } finally {
      setDeleting(false);
    }
  }

  function openDeleteDialog(
    event: MouseEvent<HTMLButtonElement>,
    project: LocalProjectSummary,
  ) {
    deleteOpenerRef.current = event.currentTarget;
    setDeleteTarget(project);
  }

  function closeDeleteDialog() {
    if (deleting) {
      return;
    }
    setDeleteTarget(null);
    window.queueMicrotask(() => deleteOpenerRef.current?.focus());
  }

  function handleDeleteDialogKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDeleteDialog();
    }
  }

  async function handleExport(project: LocalProjectSummary) {
    setExportingId(project.id);
    setError(null);

    try {
      const blob = await exportProjectBackup(project.id);
      downloadBlob(blob, `${project.title}.omproj`);
    } catch (exportError) {
      setError(errorMessage(exportError, strings.exportError));
    } finally {
      setExportingId(null);
    }
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setError(null);
    try {
      const snapshot = await importProjectBackup(file);
      navigate(projectRoutes.storyboard(snapshot.project.id));
    } catch (importError) {
      setError(errorMessage(importError, strings.importError));
    } finally {
      event.target.value = "";
      setImporting(false);
    }
  }

  return (
    <section className="projects-page" aria-labelledby="projects-title">
      <div className="page-heading">
        <div>
          <h1 id="projects-title">{strings.title}</h1>
          <p>{strings.localStorageNote}</p>
        </div>
        <div className="page-actions">
          <label className="button-like async-action">
            <Upload aria-hidden="true" size={16} />
            {importing ? strings.importingAction : strings.importAction}
            <input
              className="sr-only"
              type="file"
              accept=".omproj,.zip"
              aria-label={strings.importAction}
              disabled={importing}
              onChange={handleImport}
            />
          </label>
          <Link to={projectRoutes.create}>
            <FilePlus2 aria-hidden="true" size={16} />
            {strings.createAction}
          </Link>
        </div>
      </div>

      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p>{strings.loading}</p> : null}
      {!loading && projects.length === 0 ? <p>{strings.emptyState}</p> : null}

      {!loading && projects.length > 0 ? (
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id} className="project-list-item project-item">
              <div>
                <h2>{project.title}</h2>
                <p>{strings.shotCount(project.shotCount)}</p>
                <time dateTime={project.updatedAt}>
                  {strings.updatedAt(new Date(project.updatedAt).toLocaleString("zh-CN"))}
                </time>
                {project.hasFinalRender ? <span>{strings.finalRenderReady}</span> : null}
              </div>
              <div className="project-actions">
                <Link
                  to={projectRoutes.storyboard(project.id)}
                  aria-label={strings.openProject(project.title)}
                >
                  <FolderOpen aria-hidden="true" size={16} />
                  {strings.openAction}
                </Link>
                <button
                  className="async-action"
                  type="button"
                  aria-label={strings.exportProject(project.title)}
                  disabled={exportingId === project.id}
                  onClick={() => void handleExport(project)}
                >
                  <Download aria-hidden="true" size={16} />
                  {exportingId === project.id ? strings.exportingAction : strings.exportAction}
                </button>
                <button
                  type="button"
                  aria-label={strings.deleteProject(project.title)}
                  onClick={(event) => openDeleteDialog(event, project)}
                >
                  <Trash2 aria-hidden="true" size={16} />
                  {strings.deleteAction}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {deleteTarget ? (
        <dialog
          open
          aria-modal="true"
          aria-labelledby="delete-project-title"
          onCancel={(event) => {
            event.preventDefault();
            closeDeleteDialog();
          }}
          onKeyDown={handleDeleteDialogKeyDown}
        >
          <h2 id="delete-project-title">{strings.deleteDialogTitle}</h2>
          <p>{strings.deleteDialogBody(deleteTarget.title)}</p>
          <div>
            <button type="button" autoFocus disabled={deleting} onClick={closeDeleteDialog}>
              {strings.cancelAction}
            </button>
            <button className="async-action" type="button" disabled={deleting} onClick={() => void handleDelete()}>
              {deleting ? strings.deletingAction : strings.confirmDeleteAction}
            </button>
          </div>
        </dialog>
      ) : null}
    </section>
  );
}
