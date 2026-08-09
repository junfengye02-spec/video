import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type {
  ContinuityPlan,
  JobEvent,
  ShortDramaProjectResponse,
  Shot,
} from "./domain/types";
import { getStrings } from "./i18n";
import type { LocalMediaRecord, LocalProjectSnapshot } from "./localdb/types";
import { useWorkbench } from "./app/workbench/useWorkbench";
import { WorkbenchSessionProvider } from "./features/workbench/WorkbenchSessionProvider";
import { createProjectResponse } from "./test/fixtures";

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
  prepareRender: vi.fn(),
  regenerateShot: vi.fn(),
  renderProject: vi.fn(),
  saveContinuityPlan: vi.fn(),
  saveShot: vi.fn(),
  subscribeProjectEvents: vi.fn(),
  uploadReferenceImage: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  value: {
    user: { id: "user-1", email: "user@example.com", role: "user" } as {
      id: string;
      email: string;
      role: string;
    } | null,
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
    wallet: { balance_units: 1_000_000_000, held_units: 0, available_units: 1_000_000_000 },
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

vi.mock("./api/client", () => apiMocks);
vi.mock("./features/generation/GenerationService", () => ({
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
    optimize: vi.fn((projectId: string, shotId: string, sourceText: string) => (
      apiMocks.optimizePrompt(projectId, {
        target: "shot",
        target_id: shotId,
        source_text: sourceText,
        mode: "shot_json",
      })
    )),
    optimizeImagePrompt: vi.fn(),
    prepareRender: vi.fn((projectId: string) => apiMocks.prepareRender(projectId)),
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
    render: vi.fn((projectId: string) => (
      apiMocks.renderProject(projectId, { render_runtime: "ffmpeg" })
    )),
    compose: vi.fn((projectId: string) => (
      apiMocks.renderProject(projectId, { render_runtime: "ffmpeg" })
    )),
    subscribe: vi.fn((projectId: string, onEvent: (event: JobEvent) => void) => (
      apiMocks.subscribeProjectEvents(projectId, onEvent)
    )),
  },
}));
vi.mock("./auth/AuthProvider", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMocks.value,
}));
vi.mock("./billing/BillingProvider", () => ({
  BillingProvider: ({ children }: { children: ReactNode }) => children,
  useBilling: () => billingMocks.value,
}));
vi.mock("./localdb/projectStore", () => localProjectStoreMocks);
vi.mock("./localdb/mediaStore", () => localMediaStoreMocks);
vi.mock("./localdb/mediaUrls", () => localMediaUrlMocks);
vi.mock("./localdb/exportProject", () => localExportMocks);
vi.mock("./localdb/storageEstimate", () => localStorageEstimateMocks);
vi.mock("./features/projects/ProjectRepository", () => ({
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
vi.mock("./platform/storage/MediaRepository", () => ({
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

const zh = getStrings("zh");

function projectResponse(): ShortDramaProjectResponse {
  const snapshot = createProjectResponse();
  snapshot.project = {
    ...snapshot.project,
    id: "p1",
    title: "Rain Alley",
    project_type: "single_video",
  };
  snapshot.storyboard.shots = snapshot.storyboard.shots.map((shot, index) => ({
    ...shot,
    id: `shot-${index + 1}`,
    index: index + 1,
    prompt: index === 0
      ? "Mara in a red coat finds the envelope."
      : "Mara spots her boss across the alley.",
  }));
  return snapshot;
}

function cloneProjectResponse(value = projectResponse()): ShortDramaProjectResponse {
  return structuredClone(value);
}

function projectWithId(id: string, title = id): ShortDramaProjectResponse {
  const snapshot = projectResponse();
  snapshot.project = { ...snapshot.project, id, title };
  return snapshot;
}

function event(overrides: Partial<JobEvent> = {}): JobEvent {
  return {
    id: "event-1",
    job_id: "job-1",
    project_id: "p1",
    stage: "save",
    status: "complete",
    message: "Operation complete",
    created_at: "2026-07-10T08:00:00Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushPromiseQueue() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function committedMedia(id: string, projectId: string, sourcePath: string): LocalMediaRecord {
  return {
    id,
    projectId,
    sourcePath,
    contentType: "video/mp4",
    sizeBytes: 10,
    createdAt: "2026-07-11T08:00:00Z",
    state: "committed",
    storage: "indexeddb",
  };
}

function localProjectRecord(
  snapshot: ShortDramaProjectResponse,
  revision: number,
  incarnation?: string,
): LocalProjectSnapshot {
  return {
    id: snapshot.project.id,
    title: snapshot.project.title,
    updatedAt: "2026-07-11T08:00:00Z",
    revision,
    ...(incarnation ? { incarnation } : {}),
    snapshot: cloneProjectResponse(snapshot),
  };
}

function ProviderHarness() {
  const workbench = useWorkbench();
  const [outcome, setOutcome] = useState("idle");

  function run(operation: () => Promise<unknown>) {
    setOutcome("pending");
    void operation().then(
      () => setOutcome("resolved"),
      () => setOutcome("rejected"),
    );
  }

  const firstShot = workbench.snapshot?.storyboard.shots[0] ?? null;
  const continuityPlan = workbench.snapshot?.continuity_plan ?? null;

  return (
    <div>
      <button type="button" onClick={() => run(() => workbench.openLocalProject("p1"))}>Open project</button>
      <button type="button" onClick={() => run(() => workbench.openLocalProject("p2"))}>Open second project</button>
      <button
        type="button"
        onClick={() => run(() => workbench.createProject({
          title: "Rain Alley",
          prompt: "A letter changes two lives",
          project_type: "single_video",
        }))}
      >Create project</button>
      <button
        type="button"
        onClick={() => run(() => workbench.createProject({
          title: "Rain Alley",
          prompt: "   ",
          project_type: "single_video",
        }))}
      >Create empty project</button>
      <button
        type="button"
        disabled={!firstShot}
        onClick={() => firstShot && run(() => workbench.saveShotChanges(firstShot.id, {
          prompt: "Mara opens the rain-soaked envelope.",
        }))}
      >Save shot</button>
      <button
        type="button"
        disabled={!firstShot}
        onClick={() => firstShot && run(() => workbench.optimizeShotPrompt(firstShot, firstShot.prompt))}
      >Optimize shot</button>
      <button
        type="button"
        disabled={!firstShot}
        onClick={() => firstShot && run(() => workbench.regenerateSelectedShot(firstShot))}
      >Regenerate shot</button>
      <button
        type="button"
        disabled={!continuityPlan}
        onClick={() => continuityPlan && run(() => workbench.saveContinuity(continuityPlan))}
      >Save continuity</button>
      <button
        type="button"
        disabled={!workbench.snapshot}
        onClick={() => run(() => workbench.uploadReference({
          kind: "character",
          label: "Mara reference",
          description: "Red coat",
          prompt: "Mara in a red coat",
          file: new File(["image"], "mara.png", { type: "image/png" }),
        }))}
      >Upload reference</button>
      <button type="button" disabled={!workbench.snapshot} onClick={() => run(workbench.renderFinal)}>Render final</button>
      <button type="button" disabled={!workbench.snapshot?.final_path} onClick={() => run(workbench.downloadFinal)}>Download final</button>
      <output data-testid="outcome">{outcome}</output>
      <output data-testid="project-id">{workbench.snapshot?.project.id ?? ""}</output>
      <output data-testid="snapshot">{JSON.stringify(workbench.snapshot)}</output>
      <output data-testid="events">{JSON.stringify(workbench.events)}</output>
      <output data-testid="error">{workbench.error ?? ""}</output>
      <output data-testid="final-url">{workbench.finalRenderUrl ?? ""}</output>
      <output data-testid="busy">{JSON.stringify(workbench.busy)}</output>
      <output data-testid="local-media">{JSON.stringify(workbench.localMediaUrls)}</output>
      <output data-testid="local-backup-status">{workbench.localBackupStatus}</output>
    </div>
  );
}

function renderProvider() {
  return render(
    <WorkbenchSessionProvider>
      <ProviderHarness />
    </WorkbenchSessionProvider>,
  );
}

function setCredentials(_values: { text?: string; image?: string; video?: string; baseUrl?: string } = {}) {
  // Provider credentials are server-selected; legacy setup calls stay as no-ops for old flows.
}

async function openProject(snapshot = projectResponse()) {
  localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
    id: snapshot.project.id,
    title: snapshot.project.title,
    updatedAt: "2026-07-10T08:00:00Z",
    snapshot: cloneProjectResponse(snapshot),
  });
  fireEvent.click(screen.getByRole("button", { name: "Open project" }));
  await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent(snapshot.project.id));
}

describe("App workbench integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/projects");
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
      wallet: { balance_units: 1_000_000_000, held_units: 0, available_units: 1_000_000_000 },
      loading: false,
      error: null,
      refreshWallet: vi.fn(),
    };
    localProjectStoreMocks.listProjectSummaries.mockResolvedValue([]);
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue(null);
    let storageRevision = 0;
    localProjectStoreMocks.saveProjectSnapshot.mockImplementation(
      (next: ShortDramaProjectResponse) => Promise.resolve(
        localProjectRecord(next, ++storageRevision, "incarnation-default"),
      ),
    );
    localProjectStoreMocks.saveProjectSnapshotIfVersion.mockImplementation(
      (next: ShortDramaProjectResponse, expected: { incarnation: string; revision: number }) => {
        if (
          expected.incarnation !== "incarnation-default"
          || expected.revision !== storageRevision
        ) return Promise.resolve(null);
        return Promise.resolve(localProjectRecord(next, ++storageRevision, expected.incarnation));
      },
    );
    localProjectStoreMocks.setRecentProjectId.mockResolvedValue(undefined);
    localStorageEstimateMocks.getStorageEstimate.mockResolvedValue({
      usageBytes: 2048,
      quotaBytes: 4096,
      persisted: false,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue(null);
    localMediaStoreMocks.findCommittedMedia.mockResolvedValue(null);
    localMediaStoreMocks.startMediaRecoveryController.mockReturnValue({
      dispose: vi.fn(),
      run: vi.fn().mockResolvedValue(0),
    });
    localMediaUrlMocks.resolveLocalMediaUrl.mockImplementation(
      (ref: string) => Promise.resolve(`blob:${ref}`),
    );
    apiMocks.createShortDramaProject.mockResolvedValue(projectResponse());
    apiMocks.loadProject.mockResolvedValue(projectResponse());
    apiMocks.prepareRender.mockResolvedValue({
      project_id: "p1",
      shot_summary: { total: 1, reusable: 1, to_generate: 0, completed: 1 },
      estimated_units: 0,
      available_units: 1000,
      estimate_status: "ready",
      output: {
        format: "mp4",
        resolution: "1280x720",
        aspect_ratio: "16:9",
        duration_seconds: 25,
        render_runtime: "ffmpeg",
      },
      continuity: { characters: 0, locations: 0, props: 0, bound_assets: 0 },
      active_job: null,
    });
    apiMocks.subscribeProjectEvents.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
  });

  it("uses the routed application entry and shows wallet/account actions", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "让想法入镜" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /钱包 ¥1,000\.00/ })).toHaveAttribute("href", "/wallet");
    expect(screen.getByRole("link", { name: "订单" })).toHaveAttribute("href", "/orders");
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "接口配置" })).not.toBeInTheDocument();
  });

  it("opens only the requested browser-local project and marks it recent", async () => {
    renderProvider();
    await openProject();

    expect(localProjectStoreMocks.loadProjectSnapshot).toHaveBeenCalledWith("p1");
    expect(localProjectStoreMocks.setRecentProjectId).toHaveBeenCalledWith("p1");
    expect(apiMocks.loadLatestProject).not.toHaveBeenCalled();
  });

  it("starts one recovery controller on mount and disposes it on unmount", () => {
    const dispose = vi.fn();
    localMediaStoreMocks.startMediaRecoveryController.mockReturnValue({
      dispose,
      run: vi.fn().mockResolvedValue(0),
    });

    const rendered = renderProvider();

    expect(localMediaStoreMocks.startMediaRecoveryController).toHaveBeenCalledTimes(1);
    rendered.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("routes logout through the account action without deleting portable browser backups", async () => {
    const dispose = vi.fn();
    localMediaStoreMocks.startMediaRecoveryController.mockReturnValue({
      dispose,
      run: vi.fn().mockResolvedValue(0),
    });
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "Rain Alley",
      updatedAt: "2026-07-11T08:00:00Z",
      snapshot: projectResponse(),
    });
    authMocks.value.logout = vi.fn(() => {
      authMocks.value = { ...authMocks.value, user: null };
    });
    window.history.replaceState({}, "", "/projects/p1/storyboard");
    const rendered = render(<App />);
    await screen.findByLabelText(zh.shotEditor.promptLabel);

    fireEvent.click(screen.getByRole("button", { name: /退出|閫/ }));
    rendered.rerender(<App />);

    expect(authMocks.value.logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", { name: "欢迎回来" })).toBeInTheDocument();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(localProjectStoreMocks.deleteProject).not.toHaveBeenCalled();
  });

  it("hydrates exact committed shot, final, and asset media before opening a project", async () => {
    const current = projectResponse();
    current.storyboard.shots[0].output_path = "assets/video/shot-hydrate.mp4";
    current.final_path = "renders/final-hydrate.mp4";
    current.series_bible.assets![0].reference_images = ["assets/images/mara-hydrate.png"];
    current.series_bible.assets![0].media_urls = ["assets/video/mara-hydrate.mp4"];
    localMediaStoreMocks.findCommittedMedia.mockImplementation((projectId: string, sourcePath: string) => {
      const ids: Record<string, string> = {
        "assets/video/shot-hydrate.mp4": "hydrated-shot",
        "renders/final-hydrate.mp4": "hydrated-final",
        "assets/images/mara-hydrate.png": "hydrated-reference",
        "assets/video/mara-hydrate.mp4": "hydrated-asset-media",
      };
      return Promise.resolve(ids[sourcePath]
        ? committedMedia(ids[sourcePath], projectId, sourcePath)
        : null);
    });
    renderProvider();

    await openProject(current);

    expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/hydrated-shot");
    expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/hydrated-final");
    expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/hydrated-reference");
    expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/hydrated-asset-media");
    expect(localMediaStoreMocks.findCommittedMedia).toHaveBeenCalledWith(
      "p1",
      "renders/final-hydrate.mp4",
      "legacy:p1",
    );
  });

  it("keeps the authoritative final path when a committed cache has the wrong file size", async () => {
    const current = projectResponse();
    current.final_path = "renders/final.mp4";
    current.render_report = {
      version: "1.0",
      outputs: [{
        path: "renders/final.mp4",
        format: "mp4",
        resolution: "720x1280",
        duration_seconds: 12,
        file_size_bytes: 4_687_896,
      }],
    };
    localMediaStoreMocks.findCommittedMedia.mockResolvedValue(
      committedMedia("stale-final", "p1", "renders/final.mp4"),
    );
    renderProvider();

    await openProject(current);

    expect(screen.getByTestId("snapshot")).toHaveTextContent('"final_path":"renders/final.mp4"');
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("local://media/stale-final");
  });

  it("creates and persists a project without sending a shot count", async () => {
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(apiMocks.createShortDramaProject).toHaveBeenCalledWith({
      title: "Rain Alley",
      prompt: "A letter changes two lives",
      project_type: "single_video",
    });
    expect(apiMocks.createShortDramaProject.mock.calls[0]?.[0]).not.toHaveProperty("shot_count");
    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ project: expect.objectContaining({ id: "p1" }), final_path: null }),
    );
  });

  it("does not expose browser provider configuration state", () => {
    renderProvider();

    expect(screen.queryByRole("button", { name: "Save provider" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Text credential")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provider-ready")).not.toBeInTheDocument();
  });

  it("defensively rejects an empty project prompt", async () => {
    renderProvider();

    fireEvent.click(screen.getByRole("button", { name: "Create empty project" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("rejected"));
    expect(apiMocks.createShortDramaProject).not.toHaveBeenCalled();
    expect(screen.getByTestId("error")).toHaveTextContent(zh.errors.createStoryboardRequiresPrompt);
  });

  it("saves shot metadata, clears render metadata, and propagates rejection", async () => {
    const updated = projectResponse();
    updated.storyboard.shots[0] = {
      ...updated.storyboard.shots[0],
      prompt: "Mara opens the rain-soaked envelope.",
      version: 2,
    };
    apiMocks.saveShot.mockResolvedValueOnce({
      job_id: "save-job",
      event: event({ id: "save-event" }),
      shot: updated.storyboard.shots[0],
      storyboard: updated.storyboard,
      consistency_report: updated.consistency_report,
    });
    renderProvider();
    await openProject();

    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));
    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(apiMocks.saveShot).toHaveBeenCalledWith("p1", "shot-1", {
      prompt: "Mara opens the rain-soaked envelope.",
    });
    expect(apiMocks.saveShot.mock.calls[0]?.[2]).not.toHaveProperty(["video", "key"].join("_"));
    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ storyboard: updated.storyboard, render_report: null, final_path: null }),
    );

    apiMocks.saveShot.mockRejectedValueOnce(new Error("save failed"));
    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));
    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("rejected"));
    expect(screen.getByTestId("error")).toHaveTextContent("save failed");
  });

  it("optimizes with the exact shot payload", async () => {
    apiMocks.optimizePrompt.mockResolvedValue({
      project_id: "p1",
      model: "gpt-5.5",
      optimized_text: "Optimized shot",
      notes: [],
    });
    renderProvider();
    await openProject();

    fireEvent.click(screen.getByRole("button", { name: "Optimize shot" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(apiMocks.optimizePrompt).toHaveBeenCalledWith("p1", {
      target: "shot",
      target_id: "shot-1",
      source_text: "Mara in a red coat finds the envelope.",
      mode: "shot_json",
    });
  });

  it("does not let a stale optimize rejection set the new project's error or clear its busy state", async () => {
    const first = deferred<{
      project_id: string;
      model: string;
      optimized_text: string;
      notes: string[];
    }>();
    const second = deferred<{
      project_id: string;
      model: string;
      optimized_text: string;
      notes: string[];
    }>();
    apiMocks.optimizePrompt
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const projectA = projectWithId("p1", "Project A");
    const projectB = projectWithId("p2", "Project B");
    localProjectStoreMocks.loadProjectSnapshot.mockImplementation((projectId: string) => Promise.resolve({
      id: projectId,
      title: projectId === "p1" ? "Project A" : "Project B",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: cloneProjectResponse(projectId === "p1" ? projectA : projectB),
    }));
    renderProvider();
    setCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    fireEvent.click(screen.getByRole("button", { name: "Optimize shot" }));

    fireEvent.click(screen.getByRole("button", { name: "Open second project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));
    fireEvent.click(screen.getByRole("button", { name: "Optimize shot" }));
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent('"optimizingShotId":"shot-1"'));

    first.reject(new Error("stale optimize failed"));
    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("rejected"));
    expect(screen.getByTestId("error")).toBeEmptyDOMElement();
    expect(screen.getByTestId("busy")).toHaveTextContent('"optimizingShotId":"shot-1"');

    second.resolve({
      project_id: "p2",
      model: "gpt-5.5",
      optimized_text: "Project B optimized",
      notes: [],
    });
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent('"optimizingShotId":null'));
  });

  it("does not let a stale shot save success overwrite the new project or clear its save busy state", async () => {
    const projectA = projectWithId("p1", "Project A");
    const projectB = projectWithId("p2", "Project B");
    const first = deferred<{
      job_id: string;
      event: JobEvent;
      shot: Shot;
      storyboard: ShortDramaProjectResponse["storyboard"];
      consistency_report: ShortDramaProjectResponse["consistency_report"];
    }>();
    const second = deferred<{
      job_id: string;
      event: JobEvent;
      shot: Shot;
      storyboard: ShortDramaProjectResponse["storyboard"];
      consistency_report: ShortDramaProjectResponse["consistency_report"];
    }>();
    apiMocks.saveShot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    localProjectStoreMocks.loadProjectSnapshot.mockImplementation((projectId: string) => Promise.resolve({
      id: projectId,
      title: projectId === "p1" ? "Project A" : "Project B",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: cloneProjectResponse(projectId === "p1" ? projectA : projectB),
    }));
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));

    fireEvent.click(screen.getByRole("button", { name: "Open second project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));
    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent('"savingShotId":"shot-1"'));

    const staleShot = { ...projectA.storyboard.shots[0], prompt: "Stale A save" };
    first.resolve({
      job_id: "save-a",
      event: event({ id: "save-a", project_id: "p1" }),
      shot: staleShot,
      storyboard: { ...projectA.storyboard, shots: [staleShot, projectA.storyboard.shots[1]] },
      consistency_report: projectA.consistency_report,
    });
    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(screen.getByTestId("project-id")).toHaveTextContent("p2");
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("Stale A save");
    expect(screen.getByTestId("busy")).toHaveTextContent('"savingShotId":"shot-1"');

    const savedB = { ...projectB.storyboard.shots[0], prompt: "Saved B" };
    second.resolve({
      job_id: "save-b",
      event: event({ id: "save-b", project_id: "p2" }),
      shot: savedB,
      storyboard: { ...projectB.storyboard, shots: [savedB, projectB.storyboard.shots[1]] },
      consistency_report: projectB.consistency_report,
    });
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent('"savingShotId":null'));
  });

  it("does not let a stale render rejection set the new project's error or clear its render busy state", async () => {
    const projectA = projectWithId("p1", "Project A");
    const projectB = projectWithId("p2", "Project B");
    const first = deferred<never>();
    const second = deferred<never>();
    apiMocks.renderProject.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    localProjectStoreMocks.loadProjectSnapshot.mockImplementation((projectId: string) => Promise.resolve({
      id: projectId,
      title: projectId === "p1" ? "Project A" : "Project B",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: cloneProjectResponse(projectId === "p1" ? projectA : projectB),
    }));
    renderProvider();
    setCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    fireEvent.click(screen.getByRole("button", { name: "Render final" }));

    fireEvent.click(screen.getByRole("button", { name: "Open second project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));
    fireEvent.click(screen.getByRole("button", { name: "Render final" }));
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent('"rendering":true'));

    first.reject(new Error("stale render failed"));
    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("rejected"));
    expect(screen.getByTestId("error")).toBeEmptyDOMElement();
    expect(screen.getByTestId("busy")).toHaveTextContent('"rendering":true');

    second.reject(new Error("current render failed"));
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("current render failed"));
    expect(screen.getByTestId("busy")).toHaveTextContent('"rendering":false');
  });

  it("accepts asynchronous regeneration without replacing the current snapshot", async () => {
    const current = projectResponse();
    apiMocks.regenerateShot.mockResolvedValue({
      task_id: "regenerate-task",
      status: "queued",
      deduplicated: false,
      task: { id: "regenerate-task", status: "queued", items: [] },
    });
    renderProvider();
    await openProject(current);
    setCredentials();
    const snapshotBefore = screen.getByTestId("snapshot").textContent;

    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(apiMocks.regenerateShot).toHaveBeenCalledWith("p1", "shot-1", {});
    expect(screen.getByTestId("busy")).toHaveTextContent('"regeneratingShotId":null');
    expect(screen.getByTestId("snapshot").textContent).toBe(snapshotBefore);
    expect(localMediaStoreMocks.cacheRemoteMedia).not.toHaveBeenCalled();
  });

  it("holds regeneration busy state until the asynchronous task is accepted", async () => {
    const pending = deferred<unknown>();
    apiMocks.regenerateShot.mockReturnValue(pending.promise);
    renderProvider();
    await openProject(projectResponse());
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));

    await waitFor(() => expect(screen.getByTestId("busy"))
      .toHaveTextContent('"regeneratingShotId":"shot-1"'));
    expect(screen.getByTestId("outcome")).toHaveTextContent("pending");
    pending.resolve({
      task_id: "pending-regenerate-task",
      status: "waiting_provider",
      deduplicated: false,
      task: { id: "pending-regenerate-task", status: "waiting_provider", items: [] },
    });
    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(screen.getByTestId("busy")).toHaveTextContent('"regeneratingShotId":null');
  });

  it("saves continuity with the exact plan and persists the refreshed project", async () => {
    const current = projectResponse();
    const plan = current.continuity_plan as ContinuityPlan;
    const refreshed = cloneProjectResponse(current);
    refreshed.continuity_plan = { ...plan, series_bible: { ...plan.series_bible, worldview: "Updated" } };
    apiMocks.saveContinuityPlan.mockResolvedValue({
      project: current.project,
      continuity_plan: refreshed.continuity_plan,
    });
    apiMocks.loadProject.mockResolvedValue(refreshed);
    renderProvider();
    await openProject(current);

    fireEvent.click(screen.getByRole("button", { name: "Save continuity" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(apiMocks.saveContinuityPlan).toHaveBeenCalledWith("p1", plan);
    expect(apiMocks.loadProject).toHaveBeenCalledWith("p1");
    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenLastCalledWith(refreshed);
  });

  it("retries a continuity refresh when a newer shot save lands during the first GET", async () => {
    const current = projectResponse();
    const updatedPlan = {
      ...(current.continuity_plan as ContinuityPlan),
      series_bible: {
        ...(current.continuity_plan as ContinuityPlan).series_bible,
        worldview: "Continuity saved",
      },
    };
    const firstRefresh = deferred<ShortDramaProjectResponse>();
    const staleRefresh = cloneProjectResponse(current);
    staleRefresh.continuity_plan = updatedPlan;
    const combined = cloneProjectResponse(staleRefresh);
    combined.storyboard.shots[0].prompt = "Newer shot survived";
    apiMocks.saveContinuityPlan.mockResolvedValue({
      project: current.project,
      continuity_plan: updatedPlan,
    });
    apiMocks.loadProject
      .mockReturnValueOnce(firstRefresh.promise)
      .mockResolvedValueOnce(combined);
    apiMocks.saveShot.mockResolvedValue({
      job_id: "newer-save",
      event: event({ id: "newer-save" }),
      shot: combined.storyboard.shots[0],
      storyboard: combined.storyboard,
      consistency_report: combined.consistency_report,
    });
    renderProvider();
    await openProject(current);

    fireEvent.click(screen.getByRole("button", { name: "Save continuity" }));
    await waitFor(() => expect(apiMocks.loadProject).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));
    await waitFor(() => expect(screen.getByTestId("snapshot")).toHaveTextContent("Newer shot survived"));

    firstRefresh.resolve(staleRefresh);

    await waitFor(() => expect(apiMocks.loadProject).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.getByTestId("snapshot")).toHaveTextContent("Newer shot survived");
      expect(screen.getByTestId("snapshot")).toHaveTextContent("Continuity saved");
    });
    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        continuity_plan: expect.objectContaining({
          series_bible: expect.objectContaining({ worldview: "Continuity saved" }),
        }),
        storyboard: expect.objectContaining({
          shots: expect.arrayContaining([
            expect.objectContaining({ prompt: "Newer shot survived" }),
          ]),
        }),
      }),
    );
  });

  it("preserves browser-local media refs and their fallback across a non-media refresh", async () => {
    const current = projectResponse();
    current.storyboard.shots[0].output_path = "local://media/cached-shot";
    current.final_path = "local://media/cached-final";
    current.render_report = {
      version: "1.0",
      outputs: [{
        path: "renders/final.mp4",
        format: "mp4",
        resolution: "720x1280",
        duration_seconds: 25,
      }],
    };
    const refreshed = cloneProjectResponse(current);
    refreshed.storyboard.shots[0].output_path = "assets/video/shot-1.mp4";
    refreshed.final_path = "renders/final.mp4";
    const plan = current.continuity_plan as ContinuityPlan;
    apiMocks.saveContinuityPlan.mockResolvedValue({ project: current.project, continuity_plan: plan });
    apiMocks.loadProject.mockResolvedValue(refreshed);
    renderProvider();
    await openProject(current);

    fireEvent.click(screen.getByRole("button", { name: "Save continuity" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/cached-shot");
    expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/cached-final");
    expect(screen.getByTestId("snapshot")).toHaveTextContent(
      '"output_url":"assets/video/shot-1.mp4"',
    );
  });

  it("uploads the exact reference payload and persists the refreshed project", async () => {
    const current = projectResponse();
    current.storyboard.shots[0].output_path = "local://media/upload-cached-shot";
    current.series_bible.assets![0].reference_images = ["local://media/upload-cached-asset"];
    const refreshed = cloneProjectResponse(current);
    refreshed.storyboard.shots[0].output_path = "assets/video/shot-1.mp4";
    refreshed.series_bible.assets![0].reference_images = ["assets/images/character/mara.png"];
    refreshed.series_bible.assets = [
      ...(refreshed.series_bible.assets ?? []),
      {
        id: "asset-uploaded",
        kind: "character",
        label: "Mara reference",
        reference_images: ["assets/images/mara.png"],
      },
    ];
    apiMocks.uploadReferenceImage.mockResolvedValue({
      media: {
        path: "assets/images/mara.png",
        media_url: "/api/projects/p1/media/assets/images/mara.png",
        filename: "mara.png",
        content_type: "image/png",
      },
      asset: refreshed.series_bible.assets[refreshed.series_bible.assets.length - 1],
    });
    apiMocks.loadProject.mockResolvedValue(refreshed);
    renderProvider();
    await openProject(current);

    fireEvent.click(screen.getByRole("button", { name: "Upload reference" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(apiMocks.uploadReferenceImage).toHaveBeenCalledWith("p1", expect.objectContaining({
      kind: "character",
      label: "Mara reference",
      description: "Red coat",
      prompt: "Mara in a red coat",
      file: expect.any(File),
    }));
    expect(apiMocks.loadProject).toHaveBeenCalledWith("p1");
    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        storyboard: expect.objectContaining({
          shots: expect.arrayContaining([
            expect.objectContaining({ output_path: "local://media/upload-cached-shot" }),
          ]),
        }),
        series_bible: expect.objectContaining({
          assets: expect.arrayContaining([
            expect.objectContaining({
              id: "asset-char-1",
              reference_images: ["local://media/upload-cached-asset"],
            }),
            expect.objectContaining({ id: "asset-uploaded" }),
          ]),
        }),
      }),
    );
  });

  it("retries an upload refresh when a newer shot save lands during the first GET", async () => {
    const current = projectResponse();
    const uploadedAsset = {
      id: "asset-uploaded-race",
      kind: "character" as const,
      label: "Uploaded race asset",
      description: "Uploaded while editing",
      prompt: "Reference",
      reference_images: ["assets/images/uploaded-race.png"],
      media_urls: ["/api/projects/p1/media/assets/images/uploaded-race.png"],
      shot_ids: [],
      version: 1,
    };
    const firstRefresh = deferred<ShortDramaProjectResponse>();
    const staleRefresh = cloneProjectResponse(current);
    staleRefresh.series_bible.assets = [
      ...(staleRefresh.series_bible.assets ?? []),
      uploadedAsset,
    ];
    const combined = cloneProjectResponse(staleRefresh);
    combined.storyboard.shots[0].prompt = "Newer shot survived upload";
    apiMocks.uploadReferenceImage.mockResolvedValue({
      media: {
        path: "assets/images/uploaded-race.png",
        media_url: "/api/projects/p1/media/assets/images/uploaded-race.png",
        filename: "uploaded-race.png",
        content_type: "image/png",
      },
      asset: uploadedAsset,
    });
    apiMocks.loadProject
      .mockReturnValueOnce(firstRefresh.promise)
      .mockResolvedValueOnce(combined);
    apiMocks.saveShot.mockResolvedValue({
      job_id: "newer-save-upload",
      event: event({ id: "newer-save-upload" }),
      shot: combined.storyboard.shots[0],
      storyboard: combined.storyboard,
      consistency_report: combined.consistency_report,
    });
    renderProvider();
    await openProject(current);

    fireEvent.click(screen.getByRole("button", { name: "Upload reference" }));
    await waitFor(() => expect(apiMocks.loadProject).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));
    await waitFor(() => expect(screen.getByTestId("snapshot")).toHaveTextContent("Newer shot survived upload"));

    firstRefresh.resolve(staleRefresh);

    await waitFor(() => expect(apiMocks.loadProject).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.getByTestId("snapshot")).toHaveTextContent("Newer shot survived upload");
      expect(screen.getByTestId("snapshot")).toHaveTextContent("Uploaded race asset");
    });
  });

  it("keeps the last successful final render available when a retry fails", async () => {
    const current = projectResponse();
    current.final_path = "local://media/old-final";
    current.render_report = {
      version: "1.0",
      outputs: [{
        path: "renders/old-final.mp4",
        format: "mp4",
        resolution: "720x1280",
        duration_seconds: 25,
      }],
    };
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: current.project.title,
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: cloneProjectResponse(current),
    });
    localMediaUrlMocks.resolveLocalMediaUrl.mockResolvedValue("blob:old-final");
    apiMocks.renderProject.mockRejectedValue(new Error("render failed"));
    window.history.replaceState({}, "", "/projects/p1/production");
    render(<App />);

    expect(await screen.findByLabelText("最终成片预览")).toHaveAttribute("src", "blob:old-final");
    fireEvent.click(screen.getByRole("button", { name: "重新制作" }));
    const renderDialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(renderDialog).getByRole("button", { name: "确认重新制作" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("render failed");
    expect(screen.getByLabelText("最终成片预览")).toHaveAttribute("src", "blob:old-final");
    expect(screen.getByRole("button", { name: "下载最终成片" })).toBeEnabled();
    expect(localProjectStoreMocks.saveProjectSnapshot).not.toHaveBeenCalledWith(
      expect.objectContaining({ final_path: null }),
    );
  });

  it("refreshes from the authoritative project after render and caches its final path", async () => {
    const current = projectResponse();
    current.storyboard.shots[0].output_path = "local://media/render-cached-shot";
    const authoritative = cloneProjectResponse(current);
    authoritative.storyboard.shots[0].output_path = "assets/video/shot-1.mp4";
    authoritative.continuity_plan = {
      ...(authoritative.continuity_plan as ContinuityPlan),
      series_bible: {
        ...(authoritative.continuity_plan as ContinuityPlan).series_bible,
        worldview: "Authoritative world",
      },
    };
    authoritative.workflow_artifacts = [{
      name: "authoritative-render.json",
      path: "artifacts/authoritative-render.json",
      exists: true,
    }];
    authoritative.render_report = {
      version: "1.0",
      outputs: [{
        path: "renders/final.mp4",
        format: "mp4",
        resolution: "1080x1920",
        duration_seconds: 26,
      }],
    };
    authoritative.final_path = "renders/final.mp4";
    apiMocks.renderProject.mockResolvedValue({
      job_id: "render-job",
      event: event({ id: "render-event", stage: "render" }),
      project: current.project,
      storyboard: current.storyboard,
      consistency_report: current.consistency_report,
      render_report: {
        version: "1.0",
        outputs: [{
          path: "renders/final.webm",
          format: "webm",
          resolution: "720x1280",
          duration_seconds: 25,
        }],
      },
      final_path: "renders/final.webm",
    });
    apiMocks.loadProject.mockResolvedValue(authoritative);
    localMediaStoreMocks.cacheRemoteMedia.mockImplementation(
      (_url: string, metadata: { sourcePath: string }) => Promise.resolve(
        metadata.sourcePath.endsWith("final.mp4")
          ? "local://media/final-authoritative"
          : "local://media/final-response",
      ),
    );
    renderProvider();
    await openProject(current);
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Render final" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(apiMocks.renderProject).toHaveBeenCalledWith("p1", {
      render_runtime: "ffmpeg",
    });
    expect(apiMocks.loadProject).toHaveBeenCalledWith("p1");
    await waitFor(() => expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledTimes(1));
    expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledWith(
      "/api/projects/p1/media/renders/final.mp4",
      {
        projectId: "p1",
        projectIncarnation: "incarnation-default",
        sourcePath: "renders/final.mp4",
      },
    );
    expect(localProjectStoreMocks.saveProjectSnapshotIfVersion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        continuity_plan: expect.objectContaining({
          series_bible: expect.objectContaining({ worldview: "近未来沿海城市" }),
        }),
        workflow_artifacts: current.workflow_artifacts,
        final_path: "local://media/final-authoritative",
        storyboard: expect.objectContaining({
          shots: expect.arrayContaining([
            expect.objectContaining({ output_path: "local://media/render-cached-shot" }),
          ]),
        }),
      }),
      { incarnation: "incarnation-default", revision: 1 },
    );
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("Authoritative world");
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("authoritative-render.json");
  });

  it("uses the current snapshot as render reconciliation base and takes only final metadata", async () => {
    const current = projectResponse();
    const responseReport = {
      version: "1.0" as const,
      outputs: [{
        path: "renders/concurrent-response.webm",
        format: "webm",
        resolution: "720x1280",
        duration_seconds: 24,
      }],
    };
    const authoritativeReport = {
      version: "1.0" as const,
      outputs: [{
        path: "renders/concurrent-authoritative.mp4",
        format: "mp4",
        resolution: "1080x1920",
        duration_seconds: 25,
      }],
    };
    apiMocks.renderProject.mockResolvedValue({
      job_id: "render-current-base",
      event: event({ id: "render-current-base", stage: "render" }),
      project: current.project,
      storyboard: current.storyboard,
      consistency_report: current.consistency_report,
      render_report: responseReport,
      final_path: "renders/concurrent-response.webm",
    });

    const concurrentProject = { ...current.project, title: "Concurrent project title" };
    const concurrentPlan = {
      ...(current.continuity_plan as ContinuityPlan),
      series_bible: {
        ...(current.continuity_plan as ContinuityPlan).series_bible,
        worldview: "Concurrent continuity world",
      },
    };
    apiMocks.saveContinuityPlan.mockResolvedValue({
      project: concurrentProject,
      continuity_plan: concurrentPlan,
    });
    const uploadedAsset = {
      id: "asset-concurrent-render",
      kind: "character" as const,
      label: "Concurrent render asset",
      reference_images: ["assets/images/concurrent-render.png"],
    };
    apiMocks.uploadReferenceImage.mockResolvedValue({
      media: {
        path: "assets/images/concurrent-render.png",
        media_url: "/api/projects/p1/media/assets/images/concurrent-render.png",
        filename: "concurrent-render.png",
        content_type: "image/png",
      },
      asset: uploadedAsset,
    });

    const afterContinuity = cloneProjectResponse(current);
    afterContinuity.project = concurrentProject;
    afterContinuity.continuity_plan = concurrentPlan;
    afterContinuity.render_report = responseReport;
    afterContinuity.final_path = "renders/concurrent-response.webm";
    const afterUpload = cloneProjectResponse(afterContinuity);
    afterUpload.series_bible.assets = [
      ...(afterUpload.series_bible.assets ?? []),
      uploadedAsset,
    ];
    const authoritative = cloneProjectResponse(current);
    authoritative.project.title = "Stale authoritative title";
    (authoritative.continuity_plan as ContinuityPlan).series_bible.worldview = "Stale world";
    authoritative.series_bible.assets = [];
    authoritative.render_report = authoritativeReport;
    authoritative.final_path = "renders/concurrent-authoritative.mp4";

    const renderRefresh = deferred<ShortDramaProjectResponse>();
    apiMocks.loadProject
      .mockReturnValueOnce(renderRefresh.promise)
      .mockResolvedValueOnce(afterContinuity)
      .mockResolvedValueOnce(afterUpload)
      .mockResolvedValueOnce(authoritative);
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue("local://media/concurrent-authoritative");
    renderProvider();
    await openProject(current);
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Render final" }));
    await waitFor(() => expect(apiMocks.loadProject).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Save continuity" }));
    await waitFor(() => expect(screen.getByTestId("snapshot"))
      .toHaveTextContent("Concurrent continuity world"));
    fireEvent.click(screen.getByRole("button", { name: "Upload reference" }));
    await waitFor(() => expect(screen.getByTestId("snapshot"))
      .toHaveTextContent("Concurrent render asset"));

    renderRefresh.resolve(authoritative);

    await waitFor(() => expect(screen.getByTestId("snapshot"))
      .toHaveTextContent("local://media/concurrent-authoritative"));
    expect(apiMocks.loadProject).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId("snapshot")).toHaveTextContent("Concurrent project title");
    expect(screen.getByTestId("snapshot")).toHaveTextContent("Concurrent continuity world");
    expect(screen.getByTestId("snapshot")).toHaveTextContent("Concurrent render asset");
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("Stale authoritative title");
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("Stale world");
  });

  it("publishes and persists remote final render before background caching completes", async () => {
    const current = projectResponse();
    const cache = deferred<string | null>();
    const renderReport = {
      version: "1.0" as const,
      outputs: [{
        path: "renders/remote-first.mp4",
        format: "mp4",
        resolution: "720x1280",
        duration_seconds: 25,
      }],
    };
    const remoteSnapshot = cloneProjectResponse(current);
    remoteSnapshot.render_report = renderReport;
    remoteSnapshot.final_path = "renders/remote-first.mp4";
    apiMocks.renderProject.mockResolvedValue({
      job_id: "render-remote-first",
      event: event({ id: "render-remote-first", stage: "render" }),
      project: current.project,
      storyboard: current.storyboard,
      consistency_report: current.consistency_report,
      render_report: renderReport,
      final_path: "renders/remote-first.mp4",
    });
    apiMocks.loadProject.mockResolvedValue(remoteSnapshot);
    localMediaStoreMocks.cacheRemoteMedia.mockReturnValue(cache.promise);
    renderProvider();
    await openProject(current);
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Render final" }));

    await waitFor(() => expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(screen.getByTestId("busy")).toHaveTextContent('"rendering":false');
    expect(screen.getByTestId("snapshot")).toHaveTextContent("renders/remote-first.mp4");
    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ final_path: "renders/remote-first.mp4" }),
    );
    expect(screen.getByTestId("local-backup-status")).toHaveTextContent("saving");

    cache.resolve("local://media/render-remote-first");
    await waitFor(() => expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/render-remote-first"));
  });

  it("starts authoritative render refresh in a macrotask after public completion and busy clear", async () => {
    const current = projectResponse();
    const renderReport = {
      version: "1.0" as const,
      outputs: [{
        path: "renders/macrotask-final.mp4",
        format: "mp4",
        resolution: "720x1280",
        duration_seconds: 25,
      }],
    };
    apiMocks.renderProject.mockResolvedValue({
      job_id: "render-macrotask",
      event: event({ id: "render-macrotask", stage: "render" }),
      project: current.project,
      storyboard: current.storyboard,
      consistency_report: current.consistency_report,
      render_report: renderReport,
      final_path: "renders/macrotask-final.mp4",
    });
    const eventLog: string[] = [];
    apiMocks.loadProject.mockImplementation(() => {
      eventLog.push(
        `refresh:${screen.getByTestId("outcome").textContent}:`
        + `${screen.getByTestId("busy").textContent?.includes('"rendering":false')}`,
      );
      const authoritative = cloneProjectResponse(current);
      authoritative.render_report = renderReport;
      authoritative.final_path = "renders/macrotask-final.mp4";
      return Promise.resolve(authoritative);
    });
    renderProvider();
    await openProject(current);
    setCredentials();
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Render final" }));
    await act(flushPromiseQueue);

    expect(screen.getByTestId("outcome")).toHaveTextContent("resolved");
    expect(screen.getByTestId("busy")).toHaveTextContent('"rendering":false');
    expect(apiMocks.loadProject).not.toHaveBeenCalled();
    expect(localMediaStoreMocks.cacheRemoteMedia).not.toHaveBeenCalled();
    eventLog.push("public:resolved:true");

    await act(async () => {
      vi.runOnlyPendingTimers();
      await flushPromiseQueue();
    });

    expect(eventLog).toEqual(["public:resolved:true", "refresh:resolved:true"]);
  });

  it("does not reconcile or cache a pending authoritative render refresh after unmount", async () => {
    const current = projectResponse();
    const refresh = deferred<ShortDramaProjectResponse>();
    const renderReport = {
      version: "1.0" as const,
      outputs: [{
        path: "renders/unmounted-pending-final.mp4",
        format: "mp4",
        resolution: "720x1280",
        duration_seconds: 25,
      }],
    };
    apiMocks.renderProject.mockResolvedValue({
      job_id: "unmounted-pending-render",
      event: event({ id: "unmounted-pending-render", stage: "render" }),
      project: current.project,
      storyboard: current.storyboard,
      consistency_report: current.consistency_report,
      render_report: renderReport,
      final_path: "renders/unmounted-pending-final.mp4",
    });
    apiMocks.loadProject.mockReturnValue(refresh.promise);
    const rendered = renderProvider();
    await openProject(current);
    setCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Render final" }));
    await waitFor(() => expect(apiMocks.loadProject).toHaveBeenCalledTimes(1));
    const primarySaveCount = localProjectStoreMocks.saveProjectSnapshot.mock.calls.length;

    rendered.unmount();
    const authoritative = cloneProjectResponse(current);
    authoritative.render_report = renderReport;
    authoritative.final_path = "renders/unmounted-pending-final.mp4";
    refresh.resolve(authoritative);
    await flushPromiseQueue();

    expect(localProjectStoreMocks.saveProjectSnapshot.mock.calls.length).toBeGreaterThanOrEqual(primarySaveCount);
    expect(localProjectStoreMocks.saveProjectSnapshotIfVersion).not.toHaveBeenCalled();
    expect(localMediaStoreMocks.cacheRemoteMedia).not.toHaveBeenCalled();
  });

  it("keeps the accepted async composition separate from a failed refresh", async () => {
    const current = projectResponse();
    apiMocks.renderProject.mockResolvedValue({
      job_id: "render-job",
      event: event({ id: "render-event", stage: "render" }),
      project: current.project,
      storyboard: current.storyboard,
      consistency_report: current.consistency_report,
      render_report: {
        version: "1.0",
        outputs: [{
          path: "renders/final.mp4",
          format: "mp4",
          resolution: "720x1280",
          duration_seconds: 25,
        }],
      },
      final_path: "renders/final.mp4",
    });
    apiMocks.loadProject.mockRejectedValue(new Error("authoritative refresh failed"));
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue("local://media/final-response");
    renderProvider();
    await openProject(current);
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Render final" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(apiMocks.loadProject).toHaveBeenCalledWith("p1");
    expect(screen.getByTestId("snapshot")).toHaveTextContent('"final_path":null');
    expect(localMediaStoreMocks.cacheRemoteMedia).not.toHaveBeenCalled();
    expect(screen.getByTestId("error")).toBeEmptyDOMElement();
  });

  it("waits for persisted render metadata when an immediate refresh is incomplete", async () => {
    const current = projectResponse();
    const postRender = cloneProjectResponse(current);
    postRender.project.title = "POST render title";
    postRender.storyboard.shots[0].prompt = "POST render storyboard";
    postRender.consistency_report = { score: 91, issues: [] };
    apiMocks.renderProject.mockResolvedValue({
      job_id: "render-incomplete-refresh",
      event: event({ id: "render-incomplete-refresh", stage: "render" }),
      project: postRender.project,
      storyboard: postRender.storyboard,
      consistency_report: postRender.consistency_report,
      render_report: {
        version: "1.0",
        outputs: [{
          path: "renders/final.mp4",
          format: "mp4",
          resolution: "720x1280",
          duration_seconds: 25,
        }],
      },
      final_path: "renders/final.mp4",
    });
    const incomplete = cloneProjectResponse(current);
    incomplete.project.title = "Stale incomplete GET title";
    incomplete.storyboard.shots[0].prompt = "Stale incomplete GET storyboard";
    incomplete.consistency_report = { score: 12, issues: [] };
    incomplete.render_report = null;
    incomplete.final_path = null;
    apiMocks.loadProject.mockResolvedValue(incomplete);
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue("local://media/render-incomplete-refresh");
    renderProvider();
    await openProject(current);
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Render final" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    await waitFor(() => expect(apiMocks.loadProject).toHaveBeenCalledWith("p1"));
    expect(screen.getByTestId("snapshot")).toHaveTextContent('"render_report":null');
    expect(screen.getByTestId("snapshot")).toHaveTextContent('"final_path":null');
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("POST render");
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("Stale incomplete GET");
    expect(localMediaStoreMocks.cacheRemoteMedia).not.toHaveBeenCalled();
  });

  it("preserves a newer shot save that lands while rendered media is caching", async () => {
    const current = projectResponse();
    const finalCache = deferred<string | null>();
    const authoritative = cloneProjectResponse(current);
    authoritative.storyboard.shots[0].prompt = "Newer save survived render cache";
    authoritative.render_report = {
      version: "1.0",
      outputs: [{
        path: "renders/final.mp4",
        format: "mp4",
        resolution: "720x1280",
        duration_seconds: 25,
      }],
    };
    authoritative.final_path = "renders/final.mp4";
    apiMocks.renderProject.mockResolvedValue({
      job_id: "render-cache-race",
      event: event({ id: "render-cache-race", stage: "render" }),
      project: current.project,
      storyboard: current.storyboard,
      consistency_report: current.consistency_report,
      render_report: {
        version: "1.0",
        outputs: [{
          path: "renders/final.mp4",
          format: "mp4",
          resolution: "720x1280",
          duration_seconds: 25,
        }],
      },
      final_path: "renders/final.mp4",
    });
    apiMocks.saveShot.mockResolvedValue({
      job_id: "save-during-render-cache",
      event: event({ id: "save-during-render-cache" }),
      shot: authoritative.storyboard.shots[0],
      storyboard: authoritative.storyboard,
      consistency_report: authoritative.consistency_report,
    });
    const authoritativeRefresh = deferred<ShortDramaProjectResponse>();
    apiMocks.loadProject.mockReturnValue(authoritativeRefresh.promise);
    localMediaStoreMocks.cacheRemoteMedia
      .mockReturnValueOnce(finalCache.promise);
    renderProvider();
    await openProject(current);
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Render final" }));
    await waitFor(() => expect(apiMocks.loadProject).toHaveBeenCalledTimes(1));
    authoritativeRefresh.resolve(authoritative);
    await waitFor(() => expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));
    await waitFor(() => expect(screen.getByTestId("snapshot")).toHaveTextContent("Newer save survived render cache"));

    finalCache.resolve("local://media/render-cache-authoritative");
    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(screen.getByTestId("snapshot")).toHaveTextContent("Newer save survived render cache");
    expect(screen.getByTestId("snapshot")).toHaveTextContent('"render_report":null');
    expect(screen.getByTestId("snapshot")).toHaveTextContent('"final_path":null');
    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        storyboard: expect.objectContaining({
          shots: expect.arrayContaining([
            expect.objectContaining({ prompt: "Newer save survived render cache" }),
          ]),
        }),
        render_report: null,
        final_path: null,
      }),
    );
    expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledTimes(1);
  });

  it("does not reconcile or cache a render after a newer shot save lands during refresh", async () => {
    const current = projectResponse();
    const renderReport = {
      version: "1.0" as const,
      outputs: [{
        path: "renders/final.mp4",
        format: "mp4",
        resolution: "720x1280",
        duration_seconds: 25,
      }],
    };
    const firstRefresh = deferred<ShortDramaProjectResponse>();
    const staleRefresh = cloneProjectResponse(current);
    staleRefresh.render_report = renderReport;
    staleRefresh.final_path = "renders/final.mp4";
    const combined = cloneProjectResponse(staleRefresh);
    combined.storyboard.shots[0].prompt = "Newer shot survived render";
    apiMocks.renderProject.mockResolvedValue({
      job_id: "render-race",
      event: event({ id: "render-race", stage: "render" }),
      project: current.project,
      storyboard: current.storyboard,
      consistency_report: current.consistency_report,
      render_report: renderReport,
      final_path: "renders/final.mp4",
    });
    apiMocks.loadProject
      .mockReturnValueOnce(firstRefresh.promise)
      .mockResolvedValueOnce(combined);
    apiMocks.saveShot.mockResolvedValue({
      job_id: "newer-save-render",
      event: event({ id: "newer-save-render" }),
      shot: combined.storyboard.shots[0],
      storyboard: combined.storyboard,
      consistency_report: combined.consistency_report,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue("local://media/render-race");
    renderProvider();
    await openProject(current);
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Render final" }));
    await waitFor(() => expect(apiMocks.loadProject).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));
    await waitFor(() => expect(screen.getByTestId("snapshot")).toHaveTextContent("Newer shot survived render"));

    firstRefresh.resolve(staleRefresh);

    await waitFor(() => expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("local-backup-status")).toHaveTextContent("idle"));
    expect(apiMocks.loadProject).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("snapshot")).toHaveTextContent("Newer shot survived render");
    expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/render-race");
  });

  it("resolves and downloads a browser-local final video", async () => {
    const current = projectResponse();
    current.final_path = "local://media/final-1";
    localMediaStoreMocks.loadMediaBlob.mockResolvedValue(
      new Blob(["final-video"], { type: "video/mp4" }),
    );
    const createObjectUrl = vi.fn(() => "blob:download-final");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const click = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
      const element = originalCreateElement(tagName, options);
      if (tagName.toLowerCase() === "a") element.click = click;
      return element;
    });
    renderProvider();
    await openProject(current);

    await waitFor(() => expect(localMediaUrlMocks.resolveLocalMediaUrl).toHaveBeenCalledWith("local://media/final-1"));
    expect(screen.getByTestId("final-url")).toHaveTextContent("blob:local://media/final-1");
    fireEvent.click(screen.getByRole("button", { name: "Download final" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(localMediaStoreMocks.loadMediaBlob).toHaveBeenCalledWith("local://media/final-1");
    const link = createElement.mock.results.find((result) => result.value instanceof HTMLAnchorElement)
      ?.value as HTMLAnchorElement;
    expect(link.download).toBe("Rain Alley-final.mp4");
    expect(click).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:download-final");
  });

  it("downloads a server final video from its real media URL", async () => {
    const current = projectResponse();
    current.final_path = "renders/final.mp4";
    const click = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
      const element = originalCreateElement(tagName, options);
      if (tagName.toLowerCase() === "a") element.click = click;
      return element;
    });
    renderProvider();
    await openProject(current);

    fireEvent.click(screen.getByRole("button", { name: "Download final" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    const link = createElement.mock.results.find((result) => result.value instanceof HTMLAnchorElement)
      ?.value as HTMLAnchorElement;
    expect(link.download).toBe("Rain Alley-final.mp4");
    expect(link.getAttribute("href")).toBe("/api/projects/p1/media/renders/final.mp4");
    expect(click).toHaveBeenCalled();
    expect(localMediaStoreMocks.loadMediaBlob).not.toHaveBeenCalled();
  });

  it("fully resets a stale media resolution after its project is no longer active", async () => {
    const projectA = projectWithId("p1", "Project A");
    projectA.final_path = "local://media/stale-final";
    const projectB = projectWithId("p2", "Project B");
    const resolution = deferred<string | null>();
    localMediaUrlMocks.resolveLocalMediaUrl.mockReturnValue(resolution.promise);
    localProjectStoreMocks.loadProjectSnapshot.mockImplementation((projectId: string) => Promise.resolve({
      id: projectId,
      title: projectId === "p1" ? "Project A" : "Project B",
      updatedAt: "2026-07-10T08:00:00Z",
      snapshot: cloneProjectResponse(projectId === "p1" ? projectA : projectB),
    }));
    renderProvider();

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(localMediaUrlMocks.resolveLocalMediaUrl).toHaveBeenCalledWith("local://media/stale-final"));
    fireEvent.click(screen.getByRole("button", { name: "Open second project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));

    resolution.resolve("blob:stale-final");

    await waitFor(() => expect(localMediaUrlMocks.revokeLocalMediaUrls).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("local-media")).not.toHaveTextContent("blob:stale-final");
  });

  it("resolves a new project generation while an old media resolution never settles", async () => {
    const projectA = projectWithId("p1", "Project A");
    projectA.final_path = "local://media/never-settles";
    const projectB = projectWithId("p2", "Project B");
    projectB.final_path = "local://media/new-generation";
    const oldResolution = deferred<string | null>();
    localMediaUrlMocks.resolveLocalMediaUrl.mockImplementation((ref: string) => (
      ref === "local://media/never-settles"
        ? oldResolution.promise
        : Promise.resolve("blob:new-generation")
    ));
    localProjectStoreMocks.loadProjectSnapshot.mockImplementation((projectId: string) => {
      const loaded = projectId === "p1" ? projectA : projectB;
      return Promise.resolve(localProjectRecord(loaded, 1));
    });
    renderProvider();

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(localMediaUrlMocks.resolveLocalMediaUrl)
      .toHaveBeenCalledWith("local://media/never-settles"));
    fireEvent.click(screen.getByRole("button", { name: "Open second project" }));

    await waitFor(() => expect(localMediaUrlMocks.resolveLocalMediaUrl)
      .toHaveBeenCalledWith("local://media/new-generation"));
    expect(screen.getByTestId("final-url")).toHaveTextContent("blob:new-generation");
  });

  it("does not spin while an internal local media ref is unavailable", async () => {
    const current = projectResponse();
    current.final_path = "local://media/missing-final";
    localMediaUrlMocks.resolveLocalMediaUrl
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(new Promise(() => undefined));
    renderProvider();

    await openProject(current);

    await waitFor(() => expect(localMediaUrlMocks.resolveLocalMediaUrl).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(localMediaUrlMocks.resolveLocalMediaUrl).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("final-url")).toBeEmptyDOMElement();
  });

  it("retries a failed local media ref after the project generation resets", async () => {
    const projectA = projectWithId("p1", "Project A");
    projectA.final_path = "local://media/retry-after-reset";
    const projectB = projectWithId("p2", "Project B");
    localProjectStoreMocks.loadProjectSnapshot.mockImplementation((projectId: string) => Promise.resolve({
      id: projectId,
      title: projectId === "p1" ? "Project A" : "Project B",
      updatedAt: "2026-07-11T08:00:00Z",
      snapshot: cloneProjectResponse(projectId === "p1" ? projectA : projectB),
    }));
    localMediaUrlMocks.resolveLocalMediaUrl
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("blob:retry-after-reset");
    renderProvider();

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(localMediaUrlMocks.resolveLocalMediaUrl).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("final-url")).toBeEmptyDOMElement();

    fireEvent.click(screen.getByRole("button", { name: "Open second project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));

    await waitFor(() => expect(localMediaUrlMocks.resolveLocalMediaUrl).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("final-url")).toHaveTextContent("blob:retry-after-reset");
  });

  it("resets orphaned media and rebuilds retained refs after a same-project refresh", async () => {
    const current = projectResponse();
    current.final_path = "local://media/retained-final";
    current.storyboard.shots[0].output_path = "local://media/orphaned-shot";
    const refreshed = cloneProjectResponse(current);
    refreshed.storyboard.shots[0].output_path = null;
    const plan = current.continuity_plan as ContinuityPlan;
    apiMocks.saveContinuityPlan.mockResolvedValue({
      project: current.project,
      continuity_plan: plan,
    });
    apiMocks.loadProject.mockResolvedValue(refreshed);
    let retainedResolution = 0;
    localMediaUrlMocks.resolveLocalMediaUrl.mockImplementation((ref: string) => Promise.resolve(
      ref.endsWith("retained-final")
        ? `blob:retained-final-${++retainedResolution}`
        : "blob:orphaned-shot",
    ));
    renderProvider();
    await openProject(current);
    await waitFor(() => {
      expect(screen.getByTestId("local-media")).toHaveTextContent("blob:retained-final-1");
      expect(screen.getByTestId("local-media")).toHaveTextContent("blob:orphaned-shot");
    });

    fireEvent.click(screen.getByRole("button", { name: "Save continuity" }));

    await waitFor(() => expect(localMediaUrlMocks.revokeLocalMediaUrls).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("local-media")).toHaveTextContent("blob:retained-final-2"));
    expect(screen.getByTestId("local-media")).not.toHaveTextContent("blob:orphaned-shot");
  });

  it("returns a fresh resolver URL when an orphaned same-project ref is re-added", async () => {
    const current = projectResponse();
    current.storyboard.shots[0].output_path = "local://media/reappearing-shot";
    const refreshed = cloneProjectResponse(current);
    refreshed.storyboard.shots[0].output_path = null;
    apiMocks.saveContinuityPlan.mockResolvedValue({
      project: current.project,
      continuity_plan: current.continuity_plan as ContinuityPlan,
    });
    apiMocks.loadProject.mockResolvedValue(refreshed);
    localMediaUrlMocks.resolveLocalMediaUrl
      .mockResolvedValueOnce("blob:reappearing-shot-old")
      .mockResolvedValueOnce("blob:reappearing-shot-fresh");
    renderProvider();
    await openProject(current);
    await waitFor(() => expect(screen.getByTestId("local-media")).toHaveTextContent("blob:reappearing-shot-old"));

    fireEvent.click(screen.getByRole("button", { name: "Save continuity" }));
    await waitFor(() => expect(localMediaUrlMocks.revokeLocalMediaUrls).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("local-media")).not.toHaveTextContent("blob:reappearing-shot-old");

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));

    await waitFor(() => expect(localMediaUrlMocks.revokeLocalMediaUrls).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(localMediaUrlMocks.resolveLocalMediaUrl).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("local-media")).toHaveTextContent("blob:reappearing-shot-fresh");
  });

  it("deduplicates subscribed project events", async () => {
    renderProvider();
    await openProject();
    await waitFor(() => expect(apiMocks.subscribeProjectEvents).toHaveBeenCalledWith("p1", expect.any(Function)));
    const onEvent = apiMocks.subscribeProjectEvents.mock.calls[0]?.[1] as (next: JobEvent) => void;
    const next = event({ id: "duplicate-event", message: "Rendering final video" });

    onEvent(next);
    onEvent({ ...next, created_at: "2026-07-10T08:00:01Z" });

    await waitFor(() => expect(JSON.parse(screen.getByTestId("events").textContent ?? "[]")).toHaveLength(1));
    expect(screen.getByTestId("events")).toHaveTextContent("Rendering final video");
  });

  it("keeps bilingual shot workflow strings available", () => {
    const en = getStrings("en");
    expect(en.shotEditor.saveAction).toBe("Save changes");
    expect(en.shotEditor.regenerateAction).toBe("Regenerate video");
    expect(zh.shotEditor.saveAction).toBeTruthy();
    expect(zh.shotEditor.regenerateAction).toBeTruthy();
  });
});
