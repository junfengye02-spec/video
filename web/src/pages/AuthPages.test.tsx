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
  const rendered = renderPage("login", anonymousFetch(mutation));
  const submit = await screen.findByRole("button", { name: "登录" });
  const feedbackSlot = rendered.container.querySelector(".auth-feedback-slot");
  expect(feedbackSlot).toHaveAttribute("data-empty", "true");

  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "not-an-email" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "short" } });
  fireEvent.click(submit);

  expect(mutation).not.toHaveBeenCalled();
  expect(screen.getByLabelText("邮箱")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText("密码")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByLabelText("邮箱")).toHaveAttribute("aria-describedby", "login-feedback");
  expect(screen.getByLabelText("密码")).toHaveAttribute("aria-describedby", "login-feedback");
  expect(document.getElementById("login-feedback")).toContainElement(screen.getByRole("alert"));
  expect(screen.getByLabelText("邮箱")).toHaveFocus();
  expect(screen.getByRole("alert")).toHaveTextContent("请输入有效的邮箱地址");
  expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  expect(rendered.container.querySelector(".auth-feedback-slot")).toBe(feedbackSlot);
});

it("gives the password visibility control an accessible toggled state", async () => {
  renderPage("login", anonymousFetch());
  await screen.findByRole("button", { name: "登录" });
  const password = screen.getByLabelText<HTMLInputElement>("密码");
  const showPassword = screen.getByRole("button", { name: "显示密码" });

  expect(password).toHaveAttribute("type", "password");
  expect(showPassword).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(showPassword);

  expect(password).toHaveAttribute("type", "text");
  expect(screen.getByRole("button", { name: "隐藏密码" })).toHaveAttribute("aria-pressed", "true");
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
  await screen.findByRole("button", { name: "登录" });

  expect(screen.getByLabelText("邮箱")).toHaveAttribute("autocomplete", "username");
  expect(screen.getByLabelText("密码")).toHaveAttribute("autocomplete", "current-password");
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password123" } });
  fireEvent.click(screen.getByRole("button", { name: "登录" }));

  expect(screen.getByRole("button", { name: "正在登录..." })).toBeDisabled();
  expect(screen.getByLabelText("邮箱")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "正在登录..." }));
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
  await screen.findByRole("button", { name: "登录" });
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password123" } });

  fireEvent.click(screen.getByRole("button", { name: "登录" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("服务暂时不可用");
  expect(document.body).not.toHaveTextContent(secret);
  expect(screen.getByRole("button", { name: "登录" })).toBeEnabled();
});

it("shows a safe error when verification email delivery fails", async () => {
  const secret = "person@example.com does not exist";
  const mutation = vi.fn().mockResolvedValue(jsonResponse({ detail: secret }, 429));
  renderPage("register", anonymousFetch(mutation));
  await screen.findByRole("button", { name: "发送验证码" });
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: user.email } });

  fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("尝试次数过多，请稍后再试");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(secret);
  expect(mutation).toHaveBeenCalledTimes(1);
});

it.each([
  [422, "email_domain_unavailable", "该邮箱域名无法接收邮件，请检查邮箱地址。"],
  [503, "email_delivery_unavailable", "邮件服务尚未配置，请联系管理员。"],
  [503, "email_delivery_failed", "验证码邮件发送失败，请稍后再试。"],
] as const)("shows a specific safe verification error for %s/%s", async (status, code, message) => {
  renderPage("register", anonymousFetch(async () => jsonResponse({
    detail: { code, message: "upstream detail must stay hidden" },
  }, status)));
  await screen.findByRole("button", { name: "发送验证码" });
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: user.email } });

  fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(message);
  expect(document.body).not.toHaveTextContent("upstream detail must stay hidden");
});

