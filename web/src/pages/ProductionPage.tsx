import { Film } from "lucide-react";
import { useRef } from "react";
import { ConsistencyPanel } from "../components/ConsistencyPanel";
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
}: ProductionPageProps) {
  const strings = getStrings("zh").production;
  const renderDisabled = shotCount === 0 || rendering;
  const renderInFlightRef = useRef(false);

  const handleRender = async () => {
    if (renderDisabled || renderInFlightRef.current) {
      return;
    }
    renderInFlightRef.current = true;
    try {
      await onRender();
    } catch {
      // The callback owner publishes operation errors.
    } finally {
      renderInFlightRef.current = false;
    }
  };

  return (
    <section className="storyboard-panel production-page" aria-label={strings.pageLabel}>
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
      <button
        className="render-button"
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
