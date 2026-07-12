import { Film } from "lucide-react";
import { useRef, useState } from "react";
import { ConsistencyPanel } from "../components/ConsistencyPanel";
import {
  CommandErrorNotice,
  commandErrorFrom,
  type CommandError,
} from "../components/feedback/DomainErrorBoundary";
import { JobProgress } from "../components/JobProgress";
import { FinalRenderPanel } from "../components/production/FinalRenderPanel";
import { WorkflowArtifacts } from "../components/production/WorkflowArtifacts";
import type {
  ConsistencyReport,
  JobEvent,
  WorkflowArtifactStatus,
} from "../domain/types";
import { getStrings } from "../i18n";

export interface ProductionPageProps {
  consistencyReport: ConsistencyReport | null;
  downloading: boolean;
  events: JobEvent[];
  finalPath: string | null;
  finalRenderUrl: string | null;
  rendering: boolean;
  shotCount: number;
  workflowArtifacts: WorkflowArtifactStatus[];
  onDownload: () => Promise<void>;
  onRender: () => Promise<void>;
  onSessionExpired?: () => void;
  walletAvailableUnits?: number | null;
}

export function ProductionPage({
  consistencyReport,
  downloading,
  events,
  finalPath,
  finalRenderUrl,
  rendering,
  shotCount,
  workflowArtifacts,
  onDownload,
  onRender,
  onSessionExpired,
  walletAvailableUnits = null,
}: ProductionPageProps) {
  const strings = getStrings("zh").production;
  const errorStrings = getStrings("zh").errors;
  const [commandError, setCommandError] = useState<CommandError | null>(null);
  const renderDisabled = shotCount === 0 || rendering;
  const renderInFlightRef = useRef(false);

  const handleRender = async () => {
    if (renderDisabled || renderInFlightRef.current) {
      return;
    }
    renderInFlightRef.current = true;
    try {
      setCommandError(null);
      await onRender();
    } catch (renderError) {
      setCommandError(commandErrorFrom(renderError, {
        fallback: errorStrings.renderFallback,
        onSessionExpired,
        walletAvailableUnits,
      }));
    } finally {
      renderInFlightRef.current = false;
    }
  };

  return (
    <section className="storyboard-panel production-page" aria-label={strings.pageLabel}>
      <div className="production-layout">
        <JobProgress events={events} strings={strings.jobProgress} />
        <WorkflowArtifacts artifacts={workflowArtifacts} strings={strings.workflowArtifacts} />
        <ConsistencyPanel report={consistencyReport} strings={strings.consistency} />
        <FinalRenderPanel
          downloading={downloading}
          finalPath={finalPath}
          finalRenderUrl={finalRenderUrl}
          strings={strings.finalRender}
          onDownload={onDownload}
        />
      </div>
      <CommandErrorNotice error={commandError} />
      <button
        className="render-button async-action"
        type="button"
        disabled={renderDisabled}
        onClick={handleRender}
      >
        <Film aria-hidden="true" size={16} />
        {rendering ? strings.renderingAction : strings.renderAction}
      </button>
    </section>
  );
}
