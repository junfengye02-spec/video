import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  Hourglass,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import type { ShotStatus, TaskItemStatus } from "../../../domain/types";
import { getStrings } from "../../../i18n";
import styles from "./ShotList.module.css";

const ICONS = {
  complete: CheckCircle2,
  draft: CircleDashed,
  failed: AlertCircle,
  generating: LoaderCircle,
  ready: Clock3,
  stale: RefreshCw,
} satisfies Record<ShotStatus, typeof CheckCircle2>;

export function ShotStatusLabel({ status }: { status: ShotStatus }) {
  const Icon = ICONS[status];
  const label = getStrings("zh").storyboardWaterfall.statusLabels[status];
  return (
    <span className={styles.status} data-status={status}>
      <Icon aria-hidden="true" size={13} />
      <span>{label}</span>
    </span>
  );
}

const TASK_ICONS = {
  queued: Clock3,
  running: LoaderCircle,
  awaiting_payment: AlertCircle,
  waiting_dependency: Clock3,
  waiting_provider: Hourglass,
  complete: CheckCircle2,
  failed: AlertCircle,
  cancelled: AlertCircle,
} satisfies Record<TaskItemStatus, typeof CheckCircle2>;

export function ShotTaskStatusLabel({ status }: { status: TaskItemStatus }) {
  const Icon = TASK_ICONS[status];
  const label = getStrings("zh").storyboardPage.shotTaskStatusLabels[status];
  return (
    <span className={styles.status} data-task-status={status}>
      <Icon aria-hidden="true" size={13} />
      <span>{label}</span>
    </span>
  );
}
