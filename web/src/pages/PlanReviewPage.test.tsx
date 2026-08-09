import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PlanSectionId,
  ShortDramaProjectResponse,
  TaskBatch,
  TaskItemStatus,
} from "../domain/types";
import { createProjectResponse, createShot } from "../test/fixtures";
import { PlanReviewPage, type PlanReviewPageProps } from "./PlanReviewPage";

const sectionIds: PlanSectionId[] = [
  "worldview",
  "characters",
  "scenes",
  "props",
  "sound",
  "storyboard",
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function endFrameBatch(
  firstStatus: TaskItemStatus,
  lastStatus: TaskItemStatus,
): TaskBatch {
  const createdAt = "2026-07-21T08:00:00Z";
  const item = (id: string, target: "first" | "last", status: TaskItemStatus) => ({
    id,
    batch_id: "end-frame-batch",
    position: target === "first" ? 0 : 1,
    task_type: "resource_image.generate",
    status,
    idempotency_key: `${target}-key`,
    input: { frame_target: target },
    target_entity_type: "shot_frame",
    target_entity_id: target === "first" ? "shot-1" : "shot-2",
    target_entity_version: 1,
    attempt_count: 1,
    max_attempts: 3,
    progress: status === "complete" ? 100 : 0,
    retryable: status !== "complete",
    error_code: status === "failed" ? "provider_call_failed" : null,
    error_message: status === "failed" ? "failed" : null,
    result: null,
    billing_job_id: null,
    provider_wait_started_at: null,
    provider_next_poll_at: null,
    provider_poll_count: 0,
    dependencies: [],
    created_at: createdAt,
    updated_at: createdAt,
  });
  return {
    id: "end-frame-batch",
    project_id: "project-1",
    task_type: "resource_image.generate",
    status: firstStatus === "failed" || lastStatus === "failed"
      ? "partial_failure"
      : firstStatus === "complete" && lastStatus === "complete"
        ? "complete"
        : firstStatus,
    idempotency_key: "end-frame-key",
    snapshot: { purpose: "inspiration_end_frames" },
    progress: firstStatus === "complete" && lastStatus === "complete" ? 100 : 50,
    total_items: 2,
    completed_items: [firstStatus, lastStatus].filter((status) => status === "complete").length,
    failed_items: [firstStatus, lastStatus].filter((status) => status === "failed").length,
    error_code: null,
    error_message: null,
    created_at: createdAt,
    updated_at: createdAt,
    items: [item("first-item", "first", firstStatus), item("last-item", "last", lastStatus)],
  };
}

function createReviewSnapshot(status: "pending" | "approved" = "pending") {
  const snapshot = createProjectResponse({ shotCount: 2 });
  snapshot.series_bible.worldview = "近未来沿海城市，一个持续下雨的深夜";
  snapshot.series_bible.main_arc = "信使必须在午夜前交付一封来自明天的信";
  snapshot.series_bible.visual_rules = "冷雨与暖灯形成对比，保持写实摄影";
  snapshot.series_bible.sound_plan = {
    narration: "第一人称克制旁白",
    dialogue: "对白短促并保留停顿",
    ambience: "持续雨声与远处列车",
    music_direction: "低频钢琴与极简弦乐",
    prompt: "雨声主导，克制钢琴，避免煽情",
    storyboard_prompt_integration: true,
  };
  snapshot.series_bible.characters = [{
    id: "character-1",
    name: "林乔",
    role: "负责送信的夜班信使",
    visual_lock: "短黑发、红色雨衣、旧帆布邮差包",
    voice: "动作克制，面对异常时先观察再反应",
    reference_images: [],
    locked: true,
  }];
  snapshot.series_bible.assets = [
    {
      id: "character-asset-1",
      kind: "character",
      label: "林乔",
      description: "红色防水雨衣与旧帆布邮差包",
      prompt: "中国女性夜班信使，短黑发，红色雨衣，克制表演",
      reference_images: [],
    },
    {
      id: "scene-1",
      kind: "scene",
      label: "雨巷",
      description: "午夜狭窄巷道，出口连接旧火车站，路面持续积水",
      prompt: "冷蓝月光，暖色路灯，湿路反射，纵深构图",
      reference_images: [],
    },
    {
      id: "prop-1",
      kind: "prop",
      label: "明日来信",
      description: "发黄纸张、蓝黑墨水、三道固定折痕",
      prompt: "旧纸信封，纤维材质清晰，日期写着明天",
      reference_images: [],
    },
  ];
  snapshot.storyboard.shots = [
    createShot({
      id: "shot-1",
      beat: "林乔进入雨巷并发现日期异常",
      prompt: "中近景跟随林乔穿过雨巷，红色雨衣在冷蓝环境中醒目",
      characters: ["character-1"],
      props: ["明日来信"],
      asset_ids: ["scene-1", "prop-1"],
      location: "雨巷入口",
      shot_intent: "建立异常来信与人物的谨慎反应",
      shot_language: { shot_size: "medium_close", camera_movement: "dolly_in", lens_mm: 50 },
    }),
    createShot({
      id: "shot-2",
      beat: "她在车站灯下拆开信封",
      prompt: "手部特写拆开旧信封，暖灯映出纸张纤维与折痕",
      characters: ["character-1"],
      props: ["明日来信"],
      asset_ids: ["prop-1"],
      location: "旧火车站",
      shot_intent: "把道具连续性作为悬念证据",
      shot_language: { shot_size: "close_up", camera_movement: "static", lens_mm: 85 },
    }),
  ];
  snapshot.continuity_plan = {
    project_type: "single_video",
    active_episode_number: null,
    series_bible: {
      worldview: snapshot.series_bible.worldview,
      main_arc: snapshot.series_bible.main_arc,
      style_lock: "写实世界，不出现超自然视觉特效",
      visual_rules: snapshot.series_bible.visual_rules,
      taboos: ["不使用赛博霓虹", "不展示信件寄件人正脸"],
      locations: ["雨巷", "旧火车站"],
      props: ["明日来信的三道折痕始终一致"],
      relationship_map: [],
    },
    episodes: [],
    story_state: {
      character_knowledge: [],
      relationship_changes: [],
      active_foreshadowing: [],
      resolved_foreshadowing: [],
      prop_state: [],
      character_status: [],
      current_locations: [],
    },
  };
  snapshot.creative_workflow = {
    phase: "plan_review",
    messages: [],
    brief: {
      title: "雨夜来信",
      logline: "一封来自明天的信改变夜班信使的选择",
      audience: "悬疑短片观众",
      format: "剧情短片",
      duration_seconds: 48,
      aspect_ratio: "16:9",
      genre: "悬疑",
      tone: "克制",
      visual_style: "冷雨暖灯",
      story_outline: "送信、拆信、选择",
      must_have: ["明日来信"],
      open_questions: [],
    },
    ready_to_confirm: true,
    planned_asset_ids: ["character-asset-1", "scene-1", "prop-1"],
    approved_at: null,
    plan_generated_at: "2026-07-16T02:00:00Z",
    plan_sections: Object.fromEntries(sectionIds.map((section, index) => [section, {
      status,
      revision: index + 1,
      feedback: null,
      updated_at: status === "approved" ? `2026-07-16T0${index}:00:00Z` : null,
    }])) as NonNullable<ShortDramaProjectResponse["creative_workflow"]>["plan_sections"],
  };
  return snapshot;
}

function renderPage(overrides: Partial<PlanReviewPageProps> = {}) {
  const props: PlanReviewPageProps = {
    snapshot: createReviewSnapshot(),
    approving: false,
    revising: false,
    updatingSection: null,
    onApprove: vi.fn().mockResolvedValue(undefined),
    onConfirmSection: vi.fn().mockResolvedValue(undefined),
    onRequestChanges: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { props, ...render(<PlanReviewPage {...props} />) };
}

function openFeedbackDrawer() {
  fireEvent.click(screen.getByRole("button", { name: "要求修改" }));
  const drawer = screen.getByRole("dialog", { name: /修改反馈/ });
  return {
    drawer,
    feedback: within(drawer).getByRole("textbox", { name: "修改反馈" }),
  };
}

afterEach(cleanup);

describe("PlanReviewPage", () => {
  it("restores only the automatic first and last frame statuses without locking review", async () => {
    const snapshot = createReviewSnapshot();
    snapshot.creative_workflow = {
      ...snapshot.creative_workflow!,
      control_end_frames: true,
    };
    const awaiting = endFrameBatch("awaiting_payment", "failed");
    const complete = endFrameBatch("complete", "complete");
    const onListTasks = vi.fn().mockResolvedValue({ tasks: [awaiting] });
    const onRetryTaskItem = vi.fn().mockResolvedValue(awaiting);
    const rendered = renderPage({
      snapshot,
      onListTasks,
      onRetryTaskItem,
    });

    expect(await screen.findByText("首帧 待支付")).toBeInTheDocument();
    expect(screen.getByText("尾帧 生成失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认此部分" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重试首帧" }));
    await waitFor(() => expect(onRetryTaskItem).toHaveBeenCalledWith(
      "end-frame-batch",
      "first-item",
    ));

    onListTasks.mockResolvedValue({ tasks: [complete] });
    rendered.rerender(
      <PlanReviewPage
        {...rendered.props}
        taskEvents={[{
          id: "task-event-1",
          job_id: "first-item",
          project_id: snapshot.project.id,
          stage: "task_item",
          status: "complete",
          message: "complete",
          created_at: "2026-07-21T08:01:00Z",
        }]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("首帧 已完成")).toBeInTheDocument();
      expect(screen.getByText("尾帧 已完成")).toBeInTheDocument();
    });
  });

  it("maps all six server-backed plan documents and required fields", () => {
    renderPage();

    expect(screen.getByText("近未来沿海城市，一个持续下雨的深夜")).toBeInTheDocument();
    expect(screen.getByText("不使用赛博霓虹")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /人物设定/ }));
    expect(screen.getAllByText("负责送信的夜班信使")).toHaveLength(2);
    expect(screen.getAllByText("短黑发、红色雨衣、旧帆布邮差包")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /场景设定/ }));
    expect(screen.getAllByText("午夜狭窄巷道，出口连接旧火车站，路面持续积水")).toHaveLength(3);
    expect(screen.getAllByText("冷蓝月光，暖色路灯，湿路反射，纵深构图")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /关键道具/ }));
    expect(screen.getByText("明日来信的三道折痕始终一致")).toBeInTheDocument();
    expect(screen.getAllByText("旧纸信封，纤维材质清晰，日期写着明天")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /声音与配乐/ }));
    expect(screen.getByText("第一人称克制旁白")).toBeInTheDocument();
    expect(screen.getByText("雨声主导，克制钢琴，避免煽情")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /分镜规划/ }));
    expect(screen.getByText("中近景")).toBeInTheDocument();
    expect(screen.getByText("推近")).toBeInTheDocument();
    expect(screen.queryByText("24.0 秒（按创意简报总时长均分）")).not.toBeInTheDocument();
  });

  it("preserves a separate feedback draft while switching categories", () => {
    renderPage();
    let { feedback } = openFeedbackDrawer();
    fireEvent.change(feedback, { target: { value: "把规则限制在一个雨夜" } });
    fireEvent.keyDown(document, { key: "Escape" });

    fireEvent.click(screen.getByRole("button", { name: /人物设定/ }));
    ({ feedback } = openFeedbackDrawer());
    fireEvent.change(feedback, { target: { value: "保留红色雨衣" } });
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /世界观与视觉规则/ }));

    ({ feedback } = openFeedbackDrawer());
    expect(feedback).toHaveValue("把规则限制在一个雨夜");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /人物设定/ }));
    ({ feedback } = openFeedbackDrawer());
    expect(feedback).toHaveValue("保留红色雨衣");
  });

  it("confirms the active section with its server revision and deduplicates pending clicks", async () => {
    const pending = deferred<void>();
    const onConfirmSection = vi.fn(() => pending.promise);
    renderPage({ onConfirmSection });
    const confirm = screen.getByRole("button", { name: "确认此部分" });

    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(onConfirmSection).toHaveBeenCalledTimes(1);
    expect(onConfirmSection).toHaveBeenCalledWith("worldview", 1);
    expect(screen.getByRole("button", { name: "正在确认" })).toBeDisabled();
    pending.resolve();
    expect(await screen.findByRole("status")).toHaveTextContent("世界观已确认");
  });

  it("keeps a failed section confirmation retryable", async () => {
    const onConfirmSection = vi.fn()
      .mockRejectedValueOnce(new Error("Confirmation failed"))
      .mockResolvedValueOnce(undefined);
    renderPage({ onConfirmSection });
    fireEvent.click(screen.getByRole("button", { name: "确认此部分" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Confirmation failed");
    fireEvent.click(screen.getByRole("button", { name: "确认此部分" }));
    await waitFor(() => expect(onConfirmSection).toHaveBeenCalledTimes(2));
  });

  it("persists changes_requested before revising and keeps feedback visible while pending", async () => {
    const pending = deferred<void>();
    const onRequestChanges = vi.fn(() => pending.promise);
    renderPage({ onRequestChanges });
    const { drawer, feedback } = openFeedbackDrawer();
    fireEvent.change(feedback, { target: { value: "明确雨夜规则的因果限制" } });

    const revise = within(drawer).getByRole("button", { name: "提交修改" });
    fireEvent.click(revise);
    fireEvent.click(revise);

    expect(onRequestChanges).toHaveBeenCalledTimes(1);
    expect(onRequestChanges).toHaveBeenCalledWith("worldview", "明确雨夜规则的因果限制", 1);
    expect(within(drawer).getByRole("button", { name: "正在修改" })).toBeDisabled();
    expect(feedback).toHaveValue("明确雨夜规则的因果限制");
    pending.resolve();
    expect(await screen.findByRole("status")).toHaveTextContent("世界观已按反馈更新");
  });

  it("keeps the section draft after an API failure", async () => {
    const onRequestChanges = vi.fn()
      .mockRejectedValueOnce(new Error("Revision failed"))
      .mockResolvedValueOnce(undefined);
    renderPage({ onRequestChanges });
    const { drawer, feedback } = openFeedbackDrawer();
    fireEvent.change(feedback, { target: { value: "不要清空这段反馈" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "提交修改" }));

    expect(await within(drawer).findByRole("alert")).toHaveTextContent("Revision failed");
    expect(feedback).toHaveValue("不要清空这段反馈");
    fireEvent.click(within(drawer).getByRole("button", { name: "提交修改" }));
    await waitFor(() => expect(onRequestChanges).toHaveBeenCalledTimes(2));
  });

  it("explains a recoverable revision conflict and preserves the draft for retry", async () => {
    renderPage({
      onRequestChanges: vi.fn().mockRejectedValue({
        status: 409,
        code: "plan_section_revision_conflict",
        details: { current_revision: 3 },
      }),
    });
    const { drawer, feedback } = openFeedbackDrawer();
    fireEvent.change(feedback, { target: { value: "基于最新版本继续调整" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "提交修改" }));

    expect(await within(drawer).findByRole("alert")).toHaveTextContent("已载入服务端最新版本");
    expect(feedback).toHaveValue("基于最新版本继续调整");
  });

  it("shows approved revisions and server confirmation times", () => {
    renderPage({ snapshot: createReviewSnapshot("approved") });

    expect(screen.queryByText(/版本 01/)).not.toBeInTheDocument();
    expect(screen.getByTestId("blueprint-document-state")).toHaveTextContent("已确认 · 2026");
    expect(screen.getByRole("button", { name: "此部分已确认" })).toBeDisabled();
  });

  it("keeps final approval gated and deduplicates the confirmed submission", async () => {
    const pending = deferred<void>();
    const onApprove = vi.fn(() => pending.promise);
    const { rerender, props } = renderPage({ onApprove });
    expect(screen.getByRole("button", { name: "还有 6 类待确认" })).toBeDisabled();

    const approved = createReviewSnapshot("approved");
    rerender(<PlanReviewPage {...props} snapshot={approved} />);
    const finalApprove = screen.getByRole("button", { name: "全部确认，进入分镜" });
    fireEvent.click(finalApprove);
    const dialog = screen.getByRole("dialog", { name: "确认最终蓝图" });
    const confirm = within(dialog).getByRole("button", { name: "确认并进入分镜" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole("button", { name: "正在锁定蓝图" })).toBeDisabled();
    pending.resolve();
  });

  it("shows final approval failure inside the confirmation and retries in place", async () => {
    const onApprove = vi.fn()
      .mockRejectedValueOnce(new Error("Final approval failed"))
      .mockResolvedValueOnce(undefined);
    renderPage({ snapshot: createReviewSnapshot("approved"), onApprove });
    fireEvent.click(screen.getByRole("button", { name: "全部确认，进入分镜" }));
    const dialog = screen.getByRole("dialog", { name: "确认最终蓝图" });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认并进入分镜" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Final approval failed");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认并进入分镜" }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(2));
  });

  it("manages feedback Drawer focus and restores the opener on Escape", async () => {
    renderPage();
    const opener = screen.getByRole("button", { name: "要求修改" });
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByRole("dialog", { name: /修改反馈/ });
    await waitFor(() => expect(within(drawer).getByRole("button", { name: "关闭" })).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(screen.queryByRole("dialog", { name: /修改反馈/ })).not.toBeInTheDocument();
  });

  it("preserves per-section document scroll and partial update scroll position", async () => {
    const snapshot = createReviewSnapshot();
    const { rerender, props } = renderPage({ snapshot });
    let documentRegion = screen.getByRole("region", { name: "世界观与视觉规则文档" });
    const scroll = documentRegion.querySelector("article")?.parentElement as HTMLDivElement;
    scroll.scrollTop = 64;

    fireEvent.click(screen.getByRole("button", { name: /人物设定/ }));
    await waitFor(() => expect(screen.getByRole("region", { name: "人物设定文档" })).toBeInTheDocument());
    documentRegion = screen.getByRole("region", { name: "人物设定文档" });
    const sameScroll = documentRegion.querySelector("article")?.parentElement as HTMLDivElement;
    sameScroll.scrollTop = 37;
    fireEvent.click(screen.getByRole("button", { name: /世界观与视觉规则/ }));
    await waitFor(() => expect(sameScroll.scrollTop).toBe(64));

    const updated = structuredClone(snapshot);
    updated.creative_workflow!.plan_sections!.worldview.updated_at = "2026-07-18T01:00:00Z";
    rerender(<PlanReviewPage {...props} snapshot={updated} />);
    expect(sameScroll.scrollTop).toBe(64);
  });

  it("ignores a stale section completion after switching projects", async () => {
    const pending = deferred<void>();
    const onConfirmSection = vi.fn(() => pending.promise);
    const first = createReviewSnapshot();
    const rendered = renderPage({ snapshot: first, onConfirmSection });
    fireEvent.click(screen.getByRole("button", { name: "确认此部分" }));

    const second = createReviewSnapshot();
    second.project.id = "p2";
    rendered.rerender(<PlanReviewPage {...rendered.props} snapshot={second} />);
    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    expect(screen.queryByText("世界观已确认。")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders 30 storyboard entries without exposing media generation controls", () => {
    const snapshot = createReviewSnapshot();
    snapshot.storyboard.shots = Array.from({ length: 30 }, (_, index) => createShot({
      id: `shot-${index + 1}`,
      index: index + 1,
      beat: `节拍 ${index + 1}`,
      prompt: `长中文画面提示词 ${index + 1}`.repeat(12),
    }));
    renderPage({ snapshot });
    fireEvent.click(screen.getByRole("button", { name: /分镜规划/ }));

    const documentRegion = screen.getByRole("region", { name: "分镜规划文档" });
    expect(within(documentRegion).getAllByText(/^镜头 \d{2}$/)).toHaveLength(30);
    expect(screen.queryByRole("button", { name: /生成图片|生成视频|重新生成镜头|渲染|render/i })).not.toBeInTheDocument();
  });
});
