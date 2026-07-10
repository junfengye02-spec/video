import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { ShortDramaProjectResponse } from "../domain/types";
import { getStrings } from "../i18n";
import { createProjectResponse } from "../test/fixtures";

const apiMocks = vi.hoisted(() => ({
  createDraftProject: vi.fn(),
  createShortDramaProject: vi.fn(),
  loadLatestProject: vi.fn(),
  loadProject: vi.fn(),
  mediaUrl: vi.fn((path: string | null | undefined, projectId?: string | null) => {
    if (!path) return null;
    return path.startsWith("/api/") || !projectId
      ? path
      : `/api/projects/${projectId}/media/${path}`;
  }),
  optimizePrompt: vi.fn(),
  regenerateShot: vi.fn(),
  renderProject: vi.fn(),
  saveContinuityPlan: vi.fn(),
  saveGatewayKey: vi.fn(),
  saveShot: vi.fn(),
  subscribeProjectEvents: vi.fn(),
  uploadReferenceImage: vi.fn(),
}));

const localProjectStoreMocks = vi.hoisted(() => ({
  deleteProject: vi.fn(),
  listProjectSummaries: vi.fn(),
  loadProjectSnapshot: vi.fn(),
  loadRecentProjectSnapshot: vi.fn(),
  saveProjectSnapshot: vi.fn(),
  setRecentProjectId: vi.fn(),
}));

const localMediaStoreMocks = vi.hoisted(() => ({
  cacheRemoteMedia: vi.fn(),
  loadMediaBlob: vi.fn(),
  saveMediaBlob: vi.fn(),
}));

const localExportMocks = vi.hoisted(() => ({
  exportProjectBackup: vi.fn(),
  importProjectBackup: vi.fn(),
}));

const localStorageEstimateMocks = vi.hoisted(() => ({
  formatBytes: vi.fn((bytes: number | null) => (bytes === null ? "Unknown" : `${bytes} B`)),
  getStorageEstimate: vi.fn(),
}));

const localMediaUrlMocks = vi.hoisted(() => ({
  resolveLocalMediaUrl: vi.fn(),
  revokeLocalMediaUrls: vi.fn(),
}));

vi.mock("../api/client", () => apiMocks);
vi.mock("../localdb/projectStore", () => localProjectStoreMocks);
vi.mock("../localdb/mediaStore", () => localMediaStoreMocks);
vi.mock("../localdb/mediaUrls", () => localMediaUrlMocks);
vi.mock("../localdb/exportProject", () => localExportMocks);
vi.mock("../localdb/storageEstimate", () => localStorageEstimateMocks);

const projectWithEightShots = createProjectResponse({ shotCount: 8 });
const zh = getStrings("zh");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function cloneProjectResponse(
  value: ShortDramaProjectResponse = createProjectResponse(),
): ShortDramaProjectResponse {
  return structuredClone(value);
}

function renderAppAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<App />);
}

