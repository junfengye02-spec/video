import {
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { matchPath, useInRouterContext, useLocation } from "react-router-dom";
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
import {
  generationService as defaultGenerationService,
  type GenerationService,
} from "../generation/GenerationService";
import {
  projectRepository as defaultProjectRepository,
  type ProjectRepository,
} from "../projects/ProjectRepository";
import {
  mediaRepository as defaultMediaRepository,
  type MediaRepository,
} from "../../platform/storage/MediaRepository";
import { detectLocale, getStrings } from "../../i18n";
import type { LocalMediaRef, LocalProjectVersion } from "../../localdb/types";
import {
  applyCommittedMediaOverlays,
  collectRemoteMediaSourcePaths,
  mergeAuthoritativeMediaOverlays,
} from "../../app/workbench/snapshot";
import type {
  CreateProjectInput,
  LocalBackupStatus,
  WorkbenchBusyState,
  WorkbenchContextValue,
} from "../../app/workbench/types";
import {
  initialWorkbenchState,
  reduceWorkbench,
  type OperationToken,
  type WorkbenchState,
} from "./reducer";

const CREATE_PROJECT_TOKEN_ID = "__create__";

const INITIAL_TARGETS = {
  optimizingShotId: null as string | null,
  regeneratingShotId: null as string | null,
  savingShotId: null as string | null,
};

type BackgroundCacheJobToken = {
  generation: number;
  id: number;
};

export interface WorkbenchSessionProviderProps {
  children: ReactNode;
  generation?: GenerationService;
  media?: MediaRepository;
  projects?: ProjectRepository;
}

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
  preserveLatest = true,
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
        version: cachedShot.version,
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
  preserveLatest = true,
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

export function WorkbenchSessionProvider({
  children,
  generation = defaultGenerationService,
  media = defaultMediaRepository,
  projects = defaultProjectRepository,
}: WorkbenchSessionProviderProps) {
  const inRouterContext = useInRouterContext();
  const strings = useMemo(
    () => getStrings(detectLocale(globalThis.navigator?.language)),
    [],
  );
  const [state, dispatch] = useReducer(reduceWorkbench, initialWorkbenchState);
  const stateRef = useRef<WorkbenchState>(state);
  const snapshotRevisionRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const operationSequencesRef = useRef<Partial<Record<OperationToken["kind"], number>>>({});
  const pendingOpenRef = useRef<OperationToken | null>(null);
  const storageVersionRef = useRef<{
    projectId: string | null;
    version: LocalProjectVersion | null;
  }>({ projectId: null, version: null });
  const mountedRef = useRef(true);
  const previousProjectIdRef = useRef<string | null>(null);
  const resolvingMediaRefsRef = useRef(new Set<string>());
  const failedMediaRefsRef = useRef(new Set<string>());
  const mediaGenerationRef = useRef(0);
  const backgroundCacheGenerationRef = useRef(0);
  const nextBackgroundCacheJobRef = useRef(0);
  const backgroundCacheJobsRef = useRef(new Map<number, LocalBackupStatus>());
  const scheduledBackgroundTasksRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [operationTargets, setOperationTargets] = useState(INITIAL_TARGETS);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [localMediaUrls, setLocalMediaUrls] = useState<Partial<Record<LocalMediaRef, string>>>({});
  const [mediaWakeVersion, setMediaWakeVersion] = useState(0);
  const [localBackupStatus, setLocalBackupStatus] = useState<LocalBackupStatus>("idle");

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const send = useCallback((action: Parameters<typeof reduceWorkbench>[1]) => {
    const previous = stateRef.current;
    const next = reduceWorkbench(previous, action);
    if (next.snapshot !== previous.snapshot) {
      snapshotRevisionRef.current += 1;
    }
    stateRef.current = next;
    dispatch(action);
  }, []);

  const recordStorageVersion = useCallback((
    projectId: string | null,
    version: LocalProjectVersion | null,
  ) => {
    storageVersionRef.current = { projectId, version };
  }, []);

  const refreshStorageEstimate = useCallback(async () => {
    try {
      await media.estimate();
    } catch {
      // Browser storage estimates are best-effort hints.
    }
  }, [media]);

  const updateLocalBackupStatus = useCallback(() => {
    if (!mountedRef.current) return;
    const jobs = Array.from(backgroundCacheJobsRef.current.values());
    setLocalBackupStatus(
      jobs.includes("saving") ? "saving" : jobs.includes("retrying") ? "retrying" : "idle",
    );
  }, []);

  const clearScheduledBackgroundTasks = useCallback(() => {
    scheduledBackgroundTasksRef.current.forEach((timer) => clearTimeout(timer));
    scheduledBackgroundTasksRef.current.clear();
  }, []);

  const resetLocalBackupState = useCallback(() => {
    backgroundCacheGenerationRef.current += 1;
    backgroundCacheJobsRef.current.clear();
    setLocalBackupStatus("idle");
  }, []);

  const resetMediaResolver = useCallback((projectId?: string | null) => {
    mediaGenerationRef.current += 1;
    resolvingMediaRefsRef.current.clear();
    failedMediaRefsRef.current.clear();
    if (projectId) media.revokeProject(projectId);
    else media.revokeAll();
    setLocalMediaUrls({});
    setMediaWakeVersion((current) => current + 1);
  }, [media]);

  const invalidateSession = useCallback(() => {
    operationGenerationRef.current += 1;
    operationSequencesRef.current = {};
    pendingOpenRef.current = null;
    clearScheduledBackgroundTasks();
    resetLocalBackupState();
    setDownloadBusy(false);
    setOperationTargets(INITIAL_TARGETS);
  }, [clearScheduledBackgroundTasks, resetLocalBackupState]);

  const beginToken = useCallback((
    projectId: string,
    kind: OperationToken["kind"],
  ): OperationToken => {
    const generation = ++operationGenerationRef.current;
    operationSequencesRef.current[kind] = generation;
    return { projectId, kind, generation };
  }, []);

  const isCurrent = useCallback((token: OperationToken): boolean => (
    mountedRef.current
    && (token.kind !== "open" || pendingOpenRef.current === token)
    && operationSequencesRef.current[token.kind] === token.generation
  ), []);

  const ensureWritable = useCallback(() => {
    if (stateRef.current.load !== "stale") return;
    const message = strings.errors.readOnlyProjectFallback;
    send({ type: "errorRaised", error: message });
    throw new Error(message);
  }, [send, strings.errors.readOnlyProjectFallback]);

  const persistSnapshot = useCallback(async (
    projectId: string,
    snapshot: ShortDramaProjectResponse,
    isSnapshotCurrent: () => boolean,
  ) => {
    if (!isSnapshotCurrent()) return;
    try {
      const saved = await projects.save(snapshot);
      if (saved) recordStorageVersion(projectId, saved);
      void refreshStorageEstimate();
    } catch {
      if (isSnapshotCurrent()) {
        send({ type: "errorRaised", error: strings.errors.localProjectSaveFallback });
      }
    }
  }, [
    projects,
    recordStorageVersion,
    refreshStorageEstimate,
    send,
    strings.errors.localProjectSaveFallback,
  ]);

  const hydrateCommittedMedia = useCallback(async (
    projectId: string,
    snapshot: ShortDramaProjectResponse,
    version: LocalProjectVersion | null,
  ): Promise<ShortDramaProjectResponse> => {
    const overlays = new Map<string, LocalMediaRef>();
    const projectIncarnation = version?.incarnation ?? `legacy:${projectId}`;
    await Promise.all(collectRemoteMediaSourcePaths(snapshot).map(async (sourcePath) => {
      try {
        const record = await media.findCommitted(projectId, sourcePath, projectIncarnation);
        if (
          record
          && record.projectId === projectId
          && record.sourcePath === sourcePath
          && (record.state === undefined || record.state === "committed")
        ) {
          overlays.set(sourcePath, `local://media/${record.id}`);
        }
      } catch {
        // A local index failure must not make the project snapshot unavailable.
      }
    }));
    return applyCommittedMediaOverlays(snapshot, overlays);
  }, [media]);

  const persistBackgroundIfCurrent = useCallback(async (
    projectId: string,
    mutate: (current: ShortDramaProjectResponse) => ShortDramaProjectResponse,
    isSnapshotCurrent: () => boolean,
  ): Promise<boolean> => {
    const current = stateRef.current.snapshot;
    const stored = storageVersionRef.current;
    if (
      current?.project.id !== projectId
      || !isSnapshotCurrent()
      || stored.projectId !== projectId
      || !stored.version
    ) {
      return true;
    }

    const memoryRevision = snapshotRevisionRef.current;
    const candidate = mutate(current);
    let saved: LocalProjectVersion | null;
    try {
      saved = await projects.saveIfVersion(candidate, stored.version);
    } catch {
      return false;
    }
    if (!saved) return true;

    const latest = stateRef.current.snapshot;
    if (
      latest?.project.id !== projectId
      || !isSnapshotCurrent()
      || memoryRevision !== snapshotRevisionRef.current
    ) {
      if (latest?.project.id !== projectId) return true;
      try {
        const repaired = await projects.saveIfVersion(latest, saved);
        if (repaired) recordStorageVersion(projectId, repaired);
        return true;
      } catch {
        return false;
      }
    }

    recordStorageVersion(projectId, saved);
    send({ type: "snapshotUpdated", projectId, snapshot: candidate });
    void refreshStorageEstimate();
    return true;
  }, [projects, recordStorageVersion, refreshStorageEstimate, send]);

  const refreshAuthoritativeProject = useCallback(async (
    projectId: string,
    isSnapshotCurrent: () => boolean,
  ): Promise<ShortDramaProjectResponse | null> => {
    const firstRevision = snapshotRevisionRef.current;
    const first = await projects.refresh(projectId);
    if (!isSnapshotCurrent()) return null;
    if (firstRevision === snapshotRevisionRef.current) return first;

    const retryRevision = snapshotRevisionRef.current;
    const retry = await projects.refresh(projectId);
    if (!isSnapshotCurrent()) return null;
    return retryRevision === snapshotRevisionRef.current ? retry : stateRef.current.snapshot;
  }, [projects]);

  const scheduleBackgroundTask = useCallback((task: () => void) => {
    const generation = backgroundCacheGenerationRef.current;
    const timer = setTimeout(() => {
      scheduledBackgroundTasksRef.current.delete(timer);
      if (!mountedRef.current || generation !== backgroundCacheGenerationRef.current) return;
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

  useEffect(() => {
    mountedRef.current = true;
    void refreshStorageEstimate();
    const controller = media.startRecovery();
    return () => {
      mountedRef.current = false;
      invalidateSession();
      controller.dispose();
      media.revokeAll();
      failedMediaRefsRef.current.clear();
    };
  }, [invalidateSession, media, refreshStorageEstimate]);

  useEffect(() => {
    const projectId = state.snapshot?.project.id ?? null;
    if (!projectId) return;
    const previousProjectId = previousProjectIdRef.current;
    previousProjectIdRef.current = projectId;
    if (previousProjectId && previousProjectId !== projectId) {
      resetMediaResolver(previousProjectId);
    }
  }, [resetMediaResolver, state.snapshot?.project.id]);

  useEffect(() => {
    const projectId = state.snapshot?.project.id;
    if (!projectId) return undefined;
    try {
      return generation.subscribe(projectId, (event: JobEvent) => {
        send({ type: "eventReceived", event });
      });
    } catch (subscriptionError) {
      send({
        type: "errorRaised",
        error: errorMessage(subscriptionError, strings.errors.renderFallback),
      });
      return undefined;
    }
  }, [generation, state.snapshot?.project.id, strings.errors.renderFallback]);

  useEffect(() => {
    const snapshot = state.snapshot;
    const projectId = snapshot?.project.id ?? null;
    const generationId = mediaGenerationRef.current;
    const refs = Array.from(collectLocalMediaRefs(snapshot));
    const currentRefs = new Set(refs);
    const hasOrphan = Object.keys(localMediaUrls).some((ref) => !currentRefs.has(ref as LocalMediaRef));
    if (hasOrphan) {
      resetMediaResolver(projectId);
      return;
    }

    refs.forEach((ref) => {
      const pendingKey = `${generationId}:${projectId ?? ""}:${ref}`;
      if (
        localMediaUrls[ref]
        || resolvingMediaRefsRef.current.has(pendingKey)
        || failedMediaRefsRef.current.has(pendingKey)
      ) {
        return;
      }
      resolvingMediaRefsRef.current.add(pendingKey);
      void media.resolve(ref)
        .then((url) => {
          if (!url) {
            failedMediaRefsRef.current.add(pendingKey);
            return;
          }
          failedMediaRefsRef.current.delete(pendingKey);
          if (
            !mountedRef.current
            || mediaGenerationRef.current !== generationId
            || stateRef.current.snapshot?.project.id !== projectId
            || !collectLocalMediaRefs(stateRef.current.snapshot).has(ref)
          ) {
            if (mountedRef.current) resetMediaResolver(projectId);
            else media.revokeAll();
            return;
          }
          setLocalMediaUrls((current) => ({ ...current, [ref]: url }));
        })
        .catch(() => {
          failedMediaRefsRef.current.add(pendingKey);
        })
        .finally(() => {
          resolvingMediaRefsRef.current.delete(pendingKey);
          if (mountedRef.current) setMediaWakeVersion((current) => current + 1);
        });
    });
  }, [localMediaUrls, media, mediaWakeVersion, resetMediaResolver, state.snapshot]);

  const handleRouteProjectChange = useCallback((routeProjectId: string | null) => {
    const pending = pendingOpenRef.current;
    if (!pending || pending.projectId === routeProjectId) return;
    pendingOpenRef.current = null;
    operationGenerationRef.current += 1;
    delete operationSequencesRef.current.open;
  }, []);

  const openLocalProject = useCallback(async (projectId: string): Promise<boolean> => {
    invalidateSession();
    recordStorageVersion(null, null);
    const token = beginToken(projectId, "open");
    pendingOpenRef.current = token;
    send({ type: "openStarted", token });
    try {
      const cached = await projects.open(projectId);
      if (!isCurrent(token)) return Boolean(cached);
      if (!cached) {
        send({ type: "openMissing", token });
        pendingOpenRef.current = null;
        return false;
      }
      const hydrated = await hydrateCommittedMedia(projectId, cached.snapshot, cached.version);
      if (!isCurrent(token)) return true;
      recordStorageVersion(projectId, cached.version);
      let recentError = false;
      try {
        await projects.markRecent(projectId);
      } catch {
        recentError = true;
      }
      if (!isCurrent(token)) return true;
      send({
        type: "openSucceeded",
        token,
        snapshot: hydrated,
        stale: cached.freshness === "stale" || !cached.writable,
      });
      pendingOpenRef.current = null;
      if (recentError) {
        send({ type: "errorRaised", error: strings.errors.localProjectSaveFallback });
      }
      return true;
    } catch (loadError) {
      const message = errorMessage(loadError, strings.projectsPage.loadError);
      if (isCurrent(token)) {
        send({ type: "operationFailed", token, error: message });
        pendingOpenRef.current = null;
      }
      throw loadError instanceof Error ? loadError : new Error(message);
    }
  }, [
    beginToken,
    hydrateCommittedMedia,
    invalidateSession,
    isCurrent,
    projects,
    recordStorageVersion,
    strings.errors.localProjectSaveFallback,
  ]);

  const createProject = useCallback(async (
    input: CreateProjectInput,
  ): Promise<ShortDramaProjectResponse> => {
    if (!input.prompt.trim()) {
      const message = strings.errors.createStoryboardRequiresPrompt;
      send({ type: "errorRaised", error: message });
      throw new Error(message);
    }

    invalidateSession();
    const token = beginToken(CREATE_PROJECT_TOKEN_ID, "create");
    send({ type: "operationStarted", token });
    try {
      const result = await projects.create({
        title: input.title,
        prompt: input.prompt,
        project_type: input.project_type,
      });
      if (isCurrent(token)) {
        const snapshot = { ...result, final_path: null };
        send({ type: "operationSucceeded", token, snapshot });
        await persistSnapshot(result.project.id, snapshot, () => (
          stateRef.current.snapshot?.project.id === result.project.id
        ));
      }
      return result;
    } catch (creationError) {
      const message = errorMessage(creationError, strings.errors.createProjectFallback);
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw creationError instanceof Error ? creationError : new Error(message);
    }
  }, [beginToken, invalidateSession, isCurrent, persistSnapshot, projects, strings.errors]);

  const optimizeShotPrompt = useCallback(async (
    shot: Shot,
    sourceText: string,
  ): Promise<PromptOptimizeResponse> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.optimizeShotFallback);
    ensureWritable();

    const token = beginToken(current.project.id, "optimize");
    setOperationTargets((targets) => ({ ...targets, optimizingShotId: shot.id }));
    send({ type: "operationStarted", token });
    try {
      const result = await generation.optimize(current.project.id, shot.id, sourceText);
      if (isCurrent(token)) send({ type: "operationSucceeded", token });
      return result;
    } catch (optimizationError) {
      const message = errorMessage(optimizationError, strings.errors.optimizeShotFallback);
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw optimizationError instanceof Error ? optimizationError : new Error(message);
    }
  }, [beginToken, ensureWritable, generation, isCurrent, strings.errors.optimizeShotFallback]);

  const saveShotChanges = useCallback(async (
    shotId: string,
    payload: ShotSaveRequest,
  ): Promise<Shot> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.saveShotFallback);
    ensureWritable();

    const projectId = current.project.id;
    const token = beginToken(projectId, "save-shot");
    setOperationTargets((targets) => ({ ...targets, savingShotId: shotId }));
    send({ type: "operationStarted", token });
    try {
      const result = await generation.saveShot(projectId, shotId, payload);
      if (!isCurrent(token)) return result.shot;
      const latest = stateRef.current.snapshot;
      if (!latest) return result.shot;
      const snapshot = {
        ...latest,
        storyboard: result.storyboard,
        consistency_report: result.consistency_report,
        render_report: null,
        final_path: null,
      };
      send({
        type: "operationSucceeded",
        token,
        snapshot,
        event: result.event,
        selectedShotId: shotId,
      });
      await persistSnapshot(projectId, snapshot, () => stateRef.current.snapshot?.project.id === projectId);
      return result.shot;
    } catch (saveError) {
      const message = errorMessage(saveError, strings.errors.saveShotFallback);
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw saveError instanceof Error ? saveError : new Error(message);
    }
  }, [beginToken, ensureWritable, generation, isCurrent, persistSnapshot, strings.errors.saveShotFallback]);

  const regenerateSelectedShot = useCallback(async (shot: Shot): Promise<void> => {
    const current = stateRef.current.snapshot;
    if (!current) return;
    ensureWritable();

    const projectId = current.project.id;
    const token = beginToken(projectId, "regenerate");
    const operationRevision = snapshotRevisionRef.current;
    setOperationTargets((targets) => ({ ...targets, regeneratingShotId: shot.id }));
    send({ type: "operationStarted", token });
    send({ type: "shotSelected", shotId: shot.id });
    try {
      const result = await generation.regenerate(projectId, shot.id);
      if (!isCurrent(token)) return;
      const latest = stateRef.current.snapshot;
      if (!latest) return;
      const snapshot = mergeRegeneratedSnapshot(
        latest,
        result.storyboard,
        result.shot,
        result.consistency_report,
        operationRevision !== snapshotRevisionRef.current,
      );
      send({
        type: "operationSucceeded",
        token,
        snapshot,
        event: result.event,
        selectedShotId: shot.id,
      });
      await persistSnapshot(projectId, snapshot, () => stateRef.current.snapshot?.project.id === projectId);
      if (!isCurrent(token)) return;

      const sourcePath = result.shot.output_path;
      const url = sourcePath && !isLocalMediaRef(sourcePath)
        ? media.remoteUrl(sourcePath, projectId)
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
            const localRef = await media.cacheRemote(url, {
              projectId,
              projectIncarnation,
              sourcePath,
            });
            if (!localRef) throw new Error("Remote media was not cached");
            const promotionIsCurrent = () => {
              if (!isCurrent(token) || snapshotRevisionRef.current < publishedRevision) return false;
              const currentShot = stateRef.current.snapshot?.storyboard.shots.find(
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
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw regenerationError instanceof Error ? regenerationError : new Error(message);
    }
  }, [
    beginBackgroundCacheJob,
    beginToken,
    ensureWritable,
    finishBackgroundCacheJob,
    generation,
    isCurrent,
    media,
    persistBackgroundIfCurrent,
    persistSnapshot,
    scheduleBackgroundTask,
    strings.errors,
  ]);

  const saveContinuity = useCallback(async (plan: ContinuityPlan): Promise<void> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.createProjectFallback);
    ensureWritable();

    const projectId = current.project.id;
    const token = beginToken(projectId, "save-continuity");
    send({ type: "operationStarted", token });
    try {
      const result = await generation.saveContinuity(projectId, plan);
      if (!isCurrent(token)) return;
      const latest = stateRef.current.snapshot;
      if (!latest) return;
      let snapshot: ShortDramaProjectResponse = {
        ...latest,
        project: result.project,
        continuity_plan: result.continuity_plan,
      };
      try {
        const refreshed = await refreshAuthoritativeProject(projectId, () => isCurrent(token));
        if (isCurrent(token) && stateRef.current.snapshot) {
          snapshot = refreshed
            ? mergeAuthoritativeMediaOverlays(refreshed, stateRef.current.snapshot)
            : snapshot;
        }
      } catch {
        // The PATCH response remains authoritative when refresh is unavailable.
      }
      if (!isCurrent(token)) return;
      send({ type: "operationSucceeded", token, snapshot });
      await persistSnapshot(projectId, snapshot, () => stateRef.current.snapshot?.project.id === projectId);
    } catch (continuityError) {
      const message = errorMessage(continuityError, strings.errors.saveContinuityFallback);
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw continuityError instanceof Error ? continuityError : new Error(message);
    }
  }, [
    beginToken,
    ensureWritable,
    generation,
    isCurrent,
    persistSnapshot,
    refreshAuthoritativeProject,
    strings.errors.createProjectFallback,
    strings.errors.saveContinuityFallback,
  ]);

  const uploadReference = useCallback(async (
    payload: ReferenceImageUploadRequest,
  ): Promise<void> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.uploadReferenceFallback);
    ensureWritable();

    const projectId = current.project.id;
    const token = beginToken(projectId, "upload");
    send({ type: "operationStarted", token });
    try {
      const result = await generation.uploadReference(projectId, payload);
      if (!isCurrent(token)) return;
      const latest = stateRef.current.snapshot;
      if (!latest) return;
      const uploadedAsset = {
        ...result.asset,
        media_urls: [...(result.asset.media_urls ?? []), result.media.media_url],
      };
      let snapshot: ShortDramaProjectResponse = {
        ...latest,
        series_bible: {
          ...latest.series_bible,
          assets: [...(latest.series_bible.assets ?? []), uploadedAsset],
        },
      };
      try {
        const refreshed = await refreshAuthoritativeProject(projectId, () => isCurrent(token));
        if (isCurrent(token) && stateRef.current.snapshot) {
          snapshot = refreshed
            ? mergeAuthoritativeMediaOverlays(refreshed, stateRef.current.snapshot)
            : snapshot;
        }
      } catch {
        // The upload response is enough to keep the UI usable.
      }
      if (!isCurrent(token)) return;
      send({ type: "operationSucceeded", token, snapshot });
      await persistSnapshot(projectId, snapshot, () => stateRef.current.snapshot?.project.id === projectId);
    } catch (uploadError) {
      const message = errorMessage(uploadError, strings.errors.uploadReferenceFallback);
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw uploadError instanceof Error ? uploadError : new Error(message);
    }
  }, [
    beginToken,
    ensureWritable,
    generation,
    isCurrent,
    persistSnapshot,
    refreshAuthoritativeProject,
    strings.errors.uploadReferenceFallback,
  ]);

  const renderFinal = useCallback(async (): Promise<void> => {
    const current = stateRef.current.snapshot;
    if (!current?.storyboard.shots.length) {
      const message = strings.errors.renderRequiresStoryboard;
      send({ type: "errorRaised", error: message });
      throw new Error(message);
    }
    ensureWritable();

    const projectId = current.project.id;
    const token = beginToken(projectId, "render");
    send({ type: "operationStarted", token });
    const responseBaseRevision = snapshotRevisionRef.current;
    try {
      const result = await generation.render(projectId);
      if (!isCurrent(token)) return;
      const latest = stateRef.current.snapshot;
      if (!latest) return;
      const snapshot = mergeRenderResponse(
        latest,
        result,
        responseBaseRevision !== snapshotRevisionRef.current,
      );
      if (!isCurrent(token)) return;
      send({
        type: "operationSucceeded",
        token,
        snapshot,
        event: result.event,
      });
      await persistSnapshot(projectId, snapshot, () => stateRef.current.snapshot?.project.id === projectId);
      if (!isCurrent(token)) return;

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
              isCurrent(token)
              && snapshotRevisionRef.current >= publishedRevision
              && stateRef.current.snapshot?.final_path === responseSource
              && JSON.stringify(stateRef.current.snapshot.render_report?.outputs ?? [])
                === responseEntityVersion
            );

            let authoritative: ShortDramaProjectResponse | null = null;
            try {
              authoritative = await refreshAuthoritativeProject(projectId, responseIsCurrent);
            } catch {
              // The persisted POST result remains authoritative when refresh is unavailable.
            }
            if (!isCurrent(token)) {
              finishBackgroundCacheJob(cacheJob, false);
              return;
            }
            if (
              authoritative
              && isCompleteRenderSource(authoritative.final_path, authoritative.render_report)
              && responseIsCurrent()
            ) {
              const currentSnapshot = stateRef.current.snapshot;
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
              isCurrent(token)
              && snapshotRevisionRef.current >= sourceRevision
              && stateRef.current.snapshot?.final_path === selectedSource
              && JSON.stringify(stateRef.current.snapshot.render_report?.outputs ?? [])
                === selectedEntityVersion
            );
            if (!promotionIsCurrent()) {
              finishBackgroundCacheJob(cacheJob, false);
              return;
            }
            const url = media.remoteUrl(selectedSource, projectId);
            if (!url) throw new Error("Final render URL is unavailable");
            const localRef = await media.cacheRemote(url, {
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
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw renderError instanceof Error ? renderError : new Error(message);
    }
  }, [
    beginBackgroundCacheJob,
    beginToken,
    ensureWritable,
    finishBackgroundCacheJob,
    generation,
    isCurrent,
    media,
    persistBackgroundIfCurrent,
    persistSnapshot,
    refreshAuthoritativeProject,
    scheduleBackgroundTask,
    strings.errors,
  ]);

  const downloadFinal = useCallback(async (): Promise<void> => {
    const current = stateRef.current.snapshot;
    const finalPath = current?.final_path;
    if (!current || !finalPath) return;
    setDownloadBusy(true);
    send({ type: "errorCleared" });
    try {
      let blob: Blob | null;
      if (isLocalMediaRef(finalPath)) {
        blob = await media.load(finalPath);
      } else {
        const url = media.remoteUrl(finalPath, current.project.id);
        if (!url) throw new Error(strings.errors.downloadFinalVideoFallback);
        const response = await fetch(url);
        if (!response.ok) throw new Error(strings.errors.downloadFinalVideoFallback);
        blob = await response.blob();
      }
      if (!blob || typeof URL.createObjectURL !== "function") {
        throw new Error(strings.errors.downloadFinalVideoFallback);
      }
      if (stateRef.current.snapshot?.project.id !== current.project.id) return;
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
      send({ type: "errorRaised", error: message });
      throw downloadError instanceof Error ? downloadError : new Error(message);
    } finally {
      if (mountedRef.current) setDownloadBusy(false);
    }
  }, [media, strings.errors.downloadFinalVideoFallback]);

  const resolveDisplayMedia = useCallback(
    (path: string | null | undefined): string | null => {
      if (isLocalMediaRef(path)) return localMediaUrls[path] ?? null;
      return media.remoteUrl(path, state.snapshot?.project.id);
    },
    [localMediaUrls, media, state.snapshot?.project.id],
  );

  const resolveShotMedia = useCallback(
    (shot: Shot) => resolveDisplayMedia(shot.output_path ?? shot.output_url),
    [resolveDisplayMedia],
  );

  const finalRenderUrl = useMemo(
    () => resolveDisplayMedia(state.snapshot?.final_path),
    [resolveDisplayMedia, state.snapshot?.final_path],
  );

  const busy = useMemo<WorkbenchBusyState>(() => ({
    creating: Boolean(state.operations.create),
    downloading: downloadBusy,
    optimizingShotId: state.operations.optimize ? operationTargets.optimizingShotId : null,
    regeneratingShotId: state.operations.regenerate ? operationTargets.regeneratingShotId : null,
    rendering: Boolean(state.operations.render),
    savingContinuity: Boolean(state.operations["save-continuity"]),
    savingShotId: state.operations["save-shot"] ? operationTargets.savingShotId : null,
    uploadingReference: Boolean(state.operations.upload),
  }), [downloadBusy, operationTargets, state.operations]);

  const value: WorkbenchContextValue = {
    snapshot: state.snapshot,
    selectedShotId: state.selectedShotId,
    events: state.events,
    error: state.error,
    load: state.load,
    readOnly: state.load === "stale",
    finalRenderUrl,
    localMediaUrls,
    localBackupStatus,
    busy,
    openLocalProject,
    createProject,
    selectShot: (shotId) => send({ type: "shotSelected", shotId }),
    optimizeShotPrompt,
    saveShotChanges,
    regenerateSelectedShot,
    saveContinuity,
    uploadReference,
    renderFinal,
    downloadFinal,
    resolveShotMedia,
    clearError: () => send({ type: "errorCleared" }),
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


