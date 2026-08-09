import { describe, expect, it, vi } from "vitest";
import type {
  ShortDramaProjectResponse,
  TaskAcceptedResponse,
  TaskBatch,
} from "../../domain/types";
import type { LocalProjectVersion } from "../../localdb/types";
import { ApiError } from "../../platform/http/HttpClient";
import type { BrowserProjectCache } from "../../platform/storage/BrowserProjectCache";
import {
  ServerProjectRepository,
  type PreparedBackupImport,
} from "./ProjectRepository";

function snapshot(id: string, title: string): ShortDramaProjectResponse {
  return {
    project: { id, title, mode: "short_drama", project_type: "single_video" },
    series_bible: {
      title,
      mode: "short_drama",
      style_lock: "",
      characters: [],
      assets: [{
        id: "asset-1",
        kind: "scene",
        label: "Alley",
        reference_images: ["local://media/image-1.png"],
      }],
    },
    storyboard: {
      shots: [{
        id: "s1",
        scene_id: "scene-1",
        index: 1,
        beat: "A reveal",
        prompt: "Neon rain",
        characters: [],
        location: null,
        props: [],
        status: "complete",
        consistency_score: 100,
        output_url: null,
        output_path: "local://media/shot-1.mp4",
        asset_ids: ["asset-1"],
        version: 1,
        history: [],
      }],
    },
    continuity_plan: {
      project_type: "single_video",
      active_episode_number: null,
      series_bible: {
        worldview: "",
        main_arc: "",
        style_lock: "",
        visual_rules: "",
        taboos: [],
        locations: [],
        props: [],
        relationship_map: [],
      },
      episodes: [],
      story_state: {
        character_knowledge: [],
        relationship_changes: [],
        active_foreshadowing: [],
        resolved_foreshadowing: [],
        prop_state: [],
        character_status: [],
        current_locations: [],
      },
    },
    consistency_report: { score: 100, issues: [] },
    workflow_artifacts: [],
    final_path: "local://media/shot-1.mp4",
  };
}

function fakeCache(initial: Record<string, ShortDramaProjectResponse | null> = {}) {
  const records = new Map(Object.entries(initial)
    .filter((entry): entry is [string, ShortDramaProjectResponse] => entry[1] !== null)
    .map(([id, value]) => [id, {
      id,
      title: value.project.title,
      updatedAt: "2026-07-12T00:00:00.000Z",
      incarnation: `test:${id}`,
      revision: 1,
      snapshot: value,
    }]));
  return {
    cache: {
      get: vi.fn(async (projectId: string) => records.get(projectId)?.snapshot ?? null),
      getRecord: vi.fn(async (projectId: string) => records.get(projectId) ?? null),
      put: vi.fn(async (value: ShortDramaProjectResponse) => {
        const previous = records.get(value.project.id);
        const record = {
          id: value.project.id,
          title: value.project.title,
          updatedAt: "2026-07-12T00:00:00.000Z",
          incarnation: previous?.incarnation ?? `test:${value.project.id}`,
          revision: (previous?.revision ?? 0) + 1,
          snapshot: value,
        };
        records.set(value.project.id, record);
        return record;
      }),
      putIfVersion: vi.fn(async (
        value: ShortDramaProjectResponse,
        expectedVersion: LocalProjectVersion,
      ) => {
        const previous = records.get(value.project.id);
        if (
          !previous
          || previous.incarnation !== expectedVersion.incarnation
          || previous.revision !== expectedVersion.revision
        ) return null;
        const record = {
          ...previous,
          revision: previous.revision + 1,
          snapshot: value,
        };
        records.set(value.project.id, record);
        return record;
      }),
      markRecent: vi.fn(async () => {
        // No-op for repository tests.
      }),
      remove: vi.fn(async (projectId: string) => {
        records.delete(projectId);
      }),
    } satisfies BrowserProjectCache,
    records,
  };
}

