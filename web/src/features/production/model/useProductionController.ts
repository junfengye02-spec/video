import { useRef, useState } from "react";
import {
  commandErrorFrom,
  type CommandError,
} from "../../../components/feedback/DomainErrorBoundary";
import type { RenderPreparation, ProductionSnapshot, Shot } from "../../../domain/types";
import type { ContinuityPlan, RenderReport } from "../../../domain/types";
import type { TaskBatch } from "../../../domain/types";
import { getStrings } from "../../../i18n";

export interface ProductionControllerProps {
  consistencyReport: import("../../../domain/types").ConsistencyReport | null;
  connectionState?: import("../../../domain/types").ProductionConnectionState;
  downloading: boolean;
  events: import("../../../domain/types").JobEvent[];
  finalPath: string | null;
  finalRenderUrl: string | null;
  projectId?: string | null;
  continuityPlan?: ContinuityPlan | null;
  renderReport?: RenderReport | null;
  production?: ProductionSnapshot | null;
  refreshing?: boolean;
  rendering: boolean;
  shots: Shot[];
  shotCount: number;
  workflowArtifacts: import("../../../domain/types").WorkflowArtifactStatus[];
  onDownload: () => Promise<void>;
  onPrepareRender?: (selectedShotIds?: string[]) => Promise<RenderPreparation>;
  onRefresh?: () => Promise<void>;
  onRetryTaskItem?: (taskId: string, itemId: string) => Promise<TaskBatch>;
  onRender: (selectedShotIds?: string[]) => Promise<void>;
  onSessionExpired?: () => void;
  walletAvailableUnits?: number | null;
}

export function useProductionController({
  finalPath,
  production = null,
  rendering,
  shotCount,
  onPrepareRender,
  onRender,
  onSessionExpired,
  walletAvailableUnits = null,
}: Pick<ProductionControllerProps, "finalPath" | "production" | "rendering" | "shotCount" | "onPrepareRender" | "onRender" | "onSessionExpired" | "walletAvailableUnits">) {
  const strings = getStrings("zh").production;
  const errorStrings = getStrings("zh").errors;
  const [commandError, setCommandError] = useState<CommandError | null>(null);
  const [confirmation, setConfirmation] = useState<RenderPreparation | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const renderInFlightRef = useRef(false);
  const prepareInFlightRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeJob = production?.active_job ?? null;
  const serverRendering = Boolean(activeJob && [
    "queued",
    "running",
    "waiting_dependency",
    "awaiting_payment",
  ].includes(activeJob.status));
  const renderDisabled = shotCount === 0 || rendering || serverRendering || preparing || submitting;
  const remaking = Boolean(finalPath);

  const closeConfirmation = () => {
    if (submitting) return;
    setConfirmation(null);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleRender = async (selectedShotIds?: string[]) => {
    if (renderDisabled || renderInFlightRef.current) return;
    renderInFlightRef.current = true;
    setSubmitting(true);
    try {
      setCommandError(null);
      setConfirmation(null);
      await onRender(selectedShotIds);
    } catch (renderError) {
      setCommandError(commandErrorFrom(renderError, { fallback: errorStrings.renderFallback, onSessionExpired, walletAvailableUnits }));
    } finally {
      renderInFlightRef.current = false;
      setSubmitting(false);
    }
  };

  const handlePrepare = async (selectedShotIds?: string[]) => {
    if (renderDisabled || prepareInFlightRef.current) return;
    if (!onPrepareRender) {
      await handleRender(selectedShotIds);
      return;
    }
    prepareInFlightRef.current = true;
    setPreparing(true);
    try {
      setCommandError(null);
      setConfirmation(await onPrepareRender(selectedShotIds));
    } catch (prepareError) {
      setCommandError(commandErrorFrom(prepareError, { fallback: errorStrings.renderFallback, onSessionExpired, walletAvailableUnits }));
    } finally {
      prepareInFlightRef.current = false;
      setPreparing(false);
    }
  };

  return {
    strings,
    commandError,
    confirmation,
    preparing,
    submitting,
    triggerRef,
    activeJob,
    serverRendering,
    renderDisabled,
    remaking,
    closeConfirmation,
    handleRender,
    handlePrepare,
  };
}
