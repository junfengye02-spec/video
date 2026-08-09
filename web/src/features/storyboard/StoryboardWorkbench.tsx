import { ArrowRight, Sparkles } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
} from "react";
import { Link } from "react-router-dom";
import {
  CommandErrorNotice,
  commandErrorFrom,
  type CommandError,
} from "../../components/feedback/DomainErrorBoundary";
import {
  type AssetRecord,
  type Character,
  type EpisodeOutlineItem,
  type GenerateImagesRequest,
  type GenerateImagesResponse,
  type GenerationExecutionSnapshot,
  type GenerationPlan,
  type GenerationPlanPreviewRequest,
  type GenerationUnitsGenerateRequest,
  type GenerationUnitsGenerateResponse,
  type JobEvent,
  type ProductionConnectionState,
  type ProjectGenerationPreferences,
  type PromptOptimizeResponse,
  type ReferenceImageUploadRequest,
  type ReferenceImageUploadResponse,
  type Shot,
  type ShotSaveRequest,
  type TaskBatch,
  type TaskItem,
  type TaskListResponse,
} from "../../domain/types";
import { getStrings, type UIStrings } from "../../i18n";
import { ApiError } from "../../platform/http/HttpClient";
import { Button, Surface, Tabs } from "../../shared/ui";
import { GenerationUnitFilmstrip } from "./components/GenerationUnitFilmstrip";
import { MediaStage } from "./components/MediaStage";
import { ShotFilmstrip } from "./components/ShotFilmstrip";
import { ShotInspector } from "./components/ShotInspector";
import { ShotList } from "./components/ShotList";
import { useStoryboardController } from "./model/useStoryboardController";
import {
  outdatedGenerationUnitIdsForShots,
  type ShotGenerationUnitMedia,
} from "./model/generationUnitMedia";
import { generationUnitPreviewItems } from "./model/generationUnitPreview";
import styles from "./StoryboardWorkbench.module.css";

export interface StoryboardWorkbenchProps {
  projectId: string;
  assets: AssetRecord[];
  characters: Character[];
  episodes?: EpisodeOutlineItem[];
  activeEpisodeNumber?: number | null;
  generationPreferences?: ProjectGenerationPreferences;
  generationExecution?: GenerationExecutionSnapshot | null;
  optimizingShotId: string | null;
  regeneratingShotId: string | null;
  savingShotId: string | null;
  planning?: boolean;
  selectedShotId: string | null;
  shots: Shot[];
  plannedShotCount?: number | null;
  initialPlanPrompt?: string;
  textModel?: string | null;
  projectAspectRatio?: string | null;
  projectDurationSeconds?: number | null;
  resolveShotMedia: (shot: Shot) => string | null;
  resolveGenerationUnitMedia?: (shot: Shot) => ShotGenerationUnitMedia;
  resolveGenerationUnitPath?: (path: string) => string | null;
  resolveShotFallbackMedia?: (shot: Shot) => string | null;
  onSelectShot: (shotId: string) => void;
  onSelectEpisode?: (episodeNumber: number) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onPlanStoryboard?: (prompt: string) => Promise<void>;
  onOptimizePrompt: (shot: Shot, sourceText: string) => Promise<PromptOptimizeResponse>;
  onSaveShot: (shotId: string, payload: ShotSaveRequest) => Promise<Shot>;
  onRegenerateShot: (shot: Shot, videoModel?: string) => Promise<void>;
  onGenerateKeyframe?: (payload: GenerateImagesRequest) => Promise<GenerateImagesResponse>;
  onGenerateGenerationUnits?: (
    payload: GenerationUnitsGenerateRequest,
  ) => Promise<GenerationUnitsGenerateResponse>;
  onPreviewGenerationPlan?: (
    payload: GenerationPlanPreviewRequest,
  ) => Promise<GenerationPlan>;
  onListTasks?: () => Promise<TaskListResponse>;
  onRetryTaskItem?: (taskId: string, itemId: string) => Promise<TaskBatch>;
  onSessionExpired?: () => void;
  taskEvents?: JobEvent[];
  walletAvailableUnits?: number | null;
  connectionState?: ProductionConnectionState;
  productionUrl?: string;
  onReviseStoryboard?: () => Promise<void>;
  uploadingFirstFrame?: boolean;
  onUploadFirstFrame?: (
    payload: ReferenceImageUploadRequest,
  ) => Promise<ReferenceImageUploadResponse>;
}

