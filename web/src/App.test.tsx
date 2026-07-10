import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    localProjectStoreMocks.saveProjectSnapshot.mockResolvedValue(undefined);
    localProjectStoreMocks.setRecentProjectId.mockResolvedValue(undefined);
    localStorageEstimateMocks.getStorageEstimate.mockResolvedValue({
      usageBytes: 2048,
      quotaBytes: 4096,
      persisted: false,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue(null);
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

  it("creates and persists a project without sending a shot count", async () => {
    renderProvider();
    setCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(screen.getByTestId("outcome")).toHaveTextContent("resolved"));
    expect(apiMocks.createShortDramaProject).toHaveBeenCalledWith({
      title: "Rain Alley",
      prompt: "A letter changes two lives",
      project_type: "single_video",
      text_key: "text-key",
      image_key: "image-key",
      video_key: "video-key",
      base_url: "https://api.0000238.xyz",
      text_model: "gpt-5.5",
      image_model: "gpt-image-2",
      video_model: "omni_flash-10s",
    });
    expect(apiMocks.createShortDramaProject.mock.calls[0]?.[0]).not.toHaveProperty("shot_count");
    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ project: expect.objectContaining({ id: "p1" }), final_path: null }),
    );
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
      { projectId: "p1", sourcePath: "assets/video/shot-1.mp4" },
    );
    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        storyboard: expect.objectContaining({
          shots: expect.arrayContaining([
            expect.objectContaining({ id: "shot-1", output_path: "local://media/shot-1" }),
          ]),
        }),
      }),
    );
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

  it("uploads the exact reference payload and persists the refreshed project", async () => {
    const current = projectResponse();
    const refreshed = cloneProjectResponse(current);
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
    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenLastCalledWith(refreshed);
  });

  it("caches final render media locally and keeps the render response without reloading", async () => {
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
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue("local://media/final-1");
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
    expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledWith(
      "/api/projects/p1/media/renders/final.mp4",
      { projectId: "p1", sourcePath: "renders/final.mp4" },
    );
    expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ final_path: "local://media/final-1" }),
    );
    expect(apiMocks.loadProject).not.toHaveBeenCalled();
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
