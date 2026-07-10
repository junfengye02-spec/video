import { describe, expect, it } from "vitest";
import { createShot } from "../../test/fixtures";
import {
  applyPromptOptimization,
  createShotDraftState,
  shotDraftIsDirty,
  toShotSaveRequest,
  undoPromptOptimization,
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
    expect(shotDraftIsDirty(optimized)).toBe(true);
    expect(undoPromptOptimization(optimized).draft).toEqual(initial.draft);
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
