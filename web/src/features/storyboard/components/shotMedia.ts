import type { Shot } from "../../../domain/types";

export type ShotMediaKind = "image" | "video";

const IMAGE_EXTENSIONS = /\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i;

export function shotMediaKind(shot: Shot, mediaUrl: string): ShotMediaKind {
  const candidate = shot.output_path || shot.output_url || mediaUrl;
  return candidate.startsWith("data:image/") || IMAGE_EXTENSIONS.test(candidate)
    ? "image"
    : "video";
}

export function stableAspectRatio(value?: string | null): string {
  const normalized = value?.trim().replace(":", "/") ?? "";
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (!match) return "16 / 9";

  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? `${width} / ${height}` : "16 / 9";
}
