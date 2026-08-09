import type { AssetRecord, GenerateImagesRequest, ListAssetsRequest, ListAssetsResponse, MediaAsset } from "../../../domain/types";
import {
  mergeMediaAssets,
  resourceAssetFromMedia,
  resourceAssetFromRecord,
  type ResourceLibraryAsset,
} from "../../../components/resources/assetLibrary";
import type { ImageGenerationParameters, ResourceView } from "./resourceLibraryTypes";

export function combineAssets(
  records: AssetRecord[],
  mediaAssets: MediaAsset[],
  projectId: string,
): ResourceLibraryAsset[] {
  const recordsById = new Map(records.map((asset) => [asset.id, asset]));
  const recordsByMediaAssetId = new Map(
    records
      .filter((asset) => asset.media_asset_id)
      .map((asset) => [asset.media_asset_id as string, asset]),
  );
  const boundRecordIds = new Set(
    Array.from(recordsByMediaAssetId.values(), (asset) => asset.id),
  );
  const generatedKeys = new Set(
    mediaAssets
      .filter((asset) => asset.status === "ready")
      .map((asset) => `${asset.kind}:${asset.label.trim().toLocaleLowerCase()}`),
  );
  const combined = new Map<string, ResourceLibraryAsset>();
  for (const record of records) {
    if (boundRecordIds.has(record.id)) continue;
    const resource = resourceAssetFromRecord(record, projectId);
    const key = `${resource.kind}:${resource.label.trim().toLocaleLowerCase()}`;
    if (resource.planned && generatedKeys.has(key)) continue;
    combined.set(resource.id, resource);
  }
  for (const asset of mediaAssets) {
    const record = recordsById.get(asset.id) ?? recordsByMediaAssetId.get(asset.id);
    const resource = resourceAssetFromMedia(asset, record);
    combined.set(resource.id, resource);
  }
  return Array.from(combined.values());
}

export function imageGenerationParameters(
  payload: GenerateImagesRequest,
): ImageGenerationParameters {
  return {
    kind: payload.kind,
    label: payload.label,
    description: payload.description,
    prompt: payload.prompt,
    model: payload.model,
    count: payload.count,
    size: payload.size,
    quality: payload.quality,
  };
}

export function sameImageGenerationParameters(
  left: ImageGenerationParameters,
  right: ImageGenerationParameters,
): boolean {
  return left.kind === right.kind
    && left.label === right.label
    && left.description === right.description
    && left.prompt === right.prompt
    && left.model === right.model
    && left.count === right.count
    && left.size === right.size
    && left.quality === right.quality;
}

export async function listEveryAssetPage(
  listAssets: (payload: ListAssetsRequest) => Promise<ListAssetsResponse>,
  scope: ResourceView,
  projectId: string,
): Promise<MediaAsset[]> {
  const assets: MediaAsset[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await listAssets({
      scope,
      project_id: scope === "project" ? projectId : undefined,
      cursor,
      limit: 100,
    });
    assets.push(...response.assets);
    const nextCursor = response.next_cursor ?? undefined;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  return mergeMediaAssets([], assets);
}
