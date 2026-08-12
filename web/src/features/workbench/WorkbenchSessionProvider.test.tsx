import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ContinuityPlan,
  JobEvent,
  ReferenceImageUploadRequest,
  RenderProjectResponse,
  ShortDramaProjectResponse,
  ShotSaveRequest,
} from "../../domain/types";
import type { LocalMediaRef, StorageEstimate } from "../../localdb/types";
import { ApiError } from "../../platform/http/HttpClient";
import { createAcceptedImageTask, createProjectResponse } from "../../test/fixtures";
import type { GenerationService } from "../generation/GenerationService";
import type { ProjectRepository } from "../projects/ProjectRepository";
import type { MediaRepository } from "../../platform/storage/MediaRepository";
import { useWorkbench } from "../../app/workbench/useWorkbench";
import { WorkbenchSessionProvider } from "./WorkbenchSessionProvider";

function project(id: string, title = id): ShortDramaProjectResponse {
  const snapshot = createProjectResponse();
  snapshot.project = { ...snapshot.project, id, title };
  snapshot.storyboard.shots = snapshot.storyboard.shots.map((shot, index) => ({
    ...shot,
    id: `${id}-shot-${index + 1}`,
    prompt: `${title} shot ${index + 1}`,
  }));
  return snapshot;
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

function event(projectId: string, id = "event-1"): JobEvent {
  return {
    id,
    job_id: id,
    project_id: projectId,
    stage: "save",
    status: "complete",
    message: "complete",
    created_at: "2026-07-12T08:00:00Z",
  };
}

function mocks() {
  const projectP1 = project("p1", "Project One");
  const projectP2 = project("p2", "Project Two");
  const projects: ProjectRepository = {
    list: vi.fn(async () => []),
    open: vi.fn(async (projectId: string) => ({
      snapshot: projectId === "p1" ? projectP1 : projectP2,
      freshness: "fresh" as const,
      writable: true,
      version: { incarnation: `test:${projectId}`, revision: 1 },
    })),
    create: vi.fn(async () => projectP1),
    createDraft: vi.fn(async () => ({ ...projectP1, storyboard: { shots: [] } })),
    developInspiration: vi.fn(async () => projectP1),
    uploadInspirationAttachment: vi.fn(),
    updateInspirationIntent: vi.fn(async () => projectP1),
    planStoryboard: vi.fn(async () => projectP1),
    approveStoryboard: vi.fn(async () => projectP1),
    beginStoryboardRevision: vi.fn(async () => projectP1),
    cancelStoryboardRevision: vi.fn(async () => projectP1),
    updatePlanSection: vi.fn(async () => projectP1),
    refresh: vi.fn(async (projectId: string) => (projectId === "p1" ? projectP1 : projectP2)),
    save: vi.fn(async () => ({ incarnation: "test:p1", revision: 2 })),
    saveIfVersion: vi.fn(async () => ({ incarnation: "test:p1", revision: 3 })),
    markRecent: vi.fn(async () => undefined),
    importBackup: vi.fn(),
    importBackupDirectory: vi.fn(),
    exportBackup: vi.fn(),
    delete: vi.fn(),
  };
  const media: MediaRepository = {
    cacheRemote: vi.fn(async () => null),
    findCommitted: vi.fn(async () => null),
    load: vi.fn(async () => null),
    resolve: vi.fn(async (ref: LocalMediaRef) => `blob:${ref}`),
    remoteUrl: vi.fn((path: string | null | undefined, projectId?: string | null) => (
      path && projectId && !path.startsWith("local://")
        ? `/api/projects/${projectId}/media/${path}`
        : null
    )),
    startRecovery: vi.fn(() => ({ dispose: vi.fn(), run: vi.fn(async () => 0) })),
    revokeProject: vi.fn(),
    revokeAll: vi.fn(),
    deleteProject: vi.fn(),
    estimate: vi.fn(async (): Promise<StorageEstimate> => ({
      usageBytes: 0,
      quotaBytes: 0,
      persisted: false,
    })),
  };
  const generation: GenerationService = {
    listModels: vi.fn(),
    listAssets: vi.fn(),
    listTasks: vi.fn(async () => ({ tasks: [] })),
    retryTaskItem: vi.fn(),
    generateImages: vi.fn(),
    previewGenerationPlan: vi.fn(),
    generateGenerationUnits: vi.fn(),
    addAssetToProject: vi.fn(),
    reviseCreativePlan: vi.fn(async () => projectP1),
    optimize: vi.fn(),
    optimizeImagePrompt: vi.fn(),
    saveShot: vi.fn(async (projectId: string, shotId: string, payload: ShotSaveRequest) => {
      const base = projectId === "p1" ? projectP1 : projectP2;
      const original = base.storyboard.shots.find((item) => item.id === shotId)!;
      const shot = {
        ...original,
        prompt: payload.prompt ?? original.prompt,
        characters: payload.characters ?? original.characters,
        location: payload.location ?? original.location,
        props: payload.props ?? original.props,
        asset_ids: payload.asset_ids ?? original.asset_ids,
        shot_intent: payload.shot_intent ?? original.shot_intent,
        shot_language: payload.shot_language ?? original.shot_language,
        version: 2,
      };
      return {
        job_id: "save-job",
        event: event(projectId, "save-event"),
        shot,
        storyboard: {
          ...base.storyboard,
          shots: base.storyboard.shots.map((item) => item.id === shot.id ? shot : item),
        },
        consistency_report: base.consistency_report,
      };
    }),
    regenerate: vi.fn(),
    prepareRender: vi.fn(async () => { throw new Error("prepare not used"); }),
    compose: vi.fn(async (projectId: string) => ({
      task_id: "composition-task",
      status: "queued" as const,
      deduplicated: false,
      task: {
        id: "composition-task",
        project_id: projectId,
        task_type: "project_render.compose",
        status: "queued" as const,
        idempotency_key: "composition-test",
        progress: 0,
        total_items: 1,
        completed_items: 0,
        failed_items: 0,
        error_code: null,
        error_message: null,
        created_at: "2026-07-21T00:00:00Z",
        updated_at: "2026-07-21T00:00:00Z",
        items: null,
      },
    })),
    render: vi.fn(async (projectId: string): Promise<RenderProjectResponse> => {
      const base = projectId === "p1" ? projectP1 : projectP2;
      return {
        job_id: "render-job",
        event: event(projectId, "render-event"),
        project: base.project,
        storyboard: base.storyboard,
        consistency_report: base.consistency_report,
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
      };
    }),
    saveContinuity: vi.fn(async (projectId: string, plan: ContinuityPlan) => ({
      project: (projectId === "p1" ? projectP1 : projectP2).project,
      continuity_plan: plan,
    })),
    uploadReference: vi.fn(async (_projectId: string, payload: ReferenceImageUploadRequest) => ({
      media: {
        path: "assets/images/reference.png",
        media_url: "assets/images/reference.png",
        filename: payload.file.name,
        content_type: payload.file.type,
      },
      asset: {
        id: "asset-upload",
        kind: payload.kind,
        label: payload.label,
        description: payload.description,
        prompt: payload.prompt,
        reference_images: ["assets/images/reference.png"],
        media_urls: [],
      },
      library_asset: {
        id: "asset-upload",
        origin_project_id: _projectId,
        kind: payload.kind,
        source_type: "upload" as const,
        label: payload.label,
        description: payload.description,
        prompt: payload.prompt,
        model: null,
        generation_job_id: null,
        provenance: null,
        media_url: "assets/images/reference.png",
        status: "ready" as const,
        created_at: "2026-07-20T00:00:00Z",
      },
    })),
    subscribe: vi.fn(() => vi.fn()),
  };
  return { generation, media, projectP1, projectP2, projects };
}

function Harness() {
  const workbench = useWorkbench();
  const firstShot = workbench.snapshot?.storyboard.shots[0] ?? null;
  return (
    <div>
      <button type="button" onClick={() => void workbench.openLocalProject("p1")}>Open p1</button>
      <button type="button" onClick={() => void workbench.openLocalProject("p2")}>Open p2</button>
      <button type="button" onClick={() => void workbench.refreshProduction()}>Refresh production</button>
      <button
        type="button"
        disabled={!firstShot}
        onClick={() => firstShot && void workbench.saveShotChanges(firstShot.id, { prompt: "Saved prompt" }).catch(() => undefined)}
      >
        Save shot
      </button>
      <button
        type="button"
        disabled={!firstShot}
        onClick={() => firstShot && void workbench.regenerateSelectedShot(firstShot).catch(() => undefined)}
      >
        Regenerate shot
      </button>
      <button
        type="button"
        disabled={!workbench.snapshot}
        onClick={() => void workbench.renderFinal().catch(() => undefined)}
      >
        Render final
      </button>
      <button
        type="button"
        disabled={!workbench.snapshot}
        onClick={() => void workbench.optimizeImagePrompt(
          "prop",
          "Sealed evidence envelope",
          "q".repeat(32),
        ).catch(() => undefined)}
      >
        Optimize image prompt
      </button>
      <button
        type="button"
        disabled={!workbench.snapshot}
        onClick={() => void workbench.generateImages({
          kind: "scene",
          label: "Cached rain alley",
          description: "",
          prompt: "Rain alley",
          model: "gpt-image-2",
          count: 1,
          size: "1024x1024",
          quality: "standard",
        }).catch(() => undefined)}
      >
        Generate resource
      </button>
      <button
        type="button"
        disabled={!workbench.snapshot}
        onClick={() => void workbench.updatePlanSection("worldview", {
          status: "approved",
          revision: 1,
        }).catch(() => undefined)}
      >
        Approve worldview
      </button>
      <button
        type="button"
        disabled={!workbench.snapshot}
        onClick={() => void workbench.reviseCreativePlan({
          sections: ["worldview"],
          feedback: "Clarify the world rule",
        }).catch(() => undefined)}
      >
        Revise worldview
      </button>
      <button
        type="button"
        disabled={!workbench.snapshot}
        onClick={() => void workbench.planStoryboard("Confirmed creative brief", false, "gpt-5.4").catch(() => undefined)}
      >
        Plan storyboard
      </button>
      <button
        type="button"
        disabled={!workbench.snapshot}
        onClick={() => void workbench.developInspiration({
          messages: [{ role: "user", content: "A quiet rain story" }],
        }).catch(() => undefined)}
      >
        Develop inspiration
      </button>
      <output data-testid="project-id">{workbench.snapshot?.project.id ?? ""}</output>
      <output data-testid="load">{workbench.load}</output>
      <output data-testid="read-only">{String(workbench.readOnly)}</output>
      <output data-testid="error">{workbench.error ?? ""}</output>
      <output data-testid="snapshot">{JSON.stringify(workbench.snapshot)}</output>
      <output data-testid="busy">{JSON.stringify(workbench.busy)}</output>
      <output data-testid="production-connection">{workbench.productionConnection}</output>
    </div>
  );
}

function renderProvider(testMocks = mocks()) {
  return {
    ...testMocks,
    ...render(
      <WorkbenchSessionProvider
        generation={testMocks.generation}
        media={testMocks.media}
        projects={testMocks.projects}
      >
        <Harness />
      </WorkbenchSessionProvider>,
    ),
  };
}

afterEach(() => {
  cleanup();
});

describe("WorkbenchSessionProvider", () => {
  it("refreshes render facts after SSE reconnect and terminal events and releases old subscriptions", async () => {
    const testMocks = mocks();
    let onEvent: ((event: JobEvent) => void) | null = null;
    let onConnectionChange: ((state: "connecting" | "connected" | "disconnected") => void) | null = null;
    const unsubscribe = vi.fn();
    vi.mocked(testMocks.generation.subscribe).mockImplementation((_projectId, eventHandler, options) => {
      onEvent = eventHandler;
      onConnectionChange = options?.onConnectionChange ?? null;
      return unsubscribe;
    });
    const completed = structuredClone(testMocks.projectP1);
    completed.final_path = "renders/final.mp4";
    completed.render_report = {
      version: "1.0",
      outputs: [{
        path: "renders/final.mp4",
        format: "mp4",
        resolution: "720x1280",
        duration_seconds: 25,
      }],
    };
    vi.mocked(testMocks.projects.refresh).mockResolvedValue(completed);
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    await waitFor(() => expect(onConnectionChange).not.toBeNull());
    await act(async () => { onConnectionChange?.("disconnected"); });
    await waitFor(() => expect(screen.getByTestId("production-connection")).toHaveTextContent("disconnected"));
    await act(async () => { onConnectionChange?.("connected"); });
    await waitFor(() => expect(testMocks.projects.refresh).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.getByTestId("snapshot")).toHaveTextContent("renders/final.mp4"));

    vi.mocked(testMocks.projects.refresh).mockClear();
    await act(async () => {
      onEvent?.({
        id: "render-complete",
        job_id: "render-job",
        project_id: "p1",
        stage: "render",
        status: "complete",
        message: "Final video rendered",
        created_at: "2026-07-16T08:00:00Z",
      });
    });
    await waitFor(() => expect(testMocks.projects.refresh).toHaveBeenCalledWith("p1"));

    const taskCompleted = structuredClone(completed);
    taskCompleted.storyboard.shots[0].version += 1;
    taskCompleted.storyboard.shots[0].continuity = {
      mode: "cut",
      inherit_previous_tail: false,
      explicit_user_first_frame_asset_id: "task-first-frame",
      inherited_first_frame_asset_id: null,
      last_frame_asset_id: null,
      first_frame: {
        asset_id: "task-first-frame",
        version: 1,
        status: "ready",
        source: "ai_generated",
        generation_job_id: "task-billing-job",
      },
      last_frame: null,
      stale: false,
    };
    vi.mocked(testMocks.projects.refresh).mockResolvedValue(taskCompleted);
    await act(async () => {
      onEvent?.({
        id: "task-complete",
        job_id: "task-job",
        project_id: "p1",
        stage: "task_item",
        status: "complete",
        message: "Task item complete",
        created_at: "2026-07-21T08:00:00Z",
      });
    });
    await waitFor(() => expect(screen.getByTestId("snapshot"))
      .toHaveTextContent("task-first-frame"));

    fireEvent.click(screen.getByRole("button", { name: "Open p2" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent authoritative production refreshes", async () => {
    const testMocks = mocks();
    const refresh = deferred<ShortDramaProjectResponse>();
    vi.mocked(testMocks.projects.refresh).mockReturnValue(refresh.promise);
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    vi.mocked(testMocks.projects.refresh).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Refresh production" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh production" }));
    await waitFor(() => expect(testMocks.projects.refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("busy")).toHaveTextContent('"refreshingProduction":true');

    await act(async () => {
      refresh.resolve(testMocks.projectP1);
      await refresh.promise;
    });
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent('"refreshingProduction":false'));
  });

  it("accepts resource generation without mutating the local snapshot before publication", async () => {
    const testMocks = mocks();
    vi.mocked(testMocks.generation.generateImages).mockResolvedValue(createAcceptedImageTask());
    vi.mocked(testMocks.media.cacheRemote).mockResolvedValue(
      "local://media/generated-scene" as LocalMediaRef,
    );
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    vi.mocked(testMocks.media.cacheRemote).mockClear();
    vi.mocked(testMocks.projects.save).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Generate resource" }));

    await waitFor(() => expect(testMocks.generation.generateImages).toHaveBeenCalled());
    expect(testMocks.media.cacheRemote).not.toHaveBeenCalled();
    expect(testMocks.projects.save).not.toHaveBeenCalled();
  });

  it("accepts asynchronous shot regeneration without replacing the current snapshot", async () => {
    const testMocks = mocks();
    const accepted = createAcceptedImageTask("regenerate-task");
    accepted.task.task_type = "storyboard_video.generate";
    vi.mocked(testMocks.generation.regenerate).mockResolvedValue(accepted);
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    vi.mocked(testMocks.projects.save).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot" }));

    await waitFor(() => expect(testMocks.generation.regenerate).toHaveBeenCalledWith(
      "p1",
      "p1-shot-1",
      undefined,
    ));
    await waitFor(() => expect(screen.getByTestId("busy"))
      .toHaveTextContent('"regeneratingShotId":null'));
    expect(JSON.parse(screen.getByTestId("snapshot").textContent ?? "null"))
      .toEqual(testMocks.projectP1);
    expect(testMocks.projects.save).not.toHaveBeenCalled();
  });

  it("routes plan section updates and text revisions through distinct services", async () => {
    const testMocks = mocks();
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    fireEvent.click(screen.getByRole("button", { name: "Approve worldview" }));
    await waitFor(() => expect(testMocks.projects.updatePlanSection).toHaveBeenCalledWith(
      "p1",
      "worldview",
      { status: "approved", revision: 1 },
    ));
    fireEvent.click(screen.getByRole("button", { name: "Revise worldview" }));
    await waitFor(() => expect(testMocks.generation.reviseCreativePlan).toHaveBeenCalledWith(
      "p1",
      { sections: ["worldview"], feedback: "Clarify the world rule" },
    ));
  });

  it("refreshes the authoritative workflow after a section revision conflict", async () => {
    const testMocks = mocks();
    const latest = structuredClone(testMocks.projectP1);
    latest.creative_workflow = {
      phase: "plan_review",
      messages: [],
      brief: null,
      ready_to_confirm: true,
      planned_asset_ids: [],
      approved_at: null,
      plan_sections: {
        worldview: { status: "approved", revision: 3, feedback: null, updated_at: "2026-07-16T03:00:00Z" },
        characters: { status: "pending", revision: 1, feedback: null, updated_at: null },
        scenes: { status: "pending", revision: 1, feedback: null, updated_at: null },
        props: { status: "pending", revision: 1, feedback: null, updated_at: null },
        sound: { status: "pending", revision: 1, feedback: null, updated_at: null },
        storyboard: { status: "pending", revision: 1, feedback: null, updated_at: null },
      },
    };
    vi.mocked(testMocks.projects.updatePlanSection).mockRejectedValue(new ApiError(
      409,
      "Creative plan section has changed",
      "plan_section_revision_conflict",
      { section: "worldview", current_revision: 3 },
    ));
    vi.mocked(testMocks.projects.refresh).mockResolvedValue(latest);
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    fireEvent.click(screen.getByRole("button", { name: "Approve worldview" }));

    await waitFor(() => expect(testMocks.projects.refresh).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.getByTestId("snapshot")).toHaveTextContent('"revision":3'));
    expect(screen.getByTestId("snapshot")).toHaveTextContent('"status":"approved"');
    expect(screen.getByTestId("busy")).toHaveTextContent('"updatingPlanSection":null');
    expect(screen.getByTestId("error")).toBeEmptyDOMElement();
  });

  it("refreshes the latest plan after a conflict raised during text revision", async () => {
    const testMocks = mocks();
    const latest = structuredClone(testMocks.projectP1);
    latest.series_bible.worldview = "Latest server worldview";
    vi.mocked(testMocks.generation.reviseCreativePlan).mockRejectedValue(new ApiError(
      409,
      "Creative plan changed while revision was generated",
      "creative_plan_revision_conflict",
      { plan_sections: {} },
    ));
    vi.mocked(testMocks.projects.refresh).mockResolvedValue(latest);
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    fireEvent.click(screen.getByRole("button", { name: "Revise worldview" }));

    await waitFor(() => expect(testMocks.projects.refresh).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.getByTestId("snapshot")).toHaveTextContent("Latest server worldview"));
    expect(screen.getByTestId("busy")).toHaveTextContent('"revisingPlan":false');
    expect(screen.getByTestId("error")).toBeEmptyDOMElement();
  });

  it("deduplicates an in-flight planning operation and preserves the inspiration snapshot on retry", async () => {
    const testMocks = mocks();
    const pendingPlan = deferred<ShortDramaProjectResponse>();
    vi.mocked(testMocks.projects.planStoryboard)
      .mockReturnValueOnce(pendingPlan.promise)
      .mockResolvedValueOnce(testMocks.projectP1);
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    const plan = screen.getByRole("button", { name: "Plan storyboard" });
    fireEvent.click(plan);
    fireEvent.click(plan);

    await waitFor(() => expect(testMocks.projects.planStoryboard).toHaveBeenCalledTimes(1));
    expect(testMocks.projects.planStoryboard).toHaveBeenCalledWith("p1", {
      control_end_frames: false,
      prompt: "Confirmed creative brief",
      project_type: "single_video",
      text_model: "gpt-5.4",
    });
    expect(screen.getByTestId("busy")).toHaveTextContent('"creating":true');

    pendingPlan.reject(new Error("planning failed"));
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("planning failed"));
    expect(screen.getByTestId("snapshot")).toHaveTextContent("Project One");

    fireEvent.click(plan);
    await waitFor(() => expect(testMocks.projects.planStoryboard).toHaveBeenCalledTimes(2));
    expect(testMocks.projects.developInspiration).not.toHaveBeenCalled();
  });

  it("ignores an expired inspiration response after the project session changes", async () => {
    const testMocks = mocks();
    const pending = deferred<ShortDramaProjectResponse>();
    vi.mocked(testMocks.projects.developInspiration).mockReturnValueOnce(pending.promise);
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    fireEvent.click(screen.getByRole("button", { name: "Develop inspiration" }));
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent('"developingIdea":true'));

    fireEvent.click(screen.getByRole("button", { name: "Open p2" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));
    const stale = structuredClone(testMocks.projectP1);
    stale.project.title = "Stale inspiration result";
    pending.resolve(stale);

    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("Stale inspiration result");
    expect(screen.getByTestId("busy")).toHaveTextContent('"developingIdea":false');
  });

  it("forwards the asset kind and retry quote when optimizing an image prompt", async () => {
    const testMocks = mocks();
    vi.mocked(testMocks.generation.optimizeImagePrompt).mockResolvedValue({
      project_id: "p1",
      model: "gpt-5.5",
      optimized_text: "Four-view evidence envelope reference sheet",
      notes: [],
    });
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    fireEvent.click(screen.getByRole("button", { name: "Optimize image prompt" }));

    await waitFor(() => expect(testMocks.generation.optimizeImagePrompt).toHaveBeenCalledWith(
      "p1",
      "prop",
      "Sealed evidence envelope",
      "q".repeat(32),
    ));
  });

  it("opens projects through the repository and cleans subscriptions and URLs on switch and unmount", async () => {
    const testMocks = mocks();
    const firstUnsubscribe = vi.fn();
    const secondUnsubscribe = vi.fn();
    vi.mocked(testMocks.generation.subscribe)
      .mockReturnValueOnce(firstUnsubscribe)
      .mockReturnValueOnce(secondUnsubscribe);
    const rendered = renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    expect(testMocks.projects.open).toHaveBeenCalledWith("p1");
    expect(testMocks.generation.subscribe).toHaveBeenCalledWith(
      "p1",
      expect.any(Function),
      expect.objectContaining({ onConnectionChange: expect.any(Function) }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open p2" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
    expect(testMocks.media.revokeProject).toHaveBeenCalledWith("p1");
    expect(testMocks.generation.subscribe).toHaveBeenCalledWith(
      "p2",
      expect.any(Function),
      expect.objectContaining({ onConnectionChange: expect.any(Function) }),
    );

    rendered.unmount();
    expect(secondUnsubscribe).toHaveBeenCalledTimes(1);
    expect(testMocks.media.revokeAll).toHaveBeenCalled();
  });

  it("ignores a stale open that resolves after a newer project", async () => {
    const testMocks = mocks();
    const pending = deferred<Awaited<ReturnType<ProjectRepository["open"]>>>();
    vi.mocked(testMocks.projects.open).mockImplementation((projectId: string) => (
      projectId === "p1"
        ? pending.promise
        : Promise.resolve({
          snapshot: testMocks.projectP2,
          freshness: "fresh",
          writable: true,
          version: { incarnation: "test:p2", revision: 1 },
        })
    ));
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    fireEvent.click(screen.getByRole("button", { name: "Open p2" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));

    pending.resolve({
      snapshot: testMocks.projectP1,
      freshness: "fresh",
      writable: true,
      version: { incarnation: "test:p1", revision: 1 },
    });

    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("Project One");
  });

  it("marks stale offline cache read-only and blocks mutating commands", async () => {
    const testMocks = mocks();
    vi.mocked(testMocks.projects.open).mockResolvedValue({
      snapshot: testMocks.projectP1,
      freshness: "stale",
      writable: false,
      version: { incarnation: "test:p1", revision: 1 },
    });
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    await waitFor(() => expect(screen.getByTestId("load")).toHaveTextContent("stale"));
    expect(screen.getByTestId("read-only")).toHaveTextContent("true");

    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));

    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("offline read-only"));
    expect(testMocks.generation.saveShot).not.toHaveBeenCalled();
  });

  it("hydrates committed media when opening a fresh server project", async () => {
    const testMocks = mocks();
    testMocks.projectP1.storyboard.shots[0].output_path = "assets/video/p1-shot-1.mp4";
    vi.mocked(testMocks.media.findCommitted).mockResolvedValue({
      id: "cached-shot",
      projectId: "p1",
      projectIncarnation: "test:p1",
      sourcePath: "assets/video/p1-shot-1.mp4",
      contentType: "video/mp4",
      sizeBytes: 1024,
      createdAt: "2026-07-20T00:00:00Z",
      state: "committed",
      importSessionId: null,
      storage: "indexeddb",
    });
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));

    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    expect(testMocks.media.findCommitted).toHaveBeenCalledWith(
      "p1",
      "assets/video/p1-shot-1.mp4",
      "test:p1",
    );
    expect(screen.getByTestId("snapshot")).toHaveTextContent("local://media/cached-shot");
    expect(screen.getByTestId("snapshot")).toHaveTextContent("assets/video/p1-shot-1.mp4");
  });

  it("hydrates committed media when opening an offline project", async () => {
    const testMocks = mocks();
    testMocks.projectP1.storyboard.shots[0].output_path = "assets/video/p1-shot-1.mp4";
    vi.mocked(testMocks.projects.open).mockResolvedValue({
      snapshot: testMocks.projectP1,
      freshness: "stale",
      writable: false,
      version: { incarnation: "test:p1", revision: 1 },
    });
    vi.mocked(testMocks.media.findCommitted).mockResolvedValue({
      id: "cached-shot",
      projectId: "p1",
      projectIncarnation: "test:p1",
      sourcePath: "assets/video/p1-shot-1.mp4",
      contentType: "video/mp4",
      sizeBytes: 1024,
      createdAt: "2026-07-20T00:00:00Z",
      state: "committed",
      importSessionId: null,
      storage: "indexeddb",
    });
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));

    await waitFor(() => expect(screen.getByTestId("snapshot"))
      .toHaveTextContent("local://media/cached-shot"));
    expect(testMocks.media.findCommitted).toHaveBeenCalledWith(
      "p1",
      "assets/video/p1-shot-1.mp4",
      "test:p1",
    );
  });

  it("persists shot saves and ignores stale command completions after a project switch", async () => {
    const testMocks = mocks();
    const pendingSave = deferred<Awaited<ReturnType<GenerationService["saveShot"]>>>();
    vi.mocked(testMocks.generation.saveShot).mockReturnValueOnce(pendingSave.promise);
    renderProvider(testMocks);

    fireEvent.click(screen.getByRole("button", { name: "Open p1" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p1"));
    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));
    await waitFor(() => expect(screen.getByTestId("busy")).toHaveTextContent("p1-shot-1"));

    fireEvent.click(screen.getByRole("button", { name: "Open p2" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));

    const staleShot = { ...testMocks.projectP1.storyboard.shots[0], prompt: "Stale save" };
    pendingSave.resolve({
      job_id: "stale-save",
      event: event("p1", "stale-save"),
      shot: staleShot,
      storyboard: {
        ...testMocks.projectP1.storyboard,
        shots: [staleShot, ...testMocks.projectP1.storyboard.shots.slice(1)],
      },
      consistency_report: testMocks.projectP1.consistency_report,
    });

    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));
    expect(screen.getByTestId("snapshot")).not.toHaveTextContent("Stale save");
  });
});
