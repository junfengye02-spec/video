import { loadMediaBlob } from "./mediaStore";
import type { LocalMediaRef } from "./types";

const resolvedUrls = new Map<LocalMediaRef, string | null>();
const inFlightResolutions = new Map<LocalMediaRef, Promise<string | null>>();
const failedResolutions = new Map<LocalMediaRef, {
  error: unknown;
  failureCount: number;
  retryAt: number;
}>();
const ERROR_RETRY_BASE_MS = 1_000;
const ERROR_RETRY_MAX_MS = 30_000;
let cacheGeneration = 0;

export async function resolveLocalMediaUrl(ref: LocalMediaRef): Promise<string | null> {
  if (resolvedUrls.has(ref)) {
    return resolvedUrls.get(ref) ?? null;
  }
  const previousFailure = failedResolutions.get(ref);
  if (previousFailure && Date.now() < previousFailure.retryAt) {
    return Promise.reject(previousFailure.error);
  }
  const inFlight = inFlightResolutions.get(ref);
  if (inFlight) return inFlight;

  const generation = cacheGeneration;
  const resolution = (async () => {
    let blob: Blob | null;
    try {
      blob = await loadMediaBlob(ref);
    } catch (error) {
      if (generation === cacheGeneration) {
        const failureCount = Math.min((previousFailure?.failureCount ?? 0) + 1, 6);
        const retryDelay = Math.min(
          ERROR_RETRY_BASE_MS * 2 ** (failureCount - 1),
          ERROR_RETRY_MAX_MS,
        );
        failedResolutions.set(ref, {
          error,
          failureCount,
          retryAt: Date.now() + retryDelay,
        });
      }
      throw error;
    }
    if (generation !== cacheGeneration) {
      return null;
    }
    failedResolutions.delete(ref);
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
  failedResolutions.clear();
}
