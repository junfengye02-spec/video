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
  AddAssetToProjectResponse,
  AssetRecord,
  ContinuityPlan,
  CreativePlanReviseRequest,
  DraftProjectRequest,
  GenerateImagesRequest,
  GenerateImagesResponse,
  GenerationPlan,
  GenerationPlanPreviewRequest,
  GenerationUnitsGenerateRequest,
  GenerationUnitsGenerateResponse,
  InspirationChatRequest,
  InspirationAttachment,
  InspirationIntentUpdateRequest,
  JobEvent,
  ListAssetsRequest,
  ListAssetsResponse,
  MediaAsset,
  MediaAssetKind,
  PlanSectionId,
  PlanSectionUpdateRequest,
  PromptOptimizeResponse,
  ProductionConnectionState,
  ReferenceImageUploadRequest,
  ReferenceImageUploadResponse,
  RenderPreparation,
  RenderProjectResponse,
  RenderReport,
  ShortDramaProjectResponse,
  Shot,
  ShotSaveRequest,
  TaskBatch,
  TaskListResponse,
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
import {
  createWorkbenchCommandContract,
  saveSnapshotIfVersionCurrent,
  type WorkbenchCommandContract,
} from "./commandContract";

const CREATE_PROJECT_TOKEN_ID = "__create__";

