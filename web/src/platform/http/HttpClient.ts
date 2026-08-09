export interface HttpClientOptions {
  fetcher?: typeof fetch;
  getCsrfToken?: () => string | null;
  onUnauthorized?: () => void;
}

export interface JsonRequestInit {
  headers?: HeadersInit;
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

export interface FormRequestInit {
  headers?: HeadersInit;
  method?: string;
  body: FormData;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;
const unauthorizedListeners = new Set<() => void>();

export function setCsrfToken(value: string | null) {
  csrfToken = value;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export function onUnauthorized(listener: () => void) {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export function notifyUnauthorized() {
  for (const listener of unauthorizedListeners) {
    try {
      listener();
    } catch {
      // A stale listener must not prevent the rest of the app from recovering.
    }
  }
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

async function parseErrorBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = await response.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function errorDetails(body: Record<string, unknown>): Record<string, unknown> {
  const nested = body.detail;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? { ...body, ...(nested as Record<string, unknown>) }
    : body;
}

export class HttpClient {
  constructor(private readonly options: HttpClientOptions = {}) {}

  async json<T>(path: string, init: JsonRequestInit = {}): Promise<T> {
    const requestMethod = init.method ?? "GET";
    const method = requestMethod.toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const csrf = this.options.getCsrfToken?.() ?? null;
    if (isMutation(method) && csrf) headers.set("X-CSRF-Token", csrf);

    return this.send<T>(path, {
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "include",
      headers,
      method: requestMethod,
      signal: init.signal,
    });
  }

  async form<T>(path: string, init: FormRequestInit): Promise<T> {
    const requestMethod = init.method ?? "POST";
    const method = requestMethod.toUpperCase();
    const headers = new Headers(init.headers);
    const csrf = this.options.getCsrfToken?.() ?? null;
    if (isMutation(method) && csrf) headers.set("X-CSRF-Token", csrf);

    return this.send<T>(path, {
      body: init.body,
      credentials: "include",
      headers,
      method: requestMethod,
      signal: init.signal,
    });
  }

  private async send<T>(path: string, init: RequestInit): Promise<T> {
    const fetcher = this.options.fetcher ?? fetch;
    let response: Response;
    try {
      response = await fetcher(path, init);
    } catch {
      throw new ApiError(0, "Unable to reach the service.", "network");
    }

    if (response.status === 401) this.options.onUnauthorized?.();
    if (!response.ok) {
      const body = await parseErrorBody(response);
      const details = errorDetails(body);
      throw new ApiError(
        response.status,
        typeof body.detail === "string"
          ? body.detail
          : typeof details.message === "string"
            ? details.message
          : `Request failed with status ${response.status}`,
        typeof details.code === "string" ? details.code : undefined,
        details,
      );
    }
    if (response.status === 204) return undefined as T;

    try {
      return await response.json() as T;
    } catch {
      throw new ApiError(response.status, "The service returned an invalid response.", "invalid_response");
    }
  }
}

export const httpClient = new HttpClient({
  getCsrfToken,
  onUnauthorized: notifyUnauthorized,
});
