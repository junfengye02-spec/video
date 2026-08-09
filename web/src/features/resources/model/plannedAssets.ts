import type { AssetRecord, Character, Shot } from "../../../domain/types";

export function withPlannedCharacterAssets(
  assets: AssetRecord[],
  characters: Character[],
  shots: Shot[],
  plannedAssetIds: string[] = [],
): AssetRecord[] {
  const plannedIds = new Set(plannedAssetIds);
  const combined = assets.map((asset) => (
    plannedIds.has(asset.id) ? { ...asset, planned: true } : asset
  ));
  const knownCharacterIds = new Set(
    assets
      .filter((asset) => asset.kind === "character")
      .map((asset) => asset.id),
  );
  const knownCharacterLabels = new Set(
    assets
      .filter((asset) => asset.kind === "character")
      .map((asset) => asset.label.trim().toLocaleLowerCase()),
  );

  for (const character of characters) {
    const assetId = `character-${character.id}`;
    const normalizedLabel = character.name.trim().toLocaleLowerCase();
    if (knownCharacterIds.has(assetId) || knownCharacterLabels.has(normalizedLabel)) continue;

    combined.push({
      id: assetId,
      kind: "character",
      label: character.name,
      description: character.role,
      prompt: character.visual_lock,
      reference_images: [...character.reference_images],
      media_urls: [],
      shot_ids: shots
        .filter((shot) => shot.characters.includes(character.id))
        .map((shot) => shot.id),
      version: 1,
      planned: character.reference_images.length === 0,
    });
    knownCharacterIds.add(assetId);
    knownCharacterLabels.add(normalizedLabel);
  }

  return combined;
}
