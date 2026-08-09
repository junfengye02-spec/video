import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthRequestError,
  authRequest,
  notifyAuthUnauthorized,
  setCsrfToken,
  subscribeToAuthUnauthorized,
} from "./api";
import { AuthProvider, useAuth } from "./AuthProvider";
import { RequireAuth } from "./RequireAuth";

const user = { id: "u1", email: "person@example.com", role: "user" as const };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function StateProbe() {
  const auth = useAuth();
  return (
    <div>
      <span>{auth.loading ? "loading" : auth.user?.email ?? "anonymous"}</span>
      <button
        type="button"
        onClick={() => void auth.login({ email: user.email, password: "password123" })}
      >
        login
      </button>
      <button
        type="button"
        onClick={() => void auth.register({
          email: user.email,
          password: "password123",
          code: "123456",
        })}
      >
        register
      </button>
      <button type="button" onClick={() => void auth.sendVerification(user.email)}>
        send verification
      </button>
      <button type="button" onClick={() => void auth.logout()}>logout</button>
    </div>
  );
}

function LoginErrorProbe() {
  const auth = useAuth();
  const [errorCode, setErrorCode] = useState("");
  return (
    <div>
      <span>{errorCode}</span>
      <button
        type="button"
        onClick={() => void auth.login({ email: user.email, password: "wrong-password" }).catch((error: unknown) => {
          if (error instanceof AuthRequestError) setErrorCode(error.code);
        })}
      >
        login
      </button>
    </div>
  );
}

function LocationProbe() {
  const location = useLocation();
  const intended = (location.state as { from?: Location } | null)?.from;
  return <span>{intended ? `${intended.pathname}${intended.search}${intended.hash}` : "none"}</span>;
}

