import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthProvider";
import { setCsrfToken } from "../auth/api";
import { ForgotPasswordPage } from "./ForgotPasswordPage";
import { LoginPage } from "./LoginPage";
import { RegisterPage } from "./RegisterPage";
import { ResetPasswordPage } from "./ResetPasswordPage";

const user = { id: "u1", email: "person@example.com", role: "user" as const };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createDeferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type Page = "login" | "register" | "forgot" | "reset";

const pages = {
  login: <LoginPage />,
  register: <RegisterPage />,
  forgot: <ForgotPasswordPage />,
  reset: <ResetPasswordPage />,
} satisfies Record<Page, React.ReactNode>;

function renderPage(
  page: Page,
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  initialEntry: string | { pathname: string; state?: unknown } = `/${page}`,
) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  return render(
    <MemoryRouter
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
      initialEntries={[initialEntry]}
    >
      <AuthProvider>
        <Routes>
          <Route path="/login" element={pages.login} />
          <Route path="/register" element={pages.register} />
          <Route path="/forgot" element={pages.forgot} />
          <Route path="/reset" element={pages.reset} />
          <Route path="/projects" element={<h1>Projects</h1>} />
          <Route path="/projects/:id" element={<h1>Intended project</h1>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function anonymousFetch(
  mutation?: (path: string, init?: RequestInit) => Promise<Response>,
) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/auth/me") return jsonResponse({}, 401);
    if (path === "/api/auth/csrf") return jsonResponse({ csrf_token: "csrf-public" });
    if (mutation) return mutation(path, init);
    throw new Error(`Unexpected request ${path}`);
  };
}

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("validates login fields without sending a request", async () => {
  const mutation = vi.fn().mockResolvedValue(jsonResponse({ user, csrf_token: "csrf-login" }));
  renderPage("login", anonymousFetch(mutation));
  const submit = await screen.findByRole("button", { name: "Sign in" });

  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "not-an-email" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
  fireEvent.click(submit);

  expect(mutation).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid email address");
});

it("submits login once, disables pending controls, and honors the guarded destination", async () => {
  const deferred = createDeferredResponse();
  let loginInit: RequestInit | undefined;
  renderPage(
    "login",
    anonymousFetch(async (path, init) => {
      expect(path).toBe("/api/auth/login");
      loginInit = init;
      return deferred.promise;
    }),
    { pathname: "/login", state: { from: { pathname: "/projects/p1", search: "", hash: "" } } },
  );
  await screen.findByRole("button", { name: "Sign in" });

  expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "username");
  expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  expect(screen.getByRole("button", { name: "Signing in..." })).toBeDisabled();
  expect(screen.getByLabelText("Email")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Signing in..." }));
  await waitFor(() => expect(loginInit).toBeDefined());
  expect(JSON.parse(String(loginInit?.body))).toEqual({
    email: user.email,
    password: "password123",
  });

  await act(async () => {
    deferred.resolve(jsonResponse({ user, csrf_token: "csrf-login" }));
    await deferred.promise;
  });
  expect(await screen.findByRole("heading", { name: "Intended project" })).toBeInTheDocument();
});

it("renders a generic login error without reflecting response secrets", async () => {
  const secret = "password123 leaked by upstream";
  renderPage("login", anonymousFetch(async () => jsonResponse({ detail: secret }, 500)));
  await screen.findByRole("button", { name: "Sign in" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });

  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("temporarily unavailable");
  expect(document.body).not.toHaveTextContent(secret);
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
});

it("always shows neutral verification-copy after a valid send-code attempt", async () => {
  const secret = "person@example.com does not exist";
  const mutation = vi.fn().mockResolvedValue(jsonResponse({ detail: secret }, 429));
  renderPage("register", anonymousFetch(mutation));
  await screen.findByRole("button", { name: "Send code" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: user.email } });

  fireEvent.click(screen.getByRole("button", { name: "Send code" }));

  expect(await screen.findByRole("status")).toHaveTextContent(
    "If this address can receive a code, it will arrive shortly.",
  );
  expect(document.body).not.toHaveTextContent(secret);
  expect(mutation).toHaveBeenCalledTimes(1);
});

