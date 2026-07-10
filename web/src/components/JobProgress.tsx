import { Activity } from "lucide-react";
import type { JobEvent } from "../domain/types";
import { getStrings, type UIStrings } from "../i18n";

export interface JobProgressProps {
  events: JobEvent[];
  strings?: UIStrings["production"]["jobProgress"];
}

export function JobProgress({
  events,
  strings = getStrings("zh").production.jobProgress,
}: JobProgressProps) {
  return (
    <section className="review-section" aria-label={strings.regionLabel}>
      <div className="section-heading">
        <Activity aria-hidden="true" size={18} />
        <h2>{strings.title}</h2>
      </div>
      {events.length === 0 ? (
        <p className="empty-state">{strings.emptyState}</p>
      ) : (
        <ol className="event-list">
          {events.map((event) => (
            <li key={event.id}>
              <span>{event.stage}</span>
              <strong>{event.status}</strong>
              <small>{event.message}</small>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
