import { Download, FilePlus2, FolderOpen, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { projectRoutes } from "../app/routes";
import { projectRepository } from "../features/projects/ProjectRepository";
import { getStrings } from "../i18n";
import { ProjectImportConflictError } from "../localdb/exportProject";
import { BackupWorkerUnavailableError } from "../localdb/backupArchiveClient";
import type { BackupReadProgress } from "../localdb/backupFormat";
import type { LocalProjectSummary } from "../localdb/types";
import { downloadBlob } from "../utils/downloadBlob";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "name" in error && (error as { name?: unknown }).name === "AbortError";
}

type ImportSource =
  | { kind: "archive"; file: File }
  | { kind: "directory"; files: File[] };

const directoryPickerAttributes = { webkitdirectory: "" } as const;

export function ProjectsPage() {
  const strings = getStrings("zh").projectsPage;
  const navigate = useNavigate();
  const [projects, setProjects] = useState<LocalProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LocalProjectSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [exportingIds, setExportingIds] = useState<Set<string>>(() => new Set());
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<BackupReadProgress | null>(null);
  const [workerUnavailable, setWorkerUnavailable] = useState(false);
  const [importConflict, setImportConflict] = useState<{
    source: ImportSource;
    projectId: string;
  } | null>(null);
  const deleteOpenerRef = useRef<HTMLButtonElement | null>(null);
  const exportingIdsRef = useRef(new Set<string>());
  const importControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;

    projectRepository.list()
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
      importControllerRef.current?.abort();
    };
  }, [strings.loadError]);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);

    try {
      await projectRepository.delete(deleteTarget.id);
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
    if (exportingIdsRef.current.has(project.id)) return;
    exportingIdsRef.current.add(project.id);
    setExportingIds(new Set(exportingIdsRef.current));
    setError(null);

    try {
      const blob = await projectRepository.exportBackup(project.id);
      downloadBlob(blob, `${project.title}.omproj`);
    } catch (exportError) {
      setError(errorMessage(exportError, strings.exportError));
    } finally {
      exportingIdsRef.current.delete(project.id);
      setExportingIds(new Set(exportingIdsRef.current));
    }
  }

  async function runImport(source: ImportSource, overwrite = false) {
    const controller = new AbortController();
    importControllerRef.current = controller;
    setImporting(true);
    setImportProgress(null);
    setError(null);
    try {
      const options = {
        ...(overwrite ? { overwrite: true } : {}),
        signal: controller.signal,
        onProgress: (progress: BackupReadProgress) => { setImportProgress(progress); },
      };
      const snapshot = source.kind === "archive"
        ? await projectRepository.importBackup(source.file, options)
        : await projectRepository.importBackupDirectory(source.files, options);
      navigate(projectRoutes.storyboard(snapshot.project.id));
    } catch (importError) {
      if (importError instanceof ProjectImportConflictError && !overwrite) {
        setImportConflict({ source, projectId: importError.projectId });
      } else if (isAbortError(importError)) {
        // Cancellation is an expected user action.
      } else if (
        source.kind === "archive" &&
        importError instanceof BackupWorkerUnavailableError
      ) {
        setWorkerUnavailable(true);
        setError(strings.workerUnavailableError);
      } else {
        setError(errorMessage(importError, strings.importError));
      }
    } finally {
      if (importControllerRef.current === controller) {
        importControllerRef.current = null;
        setImporting(false);
        setImportProgress(null);
      }
    }
  }

  async function handleArchiveImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    await runImport({ kind: "archive", file });
  }

  async function handleDirectoryImport(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    event.target.value = "";
    await runImport({ kind: "directory", files });
  }

  async function confirmOverwrite() {
    if (!importConflict) return;
    const { source } = importConflict;
    setImportConflict(null);
    await runImport(source, true);
  }

  return (
    <section className="projects-page" aria-labelledby="projects-title">
      <div className="page-heading">
        <div>
          <h1 id="projects-title">{strings.title}</h1>
          <p>{strings.localStorageNote}</p>
        </div>
        <div className="page-actions">
          <label className={`button-like async-action ${workerUnavailable ? "secondary-import-action" : ""}`}>
            <Upload aria-hidden="true" size={16} />
            {importing ? strings.importingAction : strings.importAction}
            <input
              className="sr-only"
              type="file"
              accept=".omproj,.zip"
              aria-label={strings.importAction}
              disabled={importing}
              onChange={handleArchiveImport}
            />
          </label>
          <label className={`button-like async-action ${workerUnavailable ? "primary-import-action" : ""}`}>
            <FolderOpen aria-hidden="true" size={16} />
            {strings.importDirectoryAction}
            <input
              {...directoryPickerAttributes}
              className="sr-only"
              type="file"
              multiple
              aria-label={strings.importDirectoryAction}
              disabled={importing}
              onChange={handleDirectoryImport}
            />
          </label>
          {importing ? (
            <button
              className="cancel-import-action"
              type="button"
              onClick={() => importControllerRef.current?.abort()}
            >
              <X aria-hidden="true" size={16} />
              {strings.cancelImportAction}
            </button>
          ) : null}
          <Link to={projectRoutes.create}>
            <FilePlus2 aria-hidden="true" size={16} />
            {strings.createAction}
          </Link>
        </div>
      </div>

      {error ? <p role="alert">{error}</p> : null}
      {importProgress ? (
        <p className="import-progress" role="status" aria-live="polite">
          {strings.importProgress(
            importProgress.bytesRead,
            importProgress.totalBytes,
            importProgress.entriesRead,
            importProgress.totalEntries,
          )}
        </p>
      ) : null}
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
                <span className={`status-pill ${project.hasFinalRender ? "status-complete" : "status-pending"}`}>
                  {project.hasFinalRender ? "已有成片" : "未生成成片"}
                </span>
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
                  disabled={exportingIds.has(project.id)}
                  onClick={() => void handleExport(project)}
                >
                  <Download aria-hidden="true" size={16} />
                  {exportingIds.has(project.id) ? strings.exportingAction : strings.exportAction}
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

      {importConflict ? (
        <dialog
          open
          aria-modal="true"
          aria-labelledby="overwrite-project-title"
          onCancel={(event) => {
            event.preventDefault();
            if (!importing) setImportConflict(null);
          }}
        >
          <h2 id="overwrite-project-title">{strings.overwriteDialogTitle}</h2>
          <p>
            {strings.overwriteDialogBody(
              projects.find((project) => project.id === importConflict.projectId)?.title ??
                importConflict.projectId,
            )}
          </p>
          <div>
            <button
              type="button"
              autoFocus
              disabled={importing}
              onClick={() => setImportConflict(null)}
            >
              {strings.cancelAction}
            </button>
            <button
              className="async-action"
              type="button"
              disabled={importing}
              onClick={() => void confirmOverwrite()}
            >
              {importing ? strings.overwritingAction : strings.confirmOverwriteAction}
            </button>
          </div>
        </dialog>
      ) : null}
    </section>
  );
}
