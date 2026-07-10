import type { Shot } from "../../domain/types";
import { getStrings } from "../../i18n";

export interface ShotListProps {
  shots: Shot[];
  selectedShotId: string | null;
  onSelect: (shotId: string) => void;
}

export function ShotList({ shots, selectedShotId, onSelect }: ShotListProps) {
  const strings = getStrings("zh");

  return (
    <nav className="storyboard-shot-list" aria-label={strings.storyboardPage.shotListLabel}>
      <div className="section-heading">
        <h2>{strings.storyboardPage.shotListLabel}</h2>
      </div>
      {shots.length === 0 ? (
        <p className="empty-state">{strings.storyboardPage.emptyShots}</p>
      ) : (
        <ol>
          {shots.map((shot) => (
            <li key={shot.id}>
              <button
                type="button"
                aria-label={strings.storyboardPage.selectShotLabel(shot.index)}
                aria-pressed={selectedShotId === shot.id}
                onClick={() => onSelect(shot.id)}
              >
                <span>{strings.storyboardPage.shotTitle(shot.index)}</span>
                <span>{shot.beat}</span>
                <span className={`status-pill status-${shot.status}`}>
                  {strings.storyboardWaterfall.statusLabels[shot.status]}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}
