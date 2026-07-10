import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  JobEvent,
  PromptOptimizeResponse,
  ProviderCredentials,
  ReferenceImageUploadRequest,
  ShortDramaProjectResponse,
  Shot,
  ShotSaveRequest,
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
import { emptyContinuityPlan } from "./snapshot";
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

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const strings = useMemo(
    () => getStrings(detectLocale(globalThis.navigator?.language)),
    [],
  );
  const [snapshot, setSnapshot] = useState<ShortDramaProjectResponse | null>(null);
  const snapshotRef = useRef<ShortDramaProjectResponse | null>(null);
  const projectLoadGenerationRef = useRef(0);
  const previousMediaProjectIdRef = useRef<string | null>(null);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [localMediaUrls, setLocalMediaUrls] = useState<
    Partial<Record<LocalMediaRef, string>>
  >({});
  const [providerCredentials, setProviderCredentials] = useState(INITIAL_CREDENTIALS);
  const [maskedKeys, setMaskedKeys] = useState<WorkbenchContextValue["maskedKeys"]>(null);
  const [busy, setBusy] = useState(INITIAL_BUSY);

  const setBusyValue = useCallback(
    <K extends keyof WorkbenchBusyState>(key: K, value: WorkbenchBusyState[K]) => {
      setBusy((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const applyProjectSnapshot = useCallback((next: ShortDramaProjectResponse) => {
    const previousProjectId = snapshotRef.current?.project.id ?? null;
    snapshotRef.current = next;
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
    async (next: ShortDramaProjectResponse) => {
      applyProjectSnapshot(next);
      try {
        await saveProjectSnapshot(next);
        void refreshStorageEstimate();
      } catch {
        setError(strings.errors.localProjectSaveFallback);
      }
    },
    [applyProjectSnapshot, refreshStorageEstimate, strings.errors.localProjectSaveFallback],
  );

  const persistIfCurrent = useCallback(
    async (projectId: string, next: ShortDramaProjectResponse) => {
      if (snapshotRef.current?.project.id !== projectId) return;
      await applyAndPersistProjectSnapshot(next);
    },
    [applyAndPersistProjectSnapshot],
  );

  useEffect(() => {
    void refreshStorageEstimate();
  }, [refreshStorageEstimate]);

  useEffect(() => {
    const projectId = snapshot?.project.id ?? null;
    const previousProjectId = previousMediaProjectIdRef.current;
    previousMediaProjectIdRef.current = projectId;
    if (previousProjectId && previousProjectId !== projectId) {
      revokeLocalMediaUrls();
      setLocalMediaUrls({});
    }
  }, [snapshot?.project.id]);

  useEffect(() => () => revokeLocalMediaUrls(), []);

  useEffect(() => {
    const refs = Array.from(collectLocalMediaRefs(snapshot));
    const unresolved = refs.filter((ref) => !localMediaUrls[ref]);
    if (unresolved.length === 0) return;

    let active = true;
    void Promise.all(
      unresolved.map(async (ref) => {
        try {
          const url = await resolveLocalMediaUrl(ref);
          return url ? ([ref, url] as const) : null;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (!active) return;
      const resolved = entries.filter(
        (entry): entry is readonly [LocalMediaRef, string] => Boolean(entry),
      );
      if (resolved.length > 0) {
        setLocalMediaUrls((current) => ({ ...current, ...Object.fromEntries(resolved) }));
      }
    });

    return () => {
      active = false;
    };
  }, [localMediaUrls, snapshot]);

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

  const openLocalProject = useCallback(
    async (projectId: string): Promise<boolean> => {
      const generation = ++projectLoadGenerationRef.current;
      const record = await loadProjectSnapshot(projectId);
      if (generation !== projectLoadGenerationRef.current) return Boolean(record);
      if (!record) return false;

      applyProjectSnapshot(record.snapshot);
      try {
        await setRecentProjectId(projectId);
      } catch {
        setError(strings.errors.localProjectSaveFallback);
      }
      return true;
    },
    [applyProjectSnapshot, strings.errors.localProjectSaveFallback],
  );

  const createProject = useCallback(
    async (input: CreateProjectInput): Promise<ShortDramaProjectResponse> => {
      setBusyValue("creating", true);
      setError(null);
      setEvents([]);
      try {
        const credentials = normalizeCredentials(providerCredentials);
        const result = await createShortDramaProject({
          title: input.title,
          prompt: input.prompt,
          project_type: input.project_type,
          ...credentials,
        });
        await applyAndPersistProjectSnapshot({ ...result, final_path: null });
        return result;
      } catch (creationError) {
        const message = errorMessage(creationError, strings.errors.createProjectFallback);
        setError(message);
        throw creationError instanceof Error ? creationError : new Error(message);
      } finally {
        setBusyValue("creating", false);
      }
    },
    [applyAndPersistProjectSnapshot, providerCredentials, setBusyValue, strings.errors.createProjectFallback],
  );

  const saveProvider = useCallback(async () => {
    const credentials = normalizeCredentials(providerCredentials);
    if (!credentials.text_key || !credentials.image_key || !credentials.video_key) {
      const message = strings.errors.saveKeysRequiresAll;
      setError(message);
      throw new Error(message);
    }

    setBusyValue("savingProvider", true);
    setError(null);
    try {
      const session = await saveGatewayKey(credentials);
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
      setError(message);
      throw providerError instanceof Error ? providerError : new Error(message);
    } finally {
      setBusyValue("savingProvider", false);
    }
  }, [providerCredentials, setBusyValue, strings.errors.saveKeysFallback, strings.errors.saveKeysRequiresAll]);

  const updateProviderField = useCallback(
    <K extends keyof ProviderCredentials>(key: K, value: ProviderCredentials[K]) => {
      setProviderCredentials((current) => ({ ...current, [key]: value }));
    },
    [],
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
        setError(message);
        throw optimizationError instanceof Error ? optimizationError : new Error(message);
      } finally {
        setBusyValue("optimizingShotId", null);
      }
    },
    [providerCredentials, setBusyValue, strings.errors.missingTextKeyForOptimize, strings.errors.optimizeShotFallback],
  );

  const saveShotChanges = useCallback(
    async (shotId: string, payload: ShotSaveRequest): Promise<void> => {
      const current = snapshotRef.current;
      if (!current) return;
      const projectId = current.project.id;
      setBusyValue("savingShotId", shotId);
      setError(null);
      try {
        const result = await saveShot(projectId, shotId, payload);
        if (snapshotRef.current?.project.id !== projectId) return;
        setSelectedShotId(shotId);
        setEvents((items) => appendUniqueEvent(items, result.event));
        await persistIfCurrent(projectId, {
          ...current,
          storyboard: result.storyboard,
          consistency_report: result.consistency_report,
          render_report: null,
          final_path: null,
        });
      } catch (saveError) {
        const message = errorMessage(saveError, strings.errors.saveShotFallback);
        setError(message);
        throw saveError instanceof Error ? saveError : new Error(message);
      } finally {
        setBusyValue("savingShotId", null);
      }
    },
    [persistIfCurrent, setBusyValue, strings.errors.saveShotFallback],
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
        if (snapshotRef.current?.project.id !== projectId) return;
        const nextStoryboard = {
          ...result.storyboard,
          shots: result.storyboard.shots.map((item) =>
            item.id === cachedShot.id ? cachedShot : item,
          ),
        };
        setEvents((items) => appendUniqueEvent(items, result.event));
        await persistIfCurrent(projectId, {
          ...current,
          storyboard: nextStoryboard,
          consistency_report: result.consistency_report,
        });
      } catch (regenerationError) {
        const message = errorMessage(
          regenerationError,
          strings.errors.regenerateShotFallback(shot.id),
        );
        setError(message);
        throw regenerationError instanceof Error ? regenerationError : new Error(message);
      } finally {
        setBusyValue("regeneratingShotId", null);
      }
    },
    [cacheShotMedia, persistIfCurrent, providerCredentials, setBusyValue, strings.errors],
  );

  const saveContinuity = useCallback(
    async (plan: ContinuityPlan): Promise<void> => {
      const current = snapshotRef.current;
      if (!current) throw new Error(strings.errors.createProjectFallback);
      const projectId = current.project.id;
      setBusyValue("savingContinuity", true);
      setError(null);
      try {
        const result = await saveContinuityPlan(projectId, plan);
        if (snapshotRef.current?.project.id !== projectId) return;
        applyProjectSnapshot({
          ...current,
          project: result.project,
          continuity_plan: result.continuity_plan,
        });
        const refreshed = await loadProject(projectId);
        await persistIfCurrent(projectId, refreshed);
      } catch (continuityError) {
        const message = errorMessage(continuityError, strings.errors.saveContinuityFallback);
        setError(message);
        throw continuityError instanceof Error ? continuityError : new Error(message);
      } finally {
        setBusyValue("savingContinuity", false);
      }
    },
    [applyProjectSnapshot, persistIfCurrent, setBusyValue, strings.errors.createProjectFallback, strings.errors.saveContinuityFallback],
  );

  const uploadReference = useCallback(
    async (payload: ReferenceImageUploadRequest): Promise<void> => {
      const current = snapshotRef.current;
      if (!current) throw new Error(strings.errors.uploadReferenceFallback);
      const projectId = current.project.id;
      setBusyValue("uploadingReference", true);
      setError(null);
      try {
        const result = await uploadReferenceImage(projectId, payload);
        if (snapshotRef.current?.project.id !== projectId) return;
        const uploadedAsset = {
          ...result.asset,
          media_urls: [...(result.asset.media_urls ?? []), result.media.media_url],
        };
        applyProjectSnapshot({
          ...current,
          series_bible: {
            ...current.series_bible,
            assets: [...(current.series_bible.assets ?? []), uploadedAsset],
          },
        });
        const refreshed = await loadProject(projectId);
        await persistIfCurrent(projectId, refreshed);
      } catch (uploadError) {
        const message = errorMessage(uploadError, strings.errors.uploadReferenceFallback);
        setError(message);
        throw uploadError instanceof Error ? uploadError : new Error(message);
      } finally {
        setBusyValue("uploadingReference", false);
      }
    },
    [applyProjectSnapshot, persistIfCurrent, setBusyValue, strings.errors.uploadReferenceFallback],
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
    setBusyValue("rendering", true);
    setError(null);
    applyProjectSnapshot({ ...current, final_path: null });
    try {
      const result = await renderProject(projectId, {
        video_key: credentials.video_key,
        base_url: credentials.base_url,
        video_model: credentials.video_model,
        render_runtime: "ffmpeg",
      });
      const finalPath = await cacheFinalRender(projectId, result.final_path ?? null);
      if (snapshotRef.current?.project.id !== projectId) return;
      setEvents((items) => appendUniqueEvent(items, result.event));
      await persistIfCurrent(projectId, {
        ...current,
        project: result.project,
        storyboard: result.storyboard,
        consistency_report: result.consistency_report,
        render_report: result.render_report,
        final_path: finalPath,
      });
    } catch (renderError) {
      const message = errorMessage(renderError, strings.errors.renderFallback);
      setError(message);
      throw renderError instanceof Error ? renderError : new Error(message);
    } finally {
      setBusyValue("rendering", false);
    }
  }, [applyProjectSnapshot, cacheFinalRender, persistIfCurrent, providerCredentials, setBusyValue, strings.errors]);

  const downloadFinal = useCallback(async (): Promise<void> => {
    const current = snapshotRef.current;
    const finalPath = current?.final_path;
    if (!current || !finalPath) return;
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
      setError(message);
      throw downloadError instanceof Error ? downloadError : new Error(message);
    } finally {
      setBusyValue("downloading", false);
    }
  }, [setBusyValue, strings.errors.downloadFinalVideoFallback]);

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

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}
