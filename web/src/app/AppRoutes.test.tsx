import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { buildInitialIdea } from "../components/projects/ProjectComposer";
import type { ShortDramaProjectResponse } from "../domain/types";
import { getStrings } from "../i18n";
import { createProjectResponse } from "../test/fixtures";

const apiMocks = vi.hoisted(() => ({
  authRequest: vi.fn(),
  createDraftProject: vi.fn(),
  createShortDramaProject: vi.fn(),
  developInspiration: vi.fn(),
  updateInspirationIntent: vi.fn(),
  approveStoryboard: vi.fn(),
  beginStoryboardRevision: vi.fn(),
  cancelStoryboardRevision: vi.fn(),
  loadLatestProject: vi.fn(),
  loadProject: vi.fn(),
  planStoryboard: vi.fn(),
  mediaUrl: vi.fn((path: string | null | undefined, projectId?: string | null) => {
    if (!path) return null;
    return path.startsWith("/api/") || !projectId
      ? path
      : `/api/projects/${projectId}/media/${path}`;
  }),
  optimizePrompt: vi.fn(),
  regenerateShot: vi.fn(),
  renderProject: vi.fn(),
  reviseCreativePlan: vi.fn(),
  saveContinuityPlan: vi.fn(),
  saveShot: vi.fn(),
  subscribeProjectEvents: vi.fn(),
  updatePlanSection: vi.fn(),
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
    listModels: vi.fn(async (capability: "text" | "image" | "video") => ({
      capability,
      models: capability === "text"
        ? ["gpt-5.5"]
        : capability === "image"
          ? ["gpt-image-2"]
          : ["omni_flash-10s"],
    })),
    listAssets: vi.fn(async () => ({ assets: [], next_cursor: null })),
    generateImages: vi.fn(),
    listTasks: vi.fn(async () => ({ tasks: [] })),
    retryTaskItem: vi.fn(),
    addAssetToProject: vi.fn(),
    reviseCreativePlan: vi.fn((projectId: string, payload: unknown) => (
      apiMocks.reviseCreativePlan(projectId, payload)
    )),
    optimize: vi.fn((projectId: string, shotId: string, sourceText: string) => (
      apiMocks.optimizePrompt(projectId, {
        target: "shot",
        target_id: shotId,
        source_text: sourceText,
        mode: "shot_json",
      })
    )),
    optimizeImagePrompt: vi.fn(),
    saveShot: vi.fn((projectId: string, shotId: string, payload: unknown) => (
      apiMocks.saveShot(projectId, shotId, payload)
    )),
    regenerate: vi.fn((projectId: string, shotId: string) => (
      apiMocks.regenerateShot(projectId, shotId, {})
    )),
    saveContinuity: vi.fn((projectId: string, plan: unknown) => (
      apiMocks.saveContinuityPlan(projectId, plan)
    )),
    uploadReference: vi.fn((projectId: string, payload: unknown) => (
      apiMocks.uploadReferenceImage(projectId, payload)
    )),
    prepareRender: vi.fn(async (projectId: string) => ({
      project_id: projectId,
      shot_summary: { total: 1, reusable: 0, to_generate: 1, completed: 0 },
      estimated_units: 500,
      available_units: 1_000,
      estimate_status: "ready",
      output: {
        format: "mp4",
        resolution: "720x1280",
        aspect_ratio: "9:16",
        duration_seconds: 25,
        render_runtime: "ffmpeg",
      },
      continuity: { characters: 1, locations: 1, props: 1, bound_assets: 0 },
      active_job: null,
    })),
    render: vi.fn((projectId: string) => (
      apiMocks.renderProject(projectId, { render_runtime: "ffmpeg" })
    )),
    compose: vi.fn((projectId: string) => (
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
vi.mock("../features/projects/ProjectRepository", () => ({
  projectRepository: {
    list: localProjectStoreMocks.listProjectSummaries,
    open: vi.fn(async (projectId: string) => {
      const record = await localProjectStoreMocks.loadProjectSnapshot(projectId);
      if (!record) return null;
      return {
        snapshot: record.snapshot,
        freshness: "fresh",
        writable: true,
        version: {
          incarnation: record.incarnation ?? `legacy:${record.id}`,
          revision: record.revision ?? 0,
        },
      };
    }),
    create: vi.fn(async (input: unknown) => {
      const snapshot = await apiMocks.createShortDramaProject(input);
      await localProjectStoreMocks.saveProjectSnapshot({ ...snapshot, final_path: null });
      return snapshot;
    }),
    createDraft: vi.fn(async (input: unknown) => {
      const snapshot = await apiMocks.createDraftProject(input);
      await localProjectStoreMocks.saveProjectSnapshot({ ...snapshot, final_path: null });
      return snapshot;
    }),
    developInspiration: vi.fn(async (projectId: string, input: unknown) => (
      apiMocks.developInspiration(projectId, input)
    )),
    updateInspirationIntent: vi.fn(async (projectId: string, input: unknown) => (
      apiMocks.updateInspirationIntent(projectId, input)
    )),
    planStoryboard: vi.fn(async (projectId: string, input: unknown) => (
      apiMocks.planStoryboard(projectId, input)
    )),
    approveStoryboard: vi.fn(async (projectId: string) => (
      apiMocks.approveStoryboard(projectId)
    )),
    beginStoryboardRevision: vi.fn(async (projectId: string) => (
      apiMocks.beginStoryboardRevision(projectId)
    )),
    cancelStoryboardRevision: vi.fn(async (projectId: string) => (
      apiMocks.cancelStoryboardRevision(projectId)
    )),
    updatePlanSection: vi.fn(async (projectId: string, section: string, input: unknown) => (
      apiMocks.updatePlanSection(projectId, section, input)
    )),
    refresh: vi.fn(async (projectId: string) => apiMocks.loadProject(projectId)),
    save: vi.fn(async (snapshot: ShortDramaProjectResponse) => {
      const record = await localProjectStoreMocks.saveProjectSnapshot(snapshot);
      return record ? {
        incarnation: record.incarnation ?? `legacy:${record.id}`,
        revision: record.revision ?? 0,
      } : null;
    }),
    saveIfVersion: vi.fn(async (snapshot: ShortDramaProjectResponse, expectedVersion: unknown) => {
      const record = await localProjectStoreMocks.saveProjectSnapshotIfVersion(
        snapshot,
        expectedVersion,
      );
      return record ? {
        incarnation: record.incarnation ?? `legacy:${record.id}`,
        revision: record.revision ?? 0,
      } : null;
    }),
    markRecent: localProjectStoreMocks.setRecentProjectId,
    importBackup: localExportMocks.importProjectBackup,
    importBackupDirectory: localExportMocks.importProjectBackupDirectory,
    exportBackup: localExportMocks.exportProjectBackup,
    delete: localProjectStoreMocks.deleteProject,
  },
}));
vi.mock("../platform/storage/MediaRepository", () => ({
  mediaRepository: {
    cacheRemote: localMediaStoreMocks.cacheRemoteMedia,
    findCommitted: localMediaStoreMocks.findCommittedMedia,
    load: localMediaStoreMocks.loadMediaBlob,
    resolve: localMediaUrlMocks.resolveLocalMediaUrl,
    remoteUrl: apiMocks.mediaUrl,
    startRecovery: localMediaStoreMocks.startMediaRecoveryController,
    revokeProject: vi.fn(() => localMediaUrlMocks.revokeLocalMediaUrls()),
    revokeAll: localMediaUrlMocks.revokeLocalMediaUrls,
    deleteProject: localProjectStoreMocks.deleteProject,
    estimate: localStorageEstimateMocks.getStorageEstimate,
  },
}));

const projectWithEightShots = createProjectResponse({ shotCount: 8 });
const planSectionIds = ["worldview", "characters", "scenes", "props", "sound", "storyboard"] as const;
const zh = getStrings("zh");
const initialProjectIdea = buildInitialIdea(
  "\u4e00\u5c01\u4fe1\u6539\u53d8\u4e24\u4e2a\u4eba\u7684\u547d\u8fd0",
  "story",
  "16:9",
);

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
  fireEvent.click(screen.getByRole("button", { name: "创作设置" }));
  fireEvent.change(screen.getByLabelText("\u9879\u76ee\u6807\u9898"), { target: { value: "\u96e8\u591c\u6765\u4fe1" } });
  fireEvent.change(screen.getByLabelText("\u4f60\u60f3\u505a\u4e00\u652f\u4ec0\u4e48\u6837\u7684\u89c6\u9891\uff1f"), {
    target: { value: "\u4e00\u5c01\u4fe1\u6539\u53d8\u4e24\u4e2a\u4eba\u7684\u547d\u8fd0" },
  });
  fireEvent.click(screen.getByRole("button", { name: "\u5f00\u59cb\u804a\u7075\u611f" }));
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
    "/admin/video-models?query=video#catalog",
  ])("redirects anonymous deep links from %s to login with return state", async (path) => {
    authMocks.value = { ...authMocks.value, user: null };

    renderAppAt(path);

    expect(await screen.findByRole("heading", { name: "欢迎回来" })).toBeInTheDocument();
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

  it("blocks authenticated non-admin users from video model administration", async () => {
    renderAppAt("/admin/video-models");

    expect(await screen.findByRole("heading", { name: "Not authorized" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "视频模型时长" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "模型管理" })).not.toBeInTheDocument();
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

  it("allows administrators to access video model administration", async () => {
    authMocks.value = {
      ...authMocks.value,
      user: { id: "admin-1", email: "admin@example.com", role: "admin" },
    };

    renderAppAt("/admin/video-models");

    expect(await screen.findByRole("heading", { name: "视频模型时长" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "模型管理" }))
      .toHaveAttribute("href", "/admin/video-models");
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

  it("starts with inspiration and blocks the resource library before plan approval", async () => {
    const draft = cloneProjectResponse();
    draft.storyboard = { shots: [] };
    draft.series_bible = { ...draft.series_bible, assets: [] };
    draft.creative_workflow = {
      phase: "inspiration",
      messages: [],
      brief: null,
      ready_to_confirm: false,
      planned_asset_ids: [],
      approved_at: null,
    };
    apiMocks.createDraftProject.mockResolvedValue(draft);
    const developed = cloneProjectResponse(draft);
    developed.creative_workflow = {
      ...draft.creative_workflow,
      messages: [
        { role: "user", content: "\u4e00\u5c01\u4fe1\u6539\u53d8\u4e24\u4e2a\u4eba\u7684\u547d\u8fd0" },
        { role: "assistant", content: "\u8fd9\u652f\u89c6\u9891\u60f3\u505a\u7ed9\u8c01\u770b\uff1f" },
      ],
    };
    apiMocks.developInspiration.mockResolvedValue(developed);

    renderAppAt("/projects/new");
    submitNewProject();

    expect(await screen.findByRole("heading", { name: "\u7075\u611f\u5bf9\u8bdd" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/projects/p1/idea");
    expect(screen.queryByRole("link", { name: "\u8d44\u6e90\u5e93" })).not.toBeInTheDocument();
    await waitFor(() => expect(apiMocks.developInspiration).toHaveBeenCalledWith("p1", {
      messages: [{ role: "user", content: initialProjectIdea }],
      text_model: "gpt-5.5",
    }));
    expect(apiMocks.developInspiration).toHaveBeenCalledTimes(1);
  });

  it.each(["storyboard", "resources", "production"])(
    "redirects an incompletely approved blueprint away from the %s deep link",
    async (route) => {
      const snapshot = cloneProjectResponse();
      snapshot.creative_workflow = {
        phase: "plan_review",
        messages: [],
        brief: null,
        ready_to_confirm: true,
        planned_asset_ids: [],
        approved_at: null,
        plan_sections: Object.fromEntries(planSectionIds.map((section) => [section, {
          status: section === "worldview" ? "pending" : "approved",
          revision: 2,
          feedback: null,
          updated_at: section === "worldview" ? null : "2026-07-16T02:00:00Z",
        }])) as NonNullable<ShortDramaProjectResponse["creative_workflow"]>["plan_sections"],
      };
      localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
        id: "p1",
        title: snapshot.project.title,
        updatedAt: "2026-07-16T02:00:00Z",
        snapshot,
      });

      renderAppAt(`/projects/p1/${route}`);

      expect(await screen.findByRole("heading", { name: "创作蓝图" })).toBeInTheDocument();
      expect(window.location.pathname).toBe("/projects/p1/plan-review");
      expect(screen.queryByRole("button", { name: /生成图片|生成视频|重新生成镜头|渲染|render/i })).not.toBeInTheDocument();
      expect(apiMocks.renderProject).not.toHaveBeenCalled();
    },
  );

  it("opens an explicit storyboard revision route and cancels back to the approved storyboard", async () => {
    const revision = cloneProjectResponse();
    revision.continuity_plan!.generation_preferences!.video_model = "sora_v2";
    revision.creative_workflow = {
      phase: "plan_review",
      messages: [],
      brief: null,
      ready_to_confirm: true,
      planned_asset_ids: [],
      approved_at: null,
      revision_session: {
        section: "storyboard",
        source: "generation_plan_duration",
        started_at: "2026-07-26T02:00:00Z",
        original_approved_at: "2026-07-26T01:00:00Z",
        section_revision: 3,
      },
      plan_sections: Object.fromEntries(planSectionIds.map((section) => [section, {
        status: section === "storyboard" ? "changes_requested" : "approved",
        revision: section === "storyboard" ? 3 : 2,
        feedback: section === "storyboard" ? "减少或合并分镜" : null,
        updated_at: "2026-07-26T02:00:00Z",
      }])) as NonNullable<ShortDramaProjectResponse["creative_workflow"]>["plan_sections"],
    };
    const canceled = cloneProjectResponse(revision);
    canceled.creative_workflow = {
      ...revision.creative_workflow,
      phase: "approved",
      approved_at: "2026-07-26T01:00:00Z",
      revision_session: null,
      plan_sections: {
        ...revision.creative_workflow.plan_sections!,
        storyboard: {
          status: "approved",
          revision: 4,
          feedback: null,
          updated_at: "2026-07-26T02:01:00Z",
        },
      },
    };
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: revision.project.title,
      updatedAt: "2026-07-26T02:00:00Z",
      snapshot: revision,
    });
    apiMocks.cancelStoryboardRevision.mockResolvedValue(canceled);

    renderAppAt("/projects/p1/storyboard/revision");

    expect(await screen.findByRole("region", { name: "分镜规划文档" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消修订并返回分镜" }));

    await waitFor(() => expect(apiMocks.cancelStoryboardRevision).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(window.location.pathname).toBe("/projects/p1/storyboard"));
    expect(canceled.continuity_plan!.generation_preferences!.video_model).toBe("sora_v2");
  });

  it("persists section feedback before invoking the text-only revise contract", async () => {
    const original = cloneProjectResponse();
    original.creative_workflow = {
      phase: "plan_review",
      messages: [],
      brief: null,
      ready_to_confirm: true,
      planned_asset_ids: [],
      approved_at: null,
      plan_sections: Object.fromEntries(planSectionIds.map((section) => [section, {
        status: "pending",
        revision: 1,
        feedback: null,
        updated_at: null,
      }])) as NonNullable<ShortDramaProjectResponse["creative_workflow"]>["plan_sections"],
    };
    const requested = cloneProjectResponse(original);
    requested.creative_workflow!.plan_sections!.worldview = {
      status: "changes_requested",
      revision: 2,
      feedback: "限制故事发生在一个雨夜",
      updated_at: "2026-07-16T03:00:00Z",
    };
    const revised = cloneProjectResponse(requested);
    revised.series_bible.worldview = "故事只发生在一个连续雨夜";
    if (revised.continuity_plan) {
      revised.continuity_plan.series_bible.worldview = "故事只发生在一个连续雨夜";
    }
    revised.creative_workflow!.plan_sections!.worldview = {
      status: "pending",
      revision: 3,
      feedback: "限制故事发生在一个雨夜",
      updated_at: "2026-07-16T03:01:00Z",
    };
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: original.project.title,
      updatedAt: "2026-07-16T02:00:00Z",
      snapshot: original,
    });
    apiMocks.updatePlanSection.mockResolvedValue(requested);
    apiMocks.reviseCreativePlan.mockResolvedValue(revised);

    renderAppAt("/projects/p1/plan-review");
    const feedbackOpener = await screen.findByRole("button", { name: "要求修改" });
    fireEvent.click(feedbackOpener);
    const feedbackDrawer = screen.getByRole("dialog", { name: /修改反馈 · 世界观/ });
    const feedback = within(feedbackDrawer).getByRole("textbox", { name: "修改反馈" });
    fireEvent.change(feedback, { target: { value: "限制故事发生在一个雨夜" } });
    fireEvent.click(within(feedbackDrawer).getByRole("button", { name: "提交修改" }));

    await waitFor(() => expect(apiMocks.updatePlanSection).toHaveBeenCalledWith("p1", "worldview", {
      status: "changes_requested",
      feedback: "限制故事发生在一个雨夜",
      revision: 1,
    }));
    await waitFor(() => expect(apiMocks.reviseCreativePlan).toHaveBeenCalledWith("p1", {
      sections: ["worldview"],
      feedback: "限制故事发生在一个雨夜",
    }));
    expect(await screen.findByText("故事只发生在一个连续雨夜")).toBeInTheDocument();
    expect(feedback).toHaveValue("限制故事发生在一个雨夜");
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
    const confirmation = await screen.findByRole("dialog", {
      name: zh.production.confirmation.title,
    });
    fireEvent.click(within(confirmation).getByRole("button", {
      name: zh.production.confirmation.confirmAction,
    }));
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
      expect(await screen.findByRole("heading", { name: "让想法入镜" })).toBeInTheDocument();

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

    fireEvent.click(screen.getByRole("link", { name: "mise studio" }));

    expect(confirm).toHaveBeenCalledWith(zh.storyboardPage.discardChangesConfirm);
    expect(window.location.pathname).toBe("/projects/p1/settings");
    expect(screen.getByLabelText(zh.continuity.worldview)).toHaveValue("\u672a\u4fdd\u5b58\u5168\u5c40\u8bbe\u5b9a");

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("link", { name: "mise studio" }));
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
    fireEvent.click(screen.getByRole("link", { name: "分镜" }));
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

  it("runs inspiration, plan review and approval before opening the storyboard", async () => {
    const draft = cloneProjectResponse();
    draft.storyboard.shots = [];
    draft.creative_workflow = {
      phase: "inspiration",
      messages: [],
      brief: null,
      ready_to_confirm: false,
      planned_asset_ids: [],
      approved_at: null,
    };
    const developed = cloneProjectResponse(draft);
    developed.creative_workflow = {
      ...draft.creative_workflow,
      messages: [
        { role: "user", content: "\u4e00\u5c01\u4fe1\u6539\u53d8\u4e24\u4e2a\u4eba\u7684\u547d\u8fd0" },
        { role: "assistant", content: "\u65b9\u5411\u5df2\u7ecf\u6e05\u695a\u3002" },
      ],
      brief: {
        title: "\u96e8\u591c\u6765\u4fe1",
        logline: "\u4e00\u5c01\u4fe1\u6539\u53d8\u4e24\u4e2a\u4eba\u7684\u547d\u8fd0",
        audience: "\u60ac\u7591\u77ed\u7247\u89c2\u4f17",
        format: "\u7ad6\u5c4f\u77ed\u7247",
        duration_seconds: 60,
        aspect_ratio: "9:16",
        genre: "\u60ac\u7591",
        tone: "\u7d27\u5f20",
        visual_style: "\u96e8\u591c\u9713\u8679\u5199\u5b9e",
        story_outline: "\u6765\u4fe1\u3001\u6000\u7591\u3001\u9a8c\u8bc1\u3002",
        must_have: ["\u4fe1"],
        open_questions: [],
      },
      ready_to_confirm: true,
    };
    const planned = cloneProjectResponse(projectWithEightShots);
    planned.creative_workflow = {
      ...developed.creative_workflow,
      phase: "plan_review",
      planned_asset_ids: [],
      plan_sections: Object.fromEntries(planSectionIds.map((section) => [section, {
        status: "pending",
        revision: 1,
        feedback: null,
        updated_at: null,
      }])) as NonNullable<ShortDramaProjectResponse["creative_workflow"]>["plan_sections"],
    };
    let serverSnapshot = cloneProjectResponse(planned);
    apiMocks.createDraftProject.mockResolvedValue(draft);
    apiMocks.developInspiration.mockResolvedValue(developed);
    apiMocks.planStoryboard.mockResolvedValue(planned);
    apiMocks.updatePlanSection.mockImplementation((projectId: string, section: typeof planSectionIds[number]) => {
      const next = cloneProjectResponse(serverSnapshot);
      const approval = next.creative_workflow?.plan_sections?.[section];
      if (approval) {
        next.creative_workflow!.plan_sections![section] = {
          ...approval,
          status: "approved",
          revision: approval.revision + 1,
          updated_at: "2026-07-15T00:00:00Z",
        };
      }
      serverSnapshot = next;
      return Promise.resolve(next);
    });
    apiMocks.approveStoryboard.mockImplementation(() => {
      const approved = cloneProjectResponse(serverSnapshot);
      approved.creative_workflow = {
        ...approved.creative_workflow!,
        phase: "approved",
        approved_at: "2026-07-15T01:00:00Z",
      };
      serverSnapshot = approved;
      return Promise.resolve(approved);
    });

    renderAppAt("/projects/new");

    submitNewProject();

    expect(await screen.findByText("\u521b\u610f\u610f\u56fe\u5df2\u5177\u5907\u89c4\u5212\u6761\u4ef6")).toBeInTheDocument();
    expect(apiMocks.planStoryboard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "\u786e\u8ba4\u521b\u610f\u5e76\u5f00\u59cb\u89c4\u5212" }));

    expect(await screen.findByRole("heading", { name: "创作蓝图" })).toBeInTheDocument();
    expect(apiMocks.createDraftProject).toHaveBeenCalledWith({
      title: "\u96e8\u591c\u6765\u4fe1",
      prompt: initialProjectIdea,
      project_type: "single_video",
    });
    expect(apiMocks.planStoryboard).toHaveBeenCalledWith("p1", {
      control_end_frames: false,
      project_type: "single_video",
      prompt: expect.stringContaining("Title: \u96e8\u591c\u6765\u4fe1"),
      text_model: "gpt-5.5",
    });

    const sectionNames = ["世界观与视觉规则", "人物设定", "场景设定", "关键道具", "声音与配乐", "分镜规划"];
    for (const [index, sectionName] of sectionNames.entries()) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(sectionName) }));
      fireEvent.click(screen.getByRole("button", { name: "确认此部分" }));
      await waitFor(() => expect(apiMocks.updatePlanSection).toHaveBeenCalledTimes(index + 1));
    }

    fireEvent.click(screen.getByRole("button", { name: "全部确认，进入分镜" }));
    const finalDialog = screen.getByRole("dialog", { name: "确认最终蓝图" });
    fireEvent.click(within(finalDialog).getByRole("button", { name: "确认并进入分镜" }));

    expect((await screen.findAllByText(zh.storyboardPage.shotListLabel)).length).toBeGreaterThan(0);
    expect(apiMocks.approveStoryboard).toHaveBeenCalledWith("p1");
    expect(window.location.pathname).toBe("/projects/p1/storyboard");
  });

  it("consumes the home initial idea before mutation so refresh does not send it again", async () => {
    const draft = cloneProjectResponse();
    draft.storyboard.shots = [];
    draft.creative_workflow = {
      phase: "inspiration",
      messages: [],
      brief: null,
      ready_to_confirm: false,
      planned_asset_ids: [],
      approved_at: null,
    };
    const developed = cloneProjectResponse(draft);
    developed.creative_workflow = {
      ...draft.creative_workflow,
      messages: [
        { role: "user", content: initialProjectIdea },
        { role: "assistant", content: "创意意图已经清楚。" },
      ],
      brief: {
        title: "雨夜来信",
        logline: "一封信改变两个人的命运",
        audience: "悬疑短片观众",
        format: "竖屏短片",
        duration_seconds: 60,
        aspect_ratio: "9:16",
        genre: "悬疑",
        tone: "紧张",
        visual_style: "雨夜霓虹写实",
        story_outline: "来信、怀疑、验证。",
        must_have: ["信"],
        open_questions: [],
      },
      ready_to_confirm: true,
    };
    apiMocks.createDraftProject.mockResolvedValue(draft);
    apiMocks.developInspiration.mockResolvedValue(developed);

    renderAppAt("/projects/new");
    submitNewProject();

    expect(await screen.findByText("创意意图已具备规划条件")).toBeInTheDocument();
    expect(apiMocks.developInspiration).toHaveBeenCalledTimes(1);
    expect(window.history.state?.usr?.initialMessage).toBeUndefined();

    cleanup();
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "雨夜来信",
      updatedAt: "2026-07-15T00:00:00Z",
      incarnation: "incarnation-routes",
      revision: 1,
      snapshot: developed,
    });
    render(<App />);

    expect(await screen.findByText("创意意图已具备规划条件")).toBeInTheDocument();
    expect(apiMocks.developInspiration).toHaveBeenCalledTimes(1);
  });
});
