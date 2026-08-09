import { describe, expect, it } from "vitest";
import { createShot } from "../../../test/fixtures";
import {
  applyPromptOptimization,
  createShotDraftState,
  shotDraftIsDirty,
  toShotSaveRequest,
  undoPromptOptimization,
  type ShotDraftState,
} from "./shotDraft";

const sampleShot = createShot();

describe("storyboard shot draft", () => {
  it("applies AI fields only to the draft and supports one undo", () => {
    const initial = createShotDraftState("p1", sampleShot);
    const optimized = applyPromptOptimization(initial, {
      project_id: "p1",
      model: "text-model",
      optimized_text: "优化后的画面提示词",
      notes: [],
      shot_intent: "强调人物犹豫",
      shot_language: { shot_size: "close_up", camera_movement: "dolly_in" },
    });

    expect(optimized.baseline.prompt).toBe(sampleShot.prompt);
    expect(optimized.draft).toMatchObject({
      prompt: "优化后的画面提示词",
      shotIntent: "强调人物犹豫",
      shotLanguage: { shot_size: "close_up", camera_movement: "dolly_in" },
    });
    expect(shotDraftIsDirty(optimized)).toBe(true);
    expect(undoPromptOptimization(optimized).draft).toEqual(initial.draft);
  });

  it("undoes AI-owned fields while preserving later bindings and manual edits", () => {
    const initial = createShotDraftState("p1", createShot({
      prompt: "before prompt",
      asset_ids: ["asset-1"],
      shot_intent: "before intent",
      shot_language: { shot_size: "wide" },
    }));
    const optimized = applyPromptOptimization(initial, {
      project_id: "p1",
      model: "text-model",
      optimized_text: "optimized prompt",
      notes: [],
      shot_intent: "optimized intent",
      shot_language: { shot_size: "close_up" },
    });
    const edited = {
      ...optimized,
      draft: {
        ...optimized.draft,
        props: "new prop",
        assetIds: ["asset-1", "asset-2"],
        location: "new location",
      },
    };

    expect(undoPromptOptimization(edited).draft).toMatchObject({
      prompt: "before prompt",
      shotIntent: "before intent",
      shotLanguage: { shot_size: "wide" },
      props: "new prop",
      assetIds: ["asset-1", "asset-2"],
      location: "new location",
    });
  });

  const dirtyMutations: Array<[string, (state: ShotDraftState) => void]> = [
    ["prompt", (state) => { state.draft.prompt = "changed"; }],
    ["characters", (state) => { state.draft.characters.push("char-2"); }],
    ["location", (state) => { state.draft.location = "changed"; }],
    ["props", (state) => { state.draft.props += ", prop-2"; }],
    ["asset ids", (state) => { state.draft.assetIds.push("asset-2"); }],
    ["shot intent", (state) => { state.draft.shotIntent = "changed"; }],
    ["shot language", (state) => { state.draft.shotLanguage.lens_mm = 85; }],
    ["first frame", (state) => {
      state.draft.continuity.explicit_user_first_frame_asset_id = "asset-first";
    }],
  ];

  it.each(dirtyMutations)("detects %s changes as dirty", (_field, mutate) => {
    const state = createShotDraftState("p1", sampleShot);
    mutate(state);
    expect(shotDraftIsDirty(state)).toBe(true);
  });

  it("normalizes the save payload without mutating the editable draft", () => {
    const state = createShotDraftState("p1", createShot({ props: [] }));
    state.draft.props = "umbrella, letter, ";
    expect(toShotSaveRequest(state.draft).props).toEqual(["umbrella", "letter"]);
    expect(state.draft.props).toBe("umbrella, letter, ");
  });

  it("round-trips an episode assignment and supports clearing it", () => {
    const assigned = createShotDraftState("p1", createShot({ episode_number: 2 }));
    expect(assigned.draft.episodeNumber).toBe(2);
    expect(toShotSaveRequest(assigned.draft).episode_number).toBe(2);

    assigned.draft.episodeNumber = null;
    expect(toShotSaveRequest(assigned.draft).episode_number).toBeNull();
  });

  it("persists explicit and inherited frame ids independently", () => {
    const state = createShotDraftState("p1", createShot({
      continuity: {
        mode: "carry",
        inherit_previous_tail: true,
        explicit_user_first_frame_asset_id: "user-frame",
        inherited_first_frame_asset_id: "tail-frame",
        last_frame_asset_id: null,
        first_frame: null,
        last_frame: null,
        stale: false,
      },
    }));

    expect(toShotSaveRequest(state.draft).continuity).toMatchObject({
      explicit_user_first_frame_asset_id: "user-frame",
      inherited_first_frame_asset_id: "tail-frame",
    });
  });
});
