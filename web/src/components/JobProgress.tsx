import { Activity } from "lucide-react";
import type { JobEvent } from "../domain/types";

interface JobProgressProps {
  events: JobEvent[];
}

export function JobProgress({ events }: JobProgressProps) {
  return (
    <section className="review-section" aria-label="Job progress">
      <div className="section-heading">
        <Activity aria-hidden="true" size={18} />
        <h2>Progress</h2>
      </div>
      {events.length === 0 ? (
        <p className="empty-state">No active jobs.</p>
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
