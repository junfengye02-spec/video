import type { ShortDramaProjectResponse } from "../../domain/types";
import type { LocalProjectSummary } from "../../localdb/types";

const VIDEO_EXTENSION = /\.(?:mp4|mov|webm)(?:[?#]|$)/i;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp)(?:[?#]|$)/i;

function mediaCandidate(source: string | null | undefined): LocalProjectSummary["cover"] {
  const normalized = source?.trim();
  if (!normalized) return null;
  if (VIDEO_EXTENSION.test(normalized)) return { kind: "video", source: normalized };
  if (IMAGE_EXTENSION.test(normalized)) return { kind: "image", source: normalized };
  return null;
}

export function selectProjectCover(
  snapshot: ShortDramaProjectResponse | null,
): LocalProjectSummary["cover"] {
  if (!snapshot) return null;

  const finalRender = mediaCandidate(snapshot.final_path);
  if (finalRender) return finalRender;

  for (const shot of snapshot.storyboard.shots) {
    const shotMedia = mediaCandidate(shot.output_path ?? shot.output_url);
    if (shotMedia) return shotMedia;
  }

  for (const asset of snapshot.series_bible.assets ?? []) {
    const sources = [asset.media_url, ...(asset.media_urls ?? []), ...asset.reference_images];
    for (const source of sources) {
      const assetMedia = mediaCandidate(source);
      if (assetMedia) return assetMedia;
    }
  }

  return null;
}
