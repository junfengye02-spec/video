import { CheckCheck } from "lucide-react";
import type { Shot } from "../../domain/types";
import type { UIStrings } from "../../i18n";

export interface ShotSelectionPanelProps {
  shots: Shot[];
  selectedShotIds: string[];
  disabled?: boolean;
  strings: UIStrings["production"]["shotSelection"];
  onToggle: (shotId: string) => void;
  onSelectAll: () => void;
}

export function ShotSelectionPanel({
  shots,
  selectedShotIds,
  disabled = false,
  strings,
  onToggle,
  onSelectAll,
}: ShotSelectionPanelProps) {
  const selected = new Set(selectedShotIds);
  const allSelected = shots.length > 0 && shots.every((shot) => selected.has(shot.id));

  return (
    <section className="production-shot-selection" aria-label={strings.regionLabel}>
      <header>
        <div>
          <h3>{strings.title}</h3>
          <p>{strings.selectedCount(selected.size, shots.length)}</p>
        </div>
        <button
          aria-label={strings.selectAllAction}
          className="icon-text-button"
          disabled={disabled || allSelected}
          onClick={onSelectAll}
          type="button"
        >
          <CheckCheck aria-hidden="true" size={15} />
          <span>{strings.selectAllAction}</span>
        </button>
      </header>
      <div className="production-shot-selection-list">
        {shots.map((shot) => (
          <label className="production-shot-selection-item" key={shot.id}>
            <input
              aria-label={strings.shotLabel(shot.index, shot.beat)}
              checked={selected.has(shot.id)}
              disabled={disabled}
              onChange={() => onToggle(shot.id)}
              type="checkbox"
            />
            <span className="production-shot-selection-copy">
              <strong>{`#${shot.index}`}</strong>
              <span>{shot.beat || shot.prompt || shot.id}</span>
              <small>{strings.statusLabels[shot.status]}</small>
            </span>
          </label>
        ))}
      </div>
      {selected.size === 0 ? <p className="production-shot-selection-empty" role="alert">{strings.emptySelection}</p> : null}
    </section>
  );
}
