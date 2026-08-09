import { Activity, CircleAlert, RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  JobEvent,
  ProductionActiveJob,
  ProductionConnectionState,
} from "../domain/types";
import { getStrings, type UIStrings } from "../i18n";

export interface JobProgressProps {
  events: JobEvent[];
  activeJob?: ProductionActiveJob | null;
  connectionState?: ProductionConnectionState;
  rendering?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void | Promise<void>;
  strings?: UIStrings["production"]["jobProgress"];
}

type VisibleProductionStage =
  | "idle"
  | "preparing"
  | "queued"
  | "generating"
  | "composing"
  | "finalizing"
  | "quota"
  | "failed"
  | "complete";

const STAGE_PROGRESS: Record<VisibleProductionStage, number> = {
  idle: 0,
  preparing: 12,
  queued: 20,
  generating: 48,
  composing: 78,
  finalizing: 92,
  quota: 12,
  failed: 0,
  complete: 100,
};

const ACTIVE_STEP: Record<VisibleProductionStage, number> = {
  idle: -1,
  preparing: 0,
  queued: 1,
  quota: 0,
  generating: 1,
  composing: 2,
  finalizing: 3,
  failed: -1,
  complete: 4,
};

function visibleStage(
  latest: JobEvent | null,
  activeJob: ProductionActiveJob | null,
  rendering: boolean,
): VisibleProductionStage {
  if (
    latest?.status === "failed"
    || activeJob?.status === "failed"
    || activeJob?.status === "partial_failure"
  ) return "failed";
  const inFlight = rendering || Boolean(activeJob && [
    "queued",
    "running",
    "waiting_dependency",
    "awaiting_payment",
  ].includes(activeJob.status));
  if (inFlight) {
    if (activeJob?.billing_job_id) return "quota";
    if (activeJob?.status === "queued") return "queued";
    if (latest?.status === "queued") return "queued";
    if (latest?.status !== "complete" && latest?.stage === "assets") return "generating";
    if (latest?.status !== "complete" && latest?.stage === "compose") return "composing";
    if (latest?.status !== "complete" && latest?.stage === "package") return "finalizing";
    return "preparing";
  }
  if (latest?.status === "complete" || activeJob?.status === "complete") return "complete";
  if (activeJob?.billing_job_id) return "quota";
  if (latest?.status === "queued") return "queued";
  if (latest?.stage === "assets") return "generating";
  if (latest?.stage === "compose") return "composing";
  if (latest?.stage === "package") return "finalizing";
  return "idle";
}

export function JobProgress({
  events,
  activeJob = null,
  connectionState = "connected",
  rendering = false,
  refreshing = false,
  onRefresh,
  strings = getStrings("zh").production.jobProgress,
}: JobProgressProps) {
  const productionEvents = events.filter((event) => (
    ["render", "assets", "compose", "package"].includes(event.stage)
    || Boolean(activeJob && event.job_id === activeJob.id)
  ));
  const latest = productionEvents.length
    ? productionEvents[productionEvents.length - 1]
    : null;
  const stage = visibleStage(latest, activeJob, rendering);
  const progress = STAGE_PROGRESS[stage];
  const activeStep = ACTIVE_STEP[stage];
  const [localRefreshing, setLocalRefreshing] = useState(false);
  const refreshPending = refreshing || localRefreshing;
  useEffect(() => {
    if (!refreshing) setLocalRefreshing(false);
  }, [refreshing]);
  const showRecovery = Boolean(
    onRefresh && (stage === "failed" || connectionState === "disconnected"),
  );

  const handleRefresh = () => {
    if (!onRefresh || refreshPending) return;
    setLocalRefreshing(true);
    try {
      const result = onRefresh();
      if (result && typeof result.then === "function") {
        void result.finally(() => setLocalRefreshing(false));
      } else {
        setLocalRefreshing(false);
      }
    } catch {
      setLocalRefreshing(false);
    }
  };

  return (
    <section className="production-progress" aria-label={strings.regionLabel}>
      <div className="section-heading">
        <Activity aria-hidden="true" size={18} />
        <h2>{strings.title}</h2>
      </div>
      <div className="production-progress-status" data-stage={stage} aria-live="polite">
        <div>
          {stage === "failed"
            ? <CircleAlert aria-hidden="true" size={17} />
            : <Activity aria-hidden="true" size={17} />}
          <p>
            <strong>{strings.stageLabels[stage]}</strong>
            <span>{stage === "idle" ? strings.emptyState : strings.stageDescriptions[stage]}</span>
          </p>
        </div>
        <span>{progress}%</span>
      </div>
      <div className="production-progress-track" aria-hidden="true">
        <i style={{ width: `${progress}%` }} />
      </div>
      <ol className="production-step-list">
        {strings.steps.map((step, index) => {
          const state = stage === "complete" || index < activeStep
            ? "complete"
            : index === activeStep
              ? "active"
              : "pending";
          return <li data-state={state} key={step}>{step}</li>;
        })}
      </ol>
      <div className="production-connection" data-state={connectionState}>
        {connectionState === "disconnected" ? <WifiOff aria-hidden="true" size={14} /> : null}
        <span>{strings.connectionLabels[connectionState]}</span>
        {showRecovery ? (
          <button type="button" disabled={refreshPending} onClick={handleRefresh}>
            <RefreshCw aria-hidden="true" size={14} />
            {refreshPending ? strings.refreshingAction : strings.refreshAction}
          </button>
        ) : null}
      </div>
    </section>
  );
}
