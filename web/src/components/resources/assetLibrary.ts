import type { AssetRecord, Shot } from "../../domain/types";

export type AssetKindFilter = "all" | AssetRecord["kind"];

export type ResourcePanelState =
  | { mode: "closed" }
  | { mode: "detail"; assetId: string }
  | { mode: "upload" };

const SUPPORTED_KINDS: ReadonlySet<string> = new Set(["character", "scene", "prop"]);

export function filterAssets(
  assets: AssetRecord[],
  filter: { kind: AssetKindFilter; query: string },
): AssetRecord[] {
  const query = filter.query.trim().toLocaleLowerCase();

  return assets.filter((asset) => {
    if (!SUPPORTED_KINDS.has(asset.kind)) {
      return false;
    }

    const kindMatches = filter.kind === "all" || asset.kind === filter.kind;
    const queryMatches = !query || [asset.label, asset.description, asset.prompt]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(query));

    return kindMatches && queryMatches;
  });
}

export function countLinkedShots(assetId: string, shots: Shot[]): number {
  return shots.filter((shot) => shot.asset_ids.includes(assetId)).length;
}
