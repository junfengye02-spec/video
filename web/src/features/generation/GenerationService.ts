import type {
  JobEvent,
  PromptOptimizeResponse,
  RegenerateShotResponse,
  RenderProjectResponse,
  ShotSaveRequest,
} from "../../domain/types";
import { httpClient, type JsonRequestInit } from "../../platform/http/HttpClient";

export type ShotSaveResponse = RegenerateShotResponse;

export interface GenerationService {
  optimize(projectId: string, shotId: string, sourceText: string): Promise<PromptOptimizeResponse>;
  saveShot(projectId: string, shotId: string, payload: ShotSaveRequest): Promise<ShotSaveResponse>;
  regenerate(projectId: string, shotId: string): Promise<RegenerateShotResponse>;
  render(projectId: string): Promise<RenderProjectResponse>;
  subscribe(projectId: string, onEvent: (event: JobEvent) => void): () => void;
}

interface EventSourceLike {
  addEventListener(type: string, listener: (message: MessageEvent) => void): void;
  close(): void;
}

interface GenerationHttp {
  json<T>(path: string, init?: JsonRequestInit): Promise<T>;
}

export interface GenerationServiceOptions {
  http?: GenerationHttp;
  eventSourceFactory?: (url: string) => EventSourceLike;
}

const SHOT_SAVE_FIELDS = [
  "prompt",
  "characters",
  "location",
  "props",
  "asset_ids",
  "shot_intent",
  "shot_language",
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

export class LocalGenerationService implements GenerationService {
  private readonly http: GenerationHttp;
  private readonly eventSourceFactory: (url: string) => EventSourceLike;

  constructor(options: GenerationServiceOptions = {}) {
    this.http = options.http ?? httpClient;
    this.eventSourceFactory = options.eventSourceFactory
      ?? ((url) => new EventSource(url));
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

  regenerate(projectId: string, shotId: string): Promise<RegenerateShotResponse> {
    return this.http.json<RegenerateShotResponse>(`${shotPath(projectId, shotId)}/regenerate`, {
      method: "POST",
      body: {},
    });
  }

  render(projectId: string): Promise<RenderProjectResponse> {
    return this.http.json<RenderProjectResponse>(`${projectPath(projectId)}/render`, {
      method: "POST",
      body: { render_runtime: "ffmpeg" },
    });
  }

  subscribe(projectId: string, onEvent: (event: JobEvent) => void): () => void {
    const source = this.eventSourceFactory(`${projectPath(projectId)}/events`);
    source.addEventListener("job", (message) => {
      const event = JSON.parse(message.data) as JobEvent;
      onEvent(event);
    });
    return () => {
      source.close();
    };
  }
}

export const generationService = new LocalGenerationService();
