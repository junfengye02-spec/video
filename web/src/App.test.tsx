import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
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
import { WorkbenchProvider } from "./app/workbench/WorkbenchProvider";
import { useWorkbench } from "./app/workbench/useWorkbench";
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
vi.mock("./localdb/projectStore", () => localProjectStoreMocks);
vi.mock("./localdb/mediaStore", () => localMediaStoreMocks);
vi.mock("./localdb/mediaUrls", () => localMediaUrlMocks);
vi.mock("./localdb/exportProject", () => localExportMocks);
vi.mock("./localdb/storageEstimate", () => localStorageEstimateMocks);

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
      <label>
        Text credential
        <input
          value={workbench.providerCredentials.text_key}
          onChange={(input) => workbench.updateProviderField("text_key", input.target.value)}
        />
      </label>
      <label>
        Image credential
        <input
          value={workbench.providerCredentials.image_key}
          onChange={(input) => workbench.updateProviderField("image_key", input.target.value)}
        />
      </label>
      <label>
        Video credential
        <input
          value={workbench.providerCredentials.video_key}
          onChange={(input) => workbench.updateProviderField("video_key", input.target.value)}
        />
      </label>
      <label>
        Base URL credential
        <input
          value={workbench.providerCredentials.base_url}
          onChange={(input) => workbench.updateProviderField("base_url", input.target.value)}
        />
      </label>
      <button type="button" onClick={() => run(() => workbench.openLocalProject("p1"))}>Open project</button>
      <button type="button" onClick={() => run(() => workbench.openLocalProject("p2"))}>Open second project</button>
      <button type="button" onClick={() => run(workbench.saveProvider)}>Save provider</button>
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
      <output data-testid="provider-ready">{String(workbench.providerReady)}</output>
      <output data-testid="local-media">{JSON.stringify(workbench.localMediaUrls)}</output>
      <output data-testid="local-backup-status">{workbench.localBackupStatus}</output>
    </div>
  );
}

function renderProvider() {
  return render(
    <WorkbenchProvider>
      <ProviderHarness />
    </WorkbenchProvider>,
  );
}

