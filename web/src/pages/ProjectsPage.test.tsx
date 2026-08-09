import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStrings } from "../i18n";
import {
  BackupWorkerProtocolError,
  BackupWorkerUnavailableError,
} from "../localdb/backupArchiveClient";
import { createProjectResponse } from "../test/fixtures";
import { chooseSelectMenuOption } from "../test/selectMenu";
import { ProjectsPage } from "./ProjectsPage";

const projectRepositoryMocks = vi.hoisted(() => ({
  projectRepository: {
    list: vi.fn(),
    delete: vi.fn(),
    exportBackup: vi.fn(),
    importBackup: vi.fn(),
    importBackupDirectory: vi.fn(),
  },
}));

const projectBackupMocks = vi.hoisted(() => {
  class ProjectImportConflictError extends Error {
    readonly projectId: string;

    constructor(projectId: string) {
      super(`Project ${projectId} already exists`);
      this.projectId = projectId;
    }
  }
  return {
    ProjectImportConflictError,
  };
});

const downloadMocks = vi.hoisted(() => ({
  downloadBlob: vi.fn(),
}));

vi.mock("../features/projects/ProjectRepository", () => projectRepositoryMocks);
vi.mock("../localdb/exportProject", () => projectBackupMocks);
vi.mock("../utils/downloadBlob", () => downloadMocks);

const summary = {
  id: "p1",
  title: "雨夜来信",
  updatedAt: "2026-07-10T08:00:00Z",
  shotCount: 8,
  hasFinalRender: false,
  cover: null,
};

const routerFuture = { v7_relativeSplatPath: true, v7_startTransition: true } as const;
const strings = getStrings("zh").projectsPage;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function LocationProbe() {
  return <output aria-label="当前路径">{useLocation().pathname}</output>;
}

async function projectAction(projectTitle: string, actionLabel: string) {
  fireEvent.click(await screen.findByRole("button", { name: `更多操作 ${projectTitle}` }));
  const menu = await screen.findByRole("menu", { name: `${projectTitle} 项目操作` });
  return within(menu).getByRole("menuitem", { name: actionLabel });
}

