import {
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { matchPath, useInRouterContext, useLocation } from "react-router-dom";
import {
  createShortDramaProject,
  loadProject,
  mediaUrl,
  optimizePrompt,
  regenerateShot,
  renderProject,
  saveContinuityPlan,
  saveShot,
  subscribeProjectEvents,
  uploadReferenceImage,
} from "../../api/client";
import type {
  ContinuityPlan,
  ConsistencyReport,
  JobEvent,
  PromptOptimizeResponse,
  ReferenceImageUploadRequest,
  RenderProjectResponse,
  RenderReport,
  ShortDramaProjectResponse,
  Shot,
  ShotSaveRequest,
  Storyboard,
} from "../../domain/types";
import { detectLocale, getStrings } from "../../i18n";
import {
  cacheRemoteMedia,
  findCommittedMedia,
  loadMediaBlob,
  startMediaRecoveryController,
} from "../../localdb/mediaStore";
import { resolveLocalMediaUrl, revokeLocalMediaUrls } from "../../localdb/mediaUrls";
import {
  loadProjectSnapshot,
  saveProjectSnapshot,
  saveProjectSnapshotIfVersion,
  setRecentProjectId,
} from "../../localdb/projectStore";
import { getStorageEstimate } from "../../localdb/storageEstimate";
import type { LocalMediaRef, LocalProjectSnapshot, LocalProjectVersion } from "../../localdb/types";
import {
  applyCommittedMediaOverlays,
  collectRemoteMediaSourcePaths,
  emptyContinuityPlan,
  mergeAuthoritativeMediaOverlays,
} from "./snapshot";
import type {
  CreateProjectInput,
  LocalBackupStatus,
  WorkbenchBusyState,
  WorkbenchContextValue,
} from "./types";

const INITIAL_BUSY: WorkbenchBusyState = {
  creating: false,
  downloading: false,
  optimizingShotId: null,
  regeneratingShotId: null,
  rendering: false,
  savingContinuity: false,
  savingShotId: null,
  uploadingReference: false,
};

type ProjectOperationName =
  | "download"
  | "optimize"
  | "regenerate"
  | "render"
  | "saveContinuity"
  | "saveShot"
  | "uploadReference";

type ProjectOperationToken = {
  epoch: number;
  name: ProjectOperationName;
  projectId: string;
  sequence: number;
};

type BackgroundCacheJobToken = {
  generation: number;
  id: number;
};

const INITIAL_OPERATION_SEQUENCES: Record<ProjectOperationName, number> = {
  download: 0,
  optimize: 0,
  regenerate: 0,
  render: 0,
  saveContinuity: 0,
  saveShot: 0,
  uploadReference: 0,
};

export const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

function isLocalMediaRef(value: string | null | undefined): value is LocalMediaRef {
  return typeof value === "string" && value.startsWith("local://media/");
}

function collectLocalMediaRefs(
  value: unknown,
  refs = new Set<LocalMediaRef>(),
): Set<LocalMediaRef> {
  if (typeof value === "string" && isLocalMediaRef(value)) {
    refs.add(value);
    return refs;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectLocalMediaRefs(item, refs));
    return refs;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectLocalMediaRefs(item, refs));
  }
  return refs;
}

