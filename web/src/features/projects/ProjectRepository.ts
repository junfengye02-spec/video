import type {
  ContinuityPlan,
  Project,
  ShortDramaProjectRequest,
  ShortDramaProjectResponse,
} from "../../domain/types";
import {
  exportProjectBackup,
  type ImportProjectBackupOptions,
  prepareProjectBackupDirectoryImport,
  prepareProjectBackupImport,
  type PreparedProjectBackupImport,
} from "../../localdb/exportProject";
import type { LocalProjectSummary, LocalProjectVersion } from "../../localdb/types";
import { ApiError, httpClient } from "../../platform/http/HttpClient";
import {
  browserProjectCache,
  type BrowserProjectCache,
} from "../../platform/storage/BrowserProjectCache";

export interface CachedProject {
  snapshot: ShortDramaProjectResponse;
  freshness: "fresh" | "stale";
  writable: boolean;
  version: LocalProjectVersion | null;
}

export type CreateProjectInput = Pick<
  ShortDramaProjectRequest,
  "title" | "prompt" | "project_type"
>;

export interface ProjectRepository {
  list(): Promise<LocalProjectSummary[]>;
  open(projectId: string): Promise<CachedProject | null>;
  create(input: CreateProjectInput): Promise<ShortDramaProjectResponse>;
  refresh(projectId: string): Promise<ShortDramaProjectResponse>;
  save(snapshot: ShortDramaProjectResponse): Promise<LocalProjectVersion | null>;
  saveIfVersion(
    snapshot: ShortDramaProjectResponse,
    expectedVersion: LocalProjectVersion,
  ): Promise<LocalProjectVersion | null>;
  markRecent(projectId: string): Promise<void>;
  importBackup(file: File, options?: ImportProjectBackupOptions): Promise<ShortDramaProjectResponse>;
  importBackupDirectory(
    files: Iterable<File> | ArrayLike<File>,
    options?: ImportProjectBackupOptions,
  ): Promise<ShortDramaProjectResponse>;
  exportBackup(projectId: string): Promise<Blob>;
  delete(projectId: string): Promise<void>;
}

export type PreparedBackupImport = PreparedProjectBackupImport;

type ProjectRepositoryHttp = {
  json<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T>;
};

interface ServerProjectRepositoryOptions {
  cache?: BrowserProjectCache;
  http?: ProjectRepositoryHttp;
  prepareImport?: (file: File, options?: ImportProjectBackupOptions) => Promise<PreparedBackupImport>;
  prepareDirectoryImport?: (
    files: Iterable<File> | ArrayLike<File>,
    options?: ImportProjectBackupOptions,
  ) => Promise<PreparedBackupImport>;
}

interface ProjectListResponse {
  projects: Project[];
}

interface ProjectImportRequest {
  legacy_project_id: string | null;
  title: string;
  project_type: "single_video" | "mini_series" | "long_series";
  series_bible: ShortDramaProjectResponse["series_bible"];
  storyboard: ShortDramaProjectResponse["storyboard"];
  continuity_plan: ContinuityPlan;
}

function projectPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

function defaultContinuityPlan(
  projectType: "single_video" | "mini_series" | "long_series",
): ContinuityPlan {
  return {
    project_type: projectType,
    active_episode_number: projectType === "single_video" ? null : 1,
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
  };
}

function toImportRequest(snapshot: ShortDramaProjectResponse): ProjectImportRequest {
  const projectType = snapshot.project.project_type ?? "single_video";
  return {
    legacy_project_id: snapshot.project.id,
    title: snapshot.project.title,
    project_type: projectType,
    series_bible: snapshot.series_bible,
    storyboard: snapshot.storyboard,
    continuity_plan: snapshot.continuity_plan ?? defaultContinuityPlan(projectType),
  };
}

function cachedSummary(project: Project, cached: ShortDramaProjectResponse | null): LocalProjectSummary {
  return {
    id: project.id,
    title: project.title,
    updatedAt: project.updated_at ?? new Date().toISOString(),
    shotCount: cached?.storyboard.shots.length ?? 0,
    hasFinalRender: Boolean(cached?.final_path),
  };
}

function cacheVersion(record: LocalProjectVersion): LocalProjectVersion {
  return {
    incarnation: record.incarnation,
    revision: record.revision,
  };
}

