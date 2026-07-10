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
  saveGatewayKey,
  saveShot,
  subscribeProjectEvents,
  uploadReferenceImage,
} from "../../api/client";
import type {
  ContinuityPlan,
  ConsistencyReport,
  JobEvent,
  PromptOptimizeResponse,
  ProviderCredentials,
  ReferenceImageUploadRequest,
  RenderProjectResponse,
  RenderReport,
  ShortDramaProjectResponse,
  Shot,
  ShotSaveRequest,
  Storyboard,
} from "../../domain/types";
import { detectLocale, getStrings } from "../../i18n";
import { cacheRemoteMedia, loadMediaBlob } from "../../localdb/mediaStore";
import { resolveLocalMediaUrl, revokeLocalMediaUrls } from "../../localdb/mediaUrls";
import {
  loadProjectSnapshot,
  saveProjectSnapshot,
  setRecentProjectId,
} from "../../localdb/projectStore";
import { getStorageEstimate } from "../../localdb/storageEstimate";
import type { LocalMediaRef } from "../../localdb/types";
import { emptyContinuityPlan, mergeAuthoritativeMediaOverlays } from "./snapshot";
import type {
  CreateProjectInput,
  WorkbenchBusyState,
  WorkbenchContextValue,
} from "./types";

const DEFAULT_BASE_URL = "https://api.0000238.xyz";
const DEFAULT_TEXT_MODEL = "gpt-5.5";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_VIDEO_MODEL = "omni_flash-10s";

const INITIAL_CREDENTIALS: ProviderCredentials = {
  text_key: "",
  image_key: "",
  video_key: "",
  base_url: DEFAULT_BASE_URL,
  text_model: DEFAULT_TEXT_MODEL,
  image_model: DEFAULT_IMAGE_MODEL,
  video_model: DEFAULT_VIDEO_MODEL,
};

