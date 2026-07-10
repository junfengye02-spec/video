import { loadMediaBlob } from "./mediaStore";
import type { LocalMediaRef } from "./types";

const resolvedUrls = new Map<LocalMediaRef, string | null>();
const inFlightResolutions = new Map<LocalMediaRef, Promise<string | null>>();
let cacheGeneration = 0;

export async function resolveLocalMediaUrl(ref: LocalMediaRef): Promise<string | null> {
  if (resolvedUrls.has(ref)) {
    return resolvedUrls.get(ref) ?? null;
  }
  const inFlight = inFlightResolutions.get(ref);
  if (inFlight) return inFlight;

  const generation = cacheGeneration;
  const resolution = (async () => {
    const blob = await loadMediaBlob(ref);
    if (generation !== cacheGeneration) {
      return null;
    }
    if (!blob || typeof URL.createObjectURL !== "function") {
      resolvedUrls.set(ref, null);
      return null;
    }

    const url = URL.createObjectURL(blob);
    resolvedUrls.set(ref, url);
    return url;
  })();
  inFlightResolutions.set(ref, resolution);
  const removeInFlight = () => {
    if (inFlightResolutions.get(ref) === resolution) {
      inFlightResolutions.delete(ref);
    }
  };
  void resolution.then(removeInFlight, removeInFlight);
  return resolution;
}

export function revokeLocalMediaUrls(): void {
  cacheGeneration += 1;
  for (const url of resolvedUrls.values()) {
    if (url) URL.revokeObjectURL(url);
  }
  resolvedUrls.clear();
  inFlightResolutions.clear();
}
