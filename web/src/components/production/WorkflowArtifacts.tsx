import { Workflow } from "lucide-react";
import type { WorkflowArtifactStatus } from "../../domain/types";
import { getStrings, type UIStrings } from "../../i18n";

export interface WorkflowArtifactsProps {
  artifacts: WorkflowArtifactStatus[];
  strings?: UIStrings["production"]["workflowArtifacts"];
}

export function WorkflowArtifacts({
  artifacts,
  strings = getStrings("zh").production.workflowArtifacts,
}: WorkflowArtifactsProps) {
  return (
    <section className="review-section" aria-label={strings.regionLabel}>
      <div className="section-heading">
        <Workflow aria-hidden="true" size={18} />
        <h2>{strings.title}</h2>
      </div>
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
