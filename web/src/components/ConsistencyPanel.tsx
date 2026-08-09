import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { scoreTone } from "../domain/consistency";
import type { ConsistencyReport } from "../domain/types";
import { getStrings, type UIStrings } from "../i18n";

export interface ConsistencyPanelProps {
  report: ConsistencyReport | null;
  strings?: UIStrings["production"]["consistency"];
}

const ISSUE_PAGE_SIZE = 10;

export function ConsistencyPanel({
  report,
  strings = getStrings("zh").production.consistency,
}: ConsistencyPanelProps) {
  const score = report?.score ?? 0;
  const hasIssues = Boolean(report?.issues.length);
  const tone = scoreTone(report);
  const issueCount = report?.issues.length ?? 0;
  const issuePageCount = Math.max(1, Math.ceil(issueCount / ISSUE_PAGE_SIZE));
  const [issuePage, setIssuePage] = useState(0);
  const safeIssuePage = Math.min(issuePage, issuePageCount - 1);
  const visibleIssues = report?.issues.slice(
    safeIssuePage * ISSUE_PAGE_SIZE,
    (safeIssuePage + 1) * ISSUE_PAGE_SIZE,
  ) ?? [];

  useEffect(() => {
    setIssuePage((current) => Math.min(current, issuePageCount - 1));
  }, [issuePageCount]);

  return (
    <section className={`review-section consistency-${tone}`} aria-label={strings.regionLabel}>
      <div className="section-heading">
        <h2>{strings.title}</h2>
        <span>{report ? score : "-"}</span>
      </div>
      {!report ? (
        <p className="empty-state">{strings.noReport}</p>
      ) : hasIssues ? (
        <>
          <ul className="issue-list">
            {visibleIssues.map((issue, index) => (
              <li
                key={`${issue.code}-${issue.shot_id ?? "report"}-${safeIssuePage * ISSUE_PAGE_SIZE + index}`}
                aria-label={`${strings.severityLabels[issue.severity]} ${issue.code}: ${issue.message}`}
                data-severity={issue.severity}
              >
                <AlertTriangle aria-hidden="true" size={15} />
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
          {issuePageCount > 1 ? (
            <nav className="consistency-pagination" aria-label={strings.paginationLabel}>
              <button type="button" aria-label={strings.previousPageLabel} disabled={safeIssuePage === 0} onClick={() => setIssuePage((current) => Math.max(0, current - 1))}>
                <ChevronLeft aria-hidden="true" size={14} />
              </button>
              <span role="status" aria-live="polite" aria-label={strings.paginationStatusLabel}>
                {strings.paginationStatus(safeIssuePage + 1, issuePageCount, issueCount)}
              </span>
              <button type="button" aria-label={strings.nextPageLabel} disabled={safeIssuePage >= issuePageCount - 1} onClick={() => setIssuePage((current) => Math.min(issuePageCount - 1, current + 1))}>
                <ChevronRight aria-hidden="true" size={14} />
              </button>
            </nav>
          ) : null}
        </>
      ) : (
        <div className="clean-report">
          <CheckCircle2 aria-hidden="true" size={18} />
          <span>{strings.noIssues}</span>
        </div>
      )}
    </section>
  );
}