it("keeps the verification action disabled while it is pending", async () => {
  const deferred = createDeferredResponse();
  renderPage("register", anonymousFetch(async () => deferred.promise));
  await screen.findByRole("button", { name: "Send code" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: user.email } });

  fireEvent.click(screen.getByRole("button", { name: "Send code" }));

  expect(screen.getByRole("button", { name: "Sending code..." })).toBeDisabled();
  await act(async () => {
    deferred.resolve(jsonResponse({ detail: "sent" }, 202));
    await deferred.promise;
  });
});

it("validates a six-digit registration code and matching password", async () => {
  const mutation = vi.fn().mockResolvedValue(jsonResponse({ user, csrf_token: "csrf-register" }, 201));
  renderPage("register", anonymousFetch(mutation));
  await screen.findByRole("button", { name: "Create account" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "12345x" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "password456" } });

  fireEvent.click(screen.getByRole("button", { name: "Create account" }));

  expect(mutation).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("Enter the six-digit code");
  expect(screen.getByRole("alert")).toHaveTextContent("Passwords must match");
  expect(screen.getByLabelText("Verification code")).toHaveAttribute("inputmode", "numeric");
  expect(screen.getByLabelText("Verification code")).toHaveAttribute("autocomplete", "one-time-code");
  expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "new-password");
});

it("submits registration with only email, password, and code", async () => {
  let registerBody: unknown;
  renderPage("register", anonymousFetch(async (path, init) => {
    expect(path).toBe("/api/auth/register");
    registerBody = JSON.parse(String(init?.body));
    return jsonResponse({ user, csrf_token: "csrf-register" }, 201);
  }));
  await screen.findByRole("button", { name: "Create account" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "123456" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "password123" } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "password123" } });

  fireEvent.click(screen.getByRole("button", { name: "Create account" }));

  expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
  expect(registerBody).toEqual({ email: user.email, password: "password123", code: "123456" });
  expect(registerBody).not.toHaveProperty("role");
});

it("validates reset-request email without calling the API", async () => {
  const mutation = vi.fn();
  renderPage("forgot", anonymousFetch(mutation));
  await screen.findByRole("button", { name: "Send reset code" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "invalid" } });

  fireEvent.click(screen.getByRole("button", { name: "Send reset code" }));

  expect(mutation).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid email address");
});

it.each([202, 500])("shows the same neutral reset-request result for status %s", async (status) => {
  const secret = "account lookup result";
  renderPage("forgot", anonymousFetch(async () => jsonResponse({ detail: secret }, status)));
  await screen.findByRole("button", { name: "Send reset code" });
  expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "username");
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: user.email } });

  fireEvent.click(screen.getByRole("button", { name: "Send reset code" }));

  expect(await screen.findByRole("status")).toHaveTextContent(
    "If the account can be reset, a code will arrive shortly.",
  );
  expect(document.body).not.toHaveTextContent(secret);
});

it("validates reset confirmation fields without submitting", async () => {
  const mutation = vi.fn();
  renderPage("reset", anonymousFetch(mutation));
  await screen.findByRole("button", { name: "Reset password" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("Reset code"), { target: { value: "123" } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password" } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "different-password" } });

  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

  expect(mutation).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("Enter the six-digit code");
  expect(screen.getByRole("alert")).toHaveTextContent("Passwords must match");
  expect(screen.getByLabelText("New password")).toHaveAttribute("autocomplete", "new-password");
});

it("submits reset confirmation once and reports completion", async () => {
  const deferred = createDeferredResponse();
  let resetBody: unknown;
  renderPage("reset", anonymousFetch(async (path, init) => {
    expect(path).toBe("/api/auth/password-reset/confirm");
    resetBody = JSON.parse(String(init?.body));
    return deferred.promise;
  }));
  await screen.findByRole("button", { name: "Reset password" });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("Reset code"), { target: { value: "123456" } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password" } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-password" } });

  fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

  expect(screen.getByRole("button", { name: "Resetting password..." })).toBeDisabled();
  expect(resetBody).toEqual({
    email: user.email,
    code: "123456",
    new_password: "new-password",
  });
  await act(async () => {
    deferred.resolve(new Response(null, { status: 204 }));
    await deferred.promise;
  });
  expect(await screen.findByRole("status")).toHaveTextContent("Password reset complete");
});

it("redirects an already authenticated visitor away from public auth pages", async () => {
  renderPage("login", async (input) => String(input) === "/api/auth/me"
    ? jsonResponse({ user })
    : jsonResponse({ csrf_token: "csrf-authenticated" }));

  expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
});
