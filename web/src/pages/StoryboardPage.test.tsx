import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Shot } from "../domain/types";
import { createProjectResponse } from "../test/fixtures";
import { StoryboardPage, type StoryboardPageProps } from "./StoryboardPage";

const project = createProjectResponse({ shotCount: 2 });
const tabletMediaQuery = "(min-width: 768px) and (max-width: 1179px)";
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
  onSaveShot: vi.fn().mockResolvedValue(project.storyboard.shots[0]),
  onRegenerateShot: vi.fn().mockResolvedValue(undefined),
};

function useTabletViewport() {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === tabletMediaQuery,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } satisfies MediaQueryList)));
}

function clickLikeBrowser(button: HTMLElement) {
  fireEvent.pointerDown(button, { button: 0 });
  fireEvent.mouseDown(button, { button: 0 });
  button.focus();
  fireEvent.pointerUp(button, { button: 0 });
  fireEvent.mouseUp(button, { button: 0 });
  fireEvent.click(button, { button: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

    expect(screen.getByRole("navigation", { name: "分镜列表" })).not.toHaveAttribute("tabindex");
    expect(screen.getByRole("region", { name: "分镜预览" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "分镜顺序" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "分镜检查器" })).not.toHaveAttribute("tabindex");
    expect(screen.queryByText("视频轨")).not.toBeInTheDocument();
    expect(screen.queryByText("音频轨")).not.toBeInTheDocument();
  });

  it("shows a stable thumbnail for every shot with resolved media", () => {
    const shots = storyboardProps.shots.map((shot, index) => ({
      ...shot,
      id: `s${index + 1}`,
      index: index + 1,
    }));
    render(
      <StoryboardPage
        {...storyboardProps}
        shots={shots}
        resolveShotMedia={(shot) => `blob:${shot.id}`}
      />,
    );

    expect(screen.getByLabelText("分镜 1 缩略预览")).toHaveAttribute("src", "blob:s1");
    expect(screen.getByLabelText("分镜 2 缩略预览")).toHaveAttribute("src", "blob:s2");
  });

  it("reserves an aria-hidden thumbnail placeholder for unresolved media", () => {
    render(<StoryboardPage {...storyboardProps} />);

    const shotButton = screen.getByRole("button", { name: "选择分镜 1" });
    const thumbnail = shotButton.querySelector(".shot-list-thumbnail");
    expect(thumbnail).toHaveAttribute("aria-hidden", "true");
    expect(thumbnail?.querySelector(".shot-list-thumbnail-placeholder")).toBeInTheDocument();
    expect(thumbnail?.querySelector("video")).not.toBeInTheDocument();
  });

  it("switches mobile views without unmounting a dirty shot draft", () => {
    render(<StoryboardPage {...storyboardProps} />);

    const controls = screen.getByRole("tablist", { name: "分镜视图" });
    const listTab = within(controls).getByRole("tab", { name: "分镜列表" });
    const previewTab = within(controls).getByRole("tab", { name: "预览" });
    const inspectorTab = within(controls).getByRole("tab", { name: "分镜检查器" });
    expect(previewTab).toHaveAttribute("aria-selected", "true");
    expect(listTab).toHaveAttribute("aria-selected", "false");
    expect(inspectorTab).toHaveAttribute("aria-selected", "false");

    const prompt = screen.getByLabelText("分镜提示词");
    fireEvent.change(prompt, { target: { value: "切换后仍保留的草稿" } });
    fireEvent.click(listTab);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "分镜列表" }).closest(".storyboard-list-panel"))
      .toHaveClass("is-panel-open");
    expect(screen.getByRole("region", { name: "分镜检查器" }).closest(".storyboard-inspector-panel"))
      .not.toHaveClass("is-panel-open");

    fireEvent.click(inspectorTab);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(inspectorTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("分镜提示词")).toBe(prompt);
    expect(screen.getByLabelText("分镜提示词")).toHaveValue("切换后仍保留的草稿");
  });

  it("opens the tablet shot list as a named modal and restores its opener on Escape", async () => {
    useTabletViewport();
    render(<StoryboardPage {...storyboardProps} />);

    const controls = screen.getByRole("group", { name: "分镜侧栏" });
    const opener = within(controls).getByRole("button", { name: "打开分镜列表" });
    clickLikeBrowser(opener);

    const dialog = screen.getByRole("dialog", { name: "分镜列表" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const firstControl = within(dialog).getByRole("button", { name: "选择分镜 1" });
    await waitFor(() => {
      expect(firstControl).toHaveFocus();
    });
    const modalControls = within(dialog).getAllByRole("button");
    const lastControl = modalControls[modalControls.length - 1];
    lastControl.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(firstControl).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(lastControl).toHaveFocus();

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "分镜列表" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "分镜列表" })).toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("opens only the tablet inspector modal and restores its opener on Escape", async () => {
    useTabletViewport();
    render(<StoryboardPage {...storyboardProps} />);

    const controls = screen.getByRole("group", { name: "分镜侧栏" });
    const listOpener = within(controls).getByRole("button", { name: "打开分镜列表" });
    const inspectorOpener = within(controls).getByRole("button", { name: "打开分镜检查器" });
    clickLikeBrowser(listOpener);
    clickLikeBrowser(inspectorOpener);

    const dialog = screen.getByRole("dialog", { name: "分镜检查器" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.queryByRole("dialog", { name: "分镜列表" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const firstControl = within(dialog).getByLabelText("分镜提示词");
    await waitFor(() => expect(firstControl).toHaveFocus());
    const modalControls = within(dialog).getAllByRole("button");
    const lastControl = modalControls[modalControls.length - 1];
    lastControl.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(firstControl).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(lastControl).toHaveFocus();

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "分镜检查器" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "分镜检查器" })).toBeInTheDocument();
    await waitFor(() => expect(inspectorOpener).toHaveFocus());
  });

  it("focuses the empty tablet shot-list dialog root and closes it from Escape", async () => {
    useTabletViewport();
    render(<StoryboardPage {...storyboardProps} selectedShotId={null} shots={[]} />);

    const controls = screen.getByRole("group", { name: "分镜侧栏" });
    const opener = within(controls).getByRole("button", { name: "打开分镜列表" });
    clickLikeBrowser(opener);

    const dialog = screen.getByRole("dialog", { name: "分镜列表" });
    expect(dialog).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(dialog).toHaveFocus());

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "分镜列表" })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("focuses the all-disabled tablet inspector root and closes it from Escape", async () => {
    useTabletViewport();
    render(<StoryboardPage {...storyboardProps} selectedShotId={null} shots={[]} />);

    const controls = screen.getByRole("group", { name: "分镜侧栏" });
    const opener = within(controls).getByRole("button", { name: "打开分镜检查器" });
    clickLikeBrowser(opener);

    const dialog = screen.getByRole("dialog", { name: "分镜检查器" });
    expect(dialog).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(dialog).toHaveFocus());

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "分镜检查器" })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("renders visible shot status text and stable async editor actions", () => {
    render(<StoryboardPage {...storyboardProps} optimizingShotId="shot-1" />);

    const list = screen.getByRole("navigation", { name: "分镜列表" });
    expect(within(list).getAllByText("就绪").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "正在优化提示词" })).toHaveClass("async-action");
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
    expect(screen.getByLabelText("分镜 1 预览媒体")).toHaveClass("shot-preview-media");
    expect(resolveShotMedia).toHaveBeenCalledTimes(3);
    expect(resolveShotMedia.mock.calls.map(([shot]) => shot.id).sort()).toEqual([
      "shot-1",
      "shot-1",
      "shot-2",
    ]);
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