const INITIAL_BUSY: WorkbenchBusyState = {
  creating: false,
  downloading: false,
  optimizingShotId: null,
  regeneratingShotId: null,
  rendering: false,
  savingContinuity: false,
  savingProvider: false,
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

function normalizeCredentials(credentials: ProviderCredentials): ProviderCredentials {
  return {
    text_key: credentials.text_key.trim(),
    image_key: credentials.image_key.trim(),
    video_key: credentials.video_key.trim(),
    base_url: credentials.base_url.trim(),
    text_model: credentials.text_model.trim() || DEFAULT_TEXT_MODEL,
    image_model: credentials.image_model.trim() || DEFAULT_IMAGE_MODEL,
    video_model: credentials.video_model.trim() || DEFAULT_VIDEO_MODEL,
  };
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

function valueChanged(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

function mergeConcurrentSnapshotChanges(
  base: ShortDramaProjectResponse,
  beforeAwait: ShortDramaProjectResponse,
  afterAwait: ShortDramaProjectResponse,
): ShortDramaProjectResponse {
  return {
    ...base,
    project: valueChanged(beforeAwait.project, afterAwait.project) ? afterAwait.project : base.project,
    series_bible: valueChanged(beforeAwait.series_bible, afterAwait.series_bible)
      ? afterAwait.series_bible
      : base.series_bible,
    storyboard: valueChanged(beforeAwait.storyboard, afterAwait.storyboard)
      ? afterAwait.storyboard
      : base.storyboard,
    consistency_report: valueChanged(
      beforeAwait.consistency_report,
      afterAwait.consistency_report,
    ) ? afterAwait.consistency_report : base.consistency_report,
    continuity_plan: valueChanged(beforeAwait.continuity_plan, afterAwait.continuity_plan)
      ? afterAwait.continuity_plan
      : base.continuity_plan,
    workflow_artifacts: valueChanged(
      beforeAwait.workflow_artifacts,
      afterAwait.workflow_artifacts,
    ) ? afterAwait.workflow_artifacts : base.workflow_artifacts,
    render_report: valueChanged(beforeAwait.render_report, afterAwait.render_report)
      ? afterAwait.render_report
      : base.render_report,
    final_path: valueChanged(beforeAwait.final_path, afterAwait.final_path)
      ? afterAwait.final_path
      : base.final_path,
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
  const projectEpochRef = useRef(0);
  const operationSequencesRef = useRef({ ...INITIAL_OPERATION_SEQUENCES });
  const creationSequenceRef = useRef(0);
  const providerSaveSequenceRef = useRef(0);
  const projectLoadGenerationRef = useRef(0);
  const pendingProjectLoadRef = useRef<{ generation: number; projectId: string } | null>(null);
  const previousMediaProjectIdRef = useRef<string | null>(null);
  const mediaMountedRef = useRef(true);
  const resolvingMediaRefsRef = useRef(new Set<string>());
  const mediaGenerationRef = useRef(0);
  const mediaResetSnapshotRef = useRef<ShortDramaProjectResponse | null>(null);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [localMediaUrls, setLocalMediaUrls] = useState<
    Partial<Record<LocalMediaRef, string>>
  >({});
  const [mediaGeneration, setMediaGeneration] = useState(0);
  const [mediaWakeVersion, setMediaWakeVersion] = useState(0);
  const [providerCredentials, setProviderCredentials] = useState(INITIAL_CREDENTIALS);
  const [maskedKeys, setMaskedKeys] = useState<WorkbenchContextValue["maskedKeys"]>(null);
  const [busy, setBusy] = useState(INITIAL_BUSY);

  const setBusyValue = useCallback(
    <K extends keyof WorkbenchBusyState>(key: K, value: WorkbenchBusyState[K]) => {
      setBusy((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const invalidateProjectOperations = useCallback(() => {
    projectEpochRef.current += 1;
    projectLoadGenerationRef.current += 1;
    creationSequenceRef.current += 1;
    setBusy((current) => ({
      ...INITIAL_BUSY,
      savingProvider: current.savingProvider,
    }));
  }, []);

  const beginProjectOperation = useCallback(
    (name: ProjectOperationName, projectId: string): ProjectOperationToken => {
      const sequence = operationSequencesRef.current[name] + 1;
      operationSequencesRef.current[name] = sequence;
      return { epoch: projectEpochRef.current, name, projectId, sequence };
    },
    [],
  );

  const isProjectOperationCurrent = useCallback((token: ProjectOperationToken): boolean => (
    token.epoch === projectEpochRef.current
    && token.sequence === operationSequencesRef.current[token.name]
    && token.projectId === snapshotRef.current?.project.id
  ), []);

  const applyProjectSnapshot = useCallback((next: ShortDramaProjectResponse) => {
    const previousProjectId = snapshotRef.current?.project.id ?? null;
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
        await saveProjectSnapshot(next);
        void refreshStorageEstimate();
      } catch {
        if (isCurrent()) {
          setError(strings.errors.localProjectSaveFallback);
        }
      }
    },
    [applyProjectSnapshot, refreshStorageEstimate, strings.errors.localProjectSaveFallback],
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
    revokeLocalMediaUrls();
    setLocalMediaUrls({});
    setMediaGeneration(mediaGenerationRef.current);
  }, []);

  useEffect(() => {
    void refreshStorageEstimate();
  }, [refreshStorageEstimate]);

  useEffect(() => {
    const projectId = snapshot?.project.id ?? null;
    const previousProjectId = previousMediaProjectIdRef.current;
    previousMediaProjectIdRef.current = projectId;
    if (previousProjectId && previousProjectId !== projectId) {
      mediaResetSnapshotRef.current = snapshot;
      resetMediaResolver();
    }
  }, [resetMediaResolver, snapshot?.project.id]);

  useEffect(() => () => {
    mediaMountedRef.current = false;
    revokeLocalMediaUrls();
  }, []);

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
    const hasStaleResolution = Array.from(resolvingMediaRefsRef.current).some(
      (key) => !key.startsWith(`${generation}:`),
    );
    if (hasStaleResolution) return;
    const unresolved = refs.filter((ref) => {
      const pendingKey = `${generation}:${projectId ?? ""}:${ref}`;
      return !localMediaUrls[ref] && !resolvingMediaRefsRef.current.has(pendingKey);
    });
    if (unresolved.length === 0) return;

    unresolved.forEach((ref) => {
      const pendingKey = `${generation}:${projectId ?? ""}:${ref}`;
      resolvingMediaRefsRef.current.add(pendingKey);
      void resolveLocalMediaUrl(ref)
        .then((url) => {
          if (!url) return;
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
        .catch(() => undefined)
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

      applyProjectSnapshot(record.snapshot);
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
    [applyProjectSnapshot, invalidateProjectOperations, strings.errors.localProjectSaveFallback],
  );

  const createProject = useCallback(
    async (input: CreateProjectInput): Promise<ShortDramaProjectResponse> => {
      const credentials = normalizeCredentials(providerCredentials);
      if (
        !credentials.text_key
        || !credentials.image_key
        || !credentials.video_key
        || maskedKeys === null
      ) {
        const message = strings.errors.createStoryboardRequiresKeys;
        setError(message);
        throw new Error(message);
      }
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
          ...credentials,
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
      maskedKeys,
      providerCredentials,
      setBusyValue,
      strings.errors,
    ],
  );

  const saveProvider = useCallback(async () => {
    const credentials = normalizeCredentials(providerCredentials);
    if (!credentials.text_key || !credentials.image_key || !credentials.video_key) {
      const message = strings.errors.saveKeysRequiresAll;
      setError(message);
      throw new Error(message);
    }

    const sequence = providerSaveSequenceRef.current + 1;
    providerSaveSequenceRef.current = sequence;
    const isCurrent = () => sequence === providerSaveSequenceRef.current;
    setBusyValue("savingProvider", true);
    setError(null);
    try {
      const session = await saveGatewayKey(credentials);
      if (!isCurrent()) return;
      if (!session.valid) {
        setMaskedKeys(null);
        throw new Error(strings.errors.saveKeysFallback);
      }
      setMaskedKeys(session.masked_keys);
      setProviderCredentials((current) => ({
        ...current,
        base_url: session.base_url,
        text_model: session.models.text,
        image_model: session.models.image,
        video_model: session.models.video,
      }));
    } catch (providerError) {
      const message = errorMessage(providerError, strings.errors.saveKeysFallback);
      if (isCurrent()) setError(message);
      throw providerError instanceof Error ? providerError : new Error(message);
    } finally {
      if (isCurrent()) setBusyValue("savingProvider", false);
    }
  }, [providerCredentials, setBusyValue, strings.errors.saveKeysFallback, strings.errors.saveKeysRequiresAll]);

  const updateProviderField = useCallback(
    <K extends keyof ProviderCredentials>(key: K, value: ProviderCredentials[K]) => {
      if (providerCredentials[key] === value) return;
      providerSaveSequenceRef.current += 1;
      setMaskedKeys(null);
      setBusyValue("savingProvider", false);
      setProviderCredentials((current) => ({ ...current, [key]: value }));
    },
    [providerCredentials, setBusyValue],
  );

  const optimizeShotPrompt = useCallback(
    async (shot: Shot, sourceText: string): Promise<PromptOptimizeResponse> => {
      const current = snapshotRef.current;
      if (!current) throw new Error(strings.errors.optimizeShotFallback);
      const credentials = normalizeCredentials(providerCredentials);
      if (!credentials.text_key) {
        setError(strings.errors.missingTextKeyForOptimize);
        throw new Error(strings.errors.missingTextKeyForOptimize);
      }

      const token = beginProjectOperation("optimize", current.project.id);
      setBusyValue("optimizingShotId", shot.id);
      setError(null);
      try {
        return await optimizePrompt(current.project.id, {
          target: "shot",
          target_id: shot.id,
          source_text: sourceText,
          text_key: credentials.text_key,
          base_url: credentials.base_url || DEFAULT_BASE_URL,
          text_model: credentials.text_model,
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
      providerCredentials,
      setBusyValue,
      strings.errors.missingTextKeyForOptimize,
      strings.errors.optimizeShotFallback,
    ],
  );

  const saveShotChanges = useCallback(
    async (shotId: string, payload: ShotSaveRequest): Promise<void> => {
      const current = snapshotRef.current;
      if (!current) return;
      const projectId = current.project.id;
      const token = beginProjectOperation("saveShot", projectId);
      const isCurrent = () => isProjectOperationCurrent(token);
      setBusyValue("savingShotId", shotId);
      setError(null);
      try {
        const result = await saveShot(projectId, shotId, payload);
        if (!isCurrent()) return;
        const latest = snapshotRef.current;
        if (!latest) return;
        setSelectedShotId(shotId);
        setEvents((items) => appendUniqueEvent(items, result.event));
        await persistIfCurrent(projectId, {
          ...latest,
          storyboard: result.storyboard,
          consistency_report: result.consistency_report,
          render_report: null,
          final_path: null,
        }, isCurrent);
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

  const cacheShotMedia = useCallback(
    async (projectId: string, shot: Shot): Promise<Shot> => {
      if (!shot.output_path || isLocalMediaRef(shot.output_path)) return shot;
      const url = mediaUrl(shot.output_path, projectId);
      if (!url) return shot;
      const localRef = await cacheRemoteMedia(url, {
        projectId,
        sourcePath: shot.output_path,
      });
      if (!localRef) return shot;
      void refreshStorageEstimate();
      return { ...shot, output_path: localRef, output_url: null };
    },
    [refreshStorageEstimate],
  );

  const regenerateSelectedShot = useCallback(
    async (shot: Shot): Promise<void> => {
      const current = snapshotRef.current;
      if (!current) return;
      const credentials = normalizeCredentials(providerCredentials);
      if (!credentials.video_key) {
        const message = strings.errors.missingVideoKeyForRegenerate;
        setError(message);
        throw new Error(message);
      }

      const projectId = current.project.id;
      const token = beginProjectOperation("regenerate", projectId);
      const isCurrent = () => isProjectOperationCurrent(token);
      const operationRevision = snapshotRevisionRef.current;
      setSelectedShotId(shot.id);
      setBusyValue("regeneratingShotId", shot.id);
      setError(null);
      try {
        const result = await regenerateShot(projectId, shot.id, {
          video_key: credentials.video_key,
          base_url: credentials.base_url,
          video_model: credentials.video_model,
        });
        const cachedShot = await cacheShotMedia(projectId, result.shot);
        if (!isCurrent()) return;
        const latest = snapshotRef.current;
        if (!latest) return;
        setEvents((items) => appendUniqueEvent(items, result.event));
        await persistIfCurrent(
          projectId,
          mergeRegeneratedSnapshot(
            latest,
            result.storyboard,
            cachedShot,
            result.consistency_report,
            operationRevision !== snapshotRevisionRef.current,
          ),
          isCurrent,
        );
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
      cacheShotMedia,
      isProjectOperationCurrent,
      persistIfCurrent,
      providerCredentials,
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

  const cacheFinalRender = useCallback(
    async (projectId: string, path: string | null): Promise<string | null> => {
      if (!path || isLocalMediaRef(path)) return path;
      const url = mediaUrl(path, projectId);
      if (!url) return path;
      const localRef = await cacheRemoteMedia(url, { projectId, sourcePath: path });
      void refreshStorageEstimate();
      return localRef ?? path;
    },
    [refreshStorageEstimate],
  );

  const renderFinal = useCallback(async (): Promise<void> => {
    const current = snapshotRef.current;
    if (!current?.storyboard.shots.length) {
      const message = strings.errors.renderRequiresStoryboard;
      setError(message);
      throw new Error(message);
    }
    const credentials = normalizeCredentials(providerCredentials);
    if (!credentials.video_key) {
      const message = strings.errors.missingVideoKeyForRender;
      setError(message);
      throw new Error(message);
    }

    const projectId = current.project.id;
    const token = beginProjectOperation("render", projectId);
    const isCurrent = () => isProjectOperationCurrent(token);
    setBusyValue("rendering", true);
    setError(null);
    applyProjectSnapshot({ ...current, final_path: null });
    const responseBaseRevision = snapshotRevisionRef.current;
    try {
      const result = await renderProject(projectId, {
        video_key: credentials.video_key,
        base_url: credentials.base_url,
        video_model: credentials.video_model,
        render_runtime: "ffmpeg",
      });
      if (!isCurrent()) return;
      const latest = snapshotRef.current;
      if (!latest) return;
      setEvents((items) => appendUniqueEvent(items, result.event));
      applyProjectSnapshot(mergeRenderResponse(
        latest,
        result,
        responseBaseRevision !== snapshotRevisionRef.current,
      ));

      let authoritative: ShortDramaProjectResponse | null = null;
      try {
        authoritative = await refreshAuthoritativeProject(projectId, isCurrent);
      } catch {
        // The POST response is the render fallback when the full refresh fails.
      }
      if (!isCurrent()) return;
      const latestBeforeCache = snapshotRef.current;
      if (!latestBeforeCache) return;
      const completeAuthoritative = authoritative
        && isCompleteRenderSource(authoritative.final_path, authoritative.render_report)
        ? authoritative
        : null;
      const completionSnapshotBase = completeAuthoritative
        ? mergeAuthoritativeMediaOverlays(completeAuthoritative, latestBeforeCache)
        : latestBeforeCache;
      const selectedReport = completeAuthoritative
        ? completeAuthoritative.render_report as RenderReport
        : result.render_report;
      const selectedSource = completeAuthoritative
        ? completeAuthoritative.final_path as string
        : result.final_path;
      const completionBase: ShortDramaProjectResponse = {
        ...completionSnapshotBase,
        render_report: selectedReport,
        final_path: selectedSource,
      };
      const cacheBaseRevision = snapshotRevisionRef.current;
      const cachedFinalPath = await cacheFinalRender(projectId, selectedSource);
      if (!isCurrent()) return;
      const latestAfterCache = snapshotRef.current;
      if (!latestAfterCache) return;
      const renderReportChangedDuringCache = valueChanged(
        latestBeforeCache.render_report,
        latestAfterCache.render_report,
      );
      const finalPathChangedDuringCache = valueChanged(
        latestBeforeCache.final_path,
        latestAfterCache.final_path,
      );
      const reconciled = cacheBaseRevision === snapshotRevisionRef.current
        ? completionBase
        : mergeConcurrentSnapshotChanges(
            completionBase,
            latestBeforeCache,
            latestAfterCache,
          );
      await persistIfCurrent(projectId, {
        ...reconciled,
        render_report: renderReportChangedDuringCache
          ? reconciled.render_report
          : selectedReport,
        final_path: finalPathChangedDuringCache
          ? reconciled.final_path
          : cachedFinalPath,
      }, isCurrent);
    } catch (renderError) {
      const message = errorMessage(renderError, strings.errors.renderFallback);
      if (isCurrent()) setError(message);
      throw renderError instanceof Error ? renderError : new Error(message);
    } finally {
      if (isCurrent()) setBusyValue("rendering", false);
    }
  }, [
    applyProjectSnapshot,
    beginProjectOperation,
    cacheFinalRender,
    isProjectOperationCurrent,
    persistIfCurrent,
    providerCredentials,
    refreshAuthoritativeProject,
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
    providerCredentials,
    maskedKeys,
    providerReady: maskedKeys !== null,
    busy,
    openLocalProject,
    createProject,
    saveProvider,
    updateProviderField,
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
