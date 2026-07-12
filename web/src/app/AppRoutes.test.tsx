import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { ShortDramaProjectResponse } from "../domain/types";
import { getStrings } from "../i18n";
import { createProjectResponse } from "../test/fixtures";

const apiMocks = vi.hoisted(() => ({
  authRequest: vi.fn(),
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
  saveShot: vi.fn(),
  subscribeProjectEvents: vi.fn(),
  uploadReferenceImage: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  value: {
    user: { id: "user-1", email: "user@example.com", role: "user" } as null | {
      id: string;
      email: string;
      role: "user" | "admin";
    },
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    sendVerification: vi.fn(),
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
  },
}));

const billingMocks = vi.hoisted(() => ({
  value: {
    wallet: { balance_units: 1000, held_units: 0, available_units: 1000 },
    loading: false,
    error: null,
    refreshWallet: vi.fn(),
  },
}));

const localProjectStoreMocks = vi.hoisted(() => ({
  deleteProject: vi.fn(),
  listProjectSummaries: vi.fn(),
  loadProjectSnapshot: vi.fn(),
  loadRecentProjectSnapshot: vi.fn(),
  saveProjectSnapshot: vi.fn(),
  saveProjectSnapshotIfVersion: vi.fn(),
  setRecentProjectId: vi.fn(),
}));

const localMediaStoreMocks = vi.hoisted(() => ({
  cacheRemoteMedia: vi.fn(),
  findCommittedMedia: vi.fn(),
  loadMediaBlob: vi.fn(),
  saveMediaBlob: vi.fn(),
  startMediaRecoveryController: vi.fn(),
}));

