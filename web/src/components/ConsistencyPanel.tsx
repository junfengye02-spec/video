import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { scoreTone } from "../domain/consistency";
import type { ConsistencyReport } from "../domain/types";
import { getStrings, type UIStrings } from "../i18n";

export interface ConsistencyPanelProps {
  report: ConsistencyReport | null;
  strings?: UIStrings["production"]["consistency"];
}

export function ConsistencyPanel({
  report,
  strings = getStrings("zh").production.consistency,
}: ConsistencyPanelProps) {
  const score = report?.score ?? 0;
  const hasIssues = Boolean(report?.issues.length);
  const tone = scoreTone(report);

  return (
    <section className={`review-section consistency-${tone}`} aria-label={strings.regionLabel}>
      <div className="section-heading">
        <h2>{strings.title}</h2>
        <span>{report ? score : "-"}</span>
      </div>
      {!report ? (
        <p className="empty-state">{strings.noReport}</p>
      ) : hasIssues ? (
        <ul className="issue-list">
          {report.issues.map((issue, index) => (
            <li
              key={`${issue.code}-${issue.shot_id ?? index}`}
              aria-label={`${strings.severityLabels[issue.severity]} ${issue.code}: ${issue.message}`}
              data-severity={issue.severity}
            >
              <AlertTriangle aria-hidden="true" size={15} />
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="clean-report">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>{strings.noIssues}</span>
        </div>
      )}
    </section>
  );
}
