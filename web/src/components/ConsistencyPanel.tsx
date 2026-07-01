import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { scoreTone } from "../domain/consistency";
import type { ConsistencyReport } from "../domain/types";

interface ConsistencyPanelProps {
  report: ConsistencyReport | null;
}

export function ConsistencyPanel({ report }: ConsistencyPanelProps) {
  const score = report?.score ?? 0;
  const hasIssues = Boolean(report?.issues.length);
  const tone = scoreTone(report);

  return (
    <section className={`review-section consistency-${tone}`} aria-label="Consistency report">
      <div className="section-heading">
        <h2>Consistency</h2>
        <span>{report ? score : "-"}</span>
      </div>
      {!report ? (
        <p className="empty-state">No report yet.</p>
      ) : hasIssues ? (
        <ul className="issue-list">
          {report.issues.map((issue, index) => (
            <li key={`${issue.code}-${issue.shot_id ?? index}`}>
              <AlertTriangle aria-hidden="true" size={15} />
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="clean-report">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>No issues found</span>
        </div>
      )}
    </section>
  );
}
