import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
        events={[event]}
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
    expect(progress).toHaveTextContent("compose");
    expect(progress).toHaveTextContent("running");
    expect(progress).toHaveTextContent("Encoding final video");
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
});
