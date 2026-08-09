import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreativeBrief, CreativeWorkflow, InspirationMessage } from "../domain/types";
import { creativeBriefToPrompt, InspirationPage } from "./InspirationPage";

const brief: CreativeBrief = {
  title: "Letter from Tomorrow",
  logline: "A courier receives a warning sent from tomorrow.",
  audience: "Young suspense viewers",
  format: "Vertical short video",
  duration_seconds: 60,
  aspect_ratio: "9:16",
  genre: "Suspense",
  tone: "Tense and emotional",
  visual_style: "Rainy neon realism",
  story_outline: "The courier follows the warning and finds its sender.",
  must_have: ["sealed letter", "rainy alley"],
  open_questions: [],
};

function workflow(overrides: Partial<CreativeWorkflow> = {}): CreativeWorkflow {
  return {
    phase: "inspiration",
    messages: [],
    brief: null,
    ready_to_confirm: false,
    planned_asset_ids: [],
    approved_at: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("InspirationPage", () => {
  it("consumes and automatically sends the first message once in StrictMode", async () => {
    const pending = deferred<void>();
    const onDevelop = vi.fn(() => pending.promise);
    const onInitialMessageConsumed = vi.fn();
    const rendered = render(
      <StrictMode>
        <InspirationPage
          workflow={workflow()}
          initialMessage="A courier receives a letter from tomorrow."
          initialTextModel="text-model-v2"
          developing={false}
          planning={false}
          onDevelop={onDevelop}
          onInitialMessageConsumed={onInitialMessageConsumed}
          onPlan={vi.fn()}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(onDevelop).toHaveBeenCalledWith([
      { role: "user", content: "A courier receives a letter from tomorrow." },
    ], "text-model-v2"));
    expect(onDevelop).toHaveBeenCalledTimes(1);
    expect(onInitialMessageConsumed).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <StrictMode>
        <InspirationPage
          workflow={workflow()}
          initialMessage=""
          developing
          planning={false}
          onDevelop={onDevelop}
          onInitialMessageConsumed={onInitialMessageConsumed}
          onPlan={vi.fn()}
        />
      </StrictMode>,
    );
    expect(onDevelop).toHaveBeenCalledTimes(1);
    pending.resolve();
  });

  it("restores a failed initial idea as one retryable draft", async () => {
    const onDevelop = vi.fn()
      .mockRejectedValueOnce(new Error("chat unavailable"))
      .mockResolvedValueOnce(undefined);
    render(
      <InspirationPage
        workflow={workflow()}
        initialMessage="A quiet reunion in the rain."
        developing={false}
        planning={false}
        onDevelop={onDevelop}
        onInitialMessageConsumed={vi.fn()}
        onPlan={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("chat unavailable");
    const composer = screen.getByRole("textbox", { name: "继续补充或调整想法" });
    expect(composer).toHaveValue("A quiet reunion in the rain.");
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(onDevelop).toHaveBeenCalledTimes(2));
    const expectedMessages: InspirationMessage[] = [
      { role: "user", content: "A quiet reunion in the rain." },
    ];
    expect(onDevelop).toHaveBeenNthCalledWith(1, expectedMessages, "gpt-5.5");
    expect(onDevelop).toHaveBeenNthCalledWith(2, expectedMessages, "gpt-5.5");
  });

  it("shows mise, every brief field, and explicit empty values", () => {
    const { rerender } = render(
      <InspirationPage
        workflow={workflow({
          messages: [{ role: "assistant", content: "Tell me about the ending." }],
          brief,
          ready_to_confirm: true,
        })}
        developing={false}
        planning={false}
        onDevelop={vi.fn()}
        onPlan={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("mise")).toBeInTheDocument();
    for (const label of [
      "标题",
      "一句话故事",
      "受众",
      "形式",
      "时长",
      "画幅比例",
      "类型",
      "情绪",
      "视觉方向",
      "故事轮廓",
      "必须保留",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("60 秒")).toBeInTheDocument();
    expect(screen.getByText("sealed letter")).toBeInTheDocument();
    expect(screen.getByText("rainy alley")).toBeInTheDocument();

    rerender(
      <InspirationPage
        workflow={workflow({
          brief: {
            ...brief,
            title: "",
            logline: "",
            audience: "",
            format: "",
            duration_seconds: null,
            aspect_ratio: "",
            genre: "",
            tone: "",
            visual_style: "",
            story_outline: "",
            must_have: [],
          },
        })}
        developing={false}
        planning={false}
        onDevelop={vi.fn()}
        onPlan={vi.fn()}
      />,
    );
    expect(screen.getAllByText("待补充").length).toBeGreaterThanOrEqual(10);
    expect(screen.getByText("单视频")).toBeInTheDocument();
  });

  it("uses the selected series type for automatic brief fill and suggestions", () => {
    render(
      <InspirationPage
        workflow={workflow({ brief: { ...brief, format: "竖屏剧情" } })}
        projectType="long_series"
        developing={false}
        planning={false}
        onDevelop={vi.fn()}
        onPlan={vi.fn()}
      />,
    );

    expect(screen.getByText("长系列（12-24 集） · 竖屏剧情")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "明确季级主线" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "明确视觉方向" })).not.toBeInTheDocument();
  });

  it("lists unanswered questions and never plans before explicit confirmation", () => {
    const onPlan = vi.fn().mockResolvedValue(undefined);
    render(
      <InspirationPage
        workflow={workflow({
          brief: {
            ...brief,
            open_questions: ["结尾要保留希望吗？", "是否需要旁白？"],
          },
          ready_to_confirm: false,
        })}
        developing={false}
        planning={false}
        onDevelop={vi.fn()}
        onPlan={onPlan}
      />,
    );

    const questions = screen.getByRole("heading", { name: "仍待回答" }).closest("section");
    expect(questions).not.toBeNull();
    expect(within(questions as HTMLElement).getByText("结尾要保留希望吗？")).toBeInTheDocument();
    expect(within(questions as HTMLElement).getByText("是否需要旁白？")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "确认创意并开始规划" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onPlan).not.toHaveBeenCalled();
  });

  it("inserts a submitted user message immediately without invoking planning", async () => {
    const messages: InspirationMessage[] = [
      { role: "user", content: "A rainy reunion." },
      { role: "assistant", content: "What should the audience remember?" },
    ];
    const pending = deferred<void>();
    const onDevelop = vi.fn(() => pending.promise);
    const onPlan = vi.fn();
    render(
      <InspirationPage
        workflow={workflow({ messages, brief, ready_to_confirm: false })}
        initialTextModel="text-model-v2"
        developing={false}
        planning={false}
        onDevelop={onDevelop}
        onPlan={onPlan}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "继续补充或调整想法" }), {
      target: { value: "Keep the ending restrained." },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(screen.getByText("Keep the ending restrained.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "继续补充或调整想法" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "发送消息" })).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(onDevelop).toHaveBeenCalledWith([
      ...messages,
      { role: "user", content: "Keep the ending restrained." },
    ], "text-model-v2"));
    expect(onPlan).not.toHaveBeenCalled();
    pending.resolve();
  });

  it("moves suggestion text into the focused composer and sends with Ctrl+Enter", async () => {
    const pending = deferred<void>();
    const onDevelop = vi.fn(() => pending.promise);
    render(
      <InspirationPage
        workflow={workflow()}
        developing={false}
        planning={false}
        onDevelop={onDevelop}
        onPlan={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "明确视觉方向" }));
    const composer = screen.getByRole("textbox", { name: "继续补充或调整想法" });
    await waitFor(() => expect(composer).toHaveFocus());
    expect(composer).toHaveValue("我希望整体画面的质感和视觉方向是：");

    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(onDevelop).toHaveBeenCalledWith([
      { role: "user", content: "我希望整体画面的质感和视觉方向是：" },
    ], "gpt-5.5"));
    expect(screen.getByRole("button", { name: "明确视觉方向" })).toBeDisabled();
    pending.resolve();
  });

  it("updates brief fields without remounting the conversation or resetting its scroll", () => {
    const { rerender } = render(
      <InspirationPage
        workflow={workflow({ brief, messages: [{ role: "assistant", content: "Keep this message." }] })}
        developing={false}
        planning={false}
        onDevelop={vi.fn()}
        onPlan={vi.fn()}
      />,
    );
    const conversation = screen.getByRole("tabpanel", { name: "对话" });
    const messageList = conversation.querySelector("[aria-live=polite]") as HTMLDivElement;
    messageList.scrollTop = 91;

    rerender(
      <InspirationPage
        workflow={workflow({
          brief: { ...brief, title: "Letter from Next Week", logline: "Only this field changed." },
          messages: [{ role: "assistant", content: "Keep this message." }],
        })}
        developing={false}
        planning={false}
        onDevelop={vi.fn()}
        onPlan={vi.fn()}
      />,
    );

    expect(screen.getByRole("tabpanel", { name: "对话" })).toBe(conversation);
    expect(messageList.scrollTop).toBe(91);
    expect(screen.getByRole("heading", { name: "Letter from Next Week" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Letter from Tomorrow" })).not.toBeInTheDocument();
  });

  it("ignores a stale local response after the active project changes", async () => {
    const pending = deferred<void>();
    const onDevelop = vi.fn(() => pending.promise);
    const rendered = render(
      <InspirationPage
        sessionKey="p1"
        workflow={workflow()}
        developing={false}
        planning={false}
        onDevelop={onDevelop}
        onPlan={vi.fn()}
      />,
    );
    const composer = screen.getByRole("textbox", { name: "继续补充或调整想法" });
    fireEvent.change(composer, { target: { value: "Message for project one" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    expect(screen.getByText("Message for project one")).toBeInTheDocument();

    rendered.rerender(
      <InspirationPage
        sessionKey="p2"
        workflow={workflow()}
        developing={false}
        planning={false}
        onDevelop={onDevelop}
        onPlan={vi.fn()}
      />,
    );
    expect(screen.queryByText("Message for project one")).not.toBeInTheDocument();
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(screen.queryByText("Message for project one")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("restores an unsent draft after switching away from and back to a project", () => {
    const rendered = render(
      <InspirationPage
        sessionKey="p1"
        workflow={workflow()}
        developing={false}
        planning={false}
        onDevelop={vi.fn()}
        onPlan={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "继续补充或调整想法" }), {
      target: { value: "Draft for project one" },
    });

    rendered.rerender(
      <InspirationPage
        sessionKey="p2"
        workflow={workflow()}
        developing={false}
        planning={false}
        onDevelop={vi.fn()}
        onPlan={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox", { name: "继续补充或调整想法" })).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox", { name: "继续补充或调整想法" }), {
      target: { value: "Draft for project two" },
    });

    rendered.rerender(
      <InspirationPage
        sessionKey="p1"
        workflow={workflow()}
        developing={false}
        planning={false}
        onDevelop={vi.fn()}
        onPlan={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox", { name: "继续补充或调整想法" })).toHaveValue(
      "Draft for project one",
    );
  });

  it("locks an explicit planning request immediately and submits it once", async () => {
    const pending = deferred<void>();
    const onPlan = vi.fn(() => pending.promise);
    render(
      <InspirationPage
        workflow={workflow({ brief, ready_to_confirm: true })}
        initialTextModel="gpt-5.4"
        developing={false}
        planning={false}
        onDevelop={vi.fn()}
        onPlan={onPlan}
      />,
    );

    const confirm = screen.getByRole("button", { name: "确认创意并开始规划" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(onPlan).toHaveBeenCalledWith(brief, false, "gpt-5.4");
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status", { name: "规划状态" })).toHaveTextContent("正在整理创作蓝图");
    pending.resolve();
    await waitFor(() => expect(confirm).toBeDisabled());
  });

  it("preserves the conversation, brief, and input when planning fails, then retries only planning", async () => {
    const messages: InspirationMessage[] = [
      { role: "user", content: "A rainy reunion." },
      { role: "assistant", content: "The intent is ready." },
    ];
    const onPlan = vi.fn()
      .mockRejectedValueOnce(new Error("planning unavailable"))
      .mockResolvedValueOnce(undefined);
    const onDevelop = vi.fn();
    render(
      <InspirationPage
        workflow={workflow({ messages, brief, ready_to_confirm: true })}
        developing={false}
        planning={false}
        onDevelop={onDevelop}
        onPlan={onPlan}
      />,
    );

    const composer = screen.getByRole("textbox", { name: "继续补充或调整想法" });
    fireEvent.change(composer, { target: { value: "An unsent detail stays here." } });
    fireEvent.click(screen.getByRole("button", { name: "确认创意并开始规划" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("planning unavailable");
    expect(screen.getByText("A rainy reunion.")).toBeInTheDocument();
    expect(screen.getByText(brief.logline)).toBeInTheDocument();
    expect(composer).toHaveValue("An unsent detail stays here.");
    fireEvent.click(screen.getByRole("button", { name: "重试规划" }));

    await waitFor(() => expect(onPlan).toHaveBeenCalledTimes(2));
    expect(onPlan).toHaveBeenNthCalledWith(1, brief, false, "gpt-5.5");
    expect(onPlan).toHaveBeenNthCalledWith(2, brief, false, "gpt-5.5");
    expect(onDevelop).not.toHaveBeenCalled();
  });

  it("persists the optional end-frame intent and keeps conversation editing available", async () => {
    const pending = deferred<void>();
    const onUpdateEndFrameIntent = vi.fn(() => pending.promise);
    const onPlan = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <InspirationPage
        workflow={workflow({ brief, ready_to_confirm: true })}
        developing={false}
        planning={false}
        onDevelop={vi.fn()}
        onPlan={onPlan}
        onUpdateEndFrameIntent={onUpdateEndFrameIntent}
      />,
    );

    const toggle = screen.getByRole("checkbox", { name: "控制成片首尾画面" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    expect(onUpdateEndFrameIntent).toHaveBeenCalledWith(true);
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "继续补充或调整想法" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "确认创意并开始规划" })).toBeDisabled();

    pending.resolve();
    await waitFor(() => expect(toggle).toBeEnabled());
    view.rerender(
      <InspirationPage
        workflow={workflow({ brief, ready_to_confirm: true, control_end_frames: true })}
        developing={false}
        planning={false}
        onDevelop={vi.fn()}
        onPlan={onPlan}
        onUpdateEndFrameIntent={onUpdateEndFrameIntent}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "控制成片首尾画面" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "确认创意并开始规划" }));
    await waitFor(() => expect(onPlan).toHaveBeenCalledWith(brief, true, "gpt-5.5"));
  });

  it("provides accessible conversation and brief segments for narrow screens", () => {
    render(
      <InspirationPage
        workflow={workflow({ brief })}
        developing={false}
        planning={false}
        onDevelop={vi.fn()}
        onPlan={vi.fn()}
      />,
    );

    const conversationTab = screen.getByRole("tab", { name: "对话" });
    const briefTab = screen.getByRole("tab", { name: "简报" });
    expect(conversationTab).toHaveAttribute("aria-selected", "true");
    expect(briefTab).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel", { name: "对话" })).toHaveAttribute("data-mobile-active", "true");

    fireEvent.click(briefTab);
    expect(conversationTab).toHaveAttribute("aria-selected", "false");
    expect(briefTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "简报" })).toHaveAttribute("data-mobile-active", "true");
  });

  it("does not invent missing values in the planning prompt", () => {
    const prompt = creativeBriefToPrompt({
      ...brief,
      duration_seconds: null,
      visual_style: "",
      must_have: [],
    });

    expect(prompt).not.toContain("model decides");
    expect(prompt).not.toContain("Visual style:");
    expect(prompt).not.toContain("Must include:");
  });

  it("includes the authoritative project type in the planning prompt", () => {
    const prompt = creativeBriefToPrompt(brief, "long_series");

    expect(prompt).toContain("Project type: long_series");
    expect(prompt).toContain("Duration: 60 seconds");
  });
});
