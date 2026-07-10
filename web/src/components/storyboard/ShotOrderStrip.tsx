import type { Shot } from "../../domain/types";
import { getStrings } from "../../i18n";

export interface ShotOrderStripProps {
  shots: Shot[];
  selectedShotId: string | null;
  onSelect: (shotId: string) => void;
}

export function ShotOrderStrip({ shots, selectedShotId, onSelect }: ShotOrderStripProps) {
  const strings = getStrings("zh").storyboardPage;

  return (
    <ol className="storyboard-order-strip" aria-label={strings.orderLabel}>
      {shots.map((shot) => (
        <li key={shot.id}>
          <button
            type="button"
            aria-label={strings.selectOrderedShotLabel(shot.index)}
            aria-pressed={selectedShotId === shot.id}
            onClick={() => onSelect(shot.id)}
          >
            {shot.index}
          </button>
        </li>
      ))}
    </ol>
  );
}
