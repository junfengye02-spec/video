export type AuthErrorCode =
  | "network"
  | "unauthorized"
  | "forbidden"
  | "validation"
  | "conflict"
  | "rate_limited"
  | "server"
  | "request_failed"
  | "invalid_response";

export class AuthRequestError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number | null;

  constructor(code: AuthErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "AuthRequestError";
    this.code = code;
    this.status = status;
  }
}
interface AuthRequestOptions {
  notifyUnauthorized?: boolean;
}

type UnauthorizedListener = () => void;

let csrfToken: string | null = null;
const unauthorizedListeners = new Set<UnauthorizedListener>();

export function setCsrfToken(value: string | null) {
  csrfToken = value;
}

export function subscribeToAuthUnauthorized(listener: UnauthorizedListener) {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export function notifyAuthUnauthorized() {
  for (const listener of unauthorizedListeners) {
    try {
      listener();
    } catch {
      // A stale consumer must not prevent the remaining auth listeners from recovering.
    }
  }
}

function errorForStatus(status: number): AuthRequestError {
  if (status === 400 || status === 422) {
    return new AuthRequestError("validation", "Please check the submitted information.", status);
  }
  if (status === 401) {
    return new AuthRequestError("unauthorized", "Authentication is required.", status);
  }
  if (status === 403) {
    return new AuthRequestError("forbidden", "This action is not allowed.", status);
  }
  if (status === 409) {
    return new AuthRequestError("conflict", "The request conflicts with the account state.", status);
  }
  if (status === 429) {
    return new AuthRequestError("rate_limited", "Too many requests. Please try again later.", status);
  }
  if (status >= 500) {
    return new AuthRequestError("server", "The service is temporarily unavailable.", status);
  }
  return new AuthRequestError("request_failed", "The request could not be completed.", status);
}

function isJsonBody(body: BodyInit | null | undefined): boolean {
  return typeof body === "string";
}

export async function authRequest<T = void>(
  path: string,
  init: RequestInit = {},
  options: AuthRequestOptions = {},
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (isJsonBody(init.body) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (method !== "GET" && method !== "HEAD" && csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "include",
      headers,
    });
  } catch {
    throw new AuthRequestError("network", "Unable to reach the service.");
  }

  if (!response.ok) {
    if (response.status === 401 && options.notifyUnauthorized !== false) {
      notifyAuthUnauthorized();
    }
    throw errorForStatus(response.status);
  }
  if (response.status === 204) {
    return undefined as T;
  }

  try {
    return await response.json() as T;
  } catch {
    throw new AuthRequestError(
      "invalid_response",
      "The service returned an invalid response.",
      response.status,
    );
  }
}
