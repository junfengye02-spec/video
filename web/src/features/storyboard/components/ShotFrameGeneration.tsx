import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AssetGenerationDrawer } from "../../../components/resources/AssetGenerationDrawer";
import {
  commandErrorFrom,
  type CommandError,
} from "../../../components/feedback/DomainErrorBoundary";
import type {
  AssetRecord,
  GenerateImagesRequest,
  GenerateImagesResponse,
  JobEvent,
  ProjectGenerationPreferences,
  Shot,
  TaskBatch,
  TaskItem,
  TaskListResponse,
} from "../../../domain/types";
import type { UIStrings } from "../../../i18n";
import { Button } from "../../../shared/ui";
import type { ShotDraftFields } from "../model/shotDraft";

export type FrameTarget = "first" | "last";
type GenerationParameters = Omit<GenerateImagesRequest, "billing_job_id">;

interface PendingGenerationQuote {
  billingJobId: string;
  parameters: GenerationParameters;
  target: FrameTarget;
}

interface ShotFrameGenerationProps {
  busy: boolean;
  draft: ShotDraftFields;
  generationPreferences?: ProjectGenerationPreferences;
  projectAspectRatio?: string | null;
  projectId: string;
  shot: Shot | null;
  strings: UIStrings["shotEditor"];
  walletAvailableUnits?: number | null;
  onGenerate?: (payload: GenerateImagesRequest) => Promise<GenerateImagesResponse>;
  onGenerated: (target: FrameTarget, asset: AssetRecord, mediaUrl: string) => void;
  onListTasks?: () => Promise<TaskListResponse>;
  onPendingChange?: (pending: boolean) => void;
  onRetryTaskItem?: (taskId: string, itemId: string) => Promise<TaskBatch>;
  onSessionExpired?: () => void;
  taskEvents?: JobEvent[];
}

function sameGenerationParameters(
  left: GenerationParameters,
  right: GenerationParameters,
): boolean {
  return left.kind === right.kind
    && left.label === right.label
    && left.description === right.description
    && left.prompt === right.prompt
    && left.model === right.model
    && left.count === right.count
    && left.size === right.size
    && left.quality === right.quality
    && left.shot_id === right.shot_id
    && left.frame_target === right.frame_target;
}

function itemFrameTarget(item: TaskItem, shotId: string): FrameTarget | null {
  if (item.target_entity_type !== "shot_frame" || item.target_entity_id !== shotId) return null;
  const target = item.input.frame_target;
  return target === "first" || target === "last" ? target : null;
}

function publishedAsset(item: TaskItem): { asset: AssetRecord; mediaUrl: string } | null {
  const candidates = item.result?.published_assets;
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const asset = candidates[0];
  if (!asset || typeof asset !== "object") return null;
  const record = asset as Partial<AssetRecord>;
  const mediaUrl = record.media_url
    ?? record.media_urls?.find(Boolean)
    ?? record.reference_images?.find(Boolean)
    ?? null;
  if (!record.id || !record.kind || !record.label || !record.reference_images || !mediaUrl) {
    return null;
  }
  return { asset: record as AssetRecord, mediaUrl };
}

function continuityImagePrompt(
  shot: Shot,
  draft: ShotDraftFields,
  target: FrameTarget,
): string {
  const locks = [
    draft.continuity.composition && `构图：${draft.continuity.composition}`,
    draft.continuity.subject_pose && `主体姿态：${draft.continuity.subject_pose}`,
    draft.continuity.gaze && `视线：${draft.continuity.gaze}`,
    draft.continuity.motion_direction && `运动方向：${draft.continuity.motion_direction}`,
    draft.continuity.lighting && `光线：${draft.continuity.lighting}`,
    draft.continuity.scene_state && `场景状态：${draft.continuity.scene_state}`,
  ].filter(Boolean).join("；");
  const frameRole = target === "first"
    ? "生成该镜头的首帧关键画面"
    : "生成该镜头明确指定的目标尾帧关键画面";
  return [
    frameRole,
    `镜头描述：${draft.prompt || shot.prompt}`,
    locks ? `连续性锁定：${locks}` : "保持主体、场景、光线和屏幕运动方向连续",
    "允许改变景别或机位，但不得反转既定运动方向；单帧画面，不要文字和水印。",
  ].join("。 ");
}

function imageSizeForAspectRatio(aspectRatio: string): string {
  if (aspectRatio === "9:16") return "1024x1536";
  if (aspectRatio === "16:9" || aspectRatio === "4:3") return "1536x1024";
  return "1024x1024";
}