beforeEach(() => {
  setCsrfToken(null);
});

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("authRequest", () => {
  it("sends credentialed JSON and injects the in-memory CSRF token for unsafe requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    setCsrfToken("csrf-memory-only");

    await expect(authRequest<{ ok: boolean }>("/api/auth/login", {
      method: "post",
      body: JSON.stringify({ email: user.email }),
    })).resolves.toEqual({ ok: true });

    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(init).toEqual(expect.objectContaining({ credentials: "include", method: "post" }));
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-CSRF-Token")).toBe("csrf-memory-only");
  });

  it("does not add a CSRF header to safe requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ user }));
    vi.stubGlobal("fetch", fetchMock);
    setCsrfToken("csrf-safe-request");

    await authRequest("/api/auth/me");

    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has("X-CSRF-Token")).toBe(false);
  });

  it("returns undefined for an empty 204 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    await expect(authRequest("/api/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });

  it("raises a structured generic error without reflecting response secrets", async () => {
    const secret = "password123-should-never-render";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ detail: secret }, 500)));

    const error = await authRequest("/api/private").catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AuthRequestError);
    expect(error).toMatchObject({ code: "server", status: 500 });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it.each([
    [422, "email_domain_unavailable"],
    [503, "email_delivery_unavailable"],
    [503, "email_delivery_failed"],
  ] as const)("preserves the safe email error code for status %s", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      detail: { code, message: "safe message" },
    }, status)));

    await expect(authRequest("/api/auth/email-verifications", { method: "POST" }))
      .rejects.toMatchObject({ code, status });
  });

  it("distinguishes a stale CSRF token from a forbidden request origin", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "Invalid CSRF token" }, 403))
      .mockResolvedValueOnce(jsonResponse({ detail: "Invalid request origin" }, 403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(authRequest("/api/auth/login", { method: "POST" }))
      .rejects.toMatchObject({ code: "csrf_invalid", status: 403 });
    await expect(authRequest("/api/auth/login", { method: "POST" }))
      .rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("distinguishes a missing session from invalid credentials", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "Authentication required" }, 401))
      .mockResolvedValueOnce(jsonResponse({ detail: "Email or password is incorrect" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(authRequest("/api/auth/login", { method: "POST" }))
      .rejects.toMatchObject({ code: "session_invalid", status: 401 });
    await expect(authRequest("/api/auth/login", { method: "POST" }))
      .rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("notifies narrow subscribers after an unauthorized response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ detail: "no" }, 401)));
    const listener = vi.fn();
    const unsubscribe = subscribeToAuthUnauthorized(listener);

    await expect(authRequest("/api/private")).rejects.toMatchObject({ status: 401 });

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe("AuthProvider", () => {
  it("boots from /api/auth/me, acquires CSRF, and exposes the current user", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      if (String(input) === "/api/auth/csrf") return jsonResponse({ csrf_token: "csrf-auth" });
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthProvider><StateProbe /></AuthProvider>);

    expect(await screen.findByText(user.email)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/me",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/csrf",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("bootstraps anonymous CSRF after /me returns 401 before exposing public state", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return String(input) === "/api/auth/me"
        ? jsonResponse({ detail: "Authentication required" }, 401)
        : jsonResponse({ csrf_token: "csrf-anonymous" });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthProvider><StateProbe /></AuthProvider>);

    expect(await screen.findByText("anonymous")).toBeInTheDocument();
    expect(calls).toEqual(["/api/auth/me", "/api/auth/csrf"]);
  });

  it("refreshes anonymous CSRF and retries verification after a stale session 401", async () => {
    let csrfCount = 0;
    let verificationCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/auth/me") return jsonResponse({ detail: "no" }, 401);
      if (path === "/api/auth/csrf") {
        csrfCount += 1;
        return jsonResponse({ csrf_token: `csrf-${csrfCount}` });
      }
      if (path === "/api/auth/email-verifications") {
        verificationCount += 1;
        if (verificationCount === 1) return jsonResponse({ detail: "Authentication required" }, 401);
        expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf-2");
        return jsonResponse({ detail: "Verification code sent" }, 202);
      }
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthProvider><StateProbe /></AuthProvider>);
    await screen.findByText("anonymous");

    fireEvent.click(screen.getByRole("button", { name: "send verification" }));

    await waitFor(() => expect(verificationCount).toBe(2));
    expect(csrfCount).toBe(2);
  });

  it("does not retry a login that failed because the credentials were invalid", async () => {
    let csrfCount = 0;
    let loginCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/me") return jsonResponse({ detail: "Authentication required" }, 401);
      if (path === "/api/auth/csrf") {
        csrfCount += 1;
        return jsonResponse({ csrf_token: `csrf-${csrfCount}` });
      }
      if (path === "/api/auth/login") {
        loginCount += 1;
        return jsonResponse({ detail: "Email or password is incorrect" }, 401);
      }
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthProvider><LoginErrorProbe /></AuthProvider>);
    await waitFor(() => expect(csrfCount).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "login" }));

    expect(await screen.findByText("unauthorized")).toBeInTheDocument();
    expect(loginCount).toBe(1);
    expect(csrfCount).toBe(1);
  });

  it("does not let a superseded CSRF request overwrite a forced refresh", async () => {
    const firstCsrf = deferredResponse();
    let csrfCount = 0;
    let verificationCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/auth/me") return jsonResponse({ detail: "Authentication required" }, 401);
      if (path === "/api/auth/csrf") {
        csrfCount += 1;
        if (csrfCount === 1) return firstCsrf.promise;
        return jsonResponse({ csrf_token: "csrf-fresh" });
      }
      if (path === "/api/auth/email-verifications") {
        verificationCount += 1;
        if (verificationCount === 1) return jsonResponse({ detail: "Authentication required" }, 401);
        expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf-fresh");
        return jsonResponse({ detail: "Verification code sent" }, 202);
      }
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthProvider><StateProbe /></AuthProvider>);
    await waitFor(() => expect(csrfCount).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "send verification" }));
    await waitFor(() => expect(verificationCount).toBe(1));
    firstCsrf.resolve(jsonResponse({ csrf_token: "csrf-stale" }));

    await waitFor(() => expect(verificationCount).toBe(2));
    expect(csrfCount).toBe(2);
  });

  it("refreshes anonymous CSRF and retries login after a stale-token 403", async () => {
    let csrfCount = 0;
    let loginCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/auth/me") return jsonResponse({ detail: "no" }, 401);
      if (path === "/api/auth/csrf") {
        csrfCount += 1;
        return jsonResponse({ csrf_token: `csrf-${csrfCount}` });
      }
      if (path === "/api/auth/login") {
        loginCount += 1;
        if (loginCount === 1) return jsonResponse({ detail: "Invalid CSRF token" }, 403);
        expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf-2");
        return jsonResponse({ user, csrf_token: "csrf-login" });
      }
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthProvider><StateProbe /></AuthProvider>);
    await screen.findByText("anonymous");

    fireEvent.click(screen.getByRole("button", { name: "login" }));

    expect(await screen.findByText(user.email)).toBeInTheDocument();
    expect(loginCount).toBe(2);
    expect(csrfCount).toBe(2);
  });

  it.each(["login", "register"] as const)("stores the successful %s session in memory", async (action) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/auth/me") return jsonResponse({ detail: "no" }, 401);
      if (path === "/api/auth/csrf") return jsonResponse({ csrf_token: "csrf-public" });
      if (path === `/api/auth/${action}`) {
        return jsonResponse({ user, csrf_token: `csrf-${action}` }, action === "register" ? 201 : 200);
      }
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthProvider><StateProbe /></AuthProvider>);
    await screen.findByText("anonymous");

    fireEvent.click(screen.getByRole("button", { name: action }));

    expect(await screen.findByText(user.email)).toBeInTheDocument();
    const mutation = fetchMock.mock.calls.find(([path]) => String(path) === `/api/auth/${action}`);
    expect(JSON.parse(String(mutation?.[1]?.body))).toEqual(action === "login"
      ? { email: user.email, password: "password123" }
      : { email: user.email, password: "password123", code: "123456" });
    expect(new Headers(mutation?.[1]?.headers).get("X-CSRF-Token")).toBe("csrf-public");
  });

  it("clears the user after logout and reacquires anonymous CSRF", async () => {
    const paths: string[] = [];
    let csrfCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      paths.push(path);
      if (path === "/api/auth/me") return jsonResponse({ user });
      if (path === "/api/auth/csrf") {
        csrfCount += 1;
        return jsonResponse({ csrf_token: `csrf-${csrfCount}` });
      }
      if (path === "/api/auth/logout") return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthProvider><StateProbe /></AuthProvider>);
    await screen.findByText(user.email);

    fireEvent.click(screen.getByRole("button", { name: "logout" }));

    expect(await screen.findByText("anonymous")).toBeInTheDocument();
    expect(paths).toEqual([
      "/api/auth/me",
      "/api/auth/csrf",
      "/api/auth/logout",
      "/api/auth/csrf",
    ]);
  });

  it("preserves authenticated state when logout does not reach the server", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/auth/me") return jsonResponse({ user });
      if (path === "/api/auth/csrf") return jsonResponse({ csrf_token: "csrf-auth" });
      if (path === "/api/auth/logout") throw new TypeError("network down");
      throw new Error(`Unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    function LogoutProbe() {
      const auth = useAuth();
      const [error, setError] = useState("");
      return (
        <div>
          <span>{auth.user?.email ?? "anonymous"}</span>
          <button type="button" onClick={() => void auth.logout().catch((reason) => setError(String(reason)))}>
            logout safely
          </button>
          <span>{error}</span>
        </div>
      );
    }

    render(<AuthProvider><LogoutProbe /></AuthProvider>);
    await screen.findByText(user.email);
    fireEvent.click(screen.getByRole("button", { name: "logout safely" }));

    expect(await screen.findByText(/Unable to reach the service/)).toBeInTheDocument();
    expect(screen.getByText(user.email)).toBeInTheDocument();
  });

  it("clears stale authenticated state on a later 401 notification and reacquires CSRF", async () => {
    let csrfCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/auth/me") return jsonResponse({ user });
      if (String(input) === "/api/auth/csrf") {
        csrfCount += 1;
        return jsonResponse({ csrf_token: `csrf-${csrfCount}` });
      }
      throw new Error(`Unexpected request ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthProvider><StateProbe /></AuthProvider>);
    await screen.findByText(user.email);

    act(() => notifyAuthUnauthorized());

    expect(await screen.findByText("anonymous")).toBeInTheDocument();
    await waitFor(() => expect(csrfCount).toBe(2));
  });

  it("never writes auth or CSRF data to browser storage", async () => {
    const localWrite = vi.spyOn(Storage.prototype, "setItem");
    const indexedDbOpen = vi.fn();
    vi.stubGlobal("indexedDB", { open: indexedDbOpen });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/auth/me"
      ? jsonResponse({ user })
      : jsonResponse({ csrf_token: "csrf-storage-test" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthProvider><StateProbe /></AuthProvider>);
    await screen.findByText(user.email);

    expect(localWrite).not.toHaveBeenCalled();
    expect(indexedDbOpen).not.toHaveBeenCalled();
  });

  it("does not commit a late boot response after unmount", async () => {
    const deferred = deferredResponse();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(deferred.promise));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(<AuthProvider><StateProbe /></AuthProvider>);

    view.unmount();
    await act(async () => {
      deferred.resolve(jsonResponse({ user }));
      await deferred.promise;
    });

    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("RequireAuth", () => {
  it("keeps protected content hidden while authentication is loading", () => {
    const deferred = deferredResponse();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(deferred.promise));

    render(
      <MemoryRouter
        future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
        initialEntries={["/projects"]}
      >
        <AuthProvider>
          <Routes>
            <Route element={<RequireAuth />}>
              <Route path="/projects" element={<div>private</div>} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Checking your session");
    expect(screen.queryByText("private")).not.toBeInTheDocument();
  });

  it("redirects anonymous users to login and preserves the intended location", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/auth/me"
      ? jsonResponse({}, 401)
      : jsonResponse({ csrf_token: "csrf-route" }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter
        future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
        initialEntries={["/projects/p1/storyboard?mode=edit#shot-2"]}
      >
        <AuthProvider>
          <Routes>
            <Route element={<RequireAuth />}>
              <Route path="/projects/:id/storyboard" element={<div>private</div>} />
            </Route>
            <Route path="/login" element={<LocationProbe />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("/projects/p1/storyboard?mode=edit#shot-2")).toBeInTheDocument();
    expect(screen.queryByText("private")).not.toBeInTheDocument();
  });

  it("renders the outlet after authenticated boot", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/auth/me"
      ? jsonResponse({ user })
      : jsonResponse({ csrf_token: "csrf-route-auth" }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <MemoryRouter
        future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
        initialEntries={["/projects"]}
      >
        <AuthProvider>
          <Routes>
            <Route element={<RequireAuth />}>
              <Route path="/projects" element={<div>private</div>} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("private")).toBeInTheDocument();
  });
});
