import { Download, Film } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EpisodeOutlineItem, RenderReportOutput } from "../../domain/types";
import { mediaUrl } from "../../api/client";
import { getStrings, type UIStrings } from "../../i18n";

export interface FinalRenderPanelProps {
  aspectRatio?: string | null;
  downloading: boolean;
  finalPath: string | null;
  finalRenderUrl: string | null;
  posterUrl?: string | null;
  projectId?: string | null;
  episodePlan?: EpisodeOutlineItem[];
  episodeOutputs?: RenderReportOutput[];
  activeEpisodeNumber?: number | null;
  strings?: UIStrings["production"]["finalRender"];
  onDownload: () => Promise<void>;
}

export function FinalRenderPanel({
  aspectRatio = null,
  downloading,
  finalPath,
  finalRenderUrl,
  posterUrl = null,
  strings = getStrings("zh").production.finalRender,
  onDownload,
  projectId = null,
  episodePlan = [],
  episodeOutputs = [],
  activeEpisodeNumber = null,
}: FinalRenderPanelProps) {
  const downloadDisabled = !finalPath || downloading;
  const visibleFinalPath = finalPath?.startsWith("local://media/") ? null : finalPath;
  const downloadInFlightRef = useRef(false);
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    setPreviewState("loading");
  }, [finalRenderUrl]);

  const handleDownload = async () => {
    if (downloadDisabled || downloadInFlightRef.current) {
      return;
    }
    downloadInFlightRef.current = true;
    try {
      await onDownload();
    } catch {
      // The callback owner publishes operation errors.
    } finally {
      downloadInFlightRef.current = false;
    }
  };

  const isEpisodeRender = episodePlan.length > 0 || activeEpisodeNumber !== null;
  const activeEpisode = activeEpisodeNumber ?? episodePlan[0]?.episode_number ?? null;
  const outputByEpisode = new Map(
    episodeOutputs
      .filter((output) => output.episode_number !== null && output.episode_number !== undefined)
      .map((output) => [output.episode_number as number, output]),
  );
  const episodeRows = episodePlan.map((episode) => {
    const output = outputByEpisode.get(episode.episode_number);
    const outputUrl = output ? mediaUrl(output.path, projectId) : null;
    const isCurrent = episode.episode_number === activeEpisode;
    const isComplete = isCurrent ? Boolean(finalPath) : Boolean(output?.path);
    return { episode, output, outputUrl, isComplete };
  });

  return (
    <section className="production-preview-panel" aria-label={strings.regionLabel}>
      <div className="section-heading">
        <Film aria-hidden="true" size={18} />
        <h2>{strings.title}</h2>
      </div>
      {isEpisodeRender && activeEpisode !== null ? (
        <p className="production-render-scope" aria-label={strings.scopeLabel}>
          {strings.currentEpisode(
            activeEpisode,
            episodePlan.find((episode) => episode.episode_number === activeEpisode)?.title ?? "",
          )}
        </p>
      ) : null}
      <div
        className="production-preview-frame"
        data-state={finalRenderUrl ? previewState : "empty"}
        data-testid="production-preview-frame"
        style={{ aspectRatio: aspectRatio?.replace(":", " / ") || "16 / 9" }}
      >
        {finalRenderUrl ? (
          <video
            aria-label={strings.previewLabel}
            className="final-video"
            controls
            onError={() => setPreviewState("error")}
            onLoadedData={() => setPreviewState("ready")}
            poster={posterUrl ?? undefined}
            preload="metadata"
            src={finalRenderUrl}
          />
        ) : null}
        {!finalRenderUrl ? (
          <div className="production-preview-state">
            <Film aria-hidden="true" size={28} />
            <p>{strings.noPreview}</p>
          </div>
        ) : previewState === "loading" ? (
          <div className="production-preview-state" aria-live="polite">
            <span className="production-preview-spinner" aria-hidden="true" />
            <p>{strings.loadingPreview}</p>
          </div>
        ) : previewState === "error" ? (
          <div className="production-preview-state" role="alert">
            <p>{strings.previewError}</p>
          </div>
        ) : null}
      </div>
      {visibleFinalPath ? (
        <p
          aria-label={`${strings.pathLabel}: ${visibleFinalPath}`}
          className="final-path"
          style={{ overflowWrap: "anywhere" }}
        >
          {visibleFinalPath}
        </p>
      ) : null}
      <button
        className="secondary-button final-download-button async-action"
        type="button"
        disabled={downloadDisabled}
        onClick={handleDownload}
      >
        <Download aria-hidden="true" size={16} />
        {downloading ? strings.downloadingAction : strings.downloadAction}
      </button>
      {isEpisodeRender ? (
        <div className="production-episode-renders">
          <h3>{strings.episodeListLabel}</h3>
          <ul aria-label={strings.episodeListLabel}>
            {episodeRows.map(({ episode, output, outputUrl, isComplete }) => (
              <li key={episode.episode_number} data-current={episode.episode_number === activeEpisode}>
                <span>
                  <strong>{strings.episodeHeading(episode.episode_number, episode.title)}</strong>
                  <small>{isComplete ? strings.episodeCompleted : strings.episodePending}</small>
                  {output?.shot_ids?.length ? <small>{strings.usedShots(output.shot_ids)}</small> : null}
                </span>
                {outputUrl && output ? (
                  <a
                    aria-label={strings.downloadEpisode(episode.episode_number)}
                    download
                    href={outputUrl}
                  >
                    <Download aria-hidden="true" size={15} />
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