const INITIAL_TARGETS = {
  optimizingShotId: null as string | null,
  regeneratingShotId: null as string | null,
  savingShotId: null as string | null,
  updatingPlanSection: null as PlanSectionId | null,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isCreativePlanConflict(error: unknown): boolean {
  if (!isRecord(error) || error.status !== 409) return false;
  return error.code === "plan_section_revision_conflict"
    || error.code === "creative_plan_revision_conflict";
}

function mediaAssetRecord(asset: MediaAsset): AssetRecord {
  return {
    id: asset.id,
    kind: asset.kind,
    label: asset.label,
    description: asset.description,
    prompt: asset.prompt,
    reference_images: asset.status === "ready" && asset.media_url ? [asset.media_url] : [],
    media_urls: [],
    origin_project_id: asset.origin_project_id,
    source_type: asset.source_type,
    model: asset.model,
    generation_job_id: asset.generation_job_id,
    media_url: asset.media_url,
    status: asset.status,
    created_at: asset.created_at,
    provenance: asset.provenance ?? null,
    version: 1,
  };
}

function mergeAssetRecords(current: AssetRecord[], incoming: AssetRecord[]): AssetRecord[] {
  const merged = new Map(current.map((asset) => [asset.id, asset]));
  for (const asset of incoming) merged.set(asset.id, asset);
  return Array.from(merged.values());
}

function sanitizeDownloadName(value: string | null | undefined): string {
  return (value?.trim() || "openmontage")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80);
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

function compositionIdempotencyKey(
  projectId: string,
  selectedShotIds?: string[],
): string {
  const randomId = globalThis.crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const scope = selectedShotIds?.length ?? 0;
  return `composition:${projectId.slice(0, 32)}:${scope}:${randomId}`;
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
  const planningRequestRef = useRef<{
    projectId: string;
    promise: Promise<ShortDramaProjectResponse>;
  } | null>(null);
  const pendingOpenRef = useRef<OperationToken | null>(null);
  const storageVersionRef = useRef<{
    projectId: string | null;
    version: LocalProjectVersion | null;
  }>({ projectId: null, version: null });
  const mountedRef = useRef(true);
  const previousProjectIdRef = useRef<string | null>(null);
  const productionConnectionRef = useRef<ProductionConnectionState>("connecting");
  const refreshProductionInFlightRef = useRef<{
    projectId: string;
    promise: Promise<void>;
  } | null>(null);
  const resolvingMediaRefsRef = useRef(new Set<string>());
  const failedMediaRefsRef = useRef(new Set<string>());
  const mediaGenerationRef = useRef(0);
  const backgroundCacheGenerationRef = useRef(0);
  const nextBackgroundCacheJobRef = useRef(0);
  const backgroundCacheJobsRef = useRef(new Map<number, LocalBackupStatus>());
  const scheduledBackgroundTasksRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const scheduledFinalCachesRef = useRef(new Set<string>());
  const [operationTargets, setOperationTargets] = useState(INITIAL_TARGETS);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [localMediaUrls, setLocalMediaUrls] = useState<Partial<Record<LocalMediaRef, string>>>({});
  const [mediaWakeVersion, setMediaWakeVersion] = useState(0);
  const [localBackupStatus, setLocalBackupStatus] = useState<LocalBackupStatus>("idle");
  const [productionConnection, setProductionConnection] = useState<ProductionConnectionState>("connecting");
  const commandContractRef = useRef<WorkbenchCommandContract | null>(null);
  if (!commandContractRef.current) {
    commandContractRef.current = createWorkbenchCommandContract(() => mountedRef.current);
  }

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
    commandContractRef.current?.invalidate();
    planningRequestRef.current = null;
    pendingOpenRef.current = null;
    clearScheduledBackgroundTasks();
    resetLocalBackupState();
    setDownloadBusy(false);
    setOperationTargets(INITIAL_TARGETS);
  }, [clearScheduledBackgroundTasks, resetLocalBackupState]);

  const beginToken = useCallback((
    projectId: string,
    kind: OperationToken["kind"],
  ): OperationToken => commandContractRef.current!.begin(projectId, kind), []);

  const isCurrent = useCallback((token: OperationToken): boolean => (
    Boolean(commandContractRef.current?.isCurrent(token))
    && (token.kind !== "open" || pendingOpenRef.current === token)
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
        const finalOutput = snapshot.final_path === sourcePath
          ? snapshot.render_report?.outputs.find((output) => (
            output.path === sourcePath || output.media_url === sourcePath
          ))
          : undefined;
        const expectedSize = Number.isSafeInteger(finalOutput?.file_size_bytes)
          ? finalOutput?.file_size_bytes
          : null;
        if (
          record
          && record.projectId === projectId
          && record.sourcePath === sourcePath
          && (record.state === undefined || record.state === "committed")
          && (expectedSize === null || record.sizeBytes === expectedSize)
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
    let saveResult;
    try {
      saveResult = await saveSnapshotIfVersionCurrent({
        snapshot: candidate,
        expectedVersion: stored.version,
        isCurrent: () => (
          stateRef.current.snapshot?.project.id === projectId
          && isSnapshotCurrent()
        ),
        saveIfVersion: (next, expectedVersion) => projects.saveIfVersion(next, expectedVersion),
      });
    } catch {
      return false;
    }
    if (saveResult.status !== "committed") return true;
    const saved = saveResult.version;

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

  const refreshProductionSnapshot = useCallback(async (
    projectId: string,
  ): Promise<ShortDramaProjectResponse | null> => {
    const snapshot = await refreshAuthoritativeProject(
      projectId,
      () => stateRef.current.snapshot?.project.id === projectId,
    );
    if (!snapshot || stateRef.current.snapshot?.project.id !== projectId) return null;
    await persistSnapshot(
      projectId,
      snapshot,
      () => stateRef.current.snapshot?.project.id === projectId,
    );
    if (stateRef.current.snapshot?.project.id !== projectId) return null;
    send({
      type: "snapshotUpdated",
      projectId,
      snapshot,
      merge: "render-result",
    });
    return snapshot;
  }, [persistSnapshot, refreshAuthoritativeProject, send]);

  const refreshTaskSnapshot = useCallback(async (
    projectId: string,
  ): Promise<ShortDramaProjectResponse | null> => {
    const snapshot = await refreshAuthoritativeProject(
      projectId,
      () => stateRef.current.snapshot?.project.id === projectId,
    );
    if (!snapshot || stateRef.current.snapshot?.project.id !== projectId) return null;
    const current = stateRef.current.snapshot;
    const merged = current
      ? mergeAuthoritativeMediaOverlays(snapshot, current)
      : snapshot;
    send({ type: "snapshotUpdated", projectId, snapshot: merged });
    return merged;
  }, [refreshAuthoritativeProject, send]);

  const recoverCreativePlanConflict = useCallback(async (
    error: unknown,
    token: OperationToken,
  ): Promise<boolean> => {
    if (!isCreativePlanConflict(error)) return false;
    try {
      const authoritative = await projects.refresh(token.projectId);
      if (!isCurrent(token)) return true;
      const current = stateRef.current.snapshot;
      const snapshot = current
        ? mergeAuthoritativeMediaOverlays(authoritative, current)
        : authoritative;
      send({ type: "operationSucceeded", token, snapshot });
      await persistSnapshot(token.projectId, snapshot, () => (
        isCurrent(token) && stateRef.current.snapshot?.project.id === token.projectId
      ));
      return true;
    } catch {
      return false;
    }
  }, [isCurrent, persistSnapshot, projects, send]);

  const scheduleBackgroundTask = useCallback((task: () => void, delayMs = 0) => {
    const generation = backgroundCacheGenerationRef.current;
    const timer = setTimeout(() => {
      scheduledBackgroundTasksRef.current.delete(timer);
      if (!mountedRef.current || generation !== backgroundCacheGenerationRef.current) return;
      task();
    }, delayMs);
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

  const scheduleAssetMediaCache = useCallback((
    projectId: string,
    assetId: string,
    sourcePath: string,
  ) => {
    const url = media.remoteUrl(sourcePath, projectId);
    if (!url || !sourcePath) return;
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
          if (!localRef) throw new Error("Resource media was not cached");
          const isAssetCurrent = () => {
            if (stateRef.current.snapshot?.project.id !== projectId) return false;
            const current = stateRef.current.snapshot.series_bible.assets?.find(
              (asset) => asset.id === assetId,
            );
            return Boolean(
              current
              && (
                current.media_url === sourcePath
                || current.reference_images.includes(sourcePath)
                || current.media_urls?.includes(sourcePath)
              ),
            );
          };
          const persisted = await persistBackgroundIfCurrent(
            projectId,
            (snapshot) => ({
              ...snapshot,
              series_bible: {
                ...snapshot.series_bible,
                assets: snapshot.series_bible.assets?.map((asset) => (
                  asset.id !== assetId
                    ? asset
                    : {
                      ...asset,
                      media_url: asset.media_url === sourcePath ? localRef : asset.media_url,
                      reference_images: asset.reference_images.map((value) => (
                        value === sourcePath ? localRef : value
                      )),
                      media_urls: asset.media_urls?.map((value) => (
                        value === sourcePath ? localRef : value
                      )),
                    }
                )),
              },
            }),
            isAssetCurrent,
          );
          finishBackgroundCacheJob(cacheJob, !persisted);
        } catch {
          finishBackgroundCacheJob(cacheJob, true);
        }
      })();
    });
  }, [
    beginBackgroundCacheJob,
    finishBackgroundCacheJob,
    media,
    persistBackgroundIfCurrent,
    scheduleBackgroundTask,
  ]);

  const scheduleFinalMediaCache = useCallback((
    projectId: string,
    sourcePath: string,
    renderReport: RenderReport,
  ) => {
    if (!sourcePath || isLocalMediaRef(sourcePath)) return;
    const url = media.remoteUrl(sourcePath, projectId);
    if (!url) return;
    const entityVersion = JSON.stringify(renderReport.outputs);
    const cacheKey = `${projectId}:${sourcePath}:${entityVersion}`;
    if (scheduledFinalCachesRef.current.has(cacheKey)) return;
    scheduledFinalCachesRef.current.add(cacheKey);
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
          if (!localRef) throw new Error("Final render was not cached");
          const isFinalCurrent = () => (
            stateRef.current.snapshot?.project.id === projectId
            && stateRef.current.snapshot.final_path === sourcePath
            && JSON.stringify(stateRef.current.snapshot.render_report?.outputs ?? [])
              === entityVersion
          );
          if (!isFinalCurrent()) {
            finishBackgroundCacheJob(cacheJob, false);
            return;
          }
          const persisted = await persistBackgroundIfCurrent(
            projectId,
            (snapshot) => ({ ...snapshot, final_path: localRef }),
            isFinalCurrent,
          );
          finishBackgroundCacheJob(cacheJob, !persisted);
        } catch {
          finishBackgroundCacheJob(cacheJob, true);
        }
      })();
    });
  }, [
    beginBackgroundCacheJob,
    finishBackgroundCacheJob,
    media,
    persistBackgroundIfCurrent,
    scheduleBackgroundTask,
  ]);

  useEffect(() => {
    const snapshot = state.snapshot;
    if (!snapshot?.final_path || !snapshot.render_report) return;
    scheduleFinalMediaCache(
      snapshot.project.id,
      snapshot.final_path,
      snapshot.render_report,
    );
  }, [scheduleFinalMediaCache, state.snapshot]);

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
    productionConnectionRef.current = "connecting";
    setProductionConnection("connecting");
    let subscriptionActive = true;
    try {
      const unsubscribe = generation.subscribe(projectId, (event: JobEvent) => {
        if (!subscriptionActive) return;
        send({ type: "eventReceived", event });
        if (event.stage === "render" && ["complete", "failed"].includes(event.status)) {
          void refreshProductionSnapshot(projectId).catch(() => undefined);
        }
        if (event.stage === "task_item"
          && ["complete", "failed", "cancelled"].includes(event.status)) {
          void refreshTaskSnapshot(projectId).catch(() => undefined);
        }
      }, {
        onConnectionChange: (next) => {
          if (!subscriptionActive || stateRef.current.snapshot?.project.id !== projectId) return;
          const reconnecting = productionConnectionRef.current === "disconnected"
            && next === "connected";
          productionConnectionRef.current = next;
          setProductionConnection(next);
          if (reconnecting) {
            void refreshProductionSnapshot(projectId).catch(() => undefined);
            void refreshTaskSnapshot(projectId).catch(() => undefined);
          }
        },
      });
      return () => {
        subscriptionActive = false;
        unsubscribe();
      };
    } catch (subscriptionError) {
      productionConnectionRef.current = "disconnected";
      setProductionConnection("disconnected");
      send({
        type: "errorRaised",
        error: errorMessage(subscriptionError, strings.errors.renderFallback),
      });
      return undefined;
    }
  }, [generation, refreshProductionSnapshot, refreshTaskSnapshot, send, state.snapshot?.project.id, strings.errors.renderFallback]);

  useEffect(() => {
    const projectId = state.snapshot?.project.id;
    if (!projectId || productionConnection !== "disconnected") return undefined;
    let active = true;
    const poll = () => {
      if (!active || stateRef.current.snapshot?.project.id !== projectId) return;
      void Promise.all([
        refreshTaskSnapshot(projectId),
        refreshProductionSnapshot(projectId),
      ]).catch(() => undefined);
    };
    poll();
    const timer = globalThis.setInterval(poll, 2_000);
    return () => {
      active = false;
      globalThis.clearInterval(timer);
    };
  }, [productionConnection, refreshProductionSnapshot, refreshTaskSnapshot, state.snapshot?.project.id]);

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
    commandContractRef.current?.invalidateKind("open");
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

  const createDraft = useCallback(async (
    input: DraftProjectRequest,
  ): Promise<ShortDramaProjectResponse> => {
    invalidateSession();
    const token = beginToken(CREATE_PROJECT_TOKEN_ID, "create");
    send({ type: "operationStarted", token });
    try {
      const result = await projects.createDraft(input);
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

  const planStoryboard = useCallback(async (
    prompt: string,
    controlEndFrames?: boolean,
    textModel?: string,
  ): Promise<ShortDramaProjectResponse> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.createProjectFallback);
    const pending = planningRequestRef.current;
    if (pending?.projectId === current.project.id) return pending.promise;
    ensureWritable();
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      throw new Error(strings.errors.createStoryboardRequiresPrompt);
    }

    const request = (async () => {
      const token = beginToken(current.project.id, "create");
      send({ type: "operationStarted", token });
      try {
        const planInput: Parameters<typeof projects.planStoryboard>[1] = {
          prompt: normalizedPrompt,
          project_type: current.project.project_type
            ?? current.continuity_plan?.project_type
            ?? "single_video",
          control_end_frames: controlEndFrames
            ?? current.creative_workflow?.control_end_frames
            ?? false,
        };
        const normalizedTextModel = textModel?.trim();
        if (normalizedTextModel) planInput.text_model = normalizedTextModel;
        const result = await projects.planStoryboard(current.project.id, planInput);
        if (isCurrent(token)) {
          const snapshot = { ...result, final_path: null };
          send({
            type: "operationSucceeded",
            token,
            snapshot,
            selectedShotId: snapshot.storyboard.shots[0]?.id ?? null,
          });
          await persistSnapshot(result.project.id, snapshot, () => (
            stateRef.current.snapshot?.project.id === result.project.id
          ));
        }
        return result;
      } catch (planningError) {
        const message = errorMessage(planningError, strings.errors.createProjectFallback);
        if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
        throw planningError instanceof Error ? planningError : new Error(message);
      }
    })();
    const pendingRequest = { projectId: current.project.id, promise: request };
    planningRequestRef.current = pendingRequest;
    try {
      return await request;
    } finally {
      if (planningRequestRef.current === pendingRequest) planningRequestRef.current = null;
    }
  }, [
    beginToken,
    ensureWritable,
    isCurrent,
    persistSnapshot,
    projects,
    strings.errors,
  ]);

  const developInspiration = useCallback(async (
    input: InspirationChatRequest,
    onDelta?: (text: string) => void,
  ): Promise<ShortDramaProjectResponse> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.createProjectFallback);
    ensureWritable();
    if (!input.messages.length) {
      throw new Error(strings.errors.createStoryboardRequiresPrompt);
    }

    const token = beginToken(current.project.id, "inspiration");
    send({ type: "operationStarted", token });
    try {
      const result = await projects.developInspiration(current.project.id, input, onDelta);
      if (isCurrent(token)) {
        const snapshot = { ...result, final_path: result.final_path ?? null };
        send({ type: "operationSucceeded", token, snapshot });
        await persistSnapshot(result.project.id, snapshot, () => (
          stateRef.current.snapshot?.project.id === result.project.id
        ));
      }
      return result;
    } catch (inspirationError) {
      const message = errorMessage(inspirationError, strings.errors.createProjectFallback);
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw inspirationError instanceof Error ? inspirationError : new Error(message);
    }
  }, [
    beginToken,
    ensureWritable,
    isCurrent,
    persistSnapshot,
    projects,
    strings.errors,
  ]);

  const uploadInspirationAttachment = useCallback(async (file: File): Promise<InspirationAttachment> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.createProjectFallback);
    ensureWritable();
    return projects.uploadInspirationAttachment(current.project.id, file);
  }, [ensureWritable, projects, strings.errors.createProjectFallback]);

  const updateInspirationIntent = useCallback(async (
    input: InspirationIntentUpdateRequest,
  ): Promise<ShortDramaProjectResponse> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.createProjectFallback);
    ensureWritable();
    const projectId = current.project.id;
    const result = await projects.updateInspirationIntent(projectId, input);
    if (stateRef.current.snapshot?.project.id === projectId) {
      const snapshot = { ...result, final_path: result.final_path ?? null };
      send({ type: "snapshotUpdated", projectId, snapshot });
      await persistSnapshot(projectId, snapshot, () => (
        stateRef.current.snapshot?.project.id === projectId
      ));
    }
    return result;
  }, [
    ensureWritable,
    persistSnapshot,
    projects,
    send,
    strings.errors.createProjectFallback,
  ]);

  const approveStoryboard = useCallback(async (): Promise<ShortDramaProjectResponse> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.createProjectFallback);
    ensureWritable();

    const token = beginToken(current.project.id, "approve-plan");
    send({ type: "operationStarted", token });
    try {
      const result = await projects.approveStoryboard(current.project.id);
      if (isCurrent(token)) {
        const snapshot = { ...result, final_path: result.final_path ?? null };
        send({ type: "operationSucceeded", token, snapshot });
        await persistSnapshot(result.project.id, snapshot, () => (
          stateRef.current.snapshot?.project.id === result.project.id
        ));
      }
      return result;
    } catch (approvalError) {
      const message = errorMessage(approvalError, strings.errors.createProjectFallback);
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw approvalError instanceof Error ? approvalError : new Error(message);
    }
  }, [
    beginToken,
    ensureWritable,
    isCurrent,
    persistSnapshot,
    projects,
    strings.errors.createProjectFallback,
  ]);

  const updatePlanSection = useCallback(async (
    section: PlanSectionId,
    input: PlanSectionUpdateRequest,
  ): Promise<ShortDramaProjectResponse> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.createProjectFallback);
    ensureWritable();

    const token = beginToken(current.project.id, "update-plan-section");
    setOperationTargets((targets) => ({ ...targets, updatingPlanSection: section }));
    send({ type: "operationStarted", token });
    try {
      const result = await projects.updatePlanSection(current.project.id, section, input);
      if (isCurrent(token)) {
        const snapshot = { ...result, final_path: result.final_path ?? null };
        send({ type: "operationSucceeded", token, snapshot });
        await persistSnapshot(result.project.id, snapshot, () => (
          stateRef.current.snapshot?.project.id === result.project.id
        ));
      }
      return result;
    } catch (updateError) {
      if (await recoverCreativePlanConflict(updateError, token)) throw updateError;
      const message = errorMessage(updateError, strings.errors.createProjectFallback);
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw updateError instanceof Error ? updateError : new Error(message);
    }
  }, [
    beginToken,
    ensureWritable,
    isCurrent,
    persistSnapshot,
    projects,
    recoverCreativePlanConflict,
    strings.errors.createProjectFallback,
  ]);

  const reviseCreativePlan = useCallback(async (
    input: CreativePlanReviseRequest,
  ): Promise<ShortDramaProjectResponse> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.createProjectFallback);
    ensureWritable();

    const token = beginToken(current.project.id, "revise-plan");
    send({ type: "operationStarted", token });
    try {
      const result = await generation.reviseCreativePlan(current.project.id, input);
      if (isCurrent(token)) {
        const snapshot = { ...result, final_path: result.final_path ?? null };
        send({ type: "operationSucceeded", token, snapshot });
        await persistSnapshot(result.project.id, snapshot, () => (
          stateRef.current.snapshot?.project.id === result.project.id
        ));
      }
      return result;
    } catch (revisionError) {
      if (await recoverCreativePlanConflict(revisionError, token)) throw revisionError;
      const message = errorMessage(revisionError, strings.errors.createProjectFallback);
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw revisionError instanceof Error ? revisionError : new Error(message);
    }
  }, [
    beginToken,
    ensureWritable,
    generation,
    isCurrent,
    persistSnapshot,
    recoverCreativePlanConflict,
    strings.errors.createProjectFallback,
  ]);

  const runStoryboardRevisionTransition = useCallback(async (
    transition: "begin" | "cancel",
  ): Promise<ShortDramaProjectResponse> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.createProjectFallback);
    ensureWritable();

    const token = beginToken(current.project.id, "revise-plan");
    send({ type: "operationStarted", token });
    try {
      const result = transition === "begin"
        ? await projects.beginStoryboardRevision(current.project.id)
        : await projects.cancelStoryboardRevision(current.project.id);
      if (isCurrent(token)) {
        const snapshot = { ...result, final_path: result.final_path ?? null };
        send({ type: "operationSucceeded", token, snapshot });
        await persistSnapshot(result.project.id, snapshot, () => (
          stateRef.current.snapshot?.project.id === result.project.id
        ));
      }
      return result;
    } catch (transitionError) {
      const message = errorMessage(transitionError, strings.errors.createProjectFallback);
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw transitionError instanceof Error ? transitionError : new Error(message);
    }
  }, [
    beginToken,
    ensureWritable,
    isCurrent,
    persistSnapshot,
    projects,
    strings.errors.createProjectFallback,
  ]);

  const beginStoryboardRevision = useCallback(
    () => runStoryboardRevisionTransition("begin"),
    [runStoryboardRevisionTransition],
  );
  const cancelStoryboardRevision = useCallback(
    () => runStoryboardRevisionTransition("cancel"),
    [runStoryboardRevisionTransition],
  );

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

  const optimizeImagePrompt = useCallback(async (
    kind: MediaAssetKind,
    sourceText: string,
    billingJobId?: string,
  ): Promise<PromptOptimizeResponse> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.optimizeShotFallback);
    ensureWritable();

    const token = beginToken(current.project.id, "optimize");
    setOperationTargets((targets) => ({ ...targets, optimizingShotId: null }));
    send({ type: "operationStarted", token });
    try {
      const result = await generation.optimizeImagePrompt(
        current.project.id,
        kind,
        sourceText,
        billingJobId,
      );
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

  const regenerateSelectedShot = useCallback(async (
    shot: Shot,
    videoModel?: string,
  ): Promise<void> => {
    const current = stateRef.current.snapshot;
    if (!current) return;
    ensureWritable();

    const projectId = current.project.id;
    const token = beginToken(projectId, "regenerate");
    setOperationTargets((targets) => ({ ...targets, regeneratingShotId: shot.id }));
    send({ type: "operationStarted", token });
    send({ type: "shotSelected", shotId: shot.id });
    try {
      await generation.regenerate(projectId, shot.id, videoModel);
      if (!isCurrent(token)) return;
      send({ type: "operationSucceeded", token, selectedShotId: shot.id });
    } catch (regenerationError) {
      const message = errorMessage(
        regenerationError,
        strings.errors.regenerateShotFallback(shot.id),
      );
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw regenerationError instanceof Error ? regenerationError : new Error(message);
    }
  }, [
    beginToken,
    ensureWritable,
    generation,
    isCurrent,
    strings.errors.regenerateShotFallback,
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
  ): Promise<ReferenceImageUploadResponse> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.uploadReferenceFallback);
    ensureWritable();

    const projectId = current.project.id;
    const token = beginToken(projectId, "upload");
    send({ type: "operationStarted", token });
    try {
      const result = await generation.uploadReference(projectId, payload);
      if (!isCurrent(token)) return result;
      const latest = stateRef.current.snapshot;
      if (!latest) return result;
      const uploadedAsset = {
        ...result.asset,
        media_urls: [...(result.asset.media_urls ?? []), result.media.media_url],
      };
      let snapshot: ShortDramaProjectResponse = {
        ...latest,
        series_bible: {
          ...latest.series_bible,
          assets: mergeAssetRecords(latest.series_bible.assets ?? [], [uploadedAsset]),
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
      if (!isCurrent(token)) return result;
      send({ type: "operationSucceeded", token, snapshot });
      await persistSnapshot(projectId, snapshot, () => stateRef.current.snapshot?.project.id === projectId);
      scheduleAssetMediaCache(projectId, uploadedAsset.id, result.media.media_url);
      return result;
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
    scheduleAssetMediaCache,
    strings.errors.uploadReferenceFallback,
  ]);

  const updatePlannedAssetPrompt = useCallback(async (
    assetId: string,
    payload: { prompt: string },
  ): Promise<void> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.resources.generateError);
    ensureWritable();
    const projectId = current.project.id;
    const result = await generation.updatePlannedAssetPrompt(projectId, assetId, payload);
    const latest = stateRef.current.snapshot;
    if (latest?.project.id !== projectId) return;
    const snapshot: ShortDramaProjectResponse = {
      ...latest,
      series_bible: {
        ...latest.series_bible,
        assets: mergeAssetRecords(latest.series_bible.assets ?? [], [result.asset]),
      },
    };
    send({ type: "snapshotUpdated", projectId, snapshot });
    await persistSnapshot(projectId, snapshot, () => stateRef.current.snapshot?.project.id === projectId);
  }, [ensureWritable, generation, persistSnapshot, send, strings.resources.generateError]);

  const listAssets = useCallback(
    (payload: ListAssetsRequest): Promise<ListAssetsResponse> => generation.listAssets(payload),
    [generation],
  );

  const listTasks = useCallback((): Promise<TaskListResponse> => {
    const projectId = stateRef.current.snapshot?.project.id;
    if (!projectId) return Promise.resolve({ tasks: [] });
    return generation.listTasks(projectId);
  }, [generation]);

  const retryTaskItem = useCallback((taskId: string, itemId: string): Promise<TaskBatch> => {
    const projectId = stateRef.current.snapshot?.project.id;
    if (!projectId) throw new Error(strings.resources.generateError);
    ensureWritable();
    return generation.retryTaskItem(projectId, taskId, itemId);
  }, [ensureWritable, generation, strings.resources.generateError]);

  const generateImages = useCallback(async (
    payload: GenerateImagesRequest,
  ): Promise<GenerateImagesResponse> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.resources.generateError);
    ensureWritable();
    const projectId = current.project.id;
    return generation.generateImages(projectId, payload);
  }, [
    ensureWritable,
    generation,
    strings.resources.generateError,
  ]);

  const generateGenerationUnits = useCallback(async (
    payload: GenerationUnitsGenerateRequest,
  ): Promise<GenerationUnitsGenerateResponse> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.regenerateShotFallback(""));
    ensureWritable();
    const projectId = current.project.id;
    const response = await generation.generateGenerationUnits(projectId, payload);
    await refreshTaskSnapshot(projectId).catch(() => undefined);
    return response;
  }, [ensureWritable, generation, refreshTaskSnapshot, strings.errors]);

  const previewGenerationPlan = useCallback(async (
    payload: GenerationPlanPreviewRequest,
  ): Promise<GenerationPlan> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.errors.regenerateShotFallback(""));
    ensureWritable();
    return generation.previewGenerationPlan(current.project.id, payload);
  }, [ensureWritable, generation, strings.errors]);

  const addAssetToProject = useCallback(async (
    assetId: string,
  ): Promise<AddAssetToProjectResponse> => {
    const current = stateRef.current.snapshot;
    if (!current) throw new Error(strings.resources.addError);
    ensureWritable();
    const projectId = current.project.id;
    const result = await generation.addAssetToProject(projectId, assetId);
    const latest = stateRef.current.snapshot;
    if (latest?.project.id !== projectId) return result;
    const libraryMetadata = mediaAssetRecord(result.library_asset);
    const projectAsset: AssetRecord = {
      ...libraryMetadata,
      ...result.asset,
      reference_images: result.asset.reference_images.length
        ? result.asset.reference_images
        : libraryMetadata.reference_images,
    };
    const snapshot: ShortDramaProjectResponse = {
      ...latest,
      series_bible: {
        ...latest.series_bible,
        assets: mergeAssetRecords(latest.series_bible.assets ?? [], [projectAsset]),
      },
    };
    send({ type: "snapshotUpdated", projectId, snapshot });
    await persistSnapshot(projectId, snapshot, () => stateRef.current.snapshot?.project.id === projectId);
    return result;
  }, [ensureWritable, generation, persistSnapshot, send, strings.resources.addError]);

  const prepareFinalRender = useCallback(async (selectedShotIds?: string[]): Promise<RenderPreparation> => {
    const current = stateRef.current.snapshot;
    if (!current?.storyboard.shots.length) {
      const message = strings.errors.renderRequiresStoryboard;
      send({ type: "errorRaised", error: message });
      throw new Error(message);
    }
    ensureWritable();
    const projectId = current.project.id;
    const token = beginToken(projectId, "prepare-render");
    send({ type: "operationStarted", token });
    try {
      const preparation = await generation.prepareRender(projectId, selectedShotIds);
      if (isCurrent(token)) send({ type: "operationSucceeded", token });
      return preparation;
    } catch (prepareError) {
      const message = errorMessage(prepareError, strings.errors.renderFallback);
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw prepareError instanceof Error ? prepareError : new Error(message);
    }
  }, [beginToken, ensureWritable, generation, isCurrent, send, strings.errors]);

  const refreshProduction = useCallback(async (): Promise<void> => {
    const current = stateRef.current.snapshot;
    if (!current) return;
    const projectId = current.project.id;
    const inFlight = refreshProductionInFlightRef.current;
    if (inFlight?.projectId === projectId) {
      await inFlight.promise;
      return;
    }
    const token = beginToken(projectId, "refresh-production");
    send({ type: "operationStarted", token });
    const promise = (async () => {
      try {
        const snapshot = await refreshAuthoritativeProject(
          projectId,
          () => isCurrent(token),
        );
        if (!snapshot || !isCurrent(token)) return;
        send({
          type: "operationSucceeded",
          token,
          snapshot,
          merge: "render-result",
        });
      } catch (refreshError) {
        const message = errorMessage(refreshError, strings.errors.renderFallback);
        if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
        throw refreshError instanceof Error ? refreshError : new Error(message);
      }
    })();
    refreshProductionInFlightRef.current = { projectId, promise };
    try {
      await promise;
    } finally {
      if (refreshProductionInFlightRef.current?.promise === promise) {
        refreshProductionInFlightRef.current = null;
      }
    }
  }, [beginToken, isCurrent, refreshAuthoritativeProject, send, strings.errors.renderFallback]);

  const renderFinal = useCallback(async (selectedShotIds?: string[]): Promise<void> => {
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
    try {
      await generation.compose(projectId, {
        ...(selectedShotIds ? { selected_shot_ids: selectedShotIds } : {}),
        idempotency_key: compositionIdempotencyKey(projectId, selectedShotIds),
      });
      if (!isCurrent(token)) return;
      send({ type: "operationSucceeded", token });
      scheduleBackgroundTask(() => {
        void refreshProductionSnapshot(projectId).catch(() => undefined);
      });
    } catch (renderError) {
      const message = errorMessage(renderError, strings.errors.renderFallback);
      if (isCurrent(token)) send({ type: "operationFailed", token, error: message });
      throw renderError instanceof Error ? renderError : new Error(message);
    }
  }, [
    beginToken,
    ensureWritable,
    generation,
    isCurrent,
    refreshProductionSnapshot,
    scheduleBackgroundTask,
    send,
    strings.errors,
  ]);

  const downloadFinal = useCallback(async (): Promise<void> => {
    const current = stateRef.current.snapshot;
    const finalPath = current?.final_path;
    if (!current || !finalPath) return;
    setDownloadBusy(true);
    send({ type: "errorCleared" });
    try {
      const sourceFilename = finalPath.split("/").pop() || "final.mp4";
      const filename = `${sanitizeDownloadName(current.project.title || current.project.id)}-${
        /^episode-\d+\.mp4$/i.test(sourceFilename) ? sourceFilename : "final.mp4"
      }`;
      const clickDownload = (href: string) => {
        const link = document.createElement("a");
        link.href = href;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
      };
      if (isLocalMediaRef(finalPath)) {
        const blob = await media.load(finalPath);
        if (!blob || typeof URL.createObjectURL !== "function") {
          throw new Error(strings.errors.downloadFinalVideoFallback);
        }
        if (stateRef.current.snapshot?.project.id !== current.project.id) return;
        const url = URL.createObjectURL(blob);
        clickDownload(url);
        URL.revokeObjectURL(url);
      } else {
        const url = media.remoteUrl(finalPath, current.project.id);
        if (!url) throw new Error(strings.errors.downloadFinalVideoFallback);
        if (stateRef.current.snapshot?.project.id !== current.project.id) return;
        clickDownload(url);
      }
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
    approvingPlan: Boolean(state.operations["approve-plan"]),
    creating: Boolean(state.operations.create),
    developingIdea: Boolean(state.operations.inspiration),
    downloading: downloadBusy,
    preparingRender: Boolean(state.operations["prepare-render"]),
    refreshingProduction: Boolean(state.operations["refresh-production"]),
    optimizingShotId: state.operations.optimize ? operationTargets.optimizingShotId : null,
    regeneratingShotId: state.operations.regenerate ? operationTargets.regeneratingShotId : null,
    rendering: Boolean(state.operations.render),
    revisingPlan: Boolean(state.operations["revise-plan"]),
    savingContinuity: Boolean(state.operations["save-continuity"]),
    savingShotId: state.operations["save-shot"] ? operationTargets.savingShotId : null,
    uploadingReference: Boolean(state.operations.upload),
    updatingPlanSection: state.operations["update-plan-section"]
      ? operationTargets.updatingPlanSection
      : null,
  }), [downloadBusy, operationTargets, state.operations]);

  const value: WorkbenchContextValue = {
    snapshot: state.snapshot,
    selectedShotId: state.selectedShotId,
    events: state.events,
    productionConnection,
    error: state.error,
    load: state.load,
    readOnly: state.load === "stale",
    finalRenderUrl,
    localMediaUrls,
    localBackupStatus,
    busy,
    openLocalProject,
    createProject,
    createDraft,
    developInspiration,
    uploadInspirationAttachment,
    updateInspirationIntent,
    planStoryboard,
    approveStoryboard,
    beginStoryboardRevision,
    cancelStoryboardRevision,
    updatePlanSection,
    reviseCreativePlan,
    selectShot: (shotId) => send({ type: "shotSelected", shotId }),
    optimizeShotPrompt,
    optimizeImagePrompt,
    saveShotChanges,
    regenerateSelectedShot,
    saveContinuity,
    listAssets,
    listTasks,
    generateImages,
    previewGenerationPlan,
    generateGenerationUnits,
    retryTaskItem,
    addAssetToProject,
    uploadReference,
    updatePlannedAssetPrompt,
    prepareFinalRender,
    refreshProduction,
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
