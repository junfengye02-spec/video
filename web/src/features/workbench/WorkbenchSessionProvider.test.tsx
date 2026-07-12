import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { createProjectResponse } from "../../test/fixtures";
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
    optimize: vi.fn(),
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
      <button
        type="button"
        disabled={!firstShot}
        onClick={() => firstShot && void workbench.saveShotChanges(firstShot.id, { prompt: "Saved prompt" }).catch(() => undefined)}
      >
        Save shot
      </button>
      <button
        type="button"
        disabled={!workbench.snapshot}
        onClick={() => void workbench.renderFinal().catch(() => undefined)}
      >
        Render final
      </button>
      <output data-testid="project-id">{workbench.snapshot?.project.id ?? ""}</output>
      <output data-testid="load">{workbench.load}</output>
      <output data-testid="read-only">{String(workbench.readOnly)}</output>
      <output data-testid="error">{workbench.error ?? ""}</output>
      <output data-testid="snapshot">{JSON.stringify(workbench.snapshot)}</output>
      <output data-testid="busy">{JSON.stringify(workbench.busy)}</output>
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
    expect(testMocks.generation.subscribe).toHaveBeenCalledWith("p1", expect.any(Function));

    fireEvent.click(screen.getByRole("button", { name: "Open p2" }));
    await waitFor(() => expect(screen.getByTestId("project-id")).toHaveTextContent("p2"));
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
    expect(testMocks.media.revokeProject).toHaveBeenCalledWith("p1");
    expect(testMocks.generation.subscribe).toHaveBeenCalledWith("p2", expect.any(Function));

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
