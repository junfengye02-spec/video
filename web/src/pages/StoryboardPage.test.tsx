import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type {
  GenerationPlan,
  Shot,
  ShotSaveRequest,
  TaskBatch,
  TaskItemStatus,
} from "../domain/types";
import { getStrings } from "../i18n";
import { createProjectResponse, createShot } from "../test/fixtures";
import { chooseSelectMenuOption } from "../test/selectMenu";
import { StoryboardPage, type StoryboardPageProps } from "./StoryboardPage";

const project = createProjectResponse({ shotCount: 2 });

function savedShot(payload: ShotSaveRequest): Shot {
  return createShot({
    ...project.storyboard.shots[0],
    prompt: payload.prompt ?? project.storyboard.shots[0].prompt,
    characters: payload.characters ?? project.storyboard.shots[0].characters,
    location: payload.location ?? project.storyboard.shots[0].location,
    props: payload.props ?? project.storyboard.shots[0].props,
    asset_ids: payload.asset_ids ?? project.storyboard.shots[0].asset_ids,
    shot_intent: payload.shot_intent ?? project.storyboard.shots[0].shot_intent,
    shot_language: payload.shot_language ?? project.storyboard.shots[0].shot_language,
    episode_number: payload.episode_number === undefined
      ? project.storyboard.shots[0].episode_number
      : payload.episode_number,
  });
}

function props(overrides: Partial<StoryboardPageProps> = {}): StoryboardPageProps {
  return {
    projectId: "p1",
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
      shot_intent: "强调人物犹豫",
      shot_language: { shot_size: "close_up" },
    }),
    onSaveShot: vi.fn().mockImplementation(async (_shotId, payload) => savedShot(payload)),
    onRegenerateShot: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderPage(overrides: Partial<StoryboardPageProps> = {}) {
  const pageProps = props(overrides);
  return {
    ...render(<MemoryRouter><StoryboardPage {...pageProps} /></MemoryRouter>),
    pageProps,
  };
}

function useCompactViewport() {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(max-width: 1179px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } satisfies MediaQueryList)));
}

