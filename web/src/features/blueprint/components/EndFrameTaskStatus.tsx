import {
  CircleAlert,
  CircleCheck,
  CircleDollarSign,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  JobEvent,
  TaskBatch,
  TaskItem,
  TaskItemStatus,
  TaskListResponse,
} from "../../../domain/types";
import styles from "../BlueprintWorkspace.module.css";

type FrameTarget = "first" | "last";

const PURPOSE = "inspiration_end_frames";

const STATUS_LABELS: Record<TaskItemStatus, string> = {
  waiting_provider: "\u7b49\u5f85\u4f9b\u5e94\u5546",
  queued: "准备中",
  running: "准备中",
  waiting_dependency: "准备中",
  awaiting_payment: "待支付",
  failed: "生成失败",
  cancelled: "生成失败",
  complete: "已完成",
};

function targetFor(item: TaskItem): FrameTarget | null {
  const target = item.input.frame_target;
  return target === "first" || target === "last" ? target : null;
}

function batchPurpose(task: TaskBatch): unknown {
  if (task.snapshot?.purpose) return task.snapshot.purpose;
  const inner = task.snapshot?.snapshot;
  return inner && typeof inner === "object"
    ? (inner as Record<string, unknown>).purpose
    : null;
}

function statusIcon(status: TaskItemStatus) {
  if (status === "complete") return <CircleCheck aria-hidden="true" size={14} />;
  if (status === "awaiting_payment") return <CircleDollarSign aria-hidden="true" size={14} />;
  if (["failed", "cancelled"].includes(status)) return <CircleAlert aria-hidden="true" size={14} />;
  return <LoaderCircle aria-hidden="true" className={styles.endFrameSpinner} size={14} />;
}

export interface EndFrameTaskStatusProps {
  enabled: boolean;
  onListTasks?: () => Promise<TaskListResponse>;
  onRetryTaskItem?: (taskId: string, itemId: string) => Promise<TaskBatch>;
  taskEvents?: JobEvent[];
}

export function EndFrameTaskStatus({
  enabled,
  onListTasks,
  onRetryTaskItem,
  taskEvents = [],
}: EndFrameTaskStatusProps) {
  const [tasks, setTasks] = useState<TaskBatch[]>([]);
  const [retryingItemId, setRetryingItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled || !onListTasks) return;
    try {
      const response = await onListTasks();
      setTasks(response.tasks);
    } catch {
      setError("暂时无法刷新画面状态");
    }
  }, [enabled, onListTasks]);

  useEffect(() => {
    setTasks([]);
    setError(null);
    void refresh();
  }, [refresh]);

  const latestEvent = taskEvents[taskEvents.length - 1];
  useEffect(() => {
    if (!latestEvent || !["task", "task_item"].includes(latestEvent.stage)) return;
    void refresh();
  }, [latestEvent?.id, refresh]);

  const batch = useMemo(
    () => tasks.find((task) => batchPurpose(task) === PURPOSE) ?? null,
    [tasks],
  );
  const items = useMemo(() => {
    const mapped = new Map<FrameTarget, TaskItem>();
    for (const item of batch?.items ?? []) {
      const target = targetFor(item);
      if (target && !mapped.has(target)) mapped.set(target, item);
    }
    return mapped;
  }, [batch]);

  if (!enabled) return null;

  async function retry(item: TaskItem) {
    if (!batch || !onRetryTaskItem || retryingItemId) return;
    setRetryingItemId(item.id);
    setError(null);
    try {
      const updated = await onRetryTaskItem(batch.id, item.id);
      setTasks((current) => [
        updated,
        ...current.filter((task) => task.id !== updated.id),
      ]);
    } catch {
      setError("暂时无法重试画面生成");
    } finally {
      setRetryingItemId(null);
    }
  }

  return (
    <div className={styles.endFrameStatus} aria-label="首尾画面状态">
      {(["first", "last"] as const).map((target) => {
        const item = items.get(target);
        const status = item?.status ?? "queued";
        const canRetry = Boolean(
          item
          && onRetryTaskItem
          && ["awaiting_payment", "failed"].includes(status)
          && item.retryable,
        );
        const targetLabel = target === "first" ? "首帧" : "尾帧";
        return (
          <span key={target} className={styles.endFrameItem} data-status={status}>
            {statusIcon(status)}
            <span>{targetLabel} {STATUS_LABELS[status]}</span>
            {canRetry && item ? (
              <button
                type="button"
                title={`重试${targetLabel}`}
                aria-label={`重试${targetLabel}`}
                disabled={retryingItemId !== null}
                onClick={() => void retry(item)}
              >
                <RotateCcw aria-hidden="true" size={13} />
              </button>
            ) : null}
          </span>
        );
      })}
      {error ? <small role="alert">{error}</small> : null}
    </div>
  );
}