function setCredentials(values: { text?: string; image?: string; video?: string; baseUrl?: string } = {}) {
  fireEvent.change(screen.getByLabelText("Text credential"), {
    target: { value: values.text ?? "text-key" },
  });
  fireEvent.change(screen.getByLabelText("Image credential"), {
    target: { value: values.image ?? "image-key" },
  });
  fireEvent.change(screen.getByLabelText("Video credential"), {
    target: { value: values.video ?? "video-key" },
  });
  if (values.baseUrl !== undefined) {
    fireEvent.change(screen.getByLabelText("Base URL credential"), {
      target: { value: values.baseUrl },
    });
  }
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
    apiMocks.saveGatewayKey.mockResolvedValue({
      masked_keys: { text: "***text", image: "***image", video: "***video" },
      provider: "syapi",
      base_url: "https://example.invalid",
      models: { text: "text-model", image: "image-model", video: "video-model" },
      valid: true,
    });
    apiMocks.subscribeProjectEvents.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
  });

  it("uses the routed application entry and opens the provider drawer", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: zh.projectsPage.title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "接口配置" }));
    expect(screen.getByLabelText(zh.keyGate.textKeyLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.keyGate.imageKeyLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.keyGate.videoKeyLabel)).toBeInTheDocument();
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

  it("hydrates exact committed shot, final, and asset media before opening a local project", async () => {
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

  it("creates and persists a project without sending a shot count", async () => {
    renderProvider();
    setCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(screen.getByTestId("provider-ready")).toHaveTextContent("true"));
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(apiMocks.createShortDramaProject).toHaveBeenCalledWith({
      title: "Rain Alley",
      prompt: "A letter changes two lives",
      project_type: "single_video",
      text_key: "text-key",
      image_key: "image-key",
      video_key: "video-key",
      base_url: "https://example.invalid",
      text_model: "text-model",
      image_model: "image-model",
      video_model: "video-model",
    });
    expect(apiMocks.createShortDramaProject.mock.calls[0]?.[0]).not.toHaveProperty("shot_count");
    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ project: expect.objectContaining({ id: "p1" }), final_path: null }),
    );
  });

  it("rejects project creation until the current complete credentials are verified", async () => {
    renderProvider();
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("rejected"));
    expect(apiMocks.createShortDramaProject).not.toHaveBeenCalled();
    expect(screen.getByTestId("error")).toHaveTextContent(zh.errors.createStoryboardRequiresKeys);
  });

  it("invalidates provider readiness whenever a verified credential changes", async () => {
    renderProvider();
    setCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(screen.getByTestId("provider-ready")).toHaveTextContent("true"));

    fireEvent.change(screen.getByLabelText("Video credential"), {
      target: { value: "different-video-key" },
    });

    expect(screen.getByTestId("provider-ready")).toHaveTextContent("false");
  });

  it("rejects an invalid provider session without installing masked keys", async () => {
    apiMocks.saveGatewayKey.mockResolvedValue({
      masked_keys: { text: "***text", image: "***image", video: "***video" },
      provider: "syapi",
      base_url: "https://example.invalid",
      models: { text: "text-model", image: "image-model", video: "video-model" },
      valid: false,
    });
    renderProvider();
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("rejected"));
    expect(screen.getByTestId("provider-ready")).toHaveTextContent("false");
    expect(screen.getByTestId("error")).toHaveTextContent(zh.errors.saveKeysFallback);
  });

  it("clears previously verified readiness when provider revalidation is invalid", async () => {
    renderProvider();
    setCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(screen.getByTestId("provider-ready")).toHaveTextContent("true"));
    apiMocks.saveGatewayKey.mockResolvedValueOnce({
      masked_keys: { text: "***text", image: "***image", video: "***video" },
      provider: "syapi",
      base_url: "https://example.invalid",
      models: { text: "text-model", image: "image-model", video: "video-model" },
      valid: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("rejected"));
    expect(screen.getByTestId("provider-ready")).toHaveTextContent("false");
  });

  it("defensively rejects an empty project prompt", async () => {
    renderProvider();
    setCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() => expect(screen.getByTestId("provider-ready")).toHaveTextContent("true"));

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
    expect(apiMocks.saveShot.mock.calls[0]?.[2]).not.toHaveProperty("video_key");
    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ storyboard: updated.storyboard, render_report: null, final_path: null }),
    );

    apiMocks.saveShot.mockRejectedValueOnce(new Error("save failed"));
    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));
    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("rejected"));
    expect(screen.getByTestId("error")).toHaveTextContent("save failed");
  });

  it("optimizes with the exact shot payload and the default base URL", async () => {
    apiMocks.optimizePrompt.mockResolvedValue({
      project_id: "p1",
      model: "gpt-5.5",
      optimized_text: "Optimized shot",
      notes: [],
    });
    renderProvider();
    await openProject();
    setCredentials({ baseUrl: "" });

    fireEvent.click(screen.getByRole("button", { name: "Optimize shot" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(apiMocks.optimizePrompt).toHaveBeenCalledWith("p1", {
      target: "shot",
      target_id: "shot-1",
      source_text: "Mara in a red coat finds the envelope.",
      text_key: "text-key",
      base_url: "https://api.0000238.xyz",
      text_model: "gpt-5.5",
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

  it("caches regenerated shot media locally and persists the updated snapshot", async () => {
    const current = projectResponse();
    const regeneratedShot: Shot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/shot-1.mp4",
      output_url: null,
    };
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "regenerate-job",
      event: event({ id: "regenerate-event", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: {
        shots: [regeneratedShot, current.storyboard.shots[1]],
      },
      consistency_report: current.consistency_report,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue("local://media/shot-1");
    renderProvider();
    await openProject(current);
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(apiMocks.regenerateShot).toHaveBeenCalledWith("p1", "shot-1", {
      video_key: "video-key",
      base_url: "https://api.0000238.xyz",
      video_model: "omni_flash-10s",
    });
    expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledWith(
      "/api/projects/p1/media/assets/video/shot-1.mp4",
      {
        projectId: "p1",
        projectIncarnation: "incarnation-default",
        sourcePath: "assets/video/shot-1.mp4",
      },
    );
    expect(localProjectStoreMocks.saveProjectSnapshotIfVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        storyboard: expect.objectContaining({
          shots: expect.arrayContaining([
            expect.objectContaining({ id: "shot-1", output_path: "local://media/shot-1" }),
          ]),
        }),
      }),
      { incarnation: "incarnation-default", revision: 1 },
    );
  });

  it("publishes regenerated remote media and resolves before background caching completes", async () => {
    const current = projectResponse();
    const cache = deferred<string | null>();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/shot-remote.mp4",
      output_url: null,
    };
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "regenerate-remote-first",
      event: event({ id: "regenerate-remote-first", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: { ...current.storyboard, shots: [regeneratedShot, current.storyboard.shots[1]] },
      consistency_report: current.consistency_report,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockReturnValue(cache.promise);
    renderProvider();
    await openProject(current);
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(screen.getByTestId("busy")).toHaveTextContent('"regeneratingShotId":null');
    expect(screen.getByTestId("snapshot")).toHaveTextContent("assets/video/shot-remote.mp4");
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("local://media/shot-remote");
    expect(screen.getByTestId("local-backup-status")).toHaveTextContent("saving");

    cache.resolve("local://media/shot-remote");
    await waitFor(() => expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/shot-remote"));
    expect(screen.getByTestId("local-backup-status")).toHaveTextContent("idle");
  });

  it("starts regenerated media caching in a macrotask after public completion and busy clear", async () => {
    const current = projectResponse();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/macrotask-shot.mp4",
      output_url: null,
    };
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "regenerate-macrotask",
      event: event({ id: "regenerate-macrotask", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: { ...current.storyboard, shots: [regeneratedShot, current.storyboard.shots[1]] },
      consistency_report: current.consistency_report,
    });
    const eventLog: string[] = [];
    localMediaStoreMocks.cacheRemoteMedia.mockImplementation(() => {
      eventLog.push(
        `cache:${screen.getByTestId("outcome").textContent}:`
        + `${screen.getByTestId("busy").textContent?.includes('"regeneratingShotId":null')}`,
      );
      return Promise.resolve("local://media/macrotask-shot");
    });
    renderProvider();
    await openProject(current);
    setCredentials();
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));
    await act(flushPromiseQueue);

    expect(screen.getByTestId("outcome")).toHaveTextContent("resolved");
    expect(screen.getByTestId("busy")).toHaveTextContent('"regeneratingShotId":null');
    expect(localMediaStoreMocks.cacheRemoteMedia).not.toHaveBeenCalled();
    eventLog.push("public:resolved:true");

    await act(async () => {
      vi.runOnlyPendingTimers();
      await flushPromiseQueue();
    });

    expect(eventLog).toEqual(["public:resolved:true", "cache:resolved:true"]);
  });

  it("cancels scheduled regenerated media caching when the provider unmounts", async () => {
    const current = projectResponse();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/unmounted-scheduled-shot.mp4",
      output_url: null,
    };
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "unmounted-scheduled-regenerate",
      event: event({ id: "unmounted-scheduled-regenerate", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: { ...current.storyboard, shots: [regeneratedShot, current.storyboard.shots[1]] },
      consistency_report: current.consistency_report,
    });
    const rendered = renderProvider();
    await openProject(current);
    setCredentials();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));
    await act(flushPromiseQueue);
    expect(screen.getByTestId("outcome")).toHaveTextContent("resolved");

    rendered.unmount();
    await act(async () => {
      vi.runOnlyPendingTimers();
      await flushPromiseQueue();
    });

    expect(localMediaStoreMocks.cacheRemoteMedia).not.toHaveBeenCalled();
    expect(localProjectStoreMocks.saveProjectSnapshotIfVersion).not.toHaveBeenCalled();
  });

  it("builds the promotion candidate from a manual save completed before its CAS macrotask", async () => {
    const current = projectResponse();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/pre-cas-edit.mp4",
      output_url: null,
    };
    const manuallySaved = cloneProjectResponse(current);
    manuallySaved.storyboard.shots[0] = {
      ...regeneratedShot,
      prompt: "Manual edit before promotion CAS",
    };
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "pre-cas-regenerate",
      event: event({ id: "pre-cas-regenerate", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: { ...current.storyboard, shots: [regeneratedShot, current.storyboard.shots[1]] },
      consistency_report: current.consistency_report,
    });
    apiMocks.saveShot.mockResolvedValue({
      job_id: "pre-cas-manual-save",
      event: event({ id: "pre-cas-manual-save" }),
      shot: manuallySaved.storyboard.shots[0],
      storyboard: manuallySaved.storyboard,
      consistency_report: manuallySaved.consistency_report,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue("local://media/pre-cas-edit");
    renderProvider();
    await openProject(current);
    setCredentials();
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));
    await act(flushPromiseQueue);
    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));
    await act(flushPromiseQueue);
    expect(screen.getByTestId("snapshot")).toHaveTextContent("Manual edit before promotion CAS");
    expect(localProjectStoreMocks.saveProjectSnapshotIfVersion).not.toHaveBeenCalled();

    await act(async () => {
      vi.runOnlyPendingTimers();
      await flushPromiseQueue();
    });

    expect(localProjectStoreMocks.saveProjectSnapshotIfVersion).toHaveBeenCalledTimes(1);
    expect(localProjectStoreMocks.saveProjectSnapshotIfVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        storyboard: expect.objectContaining({
          shots: expect.arrayContaining([
            expect.objectContaining({
              output_path: "local://media/pre-cas-edit",
              prompt: "Manual edit before promotion CAS",
            }),
          ]),
        }),
      }),
      { incarnation: "incarnation-default", revision: 2 },
    );
  });

  it("promotes regenerated media with the primary save's exact durable revision", async () => {
    const current = projectResponse();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/cas-shot.mp4",
      output_url: null,
    };
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "regenerate-cas",
      event: event({ id: "regenerate-cas", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: { ...current.storyboard, shots: [regeneratedShot, current.storyboard.shots[1]] },
      consistency_report: current.consistency_report,
    });
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue(
      localProjectRecord(current, 4, "incarnation-cas"),
    );
    localProjectStoreMocks.saveProjectSnapshot.mockImplementation(
      (next: ShortDramaProjectResponse) => Promise.resolve(
        localProjectRecord(next, 5, "incarnation-cas"),
      ),
    );
    localProjectStoreMocks.saveProjectSnapshotIfVersion.mockImplementation(
      (next: ShortDramaProjectResponse, expected: { incarnation: string; revision: number }) => Promise.resolve(
        expected.incarnation === "incarnation-cas" && expected.revision === 5
          ? localProjectRecord(next, 6, "incarnation-cas")
          : null,
      ),
    );
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue("local://media/cas-shot");
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));

    await waitFor(() => expect(localProjectStoreMocks.saveProjectSnapshotIfVersion)
      .toHaveBeenCalledWith(expect.objectContaining({
        storyboard: expect.objectContaining({
          shots: expect.arrayContaining([
            expect.objectContaining({ output_path: "local://media/cas-shot" }),
          ]),
        }),
      }), { incarnation: "incarnation-cas", revision: 5 }));
    expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/cas-shot");
  });

  it("replaces a stale tracked revision when the same project id is loaded from new storage", async () => {
    const current = projectResponse();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/recreated-project.mp4",
      output_url: null,
    };
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "recreated-project-regenerate",
      event: event({ id: "recreated-project-regenerate", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: { ...current.storyboard, shots: [regeneratedShot, current.storyboard.shots[1]] },
      consistency_report: current.consistency_report,
    });
    localProjectStoreMocks.loadProjectSnapshot
      .mockResolvedValueOnce(localProjectRecord(current, 9, "incarnation-before-recreate"))
      .mockResolvedValueOnce(localProjectRecord(current, 1, "incarnation-after-recreate"));
    localProjectStoreMocks.saveProjectSnapshot.mockImplementation(
      (next: ShortDramaProjectResponse) => Promise.resolve(
        localProjectRecord(next, 2, "incarnation-after-recreate"),
      ),
    );
    localProjectStoreMocks.saveProjectSnapshotIfVersion.mockImplementation(
      (next: ShortDramaProjectResponse, expected: { incarnation: string; revision: number }) => Promise.resolve(
        expected.incarnation === "incarnation-after-recreate" && expected.revision === 2
          ? localProjectRecord(next, 3, "incarnation-after-recreate")
          : null,
      ),
    );
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue("local://media/recreated-project");
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(localProjectStoreMocks.loadProjectSnapshot).toHaveBeenCalledTimes(2));
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));

    await waitFor(() => expect(localProjectStoreMocks.saveProjectSnapshotIfVersion)
      .toHaveBeenCalledWith(expect.any(Object), {
        incarnation: "incarnation-after-recreate",
        revision: 2,
      }));
    expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/recreated-project");
  });

  it("does not recreate a deleted project when pending shot caching completes", async () => {
    const current = projectResponse();
    const cache = deferred<string | null>();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/deleted-project.mp4",
      output_url: null,
    };
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "deleted-project-cache",
      event: event({ id: "deleted-project-cache", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: { ...current.storyboard, shots: [regeneratedShot, current.storyboard.shots[1]] },
      consistency_report: current.consistency_report,
    });
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue(
      localProjectRecord(current, 3, "incarnation-deleted"),
    );
    localProjectStoreMocks.saveProjectSnapshot.mockImplementation(
      (next: ShortDramaProjectResponse) => Promise.resolve(
        localProjectRecord(next, 4, "incarnation-deleted"),
      ),
    );
    let exists = true;
    localProjectStoreMocks.deleteProject.mockImplementation(() => {
      exists = false;
      return Promise.resolve();
    });
    localProjectStoreMocks.saveProjectSnapshotIfVersion.mockImplementation(
      (next: ShortDramaProjectResponse, expected: { incarnation: string; revision: number }) => Promise.resolve(
        exists && expected.incarnation === "incarnation-deleted" && expected.revision === 4
          ? localProjectRecord(next, 5, "incarnation-deleted")
          : null,
      ),
    );
    localMediaStoreMocks.cacheRemoteMedia.mockReturnValue(cache.promise);
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    setCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));
    await waitFor(() => expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledTimes(1));

    await localProjectStoreMocks.deleteProject("p1");
    cache.resolve("local://media/deleted-project");

    await waitFor(() => expect(localProjectStoreMocks.saveProjectSnapshotIfVersion)
      .toHaveBeenCalledWith(expect.any(Object), {
        incarnation: "incarnation-deleted",
        revision: 4,
      }));
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("local://media/deleted-project");
    expect(localProjectStoreMocks.saveProjectSnapshot).not.toHaveBeenCalledWith(
      expect.objectContaining({
        storyboard: expect.objectContaining({
          shots: expect.arrayContaining([
            expect.objectContaining({ output_path: "local://media/deleted-project" }),
          ]),
        }),
      }),
    );
  });

  it("does not promote an old pending cache into a same-id recreated project at matching revision", async () => {
    const current = projectResponse();
    const cache = deferred<string | null>();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/aba-pending.mp4",
      output_url: null,
    };
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "aba-pending-regenerate",
      event: event({ id: "aba-pending-regenerate", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: { ...current.storyboard, shots: [regeneratedShot, current.storyboard.shots[1]] },
      consistency_report: current.consistency_report,
    });
    let durable = localProjectRecord(current, 1, "incarnation-old");
    localProjectStoreMocks.loadProjectSnapshot.mockImplementation(() => Promise.resolve(durable));
    localProjectStoreMocks.saveProjectSnapshot.mockImplementation((next: ShortDramaProjectResponse) => {
      durable = localProjectRecord(
        next,
        (durable.revision ?? 0) + 1,
        (durable as LocalProjectSnapshot & { incarnation: string }).incarnation,
      );
      return Promise.resolve(durable);
    });
    const conditionalSave = (
      next: ShortDramaProjectResponse,
      expected: { incarnation: string; revision: number },
    ) => {
      const currentVersion = {
        incarnation: (durable as LocalProjectSnapshot & { incarnation: string }).incarnation,
        revision: durable.revision ?? 0,
      };
      const matches = expected.incarnation === currentVersion.incarnation
        && expected.revision === currentVersion.revision;
      if (!matches) return Promise.resolve(null);
      durable = localProjectRecord(next, currentVersion.revision + 1, currentVersion.incarnation);
      return Promise.resolve(durable);
    };
    localProjectStoreMocks.saveProjectSnapshotIfVersion.mockImplementation(conditionalSave);
    localMediaStoreMocks.cacheRemoteMedia.mockReturnValue(cache.promise);
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    setCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));
    await waitFor(() => expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledTimes(1));

    const recreated = cloneProjectResponse(durable.snapshot);
    recreated.project.title = "Recreated same ID";
    durable = localProjectRecord(recreated, 2, "incarnation-new");
    cache.resolve("local://media/aba-pending");

    await waitFor(() => expect(screen.getByTestId("local-backup-status")).toHaveTextContent("idle"));
    expect(durable).toMatchObject({
      incarnation: "incarnation-new",
      revision: 2,
      title: "Recreated same ID",
    });
    expect(durable.snapshot.storyboard.shots[0].output_path).toBe("assets/video/aba-pending.mp4");
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("local://media/aba-pending");
  });

  it("does not persist a pending regenerated cache result after unmount", async () => {
    const current = projectResponse();
    const cache = deferred<string | null>();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/unmounted-pending-shot.mp4",
      output_url: null,
    };
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "unmounted-pending-regenerate",
      event: event({ id: "unmounted-pending-regenerate", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: { ...current.storyboard, shots: [regeneratedShot, current.storyboard.shots[1]] },
      consistency_report: current.consistency_report,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockReturnValue(cache.promise);
    const rendered = renderProvider();
    await openProject(current);
    setCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));
    await waitFor(() => expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledTimes(1));
    const primarySaveCount = localProjectStoreMocks.saveProjectSnapshot.mock.calls.length;

    rendered.unmount();
    cache.resolve("local://media/unmounted-pending-shot");
    await flushPromiseQueue();

    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenCalledTimes(primarySaveCount);
    expect(localProjectStoreMocks.saveProjectSnapshotIfVersion).not.toHaveBeenCalled();
  });

  it("keeps regenerated remote media successful when background caching fails", async () => {
    const current = projectResponse();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/shot-backup-fails.mp4",
      output_url: null,
    };
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "regenerate-cache-failure",
      event: event({ id: "regenerate-cache-failure", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: { ...current.storyboard, shots: [regeneratedShot, current.storyboard.shots[1]] },
      consistency_report: current.consistency_report,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockRejectedValue(new Error("cache unavailable"));
    renderProvider();
    await openProject(current);
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));

    await waitFor(() => expect(screen.getByTestId("local-backup-status")).toHaveTextContent("retrying"));
    expect(screen.getByTestId("outcome")).toHaveTextContent("resolved");
    expect(screen.getByTestId("snapshot")).toHaveTextContent("assets/video/shot-backup-fails.mp4");
    expect(screen.getByTestId("error")).toBeEmptyDOMElement();
  });

  it("does not promote stale regenerated media after a newer manual shot save", async () => {
    const current = projectResponse();
    const cachedMedia = deferred<string | null>();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/shot-1.mp4",
      output_url: null,
    };
    const saved = cloneProjectResponse(current);
    saved.storyboard.shots[0].prompt = "Newer save survived regeneration cache";
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "regenerate-cache-race",
      event: event({ id: "regenerate-cache-race", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: {
        ...current.storyboard,
        shots: [regeneratedShot, current.storyboard.shots[1]],
      },
      consistency_report: current.consistency_report,
    });
    apiMocks.saveShot.mockResolvedValue({
      job_id: "save-during-regenerate-cache",
      event: event({ id: "save-during-regenerate-cache" }),
      shot: saved.storyboard.shots[0],
      storyboard: saved.storyboard,
      consistency_report: saved.consistency_report,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockReturnValue(cachedMedia.promise);
    renderProvider();
    await openProject(current);
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));
    await waitFor(() => expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));
    await waitFor(() => expect(screen.getByTestId("snapshot")).toHaveTextContent("Newer save survived regeneration cache"));

    cachedMedia.resolve("local://media/regenerate-cache-race");

    await waitFor(() => expect(screen.getByTestId("local-backup-status")).toHaveTextContent("idle"));
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("local://media/regenerate-cache-race");
    expect(screen.getByTestId("snapshot")).toHaveTextContent("Newer save survived regeneration cache");
  });

  it("lets five newer primary saves win after a successful promotion CAS becomes stale", async () => {
    const current = projectResponse();
    const promotionResolution = deferred<void>();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/persistence-race.mp4",
      output_url: null,
    };
    const regenerated = cloneProjectResponse(current);
    regenerated.storyboard = {
      ...current.storyboard,
      shots: [regeneratedShot, current.storyboard.shots[1]],
    };
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "promotion-persistence-race",
      event: event({ id: "promotion-persistence-race", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: regenerated.storyboard,
      consistency_report: current.consistency_report,
    });
    let manualSave = 0;
    apiMocks.saveShot.mockImplementation(() => {
      manualSave += 1;
      const next = cloneProjectResponse(regenerated);
      next.storyboard.shots[0].prompt = `Manual durable edit ${manualSave}`;
      return Promise.resolve({
        job_id: `manual-save-persistence-race-${manualSave}`,
        event: event({ id: `manual-save-persistence-race-${manualSave}` }),
        shot: next.storyboard.shots[0],
        storyboard: next.storyboard,
        consistency_report: next.consistency_report,
      });
    });
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue("local://media/persistence-race");

    let durable = localProjectRecord(current, 1, "incarnation-old");
    localProjectStoreMocks.loadProjectSnapshot.mockImplementation(() => Promise.resolve(
      localProjectRecord(durable.snapshot, durable.revision ?? 0, durable.incarnation),
    ));
    localProjectStoreMocks.saveProjectSnapshot.mockImplementation(
      (next: ShortDramaProjectResponse) => {
        durable = localProjectRecord(
          next,
          (durable.revision ?? 0) + 1,
          durable.incarnation,
        );
        return Promise.resolve(localProjectRecord(
          durable.snapshot,
          durable.revision ?? 0,
          durable.incarnation,
        ));
      },
    );
    let promotionRecord: LocalProjectSnapshot | null = null;
    localProjectStoreMocks.saveProjectSnapshotIfVersion.mockImplementation(
      (next: ShortDramaProjectResponse, expected: { incarnation: string; revision: number }) => {
        if (
          durable.incarnation !== expected.incarnation
          || (durable.revision ?? 0) !== expected.revision
        ) return Promise.resolve(null);
        durable = localProjectRecord(next, expected.revision + 1, expected.incarnation);
        if (!promotionRecord) {
          promotionRecord = localProjectRecord(
            durable.snapshot,
            durable.revision ?? 0,
            durable.incarnation,
          );
          return promotionResolution.promise.then(() => promotionRecord);
        }
        return Promise.resolve(localProjectRecord(
          durable.snapshot,
          durable.revision ?? 0,
          durable.incarnation,
        ));
      },
    );
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));
    await waitFor(() => expect(localProjectStoreMocks.saveProjectSnapshotIfVersion)
      .toHaveBeenCalledWith(expect.objectContaining({
        storyboard: expect.objectContaining({
          shots: expect.arrayContaining([
            expect.objectContaining({ output_path: "local://media/persistence-race" }),
          ]),
        }),
      }), { incarnation: "incarnation-old", revision: 2 }));

    for (let index = 1; index <= 5; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Save shot" }));
      await waitFor(() => expect(screen.getByTestId("snapshot"))
        .toHaveTextContent(`Manual durable edit ${index}`));
    }

    promotionResolution.resolve();
    await waitFor(() => expect(localProjectStoreMocks.saveProjectSnapshotIfVersion)
      .toHaveBeenCalledTimes(2));
    expect(localProjectStoreMocks.saveProjectSnapshotIfVersion.mock.calls[1]?.[1]).toEqual({
      incarnation: "incarnation-old",
      revision: 3,
    });
    expect(durable.revision).toBe(8);
    expect(durable.snapshot.storyboard.shots[0].prompt).toBe("Manual durable edit 5");
    expect(durable.snapshot.storyboard.shots[0].output_path).toBe("assets/video/persistence-race.mp4");

    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(screen.getByTestId("snapshot")).toHaveTextContent("Manual durable edit 5"));
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("local://media/persistence-race");
  });

  it("keeps backup status saving while a later overlapping cache is still pending", async () => {
    const current = projectResponse();
    const firstCache = deferred<string | null>();
    const secondCache = deferred<string | null>();
    const firstShot = { ...current.storyboard.shots[0], output_path: "assets/video/first.mp4", output_url: null };
    const secondShot = { ...firstShot, output_path: "assets/video/second.mp4", version: firstShot.version + 1 };
    apiMocks.regenerateShot
      .mockResolvedValueOnce({
        job_id: "first-cache",
        event: event({ id: "first-cache", stage: "regenerate" }),
        shot: firstShot,
        storyboard: { ...current.storyboard, shots: [firstShot, current.storyboard.shots[1]] },
        consistency_report: current.consistency_report,
      })
      .mockResolvedValueOnce({
        job_id: "second-cache",
        event: event({ id: "second-cache", stage: "regenerate" }),
        shot: secondShot,
        storyboard: { ...current.storyboard, shots: [secondShot, current.storyboard.shots[1]] },
        consistency_report: current.consistency_report,
      });
    localMediaStoreMocks.cacheRemoteMedia
      .mockReturnValueOnce(firstCache.promise)
      .mockReturnValueOnce(secondCache.promise);
    renderProvider();
    await openProject(current);
    setCredentials();

    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));
    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));
    await waitFor(() => expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledTimes(2));

    firstCache.resolve("local://media/first");
    await waitFor(() => expect(screen.getByTestId("local-backup-status")).toHaveTextContent("saving"));
    expect(screen.getByTestId("snapshot")).toHaveTextContent("assets/video/second.mp4");
    secondCache.resolve("local://media/second");
    await waitFor(() => expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/second"));
    expect(screen.getByTestId("local-backup-status")).toHaveTextContent("idle");
  });

  it("resets backup status and rejects promotion after switching projects", async () => {
    const current = projectResponse();
    const cache = deferred<string | null>();
    const regeneratedShot = {
      ...current.storyboard.shots[0],
      output_path: "assets/video/project-switch.mp4",
      output_url: null,
    };
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "project-switch-cache",
      event: event({ id: "project-switch-cache", stage: "regenerate" }),
      shot: regeneratedShot,
      storyboard: { ...current.storyboard, shots: [regeneratedShot, current.storyboard.shots[1]] },
      consistency_report: current.consistency_report,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockReturnValue(cache.promise);
    localProjectStoreMocks.loadProjectSnapshot.mockImplementation((projectId: string) => {
      const loaded = projectId === "p1" ? current : projectWithId("p2", "Project Two");
      return Promise.resolve({
        id: projectId,
        title: loaded.project.title,
        updatedAt: "2026-07-11T08:00:00Z",
        snapshot: cloneProjectResponse(loaded),
      });
    });
    renderProvider();
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    setCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));
    await waitFor(() => expect(screen.getByTestId("local-backup-status")).toHaveTextContent("saving"));

    fireEvent.click(screen.getByRole("button", { name: "Open second project" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));
    expect(screen.getByTestId("local-backup-status")).toHaveTextContent("idle");
    cache.resolve("local://media/project-switch");

    await waitFor(() => expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("local://media/project-switch");
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

  it("preserves browser-local media refs across a non-media authoritative refresh", async () => {
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
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("assets/video/shot-1.mp4");
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
    fireEvent.click(screen.getByRole("button", { name: "接口配置" }));
    fireEvent.change(screen.getByLabelText(zh.keyGate.videoKeyLabel), {
      target: { value: "video-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭接口配置" }));

    fireEvent.click(screen.getByRole("button", { name: "生成最终成片" }));

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
      video_key: "video-key",
      base_url: "https://api.0000238.xyz",
      video_model: "omni_flash-10s",
      render_runtime: "ffmpeg",
    });
    expect(apiMocks.loadProject).toHaveBeenCalledWith("p1");
    expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledTimes(1);
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
      { incarnation: "incarnation-default", revision: 2 },
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

    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenCalledTimes(primarySaveCount);
    expect(localProjectStoreMocks.saveProjectSnapshotIfVersion).not.toHaveBeenCalled();
    expect(localMediaStoreMocks.cacheRemoteMedia).not.toHaveBeenCalled();
  });

  it("retains the render response without publishing a refresh failure", async () => {
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
    expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/final-response");
    expect(screen.getByTestId("error")).toBeEmptyDOMElement();
  });

  it("retains render response metadata when an immediate refresh is incomplete", async () => {
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
    expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/render-incomplete-refresh");
    expect(screen.getByTestId("snapshot")).toHaveTextContent('"render_report":{"version":"1.0"');
    expect(screen.getByTestId("snapshot")).toHaveTextContent("POST render title");
    expect(screen.getByTestId("snapshot")).toHaveTextContent("POST render storyboard");
    expect(screen.getByTestId("snapshot")).toHaveTextContent('"consistency_report":{"score":91');
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("Stale incomplete GET");
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

    await waitFor(() => expect(screen.getByTestId("local-backup-status")).toHaveTextContent("idle"));
    expect(apiMocks.loadProject).toHaveBeenCalledTimes(1);
    expect(localMediaStoreMocks.cacheRemoteMedia).not.toHaveBeenCalled();
    expect(screen.getByTestId("snapshot")).toHaveTextContent("Newer shot survived render");
    expect(screen.getByTestId("snapshot")).toHaveTextContent('"render_report":null');
    expect(screen.getByTestId("snapshot")).toHaveTextContent('"final_path":null');
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
    expect(en.shotEditor.regenerateAction).toBe("Regenerate");
    expect(zh.shotEditor.saveAction).toBeTruthy();
    expect(zh.shotEditor.regenerateAction).toBeTruthy();
  });
});
