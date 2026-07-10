import { describe, expect, it } from "vitest";
import { createShot } from "../../test/fixtures";
import {
  applyPromptOptimization,
  createShotDraftState,
  shotDraftIsDirty,
  toShotSaveRequest,
  undoPromptOptimization,
  type ShotDraftState,
} from "./shotDraft";

const sampleShot = createShot();

describe("shotDraft", () => {
  it("applies all AI fields as an unsaved draft and supports one undo", () => {
    const initial = createShotDraftState(sampleShot);
    const optimized = applyPromptOptimization(initial, {
      project_id: "p1",
      model: "text-model",
      optimized_text: "优化后的画面提示词",
      notes: [],
      shot_intent: "强调人物犹豫",
      shot_language: { shot_size: "close_up", camera_movement: "dolly_in" },
    });

    expect(optimized.draft.prompt).toBe("优化后的画面提示词");
    expect(optimized.draft.shotIntent).toBe("强调人物犹豫");
    expect(optimized.draft.shotLanguage.shot_size).toBe("close_up");
    expect(optimized.draft.shotLanguage.camera_movement).toBe("dolly_in");
    expect(shotDraftIsDirty(optimized)).toBe(true);
    expect(undoPromptOptimization(optimized).draft).toEqual(initial.draft);
  });

  it("keeps source, baseline, and draft collections isolated", () => {
    const source = createShot({ asset_ids: ["asset-1"] });
    const state = createShotDraftState(source);

    source.characters.push("source-character");
    source.props.push("source-prop");
    source.asset_ids.push("source-asset");
    source.shot_language!.shot_size = "wide";

    expect(state.baseline.characters).not.toContain("source-character");
    expect(state.baseline.props).not.toContain("source-prop");
    expect(state.baseline.assetIds).not.toContain("source-asset");
    expect(state.baseline.shotLanguage.shot_size).toBe("medium_close");

    state.draft.characters.push("draft-character");
    state.draft.props += ", draft-prop";
    state.draft.assetIds.push("draft-asset");
    state.draft.shotLanguage.camera_movement = "static";

    expect(state.baseline.characters).not.toContain("draft-character");
    expect(state.baseline.props).not.toContain("draft-prop");
    expect(state.baseline.assetIds).not.toContain("draft-asset");
    expect(state.baseline.shotLanguage.camera_movement).toBe("dolly_in");
  });

  const dirtyMutations: Array<[string, (state: ShotDraftState) => void]> = [
    ["prompt", (state) => { state.draft.prompt = "changed"; }],
    ["characters", (state) => { state.draft.characters.push("char-2"); }],
    ["location", (state) => { state.draft.location = "changed"; }],
    ["props", (state) => { state.draft.props += ", prop-2"; }],
    ["asset ids", (state) => { state.draft.assetIds.push("asset-2"); }],
    ["shot intent", (state) => { state.draft.shotIntent = "changed"; }],
    ["shot language", (state) => { state.draft.shotLanguage.lens_mm = 85; }],
  ];

  it.each(dirtyMutations)("detects %s changes as dirty", (_field, mutate) => {
    const state = createShotDraftState(sampleShot);

    mutate(state);

    expect(shotDraftIsDirty(state)).toBe(true);
  });

  it("converts the current draft to the existing save payload", () => {
    const state = createShotDraftState(sampleShot);
    expect(toShotSaveRequest(state.draft)).toEqual({
      prompt: sampleShot.prompt,
      characters: sampleShot.characters,
      location: sampleShot.location,
      props: sampleShot.props,
      asset_ids: sampleShot.asset_ids,
      shot_intent: sampleShot.shot_intent,
      shot_language: sampleShot.shot_language,
    });
  });
});
