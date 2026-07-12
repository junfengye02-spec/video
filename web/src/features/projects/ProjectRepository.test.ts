import { describe, expect, it, vi } from "vitest";
import type { ShortDramaProjectResponse } from "../../domain/types";
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
      prepareImport: options.prepareImport,
    }),
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
