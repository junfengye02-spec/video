import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  it("shows progress, workflow artifacts, consistency and final preview", () => {
    render(
      <ProductionPage
        {...productionProps}
        finalPath="local://media/final"
        finalRenderUrl="blob:final"
      />,
    );

    expect(screen.getByRole("heading", { name: "制作进度" })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "生成最终成片" }));
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
    const eventItems = within(progress).getAllByRole("listitem");
    expect(eventItems).toHaveLength(2);
    expect(eventItems[0]).toHaveTextContent("compose");
    expect(eventItems[0]).toHaveTextContent("running");
    expect(eventItems[0]).toHaveTextContent("Encoding final video");
    expect(eventItems[1]).toHaveTextContent("package");
    expect(eventItems[1]).toHaveTextContent("complete");
    expect(eventItems[1]).toHaveTextContent("Final video ready");
    expect(screen.getByRole("region", { name: "一致性检查" })).toHaveTextContent("45");
    const issue = screen.getByRole("listitem", { name: /错误 continuity/ });
    expect(issue).toHaveTextContent("Wardrobe changed");
    expect(issue).toHaveAttribute("data-severity", "error");
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
