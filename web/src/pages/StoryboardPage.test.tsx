import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Shot } from "../domain/types";
import { createProjectResponse } from "../test/fixtures";
import { StoryboardPage, type StoryboardPageProps } from "./StoryboardPage";

const project = createProjectResponse({ shotCount: 2 });
const storyboardProps: StoryboardPageProps = {
  assets: project.series_bible.assets ?? [],
  characters: project.series_bible.characters,
  optimizingShotId: null,
  regeneratingShotId: null,
  savingShotId: null,
  selectedShotId: "shot-1",
  shots: project.storyboard.shots,
  plannedShotCount: null,
  resolveShotMedia: () => null,
  onSelectShot: vi.fn(),
  onOptimizePrompt: vi.fn().mockResolvedValue({
    project_id: "p1",
    model: "text-model",
    optimized_text: "优化后的画面提示词",
    notes: [],
  }),
  onSaveShot: vi.fn().mockResolvedValue(undefined),
  onRegenerateShot: vi.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("StoryboardPage", () => {
  it("reports dirty state upward while preserving its existing shot guard", async () => {
    const onDirtyChange = vi.fn();
    const props = { ...storyboardProps, onDirtyChange } as StoryboardPageProps;
    render(<StoryboardPage {...props} />);

    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText("分镜提示词"), {
      target: { value: "向路由报告的未保存草稿" },
    });

    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
  });

  it("renders a selectable shot list, central preview, read-only order strip and inspector", () => {
    render(<StoryboardPage {...storyboardProps} />);

    expect(screen.getByRole("navigation", { name: "分镜列表" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "分镜预览" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "分镜顺序" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "分镜检查器" })).toBeInTheDocument();
    expect(screen.queryByText("视频轨")).not.toBeInTheDocument();
    expect(screen.queryByText("音频轨")).not.toBeInTheDocument();
  });

  it("changes the current shot from the shot list without regenerating", () => {
    const onSelectShot = vi.fn();
    render(<StoryboardPage {...storyboardProps} onSelectShot={onSelectShot} />);

    fireEvent.click(screen.getByRole("button", { name: "选择分镜 2" }));

    expect(onSelectShot).toHaveBeenCalledWith("shot-2");
    expect(storyboardProps.onRegenerateShot).not.toHaveBeenCalled();
  });

  it("changes the current shot from the order strip without regenerating", () => {
    const onSelectShot = vi.fn();
    render(<StoryboardPage {...storyboardProps} onSelectShot={onSelectShot} />);

    const orderStrip = screen.getByRole("list", { name: "分镜顺序" });
    fireEvent.click(within(orderStrip).getByRole("button", { name: "在顺序中选择分镜 2" }));

    expect(onSelectShot).toHaveBeenCalledWith("shot-2");
    expect(storyboardProps.onRegenerateShot).not.toHaveBeenCalled();
  });

  it("sorts shots by index and falls back to the first ordered shot", () => {
    const resolveShotMedia = vi.fn((shot: Shot) => `/media/${shot.id}.mp4`);
    render(
      <StoryboardPage
        {...storyboardProps}
        selectedShotId="missing-shot"
        shots={[...storyboardProps.shots].reverse()}
        resolveShotMedia={resolveShotMedia}
      />,
    );

    const shotList = screen.getByRole("navigation", { name: "分镜列表" });
    const shotButtons = within(shotList).getAllByRole("button");
    expect(shotButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "选择分镜 1",
      "选择分镜 2",
    ]);
    expect(screen.getByRole("heading", { name: "分镜 1" })).toBeInTheDocument();
    expect(screen.getByLabelText("分镜 1 预览媒体")).toHaveAttribute("src", "/media/shot-1.mp4");
    expect(resolveShotMedia).toHaveBeenCalledTimes(1);
    expect(resolveShotMedia).toHaveBeenCalledWith(expect.objectContaining({ id: "shot-1" }));
  });

  it("shows the planned count and a clear preview empty state", () => {
    render(<StoryboardPage {...storyboardProps} plannedShotCount={2} />);

    expect(screen.getByText("AI 已为你规划 2 个分镜")).toHaveAttribute("role", "status");
    expect(screen.getByText("当前分镜尚无预览媒体")).toBeInTheDocument();
  });

  it("requires the exact confirmation before abandoning dirty edits from either selector", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onSelectShot = vi.fn();
    render(<StoryboardPage {...storyboardProps} onSelectShot={onSelectShot} />);
    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "未保存草稿" } });

    const shotList = screen.getByRole("navigation", { name: "分镜列表" });
    fireEvent.click(within(shotList).getByRole("button", { name: "选择分镜 2" }));

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledWith("当前分镜有未保存修改，确定放弃吗？");
    });
    expect(onSelectShot).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    const orderStrip = screen.getByRole("list", { name: "分镜顺序" });
    fireEvent.click(within(orderStrip).getByRole("button", { name: "在顺序中选择分镜 2" }));

    expect(confirm).toHaveBeenLastCalledWith("当前分镜有未保存修改，确定放弃吗？");
    expect(onSelectShot).toHaveBeenCalledTimes(1);
    expect(onSelectShot).toHaveBeenCalledWith("shot-2");
  });

  it("clears the abandoned draft and unload protection after the accepted selection renders", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const onSelectShot = vi.fn();
    const shots = storyboardProps.shots.map((shot) => (
      shot.id === "shot-2" ? { ...shot, prompt: "第二个分镜提示词" } : shot
    ));
    const { rerender } = render(
      <StoryboardPage {...storyboardProps} shots={shots} onSelectShot={onSelectShot} />,
    );
    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "要放弃的草稿" } });
    await waitFor(() => {
      expect(addEventListener.mock.calls.some(([type]) => type === "beforeunload")).toBe(true);
    });
    const activeListener = addEventListener.mock.calls.find(([type]) => type === "beforeunload")?.[1];

    fireEvent.click(screen.getByRole("button", { name: "选择分镜 2" }));
    rerender(
      <StoryboardPage
        {...storyboardProps}
        shots={shots}
        selectedShotId="shot-2"
        onSelectShot={onSelectShot}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("分镜提示词")).toHaveValue("第二个分镜提示词"));
    await waitFor(() => {
      expect(removeEventListener).toHaveBeenCalledWith("beforeunload", activeListener);
    });
    confirm.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "选择分镜 1" }));

    expect(confirm).not.toHaveBeenCalled();
    expect(onSelectShot.mock.calls).toEqual([["shot-2"], ["shot-1"]]);
  });

  it("keeps drag, drop and pointer movement inert on the read-only order strip", () => {
    const onSelectShot = vi.fn();
    render(<StoryboardPage {...storyboardProps} onSelectShot={onSelectShot} />);
    const orderStrip = screen.getByRole("list", { name: "分镜顺序" });
    const shotButton = within(orderStrip).getByRole("button", { name: "在顺序中选择分镜 2" });

    fireEvent.dragStart(shotButton);
    fireEvent.dragOver(shotButton);
    fireEvent.drop(shotButton);
    fireEvent.pointerMove(shotButton);

    expect(shotButton).not.toHaveAttribute("draggable");
    expect(onSelectShot).not.toHaveBeenCalled();
    expect(storyboardProps.onSaveShot).not.toHaveBeenCalled();
    expect(storyboardProps.onRegenerateShot).not.toHaveBeenCalled();
  });

  it("registers beforeunload only while dirty and removes the active listener", async () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<StoryboardPage {...storyboardProps} />);

    expect(addEventListener.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "未保存草稿" } });
    await waitFor(() => {
      expect(addEventListener.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1);
    });
    const firstListener = addEventListener.mock.calls.find(([type]) => type === "beforeunload")?.[1];
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    fireEvent.change(screen.getByLabelText("分镜提示词"), {
      target: { value: project.storyboard.shots[0].prompt },
    });
    await waitFor(() => {
      expect(removeEventListener).toHaveBeenCalledWith("beforeunload", firstListener);
    });

    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "第二份未保存草稿" } });
    await waitFor(() => {
      expect(addEventListener.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(2);
    });
    const activeListener = addEventListener.mock.calls.filter(([type]) => type === "beforeunload")[1]?.[1];

    unmount();

    expect(removeEventListener).toHaveBeenCalledWith("beforeunload", activeListener);
  });
});
