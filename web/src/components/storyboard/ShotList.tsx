import type { KeyboardEventHandler, Ref } from "react";
import type { Shot } from "../../domain/types";
import { getStrings } from "../../i18n";

export interface ShotListProps {
  modal?: boolean;
  panelRef?: Ref<HTMLElement>;
  shots: Shot[];
  selectedShotId: string | null;
  resolveShotMedia: (shot: Shot) => string | null;
  onSelect: (shotId: string) => void;
  onPanelKeyDown?: KeyboardEventHandler<HTMLElement>;
}

export function ShotList({
  modal = false,
  panelRef,
  shots,
  selectedShotId,
  resolveShotMedia,
  onSelect,
  onPanelKeyDown,
}: ShotListProps) {
  const strings = getStrings("zh");

  return (
    <nav
      ref={panelRef}
      className="storyboard-shot-list"
      role={modal ? "dialog" : undefined}
      aria-modal={modal ? "true" : undefined}
      aria-label={strings.storyboardPage.shotListLabel}
      tabIndex={modal ? -1 : undefined}
      onKeyDown={onPanelKeyDown}
    >
      <div className="section-heading">
        <h2>{strings.storyboardPage.shotListLabel}</h2>
      </div>
      {shots.length === 0 ? (
        <p className="empty-state">{strings.storyboardPage.emptyShots}</p>
      ) : (
        <ol>
          {shots.map((shot) => {
            const mediaUrl = resolveShotMedia(shot);

            return (
              <li key={shot.id}>
                <button
                  type="button"
                  aria-label={strings.storyboardPage.selectShotLabel(shot.index)}
                  aria-pressed={selectedShotId === shot.id}
                  onClick={() => onSelect(shot.id)}
                >
                  <span className="shot-list-thumbnail" aria-hidden={mediaUrl ? undefined : "true"}>
                    {mediaUrl ? (
                      <video
                        aria-label={`${strings.storyboardPage.shotTitle(shot.index)} 缩略预览`}
                        src={mediaUrl}
                        muted
                        playsInline
                        preload="metadata"
                      />
                    ) : (
                      <span className="shot-list-thumbnail-placeholder" />
                    )}
                  </span>
                  <span className="shot-list-title">{strings.storyboardPage.shotTitle(shot.index)}</span>
                  <span className="shot-list-beat">{shot.beat}</span>
                  <span className={`status-pill status-${shot.status}`}>
                    {strings.storyboardWaterfall.statusLabels[shot.status]}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </nav>
  );
}
