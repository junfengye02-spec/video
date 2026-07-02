import { RefreshCw, Video } from "lucide-react";
import { orderedShots } from "../domain/storyboard";
import type { Shot } from "../domain/types";
import type { UIStrings } from "../i18n";

interface StoryboardWaterfallProps {
  regeneratingShotId: string | null;
  shots: Shot[];
  strings: UIStrings["storyboardWaterfall"];
  onRegenerate: (shot: Shot) => void;
}

export function StoryboardWaterfall({
  regeneratingShotId,
  shots,
  strings,
  onRegenerate,
}: StoryboardWaterfallProps) {
  return (
    <section className="storyboard-panel" aria-label={strings.regionLabel}>
      <div className="section-heading">
        <Video aria-hidden="true" size={18} />
        <h2>{strings.title}</h2>
      </div>
      <div className="shot-list">
        {shots.length === 0 ? (
          <div className="storyboard-empty">
            <p>{strings.emptyState}</p>
          </div>
        ) : (
          orderedShots(shots).map((shot) => (
            <article className="shot-card" key={shot.id}>
              <div className="shot-index">{String(shot.index).padStart(2, "0")}</div>
              <div className="shot-body">
                <div className="shot-topline">
                  <h3>{shot.beat}</h3>
                  <span className={`status-pill status-${shot.status}`}>{strings.statusLabels[shot.status]}</span>
                </div>
                <p>{shot.prompt}</p>
                <div className="shot-meta">
                  <span>{shot.location ?? strings.noLocationFallback}</span>
                  <span>{strings.scoreLabel(shot.consistency_score)}</span>
                  <span>{strings.versionLabel(shot.version ?? 1)}</span>
                </div>
              </div>
              <button
                className="icon-button"
                type="button"
                title={strings.regenerateShotLabel(shot.index)}
                aria-label={strings.regenerateShotLabel(shot.index)}
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
