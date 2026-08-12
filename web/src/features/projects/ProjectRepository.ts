import type {
  ContinuityPlan,
  PlanSectionId,
  PlanSectionUpdateRequest,
  DraftProjectRequest,
  InspirationChatRequest,
  InspirationAttachment,
  InspirationIntentUpdateRequest,
  Project,
  ShortDramaProjectRequest,
  ShortDramaProjectResponse,
  TaskAcceptedResponse,
  TaskBatch,
} from "../../domain/types";
import {
  exportProjectBackup,
  type ImportProjectBackupOptions,
  prepareProjectBackupDirectoryImport,
  prepareProjectBackupImport,
  type PreparedProjectBackupImport,
} from "../../localdb/exportProject";
import type { LocalProjectSummary, LocalProjectVersion } from "../../localdb/types";
import { selectProjectCover } from "./projectCover";
import {
  ApiError,
  getCsrfToken,
  httpClient,
  notifyUnauthorized,
} from "../../platform/http/HttpClient";
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

export type PlanStoryboardInput = Pick<ShortDramaProjectRequest, "prompt" | "project_type"> & {
  text_model?: string;
  control_end_frames?: boolean;
};

export interface ProjectRepository {
  list(): Promise<LocalProjectSummary[]>;
  open(projectId: string): Promise<CachedProject | null>;
  create(input: CreateProjectInput): Promise<ShortDramaProjectResponse>;
  createDraft(input: DraftProjectRequest): Promise<ShortDramaProjectResponse>;
  developInspiration(
    projectId: string,
    input: InspirationChatRequest,
    onDelta?: (text: string) => void,
  ): Promise<ShortDramaProjectResponse>;
  uploadInspirationAttachment(projectId: string, file: File): Promise<InspirationAttachment>;
  updateInspirationIntent(
    projectId: string,
    input: InspirationIntentUpdateRequest,
  ): Promise<ShortDramaProjectResponse>;
  planStoryboard(
    projectId: string,
    input: PlanStoryboardInput,
  ): Promise<ShortDramaProjectResponse>;
  approveStoryboard(projectId: string): Promise<ShortDramaProjectResponse>;
  beginStoryboardRevision(projectId: string): Promise<ShortDramaProjectResponse>;
  cancelStoryboardRevision(projectId: string): Promise<ShortDramaProjectResponse>;
  updatePlanSection(
    projectId: string,
    section: PlanSectionId,
    input: PlanSectionUpdateRequest,
  ): Promise<ShortDramaProjectResponse>;
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
  planningPollIntervalMs?: number;
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
  generation_execution?: ShortDramaProjectResponse["generation_execution"];
}

function projectPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

const STORYBOARD_PLANNING_POLL_INTERVAL_MS = 1_500;
const STORYBOARD_PLANNING_TIMEOUT_MS = 15 * 60 * 1_000;
const STORYBOARD_PLANNING_TERMINAL_STATUSES = new Set([
  "complete",
  "failed",
  "cancelled",
  "partial_failure",
  "awaiting_payment",
]);

function storyboardPlanningTaskError(task: TaskBatch): ApiError {
  const item = task.items?.find((candidate) => candidate.status === "awaiting_payment")
    ?? task.items?.find((candidate) => candidate.error_code || candidate.error_message)
    ?? task.items?.[0];
  const billingJobId = item?.billing_job_id ?? task.billing_job_id ?? null;
  const code = task.status === "awaiting_payment"
    ? "awaiting_payment"
    : task.error_code ?? item?.error_code ?? "storyboard_plan_failed";
  const message = task.status === "awaiting_payment"
    ? item?.error_message ?? "Storyboard planning requires payment before it can continue."
    : task.error_message ?? item?.error_message ?? "Storyboard planning failed.";
  return new ApiError(
    task.status === "awaiting_payment" ? 402 : 500,
    message,
    code,
    {
      task_id: task.id,
      ...(billingJobId ? { billing_job_id: billingJobId } : {}),
    },
  );
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
      series_prompt: "",
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
    ...(snapshot.generation_execution
      ? { generation_execution: snapshot.generation_execution }
      : {}),
  };
}