export function ShotFrameGeneration({
  busy,
  draft,
  generationPreferences,
  projectAspectRatio = null,
  projectId,
  shot,
  strings,
  walletAvailableUnits = null,
  onGenerate,
  onGenerated,
  onListTasks,
  onPendingChange,
  onRetryTaskItem,
  onSessionExpired,
  taskEvents = [],
}: ShotFrameGenerationProps) {
  const [target, setTarget] = useState<FrameTarget | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<CommandError | null>(null);
  const [pendingQuote, setPendingQuote] = useState<PendingGenerationQuote | null>(null);
  const [tasks, setTasks] = useState<TaskBatch[]>([]);
  const [retryingItemId, setRetryingItemId] = useState<string | null>(null);
  const requestRevision = useRef(0);
  const appliedItemIds = useRef(new Set<string>());
  const openerRef = useRef<HTMLElement | null>(null);
  const frameGenerationPreferences = useMemo<ProjectGenerationPreferences>(() => {
    const aspectRatio = projectAspectRatio
      || generationPreferences?.aspect_ratio
      || "1:1";
    return {
      image_model: generationPreferences?.image_model || "gpt-image-2",
      video_model: generationPreferences?.video_model || "omni_flash-10s",
      image_size: imageSizeForAspectRatio(aspectRatio),
      image_quality: generationPreferences?.image_quality || "standard",
      aspect_ratio: aspectRatio,
    };
  }, [generationPreferences, projectAspectRatio]);
  const latestItems = useMemo(() => {
    const mapped = new Map<FrameTarget, { batchId: string; item: TaskItem }>();
    if (!shot) return mapped;
    for (const task of tasks) {
      for (const item of task.items ?? []) {
        const itemTarget = itemFrameTarget(item, shot.id);
        if (itemTarget && !mapped.has(itemTarget)) {
          mapped.set(itemTarget, { batchId: task.id, item });
        }
      }
    }
    return mapped;
  }, [shot, tasks]);
  const loadingTargets = useMemo(() => new Set(
    [...latestItems.entries()]
      .filter(([, value]) => [
        "queued",
        "running",
        "waiting_dependency",
      ].includes(value.item.status))
      .map(([itemTarget]) => itemTarget),
  ), [latestItems]);
  const blockedTargets = useMemo(() => new Set(
    [...latestItems.entries()]
      .filter(([, value]) => [
        "queued",
        "running",
        "waiting_dependency",
        "awaiting_payment",
        "failed",
      ].includes(value.item.status))
      .map(([itemTarget]) => itemTarget),
  ), [latestItems]);

  useEffect(() => onPendingChange?.(pending), [onPendingChange, pending]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  useEffect(() => {
    requestRevision.current += 1;
    setTarget(null);
    setPending(false);
    setError(null);
    setPendingQuote(null);
    setTasks([]);
    setRetryingItemId(null);
    if (shot && onListTasks) {
      void onListTasks()
        .then((response) => setTasks(response.tasks.filter(
          (task) => task.task_type === "resource_image.generate",
        )))
        .catch(() => undefined);
    }
  }, [onListTasks, projectId, shot?.id]);

  const latestTaskEvent = taskEvents[taskEvents.length - 1];
  useEffect(() => {
    if (!latestTaskEvent || !onListTasks || !shot
      || !["task", "task_item"].includes(latestTaskEvent.stage)) return;
    void onListTasks()
      .then((response) => setTasks(response.tasks.filter(
        (task) => task.task_type === "resource_image.generate",
      )))
      .catch(() => undefined);
  }, [latestTaskEvent?.id, onListTasks, shot?.id]);

  useEffect(() => {
    for (const [itemTarget, { item }] of latestItems) {
      if (item.status !== "complete" || appliedItemIds.current.has(item.id)) continue;
      const published = publishedAsset(item);
      if (!published) continue;
      appliedItemIds.current.add(item.id);
      onGenerated(itemTarget, published.asset, published.mediaUrl);
    }
  }, [latestItems, onGenerated]);

  const open = (nextTarget: FrameTarget, opener: HTMLElement) => {
    if (!shot || busy || pending || blockedTargets.has(nextTarget) || !onGenerate) return;
    openerRef.current = opener;
    setError(null);
    setPendingQuote(null);
    setTarget(nextTarget);
  };

  const generate = async (payload: GenerateImagesRequest) => {
    if (!onGenerate || !shot || !target || pending || busy) return;
    const submittedTarget = target;
    const capturedProjectId = projectId;
    const capturedShotId = shot.id;
    const parameters: GenerationParameters = {
      kind: "scene",
      label: payload.label,
      description: payload.description,
      prompt: payload.prompt,
      model: payload.model,
      count: 1,
      size: payload.size,
      quality: payload.quality,
      shot_id: capturedShotId,
      frame_target: submittedTarget,
    };
    const retryBillingJobId = pendingQuote
      && pendingQuote.target === submittedTarget
      && sameGenerationParameters(pendingQuote.parameters, parameters)
      ? pendingQuote.billingJobId
      : null;
    const requestPayload: GenerateImagesRequest = retryBillingJobId
      ? { ...parameters, billing_job_id: retryBillingJobId }
      : parameters;
    const revision = ++requestRevision.current;
    setPending(true);
    setError(null);
    try {
      const result = await onGenerate(requestPayload);
      if (
        requestRevision.current !== revision
        || projectId !== capturedProjectId
        || shot.id !== capturedShotId
      ) return;
      if (!result.task_id) throw new Error(strings.keyframeGenerationFailed);
      setTasks((current) => [
        result.task,
        ...current.filter((task) => task.id !== result.task.id),
      ]);
      setPendingQuote(null);
      setTarget(null);
    } catch (caught) {
      if (requestRevision.current !== revision) return;
      const recovered = commandErrorFrom(caught, {
        fallback: strings.keyframeGenerationFailed,
        onSessionExpired,
        walletAvailableUnits,
      });
      setError(recovered);
      setPendingQuote(
        recovered?.kind === "payment" && recovered.billingJobId
          ? {
              billingJobId: recovered.billingJobId,
              parameters,
              target: submittedTarget,
            }
          : null,
      );
    } finally {
      if (requestRevision.current === revision) setPending(false);
    }
  };

  const retry = async (batchId: string, itemId: string) => {
    if (!onRetryTaskItem || retryingItemId) return;
    setRetryingItemId(itemId);
    setError(null);
    try {
      const retried = await onRetryTaskItem(batchId, itemId);
      setTasks((current) => [
        retried,
        ...current.filter((task) => task.id !== retried.id),
      ]);
    } catch (caught) {
      setError(commandErrorFrom(caught, {
        fallback: strings.keyframeGenerationFailed,
        onSessionExpired,
        walletAvailableUnits,
      }));
    } finally {
      setRetryingItemId(null);
    }
  };

  return (
    <>
      <Button
        icon={<Sparkles size={15} />}
        loading={loadingTargets.has("first")}
        disabled={!shot || busy || pending || blockedTargets.has("first") || !onGenerate}
        onClick={(event) => open("first", event.currentTarget)}
      >
        {strings.generateFirstFrameAction}
      </Button>
      <Button
        icon={<Sparkles size={15} />}
        loading={loadingTargets.has("last")}
        disabled={!shot || busy || pending || blockedTargets.has("last") || !onGenerate}
        onClick={(event) => open("last", event.currentTarget)}
      >
        {strings.generateTailFrameAction}
      </Button>
      {target && shot ? (
        <AssetGenerationDrawer
          key={`${projectId}:${shot.id}:${target}`}
          busy={pending}
          error={error}
          fixedCount={1}
          generationPreferences={frameGenerationPreferences}
          initialDescription={target === "first"
            ? "AI fallback first frame for shot continuity"
            : "Explicit AI target tail frame for shot continuity"}
          initialKind="scene"
          initialLabel={`${shot.id} ${target === "first" ? "first" : "target tail"} frame`}
          initialPrompt={continuityImagePrompt(shot, draft, target)}
          lockKind
          returnFocusRef={openerRef}
          title={target === "first"
            ? strings.generateFirstFrameDialogTitle
            : strings.generateTailFrameDialogTitle}
          onClose={() => {
            if (pending) return;
            setTarget(null);
            setError(null);
            setPendingQuote(null);
          }}
          onSubmit={generate}
        />
      ) : null}
      {["first", "last"].map((itemTarget) => {
        const taskItem = latestItems.get(itemTarget as FrameTarget);
        if (!taskItem || !["awaiting_payment", "failed"].includes(taskItem.item.status)) {
          return null;
        }
        return (
          <div key={itemTarget} role="alert">
            <span>{taskItem.item.status === "awaiting_payment"
              ? strings.keyframeAwaitingPayment
              : taskItem.item.error_message ?? strings.keyframeGenerationFailed}</span>
            {taskItem.item.retryable && onRetryTaskItem ? (
              <Button
                disabled={retryingItemId !== null}
                loading={retryingItemId === taskItem.item.id}
                onClick={() => void retry(taskItem.batchId, taskItem.item.id)}
              >
                {strings.retryKeyframeGenerationAction}
              </Button>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