it("keeps the verification action disabled while it is pending", async () => {
  const deferred = createDeferredResponse();
  renderPage("register", anonymousFetch(async () => deferred.promise));
  await screen.findByRole("button", { name: "发送验证码" });
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: user.email } });

  fireEvent.click(screen.getByRole("button", { name: "发送验证码" }));

  expect(screen.getByRole("button", { name: "正在发送..." })).toBeDisabled();
  await act(async () => {
    deferred.resolve(jsonResponse({ detail: "sent" }, 202));
    await deferred.promise;
  });
  expect(await screen.findByRole("status")).toHaveTextContent(
    "验证码已发送，请检查收件箱和垃圾邮件。",
  );
});

it("validates a six-digit registration code and matching password", async () => {
  const mutation = vi.fn().mockResolvedValue(jsonResponse({ user, csrf_token: "csrf-register" }, 201));
  renderPage("register", anonymousFetch(mutation));
  await screen.findByRole("button", { name: "创建账户" });
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "12345x" } });
  fireEvent.change(screen.getByLabelText("设置密码"), { target: { value: "password123" } });
  fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "password456" } });

  fireEvent.click(screen.getByRole("button", { name: "创建账户" }));

  expect(mutation).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("请输入 6 位数字验证码");
  expect(screen.getByRole("alert")).toHaveTextContent("两次输入的密码不一致");
  expect(screen.getByLabelText("验证码")).toHaveAttribute("aria-describedby", "register-feedback");
  expect(screen.getByLabelText("设置密码")).toHaveAttribute("aria-describedby", "register-feedback");
  expect(screen.getByLabelText("验证码")).toHaveAttribute("inputmode", "numeric");
  expect(screen.getByLabelText("验证码")).toHaveAttribute("autocomplete", "one-time-code");
  expect(screen.getByLabelText("设置密码")).toHaveAttribute("autocomplete", "new-password");
});

it("submits registration with only email, password, and code", async () => {
  let registerBody: unknown;
  renderPage("register", anonymousFetch(async (path, init) => {
    expect(path).toBe("/api/auth/register");
    registerBody = JSON.parse(String(init?.body));
    return jsonResponse({ user, csrf_token: "csrf-register" }, 201);
  }));
  await screen.findByRole("button", { name: "创建账户" });
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
  fireEvent.change(screen.getByLabelText("设置密码"), { target: { value: "password123" } });
  fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "password123" } });

  fireEvent.click(screen.getByRole("button", { name: "创建账户" }));

  expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
  expect(registerBody).toEqual({ email: user.email, password: "password123", code: "123456" });
  expect(registerBody).not.toHaveProperty("role");
});

it("disables every registration control during account creation", async () => {
  const deferred = createDeferredResponse();
  renderPage("register", anonymousFetch(async () => deferred.promise));
  await screen.findByRole("button", { name: "创建账户" });
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
  fireEvent.change(screen.getByLabelText("设置密码"), { target: { value: "password123" } });
  fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "password123" } });

  fireEvent.click(screen.getByRole("button", { name: "创建账户" }));

  expect(screen.getByRole("button", { name: "正在创建..." })).toBeDisabled();
  expect(screen.getByRole("button", { name: "正在创建..." })).toHaveAttribute("aria-busy", "true");
  expect(screen.getByLabelText("邮箱")).toBeDisabled();
  expect(screen.getByRole("button", { name: "发送验证码" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "显示设置密码" })).toBeDisabled();

  await act(async () => {
    deferred.resolve(jsonResponse({ user, csrf_token: "csrf-register" }, 201));
    await deferred.promise;
  });
});

it("validates reset-request email without calling the API", async () => {
  const mutation = vi.fn();
  renderPage("forgot", anonymousFetch(mutation));
  await screen.findByRole("button", { name: "发送重置验证码" });
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "invalid" } });

  fireEvent.click(screen.getByRole("button", { name: "发送重置验证码" }));

  expect(mutation).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("请输入有效的邮箱地址");
  expect(screen.getByLabelText("邮箱")).toHaveAttribute("aria-describedby", "recovery-feedback");
});

