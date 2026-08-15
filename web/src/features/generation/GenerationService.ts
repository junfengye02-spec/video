import { GENERATION_UNITS_CONTRACT_VERSION } from "../../domain/types";
import type {
  AddAssetToProjectResponse,
  AssetRecord,
  CompositionAcceptedResponse,
  ContinuityPlan,
  ContinuityPlanResponse,
  CreativePlanReviseRequest,
  GenerateImagesRequest,
  GenerateImagesResponse,
  GenerationCapability,
  GenerationPlan,
  GenerationPlanPreviewRequest,
  GenerationUnitsGenerateRequest,
  GenerationUnitsGenerateResponse,
  GenerationModelsResponse,
  JobEvent,
  ListAssetsRequest,
  ListAssetsResponse,
  MediaAssetKind,
  PromptOptimizeResponse,
  PlannedAssetPromptUpdateRequest,
  ProductionConnectionState,
  ReferenceImageUploadRequest,
  ReferenceImageUploadResponse,
  RegenerateShotAcceptedResponse,
  RegenerateShotResponse,
  RenderProjectRequest,
  ShortDramaProjectResponse,
  RenderProjectResponse,
  RenderPreparation,
  ShotSaveRequest,
  TaskBatch,
  TaskListResponse,
  VideoModelProfile,
} from "../../domain/types";
import {
  ApiError,
  httpClient,
  type FormRequestInit,
  type JsonRequestInit,
} from "../../platform/http/HttpClient";

export type ShotSaveResponse = RegenerateShotResponse;

export interface GenerationService {
  listModels(capability: GenerationCapability): Promise<GenerationModelsResponse>;
  listAssets(payload: ListAssetsRequest): Promise<ListAssetsResponse>;
  generateImages(projectId: string, payload: GenerateImagesRequest): Promise<GenerateImagesResponse>;
  previewGenerationPlan(
    projectId: string,
    payload: GenerationPlanPreviewRequest,
  ): Promise<GenerationPlan>;
  generateGenerationUnits(
    projectId: string,
    payload: GenerationUnitsGenerateRequest,
  ): Promise<GenerationUnitsGenerateResponse>;
  listTasks(projectId: string): Promise<TaskListResponse>;
  retryTaskItem(projectId: string, taskId: string, itemId: string): Promise<TaskBatch>;
  addAssetToProject(projectId: string, assetId: string): Promise<AddAssetToProjectResponse>;
  reviseCreativePlan(
    projectId: string,
    payload: CreativePlanReviseRequest,
  ): Promise<ShortDramaProjectResponse>;
  optimize(projectId: string, shotId: string, sourceText: string): Promise<PromptOptimizeResponse>;
  optimizeImagePrompt(
    projectId: string,
    kind: MediaAssetKind,
    sourceText: string,
    billingJobId?: string,
  ): Promise<PromptOptimizeResponse>;
  saveShot(projectId: string, shotId: string, payload: ShotSaveRequest): Promise<ShotSaveResponse>;
  regenerate(
    projectId: string,
    shotId: string,
    videoModel?: string,
  ): Promise<RegenerateShotAcceptedResponse>;
  saveContinuity(projectId: string, plan: ContinuityPlan): Promise<ContinuityPlanResponse>;
  uploadReference(
    projectId: string,
    payload: ReferenceImageUploadRequest,
  ): Promise<ReferenceImageUploadResponse>;
  updatePlannedAssetPrompt(
    projectId: string,
    assetId: string,
    payload: PlannedAssetPromptUpdateRequest,
  ): Promise<{ asset: AssetRecord }>;
  prepareRender(projectId: string, selectedShotIds?: string[]): Promise<RenderPreparation>;
  compose(projectId: string, payload: RenderProjectRequest): Promise<CompositionAcceptedResponse>;
  render(projectId: string, payload?: RenderProjectRequest | boolean): Promise<RenderProjectResponse>;
  subscribe(
    projectId: string,
    onEvent: (event: JobEvent) => void,
    options?: JobSubscriptionOptions,
  ): () => void;
}

