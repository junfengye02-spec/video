import { Download, Film } from "lucide-react";
import { getStrings, type UIStrings } from "../../i18n";

export interface FinalRenderPanelProps {
  downloading: boolean;
  finalPath: string | null;
  finalRenderUrl: string | null;
  strings?: UIStrings["production"]["finalRender"];
  onDownload: () => Promise<void>;
}

export function FinalRenderPanel({
  downloading,
  finalPath,
  finalRenderUrl,
  strings = getStrings("zh").production.finalRender,
  onDownload,
}: FinalRenderPanelProps) {
  const downloadDisabled = !finalPath || downloading;

  const handleDownload = () => {
    if (downloadDisabled) {
      return;
    }
    void onDownload().catch(() => undefined);
  };

  return (
    <section className="review-section" aria-label={strings.regionLabel}>
      <div className="section-heading">
        <Film aria-hidden="true" size={18} />
        <h2>{strings.title}</h2>
      </div>
      {finalRenderUrl ? (
        <video
          aria-label={strings.previewLabel}
          className="final-video"
          controls
          preload="metadata"
          src={finalRenderUrl}
        />
      ) : (
        <p className="empty-state">{strings.noPreview}</p>
      )}
      {finalPath ? (
        <p
          aria-label={`${strings.pathLabel}: ${finalPath}`}
          className="final-path"
          style={{ overflowWrap: "anywhere" }}
        >
          {finalPath}
        </p>
      ) : null}
      <button
        className="secondary-button final-download-button"
        type="button"
        disabled={downloadDisabled}
        onClick={handleDownload}
      >
        <Download aria-hidden="true" size={16} />
        {downloading ? strings.downloadingAction : strings.downloadAction}
      </button>
    </section>
  );
}