function useControllableCompactViewport(initialMatches = false) {
  let matches = initialMatches;
  let listener: ((event: MediaQueryListEvent) => void) | null = null;
  const query = {
    get matches() { return matches; },
    media: "(max-width: 1179px)",
    onchange: null,
    addEventListener: vi.fn((_type: string, next: EventListenerOrEventListenerObject) => {
      listener = next as (event: MediaQueryListEvent) => void;
    }),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return {
    setCompact(next: boolean) {
      matches = next;
      act(() => listener?.({ matches: next } as MediaQueryListEvent));
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function shotTask(
  status: TaskItemStatus,
  shotIds: string[],
  errorCode: string | null = null,
): TaskBatch {
  return {
    id: `task-${status}`,
    project_id: "p1",
    task_type: "storyboard_video.generate",
    status,
    idempotency_key: `key-${status}`,
    progress: status === "complete" ? 100 : 0,
    total_items: shotIds.length,
    completed_items: status === "complete" ? shotIds.length : 0,
    failed_items: status === "failed" ? shotIds.length : 0,
    error_code: null,
    error_message: null,
    created_at: "2026-07-21T00:00:00Z",
    updated_at: "2026-07-21T00:00:00Z",
    items: shotIds.map((shotId, position) => ({
      id: `item-${status}-${shotId}`,
      batch_id: `task-${status}`,
      position,
      task_type: "shot_video.generate",
      status,
      idempotency_key: `item-${shotId}`,
      input: { dependency: { required: position > 0 } },
      target_entity_type: "shot_video",
      target_entity_id: shotId,
      target_entity_version: 1,
      attempt_count: status === "queued" ? 0 : 1,
      max_attempts: 10,
      progress: status === "complete" ? 100 : 0,
      retryable: true,
      error_code: errorCode,
      error_message: errorCode ? "dependency" : null,
      result: null,
      billing_job_id: null,
      provider_wait_started_at: null,
      provider_next_poll_at: null,
      provider_poll_count: 0,
      dependencies: [],
      created_at: "2026-07-21T00:00:00Z",
      updated_at: "2026-07-21T00:00:00Z",
    })),
  };
}

function generationPlan(
  shots: Shot[],
  overrides: Partial<GenerationPlan> = {},
): GenerationPlan {
  const sourceShotIds = shots.map((shot) => shot.id);
  const unitId = "unit-" + "a".repeat(24);
  return {
    version: "1.0",
    id: "a".repeat(64),
    storyboard_revision: "sha256:storyboard",
    provider: "newapi",
    model_id: "omni_flash-10s",
    shot_ids: sourceShotIds,
    storyboard_shot_count: shots.length,
    generation_unit_count: 1,
    protected_generation_unit_ids: [],
    pending_shot_ids: sourceShotIds,
    covered_shot_ids: sourceShotIds,
    covered_segment_ids: [],
    target_duration_seconds: 10,
    native_total_duration_seconds: 10,
    timeline_total_duration_seconds: 10,
    duration_difference_seconds: 0,
    compatible_with_target: true,
    requires_confirmation: false,
    can_generate: true,
    confirmed_strategy: null,
    issues: [],
    adaptation_options: ["choose_compatible_model"],
    generation_segments: [],
    generation_units: [{
      id: unitId,
      revision: 1,
      status: "planned",
      shot_ids: sourceShotIds,
      source_shot_ids: sourceShotIds,
      source_beat_ids: shots.map((shot) => shot.beat_id ?? shot.id),
      source_segment_ids: [],
      prompt_segments: [],
      provider: "newapi",
      model_id: "omni_flash-10s",
      operation: "text_to_video",
      requested_duration_seconds: 10,
      source_duration_seconds: null,
      timeline_duration_seconds: 10,
      output_asset_id: null,
      output_path: null,
      billing_job_id: null,
      task_item_id: null,
      replaces_unit_id: null,
      profile: {
        provider: "newapi",
        model_id: "omni_flash-10s",
        operation: "text_to_video",
        duration_mode: "fixed",
        fixed_duration_seconds: 10,
        supported_duration_seconds: [],
        min_duration_seconds: null,
        max_duration_seconds: null,
        supports_start_frame: false,
        supports_end_frame: false,
        supports_extend: false,
        supports_sequential_beats: true,
        supports_multi_shot_prompt: true,
        max_narrative_beats_per_unit: 2,
        contract_source: "verified_override",
        profile_revision: "test",
        duration_configuration_status: "configured",
      },
    }],
    ...overrides,
  };
}

function generationUnitTask(status: TaskItemStatus, unitIds: string[]): TaskBatch {
  const task = shotTask(status, unitIds);
  task.task_type = "generation_unit_video.generate";
  task.items = task.items?.map((item, index) => ({
    ...item,
    task_type: "generation_unit_video.generate",
    target_entity_type: "generation_unit",
    target_entity_id: unitIds[index],
  })) ?? [];
  return task;
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("StoryboardPage", () => {
  it("does not repeat generation-plan previews when a parent recreates callbacks", async () => {
    const preview = vi.fn().mockRejectedValue(new Error("preview failed"));
    const pageProps = props({
      onPreviewGenerationPlan: (payload) => preview(payload),
    });
    const view = render(
      <MemoryRouter><StoryboardPage {...pageProps} /></MemoryRouter>,
    );

    await waitFor(() => expect(preview).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("preview failed")).toBeInTheDocument();

    view.rerender(
      <MemoryRouter>
        <StoryboardPage
          {...pageProps}
          onPreviewGenerationPlan={(payload) => preview(payload)}
        />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("previews the complete episode and submits only generation unit IDs", async () => {
    const plan = generationPlan(project.storyboard.shots);
    const onGenerateGenerationUnits = vi.fn(async (payload) => ({
      task_id: "task-queued",
      status: "queued" as const,
      deduplicated: false,
      task: generationUnitTask("queued", payload.generation_unit_ids),
    }));
    const onPreviewGenerationPlan = vi.fn(async () => plan);
    renderPage({
      onGenerateGenerationUnits,
      onPreviewGenerationPlan,
      onListTasks: vi.fn(async () => ({ tasks: [] })),
    });

    expect(await screen.findByText("2 个叙事节拍 / 1 个视频生成单元 / 预计 10 秒"))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成 1 个待处理单元" }));

    await waitFor(() => expect(onGenerateGenerationUnits).toHaveBeenCalledTimes(1));
    expect(onPreviewGenerationPlan).toHaveBeenCalledWith({
      video_model: "omni_flash-10s",
      shot_ids: ["shot-1", "shot-2"],
      regenerate_unit_ids: [],
    });
    expect(onGenerateGenerationUnits).toHaveBeenCalledWith({
      generation_plan_id: plan.id,
      generation_unit_ids: [plan.generation_units[0].id],
      idempotency_key: expect.stringMatching(/^generation-units:/),
    });
  });

  it("excludes protected units from submission and prevents duplicate commands", async () => {
    const base = generationPlan(project.storyboard.shots);
    const protectedUnit = {
      ...base.generation_units[0],
      id: "unit-protected",
      status: "complete" as const,
      source_shot_ids: ["shot-1"],
      shot_ids: ["shot-1"],
      source_beat_ids: ["shot-1"],
    };
    const pendingUnit = {
      ...base.generation_units[0],
      id: "unit-pending",
      source_shot_ids: ["shot-2"],
      shot_ids: ["shot-2"],
      source_beat_ids: ["shot-2"],
    };
    const plan = generationPlan(project.storyboard.shots, {
      generation_unit_count: 2,
      protected_generation_unit_ids: [protectedUnit.id],
      pending_shot_ids: ["shot-2"],
      generation_units: [protectedUnit, pendingUnit],
    });
    const pending = deferred<{
      task_id: string;
      status: "queued";
      deduplicated: boolean;
      task: TaskBatch;
    }>();
    const onGenerateGenerationUnits = vi.fn(() => pending.promise);
    renderPage({
      onGenerateGenerationUnits,
      onPreviewGenerationPlan: vi.fn(async () => plan),
      onListTasks: vi.fn(async () => ({ tasks: [] })),
    });

    expect(await screen.findByText("已保护")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "生成 1 个待处理单元" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(onGenerateGenerationUnits).toHaveBeenCalledTimes(1);
    expect(onGenerateGenerationUnits).toHaveBeenCalledWith(expect.objectContaining({
      generation_unit_ids: [pendingUnit.id],
    }));
    pending.resolve({
      task_id: "task-queued",
      status: "queued",
      deduplicated: false,
      task: generationUnitTask("queued", [pendingUnit.id]),
    });
    await waitFor(() => expect(screen.getByText("排队中")).toBeInTheDocument());
  });

  it("keeps failed items out of new batches and retries only that persisted item", async () => {
    const failed = shotTask("failed", ["shot-1"], "provider_call_failed");
    const retried = deferred<TaskBatch>();
    const onRetryTaskItem = vi.fn(() => retried.promise);
    renderPage({
      onListTasks: vi.fn(async () => ({ tasks: [failed] })),
      onRetryTaskItem,
    });

    expect(screen.queryByRole("checkbox", { name: "选择分镜 1 进行生成" })).not.toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: "重试当前分镜" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(onRetryTaskItem).toHaveBeenCalledTimes(1);
    expect(onRetryTaskItem).toHaveBeenCalledWith(
      failed.id,
      failed.items?.[0].id,
    );

    retried.resolve(shotTask("queued", ["shot-1"]));
    await waitFor(() => expect(screen.getByText("排队中")).toBeInTheDocument());
  });

  it("uses the newest task item when an older batch is returned first", async () => {
    const older = shotTask("complete", ["shot-1"]);
    older.id = "task-older";
    older.updated_at = "2026-07-21T00:00:00Z";
    const newer = shotTask("failed", ["shot-1"], "provider_call_failed");
    newer.id = "task-newer";
    newer.updated_at = "2026-07-22T00:00:00Z";
    renderPage({
      onListTasks: vi.fn(async () => ({ tasks: [older, newer] })),
      onRetryTaskItem: vi.fn(),
    });

    expect(await screen.findByRole("button", {
      name: getStrings("zh").storyboardPage.retryShotAction,
    })).toBeInTheDocument();
  });

  it("offers the composition stage once every scoped shot has reusable media", async () => {
    renderPage({
      productionUrl: "/projects/p1/production",
      resolveShotMedia: (shot) => `/media/${shot.id}.mp4`,
      shots: project.storyboard.shots.map((shot) => ({ ...shot, status: "complete" })),
    });

    expect(screen.getByText("当前范围镜头已就绪")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "进入合成" })).toHaveAttribute(
      "href",
      "/projects/p1/production",
    );
  });

  it("offers composition from complete generation units when shot media fields are empty", () => {
    const unitMedia = new Map([
      ["shot-1", ["/media/unit-1.mp4", "/media/unit-2.mp4"]],
      ["shot-2", ["/media/unit-3.mp4"]],
    ]);
    const rendered = renderPage({
      productionUrl: "/projects/p1/production",
      resolveGenerationUnitMedia: (shot) => ({
        complete: true,
        hasUnits: true,
        urls: unitMedia.get(shot.id) ?? [],
      }),
      shots: project.storyboard.shots.map((shot) => ({
        ...shot,
        output_path: null,
        output_url: null,
        status: "ready",
      })),
    });

    expect(rendered.container.querySelector('video[src="/media/unit-1.mp4"]'))
      .toBeInTheDocument();
    expect(screen.getByRole("link", {
      name: getStrings("zh").storyboardPage.continueToCompositionAction,
    })).toHaveAttribute("href", "/projects/p1/production");
  });

  it("limits generation selection to the active episode", () => {
    const shots = [
      createShot({ id: "episode-1", index: 1, episode_number: 1 }),
      createShot({ id: "episode-2", index: 2, episode_number: 2 }),
    ];
    renderPage({ shots, activeEpisodeNumber: 2, selectedShotId: "episode-2" });

    expect(screen.queryByRole("button", { name: "选择分镜 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选择分镜 2" })).toBeInTheDocument();
  });

  it("switches the active episode from the storyboard controls", async () => {
    const shots = [
      createShot({ id: "episode-1", index: 1, episode_number: 1 }),
      createShot({ id: "episode-2", index: 2, episode_number: 2 }),
    ];
    const continuityPlan = project.continuity_plan!;
    const episodes = [
      { ...continuityPlan.episodes[0], episode_number: 1, title: "第一集" },
      { ...continuityPlan.episodes[0], episode_number: 2, title: "第二集" },
    ];
    const onSelectEpisode = vi.fn().mockResolvedValue(undefined);
    renderPage({
      shots,
      episodes,
      activeEpisodeNumber: 1,
      selectedShotId: "episode-1",
      onSelectEpisode,
    });

    chooseSelectMenuOption("当前分集", "第 2 集 · 第二集");

    await waitFor(() => expect(onSelectEpisode).toHaveBeenCalledWith(2));
  });

  it("keeps the route page thin while composing the three-pane feature", () => {
    renderPage();

    expect(screen.getByRole("region", { name: "分镜工作台" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "分镜列表" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "分镜预览" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "分镜顺序" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "分镜检查器" })).toBeInTheDocument();
  });

  it("plans an existing empty project once and preserves its initial direction", async () => {
    const onPlanStoryboard = vi.fn().mockResolvedValue(undefined);
    renderPage({
      selectedShotId: null,
      shots: [],
      initialPlanPrompt: "资源优先项目的故事方向",
      onPlanStoryboard,
    });
    const prompt = screen.getByLabelText("故事与画面要求");
    expect(prompt).toHaveValue("资源优先项目的故事方向");
    fireEvent.change(prompt, { target: { value: "  一封信改变两个人的命运  " } });
    const submit = screen.getByRole("button", { name: "AI 规划分镜" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(onPlanStoryboard).toHaveBeenCalledTimes(1));
    expect(onPlanStoryboard).toHaveBeenCalledWith("一封信改变两个人的命运");
  });

  it("shows status icons and text for ready, generating, complete, and failed shots", () => {
    const shots = ["ready", "generating", "complete", "failed"].map((status, index) => createShot({
      id: `status-${index}`,
      index: index + 1,
      status: status as Shot["status"],
    }));
    renderPage({ shots, selectedShotId: shots[0].id });
    const list = screen.getByRole("navigation", { name: "分镜列表" });

    for (const label of ["就绪", "生成中", "已完成", "失败"]) {
      const status = within(list).getByText(label).parentElement;
      expect(status?.querySelector("svg")).toBeInTheDocument();
    }
  });

  it("renders 30+ shots in one scrollable list and filmstrip without adding edit affordances", () => {
    const shots = Array.from({ length: 32 }, (_, index) => createShot({
      id: `long-shot-${index + 1}`,
      index: index + 1,
      beat: `长分镜 ${index + 1}`,
    }));
    renderPage({
      shots,
      selectedShotId: shots[0].id,
      projectDurationSeconds: 160,
    });

    const list = screen.getByRole("navigation", { name: "分镜列表" });
    expect(within(list).getAllByRole("button", { name: /^选择分镜 \d+$/ })).toHaveLength(32);
    expect(within(list).getByRole("button", { name: "选择分镜 32" })).toBeInTheDocument();
    expect(within(list).queryByText("预计 5.0 秒")).not.toBeInTheDocument();
    const filmstrip = screen.getByRole("navigation", { name: "分镜顺序" });
    expect(within(filmstrip).getAllByRole("button")).toHaveLength(32);
    expect(screen.queryByText("下一组分镜")).not.toBeInTheDocument();
    expect(filmstrip.querySelector("[draggable=true]")).not.toBeInTheDocument();
  });

  it("selects from either synchronized surface without regenerating", () => {
    const onSelectShot = vi.fn();
    const onRegenerateShot = vi.fn();
    renderPage({ onSelectShot, onRegenerateShot });

    fireEvent.click(screen.getByRole("button", { name: "选择分镜 2" }));
    fireEvent.click(screen.getByRole("button", { name: "在顺序中选择分镜 2" }));

    expect(onSelectShot).toHaveBeenNthCalledWith(1, "shot-2");
    expect(onSelectShot).toHaveBeenNthCalledWith(2, "shot-2");
    expect(onRegenerateShot).not.toHaveBeenCalled();
  });

  it("guards dirty selection from both list and filmstrip", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onSelectShot = vi.fn();
    renderPage({ onSelectShot });
    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "未保存草稿" } });

    fireEvent.click(screen.getByRole("button", { name: "选择分镜 2" }));
    expect(onSelectShot).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "在顺序中选择分镜 2" }));

    expect(confirm).toHaveBeenLastCalledWith("当前分镜有未保存修改，确定放弃吗？");
    expect(onSelectShot).toHaveBeenCalledWith("shot-2");
  });

  it("keeps AI optimization in the draft, supports undo, and saves only on command", async () => {
    const onSaveShot = vi.fn().mockImplementation(async (_shotId, payload) => savedShot(payload));
    renderPage({ onSaveShot });
    fireEvent.click(screen.getByRole("button", { name: "AI 优化提示词" }));

    expect(await screen.findByDisplayValue("优化后的画面提示词")).toBeInTheDocument();
    expect(onSaveShot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "撤销优化" }));
    expect(screen.getByLabelText("分镜提示词")).toHaveValue(project.storyboard.shots[0].prompt);

    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "手动保存草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(onSaveShot).toHaveBeenCalledWith(
      "shot-1",
      expect.objectContaining({ prompt: "手动保存草稿" }),
    ));
    expect(await screen.findByText("分镜修改已保存。")).toBeInTheDocument();
  });

  it("lets a series operator assign a shot to an episode before saving", async () => {
    const onSaveShot = vi.fn().mockImplementation(async (_shotId, payload) => savedShot(payload));
    const continuityPlan = project.continuity_plan!;
    const episodes = [
      { ...continuityPlan.episodes[0], episode_number: 1, title: "第一集" },
      { ...continuityPlan.episodes[0], episode_number: 2, title: "第二集" },
    ];
    renderPage({ onSaveShot, episodes });

    chooseSelectMenuOption(getStrings("zh").shotEditor.episodeLabel, "第 2 集 · 第二集");
    fireEvent.click(screen.getByRole("button", { name: getStrings("zh").shotEditor.saveAction }));

    await waitFor(() => expect(onSaveShot).toHaveBeenCalledWith(
      "shot-1",
      expect.objectContaining({ episode_number: 2 }),
    ));
  });

  it("keeps character and resource bindings in the save payload", async () => {
    const onSaveShot = vi.fn().mockImplementation(async (_shotId, payload) => savedShot(payload));
    renderPage({
      assets: [{
        id: "scene-rain",
        kind: "scene",
        label: "雨夜车站",
        reference_images: ["station.png"],
      }],
      characters: [{
        id: "char-mara",
        name: "玛拉",
        role: "修复师",
        visual_lock: "红色风衣",
        voice: null,
        reference_images: [],
        locked: true,
      }],
      shots: [createShot({ id: "shot-1", characters: [], asset_ids: [] })],
      onSaveShot,
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /玛拉.*修复师/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /雨夜车站.*场景/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(onSaveShot).toHaveBeenCalledWith("shot-1", expect.objectContaining({
      characters: ["char-mara"],
      asset_ids: ["scene-rain"],
    })));
  });

  it("sends the real nine-shot continuity payload shape when binding a resource", async () => {
    const onSaveShot = vi.fn().mockImplementation(async (_shotId, payload) => savedShot(payload));
    const continuity = {
      mode: "cut" as const,
      inherit_previous_tail: false,
      explicit_user_first_frame_asset_id: null,
      inherited_first_frame_asset_id: null,
      last_frame_asset_id: null,
      first_frame: null,
      last_frame: null,
      stale: false,
      composition: "",
      subject_pose: "",
      gaze: "",
      motion_direction: "",
      lighting: "",
      scene_state: "",
    };
    renderPage({
      assets: [{
        id: "prop_recorder",
        kind: "prop",
        label: "会发光的旧录音机",
        reference_images: ["ref/prop_recorder.png"],
      }],
      characters: [
        { id: "char_girl_lin", name: "林夏", role: "女儿", visual_lock: "", voice: null, reference_images: [], locked: true },
        { id: "char_father_chen", name: "陈默", role: "父亲", visual_lock: "", voice: null, reference_images: [], locked: true },
      ],
      shots: [createShot({
        id: "shot_09",
        characters: ["char_girl_lin", "char_father_chen"],
        location: "清晨站台中央",
        props: ["prop_recorder"],
        asset_ids: [],
        shot_intent: "完成父女重逢和情绪闭环。",
        shot_language: {
          shot_size: "medium_close",
          camera_movement: "dolly_in",
          lens_mm: 50,
          lighting_key: "golden_hour",
          depth_of_field: "medium",
          color_temperature: "warm",
        },
        continuity,
      })],
      selectedShotId: "shot_09",
      onSaveShot,
    });

    fireEvent.click(screen.getByRole("checkbox", { name: /会发光的旧录音机.*道具/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(onSaveShot).toHaveBeenCalledWith("shot_09", {
      episode_number: null,
      prompt: expect.any(String),
      characters: ["char_girl_lin", "char_father_chen"],
      location: "清晨站台中央",
      props: ["prop_recorder"],
      asset_ids: ["prop_recorder"],
      shot_intent: "完成父女重逢和情绪闭环。",
      shot_language: {
        shot_size: "medium_close",
        camera_movement: "dolly_in",
        lens_mm: 50,
        lighting_key: "golden_hour",
        depth_of_field: "medium",
        color_temperature: "warm",
      },
      continuity,
    }));
  });

  it("removes the legacy per-shot video regeneration command from the unit workflow", () => {
    const onRegenerateShot = vi.fn();
    renderPage({ onRegenerateShot });

    expect(screen.queryByRole("button", { name: "重新生成视频" })).not.toBeInTheDocument();
    expect(onRegenerateShot).not.toHaveBeenCalled();
  });

  it("keeps the inspector mounted, dirty, and focus-restorable across compact segments", async () => {
    useCompactViewport();
    renderPage();
    const tabs = screen.getByRole("tablist", { name: "分镜视图" });
    fireEvent.click(within(tabs).getByRole("tab", { name: "分镜检查器" }));
    const prompt = screen.getByLabelText("分镜提示词");
    prompt.focus();
    fireEvent.change(prompt, { target: { value: "分段切换保留草稿" } });
    fireEvent.click(within(tabs).getByRole("tab", { name: "预览" }));
    fireEvent.click(within(tabs).getByRole("tab", { name: "分镜检查器" }));

    await waitFor(() => expect(prompt).toHaveFocus());
    expect(screen.getByLabelText("分镜提示词")).toBe(prompt);
    expect(prompt).toHaveValue("分段切换保留草稿");
    expect(screen.getAllByText("未保存").length).toBeGreaterThan(0);
  });

  it("reveals a filmstrip selection when the compact shot list becomes visible", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(max-width: 1179px)" || query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } satisfies MediaQueryList)));
    const shots = Array.from({ length: 9 }, (_, index) => createShot({
      id: `compact-shot-${index + 1}`,
      index: index + 1,
    }));

    function Harness() {
      const [selectedShotId, setSelectedShotId] = useState(shots[0].id);
      return (
        <MemoryRouter>
          <StoryboardPage {...props({ shots, selectedShotId, onSelectShot: setSelectedShotId })} />
        </MemoryRouter>
      );
    }

    const rendered = render(<Harness />);
    const list = rendered.container.querySelector<HTMLOListElement>("[data-testid=shot-scroll-list]")!;
    Object.defineProperties(list, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 900 },
      scrollTop: { value: 0, writable: true },
    });
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({
      top: 0, bottom: 200, height: 200, left: 0, right: 280, width: 280,
      x: 0, y: 0, toJSON: () => ({}),
    });
    const tail = screen.getByRole("button", { name: "选择分镜 9" });
    vi.spyOn(tail, "getBoundingClientRect").mockReturnValue({
      top: 760, bottom: 840, height: 80, left: 0, right: 280, width: 280,
      x: 0, y: 760, toJSON: () => ({}),
    });

    fireEvent.click(screen.getByRole("button", { name: "在顺序中选择分镜 9" }));
    expect(list.scrollTop).toBe(0);
    fireEvent.click(within(screen.getByRole("tablist", { name: "分镜视图" })).getByRole("tab", { name: "分镜列表" }));

    await waitFor(() => expect(list.scrollTop).toBe(648));
  });

  it("clears retained workbench scroll offsets when crossing the compact breakpoint", () => {
    const viewport = useControllableCompactViewport(false);
    const rendered = renderPage();
    const pane = rendered.container.querySelector<HTMLElement>("[data-active]");
    const root = pane?.parentElement;
    expect(root).toBeInstanceOf(HTMLElement);

    root!.scrollTop = 174;
    root!.scrollLeft = 32;
    viewport.setCompact(true);
    expect(root).toHaveProperty("scrollTop", 0);
    expect(root).toHaveProperty("scrollLeft", 0);

    root!.scrollTop = 93;
    viewport.setCompact(false);
    expect(root).toHaveProperty("scrollTop", 0);
  });

  it("reports dirty state upward for route-level beforeunload and navigation gates", async () => {
    const onDirtyChange = vi.fn();
    const rendered = renderPage({ onDirtyChange });
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "向路由报告" } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));
    rendered.unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("keeps the old medium visible while background regeneration is pending", () => {
    const shot = createShot({ output_path: "assets/video/shot.mp4", status: "generating" });
    renderPage({
      shots: [shot],
      selectedShotId: shot.id,
      regeneratingShotId: null,
      projectAspectRatio: "9:16",
      resolveShotMedia: () => "blob:shot",
    });
    const media = screen.getByLabelText("分镜 1 预览媒体");
    fireEvent.loadedData(media);
    const canvas = media.closest("[data-media-state]");

    expect(canvas).toHaveStyle({ aspectRatio: "9 / 16" });
    expect(screen.getByText("视频正在生成")).toBeInTheDocument();
    expect(media).toBeInTheDocument();
  });
});
