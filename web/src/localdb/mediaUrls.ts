import { mediaRepository } from "../platform/storage/MediaRepository";
import type { LocalMediaRef } from "./types";

export function resolveLocalMediaUrl(ref: LocalMediaRef): Promise<string | null> {
  return mediaRepository.resolve(ref);
}

export function revokeLocalMediaUrls(): void {
  mediaRepository.revokeAll();
}