function appendUniqueEvent(current: JobEvent[], event: JobEvent): JobEvent[] {
  return current.some((item) => item.id === event.id) ? current : [...current, event];
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sanitizeDownloadName(value: string | null | undefined): string {
  return (value?.trim() || "openmontage")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function mergeRegeneratedSnapshot(
  latest: ShortDramaProjectResponse,
  storyboard: Storyboard,
  cachedShot: Shot,
  consistencyReport: ConsistencyReport,
  preserveLatest: boolean,
): ShortDramaProjectResponse {
  if (!preserveLatest) {
    return {
      ...latest,
      storyboard: {
        ...storyboard,
        shots: storyboard.shots.map((item) => item.id === cachedShot.id ? cachedShot : item),
      },
      consistency_report: consistencyReport,
    };
  }

  const latestShot = latest.storyboard.shots.find((item) => item.id === cachedShot.id);
  const mergedShot = latestShot
    ? {
        ...cachedShot,
        ...latestShot,
        output_path: cachedShot.output_path,
        output_url: cachedShot.output_url,
        status: cachedShot.status,
        consistency_score: cachedShot.consistency_score,
      }
    : cachedShot;
  return {
    ...latest,
    storyboard: {
      ...latest.storyboard,
      shots: latest.storyboard.shots.map((item) => item.id === mergedShot.id ? mergedShot : item),
    },
  };
}

function mergeRenderResponse(
  latest: ShortDramaProjectResponse,
  result: RenderProjectResponse,
  preserveLatest: boolean,
): ShortDramaProjectResponse {
  return {
    ...latest,
    ...(preserveLatest ? {} : {
      project: result.project,
      storyboard: result.storyboard,
      consistency_report: result.consistency_report,
    }),
    render_report: result.render_report,
    final_path: result.final_path,
  };
}

function isCompleteRenderSource(
  path: string | null | undefined,
  report: RenderReport | null | undefined,
): path is string {
  const normalized = path?.trim();
  if (!normalized || !report?.outputs.length) return false;
  return report.outputs.some((output) => (
    output.path === normalized
    || output.media_url === normalized
    || normalized.endsWith(`/${output.path}`)
  ));
}

function ProjectLoadRouteObserver({
  onRouteProjectChange,
}: {
  onRouteProjectChange: (projectId: string | null) => void;
}) {
  const location = useLocation();

  useLayoutEffect(() => {
    const match = matchPath("/projects/:projectId/*", location.pathname)
      ?? matchPath("/projects/:projectId", location.pathname);
    onRouteProjectChange(match?.params.projectId ?? null);
  }, [location.pathname, onRouteProjectChange]);

  return null;
}

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const inRouterContext = useInRouterContext();
  const strings = useMemo(
    () => getStrings(detectLocale(globalThis.navigator?.language)),
    [],
  );
  const [snapshot, setSnapshot] = useState<ShortDramaProjectResponse | null>(null);
  const snapshotRef = useRef<ShortDramaProjectResponse | null>(null);
  const snapshotRevisionRef = useRef(0);
  const storageVersionRef = useRef({
    projectId: null as string | null,
    version: null as LocalProjectVersion | null,
  });
  const projectEpochRef = useRef(0);
  const operationSequencesRef = useRef({ ...INITIAL_OPERATION_SEQUENCES });
  const creationSequenceRef = useRef(0);
  const projectLoadGenerationRef = useRef(0);
  const pendingProjectLoadRef = useRef<{ generation: number; projectId: string } | null>(null);
  const previousMediaProjectIdRef = useRef<string | null>(null);
  const mediaMountedRef = useRef(true);
  const resolvingMediaRefsRef = useRef(new Set<string>());
  const failedMediaRefsRef = useRef(new Set<string>());
  const mediaGenerationRef = useRef(0);
  const mediaResetSnapshotRef = useRef<ShortDramaProjectResponse | null>(null);
  const backgroundCacheGenerationRef = useRef(0);
  const nextBackgroundCacheJobRef = useRef(0);
  const backgroundCacheJobsRef = useRef(new Map<number, LocalBackupStatus>());
  const scheduledBackgroundTasksRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [localMediaUrls, setLocalMediaUrls] = useState<
    Partial<Record<LocalMediaRef, string>>
  >({});
  const [mediaGeneration, setMediaGeneration] = useState(0);
  const [mediaWakeVersion, setMediaWakeVersion] = useState(0);
  const [localBackupStatus, setLocalBackupStatus] = useState<LocalBackupStatus>("idle");
  const [busy, setBusy] = useState(INITIAL_BUSY);

  const updateLocalBackupStatus = useCallback(() => {
    if (!mediaMountedRef.current) return;
    const jobs = Array.from(backgroundCacheJobsRef.current.values());
    setLocalBackupStatus(
      jobs.includes("saving") ? "saving" : jobs.includes("retrying") ? "retrying" : "idle",
    );
  }, []);

  const resetLocalBackupState = useCallback(() => {
    backgroundCacheGenerationRef.current += 1;
    backgroundCacheJobsRef.current.clear();
    setLocalBackupStatus("idle");
  }, []);

  const clearScheduledBackgroundTasks = useCallback(() => {
    scheduledBackgroundTasksRef.current.forEach((timer) => clearTimeout(timer));
    scheduledBackgroundTasksRef.current.clear();
  }, []);

  const scheduleBackgroundTask = useCallback((task: () => void) => {
    const generation = backgroundCacheGenerationRef.current;
    const timer = setTimeout(() => {
      scheduledBackgroundTasksRef.current.delete(timer);
      if (!mediaMountedRef.current || generation !== backgroundCacheGenerationRef.current) return;
      task();
    }, 0);
    scheduledBackgroundTasksRef.current.add(timer);
  }, []);

  const beginBackgroundCacheJob = useCallback((): BackgroundCacheJobToken => {
    const token = {
      generation: backgroundCacheGenerationRef.current,
      id: ++nextBackgroundCacheJobRef.current,
    };
    backgroundCacheJobsRef.current.set(token.id, "saving");
    updateLocalBackupStatus();
    return token;
  }, [updateLocalBackupStatus]);

  const finishBackgroundCacheJob = useCallback((
    token: BackgroundCacheJobToken,
    failed: boolean,
  ) => {
    if (token.generation !== backgroundCacheGenerationRef.current) return;
    if (failed) backgroundCacheJobsRef.current.set(token.id, "retrying");
    else backgroundCacheJobsRef.current.delete(token.id);
    updateLocalBackupStatus();
  }, [updateLocalBackupStatus]);

  const setBusyValue = useCallback(
    <K extends keyof WorkbenchBusyState>(key: K, value: WorkbenchBusyState[K]) => {
      setBusy((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const invalidateProjectOperations = useCallback(() => {
    clearScheduledBackgroundTasks();
    projectEpochRef.current += 1;
    (Object.keys(operationSequencesRef.current) as ProjectOperationName[]).forEach((name) => {
      operationSequencesRef.current[name] += 1;
    });
    projectLoadGenerationRef.current += 1;
    creationSequenceRef.current += 1;
    resetLocalBackupState();
    setBusy(INITIAL_BUSY);
  }, [clearScheduledBackgroundTasks, resetLocalBackupState]);

  const beginProjectOperation = useCallback(
    (name: ProjectOperationName, projectId: string): ProjectOperationToken => {
      const sequence = operationSequencesRef.current[name] + 1;
      operationSequencesRef.current[name] = sequence;
      return { epoch: projectEpochRef.current, name, projectId, sequence };
    },
    [],
  );

  const isProjectOperationCurrent = useCallback((token: ProjectOperationToken): boolean => (
    mediaMountedRef.current
    && token.epoch === projectEpochRef.current
    && token.sequence === operationSequencesRef.current[token.name]
    && token.projectId === snapshotRef.current?.project.id
  ), []);

  const applyProjectSnapshot = useCallback((next: ShortDramaProjectResponse) => {
    const previousProjectId = snapshotRef.current?.project.id ?? null;
    if (previousProjectId && previousProjectId !== next.project.id) resetLocalBackupState();
    snapshotRef.current = next;
    snapshotRevisionRef.current += 1;
    setSnapshot(next);
    if (previousProjectId !== next.project.id) {
      setEvents([]);
    }
    setSelectedShotId((current) => {
      const shots = next.storyboard.shots;
      if (current && shots.some((shot) => shot.id === current)) return current;
      return shots[0]?.id ?? null;
    });
  }, [resetLocalBackupState]);

  const recordStorageVersion = useCallback((record: LocalProjectSnapshot) => {
    storageVersionRef.current = {
      projectId: record.id,
      version: {
        incarnation: record.incarnation?.trim() || `legacy:${record.id}`,
        revision: record.revision ?? 0,
      },
    };
  }, []);

  const refreshStorageEstimate = useCallback(async () => {
    try {
      await getStorageEstimate();
    } catch {
      // Browser storage estimates are best-effort hints.
    }
  }, []);

  const applyAndPersistProjectSnapshot = useCallback(
    async (next: ShortDramaProjectResponse, isCurrent: () => boolean = () => true) => {
      if (!isCurrent()) return;
      applyProjectSnapshot(next);
      try {
        const saved = await saveProjectSnapshot(next);
        recordStorageVersion(saved);
        void refreshStorageEstimate();
      } catch {
        if (isCurrent()) {
          setError(strings.errors.localProjectSaveFallback);
        }
      }
    },
    [
      applyProjectSnapshot,
      recordStorageVersion,
      refreshStorageEstimate,
      strings.errors.localProjectSaveFallback,
    ],
  );

  const persistIfCurrent = useCallback(
    async (
      projectId: string,
      next: ShortDramaProjectResponse,
      isCurrent: () => boolean = () => true,
    ) => {
      const guard = () => snapshotRef.current?.project.id === projectId && isCurrent();
      if (!guard()) return;
      await applyAndPersistProjectSnapshot(next, guard);
    },
    [applyAndPersistProjectSnapshot],
  );

  const persistBackgroundIfCurrent = useCallback(
    async (
      projectId: string,
      mutate: (current: ShortDramaProjectResponse) => ShortDramaProjectResponse,
      isCurrent: () => boolean,
    ): Promise<boolean> => {
      const current = snapshotRef.current;
      const stored = storageVersionRef.current;
      if (
        current?.project.id !== projectId
        || !isCurrent()
        || stored.projectId !== projectId
        || !stored.version
      ) {
        return true;
      }
      const memoryRevision = snapshotRevisionRef.current;
      const candidate = mutate(current);
      let saved;
      try {
        saved = await saveProjectSnapshotIfVersion(candidate, stored.version);
      } catch {
        return false;
      }
      if (!saved) return true;

      const latest = snapshotRef.current;
      if (
        latest?.project.id !== projectId
        || !isCurrent()
        || memoryRevision !== snapshotRevisionRef.current
      ) {
        if (latest?.project.id !== projectId) return true;
        try {
          const repaired = await saveProjectSnapshotIfVersion(
            latest,
            { incarnation: saved.incarnation, revision: saved.revision },
          );
          if (repaired) recordStorageVersion(repaired);
          return true;
        } catch {
          return false;
        }
      }

      recordStorageVersion(saved);
      applyProjectSnapshot(candidate);
      void refreshStorageEstimate();
      return true;
    },
    [applyProjectSnapshot, recordStorageVersion, refreshStorageEstimate],
  );

  const refreshAuthoritativeProject = useCallback(
    async (
      projectId: string,
      isCurrent: () => boolean,
    ): Promise<ShortDramaProjectResponse | null> => {
      const firstRevision = snapshotRevisionRef.current;
      const first = await loadProject(projectId);
      if (!isCurrent()) return null;
      if (firstRevision === snapshotRevisionRef.current) return first;

      const retryRevision = snapshotRevisionRef.current;
      const retry = await loadProject(projectId);
      if (!isCurrent()) return null;
      return retryRevision === snapshotRevisionRef.current ? retry : snapshotRef.current;
    },
    [],
  );

  const resetMediaResolver = useCallback(() => {
    mediaGenerationRef.current += 1;
    failedMediaRefsRef.current.clear();
    revokeLocalMediaUrls();
    setLocalMediaUrls({});
    setMediaGeneration(mediaGenerationRef.current);
  }, []);

  useEffect(() => {
    void refreshStorageEstimate();
  }, [refreshStorageEstimate]);

  useEffect(() => {
    const controller = startMediaRecoveryController();
    return () => controller.dispose();
  }, []);

  useEffect(() => {
    const projectId = snapshot?.project.id ?? null;
    const previousProjectId = previousMediaProjectIdRef.current;
    previousMediaProjectIdRef.current = projectId;
    if (previousProjectId && previousProjectId !== projectId) {
      mediaResetSnapshotRef.current = snapshot;
      resetMediaResolver();
    }
  }, [resetMediaResolver, snapshot?.project.id]);

  useEffect(() => {
    mediaMountedRef.current = true;
    return () => {
      mediaMountedRef.current = false;
      projectEpochRef.current += 1;
      (Object.keys(operationSequencesRef.current) as ProjectOperationName[]).forEach((name) => {
        operationSequencesRef.current[name] += 1;
      });
      projectLoadGenerationRef.current += 1;
      creationSequenceRef.current += 1;
      clearScheduledBackgroundTasks();
      backgroundCacheGenerationRef.current += 1;
      backgroundCacheJobsRef.current.clear();
      failedMediaRefsRef.current.clear();
      revokeLocalMediaUrls();
    };
  }, [clearScheduledBackgroundTasks]);

  useEffect(() => {
    if (mediaResetSnapshotRef.current === snapshot) {
      mediaResetSnapshotRef.current = null;
      return;
    }
    const refs = collectLocalMediaRefs(snapshot);
    const hasOrphan = Object.keys(localMediaUrls).some((ref) => !refs.has(ref as LocalMediaRef));
    if (hasOrphan) resetMediaResolver();
  }, [localMediaUrls, resetMediaResolver, snapshot]);

  useEffect(() => {
    const projectId = snapshot?.project.id ?? null;
    const generation = mediaGenerationRef.current;
    const refs = Array.from(collectLocalMediaRefs(snapshot));
    const unresolved = refs.filter((ref) => {
      const pendingKey = `${generation}:${projectId ?? ""}:${ref}`;
      return !localMediaUrls[ref]
        && !resolvingMediaRefsRef.current.has(pendingKey)
        && !failedMediaRefsRef.current.has(pendingKey);
    });
    if (unresolved.length === 0) return;

    unresolved.forEach((ref) => {
      const pendingKey = `${generation}:${projectId ?? ""}:${ref}`;
      resolvingMediaRefsRef.current.add(pendingKey);
      void resolveLocalMediaUrl(ref)
        .then((url) => {
          if (!url) {
            failedMediaRefsRef.current.add(pendingKey);
            return;
          }
          failedMediaRefsRef.current.delete(pendingKey);
          const currentRefs = collectLocalMediaRefs(snapshotRef.current);
          if (
            !mediaMountedRef.current
            || generation !== mediaGenerationRef.current
            || snapshotRef.current?.project.id !== projectId
            || !currentRefs.has(ref)
          ) {
            if (mediaMountedRef.current) {
              resetMediaResolver();
            } else {
              revokeLocalMediaUrls();
            }
            return;
          }
          setLocalMediaUrls((current) => ({ ...current, [ref]: url }));
        })
        .catch(() => {
          failedMediaRefsRef.current.add(pendingKey);
        })
        .finally(() => {
          resolvingMediaRefsRef.current.delete(pendingKey);
          if (mediaMountedRef.current) {
            setMediaWakeVersion((current) => current + 1);
          }
        });
    });
  }, [localMediaUrls, mediaGeneration, mediaWakeVersion, resetMediaResolver, snapshot]);

  useEffect(() => {
    const projectId = snapshot?.project.id;
    if (!projectId) return;
    try {
      return subscribeProjectEvents(projectId, (event) => {
        if (snapshotRef.current?.project.id !== projectId) return;
        setEvents((current) => appendUniqueEvent(current, event));
      });
    } catch (subscriptionError) {
      setError(errorMessage(subscriptionError, strings.errors.renderFallback));
      return undefined;
    }
  }, [snapshot?.project.id, strings.errors.renderFallback]);

  const handleRouteProjectChange = useCallback((routeProjectId: string | null) => {
    const pending = pendingProjectLoadRef.current;
    if (!pending || pending.projectId === routeProjectId) return;
    projectLoadGenerationRef.current += 1;
    pendingProjectLoadRef.current = null;
  }, []);

  const openLocalProject = useCallback(
    async (projectId: string): Promise<boolean> => {
      invalidateProjectOperations();
      const generation = projectLoadGenerationRef.current;
      pendingProjectLoadRef.current = { generation, projectId };
      const record = await loadProjectSnapshot(projectId);
      if (generation !== projectLoadGenerationRef.current) return Boolean(record);
      pendingProjectLoadRef.current = null;
      if (!record) return false;
      recordStorageVersion(record);

      const overlays = new Map<string, LocalMediaRef>();
      const projectIncarnation = record.incarnation?.trim() || `legacy:${record.id}`;
      await Promise.all(collectRemoteMediaSourcePaths(record.snapshot).map(async (sourcePath) => {
        try {
          const media = await findCommittedMedia(projectId, sourcePath, projectIncarnation);
          if (
            media
            && media.projectId === projectId
            && media.sourcePath === sourcePath
            && (media.state === undefined || media.state === "committed")
          ) {
            overlays.set(sourcePath, `local://media/${media.id}`);
          }
        } catch {
          // A local index failure must not make the remote project snapshot unavailable.
        }
      }));
      if (generation !== projectLoadGenerationRef.current) return true;
      applyProjectSnapshot(applyCommittedMediaOverlays(record.snapshot, overlays));
      try {
        await setRecentProjectId(projectId);
      } catch {
        if (
          generation === projectLoadGenerationRef.current
          && snapshotRef.current?.project.id === projectId
        ) {
          setError(strings.errors.localProjectSaveFallback);
        }
      }
      return true;
    },
    [
      applyProjectSnapshot,
      invalidateProjectOperations,
      recordStorageVersion,
      strings.errors.localProjectSaveFallback,
    ],
  );

  const createProject = useCallback(
    async (input: CreateProjectInput): Promise<ShortDramaProjectResponse> => {
      if (!input.prompt.trim()) {
        const message = strings.errors.createStoryboardRequiresPrompt;
        setError(message);
        throw new Error(message);
      }

      invalidateProjectOperations();
      const creationSequence = creationSequenceRef.current;
      const isCurrent = () => creationSequence === creationSequenceRef.current;
      setBusyValue("creating", true);
      setError(null);
      setEvents([]);
      try {
        const result = await createShortDramaProject({
          title: input.title,
          prompt: input.prompt,
          project_type: input.project_type,
        });
        if (isCurrent()) {
          await applyAndPersistProjectSnapshot({ ...result, final_path: null }, isCurrent);
        }
        return result;
      } catch (creationError) {
        const message = errorMessage(creationError, strings.errors.createProjectFallback);
        if (isCurrent()) setError(message);
        throw creationError instanceof Error ? creationError : new Error(message);
      } finally {
        if (isCurrent()) setBusyValue("creating", false);
      }
    },
    [
      applyAndPersistProjectSnapshot,
      invalidateProjectOperations,
      setBusyValue,
      strings.errors,
    ],
  );

  const optimizeShotPrompt = useCallback(
    async (shot: Shot, sourceText: string): Promise<PromptOptimizeResponse> => {
      const current = snapshotRef.current;
      if (!current) throw new Error(strings.errors.optimizeShotFallback);

      const token = beginProjectOperation("optimize", current.project.id);
      setBusyValue("optimizingShotId", shot.id);
      setError(null);
      try {
        return await optimizePrompt(current.project.id, {
          target: "shot",
          target_id: shot.id,
          source_text: sourceText,
          mode: "shot_json",
        });
      } catch (optimizationError) {
        const message = errorMessage(optimizationError, strings.errors.optimizeShotFallback);
        if (isProjectOperationCurrent(token)) setError(message);
        throw optimizationError instanceof Error ? optimizationError : new Error(message);
      } finally {
        if (isProjectOperationCurrent(token)) setBusyValue("optimizingShotId", null);
      }
    },
    [
      beginProjectOperation,
      isProjectOperationCurrent,
      setBusyValue,
      strings.errors.optimizeShotFallback,
    ],
  );

  const saveShotChanges = useCallback(
    async (shotId: string, payload: ShotSaveRequest): Promise<Shot> => {
      const current = snapshotRef.current;
      if (!current) throw new Error(strings.errors.saveShotFallback);
      const projectId = current.project.id;
      const token = beginProjectOperation("saveShot", projectId);
      const isCurrent = () => isProjectOperationCurrent(token);
      setBusyValue("savingShotId", shotId);
      setError(null);
      try {
        const result = await saveShot(projectId, shotId, payload);
        if (!isCurrent()) return result.shot;
        const latest = snapshotRef.current;
        if (!latest) return result.shot;
        setSelectedShotId(shotId);
        setEvents((items) => appendUniqueEvent(items, result.event));
        await persistIfCurrent(projectId, {
          ...latest,
          storyboard: result.storyboard,
          consistency_report: result.consistency_report,
          render_report: null,
          final_path: null,
        }, isCurrent);
        return result.shot;
      } catch (saveError) {
        const message = errorMessage(saveError, strings.errors.saveShotFallback);
        if (isCurrent()) setError(message);
        throw saveError instanceof Error ? saveError : new Error(message);
      } finally {
        if (isCurrent()) setBusyValue("savingShotId", null);
      }
    },
    [
      beginProjectOperation,
      isProjectOperationCurrent,
      persistIfCurrent,
      setBusyValue,
      strings.errors.saveShotFallback,
    ],
  );

  const regenerateSelectedShot = useCallback(
    async (shot: Shot): Promise<void> => {
      const current = snapshotRef.current;
      if (!current) return;

      const projectId = current.project.id;
      const token = beginProjectOperation("regenerate", projectId);
      const isCurrent = () => isProjectOperationCurrent(token);
      const operationRevision = snapshotRevisionRef.current;
      setSelectedShotId(shot.id);
      setBusyValue("regeneratingShotId", shot.id);
      setError(null);
      try {
        const result = await regenerateShot(projectId, shot.id, {});
        if (!isCurrent()) return;
        const latest = snapshotRef.current;
        if (!latest) return;
        setEvents((items) => appendUniqueEvent(items, result.event));
        const remoteSnapshot = mergeRegeneratedSnapshot(
          latest,
          result.storyboard,
          result.shot,
          result.consistency_report,
          operationRevision !== snapshotRevisionRef.current,
        );
        await persistIfCurrent(
          projectId,
          remoteSnapshot,
          isCurrent,
        );
        if (!isCurrent()) return;
        const sourcePath = result.shot.output_path;
        const url = sourcePath && !isLocalMediaRef(sourcePath)
          ? mediaUrl(sourcePath, projectId)
          : null;
        if (!sourcePath || !url) return;
        const entityId = result.shot.id;
        const entityVersion = result.shot.version;
        const publishedRevision = snapshotRevisionRef.current;
        const projectIncarnation = storageVersionRef.current.projectId === projectId
          ? storageVersionRef.current.version?.incarnation
          : undefined;
        const cacheJob = beginBackgroundCacheJob();
        scheduleBackgroundTask(() => {
          void (async () => {
            try {
              const localRef = await cacheRemoteMedia(url, {
                projectId,
                projectIncarnation,
                sourcePath,
              });
              if (!localRef) throw new Error("Remote media was not cached");
              const promotionIsCurrent = () => {
                if (!isCurrent() || snapshotRevisionRef.current < publishedRevision) return false;
                const currentShot = snapshotRef.current?.storyboard.shots.find(
                  (item) => item.id === entityId,
                );
                return currentShot?.version === entityVersion
                  && currentShot.output_path === sourcePath;
              };
              if (!promotionIsCurrent()) {
                finishBackgroundCacheJob(cacheJob, false);
                return;
              }
              const persisted = await persistBackgroundIfCurrent(
                projectId,
                (currentSnapshot) => ({
                  ...currentSnapshot,
                  storyboard: {
                    ...currentSnapshot.storyboard,
                    shots: currentSnapshot.storyboard.shots.map((item) => item.id === entityId
                      ? { ...item, output_path: localRef, output_url: null }
                      : item),
                  },
                }),
                promotionIsCurrent,
              );
              finishBackgroundCacheJob(cacheJob, !persisted);
            } catch {
              finishBackgroundCacheJob(cacheJob, true);
            }
          })();
        });
      } catch (regenerationError) {
        const message = errorMessage(
          regenerationError,
          strings.errors.regenerateShotFallback(shot.id),
        );
        if (isCurrent()) setError(message);
        throw regenerationError instanceof Error ? regenerationError : new Error(message);
      } finally {
        if (isCurrent()) setBusyValue("regeneratingShotId", null);
      }
    },
    [
      beginProjectOperation,
      beginBackgroundCacheJob,
      finishBackgroundCacheJob,
      isProjectOperationCurrent,
      persistBackgroundIfCurrent,
      persistIfCurrent,
      scheduleBackgroundTask,
      setBusyValue,
      strings.errors,
    ],
  );

  const saveContinuity = useCallback(
    async (plan: ContinuityPlan): Promise<void> => {
      const current = snapshotRef.current;
      if (!current) throw new Error(strings.errors.createProjectFallback);
      const projectId = current.project.id;
      const token = beginProjectOperation("saveContinuity", projectId);
      const isCurrent = () => isProjectOperationCurrent(token);
      setBusyValue("savingContinuity", true);
      setError(null);
      try {
        const result = await saveContinuityPlan(projectId, plan);
        if (!isCurrent()) return;
        const latest = snapshotRef.current;
        if (!latest) return;
        applyProjectSnapshot({
          ...latest,
          project: result.project,
          continuity_plan: result.continuity_plan,
        });
        const refreshed = await refreshAuthoritativeProject(projectId, isCurrent);
        if (refreshed && snapshotRef.current) {
          await persistIfCurrent(
            projectId,
            mergeAuthoritativeMediaOverlays(refreshed, snapshotRef.current),
            isCurrent,
          );
        }
      } catch (continuityError) {
        const message = errorMessage(continuityError, strings.errors.saveContinuityFallback);
        if (isCurrent()) setError(message);
        throw continuityError instanceof Error ? continuityError : new Error(message);
      } finally {
        if (isCurrent()) setBusyValue("savingContinuity", false);
      }
    },
    [
      applyProjectSnapshot,
      beginProjectOperation,
      isProjectOperationCurrent,
      persistIfCurrent,
      refreshAuthoritativeProject,
      setBusyValue,
      strings.errors.createProjectFallback,
      strings.errors.saveContinuityFallback,
    ],
  );

  const uploadReference = useCallback(
    async (payload: ReferenceImageUploadRequest): Promise<void> => {
      const current = snapshotRef.current;
      if (!current) throw new Error(strings.errors.uploadReferenceFallback);
      const projectId = current.project.id;
      const token = beginProjectOperation("uploadReference", projectId);
      const isCurrent = () => isProjectOperationCurrent(token);
      setBusyValue("uploadingReference", true);
      setError(null);
      try {
        const result = await uploadReferenceImage(projectId, payload);
        if (!isCurrent()) return;
        const latest = snapshotRef.current;
        if (!latest) return;
        const uploadedAsset = {
          ...result.asset,
          media_urls: [...(result.asset.media_urls ?? []), result.media.media_url],
        };
        applyProjectSnapshot({
          ...latest,
          series_bible: {
            ...latest.series_bible,
            assets: [...(latest.series_bible.assets ?? []), uploadedAsset],
          },
        });
        const refreshed = await refreshAuthoritativeProject(projectId, isCurrent);
        if (refreshed && snapshotRef.current) {
          await persistIfCurrent(
            projectId,
            mergeAuthoritativeMediaOverlays(refreshed, snapshotRef.current),
            isCurrent,
          );
        }
      } catch (uploadError) {
        const message = errorMessage(uploadError, strings.errors.uploadReferenceFallback);
        if (isCurrent()) setError(message);
        throw uploadError instanceof Error ? uploadError : new Error(message);
      } finally {
        if (isCurrent()) setBusyValue("uploadingReference", false);
      }
    },
    [
      applyProjectSnapshot,
      beginProjectOperation,
      isProjectOperationCurrent,
      persistIfCurrent,
      refreshAuthoritativeProject,
      setBusyValue,
      strings.errors.uploadReferenceFallback,
    ],
  );

  const renderFinal = useCallback(async (): Promise<void> => {
    const current = snapshotRef.current;
    if (!current?.storyboard.shots.length) {
      const message = strings.errors.renderRequiresStoryboard;
      setError(message);
      throw new Error(message);
    }

    const projectId = current.project.id;
    const token = beginProjectOperation("render", projectId);
    const isCurrent = () => isProjectOperationCurrent(token);
    setBusyValue("rendering", true);
    setError(null);
    const responseBaseRevision = snapshotRevisionRef.current;
    try {
      const result = await renderProject(projectId, {
        render_runtime: "ffmpeg",
      });
      if (!isCurrent()) return;
      const latest = snapshotRef.current;
      if (!latest) return;
      setEvents((items) => appendUniqueEvent(items, result.event));
      const remoteSnapshot = mergeRenderResponse(
        latest,
        result,
        responseBaseRevision !== snapshotRevisionRef.current,
      );
      await persistIfCurrent(projectId, remoteSnapshot, isCurrent);
      if (!isCurrent()) return;

      const publishedRevision = snapshotRevisionRef.current;
      const responseSource = result.final_path;
      const responseEntityVersion = JSON.stringify(result.render_report.outputs);
      const projectIncarnation = storageVersionRef.current.projectId === projectId
        ? storageVersionRef.current.version?.incarnation
        : undefined;
      const cacheJob = beginBackgroundCacheJob();
      scheduleBackgroundTask(() => {
        void (async () => {
          try {
            let selectedSource = responseSource;
            let selectedReport = result.render_report;
            const responseIsCurrent = () => (
              isCurrent()
              && snapshotRevisionRef.current >= publishedRevision
              && snapshotRef.current?.final_path === responseSource
              && JSON.stringify(snapshotRef.current.render_report?.outputs ?? []) === responseEntityVersion
            );

            let authoritative: ShortDramaProjectResponse | null = null;
            try {
              authoritative = await refreshAuthoritativeProject(projectId, responseIsCurrent);
            } catch {
              // The persisted POST result remains authoritative when refresh is unavailable.
            }
            if (!isCurrent()) {
              finishBackgroundCacheJob(cacheJob, false);
              return;
            }
            if (
              authoritative
              && isCompleteRenderSource(authoritative.final_path, authoritative.render_report)
              && responseIsCurrent()
            ) {
              const currentSnapshot = snapshotRef.current;
              if (!currentSnapshot) {
                finishBackgroundCacheJob(cacheJob, false);
                return;
              }
              selectedSource = authoritative.final_path as string;
              selectedReport = authoritative.render_report as RenderReport;
              const persisted = await persistBackgroundIfCurrent(
                projectId,
                (latestSnapshot) => ({
                  ...latestSnapshot,
                  render_report: selectedReport,
                  final_path: selectedSource,
                }),
                responseIsCurrent,
              );
              if (!persisted) throw new Error("Render reconciliation was not persisted");
            }

            const sourceRevision = snapshotRevisionRef.current;
            const selectedEntityVersion = JSON.stringify(selectedReport.outputs);
            const promotionIsCurrent = () => (
              isCurrent()
              && snapshotRevisionRef.current >= sourceRevision
              && snapshotRef.current?.final_path === selectedSource
              && JSON.stringify(snapshotRef.current.render_report?.outputs ?? []) === selectedEntityVersion
            );
            if (!promotionIsCurrent()) {
              finishBackgroundCacheJob(cacheJob, false);
              return;
            }
            const url = mediaUrl(selectedSource, projectId);
            if (!url) throw new Error("Final render URL is unavailable");
            const localRef = await cacheRemoteMedia(url, {
              projectId,
              projectIncarnation,
              sourcePath: selectedSource,
            });
            if (!localRef) throw new Error("Final render was not cached");
            if (!promotionIsCurrent()) {
              finishBackgroundCacheJob(cacheJob, false);
              return;
            }
            const persisted = await persistBackgroundIfCurrent(
              projectId,
              (currentSnapshot) => ({ ...currentSnapshot, final_path: localRef }),
              promotionIsCurrent,
            );
            finishBackgroundCacheJob(cacheJob, !persisted);
          } catch {
            finishBackgroundCacheJob(cacheJob, true);
          }
        })();
      });
    } catch (renderError) {
      const message = errorMessage(renderError, strings.errors.renderFallback);
      if (isCurrent()) setError(message);
      throw renderError instanceof Error ? renderError : new Error(message);
    } finally {
      if (isCurrent()) setBusyValue("rendering", false);
    }
  }, [
    beginBackgroundCacheJob,
    beginProjectOperation,
    finishBackgroundCacheJob,
    isProjectOperationCurrent,
    persistBackgroundIfCurrent,
    persistIfCurrent,
    refreshAuthoritativeProject,
    scheduleBackgroundTask,
    setBusyValue,
    strings.errors,
  ]);

  const downloadFinal = useCallback(async (): Promise<void> => {
    const current = snapshotRef.current;
    const finalPath = current?.final_path;
    if (!current || !finalPath) return;
    const token = beginProjectOperation("download", current.project.id);
    const isCurrent = () => isProjectOperationCurrent(token);
    setBusyValue("downloading", true);
    setError(null);
    try {
      let blob: Blob | null;
      if (isLocalMediaRef(finalPath)) {
        blob = await loadMediaBlob(finalPath);
      } else {
        const url = mediaUrl(finalPath, current.project.id);
        if (!url) throw new Error(strings.errors.downloadFinalVideoFallback);
        const response = await fetch(url);
        if (!response.ok) throw new Error(strings.errors.downloadFinalVideoFallback);
        blob = await response.blob();
      }
      if (!blob || typeof URL.createObjectURL !== "function") {
        throw new Error(strings.errors.downloadFinalVideoFallback);
      }
      if (!isCurrent()) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${sanitizeDownloadName(current.project.title || current.project.id)}-final.mp4`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (downloadError) {
      const message = errorMessage(downloadError, strings.errors.downloadFinalVideoFallback);
      if (isCurrent()) setError(message);
      throw downloadError instanceof Error ? downloadError : new Error(message);
    } finally {
      if (isCurrent()) setBusyValue("downloading", false);
    }
  }, [
    beginProjectOperation,
    isProjectOperationCurrent,
    setBusyValue,
    strings.errors.downloadFinalVideoFallback,
  ]);

  const resolveDisplayMedia = useCallback(
    (path: string | null | undefined): string | null => {
      if (isLocalMediaRef(path)) return localMediaUrls[path] ?? null;
      return mediaUrl(path, snapshot?.project.id);
    },
    [localMediaUrls, snapshot?.project.id],
  );

  const resolveShotMedia = useCallback(
    (shot: Shot) => resolveDisplayMedia(shot.output_path ?? shot.output_url),
    [resolveDisplayMedia],
  );

  const finalRenderUrl = useMemo(
    () => resolveDisplayMedia(snapshot?.final_path),
    [resolveDisplayMedia, snapshot?.final_path],
  );

  const value: WorkbenchContextValue = {
    snapshot,
    selectedShotId,
    events,
    error,
    finalRenderUrl,
    localMediaUrls,
    localBackupStatus,
    busy,
    openLocalProject,
    createProject,
    selectShot: setSelectedShotId,
    optimizeShotPrompt,
    saveShotChanges,
    regenerateSelectedShot,
    saveContinuity,
    uploadReference,
    renderFinal,
    downloadFinal,
    resolveShotMedia,
    clearError: () => setError(null),
  };

  return (
    <WorkbenchContext.Provider value={value}>
      {inRouterContext ? (
        <ProjectLoadRouteObserver onRouteProjectChange={handleRouteProjectChange} />
      ) : null}
      {children}
    </WorkbenchContext.Provider>
  );
}
