import { loadMediaBlob } from "./mediaStore";
import type { LocalMediaRef } from "./types";

const objectUrls = new Map<LocalMediaRef, string>();

export async function resolveLocalMediaUrl(ref: LocalMediaRef): Promise<string | null> {
  const cached = objectUrls.get(ref);
  if (cached) {
    return cached;
  }

  const blob = await loadMediaBlob(ref);
  if (!blob || typeof URL.createObjectURL !== "function") {
    return null;
  }

  const url = URL.createObjectURL(blob);
  objectUrls.set(ref, url);
  return url;
}

export function revokeLocalMediaUrls(): void {
  for (const url of objectUrls.values()) {
    URL.revokeObjectURL(url);
  }
  objectUrls.clear();
}