async function enterProviderCredentials() {
  fireEvent.click(screen.getByRole("button", { name: "\u63a5\u53e3\u914d\u7f6e" }));
  fireEvent.change(screen.getByLabelText(zh.keyGate.textKeyLabel), { target: { value: "text-test-key" } });
  fireEvent.change(screen.getByLabelText(zh.keyGate.imageKeyLabel), { target: { value: "image-test-key" } });
  fireEvent.change(screen.getByLabelText(zh.keyGate.videoKeyLabel), { target: { value: "video-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: zh.keyGate.useKeysAction }));
  await waitFor(() => expect(apiMocks.saveGatewayKey).toHaveBeenCalledTimes(1));
}

function submitNewProject() {
  fireEvent.change(screen.getByLabelText("\u9879\u76ee\u6807\u9898"), { target: { value: "\u96e8\u591c\u6765\u4fe1" } });
  fireEvent.change(screen.getByLabelText("\u6545\u4e8b\u4e0e\u753b\u9762\u8981\u6c42"), {
    target: { value: "\u4e00\u5c01\u4fe1\u6539\u53d8\u4e24\u4e2a\u4eba\u7684\u547d\u8fd0" },
  });
  fireEvent.click(screen.getByRole("button", { name: "AI \u89c4\u5212\u5206\u955c" }));
}

describe("App routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window.navigator, "language", {
      configurable: true,
      value: "zh-CN",
    });
    apiMocks.saveGatewayKey.mockResolvedValue({
      masked_keys: { text: "***text", image: "***image", video: "***video" },
      provider: "syapi",
      base_url: "https://example.invalid",
      models: { text: "text-model", image: "image-model", video: "video-model" },
      valid: true,
    });
    apiMocks.createShortDramaProject.mockResolvedValue(cloneProjectResponse(projectWithEightShots));
    apiMocks.subscribeProjectEvents.mockReturnValue(vi.fn());
    localProjectStoreMocks.listProjectSummaries.mockResolvedValue([]);
    localProjectStoreMocks.loadRecentProjectSnapshot.mockResolvedValue(null);
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue(null);
    localProjectStoreMocks.saveProjectSnapshot.mockResolvedValue(undefined);
    localProjectStoreMocks.setRecentProjectId.mockResolvedValue(undefined);
    localStorageEstimateMocks.getStorageEstimate.mockResolvedValue({
      usageBytes: 0,
      quotaBytes: 0,
      persisted: false,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue(null);
    localMediaUrlMocks.resolveLocalMediaUrl.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
  });

  it("restores the project named by a deep link from browser-local storage", async () => {
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "\u96e8\u591c\u6765\u4fe1",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: cloneProjectResponse(),
    });

    renderAppAt("/projects/p1/resources");

    await waitFor(() => expect(localProjectStoreMocks.loadProjectSnapshot).toHaveBeenCalledWith("p1"));
    expect(apiMocks.loadLatestProject).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "\u8d44\u6e90\u5e93" })).toBeInTheDocument();
  });

  it("keeps the newest project when rapid deep-link loads resolve out of order", async () => {
    const firstLoad = deferred<Awaited<ReturnType<typeof localProjectStoreMocks.loadProjectSnapshot>>>();
    const firstProject = cloneProjectResponse();
    firstProject.project = { ...firstProject.project, id: "p1", title: "Project One" };
    const secondProject = cloneProjectResponse();
    secondProject.project = { ...secondProject.project, id: "p2", title: "Project Two" };
    localProjectStoreMocks.loadProjectSnapshot.mockImplementation((projectId: string) => {
      if (projectId === "p1") return firstLoad.promise;
      return Promise.resolve({
        id: "p2",
        title: "Project Two",
        updatedAt: "2026-07-10T09:00:00Z",
        snapshot: secondProject,
      });
    });

    renderAppAt("/projects/p1/storyboard");
    await waitFor(() => expect(localProjectStoreMocks.loadProjectSnapshot).toHaveBeenCalledWith("p1"));

    window.history.pushState({}, "", "/projects/p2/storyboard");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(await screen.findByText("Project Two")).toBeInTheDocument();
    firstLoad.resolve({
      id: "p1",
      title: "Project One",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: firstProject,
    });

    await waitFor(() => expect(localProjectStoreMocks.setRecentProjectId).toHaveBeenCalledWith("p2"));
    expect(screen.queryByText("Project One")).not.toBeInTheDocument();
  });

  it.each(["/projects", "/projects/new"])(
    "cancels a pending deep-link load when navigation leaves for %s",
    async (destination) => {
      const pendingLoad = deferred<Awaited<ReturnType<typeof localProjectStoreMocks.loadProjectSnapshot>>>();
      const staleProject = cloneProjectResponse();
      staleProject.final_path = "local://media/stale-final";
      localProjectStoreMocks.loadProjectSnapshot.mockReturnValue(pendingLoad.promise);

      renderAppAt("/projects/p1/storyboard");
      await waitFor(() => expect(localProjectStoreMocks.loadProjectSnapshot).toHaveBeenCalledWith("p1"));

      act(() => {
        window.history.pushState({}, "", destination);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      if (destination === "/projects") {
        expect(await screen.findByRole("heading", { name: zh.projectsPage.title })).toBeInTheDocument();
      } else {
        expect(await screen.findByRole("heading", { name: zh.newProjectPage.title })).toBeInTheDocument();
      }

      await act(async () => {
        pendingLoad.resolve({
          id: "p1",
          title: "Stale project",
          updatedAt: "2026-07-10T08:00:00Z",
          snapshot: staleProject,
        });
        await pendingLoad.promise;
      });

      expect(localProjectStoreMocks.setRecentProjectId).not.toHaveBeenCalledWith("p1");
      expect(apiMocks.subscribeProjectEvents).not.toHaveBeenCalledWith("p1", expect.any(Function));
      expect(localMediaUrlMocks.resolveLocalMediaUrl).not.toHaveBeenCalledWith("local://media/stale-final");
    },
  );

  it("cleans up project event subscriptions when the active project changes and unmounts", async () => {
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    apiMocks.subscribeProjectEvents
      .mockReturnValueOnce(firstCleanup)
      .mockReturnValueOnce(secondCleanup);
    const firstProject = cloneProjectResponse();
    const secondProject = cloneProjectResponse();
    secondProject.project = { ...secondProject.project, id: "p2", title: "Project Two" };
    localProjectStoreMocks.loadProjectSnapshot.mockImplementation((projectId: string) => Promise.resolve({
      id: projectId,
      title: projectId === "p1" ? "Project One" : "Project Two",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: projectId === "p1" ? firstProject : secondProject,
    }));

    const rendered = renderAppAt("/projects/p1/storyboard");
    await waitFor(() => expect(apiMocks.subscribeProjectEvents).toHaveBeenCalledWith("p1", expect.any(Function)));

    window.history.pushState({}, "", "/projects/p2/storyboard");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await waitFor(() => expect(apiMocks.subscribeProjectEvents).toHaveBeenCalledWith("p2", expect.any(Function)));
    expect(firstCleanup).toHaveBeenCalledTimes(1);

    rendered.unmount();
    expect(secondCleanup).toHaveBeenCalledTimes(1);
  });

  it("revokes local media object URLs when the active project changes and unmounts", async () => {
    const firstProject = cloneProjectResponse();
    firstProject.final_path = "local://media/final-p1";
    const secondProject = cloneProjectResponse();
    secondProject.project = { ...secondProject.project, id: "p2", title: "Project Two" };
    localProjectStoreMocks.loadProjectSnapshot.mockImplementation((projectId: string) => Promise.resolve({
      id: projectId,
      title: projectId === "p1" ? "Project One" : "Project Two",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: projectId === "p1" ? firstProject : secondProject,
    }));

    const rendered = renderAppAt("/projects/p1/storyboard");
    await waitFor(() => expect(localMediaUrlMocks.resolveLocalMediaUrl).toHaveBeenCalledWith("local://media/final-p1"));

    window.history.pushState({}, "", "/projects/p2/storyboard");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await waitFor(() => expect(localMediaUrlMocks.revokeLocalMediaUrls).toHaveBeenCalledTimes(1));
    rendered.unmount();
    expect(localMediaUrlMocks.revokeLocalMediaUrls).toHaveBeenCalledTimes(2);
  });

  it("shows a recoverable state for an unknown local project", async () => {
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue(null);

    renderAppAt("/projects/missing/storyboard");

    expect(await screen.findByText("\u6b64\u9879\u76ee\u4e0d\u5728\u5f53\u524d\u6d4f\u89c8\u5668\u4e2d")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "\u8fd4\u56de\u9879\u76ee\u5217\u8868" })).toHaveAttribute("href", "/projects");
  });

  it("shows a storage error instead of missing-project copy when local loading rejects", async () => {
    localProjectStoreMocks.loadProjectSnapshot.mockRejectedValue(new Error("browser storage failed"));

    renderAppAt("/projects/p1/storyboard");

    expect(await screen.findByRole("alert")).toHaveTextContent("browser storage failed");
    expect(screen.queryByText("\u6b64\u9879\u76ee\u4e0d\u5728\u5f53\u524d\u6d4f\u89c8\u5668\u4e2d")).not.toBeInTheDocument();
  });

  it("does not flash the previous missing state while loading a new project ID", async () => {
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValueOnce(null);
    renderAppAt("/projects/missing/storyboard");
    expect(await screen.findByText("\u6b64\u9879\u76ee\u4e0d\u5728\u5f53\u524d\u6d4f\u89c8\u5668\u4e2d")).toBeInTheDocument();

    const nextLoad = deferred<Awaited<ReturnType<typeof localProjectStoreMocks.loadProjectSnapshot>>>();
    localProjectStoreMocks.loadProjectSnapshot.mockReturnValueOnce(nextLoad.promise);
    act(() => {
      window.history.pushState({}, "", "/projects/p2/storyboard");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.queryByText("\u6b64\u9879\u76ee\u4e0d\u5728\u5f53\u524d\u6d4f\u89c8\u5668\u4e2d")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("\u6b63\u5728\u52a0\u8f7d\u5f53\u524d\u6d4f\u89c8\u5668\u4e2d\u7684\u9879\u76ee");

    const nextProject = cloneProjectResponse();
    nextProject.project = { ...nextProject.project, id: "p2", title: "Project Two" };
    nextLoad.resolve({
      id: "p2",
      title: "Project Two",
      updatedAt: "2026-07-10T09:00:00Z",
      snapshot: nextProject,
    });
    expect(await screen.findByText("Project Two")).toBeInTheDocument();
  });

  it("guards dirty storyboard navigation and preserves the draft when cancelled", async () => {
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "Rain Alley",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: cloneProjectResponse(),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderAppAt("/projects/p1/storyboard");
    const prompt = await screen.findByLabelText(zh.shotEditor.promptLabel);
    fireEvent.change(prompt, { target: { value: "\u672a\u4fdd\u5b58\u5206\u955c\u8349\u7a3f" } });

    fireEvent.click(screen.getByRole("link", { name: zh.resources.title }));

    expect(confirm).toHaveBeenCalledWith(zh.storyboardPage.discardChangesConfirm);
    expect(window.location.pathname).toBe("/projects/p1/storyboard");
    expect(screen.getByLabelText(zh.shotEditor.promptLabel)).toHaveValue("\u672a\u4fdd\u5b58\u5206\u955c\u8349\u7a3f");

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("link", { name: zh.resources.title }));
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1/resources"));
  });

  it("guards dirty global settings navigation and preserves the draft when cancelled", async () => {
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "Rain Alley",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: cloneProjectResponse(),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderAppAt("/projects/p1/settings");
    const worldview = await screen.findByLabelText(zh.continuity.worldview);
    fireEvent.change(worldview, { target: { value: "\u672a\u4fdd\u5b58\u5168\u5c40\u8bbe\u5b9a" } });

    fireEvent.click(screen.getByRole("link", { name: "OpenMontage" }));

    expect(confirm).toHaveBeenCalledWith(zh.storyboardPage.discardChangesConfirm);
    expect(window.location.pathname).toBe("/projects/p1/settings");
    expect(screen.getByLabelText(zh.continuity.worldview)).toHaveValue("\u672a\u4fdd\u5b58\u5168\u5c40\u8bbe\u5b9a");

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("link", { name: "OpenMontage" }));
    await waitFor(() => expect(window.location.pathname).toBe("/projects"));
  });

  it("guards a dirty storyboard from browser history navigation", async () => {
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "Rain Alley",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: cloneProjectResponse(),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderAppAt("/projects/p1/settings");
    await screen.findByLabelText(zh.continuity.worldview);
    fireEvent.click(screen.getByRole("link", { name: "分镜编辑" }));
    const prompt = await screen.findByLabelText(zh.shotEditor.promptLabel);
    fireEvent.change(prompt, { target: { value: "未保存的历史导航草稿" } });

    act(() => window.history.back());

    await waitFor(() => expect(confirm).toHaveBeenCalledWith(zh.storyboardPage.discardChangesConfirm));
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1/storyboard"));
    expect(screen.getByLabelText(zh.shotEditor.promptLabel)).toHaveValue("未保存的历史导航草稿");

    confirm.mockReturnValue(true);
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1/settings"));
  });

  it("guards a dirty global settings draft from history and browser unload", async () => {
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "Rain Alley",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: cloneProjectResponse(),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderAppAt("/projects/p1/storyboard");
    await screen.findByLabelText(zh.shotEditor.promptLabel);
    fireEvent.click(screen.getByRole("link", { name: "全局设定" }));
    const worldview = await screen.findByLabelText(zh.continuity.worldview);
    fireEvent.change(worldview, { target: { value: "未保存的历史全局设定" } });

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    act(() => window.history.back());

    await waitFor(() => expect(confirm).toHaveBeenCalledWith(zh.storyboardPage.discardChangesConfirm));
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1/settings"));
    expect(screen.getByLabelText(zh.continuity.worldview)).toHaveValue("未保存的历史全局设定");

    confirm.mockReturnValue(true);
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1/storyboard"));
  });

  it("binds unique asset IDs and lets a rejected save reach the resource page", async () => {
    const snapshot = cloneProjectResponse();
    snapshot.storyboard.shots[0].asset_ids = ["existing-asset", "existing-asset"];
    snapshot.series_bible.assets = [{
      id: "asset-reference",
      kind: "character",
      label: "Reference asset",
      description: "A saved character reference",
      prompt: "Character reference",
      reference_images: [],
      media_urls: [],
      shot_ids: [],
      version: 1,
    }];
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "\u96e8\u591c\u6765\u4fe1",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot,
    });
    apiMocks.saveShot.mockRejectedValue(new Error("binding rejected"));

    renderAppAt("/projects/p1/resources");
    fireEvent.click(await screen.findByRole("button", {
      name: zh.resources.viewAsset("Reference asset"),
    }));
    fireEvent.click(screen.getByRole("button", { name: zh.resources.bindAction }));

    await waitFor(() => expect(apiMocks.saveShot).toHaveBeenCalledWith("p1", "shot-1", {
      asset_ids: ["existing-asset", "asset-reference"],
    }));
    expect((await screen.findAllByRole("alert")).some((alert) => (
      alert.textContent?.includes("binding rejected")
    ))).toBe(true);
  });

  it("routes a created project to its storyboard and reports the AI shot count", async () => {
    renderAppAt("/projects/new");

    await enterProviderCredentials();
    submitNewProject();

    expect(await screen.findByText("AI \u5df2\u4e3a\u4f60\u89c4\u5212 8 \u4e2a\u5206\u955c")).toBeInTheDocument();
    expect(apiMocks.createShortDramaProject).toHaveBeenCalledWith({
      title: "\u96e8\u591c\u6765\u4fe1",
      prompt: "\u4e00\u5c01\u4fe1\u6539\u53d8\u4e24\u4e2a\u4eba\u7684\u547d\u8fd0",
      project_type: "single_video",
      text_key: "text-test-key",
      image_key: "image-test-key",
      video_key: "video-test-key",
      base_url: "https://example.invalid",
      text_model: "text-model",
      image_model: "image-model",
      video_model: "video-model",
    });
    expect(apiMocks.createShortDramaProject.mock.calls[0]?.[0]).not.toHaveProperty("shot_count");
    expect(window.location.pathname).toBe("/projects/p1/storyboard");
  });
});
