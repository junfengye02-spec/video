import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptOptimizeResponse } from "../domain/types";
import { getStrings } from "../i18n";
import { createShot } from "../test/fixtures";
import { ShotEditor, type ShotEditorProps } from "./ShotEditor";

const sampleShot = createShot();
const optimizedResponse: PromptOptimizeResponse = {
  project_id: "p1",
  model: "text-model",
  optimized_text: "优化后的画面提示词",
  notes: [],
  shot_intent: "强调人物犹豫",
  shot_language: { shot_size: "close_up" },
};

function renderEditor(overrides: Partial<ShotEditorProps> = {}) {
  const props: ShotEditorProps = {
    assets: [],
    characters: [],
    optimizing: false,
    regenerating: false,
    saving: false,
    shot: sampleShot,
    strings: getStrings("zh").shotEditor,
    onOptimizePrompt: vi.fn().mockResolvedValue(optimizedResponse),
    onRegenerateShot: vi.fn().mockResolvedValue(undefined),
    onSaveShot: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { ...render(<ShotEditor {...props} />), props };
}

afterEach(() => {
  cleanup();
});

describe("ShotEditor", () => {
  it("keeps optimization local until the user saves", async () => {
    const onOptimizePrompt = vi.fn().mockResolvedValue(optimizedResponse);
    const onSaveShot = vi.fn().mockResolvedValue(undefined);
    const onRegenerateShot = vi.fn().mockResolvedValue(undefined);
    renderEditor({ onOptimizePrompt, onSaveShot, onRegenerateShot });

    fireEvent.click(screen.getByRole("button", { name: "AI 优化提示词" }));
    expect(await screen.findByDisplayValue("优化后的画面提示词")).toBeInTheDocument();
    expect(onOptimizePrompt).toHaveBeenCalledWith(sampleShot, sampleShot.prompt);
    expect(onSaveShot).not.toHaveBeenCalled();
    expect(onRegenerateShot).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(onSaveShot).toHaveBeenCalledTimes(1));
    expect(onSaveShot).toHaveBeenCalledWith(
      sampleShot.id,
      expect.objectContaining({
        prompt: optimizedResponse.optimized_text,
        shot_intent: optimizedResponse.shot_intent,
        shot_language: expect.objectContaining(optimizedResponse.shot_language),
      }),
    );
    expect(onRegenerateShot).not.toHaveBeenCalled();
  });

  it("reports dirty edits and a clean selection reset", async () => {
    const onDirtyChange = vi.fn();
    const nextShot = createShot({ id: "shot-2", prompt: "第二个分镜" });
    const { props, rerender } = renderEditor({ onDirtyChange });

    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "未保存草稿" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    rerender(<ShotEditor {...props} shot={nextShot} />);

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    expect(onDirtyChange.mock.calls.map(([dirty]) => dirty)).toEqual([false, true, false]);
  });

  it("reports clean after undo restores the baseline", async () => {
    const onDirtyChange = vi.fn();
    renderEditor({ onDirtyChange });

    fireEvent.click(screen.getByRole("button", { name: "AI 优化提示词" }));
    expect(await screen.findByRole("button", { name: "撤销优化" })).toBeInTheDocument();
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    fireEvent.click(screen.getByRole("button", { name: "撤销优化" }));

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("reports clean after save accepts the current draft", async () => {
    const onDirtyChange = vi.fn();
    renderEditor({ onDirtyChange });
    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "待保存草稿" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("does not save automatically when regenerate is clicked", async () => {
    const onSaveShot = vi.fn();
    const onRegenerateShot = vi.fn().mockResolvedValue(undefined);
    renderEditor({ onSaveShot, onRegenerateShot });
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(onRegenerateShot).toHaveBeenCalledTimes(1));
    expect(onRegenerateShot).toHaveBeenCalledWith(sampleShot);
    expect(onSaveShot).not.toHaveBeenCalled();
  });

  it("preserves the current form when optimization fails", async () => {
    const onOptimizePrompt = vi.fn().mockRejectedValue(new Error("优化失败"));
    renderEditor({ onOptimizePrompt });
    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "用户当前草稿" } });
    fireEvent.change(screen.getByLabelText("场景"), { target: { value: "雨夜天台" } });
    fireEvent.change(screen.getByLabelText("镜头意图"), { target: { value: "保留用户意图" } });
    fireEvent.change(screen.getByLabelText("景别"), { target: { value: "wide" } });
    fireEvent.click(screen.getByRole("button", { name: "AI 优化提示词" }));
    await waitFor(() => expect(onOptimizePrompt).toHaveBeenCalledWith(sampleShot, "用户当前草稿"));
    expect(screen.getByDisplayValue("用户当前草稿")).toBeInTheDocument();
    expect(screen.getByDisplayValue("雨夜天台")).toBeInTheDocument();
    expect(screen.getByDisplayValue("保留用户意图")).toBeInTheDocument();
    expect(screen.getByLabelText("景别")).toHaveValue("wide");
  });

  it("offers one undo for the latest successful optimization", async () => {
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "AI 优化提示词" }));
    expect(await screen.findByDisplayValue("优化后的画面提示词")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "撤销优化" }));

    expect(screen.getByDisplayValue(sampleShot.prompt)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "撤销优化" })).not.toBeInTheDocument();
  });

  it("disables regeneration while the draft is dirty", () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "未保存草稿" } });

    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
    expect(screen.getByText("请先保存修改")).toBeInTheDocument();
  });

  it("clears undo and dirty state only after save succeeds", async () => {
    let resolveSave: (() => void) | undefined;
    const onSaveShot = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));
    renderEditor({ onSaveShot });

    fireEvent.click(screen.getByRole("button", { name: "AI 优化提示词" }));
    expect(await screen.findByRole("button", { name: "撤销优化" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
    resolveSave?.();

    await waitFor(() => expect(screen.getByRole("button", { name: "重新生成" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "撤销优化" })).not.toBeInTheDocument();
  });

  it("keeps the draft dirty when save fails", async () => {
    const onSaveShot = vi.fn().mockRejectedValue(new Error("保存失败"));
    renderEditor({ onSaveShot });
    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "仍未保存" } });

    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(onSaveShot).toHaveBeenCalledTimes(1));

    expect(screen.getByDisplayValue("仍未保存")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
  });

  it("preserves edits made while a save is pending", async () => {
    let resolveSave: (() => void) | undefined;
    const onSaveShot = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));
    renderEditor({ onSaveShot });
    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "已提交的提示词" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(onSaveShot).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("场景"), { target: { value: "提交后的新场景" } });
    await act(async () => resolveSave?.());

    expect(screen.getByLabelText("分镜提示词")).toHaveValue("已提交的提示词");
    expect(screen.getByLabelText("场景")).toHaveValue("提交后的新场景");
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
  });

  it("keeps a later optimization dirty and undoable when an earlier save resolves", async () => {
    let resolveOptimize: ((response: PromptOptimizeResponse) => void) | undefined;
    let resolveSave: (() => void) | undefined;
    const onOptimizePrompt = vi.fn().mockReturnValue(new Promise<PromptOptimizeResponse>((resolve) => {
      resolveOptimize = resolve;
    }));
    const onSaveShot = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));
    renderEditor({ onOptimizePrompt, onSaveShot });

    fireEvent.click(screen.getByRole("button", { name: "AI 优化提示词" }));
    await waitFor(() => expect(onOptimizePrompt).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(onSaveShot).toHaveBeenCalledTimes(1));

    await act(async () => resolveOptimize?.(optimizedResponse));
    expect(await screen.findByRole("button", { name: "撤销优化" })).toBeInTheDocument();
    await act(async () => resolveSave?.());

    expect(screen.getByLabelText("分镜提示词")).toHaveValue(optimizedResponse.optimized_text);
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "撤销优化" }));
    expect(screen.getByLabelText("分镜提示词")).toHaveValue(sampleShot.prompt);
  });

  it("ignores an old optimization after the selection cycles back to the same shot", async () => {
    let resolveOptimize: ((response: PromptOptimizeResponse) => void) | undefined;
    const onOptimizePrompt = vi.fn().mockReturnValue(new Promise<PromptOptimizeResponse>((resolve) => {
      resolveOptimize = resolve;
    }));
    const secondShot = createShot({ id: "shot-2", prompt: "第二个分镜" });
    const { props, rerender } = renderEditor({ onOptimizePrompt });
    fireEvent.click(screen.getByRole("button", { name: "AI 优化提示词" }));
    await waitFor(() => expect(onOptimizePrompt).toHaveBeenCalledTimes(1));

    rerender(<ShotEditor {...props} shot={secondShot} />);
    rerender(<ShotEditor {...props} shot={sampleShot} />);
    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "重新选择后的新草稿" } });
    await act(async () => resolveOptimize?.(optimizedResponse));

    expect(screen.getByLabelText("分镜提示词")).toHaveValue("重新选择后的新草稿");
  });

  it("ignores an old save after the selection cycles back to the same shot", async () => {
    let resolveSave: (() => void) | undefined;
    const onSaveShot = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));
    const secondShot = createShot({ id: "shot-2", prompt: "第二个分镜" });
    const { props, rerender } = renderEditor({ onSaveShot });
    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "旧请求提交内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(onSaveShot).toHaveBeenCalledTimes(1));

    rerender(<ShotEditor {...props} shot={secondShot} />);
    rerender(<ShotEditor {...props} shot={sampleShot} />);
    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "重新选择后的未保存内容" } });
    await act(async () => resolveSave?.());

    expect(screen.getByLabelText("分镜提示词")).toHaveValue("重新选择后的未保存内容");
    expect(screen.getByRole("button", { name: "重新生成" })).toBeDisabled();
  });

  it("resets the draft when the selected shot changes", () => {
    const nextShot = createShot({ id: "shot-2", prompt: "第二个分镜" });
    const { props, rerender } = renderEditor();
    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "第一个分镜草稿" } });

    rerender(<ShotEditor {...props} shot={nextShot} />);

    expect(screen.getByLabelText("分镜提示词")).toHaveValue("第二个分镜");
    expect(screen.getByRole("button", { name: "重新生成" })).toBeEnabled();
  });
});