it.each([202, 500])("shows the same neutral reset-request result for status %s", async (status) => {
  const secret = "account lookup result";
  renderPage("forgot", anonymousFetch(async () => jsonResponse({ detail: secret }, status)));
  await screen.findByRole("button", { name: "发送重置验证码" });
  expect(screen.getByLabelText("邮箱")).toHaveAttribute("autocomplete", "email");
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: user.email } });

  fireEvent.click(screen.getByRole("button", { name: "发送重置验证码" }));

  expect(await screen.findByRole("status")).toHaveTextContent(
    "如果该账户可以重置，你会很快收到验证码。",
  );
  expect(document.body).not.toHaveTextContent(secret);
});

it("disables account-recovery input while the request is pending", async () => {
  const deferred = createDeferredResponse();
  renderPage("forgot", anonymousFetch(async () => deferred.promise));
  await screen.findByRole("button", { name: "发送重置验证码" });
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: user.email } });

  fireEvent.click(screen.getByRole("button", { name: "发送重置验证码" }));

  expect(screen.getByRole("button", { name: "正在发送..." })).toBeDisabled();
  expect(screen.getByLabelText("邮箱")).toBeDisabled();

  await act(async () => {
    deferred.resolve(jsonResponse({ detail: "sent" }, 202));
    await deferred.promise;
  });
  expect(await screen.findByRole("status")).toHaveAttribute("aria-live", "polite");
});

it("validates reset confirmation fields without submitting", async () => {
  const mutation = vi.fn();
  renderPage("reset", anonymousFetch(mutation));
  await screen.findByRole("button", { name: "确认重置密码" });
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123" } });
  fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new-password" } });
  fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "different-password" } });

  fireEvent.click(screen.getByRole("button", { name: "确认重置密码" }));

  expect(mutation).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("请输入 6 位数字验证码");
  expect(screen.getByRole("alert")).toHaveTextContent("两次输入的密码不一致");
  expect(screen.getByLabelText("验证码")).toHaveAttribute("aria-describedby", "reset-feedback");
  expect(screen.getByLabelText("新密码")).toHaveAttribute("autocomplete", "new-password");
});

it("submits reset confirmation once and reports completion", async () => {
  const deferred = createDeferredResponse();
  let resetBody: unknown;
  renderPage("reset", anonymousFetch(async (path, init) => {
    expect(path).toBe("/api/auth/password-reset/confirm");
    resetBody = JSON.parse(String(init?.body));
    return deferred.promise;
  }));
  await screen.findByRole("button", { name: "确认重置密码" });
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
  fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new-password" } });
  fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "new-password" } });

  fireEvent.click(screen.getByRole("button", { name: "确认重置密码" }));

  expect(screen.getByRole("button", { name: "正在重置..." })).toBeDisabled();
  expect(resetBody).toEqual({
    email: user.email,
    code: "123456",
    new_password: "new-password",
  });
  await act(async () => {
    deferred.resolve(new Response(null, { status: 204 }));
    await deferred.promise;
  });
  expect(await screen.findByRole("status")).toHaveTextContent("密码已重置");
  expect(screen.getByRole("button", { name: "密码已重置" })).toBeDisabled();
});

it("shows a safe reset service error and restores the form", async () => {
  const secret = "internal reset gateway failure";
  renderPage("reset", anonymousFetch(async () => jsonResponse({ detail: secret }, 500)));
  await screen.findByRole("button", { name: "确认重置密码" });
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: user.email } });
  fireEvent.change(screen.getByLabelText("验证码"), { target: { value: "123456" } });
  fireEvent.change(screen.getByLabelText("新密码"), { target: { value: "new-password" } });
  fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: "new-password" } });

  fireEvent.click(screen.getByRole("button", { name: "确认重置密码" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("服务暂时不可用");
  expect(document.body).not.toHaveTextContent(secret);
  expect(screen.getByRole("button", { name: "确认重置密码" })).toBeEnabled();
});

it("redirects an already authenticated visitor away from public auth pages", async () => {
  renderPage("login", async (input) => String(input) === "/api/auth/me"
    ? jsonResponse({ user })
    : jsonResponse({ csrf_token: "csrf-authenticated" }));

  expect(await screen.findByRole("heading", { name: "Projects" })).toBeInTheDocument();
});