export interface JobSubscriptionOptions {
  onConnectionChange?: (state: ProductionConnectionState) => void;
}

interface EventSourceLike {
  addEventListener(type: string, listener: (message: MessageEvent) => void): void;
  close(): void;
}

interface GenerationHttp {
  json<T>(path: string, init?: JsonRequestInit): Promise<T>;
  form<T>(path: string, init: FormRequestInit): Promise<T>;
}

export interface GenerationServiceOptions {
  http?: GenerationHttp;
  eventSourceFactory?: (url: string) => EventSourceLike;
}

function generationModelsResponse(
  value: unknown,
  capability: GenerationCapability,
): GenerationModelsResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(200, "The model catalog response is invalid.", "invalid_response");
  }
  const record = value as Record<string, unknown>;
  if (
    record.capability !== capability
    || !Array.isArray(record.models)
    || record.models.some((model) => typeof model !== "string" || !model.trim())
    || (record.profiles !== undefined && !Array.isArray(record.profiles))
  ) {
    throw new ApiError(200, "The model catalog response is invalid.", "invalid_response");
  }
  return {
    capability,
    models: record.models as string[],
    profiles: capability === "video"
      ? (record.profiles ?? []) as VideoModelProfile[]
      : [],
  };
}

function generationConflictTaskId(error: unknown): string | null {
  if (!(error instanceof ApiError)
    || error.status !== 409
    || error.code !== "provider_generation_in_progress") return null;
  const value = error.details.task_id ?? error.details.taskId;
  return typeof value === "string" && value.trim() ? value : null;
}

const SHOT_SAVE_FIELDS = [
  "episode_number",
  "prompt",
  "characters",
  "location",
  "props",
  "asset_ids",
  "shot_intent",
  "shot_language",
  "continuity",
] as const;

function projectPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

function shotPath(projectId: string, shotId: string): string {
  return `${projectPath(projectId)}/shots/${encodeURIComponent(shotId)}`;
}

function publicShotSavePayload(payload: ShotSaveRequest): ShotSaveRequest {
  const safe: ShotSaveRequest = {};
  for (const field of SHOT_SAVE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      safe[field] = payload[field] as never;
    }
  }
  return safe;
}

function jobEvent(value: unknown, projectId: string): JobEvent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const fields = ["id", "job_id", "project_id", "stage", "status", "message", "created_at"];
  if (fields.some((field) => typeof record[field] !== "string" || !record[field])) return null;
  if (record.project_id !== projectId) return null;
  return record as unknown as JobEvent;
}

export class LocalGenerationService implements GenerationService {
  private readonly http: GenerationHttp;
  private readonly eventSourceFactory: (url: string) => EventSourceLike;
  private readonly generationPlanPreviews = new Map<string, Promise<GenerationPlan>>();

  constructor(options: GenerationServiceOptions = {}) {
    this.http = options.http ?? httpClient;
    this.eventSourceFactory = options.eventSourceFactory
      ?? ((url) => new EventSource(url));
  }

  async listModels(capability: GenerationCapability): Promise<GenerationModelsResponse> {
    const query = new URLSearchParams({ capability });
    const response = await this.http.json<unknown>(
      `/api/generation/models?${query.toString()}`,
    );
    return generationModelsResponse(response, capability);
  }

  listAssets(payload: ListAssetsRequest): Promise<ListAssetsResponse> {
    const query = new URLSearchParams({ scope: payload.scope });
    if (payload.project_id) query.set("project_id", payload.project_id);
    if (payload.kind) query.set("kind", payload.kind);
    if (payload.source_type) query.set("source_type", payload.source_type);
    if (payload.cursor) query.set("cursor", payload.cursor);
    if (payload.limit !== undefined) query.set("limit", String(payload.limit));
    return this.http.json<ListAssetsResponse>(`/api/assets?${query.toString()}`);
  }

