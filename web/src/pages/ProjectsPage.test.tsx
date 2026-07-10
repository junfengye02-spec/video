import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectResponse } from "../test/fixtures";
import { ProjectsPage } from "./ProjectsPage";

const projectStoreMocks = vi.hoisted(() => ({
  listProjectSummaries: vi.fn(),
  deleteProject: vi.fn(),
}));

const projectBackupMocks = vi.hoisted(() => ({
  exportProjectBackup: vi.fn(),
  importProjectBackup: vi.fn(),
}));

const downloadMocks = vi.hoisted(() => ({
  downloadBlob: vi.fn(),
}));

vi.mock("../localdb/projectStore", () => projectStoreMocks);
vi.mock("../localdb/exportProject", () => projectBackupMocks);
vi.mock("../utils/downloadBlob", () => downloadMocks);

const summary = {
  id: "p1",
  title: "雨夜来信",
  updatedAt: "2026-07-10T08:00:00Z",
  shotCount: 8,
  hasFinalRender: false,
};

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const;

function LocationProbe() {
  return <output aria-label="当前路径">{useLocation().pathname}</output>;
}

beforeEach(() => {
  projectStoreMocks.listProjectSummaries.mockReset().mockResolvedValue([]);
  projectStoreMocks.deleteProject.mockReset().mockResolvedValue(undefined);
  projectBackupMocks.exportProjectBackup.mockReset();
  projectBackupMocks.importProjectBackup.mockReset();
  downloadMocks.downloadBlob.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ProjectsPage", () => {
  it("lists browser-local projects and opens the selected project", async () => {
    projectStoreMocks.listProjectSummaries.mockResolvedValue([summary]);
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    expect(await screen.findByText("雨夜来信")).toBeInTheDocument();
    expect(screen.getByText("8 个分镜")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开 雨夜来信" })).toHaveAttribute(
      "href",
      "/projects/p1/storyboard",
    );
  });

  it("requires confirmation before deleting a local project", async () => {
    projectStoreMocks.listProjectSummaries.mockResolvedValue([summary]);
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "删除 雨夜来信" }));
    expect(screen.getByRole("dialog", { name: "删除项目" })).toBeInTheDocument();
    expect(projectStoreMocks.deleteProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(projectStoreMocks.deleteProject).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.queryByText("雨夜来信")).not.toBeInTheDocument());
  });

  it("closes delete confirmation without deleting", async () => {
    projectStoreMocks.listProjectSummaries.mockResolvedValue([summary]);
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "删除 雨夜来信" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(projectStoreMocks.deleteProject).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "删除项目" })).not.toBeInTheDocument();
  });

  it("exports the selected project as an omproj backup", async () => {
    const blob = new Blob(["backup"], { type: "application/zip" });
    projectStoreMocks.listProjectSummaries.mockResolvedValue([summary]);
    projectBackupMocks.exportProjectBackup.mockResolvedValue(blob);
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: "导出 雨夜来信" }));

    await waitFor(() => expect(downloadMocks.downloadBlob).toHaveBeenCalledWith(
      blob,
      "雨夜来信.omproj",
    ));
    expect(projectBackupMocks.exportProjectBackup).toHaveBeenCalledWith("p1");
    expect(projectBackupMocks.exportProjectBackup.mock.invocationCallOrder[0]).toBeLessThan(
      downloadMocks.downloadBlob.mock.invocationCallOrder[0],
    );
  });

  it("imports a backup before navigating to its storyboard", async () => {
    const file = new File(["backup"], "project.omproj", { type: "application/zip" });
    projectBackupMocks.importProjectBackup.mockResolvedValue(createProjectResponse());
    render(
      <MemoryRouter future={routerFuture} initialEntries={["/projects"]}>
        <ProjectsPage />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("导入项目"), { target: { files: [file] } });

    await waitFor(() => expect(projectBackupMocks.importProjectBackup).toHaveBeenCalledWith(file));
    expect(await screen.findByRole("status", { name: "当前路径" })).toHaveTextContent(
      "/projects/p1/storyboard",
    );
  });

  it("shows loading and load failure states", async () => {
    let rejectLoad: (reason: unknown) => void = () => undefined;
    projectStoreMocks.listProjectSummaries.mockReturnValue(new Promise((_, reject) => {
      rejectLoad = reject;
    }));
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    expect(screen.getByText("正在加载本地项目...")).toBeInTheDocument();
    rejectLoad(new Error("读取项目失败"));

    expect(await screen.findByRole("alert")).toHaveTextContent("读取项目失败");
  });
});
