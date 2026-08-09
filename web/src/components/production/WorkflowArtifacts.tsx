import { Workflow } from "lucide-react";
import type { ProductionShotSummary, WorkflowArtifactStatus } from "../../domain/types";
import { getStrings, type UIStrings } from "../../i18n";

export interface WorkflowArtifactsProps {
  artifacts: WorkflowArtifactStatus[];
  shotSummary?: ProductionShotSummary | null;
  strings?: UIStrings["production"]["workflowArtifacts"];
}

export function WorkflowArtifacts({
  artifacts,
  shotSummary = null,
  strings = getStrings("zh").production.workflowArtifacts,
}: WorkflowArtifactsProps) {
  return (
    <section className="review-section" aria-label={strings.regionLabel}>
      <div className="section-heading">
        <Workflow aria-hidden="true" size={18} />
        <h2>{strings.title}</h2>
      </div>
      {shotSummary ? (
        <dl className="production-shot-summary" aria-label={strings.shotSummaryLabel}>
          <div>
            <dt>{strings.totalShotsLabel}</dt>
            <dd>{shotSummary.total}</dd>
          </div>
          <div>
            <dt>{strings.reusableShotsLabel}</dt>
            <dd>{shotSummary.reusable}</dd>
          </div>
          <div>
            <dt>{strings.generateShotsLabel}</dt>
            <dd>{shotSummary.to_generate}</dd>
          </div>
          <div>
            <dt>{strings.completedShotsLabel}</dt>
            <dd>{shotSummary.completed}</dd>
          </div>
        </dl>
      ) : null}
      {artifacts.length === 0 ? (
        <p className="empty-state">{strings.emptyState}</p>
      ) : (
        <ul className="workflow-list" aria-label={strings.title}>
          {artifacts.map((artifact) => (
            <li
              className={artifact.exists ? "workflow-ok" : "workflow-missing"}
              key={`${artifact.name}-${artifact.path}`}
            >
              <strong>{artifact.name}</strong>
              <span>{artifact.exists ? strings.existsStatus : strings.missingStatus}</span>
              <small
                aria-label={`${strings.pathLabel}: ${artifact.path}`}
                className="final-path"
                style={{ overflowWrap: "anywhere" }}
              >
                {strings.pathLabel}: {artifact.path}
              </small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