type StoryboardView = "list" | "preview" | "inspector";
const COMPACT_QUERY = "(max-width: 1179px)";

function taskTimestamp(task: Pick<TaskBatch, "updated_at" | "created_at">): number {
  const parsed = Date.parse(task.updated_at || task.created_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeTaskBatches(
  current: TaskBatch[],
  incoming: TaskBatch[],
  preferIncoming = false,
): TaskBatch[] {
  const byId = new Map(current.map((task) => [task.id, task]));
  for (const task of incoming) {
    const previous = byId.get(task.id);
    if (
      !previous
      || preferIncoming
      || taskTimestamp(task) > taskTimestamp(previous)
    ) {
      byId.set(task.id, task);
    }
  }
  return [...byId.values()].sort((left, right) => (
    taskTimestamp(right) - taskTimestamp(left) || right.id.localeCompare(left.id)
  ));
}

function useCompactViewport(): boolean {
  const [matches, setMatches] = useState(() => (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(COMPACT_QUERY).matches
      : false
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(COMPACT_QUERY);
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return matches;
}

export function StoryboardWorkbench(props: StoryboardWorkbenchProps) {
  const strings = getStrings("zh");
  const compact = useCompactViewport();
  const [activeView, setActiveView] = useState<StoryboardView>("preview");
  const defaultVideoModel = props.generationPreferences?.video_model || "omni_flash-10s";
  const [videoModel, setVideoModel] = useState(defaultVideoModel);
  const [shotTasks, setShotTasks] = useState<TaskBatch[]>([]);
  const [submittingUnits, setSubmittingUnits] = useState(false);
  const [confirmingPlan, setConfirmingPlan] = useState(false);
  const [revisingStoryboard, setRevisingStoryboard] = useState(false);
  const [regenerateUnitIds, setRegenerateUnitIds] = useState<Set<string>>(new Set());
  const [retryingItemId, setRetryingItemId] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState<CommandError | null>(null);
  const [generationPlan, setGenerationPlan] = useState<GenerationPlan | null>(null);
  const [selectedGenerationUnitKey, setSelectedGenerationUnitKey] = useState<string | null>(null);
  const [previewingPlan, setPreviewingPlan] = useState(false);
  const [episodeError, setEpisodeError] = useState<CommandError | null>(null);
  const [switchingEpisode, setSwitchingEpisode] = useState(false);
  const previewGenerationPlanRef = useRef(props.onPreviewGenerationPlan);
  const onSessionExpiredRef = useRef(props.onSessionExpired);
  previewGenerationPlanRef.current = props.onPreviewGenerationPlan;
  onSessionExpiredRef.current = props.onSessionExpired;
  const canPreviewGenerationPlan = Boolean(props.onPreviewGenerationPlan);
  const taskRefreshSequence = useRef(0);
  const rootRef = useRef<HTMLElement | null>(null);
  const paneRefs = useRef<Record<StoryboardView, HTMLDivElement | null>>({
    list: null,
    preview: null,
    inspector: null,
  });
  const lastFocus = useRef<Partial<Record<StoryboardView, HTMLElement>>>({});

  useEffect(() => setVideoModel(defaultVideoModel), [defaultVideoModel, props.projectId]);
  const episodeOptions = useMemo(() => {
    const titles = new Map(
      (props.episodes ?? []).map((episode) => [episode.episode_number, episode.title]),
    );
    for (const shot of props.shots) {
      if (shot.episode_number != null && !titles.has(shot.episode_number)) {
        titles.set(shot.episode_number, "");
      }
    }
    return [...titles.entries()]
      .sort(([left], [right]) => left - right)
      .map(([episodeNumber, title]) => ({
        value: String(episodeNumber),
        label: strings.storyboardPage.episodeOption(episodeNumber, title),
      }));
  }, [props.episodes, props.shots, strings.storyboardPage]);
  const selectedEpisodeNumber = useMemo(() => {
    const available = new Set(episodeOptions.map((option) => Number(option.value)));
    if (props.activeEpisodeNumber != null && available.has(props.activeEpisodeNumber)) {
      return props.activeEpisodeNumber;
    }
    return episodeOptions.length ? Number(episodeOptions[0].value) : null;
  }, [episodeOptions, props.activeEpisodeNumber]);
  const scopedShots = useMemo(() => {
    const hasEpisodeTags = props.shots.some((shot) => shot.episode_number != null);
    if (!hasEpisodeTags) return props.shots;
    return props.shots.filter(
      (shot) => shot.episode_number === selectedEpisodeNumber,
    );
  }, [props.shots, selectedEpisodeNumber]);
  const generationUnitMedia = useCallback(
    (shot: Shot): ShotGenerationUnitMedia => props.resolveGenerationUnitMedia?.(shot) ?? ({
      complete: false,
      hasUnits: false,
      urls: [],
    }),
    [props.resolveGenerationUnitMedia],
  );
  const resolvePreviewMedia = useCallback((shot: Shot): string | null => {
    const unitMedia = generationUnitMedia(shot);
    if (unitMedia.hasUnits) return unitMedia.urls[0] ?? null;
    return props.resolveShotMedia(shot);
  }, [generationUnitMedia, props.resolveShotMedia]);
  const controller = useStoryboardController({
    projectId: props.projectId,
    shots: scopedShots,
    selectedShotId: props.selectedShotId,
    optimizingShotId: props.optimizingShotId,
    regeneratingShotId: props.regeneratingShotId,
    savingShotId: props.savingShotId,
    onSelectShot: props.onSelectShot,
    onDirtyChange: props.onDirtyChange,
    onOptimizePrompt: props.onOptimizePrompt,
    onSaveShot: props.onSaveShot,
    onRegenerateShot: props.onRegenerateShot,
    onSessionExpired: props.onSessionExpired,
    walletAvailableUnits: props.walletAvailableUnits,
  });
  const previewGenerationUnits = useMemo(() => generationUnitPreviewItems(
    props.generationExecution,
    scopedShots,
    props.resolveGenerationUnitPath ?? (() => null),
  ), [props.generationExecution, props.resolveGenerationUnitPath, scopedShots]);
  const selectedGenerationUnit = useMemo(() => (
    previewGenerationUnits.find((item) => item.key === selectedGenerationUnitKey)
    ?? previewGenerationUnits.find((item) => (
      controller.selectedShot && item.unit.source_shot_ids.includes(controller.selectedShot.id)
    ))
    ?? previewGenerationUnits[0]
    ?? null
  ), [controller.selectedShot, previewGenerationUnits, selectedGenerationUnitKey]);

  useEffect(() => {
    setSelectedGenerationUnitKey((current) => {
      const currentItem = previewGenerationUnits.find((item) => item.key === current);
      if (
        currentItem
        && (!controller.selectedShot || currentItem.unit.source_shot_ids.includes(controller.selectedShot.id))
      ) return current;
      return previewGenerationUnits.find((item) => (
        controller.selectedShot && item.unit.source_shot_ids.includes(controller.selectedShot.id)
      ))?.key ?? previewGenerationUnits[0]?.key ?? null;
    });
  }, [controller.selectedShot, previewGenerationUnits]);
  const latestShotItems = useMemo(() => {
    const mapped = new Map<string, { batchId: string; item: TaskItem }>();
    for (const task of shotTasks) {
      if (task.task_type !== "storyboard_video.generate") continue;
      for (const item of task.items ?? []) {
        const shotId = item.target_entity_type === "shot_video"
          ? item.target_entity_id
          : null;
        if (!shotId) continue;
        const current = mapped.get(shotId);
        const currentTimestamp = current
          ? taskTimestamp({ updated_at: current.item.updated_at, created_at: current.item.created_at })
          : Number.NEGATIVE_INFINITY;
        const nextTimestamp = taskTimestamp({ updated_at: item.updated_at, created_at: item.created_at });
        if (!current || nextTimestamp > currentTimestamp) {
          mapped.set(shotId, { batchId: task.id, item });
        }
      }
    }
    return mapped;
  }, [shotTasks]);
  const latestGenerationUnitItems = useMemo(() => {
    const mapped = new Map<string, { batchId: string; item: TaskItem }>();
    for (const task of shotTasks) {
      if (task.task_type !== "generation_unit_video.generate") continue;
      for (const item of task.items ?? []) {
        const unitId = item.target_entity_type === "generation_unit"
          ? item.target_entity_id
          : null;
        if (!unitId) continue;
        const current = mapped.get(unitId);
        const currentTimestamp = current
          ? taskTimestamp({ updated_at: current.item.updated_at, created_at: current.item.created_at })
          : Number.NEGATIVE_INFINITY;
        const nextTimestamp = taskTimestamp({ updated_at: item.updated_at, created_at: item.created_at });
        if (!current || nextTimestamp > currentTimestamp) {
          mapped.set(unitId, { batchId: task.id, item });
        }
      }
    }
    return mapped;
  }, [shotTasks]);
  const activeShotTasks = shotTasks.some((task) => [
    "queued",
    "running",
    "waiting_dependency",
    "waiting_provider",
    "awaiting_payment",
  ].includes(task.status));

  const refreshTasks = useCallback(async () => {
    if (!props.onListTasks) return;
    const requestSequence = ++taskRefreshSequence.current;
    try {
      const response = await props.onListTasks();
      if (requestSequence === taskRefreshSequence.current) {
        setShotTasks((current) => mergeTaskBatches(current, response.tasks));
      }
    } catch {
      // A transient task-list failure must not clear the last known state.
    }
  }, [props.onListTasks]);

  useEffect(() => {
    taskRefreshSequence.current += 1;
    setRegenerateUnitIds(new Set());
    setShotTasks([]);
    setGenerationError(null);
    if (!props.onListTasks) return;
    void refreshTasks();
  }, [props.activeEpisodeNumber, props.onListTasks, props.projectId, refreshTasks]);

  useEffect(() => {
    if (!props.onListTasks || (!activeShotTasks && props.connectionState !== "disconnected")) {
      return undefined;
    }
    const timer = globalThis.setInterval(() => void refreshTasks(), 2_000);
    return () => {
      globalThis.clearInterval(timer);
    };
  }, [activeShotTasks, props.connectionState, refreshTasks]);

  const latestTaskEvent = props.taskEvents?.[props.taskEvents.length - 1];
  useEffect(() => {
    if (!latestTaskEvent || !props.onListTasks
      || !["task", "task_item"].includes(latestTaskEvent.stage)) return;
    void refreshTasks();
  }, [latestTaskEvent?.id, props.onListTasks, refreshTasks]);

  const selectedPlanShotIds = useMemo(
    () => scopedShots.map((shot) => shot.id),
    [scopedShots],
  );
  const outdatedGenerationUnitIds = useMemo(
    () => outdatedGenerationUnitIdsForShots(props.generationExecution, scopedShots),
    [props.generationExecution, scopedShots],
  );
  const requestedRegenerationUnitIds = useMemo(
    () => [...new Set([...regenerateUnitIds, ...outdatedGenerationUnitIds])].sort(),
    [outdatedGenerationUnitIds, regenerateUnitIds],
  );
  const effectiveRegenerateUnitIds = useMemo(
    () => new Set(requestedRegenerationUnitIds),
    [requestedRegenerationUnitIds],
  );

  useEffect(() => {
    const previewGenerationPlan = previewGenerationPlanRef.current;
    if (!previewGenerationPlan || !selectedPlanShotIds.length || !videoModel.trim()) {
      setGenerationPlan(null);
      setPreviewingPlan(false);
      return undefined;
    }
    let active = true;
    setPreviewingPlan(true);
    setGenerationError(null);
    void previewGenerationPlan({
      video_model: videoModel.trim(),
      ...(props.textModel?.trim() ? { text_model: props.textModel.trim() } : {}),
      shot_ids: selectedPlanShotIds,
      regenerate_unit_ids: requestedRegenerationUnitIds,
    }).then((plan) => {
      if (!active) return;
      setGenerationPlan(plan);
    }).catch((caught) => {
      if (!active) return;
      setGenerationPlan(null);
      setGenerationError(generationCommandError(caught, {
        fallback: strings.storyboardPage.generationPlanError,
        strings: strings.storyboardPage,
        onSessionExpired: onSessionExpiredRef.current,
        walletAvailableUnits: props.walletAvailableUnits,
      }));
    }).finally(() => {
      if (active) setPreviewingPlan(false);
    });
    return () => { active = false; };
  }, [
    canPreviewGenerationPlan,
    props.projectId,
    props.walletAvailableUnits,
    requestedRegenerationUnitIds.join("\u0000"),
    selectedPlanShotIds.join("\u0000"),
    strings.storyboardPage.generationPlanError,
    props.textModel,
    videoModel,
  ]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.scrollTop = 0;
    root.scrollLeft = 0;
  }, [compact]);

  if (controller.shots.length === 0 && props.onPlanStoryboard) {
    return <EmptyStoryboardPlanner {...props} />;
  }

  function rememberFocus(view: StoryboardView, event: FocusEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLElement) lastFocus.current[view] = event.target;
  }

  function changeView(view: StoryboardView) {
    setActiveView(view);
    if (!compact || view === "preview") return;
    window.requestAnimationFrame(() => {
      const pane = paneRefs.current[view];
      const remembered = lastFocus.current[view];
      const fallback = pane?.querySelector<HTMLElement>(
        "button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled)",
      );
      (remembered?.isConnected ? remembered : fallback)?.focus();
    });
  }

  function selectFromList(shotId: string) {
    const changed = controller.selectShot(shotId);
    if (compact && changed) changeView("preview");
  }

  function selectGenerationUnit(key: string) {
    const item = previewGenerationUnits.find((candidate) => candidate.key === key);
    if (!item) return;
    setSelectedGenerationUnitKey(key);
    const sourceShot = item.sourceShots[0];
    if (sourceShot && sourceShot.id !== controller.selectedShot?.id) {
      controller.selectShot(sourceShot.id);
    }
  }

  async function reviseStoryboard() {
    if (!props.onReviseStoryboard || revisingStoryboard) return;
    setRevisingStoryboard(true);
    setGenerationError(null);
    try {
      await props.onReviseStoryboard();
    } catch (caught) {
      setGenerationError(generationCommandError(caught, {
        fallback: strings.storyboardPage.generationPlanError,
        strings: strings.storyboardPage,
        onSessionExpired: props.onSessionExpired,
        walletAvailableUnits: props.walletAvailableUnits,
      }));
    } finally {
      setRevisingStoryboard(false);
    }
  }

  async function selectEpisode(value: string) {
    const episodeNumber = Number(value);
    if (
      !Number.isSafeInteger(episodeNumber)
      || episodeNumber === selectedEpisodeNumber
      || switchingEpisode
      || !props.onSelectEpisode
    ) return;
    if (controller.dirty && !window.confirm(strings.storyboardPage.discardChangesConfirm)) return;
    setSwitchingEpisode(true);
    setEpisodeError(null);
    try {
      await props.onSelectEpisode(episodeNumber);
      const firstShot = props.shots.find((shot) => shot.episode_number === episodeNumber);
      if (firstShot) props.onSelectShot(firstShot.id);
    } catch (caught) {
      setEpisodeError(commandErrorFrom(caught, {
        fallback: strings.storyboardPage.switchEpisodeError,
        onSessionExpired: props.onSessionExpired,
        walletAvailableUnits: props.walletAvailableUnits,
      }));
    } finally {
      setSwitchingEpisode(false);
    }
  }

  async function generatePendingUnits() {
    if (!props.onGenerateGenerationUnits || submittingUnits || !generationPlan) return;
    const generationUnitIds = generationPlan.generation_units
      .filter((unit) => unit.status === "planned")
      .map((unit) => unit.id);
    if (
      !generationUnitIds.length
      || !generationPlan.can_generate
      || generationPlan.requires_confirmation
    ) return;
    setSubmittingUnits(true);
    setGenerationError(null);
    try {
      const response = await props.onGenerateGenerationUnits({
        generation_plan_id: generationPlan.id,
        generation_unit_ids: generationUnitIds,
        idempotency_key: generationUnitIdempotencyKey(),
      });
      setShotTasks((current) => [
        response.task,
        ...current.filter((task) => task.id !== response.task.id),
      ]);
      if (props.onPreviewGenerationPlan) {
        try {
          const refreshed = await props.onPreviewGenerationPlan({
            video_model: videoModel.trim(),
            ...(props.textModel?.trim() ? { text_model: props.textModel.trim() } : {}),
            shot_ids: selectedPlanShotIds,
            regenerate_unit_ids: requestedRegenerationUnitIds,
            ...(generationPlan.confirmed_strategy
              ? { confirmed_strategy: generationPlan.confirmed_strategy }
              : {}),
          });
          setGenerationPlan(refreshed);
        } catch {
          // The accepted task remains authoritative; task polling will refresh the ledger view.
        }
      }
    } catch (caught) {
      setGenerationError(generationCommandError(caught, {
        fallback: strings.storyboardPage.generateUnitsError,
        strings: strings.storyboardPage,
        onSessionExpired: props.onSessionExpired,
        walletAvailableUnits: props.walletAvailableUnits,
      }));
    } finally {
      setSubmittingUnits(false);
    }
  }

  async function acceptLongerDuration() {
    if (!props.onPreviewGenerationPlan || confirmingPlan || !generationPlan) return;
    setConfirmingPlan(true);
    setGenerationError(null);
    try {
      const confirmed = await props.onPreviewGenerationPlan({
        video_model: videoModel.trim(),
        ...(props.textModel?.trim() ? { text_model: props.textModel.trim() } : {}),
        shot_ids: selectedPlanShotIds,
        regenerate_unit_ids: requestedRegenerationUnitIds,
        confirmed_strategy: "accept_longer_duration",
      });
      setGenerationPlan(confirmed);
    } catch (caught) {
      setGenerationError(generationCommandError(caught, {
        fallback: strings.storyboardPage.generationPlanError,
        strings: strings.storyboardPage,
        onSessionExpired: props.onSessionExpired,
        walletAvailableUnits: props.walletAvailableUnits,
      }));
    } finally {
      setConfirmingPlan(false);
    }
  }

  function requestUnitRegeneration(unitId: string) {
    setRegenerateUnitIds((current) => new Set(current).add(unitId));
  }

  async function retryShotItem(batchId: string, itemId: string) {
    if (!props.onRetryTaskItem || retryingItemId) return;
    setRetryingItemId(itemId);
    setGenerationError(null);
    try {
      const task = await props.onRetryTaskItem(batchId, itemId);
      taskRefreshSequence.current += 1;
      setShotTasks((current) => mergeTaskBatches(current, [task], true));
    } catch (caught) {
      setGenerationError(commandErrorFrom(caught, {
        fallback: strings.storyboardPage.generateUnitsError,
        onSessionExpired: props.onSessionExpired,
        walletAvailableUnits: props.walletAvailableUnits,
      }));
    } finally {
      setRetryingItemId(null);
    }
  }

  const allScopedShotsReusable = scopedShots.length > 0
    && scopedShots.every((shot) => {
      const unitMedia = generationUnitMedia(shot);
      if (unitMedia.hasUnits) return unitMedia.complete && unitMedia.urls.length > 0;
      return Boolean(props.resolveShotMedia(shot)) && shot.status === "complete";
    });
  const selectedGenerationUnitMedia = controller.selectedShot
    ? generationUnitMedia(controller.selectedShot)
    : null;
  const selectedLegacyMedia = controller.selectedShot && !selectedGenerationUnitMedia?.hasUnits
    ? props.resolveShotMedia(controller.selectedShot)
    : null;
  const selectedMediaUrls = selectedGenerationUnitMedia?.hasUnits
    ? selectedGenerationUnitMedia.urls
    : selectedLegacyMedia ? [selectedLegacyMedia] : [];
  const previewMediaUrls = selectedGenerationUnit
    ? selectedGenerationUnit.mediaUrl ? [selectedGenerationUnit.mediaUrl] : []
    : selectedMediaUrls;
  const selectedUnitNumber = selectedGenerationUnit
    ? previewGenerationUnits.findIndex((item) => item.key === selectedGenerationUnit.key) + 1
    : null;
  const selectedUnitSourceLabel = selectedGenerationUnit
    ? selectedGenerationUnit.sourceShots.length
      ? `来源分镜 ${selectedGenerationUnit.sourceShots.map((shot) => String(shot.index).padStart(2, "0")).join("、")}`
      : "来源分镜未知"
    : null;
  const selectedUnitDescription = selectedGenerationUnit
    ? [
      selectedUnitSourceLabel,
      selectedGenerationUnit.unit.requested_duration_seconds
        ? `${selectedGenerationUnit.unit.requested_duration_seconds} 秒`
        : null,
      selectedGenerationUnit.unit.model_id,
    ].filter(Boolean).join(" · ")
    : undefined;
  const selectedShotVideoOutdated = Boolean(
    controller.selectedShot
    && (props.generationExecution?.generation_units ?? []).some((unit) => (
      effectiveRegenerateUnitIds.has(unit.id)
      && unit.source_shot_ids.includes(controller.selectedShot?.id ?? "")
    )),
  );

  return (
    <section ref={rootRef} className={styles.root} aria-label="分镜工作台">
      {props.plannedShotCount ? (
        <div className={styles.plannedStatus} role="status">
          {strings.storyboardPage.plannedShotCount(props.plannedShotCount)}
        </div>
      ) : null}

      <div className={styles.viewTabs}>
        <Tabs
          ariaLabel={strings.storyboardPage.viewControlLabel}
          value={activeView}
          onValueChange={changeView}
          items={[
            { value: "list", label: strings.storyboardPage.shotListLabel },
            { value: "preview", label: strings.storyboardPage.previewTabLabel },
            { value: "inspector", label: strings.storyboardPage.inspectorLabel },
          ]}
        />
      </div>

      {allScopedShotsReusable && props.productionUrl ? (
        <div className={styles.compositionReady} role="status">
          <span>
            <strong>{strings.storyboardPage.compositionReadyTitle}</strong>
            <small>{strings.storyboardPage.compositionReadyBody}</small>
          </span>
          <Link className="primary-button" to={props.productionUrl}>
            {strings.storyboardPage.continueToCompositionAction}
            <ArrowRight aria-hidden="true" size={15} />
          </Link>
        </div>
      ) : null}

      <div
        ref={(node) => { paneRefs.current.list = node; }}
        className={`${styles.pane} ${styles.listPane}`}
        data-active={activeView === "list" ? "true" : "false"}
        onFocusCapture={(event) => rememberFocus("list", event)}
      >
        <ShotList
          active={!compact || activeView === "list"}
          shots={controller.shots}
          selectedShotId={controller.selectedShot?.id ?? null}
          resolveShotMedia={resolvePreviewMedia}
          onSelect={selectFromList}
          episodeOptions={episodeOptions}
          selectedEpisodeNumber={selectedEpisodeNumber}
          switchingEpisode={switchingEpisode}
          onEpisodeChange={(value) => { void selectEpisode(value); }}
          generationItems={latestShotItems}
          generationUnitItems={latestGenerationUnitItems}
          generationError={generationError ?? episodeError}
          generationExecution={props.generationExecution}
          generationPlan={generationPlan}
          previewingGenerationPlan={previewingPlan}
          confirmingGenerationPlan={confirmingPlan}
          revisingStoryboard={revisingStoryboard}
          regenerateUnitIds={effectiveRegenerateUnitIds}
          submittingGeneration={submittingUnits}
          videoModel={videoModel}
          onVideoModelChange={setVideoModel}
          onAcceptLongerDuration={() => void acceptLongerDuration()}
          onGeneratePendingUnits={() => void generatePendingUnits()}
          onRegenerateUnit={requestUnitRegeneration}
          onReviseStoryboard={() => void reviseStoryboard()}
          retryingItemId={retryingItemId}
          onRetryItem={(batchId, itemId) => void retryShotItem(batchId, itemId)}
        />
      </div>

      <div
        ref={(node) => { paneRefs.current.preview = node; }}
        className={`${styles.pane} ${styles.stagePane}`}
        data-active={activeView === "preview" ? "true" : "false"}
        onFocusCapture={(event) => rememberFocus("preview", event)}
      >
        <MediaStage
          shot={controller.selectedShot}
          mediaUrl={previewMediaUrls[0] ?? null}
          mediaUrls={previewMediaUrls}
          fallbackMediaUrl={!selectedGenerationUnit && controller.selectedShot && !selectedGenerationUnitMedia?.hasUnits
            ? props.resolveShotFallbackMedia?.(controller.selectedShot) ?? null
            : null}
          aspectRatio={props.projectAspectRatio}
          generating={controller.regenerating || controller.selectedShot?.status === "generating"}
          mediaIdentity={selectedGenerationUnit?.key}
          eyebrow={selectedUnitNumber ? `U${String(selectedUnitNumber).padStart(2, "0")}` : undefined}
          title={selectedUnitNumber ? `视频单元 ${String(selectedUnitNumber).padStart(2, "0")}` : undefined}
          description={selectedUnitDescription}
        />
        {previewGenerationUnits.length ? (
          <GenerationUnitFilmstrip
            items={previewGenerationUnits}
            selectedKey={selectedGenerationUnit?.key ?? null}
            onSelect={selectGenerationUnit}
          />
        ) : (
          <ShotFilmstrip
            shots={controller.shots}
            selectedShotId={controller.selectedShot?.id ?? null}
            resolveShotMedia={resolvePreviewMedia}
            onSelect={controller.selectShot}
          />
        )}
      </div>

      <div
        ref={(node) => { paneRefs.current.inspector = node; }}
        className={`${styles.pane} ${styles.inspectorPane}`}
        data-active={activeView === "inspector" ? "true" : "false"}
        onFocusCapture={(event) => rememberFocus("inspector", event)}
      >
        <ShotInspector
          allowShotVideoRegeneration={false}
          assets={props.assets}
          characters={props.characters}
          controller={controller}
          episodes={props.episodes ?? []}
          generationPreferences={props.generationPreferences}
          projectId={props.projectId}
          projectAspectRatio={props.projectAspectRatio}
          uploadingFirstFrame={props.uploadingFirstFrame}
          onUploadFirstFrame={props.onUploadFirstFrame}
          onGenerateKeyframe={props.onGenerateKeyframe}
          onListTasks={props.onListTasks}
          onRetryTaskItem={props.onRetryTaskItem}
          onSessionExpired={props.onSessionExpired}
          taskEvents={props.taskEvents}
          generationUnit={selectedGenerationUnit?.unit ?? null}
          generationUnitNumber={selectedUnitNumber}
          generationUnitSourceShots={selectedGenerationUnit?.sourceShots ?? []}
          generationUnitRegenerationRequested={Boolean(
            selectedGenerationUnit && regenerateUnitIds.has(selectedGenerationUnit.unit.id)
          )}
          onRegenerateGenerationUnit={requestUnitRegeneration}
          videoOutdated={selectedShotVideoOutdated}
          walletAvailableUnits={props.walletAvailableUnits}
        />
      </div>
    </section>
  );
}

function generationUnitIdempotencyKey(): string {
  const randomId = globalThis.crypto?.randomUUID?.().replace(/-/g, "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `generation-units:${randomId}`;
}

function generationCommandError(
  error: unknown,
  options: {
    fallback: string;
    strings: UIStrings["storyboardPage"];
    onSessionExpired?: () => void;
    walletAvailableUnits?: number | null;
  },
): CommandError | null {
  if (error instanceof ApiError) {
    const messages: Partial<Record<string, string>> = {
      generation_units_v2_disabled: options.strings.generationUnitsDisabledError,
      generation_units_v2_required: options.strings.generationUnitsUpgradeRequiredError,
      generation_submission_mode_conflict: options.strings.generationModeConflictError,
      generation_plan_stale: options.strings.generationPlanStaleError,
      generation_plan_selection_invalid: options.strings.generationPlanSelectionError,
      generation_unit_selection_partial: options.strings.generationUnitPartialSelectionError,
      generation_plan_confirmation_required: options.strings.generationPlanConfirmationError,
      generation_plan_blocked: options.strings.generationPlanBlockedError,
    };
    const message = error.code ? messages[error.code] : null;
    if (message) return { kind: "message", message };
  }
  return commandErrorFrom(error, options);
}

function EmptyStoryboardPlanner(props: StoryboardWorkbenchProps) {
  const strings = getStrings("zh");
  const [prompt, setPrompt] = useState(props.initialPlanPrompt ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<CommandError | null>(null);
  const busy = Boolean(props.planning || submitting);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = prompt.trim();
    if (!normalized) {
      setError({ kind: "message", message: strings.errors.createStoryboardRequiresPrompt });
      return;
    }
    if (!props.onPlanStoryboard || busy) return;
    setSubmitting(true);
    setError(null);
    try {
      await props.onPlanStoryboard(normalized);
    } catch (caught) {
      setError(commandErrorFrom(caught, {
        fallback: strings.storyboardPage.planError,
        onSessionExpired: props.onSessionExpired,
        walletAvailableUnits: props.walletAvailableUnits,
      }));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={styles.planner} aria-labelledby="storyboard-empty-title">
      <Surface tone="raised" className={styles.plannerSurface}>
        <div>
          <span>Storyboard</span>
          <h1 id="storyboard-empty-title">{strings.storyboardPage.emptyPlannerTitle}</h1>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>{strings.storyboardPage.planPromptLabel}</span>
            <textarea
              rows={9}
              value={prompt}
              placeholder={strings.storyboardPage.planPromptPlaceholder}
              disabled={busy}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <CommandErrorNotice error={error} />
          <Button type="submit" variant="primary" icon={<Sparkles size={16} />} loading={busy} disabled={busy}>
            {busy ? strings.storyboardPage.planningAction : strings.storyboardPage.planAction}
          </Button>
        </form>
      </Surface>
    </section>
  );
}
