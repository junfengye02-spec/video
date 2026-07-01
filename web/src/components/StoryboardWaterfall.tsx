import { RefreshCw, Video } from "lucide-react";
import { orderedShots } from "../domain/storyboard";
import type { Shot } from "../domain/types";

interface StoryboardWaterfallProps {
  regeneratingShotId: string | null;
  shots: Shot[];
  onRegenerate: (shot: Shot) => void;
}

export function StoryboardWaterfall({
  regeneratingShotId,
  shots,
  onRegenerate,
}: StoryboardWaterfallProps) {
  return (
    <section className="storyboard-panel" aria-label="Storyboard waterfall">
      <div className="section-heading">
        <Video aria-hidden="true" size={18} />
        <h2>Storyboard Waterfall</h2>
      </div>
      <div className="shot-list">
        {shots.length === 0 ? (
          <div className="storyboard-empty">
            <p>No shots generated.</p>
          </div>
        ) : (
          orderedShots(shots).map((shot) => (
            <article className="shot-card" key={shot.id}>
              <div className="shot-index">{String(shot.index).padStart(2, "0")}</div>
              <div className="shot-body">
                <div className="shot-topline">
                  <h3>{shot.beat}</h3>
                  <span className={`status-pill status-${shot.status}`}>{shot.status}</span>
                </div>
                <p>{shot.prompt}</p>
                <div className="shot-meta">
                  <span>{shot.location ?? "No location"}</span>
                  <span>Score {shot.consistency_score}</span>
                  <span>Version {shot.version ?? 1}</span>
                </div>
              </div>
              <button
                className="icon-button"
                type="button"
                title={`Regenerate shot ${shot.index}`}
                aria-label={`Regenerate shot ${shot.index}`}
                disabled={regeneratingShotId === shot.id}
                onClick={() => onRegenerate(shot)}
              >
                <RefreshCw aria-hidden="true" size={17} />
              </button>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
