import { describe, expect, it } from "vitest";
import type { AssetRecord } from "../../domain/types";
import { createProjectResponse, createShot } from "../../test/fixtures";
import {
  countLinkedShots,
  filterAssets,
  type ResourcePanelState,
} from "./assetLibrary";

const sampleShot = createShot();
const assets: AssetRecord[] = [
  ...(createProjectResponse().series_bible.assets ?? []),
  {
    id: "scene-rain",
    kind: "scene",
    label: "雨巷",
    description: "夜雨中的旧城巷口",
    prompt: "冷色雨夜，湿润石板路",
    reference_images: [],
  },
  {
    id: "prop-envelope",
    kind: "prop",
    label: "SEALED ENVELOPE",
    description: "A weathered paper clue",
    prompt: "Red wax seal on a dark desk",
    reference_images: [],
  },
];

describe("assetLibrary", () => {
  it("filters only the three supported resource kinds", () => {
    expect(filterAssets(assets, { kind: "scene", query: "雨" }).map((asset) => asset.id)).toEqual([
      "scene-rain",
    ]);
  });

  it("never surfaces an unsupported runtime kind", () => {
    const malformedAsset = {
      id: "audio-rain",
      kind: "audio",
      label: "雨声音效",
      description: "雨巷环境声",
      prompt: "雨声",
      reference_images: [],
    } as unknown as AssetRecord;

    expect(filterAssets([...assets, malformedAsset], { kind: "all", query: "" })).not.toContain(
      malformedAsset,
    );
    expect(filterAssets([...assets, malformedAsset], { kind: "all", query: "雨声" })).toEqual([]);
  });

  it.each([
    [" sealed ", "prop-envelope"],
    ["PAPER CLUE", "prop-envelope"],
    ["red WAX", "prop-envelope"],
  ])("matches a trimmed case-insensitive query across resource text for %s", (query, expectedId) => {
    expect(filterAssets(assets, { kind: "all", query }).map((asset) => asset.id)).toEqual([
      expectedId,
    ]);
  });

  it("filters AI generated and uploaded sources independently", () => {
    const sourcedAssets = [
      { ...assets[0], source_type: "upload" as const },
      { ...assets[1], source_type: "ai_generated" as const },
    ];

    expect(filterAssets(sourcedAssets, {
      kind: "all",
      query: "",
      sourceType: "ai_generated",
    })).toEqual([sourcedAssets[1]]);
  });

  it("does not mutate asset binding metadata while filtering", () => {
    const asset = { ...assets[0], shot_ids: ["legacy-shot"] };
    const originalShotIds = asset.shot_ids;

    expect(filterAssets([asset], { kind: "all", query: "" })).toEqual([asset]);
    expect(asset.shot_ids).toBe(originalShotIds);
    expect(asset.shot_ids).toEqual(["legacy-shot"]);
  });

  it("counts bindings from current storyboard shots", () => {
    expect(countLinkedShots("asset-char-1", [
      { ...sampleShot, asset_ids: ["asset-char-1"] },
      { ...sampleShot, id: "s2", asset_ids: [] },
    ])).toBe(1);
  });

  it("counts a shot only once when malformed binding data contains duplicate asset ids", () => {
    expect(countLinkedShots("asset-char-1", [
      { ...sampleShot, asset_ids: ["asset-char-1", "asset-char-1"] },
      { ...sampleShot, id: "s2", asset_ids: ["asset-char-1"] },
    ])).toBe(2);
  });

  it("defines one mutually exclusive panel state", () => {
    const states: ResourcePanelState[] = [
      { mode: "closed" },
      { mode: "detail", assetId: "asset-char-1" },
      { mode: "upload" },
      { mode: "generate" },
    ];

    expect(states.map((state) => state.mode)).toEqual(["closed", "detail", "upload", "generate"]);
  });
});
