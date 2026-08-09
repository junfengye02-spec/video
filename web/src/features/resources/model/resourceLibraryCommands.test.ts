import { describe, expect, it } from "vitest";
import type { AssetRecord, MediaAsset } from "../../../domain/types";
import { combineAssets } from "./resourceLibraryCommands";

describe("combineAssets", () => {
  it("merges a generated media row back into its stable planned resource id", () => {
    const record: AssetRecord = {
      id: "planned-scene",
      kind: "scene",
      label: "Rain alley",
      description: "Night alley",
      prompt: "Rain alley establishing frame",
      reference_images: ["assets/images/generated/frame.png"],
      media_urls: ["/api/projects/p1/media/assets/images/generated/frame.png"],
      shot_ids: ["s1"],
      version: 2,
      source_type: "ai_generated",
      generation_job_id: "job-1",
      media_asset_id: "media-1",
      media_url: "/api/projects/p1/media/assets/images/generated/frame.png",
      status: "ready",
    };
    const media: MediaAsset = {
      id: "media-1",
      origin_project_id: "p1",
      kind: "scene",
      source_type: "ai_generated",
      label: "Rain alley",
      description: "Night alley",
      prompt: "Rain alley establishing frame",
      model: "gpt-image-2",
      generation_job_id: "job-1",
      media_url: "/api/projects/p1/media/assets/images/generated/frame.png",
      status: "ready",
      created_at: "2026-07-21T00:00:00Z",
    };

    const combined = combineAssets([record], [media], "p1");

    expect(combined).toHaveLength(1);
    expect(combined[0]).toEqual(expect.objectContaining({
      id: "planned-scene",
      media_asset_id: "media-1",
      shot_ids: ["s1"],
      source_type: "ai_generated",
      status: "ready",
    }));
    expect(combined[0]).not.toHaveProperty("planned");
  });
});
