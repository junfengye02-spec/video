import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ConsistencyPanel } from "../components/ConsistencyPanel";
import { JobProgress } from "../components/JobProgress";
import type { JobEvent, WorkflowArtifactStatus } from "../domain/types";
import { getStrings } from "../i18n";
import { createProjectResponse } from "../test/fixtures";
import { ProductionPage, type ProductionPageProps } from "./ProductionPage";

const project = createProjectResponse();
const productionProps: ProductionPageProps = {
  consistencyReport: project.consistency_report,
  downloading: false,
  events: [],
  finalPath: null,
  finalRenderUrl: null,
  rendering: false,
  shots: project.storyboard.shots,
  shotCount: project.storyboard.shots.length,
  workflowArtifacts: project.workflow_artifacts ?? [],
  onDownload: vi.fn().mockResolvedValue(undefined),
  onRender: vi.fn().mockResolvedValue(undefined),
};

const event: JobEvent = {
  id: "event-1",
  job_id: "job-1",
  project_id: "p1",
  stage: "compose",
  status: "running",
  message: "Encoding final video",
  created_at: "2026-07-10T08:00:00Z",
};
const completedEvent: JobEvent = {
  ...event,
  id: "event-2",
  stage: "package",
  status: "complete",
  message: "Final video ready",
  created_at: "2026-07-10T08:01:00Z",
};
const zh = getStrings("zh").production;

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("ProductionPage", () => {
  it("shows active episode render scope and completed episode outputs for a series", () => {
    const series = createProjectResponse({ projectType: "mini_series", shotCount: 3 });
    const continuityPlan = {
      ...series.continuity_plan!,
      active_episode_number: 2,
      episodes: [
        { ...series.continuity_plan!.episodes[0], episode_number: 1, title: "第一封信" },
        { ...series.continuity_plan!.episodes[0], episode_number: 2, title: "第二封信" },
        { ...series.continuity_plan!.episodes[0], episode_number: 3, title: "最后警告" },
      ],
    };
    render(
      <ProductionPage
        {...productionProps}
        continuityPlan={continuityPlan}
        finalPath="renders/episode-002.mp4"
        finalRenderUrl="/api/projects/p1/media/renders/episode-002.mp4"
        projectId="p1"
        shots={series.storyboard.shots.map((shot, index) => ({
          ...shot,
          episode_number: index === 2 ? 3 : index === 1 ? 2 : 1,
        }))}
        production={{
          shot_summary: { total: 3, reusable: 3, to_generate: 0, completed: 3 },
          output: {
            format: "mp4",
            resolution: "720x1280",
            aspect_ratio: "9:16",
            duration_seconds: 15,
            render_runtime: "ffmpeg",
          },
          continuity: { characters: 2, locations: 1, props: 1, bound_assets: 2 },
          render_scope: {
            kind: "episode",
            episode_number: 2,
            episode_title: "第二封信",
            total_episodes: 3,
          },
          active_job: null,
        }}
        renderReport={{
          version: "1.0",
          outputs: [
            {
              path: "renders/episode-001.mp4",
              format: "mp4",
              resolution: "720x1280",
              duration_seconds: 15,
              episode_number: 1,
              episode_title: "第一封信",
              shot_ids: ["shot-1"],
            },
            {
              path: "renders/episode-002.mp4",
              format: "mp4",
              resolution: "720x1280",
              duration_seconds: 15,
              episode_number: 2,
              episode_title: "第二封信",
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("本次合成：第 2 集 · 第二封信")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "分集成片" })).toHaveTextContent("第 1 集 · 第一封信已完成");
    expect(screen.getByRole("list", { name: "分集成片" })).toHaveTextContent("使用镜头：shot-1");
    expect(screen.getByRole("list", { name: "分集成片" })).toHaveTextContent("第 3 集 · 最后警告待合成");
    expect(screen.getByRole("button", { name: "重新合成第 2 集" })).toBeEnabled();
  });

  it("lets the operator choose the active episode shots and sends that selection to production", async () => {
    const series = createProjectResponse({ projectType: "mini_series", shotCount: 3 });
    const shots = series.storyboard.shots.map((shot, index) => ({
      ...shot,
      episode_number: index === 2 ? 2 : 1,
    }));
    const continuityPlan = {
      ...series.continuity_plan!,
      episodes: [
        { ...series.continuity_plan!.episodes[0], episode_number: 1, title: "第一封信" },
        { ...series.continuity_plan!.episodes[0], episode_number: 2, title: "第二封信" },
      ],
    };
    const onPrepareRender = vi.fn().mockResolvedValue({
      ...productionProps,
      project_id: "p1",
      selected_shot_ids: ["shot-1"],
      shot_summary: { total: 1, reusable: 1, to_generate: 0, completed: 1 },
      estimated_units: 0,
      available_units: 20_000,
      estimate_status: "not_required",
      output: {
        format: "mp4",
        resolution: "1920x1080",
        aspect_ratio: "16:9",
        duration_seconds: 5,
        render_runtime: "ffmpeg",
      },
      continuity: { characters: 1, locations: 1, props: 1, bound_assets: 0 },
      render_scope: {
        kind: "episode",
        episode_number: 1,
        episode_title: "第一封信",
        total_episodes: 2,
      },
      active_job: null,
    });
    const onRender = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductionPage
        {...productionProps}
        continuityPlan={continuityPlan}
        onPrepareRender={onPrepareRender}
        onRender={onRender}
        production={{
          shot_summary: { total: 2, reusable: 2, to_generate: 0, completed: 2 },
          output: {
            format: "mp4",
            resolution: "1920x1080",
            aspect_ratio: "16:9",
            duration_seconds: 10,
            render_runtime: "ffmpeg",
          },
          continuity: { characters: 1, locations: 1, props: 1, bound_assets: 0 },
          render_scope: {
            kind: "episode",
            episode_number: 1,
            episode_title: "第一封信",
            total_episodes: 2,
          },
          active_job: null,
        }}
        shots={shots}
      />,
    );

    const secondShot = await screen.findByRole("checkbox", { name: "选择第 2 镜：分镜 2" });
    expect(secondShot).toBeChecked();
    fireEvent.click(secondShot);
    fireEvent.click(await screen.findByRole("button", { name: "生成第 1 集成片" }));

    const dialog = await screen.findByRole("dialog", { name: zh.confirmation.title });
    expect(onPrepareRender).toHaveBeenCalledWith(["shot-1"]);
    expect(dialog).toHaveTextContent("生成镜头");
    fireEvent.click(screen.getByRole("button", { name: zh.confirmation.confirmAction }));
    await waitFor(() => expect(onRender).toHaveBeenCalledWith(["shot-1"]));
  });
  it("includes the authoritative episode scope in render confirmation", async () => {
    const onPrepareRender = vi.fn().mockResolvedValue({
      project_id: "p1",
      shot_summary: { total: 3, reusable: 1, to_generate: 2, completed: 1 },
      estimated_units: 2_000,
      available_units: 20_000,
      estimate_status: "ready",
      output: {
        format: "mp4",
        resolution: "720x1280",
        aspect_ratio: "9:16",
        duration_seconds: 15,
        render_runtime: "ffmpeg",
      },
      continuity: { characters: 2, locations: 1, props: 1, bound_assets: 1 },
      render_scope: {
        kind: "episode",
        episode_number: 2,
        episode_title: "第二封信",
        total_episodes: 3,
      },
      active_job: null,
    });
    render(<ProductionPage {...productionProps} onPrepareRender={onPrepareRender} />);

    fireEvent.click(screen.getByRole("button", { name: zh.renderAction }));

    const dialog = await screen.findByRole("dialog", { name: zh.confirmation.title });
    expect(dialog).toHaveTextContent("合成范围");
    expect(dialog).toHaveTextContent("第 2 集");
    expect(dialog).toHaveTextContent("第二封信");
  });

  it("bounds long consistency reports with accessible pagination", () => {
    const issues = Array.from({ length: 25 }, (_, index) => ({
      shot_id: `shot-${index + 1}`,
      severity: "warning" as const,
      code: "continuity",
      message: `一致性问题 ${index + 1}`,
    }));

    render(<ConsistencyPanel report={{ score: 72, issues }} />);

    expect(screen.getByText("一致性问题 1")).toBeVisible();
    expect(screen.getByText("一致性问题 10")).toBeVisible();
    expect(screen.queryByText("一致性问题 11")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "一致性问题分页状态" })).toHaveTextContent("第 1 / 3 页，共 25 项");

    fireEvent.click(screen.getByRole("button", { name: "下一页一致性问题" }));

    expect(screen.getByText("一致性问题 11")).toBeVisible();
    expect(screen.queryByText("一致性问题 1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页一致性问题" })).toBeEnabled();
  });

  it("prepares an authoritative render confirmation before starting production", async () => {
    const onPrepareRender = vi.fn().mockResolvedValue({
      project_id: "p1",
      shot_summary: { total: 36, reusable: 11, to_generate: 25, completed: 11 },
      estimated_units: 12_500_000,
      available_units: 40_000_000,
      estimate_status: "ready",
      output: {
        format: "mp4",
        resolution: "1280x720",
        aspect_ratio: "16:9",
        duration_seconds: 180,
        render_runtime: "ffmpeg",
      },
      continuity: { characters: 12, locations: 8, props: 19, bound_assets: 31 },
      active_job: null,
    });
    const onRender = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductionPage
        {...productionProps}
        onPrepareRender={onPrepareRender}
        onRender={onRender}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: zh.renderAction }));

    const dialog = await screen.findByRole("dialog", { name: "确认开始制作" });
    expect(onPrepareRender).toHaveBeenCalledTimes(1);
    expect(onRender).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent("25");
    expect(dialog).toHaveTextContent("11");
    expect(dialog).toHaveTextContent("¥12.50");
    expect(dialog).toHaveTextContent("¥40.00");
    expect(dialog).toHaveTextContent("1280x720");
    expect(dialog).toHaveTextContent("12 位人物");

    fireEvent.click(within(dialog).getByRole("button", { name: "确认并开始制作" }));
    await waitFor(() => expect(onRender).toHaveBeenCalledTimes(1));
  });

  it("locks the failure recovery action while the authoritative refresh is pending", async () => {
    const refresh = createDeferred();
    const onRefresh = vi.fn(() => refresh.promise);
    render(
      <ProductionPage
        {...productionProps}
        connectionState="disconnected"
        onRefresh={onRefresh}
      />,
    );

    const refreshAction = screen.getByRole("button", { name: zh.jobProgress.refreshAction });
    fireEvent.click(refreshAction);
    fireEvent.click(refreshAction);

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: zh.jobProgress.refreshingAction })).toBeDisabled();

    await act(async () => {
      refresh.resolve();
      await refresh.promise;
    });
    expect(screen.getByRole("button", { name: zh.jobProgress.refreshAction })).toBeEnabled();
  });

  it("shows persisted readiness blockers and retries only the named task item", async () => {
    const retry = createDeferred();
    const onRetryTaskItem = vi.fn(() => retry.promise.then(() => ({}) as never));
    render(
      <ProductionPage
        {...productionProps}
        production={{
          shot_summary: { total: 2, reusable: 1, to_generate: 1, completed: 1 },
          output: {
            format: "mp4",
            resolution: "720x1280",
            aspect_ratio: "9:16",
            duration_seconds: 10,
            render_runtime: "ffmpeg",
          },
          continuity: { characters: 1, locations: 1, props: 0, bound_assets: 1 },
          active_job: null,
          readiness: {
            ready: false,
            selected_shot_ids: ["shot-1", "shot-2"],
            reusable_shot_ids: ["shot-1"],
            blockers: [{
              code: "shot_generation_failed",
              message: "分镜 shot-2 生成失败。",
              shot_id: "shot-2",
              task_id: "task-1",
              task_item_id: "item-2",
              task_status: "failed",
              retryable: true,
            }],
          },
        }}
        onRetryTaskItem={onRetryTaskItem}
      />,
    );

    expect(screen.getByText("分镜 shot-2 生成失败。")).toBeInTheDocument();
    const retryAction = screen.getByRole("button", { name: zh.retryTaskAction });
    fireEvent.click(retryAction);
    fireEvent.click(retryAction);
    expect(onRetryTaskItem).toHaveBeenCalledTimes(1);
    expect(onRetryTaskItem).toHaveBeenCalledWith("task-1", "item-2");
    await act(async () => retry.resolve());
  });

  it("blocks confirmation when the authoritative estimate exceeds the available balance", async () => {
    const onPrepareRender = vi.fn().mockResolvedValue({
      project_id: "p1",
      shot_summary: { total: 4, reusable: 0, to_generate: 4, completed: 0 },
      estimated_units: 80_000,
      available_units: 20_000,
      estimate_status: "ready",
      output: {
        format: "mp4",
        resolution: "720x1280",
        aspect_ratio: "9:16",
        duration_seconds: 20,
        render_runtime: "ffmpeg",
      },
      continuity: { characters: 2, locations: 1, props: 3, bound_assets: 0 },
      active_job: null,
    });
    const onRender = vi.fn().mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <ProductionPage
          {...productionProps}
          onPrepareRender={onPrepareRender}
          onRender={onRender}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: zh.renderAction }));
    const dialog = await screen.findByRole("dialog", { name: "确认开始制作" });
    expect(dialog).toHaveTextContent("额度不足");
    expect(within(dialog).getByRole("button", { name: "确认并开始制作" })).toBeDisabled();
    expect(within(dialog).getByRole("link", { name: "前往钱包" })).toHaveAttribute("href", "/wallet");
    expect(onRender).not.toHaveBeenCalled();
  });

  it("makes remaking an existing final explicit and confirms it again", async () => {
    const onPrepareRender = vi.fn().mockResolvedValue({
      project_id: "p1",
      shot_summary: { total: 2, reusable: 2, to_generate: 0, completed: 2 },
      estimated_units: 0,
      available_units: 900,
      estimate_status: "not_required",
      output: {
        format: "mp4",
        resolution: "720x1280",
        aspect_ratio: "9:16",
        duration_seconds: 10,
        render_runtime: "ffmpeg",
      },
      continuity: { characters: 1, locations: 1, props: 0, bound_assets: 2 },
      active_job: null,
    });
    const onRender = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductionPage
        {...productionProps}
        finalPath="renders/final.mp4"
        finalRenderUrl="/api/projects/p1/media/renders/final.mp4"
        onPrepareRender={onPrepareRender}
        onRender={onRender}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重新制作" }));
    const dialog = await screen.findByRole("dialog", { name: "确认重新制作" });
    expect(dialog).toHaveTextContent("现有成片会保留到新版本制作成功");
    expect(onRender).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认重新制作" }));
    await waitFor(() => expect(onRender).toHaveBeenCalledTimes(1));
  });

  it("keeps the preview frame stable across empty, loading and video states", () => {
    const { rerender } = render(<ProductionPage {...productionProps} />);
    expect(screen.getByTestId("production-preview-frame")).toHaveAttribute("data-state", "empty");

    rerender(
      <ProductionPage
        {...productionProps}
        finalPath="renders/final.mp4"
        finalRenderUrl="/api/projects/p1/media/renders/final.mp4"
      />,
    );
    expect(screen.getByTestId("production-preview-frame")).toHaveAttribute("data-state", "loading");
    fireEvent.loadedData(screen.getByLabelText(zh.finalRender.previewLabel));
    expect(screen.getByTestId("production-preview-frame")).toHaveAttribute("data-state", "ready");
  });

  it("shows progress, workflow artifacts, consistency and final preview", () => {
    render(
      <ProductionPage
        {...productionProps}
        finalPath="local://media/final"
        finalRenderUrl="blob:final"
      />,
    );

    expect(screen.getByRole("heading", { name: "制作进度" })).toBeInTheDocument();
    expect(screen.getByLabelText("成片制作").querySelector(".production-layout"))
      .toBeInTheDocument();
    expect(screen.getByText("storyboard.json")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "一致性检查" })).toBeInTheDocument();
    expect(screen.getByLabelText("最终成片预览")).toHaveAttribute("src", "blob:final");
  });

  it("keeps render and download as explicit isolated actions", async () => {
    const onRender = vi.fn().mockResolvedValue(undefined);
    const onDownload = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ProductionPage
        {...productionProps}
        finalPath="local://media/final"
        onRender={onRender}
        onDownload={onDownload}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重新制作" }));
    await waitFor(() => expect(onRender).toHaveBeenCalledTimes(1));
    expect(onDownload).not.toHaveBeenCalled();

    rerender(
      <ProductionPage
        {...productionProps}
        finalPath="local://media/final"
        onRender={onRender}
        onDownload={onDownload}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "下载最终成片" }));
    await waitFor(() => expect(onDownload).toHaveBeenCalledTimes(1));
    expect(onRender).toHaveBeenCalledTimes(1);
  });

  it("disables rendering without shots and while rendering with an accurate label", () => {
    const { rerender } = render(<ProductionPage {...productionProps} shotCount={0} />);

    expect(screen.getByRole("button", { name: "生成最终成片" })).toBeDisabled();

    rerender(<ProductionPage {...productionProps} rendering />);
    expect(screen.getByRole("button", { name: "正在生成最终成片" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在生成最终成片" })).toHaveClass("async-action");
  });

  it("uses finalPath for diagnostics and download availability without inventing a preview", () => {
    const longPath = `projects/p1/renders/${"nested/".repeat(20)}final.mp4`;
    render(<ProductionPage {...productionProps} finalPath={longPath} />);

    expect(screen.queryByLabelText("最终成片预览")).not.toBeInTheDocument();
    expect(screen.getByText(longPath)).toHaveClass("final-path");
    expect(screen.getByText(longPath)).toHaveStyle({ overflowWrap: "anywhere" });
    expect(screen.getByRole("button", { name: "下载最终成片" })).toBeEnabled();
  });

  it("uses a URL-only final render for preview without enabling download", () => {
    render(<ProductionPage {...productionProps} finalRenderUrl="blob:url-only" />);

    expect(screen.getByLabelText(zh.finalRender.previewLabel)).toHaveAttribute("src", "blob:url-only");
    expect(screen.getByRole("button", { name: zh.finalRender.downloadAction })).toBeDisabled();
  });

  it("requires a final path for download and reflects external download progress", () => {
    const onDownload = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ProductionPage {...productionProps} onDownload={onDownload} />,
    );

    const unavailableDownload = screen.getByRole("button", { name: "下载最终成片" });
    expect(unavailableDownload).toBeDisabled();
    fireEvent.click(unavailableDownload);
    expect(onDownload).not.toHaveBeenCalled();

    rerender(
      <ProductionPage
        {...productionProps}
        downloading
        finalPath="renders/final.mp4"
        onDownload={onDownload}
      />,
    );
    expect(screen.getByRole("button", { name: "正在准备下载" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在准备下载" })).toHaveClass("async-action");
  });

  it("shows every workflow artifact name, path and existence state truthfully", () => {
    const artifacts: WorkflowArtifactStatus[] = [
      { name: "storyboard.json", path: "artifacts/storyboard.json", exists: true },
      { name: "render_report.json", path: "artifacts/render_report.json", exists: false },
    ];
    render(<ProductionPage {...productionProps} workflowArtifacts={artifacts} />);

    const list = screen.getByRole("list", { name: "工作流产物" });
    expect(within(list).getByText("storyboard.json")).toBeInTheDocument();
    expect(within(list).getByLabelText("路径: artifacts/storyboard.json")).toBeInTheDocument();
    expect(within(list).getByText("已生成")).toBeInTheDocument();
    expect(within(list).getByText("render_report.json")).toBeInTheDocument();
    expect(within(list).getByLabelText("路径: artifacts/render_report.json")).toBeInTheDocument();
    expect(within(list).getByText("缺失")).toBeInTheDocument();
  });

  it("shows localized empty states in the existing accessible regions", () => {
    render(
      <ProductionPage
        {...productionProps}
        consistencyReport={null}
        events={[]}
        workflowArtifacts={[]}
      />,
    );

    expect(screen.getByRole("region", { name: "制作进度" })).toHaveTextContent("暂无进行中的任务");
    expect(screen.getByRole("region", { name: "一致性检查" })).toHaveTextContent("暂无报告");
    expect(screen.getByRole("region", { name: "工作流产物" })).toHaveTextContent("暂无工作流产物");
  });

  it("preserves event and issue status details", () => {
    render(
      <ProductionPage
        {...productionProps}
        events={[event, completedEvent]}
        consistencyReport={{
          score: 45,
          issues: [{
            shot_id: "shot-1",
            severity: "error",
            code: "continuity",
            message: "Wardrobe changed",
          }],
        }}
      />,
    );

    const progress = screen.getByRole("region", { name: "制作进度" });
    expect(within(progress).getByText("成片已完成")).toBeInTheDocument();
    expect(within(progress).getByText("100%")).toBeInTheDocument();
    expect(within(progress).queryByText("Encoding final video")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "一致性检查" })).toHaveTextContent("45");
    const issue = screen.getByRole("listitem", { name: /错误 continuity/ });
    expect(issue).toHaveTextContent("Wardrobe changed");
    expect(issue).toHaveAttribute("data-severity", "error");
  });

  it("does not show a previous completed render while a new render is running", () => {
    const english = getStrings("en").production;
    render(
      <JobProgress
        events={[completedEvent]}
        rendering
        strings={english.jobProgress}
      />,
    );

    const progress = screen.getByRole("region", { name: "Production progress" });
    expect(within(progress).getByText("Preparing the production")).toBeInTheDocument();
    expect(within(progress).getByText("12%")).toBeInTheDocument();
    expect(within(progress).queryByText("Final video ready")).not.toBeInTheDocument();
  });

  it("does not treat a completed shot task as a completed composition", () => {
    const english = getStrings("en").production;
    render(
      <JobProgress
        events={[{
          ...completedEvent,
          job_id: "shot-batch",
          stage: "task_item",
        }]}
        strings={english.jobProgress}
      />,
    );

    const progress = screen.getByRole("region", { name: "Production progress" });
    expect(within(progress).getByText("No active jobs.")).toBeInTheDocument();
    expect(within(progress).getByText("0%")).toBeInTheDocument();
  });

  it("preserves issues that share backend identity without duplicate key warnings", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      render(
        <ConsistencyPanel
          report={{
            score: 60,
            issues: [
              {
                shot_id: "shot_001",
                severity: "warning",
                code: "missing_visual_lock",
                message: "First valid issue",
              },
              {
                shot_id: "shot_001",
                severity: "warning",
                code: "missing_visual_lock",
                message: "Second valid issue",
              },
            ],
          }}
        />,
      );

      expect(screen.getByText("First valid issue")).toBeInTheDocument();
      expect(screen.getByText("Second valid issue")).toBeInTheDocument();
      expect(
        consoleError.mock.calls.filter((call) =>
          call.some(
            (value) => typeof value === "string"
              && value.includes("Encountered two children with the same key"),
          ),
        ),
      ).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("passes typed owner strings through the localized child panels", () => {
    const english = getStrings("en").production;
    render(
      <>
        <JobProgress events={[]} strings={english.jobProgress} />
        <ConsistencyPanel report={{ score: 100, issues: [] }} strings={english.consistency} />
      </>,
    );

    expect(screen.getByRole("heading", { name: "Production progress" })).toBeInTheDocument();
    expect(screen.getByText("No active jobs.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Consistency check" })).toBeInTheDocument();
    expect(screen.getByText("No issues found")).toBeInTheDocument();
  });

  it("shows wallet recovery for payment-required render", async () => {
    const onRender = vi.fn().mockRejectedValue({
      code: "payment_required",
      required_units: 1_200_000,
      status: 402,
    });
    const onDownload = vi.fn().mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <ProductionPage
          {...productionProps}
          onDownload={onDownload}
          onRender={onRender}
          walletAvailableUnits={800_000}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: zh.renderAction }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("\u4f59\u989d\u4e0d\u8db3");
    expect(alert).toHaveTextContent("\u53ef\u7528\u4f59\u989d ¥0.80");
    expect(alert).toHaveTextContent("\u672c\u6b21\u6700\u591a\u9700\u8981 ¥1.20");
    expect(screen.getByRole("link", { name: "\u524d\u5f80\u94b1\u5305" })).toHaveAttribute("href", "/wallet");
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("clears transient render errors after retry succeeds", async () => {
    const onRender = vi.fn()
      .mockRejectedValueOnce(new Error("render failed once"))
      .mockResolvedValueOnce(undefined);
    const onDownload = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductionPage
        {...productionProps}
        onDownload={onDownload}
        onRender={onRender}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: zh.renderAction }));
    expect(await screen.findByRole("alert")).toHaveTextContent("render failed once");

    fireEvent.click(screen.getByRole("button", { name: zh.renderAction }));

    await waitFor(() => expect(onRender).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("does not chain a rejected render callback into download", async () => {
    const onRender = vi.fn().mockRejectedValue(new Error("render rejected"));
    const onDownload = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductionPage
        {...productionProps}
        onRender={onRender}
        onDownload={onDownload}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "生成最终成片" }));
    await waitFor(() => expect(onRender).toHaveBeenCalledTimes(1));
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("guards render immediately and releases the guard when the callback settles", async () => {
    const deferred = createDeferred();
    const onRender = vi.fn().mockReturnValue(deferred.promise);
    const onDownload = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductionPage
        {...productionProps}
        onRender={onRender}
        onDownload={onDownload}
      />,
    );
    const renderAction = screen.getByRole("button", { name: zh.renderAction });

    fireEvent.click(renderAction);
    fireEvent.click(renderAction);
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(onDownload).not.toHaveBeenCalled();

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });
    fireEvent.click(renderAction);
    expect(onRender).toHaveBeenCalledTimes(2);
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("guards download immediately and releases the guard when the callback settles", async () => {
    const deferred = createDeferred();
    const onRender = vi.fn().mockResolvedValue(undefined);
    const onDownload = vi.fn().mockReturnValue(deferred.promise);
    render(
      <ProductionPage
        {...productionProps}
        finalPath="renders/final.mp4"
        onRender={onRender}
        onDownload={onDownload}
      />,
    );
    const downloadAction = screen.getByRole("button", { name: zh.finalRender.downloadAction });

    fireEvent.click(downloadAction);
    fireEvent.click(downloadAction);
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onRender).not.toHaveBeenCalled();

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });
    fireEvent.click(downloadAction);
    expect(onDownload).toHaveBeenCalledTimes(2);
    expect(onRender).not.toHaveBeenCalled();
  });

  it("contains a synchronous render throw and releases the guard for retry", () => {
    const onRender = vi.fn(() => {
      throw new Error("synchronous render failure");
    });
    const onDownload = vi.fn().mockResolvedValue(undefined);
    render(
      <ProductionPage
        {...productionProps}
        onRender={onRender}
        onDownload={onDownload}
      />,
    );
    const renderAction = screen.getByRole("button", { name: zh.renderAction });

    expect(() => fireEvent.click(renderAction)).not.toThrow();
    expect(onRender).toHaveBeenCalledTimes(1);
    expect(onDownload).not.toHaveBeenCalled();
    expect(() => fireEvent.click(renderAction)).not.toThrow();
    expect(onRender).toHaveBeenCalledTimes(2);
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("contains a synchronous download throw and releases the guard for retry", () => {
    const onRender = vi.fn().mockResolvedValue(undefined);
    const onDownload = vi.fn(() => {
      throw new Error("synchronous download failure");
    });
    render(
      <ProductionPage
        {...productionProps}
        finalPath="renders/final.mp4"
        onRender={onRender}
        onDownload={onDownload}
      />,
    );
    const downloadAction = screen.getByRole("button", { name: zh.finalRender.downloadAction });

    expect(() => fireEvent.click(downloadAction)).not.toThrow();
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onRender).not.toHaveBeenCalled();
    expect(() => fireEvent.click(downloadAction)).not.toThrow();
    expect(onDownload).toHaveBeenCalledTimes(2);
    expect(onRender).not.toHaveBeenCalled();
  });
});