beforeEach(() => {
  projectRepositoryMocks.projectRepository.list.mockReset().mockResolvedValue([]);
  projectRepositoryMocks.projectRepository.delete.mockReset().mockResolvedValue(undefined);
  projectRepositoryMocks.projectRepository.exportBackup.mockReset();
  projectRepositoryMocks.projectRepository.importBackup.mockReset();
  projectRepositoryMocks.projectRepository.importBackupDirectory.mockReset();
  downloadMocks.downloadBlob.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ProjectsPage", () => {
  it("creates from the home composer with the selected creative preferences", async () => {
    const draft = createProjectResponse({ shotCount: 0 });
    const onCreateDraft = vi.fn().mockResolvedValue(draft);
    const onStarted = vi.fn();
    render(
      <MemoryRouter future={routerFuture}>
        <ProjectsPage onCreateDraft={onCreateDraft} onStarted={onStarted} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "让想法入镜" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "品牌叙事" }));
    fireEvent.click(screen.getByRole("button", { name: "创作设置" }));
    chooseSelectMenuOption("画幅", "9:16");
    chooseSelectMenuOption("项目类型", "短系列");
    fireEvent.change(screen.getByLabelText("项目标题"), { target: { value: "雨夜品牌片" } });
    fireEvent.change(screen.getByLabelText("你想做一支什么样的视频？"), {
      target: { value: "一只旧表见证两代人的和解" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始聊灵感" }));

    const initialMessage = "一只旧表见证两代人的和解\n\n创作偏好：品牌叙事，9:16 画幅。";
    await waitFor(() => expect(onCreateDraft).toHaveBeenCalledWith({
      title: "雨夜品牌片",
      project_type: "mini_series",
      prompt: initialMessage,
    }));
    expect(onStarted).toHaveBeenCalledWith(draft.project.id, initialMessage, "gpt-5.5");
  });

  it("filters project history without changing the underlying list", async () => {
    projectRepositoryMocks.projectRepository.list.mockResolvedValue([
      summary,
      { ...summary, id: "p2", title: "失重城市" },
    ]);
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    await screen.findByText("雨夜来信");
    fireEvent.change(screen.getByLabelText("搜索项目"), { target: { value: "失重" } });

    expect(screen.queryByText("雨夜来信")).not.toBeInTheDocument();
    expect(screen.getByText("失重城市")).toBeInTheDocument();
  });

  it("always exposes the extracted-directory backup action", () => {
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    const directoryInput = screen.getByLabelText("选择已解压备份");
    expect(directoryInput).toHaveAttribute("type", "file");
    expect(directoryInput).toHaveAttribute("multiple");
    expect(directoryInput).toHaveAttribute("webkitdirectory");
  });

  it("lists browser-local projects and opens the selected project", async () => {
    projectRepositoryMocks.projectRepository.list.mockResolvedValue([summary]);
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    expect(await screen.findByText("雨夜来信")).toBeInTheDocument();
    expect(screen.getByText("8 个分镜")).toBeInTheDocument();
    expect(screen.getByText("未生成成片")).toBeInTheDocument();
    expect(screen.getByText("雨夜来信").closest("li")).toHaveClass("project-item");
    expect(screen.getByRole("link", { name: "打开 雨夜来信" })).toHaveAttribute(
      "href",
      "/projects/p1/storyboard",
    );
  });

  it("requires confirmation before deleting a local project", async () => {
    projectRepositoryMocks.projectRepository.list.mockResolvedValue([summary]);
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    fireEvent.click(await projectAction("雨夜来信", "删除 雨夜来信"));
    expect(screen.getByRole("dialog", { name: "删除项目" })).toBeInTheDocument();
    expect(projectRepositoryMocks.projectRepository.delete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(projectRepositoryMocks.projectRepository.delete).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.queryByText("雨夜来信")).not.toBeInTheDocument());
  });

  it("closes delete confirmation from Escape or cancel without deleting", async () => {
    projectRepositoryMocks.projectRepository.list.mockResolvedValue([summary]);
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    const opener = await screen.findByRole("button", { name: "更多操作 雨夜来信" });
    fireEvent.click(await projectAction("雨夜来信", "删除 雨夜来信"));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "删除项目" }), { key: "Escape" });

    expect(projectRepositoryMocks.projectRepository.delete).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "删除项目" })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());

    fireEvent.click(await projectAction("雨夜来信", "删除 雨夜来信"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(projectRepositoryMocks.projectRepository.delete).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "删除项目" })).not.toBeInTheDocument();
  });

  it("uses a stable-width async action for project deletion", async () => {
    projectRepositoryMocks.projectRepository.list.mockResolvedValue([summary]);
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    fireEvent.click(await projectAction("雨夜来信", "删除 雨夜来信"));

    expect(screen.getByRole("button", { name: "确认删除" })).toHaveClass("async-action");
  });

  it("exports the selected project as an omproj backup", async () => {
    const blob = new Blob(["backup"], { type: "application/zip" });
    projectRepositoryMocks.projectRepository.list.mockResolvedValue([summary]);
    projectRepositoryMocks.projectRepository.exportBackup.mockResolvedValue(blob);
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    fireEvent.click(await projectAction("雨夜来信", "导出 雨夜来信"));

    await waitFor(() => expect(downloadMocks.downloadBlob).toHaveBeenCalledWith(
      blob,
      "雨夜来信.omproj",
    ));
    expect(projectRepositoryMocks.projectRepository.exportBackup).toHaveBeenCalledWith("p1");
    expect(projectRepositoryMocks.projectRepository.exportBackup.mock.invocationCallOrder[0]).toBeLessThan(
      downloadMocks.downloadBlob.mock.invocationCallOrder[0],
    );
  });

  it("guards repeated export clicks before the pending state renders", async () => {
    const pending = deferred<Blob>();
    const project = { ...summary, title: "Project One" };
    projectRepositoryMocks.projectRepository.list.mockResolvedValue([project]);
    projectRepositoryMocks.projectRepository.exportBackup.mockReturnValue(pending.promise);
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);
    const exportButton = await projectAction(project.title, strings.exportProject(project.title));

    act(() => {
      exportButton.click();
      exportButton.click();
    });

    expect(projectRepositoryMocks.projectRepository.exportBackup).toHaveBeenCalledTimes(1);
  });

  it("tracks two overlapping project exports independently", async () => {
    const first = deferred<Blob>();
    const second = deferred<Blob>();
    const firstProject = { ...summary, title: "Project One" };
    const secondProject = { ...summary, id: "p2", title: "Project Two" };
    projectRepositoryMocks.projectRepository.list.mockResolvedValue([firstProject, secondProject]);
    projectRepositoryMocks.projectRepository.exportBackup.mockImplementation((projectId: string) => (
      projectId === firstProject.id ? first.promise : second.promise
    ));
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);
    fireEvent.click(await projectAction(firstProject.title, strings.exportProject(firstProject.title)));
    fireEvent.click(await projectAction(secondProject.title, strings.exportProject(secondProject.title)));

    let secondButton = await projectAction(secondProject.title, strings.exportProject(secondProject.title));
    expect(secondButton).toBeDisabled();

    await act(async () => second.resolve(new Blob(["second"])));
    await waitFor(() => expect(secondButton).toBeEnabled());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    const firstButton = await projectAction(firstProject.title, strings.exportProject(firstProject.title));
    expect(firstButton).toBeDisabled();

    await act(async () => first.resolve(new Blob(["first"])));
    await waitFor(() => expect(firstButton).toBeEnabled());
  });

  it("imports a backup before navigating to its storyboard", async () => {
    const file = new File(["backup"], "project.omproj", { type: "application/zip" });
    projectRepositoryMocks.projectRepository.importBackup.mockResolvedValue(createProjectResponse());
    render(
      <MemoryRouter future={routerFuture} initialEntries={["/projects"]}>
        <ProjectsPage />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("导入项目"), { target: { files: [file] } });

    await waitFor(() => expect(projectRepositoryMocks.projectRepository.importBackup).toHaveBeenCalledWith(
      file,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }),
    ));
    expect(await screen.findByRole("status", { name: "当前路径" })).toHaveTextContent(
      "/projects/p1/storyboard",
    );
  });

  it("does not overwrite a conflicting import when confirmation is cancelled", async () => {
    const file = new File(["backup"], "project.omproj", { type: "application/zip" });
    projectRepositoryMocks.projectRepository.list.mockResolvedValue([summary]);
    projectRepositoryMocks.projectRepository.importBackup.mockRejectedValue(
      new projectBackupMocks.ProjectImportConflictError("p1"),
    );
    render(
      <MemoryRouter future={routerFuture} initialEntries={["/projects"]}>
        <ProjectsPage />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(strings.importAction), { target: { files: [file] } });
    expect(await screen.findByRole("dialog", { name: "\u8986\u76d6\u73b0\u6709\u9879\u76ee" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: strings.cancelAction }));

    expect(projectRepositoryMocks.projectRepository.importBackup).toHaveBeenCalledTimes(1);
    expect(projectRepositoryMocks.projectRepository.importBackup).toHaveBeenCalledWith(
      file,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("/projects");
  });

  it("overwrites a conflicting import only after explicit confirmation", async () => {
    const file = new File(["backup"], "project.omproj", { type: "application/zip" });
    projectRepositoryMocks.projectRepository.list.mockResolvedValue([summary]);
    projectRepositoryMocks.projectRepository.importBackup
      .mockRejectedValueOnce(new projectBackupMocks.ProjectImportConflictError("p1"))
      .mockResolvedValueOnce(createProjectResponse());
    render(
      <MemoryRouter future={routerFuture} initialEntries={["/projects"]}>
        <ProjectsPage />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(strings.importAction), { target: { files: [file] } });
    await screen.findByRole("dialog", { name: "\u8986\u76d6\u73b0\u6709\u9879\u76ee" });
    fireEvent.click(screen.getByRole("button", { name: "\u786e\u8ba4\u8986\u76d6" }));

    await waitFor(() => expect(projectRepositoryMocks.projectRepository.importBackup).toHaveBeenLastCalledWith(
      file,
      expect.objectContaining({
        overwrite: true,
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }),
    ));
    expect(projectRepositoryMocks.projectRepository.importBackup).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "/projects/p1/storyboard",
    );
  });

  it("retries a conflicting directory import through the directory facade", async () => {
    const files = [
      new File(["project"], "openmontage-project.json", { type: "application/json" }),
      new File(["media"], "clip.mp4", { type: "video/mp4" }),
    ];
    projectRepositoryMocks.projectRepository.list.mockResolvedValue([summary]);
    projectRepositoryMocks.projectRepository.importBackupDirectory
      .mockRejectedValueOnce(new projectBackupMocks.ProjectImportConflictError("p1"))
      .mockResolvedValueOnce(createProjectResponse());
    render(
      <MemoryRouter future={routerFuture} initialEntries={["/projects"]}>
        <ProjectsPage />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("选择已解压备份"), { target: { files } });
    await screen.findByRole("dialog", { name: "覆盖现有项目" });
    fireEvent.click(screen.getByRole("button", { name: "确认覆盖" }));

    await waitFor(() => expect(projectRepositoryMocks.projectRepository.importBackupDirectory)
      .toHaveBeenLastCalledWith(
        files,
        expect.objectContaining({
          overwrite: true,
          signal: expect.any(AbortSignal),
          onProgress: expect.any(Function),
        }),
      ));
    expect(projectRepositoryMocks.projectRepository.importBackup).not.toHaveBeenCalled();
    expect(await screen.findByRole("status", { name: "当前路径" })).toHaveTextContent(
      "/projects/p1/storyboard",
    );
  });

  it("keeps the project list and route unchanged when directory validation fails", async () => {
    const files = [new File(["broken"], "openmontage-project.json")];
    projectRepositoryMocks.projectRepository.list.mockResolvedValue([summary]);
    projectRepositoryMocks.projectRepository.importBackupDirectory.mockRejectedValue(
      new Error("备份目录不完整，请重新选择。"),
    );
    render(
      <MemoryRouter future={routerFuture} initialEntries={["/projects"]}>
        <ProjectsPage />
        <LocationProbe />
      </MemoryRouter>,
    );

    await screen.findByText(summary.title);
    fireEvent.change(screen.getByLabelText("选择已解压备份"), { target: { files } });

    expect(await screen.findByRole("alert")).toHaveTextContent("备份目录不完整，请重新选择。");
    expect(screen.getByText(summary.title)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "当前路径" })).toHaveTextContent("/projects");
    expect(projectRepositoryMocks.projectRepository.importBackup).not.toHaveBeenCalled();
  });

  it("promotes the directory action only when the module Worker is unavailable", async () => {
    const file = new File(["backup"], "project.omproj", { type: "application/zip" });
    projectRepositoryMocks.projectRepository.importBackup.mockRejectedValue(
      new BackupWorkerUnavailableError("Backup module Worker is unavailable"),
    );
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    fireEvent.change(screen.getByLabelText(strings.importAction), { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "当前浏览器无法读取压缩备份，请选择已解压备份文件夹。",
    );
    expect(screen.getByText("选择已解压备份").closest("label"))
      .toHaveClass("primary-import-action");
  });

  it("keeps protocol failures distinct from Worker unavailability", async () => {
    const file = new File(["backup"], "project.omproj", { type: "application/zip" });
    projectRepositoryMocks.projectRepository.importBackup.mockRejectedValue(
      new BackupWorkerProtocolError("备份读取协议异常，请重试。"),
    );
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    fireEvent.change(screen.getByLabelText(strings.importAction), { target: { files: [file] } });

    expect(await screen.findByRole("alert")).toHaveTextContent("备份读取协议异常，请重试。");
    expect(screen.getByRole("alert")).not.toHaveTextContent("请选择已解压备份文件夹");
    expect(screen.getByText("选择已解压备份").closest("label"))
      .not.toHaveClass("primary-import-action");
  });

  it("shows byte and entry progress and cancels the active import without failure", async () => {
    const file = new File(["backup"], "project.omproj", { type: "application/zip" });
    projectRepositoryMocks.projectRepository.importBackup.mockImplementation((
      _file: File,
      options: { signal: AbortSignal; onProgress: (progress: unknown) => void },
    ) => new Promise((_resolve, reject) => {
      options.onProgress({ bytesRead: 64, totalBytes: 128, entriesRead: 1, totalEntries: 3 });
      options.signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      }, { once: true });
    }));
    render(
      <MemoryRouter future={routerFuture} initialEntries={["/projects"]}>
        <ProjectsPage />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText(strings.importAction), { target: { files: [file] } });

    expect(await screen.findByText("64 / 128 字节，1 / 3 个条目")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消导入" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "取消导入" }))
      .not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "当前路径" })).toHaveTextContent("/projects");
  });

  it("shows loading and load failure states", async () => {
    let rejectLoad: (reason: unknown) => void = () => undefined;
    projectRepositoryMocks.projectRepository.list.mockReturnValue(new Promise((_, reject) => {
      rejectLoad = reject;
    }));
    render(<MemoryRouter future={routerFuture}><ProjectsPage /></MemoryRouter>);

    expect(screen.getByText("正在加载本地项目...")).toBeInTheDocument();
    rejectLoad(new Error("读取项目失败"));

    expect(await screen.findByRole("alert")).toHaveTextContent("读取项目失败");
  });
});
