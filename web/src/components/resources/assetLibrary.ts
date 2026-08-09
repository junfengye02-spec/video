import type {
  AssetRecord,
  MediaAsset,
  MediaAssetStatus,
  MediaAssetSourceType,
  Shot,
} from "../../domain/types";

export type AssetKindFilter = "all" | AssetRecord["kind"];
export type AssetSourceFilter = "all" | MediaAssetSourceType;

export interface ResourceLibraryAsset extends AssetRecord {
  origin_project_id: string;
  source_type: MediaAssetSourceType;
  model: string;
  generation_job_id: string;
  media_url: string;
  status: MediaAssetStatus;
  created_at: string;
}

export type ResourcePanelState =
  | { mode: "closed" }
  | { mode: "detail"; assetId: string }
  | { mode: "upload" }
  | { mode: "generate"; assetId?: string };

const SUPPORTED_KINDS: ReadonlySet<string> = new Set(["character", "scene", "prop"]);

export function filterAssets<T extends Pick<AssetRecord, "kind" | "label" | "description" | "prompt"> & {
  source_type?: MediaAssetSourceType;
}>(
  assets: T[],
  filter: { kind: AssetKindFilter; query: string; sourceType?: AssetSourceFilter },
): T[] {
  const query = filter.query.trim().toLocaleLowerCase();

  return assets.filter((asset) => {
    if (!SUPPORTED_KINDS.has(asset.kind)) {
      return false;
    }

    const kindMatches = filter.kind === "all" || asset.kind === filter.kind;
    const sourceMatches = !filter.sourceType
      || filter.sourceType === "all"
      || (asset.source_type ?? "upload") === filter.sourceType;
    const queryMatches = !query || [asset.label, asset.description, asset.prompt]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(query));

    return kindMatches && sourceMatches && queryMatches;
  });
}

export function resourceAssetFromRecord(
  asset: AssetRecord,
  projectId: string,
): ResourceLibraryAsset {
  const mediaUrl = asset.media_url
    ?? asset.media_urls?.find((url) => !/\.(?:mp4|mov|webm)(?:[?#]|$)/i.test(url))
    ?? asset.reference_images[0]
    ?? "";
  const planned = asset.planned === true;
  return {
    ...asset,
    origin_project_id: asset.origin_project_id ?? projectId,
    source_type: asset.source_type ?? (planned ? "ai_generated" : "upload"),
    model: asset.model ?? "",
    generation_job_id: asset.generation_job_id ?? "",
    media_url: mediaUrl,
    status: asset.status ?? "ready",
    created_at: asset.created_at ?? "",
    planned,
  };
}

export function resourceAssetFromMedia(
  asset: MediaAsset,
  record?: AssetRecord,
): ResourceLibraryAsset {
  const referenceImages = [...(record?.reference_images ?? [])];
  if (
    asset.status === "ready"
    && asset.media_url
    && referenceImages.length === 0
  ) {
    referenceImages.push(asset.media_url);
  }
  return {
    ...record,
    ...asset,
    id: record?.id ?? asset.id,
    media_asset_id: asset.id,
    description: asset.description,
    prompt: asset.prompt,
    model: asset.model ?? "",
    generation_job_id: asset.generation_job_id ?? "",
    reference_images: referenceImages,
    media_urls: record?.media_urls ?? [],
  };
}

export function mergeMediaAssets(
  current: MediaAsset[],
  incoming: MediaAsset[],
): MediaAsset[] {
  const merged = new Map(current.map((asset) => [asset.id, asset]));
  for (const asset of incoming) merged.set(asset.id, asset);
  return Array.from(merged.values());
}

export function countLinkedShots(assetId: string, shots: Shot[]): number {
  return shots.filter((shot) => shot.asset_ids.includes(assetId)).length;
}
