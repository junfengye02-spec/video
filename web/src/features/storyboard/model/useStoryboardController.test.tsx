import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PromptOptimizeResponse, Shot, ShotSaveRequest } from "../../../domain/types";
import { createShot } from "../../../test/fixtures";
import {
  useStoryboardController,
  type StoryboardControllerInput,
} from "./useStoryboardController";

const firstShot = createShot({ id: "shot-1", index: 1, prompt: "first prompt" });
const secondShot = createShot({ id: "shot-2", index: 2, prompt: "second prompt" });
const optimized: PromptOptimizeResponse = {
  project_id: "p1",
  model: "text-model",
  optimized_text: "optimized prompt",
  notes: [],
  shot_intent: "optimized intent",
  shot_language: { shot_size: "close_up" },
};

function savedShot(payload: ShotSaveRequest): Shot {
  return createShot({
    ...firstShot,
    prompt: payload.prompt ?? firstShot.prompt,
    characters: payload.characters ?? firstShot.characters,
    location: payload.location ?? firstShot.location,
    props: payload.props ?? firstShot.props,
    asset_ids: payload.asset_ids ?? firstShot.asset_ids,
    shot_intent: payload.shot_intent ?? firstShot.shot_intent,
    shot_language: payload.shot_language ?? firstShot.shot_language,
  });
}