function repository(options: {
  cache?: BrowserProjectCache;
  responses?: unknown[];
  planningPollIntervalMs?: number;
  prepareImport?: (file: File) => Promise<PreparedBackupImport>;
} = {}) {
  const responses = [...(options.responses ?? [])];
  const json = vi.fn(async <T,>(_path: string, _options?: { method?: string; body?: unknown }) => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next as T;
  });
  const http = {
    json,
  };
  return {
    http,
    repo: new ServerProjectRepository({
      cache: options.cache ?? fakeCache().cache,
      http: http as NonNullable<ConstructorParameters<typeof ServerProjectRepository>[0]>["http"],
      planningPollIntervalMs: options.planningPollIntervalMs,
      prepareImport: options.prepareImport,
    }),
  };
}

function taskBatch(
  id: string,
  status: TaskBatch["status"],
  overrides: Partial<TaskBatch> = {},
): TaskBatch {
  return {
    id,
    project_id: "p1",
    task_type: "storyboard.plan",
    status,
    idempotency_key: `storyboard-plan:${id}`,
    progress: status === "complete" ? 100 : 0,
    total_items: 1,
    completed_items: status === "complete" ? 1 : 0,
    failed_items: ["failed", "cancelled", "partial_failure"].includes(status) ? 1 : 0,
    error_code: null,
    error_message: null,
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    items: [],
    ...overrides,
  };
}

function acceptedTask(task: TaskBatch): TaskAcceptedResponse {
  return {
    task_id: task.id,
    status: task.status,
    deduplicated: false,
    task,
  };
}