function cachedSummary(project: Project, cached: ShortDramaProjectResponse | null): LocalProjectSummary {
  return {
    id: project.id,
    title: project.title,
    updatedAt: project.updated_at ?? new Date().toISOString(),
    shotCount: cached?.storyboard.shots.length ?? 0,
    hasFinalRender: Boolean(cached?.final_path),
    cover: selectProjectCover(cached),
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
  private readonly planningPollIntervalMs: number;
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
    this.planningPollIntervalMs = Math.max(
      0,
      options.planningPollIntervalMs ?? STORYBOARD_PLANNING_POLL_INTERVAL_MS,
    );
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

  async createDraft(input: DraftProjectRequest): Promise<ShortDramaProjectResponse> {
    const snapshot = await this.http.json<ShortDramaProjectResponse>("/api/projects", {
      method: "POST",
      body: input,
    });
    await this.cache.put(snapshot);
    return snapshot;
  }

  async planStoryboard(
    projectId: string,
    input: PlanStoryboardInput,
  ): Promise<ShortDramaProjectResponse> {
    let accepted: TaskAcceptedResponse;
    try {
      accepted = await this.http.json<TaskAcceptedResponse>(
        `${projectPath(projectId)}/storyboard/plan/tasks`,
        { method: "POST", body: input },
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === "storyboard_already_planned") {
        return this.refresh(projectId);
      }
      throw error;
    }

    const deadline = Date.now() + STORYBOARD_PLANNING_TIMEOUT_MS;
    let task = accepted.task;
    while (true) {
      if (task.status === "complete") return this.refresh(projectId);
      if (STORYBOARD_PLANNING_TERMINAL_STATUSES.has(task.status)) {
        throw storyboardPlanningTaskError(task);
      }
      if (Date.now() >= deadline) {
        throw new ApiError(
          408,
          "Storyboard planning is still running in the background.",
          "storyboard_planning_timeout",
          { task_id: accepted.task_id },
        );
      }
      if (this.planningPollIntervalMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.planningPollIntervalMs);
        });
      }
      task = await this.http.json<TaskBatch>(
        `${projectPath(projectId)}/tasks/${encodeURIComponent(accepted.task_id)}`,
        { method: "GET" },
      );
    }
  }

  async developInspiration(
    projectId: string,
    input: InspirationChatRequest,
    onDelta?: (text: string) => void,
  ): Promise<ShortDramaProjectResponse> {
    if (!onDelta) {
      const snapshot = await this.http.json<ShortDramaProjectResponse>(
        `${projectPath(projectId)}/inspiration/chat`,
        { method: "POST", body: input },
      );
      await this.cache.put(snapshot);
      return snapshot;
    }
    const response = await fetch(`${projectPath(projectId)}/inspiration/chat`, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        ...(getCsrfToken() ? { "X-CSRF-Token": getCsrfToken() as string } : {}),
      },
      body: JSON.stringify(input),
    });
    if (response.status === 401) notifyUnauthorized();
    if (!response.ok) {
      let body: Record<string, unknown> = {};
      try { body = await response.json(); } catch { /* handled below */ }
      const detail = typeof body.detail === "string" ? body.detail : undefined;
      throw new ApiError(response.status, detail ?? `Request failed with status ${response.status}`, typeof body.code === "string" ? body.code : undefined, body);
    }
    if (!response.body) throw new ApiError(response.status, "The service returned an empty stream.", "invalid_response");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let snapshot: ShortDramaProjectResponse | null = null;
    const consume = (block: string) => {
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (!data.length) return;
      let payload: any;
      try { payload = JSON.parse(data.join("\n")); } catch { return; }
      if (event === "delta" && typeof payload.text === "string") onDelta(payload.text);
      if (event === "done" && payload.snapshot) snapshot = payload.snapshot as ShortDramaProjectResponse;
      if (event === "error") throw new ApiError(Number(payload.status) || 502, String(payload.message || "Inspiration development failed"), typeof payload.code === "string" ? payload.code : undefined, payload);
    };
    while (true) {
      const part = await reader.read();
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) consume(block);
      if (part.done) break;
    }
    if (buffer.trim()) consume(buffer);
    if (!snapshot) throw new ApiError(response.status, "The service returned no completed snapshot.", "invalid_response");
    const completed = snapshot;
    await this.cache.put(completed);
    return completed;
  }

  async uploadInspirationAttachment(projectId: string, file: File): Promise<InspirationAttachment> {
    const form = new FormData();
    form.append("file", file);
    return httpClient.form<{ attachment: InspirationAttachment }>(
      `${projectPath(projectId)}/inspiration/attachments`,
      { body: form },
    ).then((value) => value.attachment);
  }

  async updateInspirationIntent(
    projectId: string,
    input: InspirationIntentUpdateRequest,
  ): Promise<ShortDramaProjectResponse> {
    const snapshot = await this.http.json<ShortDramaProjectResponse>(
      `${projectPath(projectId)}/inspiration/intent`,
      { method: "PATCH", body: input },
    );
    await this.cache.put(snapshot);
    return snapshot;
  }

  async approveStoryboard(projectId: string): Promise<ShortDramaProjectResponse> {
    const snapshot = await this.http.json<ShortDramaProjectResponse>(
      `${projectPath(projectId)}/storyboard/approve`,
      { method: "POST", body: {} },
    );
    await this.cache.put(snapshot);
    return snapshot;
  }

  async beginStoryboardRevision(projectId: string): Promise<ShortDramaProjectResponse> {
    const snapshot = await this.http.json<ShortDramaProjectResponse>(
      `${projectPath(projectId)}/creative-plan/storyboard-revision/start`,
      { method: "POST", body: {} },
    );
    await this.cache.put(snapshot);
    return snapshot;
  }

  async cancelStoryboardRevision(projectId: string): Promise<ShortDramaProjectResponse> {
    const snapshot = await this.http.json<ShortDramaProjectResponse>(
      `${projectPath(projectId)}/creative-plan/storyboard-revision/cancel`,
      { method: "POST", body: {} },
    );
    await this.cache.put(snapshot);
    return snapshot;
  }

  async updatePlanSection(
    projectId: string,
    section: PlanSectionId,
    input: PlanSectionUpdateRequest,
  ): Promise<ShortDramaProjectResponse> {
    const snapshot = await this.http.json<ShortDramaProjectResponse>(
      `${projectPath(projectId)}/creative-plan/sections/${encodeURIComponent(section)}`,
      { method: "PATCH", body: input },
    );
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