  generateImages(
    projectId: string,
    payload: GenerateImagesRequest,
  ): Promise<GenerateImagesResponse> {
    return this.http.json<GenerateImagesResponse>(`${projectPath(projectId)}/images/generate`, {
      method: "POST",
      body: payload,
    });
  }

  previewGenerationPlan(
    projectId: string,
    payload: GenerationPlanPreviewRequest,
  ): Promise<GenerationPlan> {
    const request = {
      ...payload,
      contract_version: GENERATION_UNITS_CONTRACT_VERSION,
    };
    const requestKey = `${projectId}:${JSON.stringify(request)}`;
    const current = this.generationPlanPreviews.get(requestKey);
    if (current) return current;
    const pending = this.http.json<GenerationPlan>(
      `${projectPath(projectId)}/generation-plan/preview`,
      { method: "POST", body: request },
    );
    this.generationPlanPreviews.set(requestKey, pending);
    const cleanup = () => {
      if (this.generationPlanPreviews.get(requestKey) === pending) {
        this.generationPlanPreviews.delete(requestKey);
      }
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  generateGenerationUnits(
    projectId: string,
    payload: GenerationUnitsGenerateRequest,
  ): Promise<GenerationUnitsGenerateResponse> {
    return this.http.json<GenerationUnitsGenerateResponse>(
      `${projectPath(projectId)}/generation-units/generate`,
      {
        method: "POST",
        body: {
          ...payload,
          contract_version: GENERATION_UNITS_CONTRACT_VERSION,
        },
      },
    );
  }

  listTasks(projectId: string): Promise<TaskListResponse> {
    return this.http.json<TaskListResponse>(`${projectPath(projectId)}/tasks?include_items=true`);
  }

  retryTaskItem(projectId: string, taskId: string, itemId: string): Promise<TaskBatch> {
    return this.http.json<TaskBatch>(
      `${projectPath(projectId)}/tasks/${encodeURIComponent(taskId)}/items/${encodeURIComponent(itemId)}/retry`,
      { method: "POST", body: {} },
    );
  }

  addAssetToProject(
    projectId: string,
    assetId: string,
  ): Promise<AddAssetToProjectResponse> {
    return this.http.json<AddAssetToProjectResponse>(
      `${projectPath(projectId)}/assets/${encodeURIComponent(assetId)}/add`,
      { method: "POST", body: {} },
    );
  }

  reviseCreativePlan(
    projectId: string,
    payload: CreativePlanReviseRequest,
  ): Promise<ShortDramaProjectResponse> {
    return this.http.json<ShortDramaProjectResponse>(
      `${projectPath(projectId)}/creative-plan/revise`,
      { method: "POST", body: payload },
    );
  }

  optimize(
    projectId: string,
    shotId: string,
    sourceText: string,
  ): Promise<PromptOptimizeResponse> {
    return this.http.json<PromptOptimizeResponse>(`${projectPath(projectId)}/prompt-optimize`, {
      method: "POST",
      body: {
        target: "shot",
        target_id: shotId,
        source_text: sourceText,
        mode: "shot_json",
      },
    });
  }

  optimizeImagePrompt(
    projectId: string,
    kind: MediaAssetKind,
    sourceText: string,
    billingJobId?: string,
  ): Promise<PromptOptimizeResponse> {
    return this.http.json<PromptOptimizeResponse>(`${projectPath(projectId)}/prompt-optimize`, {
      method: "POST",
      body: {
        target: "asset",
        target_id: "image-generation-draft",
        asset_kind: kind,
        source_text: sourceText,
        mode: "text",
        ...(billingJobId ? { billing_job_id: billingJobId } : {}),
      },
    });
  }

  saveShot(
    projectId: string,
    shotId: string,
    payload: ShotSaveRequest,
  ): Promise<ShotSaveResponse> {
    return this.http.json<ShotSaveResponse>(shotPath(projectId, shotId), {
      method: "PATCH",
      body: publicShotSavePayload(payload),
    });
  }

  async regenerate(
    projectId: string,
    shotId: string,
    videoModel?: string,
  ): Promise<RegenerateShotAcceptedResponse> {
    try {
      return await this.http.json<RegenerateShotAcceptedResponse>(
        `${shotPath(projectId, shotId)}/regenerate`,
        {
          method: "POST",
          body: videoModel ? { video_model: videoModel } : {},
        },
      );
    } catch (error) {
      const taskId = generationConflictTaskId(error);
      if (!taskId) throw error;
      const { tasks } = await this.listTasks(projectId);
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw error;
      return {
        task_id: task.id,
        status: task.status,
        deduplicated: true,
        task,
      };
    }
  }

  saveContinuity(projectId: string, plan: ContinuityPlan): Promise<ContinuityPlanResponse> {
    return this.http.json<ContinuityPlanResponse>(`${projectPath(projectId)}/continuity`, {
      method: "PATCH",
      body: plan,
    });
  }

  uploadReference(
    projectId: string,
    payload: ReferenceImageUploadRequest,
  ): Promise<ReferenceImageUploadResponse> {
    const form = new FormData();
    form.append("kind", payload.kind);
    form.append("label", payload.label);
    form.append("description", payload.description);
    form.append("prompt", payload.prompt);
    if (payload.resource_id) form.append("resource_id", payload.resource_id);
    form.append("file", payload.file);
    return this.http.form<ReferenceImageUploadResponse>(`${projectPath(projectId)}/assets/upload`, {
      body: form,
    });
  }

  updatePlannedAssetPrompt(
    projectId: string,
    assetId: string,
    payload: PlannedAssetPromptUpdateRequest,
  ): Promise<{ asset: AssetRecord }> {
    return this.http.json(`${projectPath(projectId)}/assets/${encodeURIComponent(assetId)}`, {
      method: "PATCH",
      body: payload,
    });
  }

  prepareRender(projectId: string, selectedShotIds?: string[]): Promise<RenderPreparation> {
    return this.http.json<RenderPreparation>(`${projectPath(projectId)}/render/prepare`, {
      method: "POST",
      body: selectedShotIds ? { selected_shot_ids: selectedShotIds } : {},
    });
  }

  compose(projectId: string, payload: RenderProjectRequest): Promise<CompositionAcceptedResponse> {
    return this.http.json<CompositionAcceptedResponse>(`${projectPath(projectId)}/composition`, {
      method: "POST",
      body: payload,
    });
  }

  render(projectId: string, payload: RenderProjectRequest | boolean = {}): Promise<RenderProjectResponse> {
    const request = typeof payload === "boolean"
      ? (payload ? { resume_existing: true } : {})
      : payload;
    return this.http.json<RenderProjectResponse>(`${projectPath(projectId)}/render`, {
      method: "POST",
      body: request,
    });
  }

  subscribe(
    projectId: string,
    onEvent: (event: JobEvent) => void,
    options: JobSubscriptionOptions = {},
  ): () => void {
    options.onConnectionChange?.("connecting");
    const source = this.eventSourceFactory(`${projectPath(projectId)}/events`);
    source.addEventListener("job", (message) => {
      try {
        const event = jobEvent(JSON.parse(message.data) as unknown, projectId);
        if (event) onEvent(event);
      } catch {
        // A malformed event is ignored; EventSource remains available for later server events.
      }
    });
    source.addEventListener("open", () => {
      options.onConnectionChange?.("connected");
    });
    source.addEventListener("error", () => {
      options.onConnectionChange?.("disconnected");
    });
    return () => {
      source.close();
    };
  }
}

export const generationService = new LocalGenerationService();