describe("ProjectRepository", () => {
  it("opens from the server before treating a cached project as owned", async () => {
    const remote = snapshot("p1", "Server Title");
    const { cache } = fakeCache({ p1: snapshot("p1", "Cached Title") });
    const { repo, http } = repository({ cache, responses: [remote] });

    await expect(repo.open("p1")).resolves.toEqual({
      snapshot: remote,
      freshness: "fresh",
      writable: true,
      version: { incarnation: "test:p1", revision: 2 },
    });

    expect(http.json).toHaveBeenCalledWith("/api/projects/p1", { method: "GET" });
    expect(cache.put).toHaveBeenCalledWith(remote);
  });

  it("evicts stale browser cache when the server denies ownership", async () => {
    const { cache } = fakeCache({ p1: snapshot("p1", "Cached") });
    const { repo } = repository({
      cache,
      responses: [new ApiError(404, "Project not found")],
    });

    await expect(repo.open("p1")).resolves.toBeNull();

    expect(cache.remove).toHaveBeenCalledWith("p1");
  });

  it("returns stale read-only cache only for a network failure", async () => {
    const cached = snapshot("p1", "Cached");
    const { cache } = fakeCache({ p1: cached });
    const { repo } = repository({
      cache,
      responses: [new ApiError(0, "Unable to reach the service.", "network")],
    });

    await expect(repo.open("p1")).resolves.toEqual({
      snapshot: cached,
      freshness: "stale",
      writable: false,
      version: { incarnation: "test:p1", revision: 1 },
    });
  });

  it("creates short-drama projects through the server and then caches the authoritative snapshot", async () => {
    const created = snapshot("server-id", "Draft");
    const { cache } = fakeCache();
    const { repo, http } = repository({ cache, responses: [created] });

    await expect(repo.create({
      title: "Draft",
      prompt: "Plan this story",
      project_type: "single_video",
    }))
      .resolves.toBe(created);

    expect(http.json).toHaveBeenCalledWith("/api/projects/short-drama", {
      method: "POST",
      body: {
        title: "Draft",
        prompt: "Plan this story",
        project_type: "single_video",
      },
    });
    const createBody = (
      http.json.mock.calls[0]?.[1] as { body: Record<string, unknown> } | undefined
    )?.body;
    expect(createBody).not.toHaveProperty("shot_count");
    expect(cache.put).toHaveBeenCalledWith(created);
  });

  it("creates an empty draft without requiring storyboard planning", async () => {
    const created = snapshot("server-id", "Draft");
    created.storyboard.shots = [];
    const { cache } = fakeCache();
    const { repo, http } = repository({ cache, responses: [created] });

    await expect(repo.createDraft({
      title: "Draft",
      project_type: "single_video",
    })).resolves.toBe(created);

    expect(http.json).toHaveBeenCalledWith("/api/projects", {
      method: "POST",
      body: {
        title: "Draft",
        project_type: "single_video",
      },
    });
    expect(cache.put).toHaveBeenCalledWith(created);
  });

  it("plans a storyboard inside an existing draft and refreshes the cache", async () => {
    const planned = snapshot("p1", "Draft");
    const accepted = taskBatch("plan-task", "queued");
    const complete = taskBatch("plan-task", "complete");
    const { cache } = fakeCache();
    const { repo, http } = repository({
      cache,
      planningPollIntervalMs: 0,
      responses: [acceptedTask(accepted), complete, planned],
    });

    await expect(repo.planStoryboard("p1", { prompt: "Plan this story" }))
      .resolves.toBe(planned);

    expect(http.json).toHaveBeenNthCalledWith(1, "/api/projects/p1/storyboard/plan/tasks", {
      method: "POST",
      body: { prompt: "Plan this story" },
    });
    expect(http.json).toHaveBeenNthCalledWith(2, "/api/projects/p1/tasks/plan-task", {
      method: "GET",
    });
    expect(http.json).toHaveBeenNthCalledWith(3, "/api/projects/p1", { method: "GET" });
    expect(cache.put).toHaveBeenCalledWith(planned);
  });

  it("surfaces a failed storyboard planning task without refreshing stale project data", async () => {
    const failed = taskBatch("failed-plan", "failed", {
      error_code: "storyboard_generation_failed",
      error_message: "Text model storyboard generation failed",
    });
    const { repo, http } = repository({
      planningPollIntervalMs: 0,
      responses: [acceptedTask(failed)],
    });

    await expect(repo.planStoryboard("p1", { prompt: "Plan this story" }))
      .rejects.toMatchObject({
        status: 500,
        code: "storyboard_generation_failed",
        details: { task_id: "failed-plan" },
      });
    expect(http.json).toHaveBeenCalledTimes(1);
  });

  it("surfaces the billing job when storyboard planning is awaiting payment", async () => {
    const awaiting = taskBatch("payment-plan", "awaiting_payment", {
      items: [{ billing_job_id: "b".repeat(32), status: "awaiting_payment" }],
    } as unknown as Partial<TaskBatch>);
    const { repo } = repository({
      planningPollIntervalMs: 0,
      responses: [acceptedTask(awaiting)],
    });

    await expect(repo.planStoryboard("p1", { prompt: "Plan this story" }))
      .rejects.toMatchObject({
        status: 402,
        code: "awaiting_payment",
        details: { task_id: "payment-plan", billing_job_id: "b".repeat(32) },
      });
  });

  it("refreshes when the server reports that planning was already published", async () => {
    const refreshed = snapshot("p1", "Already planned");
    const { repo, http } = repository({
      responses: [
        new ApiError(409, "Storyboard is already planned", "storyboard_already_planned"),
        refreshed,
      ],
    });

    await expect(repo.planStoryboard("p1", { prompt: "Plan this story" }))
      .resolves.toBe(refreshed);
    expect(http.json).toHaveBeenNthCalledWith(2, "/api/projects/p1", { method: "GET" });
  });

  it("persists the end-frame intent through the project API and cache", async () => {
    const updated = snapshot("p1", "Draft");
    updated.creative_workflow = {
      phase: "inspiration",
      messages: [],
      brief: null,
      ready_to_confirm: false,
      control_end_frames: true,
      planned_asset_ids: [],
      approved_at: null,
    };
    const { cache } = fakeCache();
    const { repo, http } = repository({ cache, responses: [updated] });

    await expect(repo.updateInspirationIntent("p1", {
      control_end_frames: true,
    })).resolves.toBe(updated);

    expect(http.json).toHaveBeenCalledWith("/api/projects/p1/inspiration/intent", {
      method: "PATCH",
      body: { control_end_frames: true },
    });
    expect(cache.put).toHaveBeenCalledWith(updated);
  });

  it("starts and cancels storyboard revision through server-backed transitions", async () => {
    const started = snapshot("p1", "Revision started");
    const canceled = snapshot("p1", "Revision canceled");
    const { cache } = fakeCache();
    const { repo, http } = repository({ cache, responses: [started, canceled] });

    await expect(repo.beginStoryboardRevision("p1")).resolves.toBe(started);
    await expect(repo.cancelStoryboardRevision("p1")).resolves.toBe(canceled);

    expect(http.json).toHaveBeenNthCalledWith(
      1,
      "/api/projects/p1/creative-plan/storyboard-revision/start",
      { method: "POST", body: {} },
    );
    expect(http.json).toHaveBeenNthCalledWith(
      2,
      "/api/projects/p1/creative-plan/storyboard-revision/cancel",
      { method: "POST", body: {} },
    );
    expect(cache.put).toHaveBeenNthCalledWith(1, started);
    expect(cache.put).toHaveBeenNthCalledWith(2, canceled);
  });

  it("updates a plan section with its optimistic revision and refreshes the cache", async () => {
    const updated = snapshot("p1", "Draft");
    const { cache } = fakeCache();
    const { repo, http } = repository({ cache, responses: [updated] });

    await expect(repo.updatePlanSection("p1", "worldview", {
      status: "changes_requested",
      feedback: "Clarify the world rule",
      revision: 2,
    })).resolves.toBe(updated);

    expect(http.json).toHaveBeenCalledWith(
      "/api/projects/p1/creative-plan/sections/worldview",
      {
        method: "PATCH",
        body: {
          status: "changes_requested",
          feedback: "Clarify the world rule",
          revision: 2,
        },
      },
    );
    expect(cache.put).toHaveBeenCalledWith(updated);
  });

  it("refreshes and saves snapshots through the browser cache boundary", async () => {
    const refreshed = snapshot("p1", "Fresh");
    const saved = snapshot("p1", "Saved");
    const { cache } = fakeCache();
    const { repo, http } = repository({ cache, responses: [refreshed] });

    await expect(repo.refresh("p1")).resolves.toBe(refreshed);
    await repo.save(saved);

    expect(http.json).toHaveBeenCalledWith("/api/projects/p1", { method: "GET" });
    expect(cache.put).toHaveBeenNthCalledWith(1, refreshed);
    expect(cache.put).toHaveBeenNthCalledWith(2, saved);
  });

  it("posts a validated backup to the server before committing it to browser cache", async () => {
    const legacy = snapshot("legacy-id", "Imported");
    const canonical = snapshot("server-id", "Imported");
    const commit = vi.fn(async () => undefined);
    const abort = vi.fn(async () => undefined);
    const file = new File(["backup"], "project.omproj");
    const { repo, http } = repository({
      responses: [canonical],
      prepareImport: vi.fn(async () => ({ snapshot: legacy, commit, abort })),
    });

    await expect(repo.importBackup(file)).resolves.toBe(canonical);

    expect(http.json).toHaveBeenCalledWith("/api/projects/import", {
      method: "POST",
      body: expect.objectContaining({
        legacy_project_id: "legacy-id",
        title: "Imported",
        series_bible: legacy.series_bible,
        storyboard: legacy.storyboard,
      }),
    });
    expect(commit).toHaveBeenCalledWith(canonical);
    expect(commit.mock.invocationCallOrder[0]).toBeGreaterThan(
      http.json.mock.invocationCallOrder[0],
    );
    expect(abort).not.toHaveBeenCalled();
  });

  it("aborts staged import media when the server import fails", async () => {
    const commit = vi.fn(async () => undefined);
    const abort = vi.fn(async () => undefined);
    const { repo } = repository({
      responses: [new ApiError(500, "Project import failed")],
      prepareImport: vi.fn(async () => ({ snapshot: snapshot("legacy", "Imported"), commit, abort })),
    });

    await expect(repo.importBackup(new File(["backup"], "project.omproj")))
      .rejects.toBeInstanceOf(ApiError);

    expect(commit).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalled();
  });

  it("deletes on the server first and leaves cache intact on server failure", async () => {
    const { cache } = fakeCache({ p1: snapshot("p1", "Cached") });
    const { repo, http } = repository({
      cache,
      responses: [new ApiError(500, "Project deletion failed")],
    });

    await expect(repo.delete("p1")).rejects.toBeInstanceOf(ApiError);

    expect(http.json).toHaveBeenCalledWith("/api/projects/p1", { method: "DELETE" });
    expect(cache.remove).not.toHaveBeenCalled();
  });

  it("removes browser cache after server delete succeeds", async () => {
    const { cache } = fakeCache({ p1: snapshot("p1", "Cached") });
    const { repo } = repository({ cache, responses: [undefined] });

    await repo.delete("p1");

    expect(cache.remove).toHaveBeenCalledWith("p1");
  });
});
