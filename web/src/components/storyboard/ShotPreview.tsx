import type { Shot } from "../../domain/types";
import { getStrings } from "../../i18n";

export interface ShotPreviewProps {
  shot: Shot | null;
  mediaUrl: string | null;
}

export function ShotPreview({ shot, mediaUrl }: ShotPreviewProps) {
  const strings = getStrings("zh").storyboardPage;

  return (
    <section className="storyboard-preview" aria-label={strings.previewLabel}>
      <div className="section-heading">
        <h2>{shot ? strings.shotTitle(shot.index) : strings.previewLabel}</h2>
        {shot ? <span>{shot.beat}</span> : null}
      </div>
      {!shot ? <p className="empty-state">{strings.noSelectedShot}</p> : null}
      {shot && mediaUrl ? (
        <video
          controls
          preload="metadata"
          src={mediaUrl}
          aria-label={strings.previewMediaLabel(shot.index)}
        />
      ) : null}
      {shot && !mediaUrl ? <p className="empty-state">{strings.noPreviewMedia}</p> : null}
    </section>
  );
}