export class ServerProjectRepository implements ProjectRepository {
  private readonly cache: BrowserProjectCache;
  private readonly http: ProjectRepositoryHttp;
  private readonly prepareImport: (
    file: File,
    options?: ImportProjectBackupOptions,
  ) => Promise<PreparedBackupImport>;
  private readonly prepareDirectoryImport: (
    files: Iterable<File> | ArrayLike<File>,
    options?: ImportProjectBackupOptions,
  ) => Promise<PreparedBackupImport>;

  constructor(options: ServerProjectRepositoryOptions = {}) {
    this.cache = options.cache ?? browserProjectCache;
    this.http = options.http ?? httpClient;
    this.prepareImport = options.prepareImport ?? prepareProjectBackupImport;
    this.prepareDirectoryImport = options.prepareDirectoryImport ?? prepareProjectBackupDirectoryImport;
  }

  async list(): Promise<LocalProjectSummary[]> {
    const response = await this.http.json<ProjectListResponse>("/api/projects", { method: "GET" });
    return Promise.all(response.projects.map(async (project) => {
      let cached: ShortDramaProjectResponse | null = null;
      try {
        cached = await this.cache.get(project.id);
      } catch {
        cached = null;
      }
      return cachedSummary(project, cached);
    }));
  }

  async open(projectId: string): Promise<CachedProject | null> {
    try {
      const snapshot = await this.http.json<ShortDramaProjectResponse>(
        projectPath(projectId),
        { method: "GET" },
      );
      const record = await this.cache.put(snapshot);
      return { snapshot, freshness: "fresh", writable: true, version: cacheVersion(record) };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        await this.cache.remove(projectId);
        return null;
      }
      if (error instanceof ApiError && error.status === 0) {
        const record = await this.cache.getRecord(projectId);
        return record ? {
          snapshot: record.snapshot,
          freshness: "stale",
          writable: false,
          version: cacheVersion(record),
        } : null;
      }
      throw error;
    }
  }

  async create(input: CreateProjectInput): Promise<ShortDramaProjectResponse> {
    const snapshot = await this.http.json<ShortDramaProjectResponse>("/api/projects/short-drama", {
      method: "POST",
      body: input,
    });
    await this.cache.put(snapshot);
    return snapshot;
  }

  async refresh(projectId: string): Promise<ShortDramaProjectResponse> {
    const snapshot = await this.http.json<ShortDramaProjectResponse>(
      projectPath(projectId),
      { method: "GET" },
    );
    await this.cache.put(snapshot);
    return snapshot;
  }

  async save(snapshot: ShortDramaProjectResponse): Promise<LocalProjectVersion | null> {
    return cacheVersion(await this.cache.put(snapshot));
  }

  async saveIfVersion(
    snapshot: ShortDramaProjectResponse,
    expectedVersion: LocalProjectVersion,
  ): Promise<LocalProjectVersion | null> {
    const record = await this.cache.putIfVersion(snapshot, expectedVersion);
    return record ? cacheVersion(record) : null;
  }

  markRecent(projectId: string): Promise<void> {
    return this.cache.markRecent(projectId);
  }

  async importBackup(
    file: File,
    options?: ImportProjectBackupOptions,
  ): Promise<ShortDramaProjectResponse> {
    const prepared = await this.prepareImport(file, options);
    return this.commitPreparedImport(prepared);
  }

  async importBackupDirectory(
    files: Iterable<File> | ArrayLike<File>,
    options?: ImportProjectBackupOptions,
  ): Promise<ShortDramaProjectResponse> {
    const prepared = await this.prepareDirectoryImport(files, options);
    return this.commitPreparedImport(prepared);
  }

  exportBackup(projectId: string): Promise<Blob> {
    return exportProjectBackup(projectId);
  }

  async delete(projectId: string): Promise<void> {
    await this.http.json<void>(projectPath(projectId), { method: "DELETE" });
    await this.cache.remove(projectId);
  }

  private async commitPreparedImport(
    prepared: PreparedBackupImport,
  ): Promise<ShortDramaProjectResponse> {
    try {
      const snapshot = await this.http.json<ShortDramaProjectResponse>("/api/projects/import", {
        method: "POST",
        body: toImportRequest(prepared.snapshot),
      });
      await prepared.commit(snapshot);
      return snapshot;
    } catch (error) {
      await prepared.abort(error);
      throw error;
    }
  }
}

export const projectRepository = new ServerProjectRepository();