const localExportMocks = vi.hoisted(() => ({
  exportProjectBackup: vi.fn(),
  importProjectBackup: vi.fn(),
  importProjectBackupDirectory: vi.fn(),
  prepareProjectBackupDirectoryImport: vi.fn(),
  prepareProjectBackupImport: vi.fn(),
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
vi.mock("../features/generation/GenerationService", () => ({
  generationService: {
    optimize: vi.fn((projectId: string, shotId: string, sourceText: string) => (
      apiMocks.optimizePrompt(projectId, {
        target: "shot",
        target_id: shotId,
        source_text: sourceText,
        mode: "shot_json",
      })
    )),
    saveShot: vi.fn((projectId: string, shotId: string, payload: unknown) => (
      apiMocks.saveShot(projectId, shotId, payload)
    )),
    regenerate: vi.fn((projectId: string, shotId: string) => (
      apiMocks.regenerateShot(projectId, shotId, {})
    )),
    render: vi.fn((projectId: string) => (
      apiMocks.renderProject(projectId, { render_runtime: "ffmpeg" })
    )),
    subscribe: vi.fn((projectId: string, onEvent: (event: unknown) => void) => (
      apiMocks.subscribeProjectEvents(projectId, onEvent)
    )),
  },
}));
vi.mock("../auth/AuthProvider", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMocks.value,
}));
vi.mock("../billing/BillingProvider", () => ({
  BillingProvider: ({ children }: { children: ReactNode }) => children,
  useBilling: () => billingMocks.value,
}));
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

function commitTextEdit(element: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setValue) throw new Error("HTMLTextAreaElement value setter is unavailable");

  flushSync(() => {
    setValue.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function enterProviderCredentials() {
  await Promise.resolve();
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
    authMocks.value = {
      user: { id: "user-1", email: "user@example.com", role: "user" },
      loading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      sendVerification: vi.fn(),
      requestPasswordReset: vi.fn(),
      resetPassword: vi.fn(),
    };
    billingMocks.value = {
      wallet: { balance_units: 1000, held_units: 0, available_units: 1000 },
      loading: false,
      error: null,
      refreshWallet: vi.fn(),
    };
    apiMocks.authRequest.mockResolvedValue(undefined);
    apiMocks.createShortDramaProject.mockResolvedValue(cloneProjectResponse(projectWithEightShots));
    apiMocks.subscribeProjectEvents.mockReturnValue(vi.fn());
    localProjectStoreMocks.listProjectSummaries.mockResolvedValue([]);
    localProjectStoreMocks.loadRecentProjectSnapshot.mockResolvedValue(null);
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue(null);
    let storageRevision = 0;
    localProjectStoreMocks.saveProjectSnapshot.mockImplementation((next: ShortDramaProjectResponse) => Promise.resolve({
      id: next.project.id,
      title: next.project.title,
      updatedAt: "2026-07-11T08:00:00Z",
      incarnation: "incarnation-routes",
      revision: ++storageRevision,
      snapshot: structuredClone(next),
    }));
    localProjectStoreMocks.saveProjectSnapshotIfVersion.mockImplementation(
      (next: ShortDramaProjectResponse, expected: { incarnation: string; revision: number }) => {
        if (
          expected.incarnation !== "incarnation-routes"
          || expected.revision !== storageRevision
        ) return Promise.resolve(null);
        return Promise.resolve({
          id: next.project.id,
          title: next.project.title,
          updatedAt: "2026-07-11T08:00:00Z",
          incarnation: expected.incarnation,
          revision: ++storageRevision,
          snapshot: structuredClone(next),
        });
      },
    );
    localProjectStoreMocks.setRecentProjectId.mockResolvedValue(undefined);
    localStorageEstimateMocks.getStorageEstimate.mockResolvedValue({
      usageBytes: 0,
      quotaBytes: 0,
      persisted: false,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue(null);
    localMediaStoreMocks.findCommittedMedia.mockResolvedValue(null);
    localMediaStoreMocks.startMediaRecoveryController.mockReturnValue({
      dispose: vi.fn(),
      run: vi.fn().mockResolvedValue(0),
    });
    localMediaUrlMocks.resolveLocalMediaUrl.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
  });

  it.each([
    "/projects",
    "/projects/p1/storyboard",
    "/projects/p1/settings",
    "/projects/p1/resources",
    "/projects/p1/production",
    "/wallet",
    "/orders",
    "/admin/billing?tab=orders#latest",
  ])("redirects anonymous deep links from %s to login with return state", async (path) => {
    authMocks.value = { ...authMocks.value, user: null };

    renderAppAt(path);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
    const from = window.history.state?.usr?.from as {
      hash?: string;
      pathname?: string;
      search?: string;
    } | undefined;
    expect(`${from?.pathname ?? ""}${from?.search ?? ""}${from?.hash ?? ""}`).toBe(path);
  });

  it.each([
    ["/wallet", zh.billing.walletTitle],
    ["/orders", zh.billing.ordersTitle],
  ])("allows authenticated users to access %s", async (path, heading) => {
    renderAppAt(path);

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "账单管理" })).not.toBeInTheDocument();
  });

  it("blocks authenticated non-admin users from billing administration", async () => {
    renderAppAt("/admin/billing");

    expect(await screen.findByRole("heading", { name: "Not authorized" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /计费管理|璁¤垂绠＄悊/ })).not.toBeInTheDocument();
  });

  it("allows administrators to access billing administration", async () => {
    authMocks.value = {
      ...authMocks.value,
      user: { id: "admin-1", email: "admin@example.com", role: "admin" },
    };

    renderAppAt("/admin/billing");

    expect(await screen.findByRole("heading", { name: /计费管理|璁¤垂绠＄悊/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "账单管理" })).toHaveAttribute("href", "/admin/billing");
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

  it("renders exact non-blocking local backup status without exposing internal refs", async () => {
    expect(zh.localBackup).toEqual({
      saving: "\u6b63\u5728\u4fdd\u5b58\u5230\u672c\u673a",
      retrying: "\u672c\u673a\u5907\u4efd\u7a0d\u540e\u91cd\u8bd5",
    });
    const cache = deferred<string | null>();
    const current = cloneProjectResponse();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/status-shot.mp4",
      output_url: null,
    };
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: current.project.title,
      updatedAt: "2026-07-11T08:00:00Z",
      snapshot: current,
    });
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "status-shot",
      event: {
        id: "status-shot",
        job_id: "status-shot",
        project_id: "p1",
        stage: "regenerate",
        status: "complete",
        message: "complete",
        created_at: "2026-07-11T08:00:00Z",
      },
      shot: regeneratedShot,
      storyboard: { ...current.storyboard, shots: [regeneratedShot, ...current.storyboard.shots.slice(1)] },
      consistency_report: current.consistency_report,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockReturnValue(cache.promise);
    const rendered = renderAppAt("/projects/p1/storyboard");
    await screen.findByLabelText(zh.shotEditor.promptLabel);
    await enterProviderCredentials();

    fireEvent.click(screen.getByRole("button", { name: zh.shotEditor.regenerateAction }));

    expect(await screen.findByText(zh.localBackup.saving, { selector: "[role='status']" }))
      .toHaveAttribute("role", "status");
    expect(rendered.container.innerHTML).not.toContain("local://media/");
    cache.resolve(null);
    expect(await screen.findByText(zh.localBackup.retrying, { selector: "[role='status']" }))
      .toHaveAttribute("role", "status");
  });

  it("keeps final preview and download usable without exposing a promoted local ref", async () => {
    const cache = deferred<string | null>();
    const current = cloneProjectResponse();
    const renderReport = {
      version: "1.0" as const,
      outputs: [{
        path: "renders/final-visible.mp4",
        format: "mp4",
        resolution: "720x1280",
        duration_seconds: 25,
      }],
    };
    const remoteSnapshot = cloneProjectResponse(current);
    remoteSnapshot.render_report = renderReport;
    remoteSnapshot.final_path = "renders/final-visible.mp4";
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: current.project.title,
      updatedAt: "2026-07-11T08:00:00Z",
      incarnation: "incarnation-routes",
      revision: 1,
      snapshot: current,
    });
    apiMocks.renderProject.mockResolvedValue({
      job_id: "render-visible",
      event: {
        id: "render-visible",
        job_id: "render-visible",
        project_id: "p1",
        stage: "render",
        status: "complete",
        message: "complete",
        created_at: "2026-07-11T08:00:00Z",
      },
      project: current.project,
      storyboard: current.storyboard,
      consistency_report: current.consistency_report,
      render_report: renderReport,
      final_path: "renders/final-visible.mp4",
    });
    apiMocks.loadProject.mockResolvedValue(remoteSnapshot);
    localMediaStoreMocks.cacheRemoteMedia.mockReturnValue(cache.promise);
    localMediaUrlMocks.resolveLocalMediaUrl.mockImplementation((ref: string) => (
      Promise.resolve(ref === "local://media/final-visible" ? "blob:final-visible" : null)
    ));
    const rendered = renderAppAt("/projects/p1/production");
    await screen.findByRole("button", { name: zh.production.renderAction });
    await enterProviderCredentials();

    fireEvent.click(screen.getByRole("button", { name: zh.production.renderAction }));
    await waitFor(() => expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledTimes(1));
    cache.resolve("local://media/final-visible");

    await waitFor(() => expect(screen.getByLabelText(zh.production.finalRender.previewLabel))
      .toHaveAttribute("src", "blob:final-visible"));
    expect(screen.getByRole("button", { name: zh.production.finalRender.downloadAction }))
      .toBeEnabled();
    expect(rendered.container.textContent).not.toContain("local://media/");
    expect(rendered.container.innerHTML).not.toContain("local://media/");
    for (const element of rendered.container.querySelectorAll("[aria-label]")) {
      expect(element.getAttribute("aria-label")).not.toContain("local://media/");
    }
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

    expect(await screen.findAllByText("Project Two")).not.toHaveLength(0);
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
    expect(await screen.findAllByText("Project Two")).not.toHaveLength(0);
  });

  it("guards dirty storyboard navigation immediately after the edit commits", async () => {
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "Rain Alley",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: cloneProjectResponse(),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderAppAt("/projects/p1/storyboard");
    const prompt = await screen.findByLabelText<HTMLTextAreaElement>(zh.shotEditor.promptLabel);
    const resourcesLink = screen.getByRole("link", { name: zh.resources.title });
    const unload = new Event("beforeunload", { cancelable: true });
    act(() => {
      commitTextEdit(prompt, "\u672a\u4fdd\u5b58\u5206\u955c\u8349\u7a3f");
      window.dispatchEvent(unload);
      resourcesLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });

    expect(unload.defaultPrevented).toBe(true);
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

  it.each([
    {
      label: "backend-relative",
      reference: "assets/images/character/reference.png",
      resolved: "/api/projects/p1/media/assets/images/character/reference.png",
    },
    {
      label: "browser-local",
      reference: "local://media/reference-image",
      resolved: "blob:reference-image",
    },
  ])("resolves and deduplicates $label asset references for grid and detail UI", async ({
    reference,
    resolved,
  }) => {
    const snapshot = cloneProjectResponse();
    snapshot.series_bible.assets = [{
      id: "asset-reference",
      kind: "character",
      label: "Reference asset",
      description: "A saved character reference",
      prompt: "Character reference",
      reference_images: [reference],
      media_urls: [reference],
      shot_ids: [],
      version: 1,
    }];
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "Rain Alley",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot,
    });
    localMediaUrlMocks.resolveLocalMediaUrl.mockImplementation((value: string) => (
      Promise.resolve(value === reference ? resolved : null)
    ));

    renderAppAt("/projects/p1/resources");

    const opener = await screen.findByRole("button", {
      name: zh.resources.viewAsset("Reference asset"),
    });
    await waitFor(() => expect(opener.querySelector("img")).toHaveAttribute("src", resolved));
    fireEvent.click(opener);

    const detail = screen.getByRole("dialog", { name: zh.resources.detailDialogTitle });
    const detailImages = Array.from(detail.querySelectorAll("img"));
    expect(detailImages).toHaveLength(1);
    expect(detailImages[0]).toHaveAttribute("src", resolved);
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
    });
    expect(apiMocks.createShortDramaProject.mock.calls[0]?.[0]).not.toHaveProperty("shot_count");
    expect(window.location.pathname).toBe("/projects/p1/storyboard");
  });
});