function input(overrides: Partial<StoryboardControllerInput> = {}): StoryboardControllerInput {
  return {
    projectId: "p1",
    shots: [firstShot, secondShot],
    selectedShotId: firstShot.id,
    optimizingShotId: null,
    regeneratingShotId: null,
    savingShotId: null,
    onSelectShot: vi.fn(),
    onOptimizePrompt: vi.fn().mockResolvedValue(optimized),
    onSaveShot: vi.fn().mockImplementation(async (_shotId, payload) => savedShot(payload)),
    onRegenerateShot: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

describe("useStoryboardController", () => {
  it("guards a dirty selection and accepts the exact discard confirmation", () => {
    const onSelectShot = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { result } = renderHook(() => useStoryboardController(input({ onSelectShot })));
    act(() => result.current.updateDraft((draft) => ({ ...draft, prompt: "dirty" })));

    expect(result.current.selectShot(secondShot.id)).toBe(false);
    expect(onSelectShot).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith("当前分镜有未保存修改，确定放弃吗？");

    confirm.mockReturnValue(true);
    expect(result.current.selectShot(secondShot.id)).toBe(true);
    expect(onSelectShot).toHaveBeenCalledWith(secondShot.id);
  });

  it("applies optimization to the unsaved draft and supports undo", async () => {
    const onSaveShot = vi.fn();
    const props = input({ onSaveShot });
    const { result } = renderHook(() => useStoryboardController(props));

    await act(async () => result.current.optimize());

    expect(result.current.draftState.draft.prompt).toBe("optimized prompt");
    expect(result.current.draftState.baseline.prompt).toBe("first prompt");
    expect(result.current.dirty).toBe(true);
    expect(onSaveShot).not.toHaveBeenCalled();
    act(() => result.current.undoOptimization());
    expect(result.current.draftState.draft.prompt).toBe("first prompt");
    expect(result.current.dirty).toBe(false);
  });

  it("preserves the draft and exposes an optimization failure", async () => {
    const props = input({ onOptimizePrompt: vi.fn().mockRejectedValue(new Error("优化失败")) });
    const { result } = renderHook(() => useStoryboardController(props));
    act(() => result.current.updateDraft((draft) => ({ ...draft, prompt: "user draft" })));

    await act(async () => result.current.optimize());

    expect(result.current.draftState.draft.prompt).toBe("user draft");
    expect(result.current.optimizeFeedback.phase).toBe("error");
    expect(result.current.optimizeFeedback.error).toMatchObject({ message: "优化失败" });
  });

  it("uses the authoritative save as baseline and clears dirty only after success", async () => {
    const onSaveShot = vi.fn().mockResolvedValue(createShot({
      ...firstShot,
      prompt: "server normalized",
      location: "server location",
    }));
    const onDirtyChange = vi.fn();
    const { result } = renderHook(() => useStoryboardController(input({ onSaveShot, onDirtyChange })));
    act(() => result.current.updateDraft((draft) => ({ ...draft, prompt: "submitted" })));

    await act(async () => result.current.save());

    expect(result.current.draftState.draft.prompt).toBe("server normalized");
    expect(result.current.draftState.draft.location).toBe("server location");
    expect(result.current.dirty).toBe(false);
    expect(result.current.saveFeedback.phase).toBe("success");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps edits made while a save is pending over the server baseline", async () => {
    const pending = deferred<Shot>();
    const onSaveShot = vi.fn().mockReturnValue(pending.promise);
    const { result } = renderHook(() => useStoryboardController(input({ onSaveShot })));
    act(() => result.current.updateDraft((draft) => ({ ...draft, prompt: "submitted" })));
    let savePromise!: Promise<void>;
    act(() => { savePromise = result.current.save(); });
    await waitFor(() => expect(onSaveShot).toHaveBeenCalledTimes(1));
    act(() => result.current.updateDraft((draft) => ({ ...draft, location: "later edit" })));

    await act(async () => {
      pending.resolve(createShot({ ...firstShot, prompt: "server normalized", location: "server location" }));
      await savePromise;
    });

    expect(result.current.draftState.baseline.prompt).toBe("server normalized");
    expect(result.current.draftState.draft).toMatchObject({ prompt: "submitted", location: "later edit" });
    expect(result.current.dirty).toBe(true);
  });

  it("keeps a failed save dirty and retries without duplicate pending requests", async () => {
    const pending = deferred<Shot>();
    const onSaveShot = vi.fn()
      .mockRejectedValueOnce(new Error("temporary save failed"))
      .mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useStoryboardController(input({ onSaveShot })));
    act(() => result.current.updateDraft((draft) => ({ ...draft, prompt: "retry draft" })));
    await act(async () => result.current.save());
    expect(result.current.saveFeedback.phase).toBe("error");
    expect(result.current.dirty).toBe(true);

    let retry!: Promise<void>;
    act(() => {
      retry = result.current.save();
      void result.current.save();
    });
    await waitFor(() => expect(onSaveShot).toHaveBeenCalledTimes(2));
    await act(async () => {
      pending.resolve(createShot({ ...firstShot, prompt: "retry draft" }));
      await retry;
    });
    expect(result.current.dirty).toBe(false);
  });

  it("retains an unsaved draft through failed regeneration and a deduplicated retry", async () => {
    const pending = deferred<void>();
    const onRegenerateShot = vi.fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useStoryboardController(input({ onRegenerateShot })));
    act(() => result.current.updateDraft((draft) => ({ ...draft, prompt: "kept draft" })));
    act(() => result.current.openRegenerationDialog());
    await act(async () => result.current.regenerate());
    expect(result.current.regenerateFeedback.phase).toBe("error");
    expect(result.current.regenerationDialogOpen).toBe(true);

    let retry!: Promise<void>;
    act(() => {
      retry = result.current.regenerate();
      void result.current.regenerate();
    });
    await waitFor(() => expect(onRegenerateShot).toHaveBeenCalledTimes(2));
    await act(async () => {
      pending.resolve();
      await retry;
    });
    expect(result.current.regenerationDialogOpen).toBe(false);
    expect(result.current.draftState.draft.prompt).toBe("kept draft");
    expect(result.current.dirty).toBe(true);
  });

  it("ignores an old optimization after the project changes, even with the same shot id", async () => {
    const pending = deferred<PromptOptimizeResponse>();
    const firstInput = input({ onOptimizePrompt: vi.fn().mockReturnValue(pending.promise) });
    const secondProjectShot = createShot({ id: "shot-1", index: 1, prompt: "project two prompt" });
    const { result, rerender } = renderHook(
      (props: StoryboardControllerInput) => useStoryboardController(props),
      { initialProps: firstInput },
    );
    let optimizePromise!: Promise<void>;
    act(() => { optimizePromise = result.current.optimize(); });
    rerender(input({
      projectId: "p2",
      shots: [secondProjectShot],
      selectedShotId: secondProjectShot.id,
    }));

    await act(async () => {
      pending.resolve(optimized);
      await optimizePromise;
    });

    expect(result.current.draftState.projectId).toBe("p2");
    expect(result.current.draftState.draft.prompt).toBe("project two prompt");
    expect(result.current.optimizeFeedback.phase).toBe("idle");
  });

  it("rebases an authoritative AI frame without discarding unrelated dirty edits", () => {
    const { result, rerender } = renderHook(
      (props: StoryboardControllerInput) => useStoryboardController(props),
      { initialProps: input() },
    );
    act(() => result.current.updateDraft((draft) => ({
      ...draft,
      prompt: "unsaved local prompt",
    })));
    const generatedFrameShot = createShot({
      ...firstShot,
      version: 2,
      continuity: {
        mode: "cut",
        inherit_previous_tail: false,
        explicit_user_first_frame_asset_id: "generated-first",
        inherited_first_frame_asset_id: null,
        last_frame_asset_id: null,
        first_frame: {
          asset_id: "generated-first",
          version: 1,
          status: "ready",
          source: "ai_generated",
          generation_job_id: "job-first",
        },
        last_frame: null,
        stale: false,
      },
    });

    rerender(input({ shots: [generatedFrameShot, secondShot] }));

    expect(result.current.draftState.baseline.continuity.first_frame?.asset_id)
      .toBe("generated-first");
    expect(result.current.draftState.draft.continuity.first_frame?.asset_id)
      .toBe("generated-first");
    expect(result.current.draftState.draft.prompt).toBe("unsaved local prompt");
    expect(result.current.dirty).toBe(true);
  });
});
