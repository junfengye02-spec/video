import type {
  ContinuityPlan,
  ContinuityPlanResponse,
  DraftProjectRequest,
  JobEvent,
  PromptOptimizeRequest,
  PromptOptimizeResponse,
  ReferenceImageUploadRequest,
  ReferenceImageUploadResponse,
  RenderProjectRequest,
  RegenerateShotResponse,
  RenderProjectResponse,
  ShortDramaProjectRequest,
  ShortDramaProjectResponse,
  ShotRegenerateRequest,
  ShotSaveRequest,
} from "../domain/types";
import {
  HttpClient,
  getCsrfToken,
  notifyUnauthorized,
  type JsonRequestInit,
} from "../platform/http/HttpClient";

export { authRequest } from "../auth/api";

async function requestJson<T>(
  path: string,
  init: JsonRequestInit,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const client = new HttpClient({
    fetcher,
    getCsrfToken,
    onUnauthorized: notifyUnauthorized,
  });
  return client.json<T>(path, init);
}

function postJson<T>(
  path: string,
  body: unknown,
  fetcher?: typeof fetch,
): Promise<T> {
  return requestJson<T>(
    path,
    {
      method: "POST",
      body,
    },
    fetcher,
  );
}

async function requestForm<T>(
  path: string,
  body: FormData,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const client = new HttpClient({
    fetcher,
    getCsrfToken,
    onUnauthorized: notifyUnauthorized,
  });
  return client.form<T>(path, { body });
}

export function mediaUrl(path: string | null | undefined, projectId?: string | null): string | null {
  const value = path?.trim();
  if (!value) {
    return null;
  }
  const mediaPattern =
    /^\/api\/projects\/[^/]+\/media\/(?:renders\/final\.(?:mp4|mov|webm)|assets\/video\/.+\.(?:mp4|mov|webm)|assets\/images\/.+\.(?:png|jpg|jpeg|webp))$/i;
  if (mediaPattern.test(value)) {
    return value;
  }
  const relativeMediaPattern =
    /^(?:renders\/final\.(?:mp4|mov|webm)|assets\/video\/.+\.(?:mp4|mov|webm)|assets\/images\/.+\.(?:png|jpg|jpeg|webp))$/i;
  if (projectId && relativeMediaPattern.test(value)) {
    const encodedPath = value.split("/").map(encodeURIComponent).join("/");
    return `/api/projects/${encodeURIComponent(projectId)}/media/${encodedPath}`;
  }
  return null;
}

export function createShortDramaProject(
  payload: ShortDramaProjectRequest,
  fetcher?: typeof fetch,
): Promise<ShortDramaProjectResponse> {
  return postJson<ShortDramaProjectResponse>("/api/projects/short-drama", payload, fetcher);
}

export function createDraftProject(
  payload: DraftProjectRequest,
  fetcher?: typeof fetch,
): Promise<ShortDramaProjectResponse> {
  return postJson<ShortDramaProjectResponse>("/api/projects", payload, fetcher);
}

export function saveShot(
  projectId: string,
  shotId: string,
  payload: ShotSaveRequest,
  fetcher?: typeof fetch,
): Promise<RegenerateShotResponse> {
  return requestJson<RegenerateShotResponse>(
    `/api/projects/${projectId}/shots/${shotId}`,
    {
      method: "PATCH",
      body: payload,
    },
    fetcher,
  );
}

export function optimizePrompt(
  projectId: string,
  payload: PromptOptimizeRequest,
  fetcher?: typeof fetch,
): Promise<PromptOptimizeResponse> {
  return postJson<PromptOptimizeResponse>(`/api/projects/${projectId}/prompt-optimize`, payload, fetcher);
}

export function regenerateShot(
  projectId: string,
  shotId: string,
  payload: ShotRegenerateRequest,
  fetcher?: typeof fetch,
): Promise<RegenerateShotResponse> {
  return postJson<RegenerateShotResponse>(
    `/api/projects/${projectId}/shots/${shotId}/regenerate`,
    payload,
    fetcher,
  );
}

export function renderProject(
  projectId: string,
  payload: RenderProjectRequest,
  fetcher?: typeof fetch,
): Promise<RenderProjectResponse> {
  return postJson<RenderProjectResponse>(`/api/projects/${projectId}/render`, payload, fetcher);
}

export function saveContinuityPlan(
  projectId: string,
  payload: ContinuityPlan,
  fetcher?: typeof fetch,
): Promise<ContinuityPlanResponse> {
  return requestJson<ContinuityPlanResponse>(
    `/api/projects/${projectId}/continuity`,
    {
      method: "PATCH",
      body: payload,
    },
    fetcher,
  );
}

export function uploadReferenceImage(
  projectId: string,
  payload: ReferenceImageUploadRequest,
  fetcher?: typeof fetch,
): Promise<ReferenceImageUploadResponse> {
  const form = new FormData();
  form.append("kind", payload.kind);
  form.append("label", payload.label);
  form.append("description", payload.description);
  form.append("prompt", payload.prompt);
  form.append("file", payload.file);
  return requestForm<ReferenceImageUploadResponse>(
    `/api/projects/${projectId}/assets/upload`,
    form,
    fetcher,
  );
}

export function loadProject(
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<ShortDramaProjectResponse> {
  return requestJson<ShortDramaProjectResponse>(
    `/api/projects/${projectId}`,
    { method: "GET" },
    fetcher,
  );
}

export function loadLatestProject(
  fetcher: typeof fetch = fetch,
): Promise<ShortDramaProjectResponse> {
  return requestJson<ShortDramaProjectResponse>(
    "/api/projects/latest",
    { method: "GET" },
    fetcher,
  );
}

export function subscribeProjectEvents(
  projectId: string,
  onEvent: (event: JobEvent) => void,
): () => void {
  const source = new EventSource(`/api/projects/${projectId}/events`);

  source.addEventListener("job", (message) => {
    const event = JSON.parse((message as MessageEvent).data) as JobEvent;
    onEvent(event);
  });

  return () => {
    source.close();
  };
}
