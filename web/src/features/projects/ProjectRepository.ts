import type {
  ContinuityPlan,
  DraftProjectRequest,
  Project,
  ShortDramaProjectResponse,
} from "../../domain/types";
import {
  exportProjectBackup,
  type ImportProjectBackupOptions,
  prepareProjectBackupDirectoryImport,
  prepareProjectBackupImport,
  type PreparedProjectBackupImport,
} from "../../localdb/exportProject";
import type { LocalProjectSummary } from "../../localdb/types";
import { ApiError, httpClient } from "../../platform/http/HttpClient";
import {
  browserProjectCache,
  type BrowserProjectCache,
} from "../../platform/storage/BrowserProjectCache";

export interface CachedProject {
  snapshot: ShortDramaProjectResponse;
  freshness: "fresh" | "stale";
  writable: boolean;
}

export type CreateProjectInput = DraftProjectRequest;

export interface ProjectRepository {
  list(): Promise<LocalProjectSummary[]>;
  open(projectId: string): Promise<CachedProject | null>;
  create(input: CreateProjectInput): Promise<ShortDramaProjectResponse>;
  importBackup(file: File, options?: ImportProjectBackupOptions): Promise<ShortDramaProjectResponse>;
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
      await this.cache.put(snapshot);
      return { snapshot, freshness: "fresh", writable: true };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        await this.cache.remove(projectId);
        return null;
      }
      if (error instanceof ApiError && error.status === 0) {
        const snapshot = await this.cache.get(projectId);
        return snapshot ? { snapshot, freshness: "stale", writable: false } : null;
      }
      throw error;
    }
  }

  async create(input: CreateProjectInput): Promise<ShortDramaProjectResponse> {
    const snapshot = await this.http.json<ShortDramaProjectResponse>("/api/projects", {
      method: "POST",
      body: input,
    });
    await this.cache.put(snapshot);
    return snapshot;
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
