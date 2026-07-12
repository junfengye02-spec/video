import {
  ApiError,
  HttpClient,
  getCsrfToken,
  notifyUnauthorized,
  onUnauthorized,
  setCsrfToken as setHttpCsrfToken,
} from "../platform/http/HttpClient";

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

export function setCsrfToken(value: string | null) {
  setHttpCsrfToken(value);
}

export function subscribeToAuthUnauthorized(listener: UnauthorizedListener) {
  return onUnauthorized(listener);
}

export function notifyAuthUnauthorized() {
  notifyUnauthorized();
}

function errorForStatus(status: number): AuthRequestError {
  if (status === 0) {
    return new AuthRequestError("network", "Unable to reach the service.");
  }
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

function requestBody(init: RequestInit): unknown {
  if (init.body === undefined || init.body === null) return undefined;
  const headers = new Headers(init.headers);
  const contentType = headers.get("Content-Type") ?? headers.get("content-type") ?? "";
  if (typeof init.body === "string" && (!contentType || contentType.includes("application/json"))) {
    try {
      return JSON.parse(init.body);
    } catch {
      return init.body;
    }
  }
  return init.body;
}

export async function authRequest<T = void>(
  path: string,
  init: RequestInit = {},
  options: AuthRequestOptions = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const client = new HttpClient({
    getCsrfToken,
    onUnauthorized: options.notifyUnauthorized === false ? undefined : notifyUnauthorized,
  });
  try {
    return await client.json<T>(path, {
      body: requestBody(init),
      headers: init.headers,
      method,
      signal: init.signal,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === "invalid_response") {
        throw new AuthRequestError(
          "invalid_response",
          "The service returned an invalid response.",
          error.status,
        );
      }
      throw errorForStatus(error.status);
    }
    throw error;
  }
}
