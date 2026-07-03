import type {
  GatewayKeySession,
  JobEvent,
  ProviderCredentials,
  RegenerateShotResponse,
  RenderProjectResponse,
  ShortDramaProjectRequest,
  ShortDramaProjectResponse,
  ShotRegenerateRequest,
  ShotSaveRequest,
} from "../domain/types";

async function requestJson<T>(
  path: string,
  init: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const response = await fetcher(path, {
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) {
        message = body.detail;
      }
    } catch {
      // Keep the status-based fallback when the backend returns non-JSON.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
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
      body: JSON.stringify(body),
    },
    fetcher,
  );
}

export function saveGatewayKey(
  payload: ProviderCredentials,
  fetcher?: typeof fetch,
): Promise<GatewayKeySession> {
  return postJson<GatewayKeySession>("/api/session/key", payload, fetcher);
}

export function createShortDramaProject(
  payload: ShortDramaProjectRequest,
  fetcher?: typeof fetch,
): Promise<ShortDramaProjectResponse> {
  return postJson<ShortDramaProjectResponse>("/api/projects/short-drama", payload, fetcher);
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
      body: JSON.stringify(payload),
    },
    fetcher,
  );
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
  payload: ProviderCredentials & { render_runtime: "ffmpeg" },
  fetcher?: typeof fetch,
): Promise<RenderProjectResponse> {
  return postJson<RenderProjectResponse>(`/api/projects/${projectId}/render`, payload, fetcher);
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

export function subscribeProjectEvents(
  projectId: string,
  onEvent: (event: JobEvent) => void,
): () => void {
  const source = new EventSource(`/api/projects/${projectId}/events`);

  source.addEventListener("job", (message) => {
    const event = JSON.parse((message as MessageEvent).data) as JobEvent;
    onEvent(event);
  });

  source.onerror = () => {
    source.close();
  };

  return () => {
    source.close();
  };
}
