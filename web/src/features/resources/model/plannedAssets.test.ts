import { describe, expect, it } from "vitest";
import { createShot } from "../../../test/fixtures";
import { withPlannedCharacterAssets } from "./plannedAssets";

describe("withPlannedCharacterAssets", () => {
  it("turns AI-planned characters into prompt-ready resource records", () => {
    const assets = withPlannedCharacterAssets(
      [],
      [{
        id: "c1",
        name: "Lin",
        role: "lead investigator",
        visual_lock: "red coat, short hair, consistent facial identity",
        voice: null,
        reference_images: [],
        locked: true,
      }],
      [createShot({ id: "s1", characters: ["c1"] })],
    );

    expect(assets).toEqual([expect.objectContaining({
      id: "character-c1",
      kind: "character",
      label: "Lin",
      description: "lead investigator",
      prompt: "red coat, short hair, consistent facial identity",
      shot_ids: ["s1"],
      planned: true,
    })]);
  });

  it("does not duplicate a character resource already returned by planning", () => {
    const existing = {
      id: "asset-c1",
      kind: "character" as const,
      label: "Lin",
      prompt: "existing prompt",
      reference_images: [],
    };

    const assets = withPlannedCharacterAssets(
      [existing],
      [{
        id: "c1",
        name: "Lin",
        role: "lead",
        visual_lock: "new prompt",
        voice: null,
        reference_images: [],
        locked: true,
      }],
      [],
    );

    expect(assets).toEqual([existing]);
  });

  it("marks only workflow-declared scene and prop assets as planned", () => {
    const plannedScene = {
      id: "scene-hall",
      kind: "scene" as const,
      label: "Main hall",
      prompt: "locked hall layout",
      reference_images: [],
    };
    const savedMetadata = {
      id: "prop-note",
      kind: "prop" as const,
      label: "Saved note",
      prompt: "folded paper note",
      reference_images: [],
    };

    const assets = withPlannedCharacterAssets(
      [plannedScene, savedMetadata],
      [],
      [],
      ["scene-hall"],
    );

    expect(assets[0]).toEqual(expect.objectContaining({ planned: true }));
    expect(assets[1].planned).toBeUndefined();
  });
});
