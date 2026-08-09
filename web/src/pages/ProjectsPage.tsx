import {
  FolderOpen,
  Search,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { projectRoutes } from "../app/routes";
import { ProjectComposer } from "../components/projects/ProjectComposer";
import { ProjectCard } from "../components/projects/ProjectCard";
import type { DraftProjectRequest, ShortDramaProjectResponse } from "../domain/types";
import { projectRepository } from "../features/projects/ProjectRepository";
import { getStrings } from "../i18n";
import { ProjectImportConflictError } from "../localdb/exportProject";
import { BackupWorkerUnavailableError } from "../localdb/backupArchiveClient";
import type { BackupReadProgress } from "../localdb/backupFormat";
import type { LocalProjectSummary } from "../localdb/types";
import { downloadBlob } from "../utils/downloadBlob";
import { Button, Dialog } from "../shared/ui";
import styles from "./ProjectsPage.module.css";

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

export interface ProjectsPageProps {
  onCreateDraft?: (input: DraftProjectRequest) => Promise<ShortDramaProjectResponse>;
  onStarted?: (projectId: string, initialMessage: string, textModel: string) => void;
  onSessionExpired?: () => void;
  walletAvailableUnits?: number | null;
  autoFocusComposer?: boolean;
}

export function ProjectsPage({
  autoFocusComposer = false,
  onCreateDraft = (input) => projectRepository.createDraft(input),
  onSessionExpired,
  onStarted,
  walletAvailableUnits = null,
}: ProjectsPageProps = {}) {
  const strings = getStrings("zh").projectsPage;
  const navigate = useNavigate();
  const [projects, setProjects] = useState<LocalProjectSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
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

  function openDeleteDialog(project: LocalProjectSummary, opener: HTMLButtonElement) {
    deleteOpenerRef.current = opener;
    setDeleteTarget(project);
  }

  function closeDeleteDialog() {
    if (deleting) {
      return;
    }
    setDeleteTarget(null);
    window.queueMicrotask(() => deleteOpenerRef.current?.focus());
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

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase("zh-CN");
  const visibleProjects = normalizedQuery
    ? projects.filter((project) => project.title.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    : projects;
  const startProject = onStarted ?? ((projectId: string, initialMessage: string, textModel: string) => {
    navigate(projectRoutes.idea(projectId), { state: { initialMessage, textModel } });
  });

  return (
    <section className="projects-page" aria-labelledby="projects-title">
      <section className="projects-creation-focus">
        <header className="projects-hero-heading">
          <span>mise studio</span>
          <h1 id="projects-title">让想法入镜</h1>
        </header>
        <ProjectComposer
          autoFocus={autoFocusComposer}
          onCreateDraft={onCreateDraft}
          onStarted={startProject}
          onSessionExpired={onSessionExpired}
          walletAvailableUnits={walletAvailableUnits}
        />
      </section>

      <section className="project-history" aria-labelledby="project-history-title">
        <header className="project-history-heading">
          <div>
            <h2 id="project-history-title">最近项目</h2>
            <p>{projects.length} 个项目 · {strings.localStorageNote}</p>
          </div>
          <div className="project-history-tools">
            <label className="project-search">
              <Search aria-hidden="true" size={15} />
              <span className="sr-only">搜索项目</span>
              <input
                type="search"
                value={searchQuery}
                placeholder="搜索项目"
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </label>
            <label className={`button-like ${workerUnavailable ? "secondary-import-action" : ""}`}>
              <Upload aria-hidden="true" size={15} />
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
            <label className={`button-like ${workerUnavailable ? "primary-import-action" : ""}`}>
              <FolderOpen aria-hidden="true" size={15} />
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
                <X aria-hidden="true" size={15} />
                {strings.cancelImportAction}
              </button>
            ) : null}
          </div>
        </header>

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
        {loading ? <p className="project-history-state">{strings.loading}</p> : null}
        {!loading && projects.length === 0 ? (
          <p className="project-history-state">{strings.emptyState}</p>
        ) : null}
        {!loading && projects.length > 0 && visibleProjects.length === 0 ? (
          <p className="project-history-state">没有匹配的项目。</p>
        ) : null}

        {!loading && visibleProjects.length > 0 ? (
          <ul className={styles.projectGrid}>
            {visibleProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                exporting={exportingIds.has(project.id)}
                onExport={(item) => void handleExport(item)}
                onDelete={openDeleteDialog}
              />
            ))}
          </ul>
        ) : null}
      </section>

      <Dialog
        open={Boolean(deleteTarget)}
        title={strings.deleteDialogTitle}
        openerRef={deleteOpenerRef}
        onClose={closeDeleteDialog}
      >
        {deleteTarget ? (
          <>
          <p>{strings.deleteDialogBody(deleteTarget.title)}</p>
          <div>
            <Button type="button" disabled={deleting} onClick={closeDeleteDialog}>
              {strings.cancelAction}
            </Button>
            <Button className="async-action" variant="danger" loading={deleting} type="button" onClick={() => void handleDelete()}>
              {deleting ? strings.deletingAction : strings.confirmDeleteAction}
            </Button>
          </div>
          </>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(importConflict)}
        title={strings.overwriteDialogTitle}
        onClose={() => { if (!importing) setImportConflict(null); }}
      >
        {importConflict ? (
          <>
          <p>
            {strings.overwriteDialogBody(
              projects.find((project) => project.id === importConflict.projectId)?.title ??
                importConflict.projectId,
            )}
          </p>
          <div>
            <Button
              type="button"
              disabled={importing}
              onClick={() => setImportConflict(null)}
            >
              {strings.cancelAction}
            </Button>
            <Button
              variant="danger"
              type="button"
              loading={importing}
              onClick={() => void confirmOverwrite()}
            >
              {importing ? strings.overwritingAction : strings.confirmOverwriteAction}
            </Button>
          </div>
          </>
        ) : null}
      </Dialog>
    </section>
  );
}
