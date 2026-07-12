import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, HttpClient } from "./HttpClient";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestHeaders(): Headers {
  const calls = vi.mocked(fetch).mock.calls;
  const init = calls[calls.length - 1]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers);
}

describe("HttpClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("includes credentials and CSRF only for mutations", async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(jsonResponse({ id: "p1" })));
    const client = new HttpClient({ getCsrfToken: () => "csrf" });

    await client.json("/api/projects", { method: "POST", body: { title: "Rain" } });

    expect(fetch).toHaveBeenCalledWith("/api/projects", expect.objectContaining({
      credentials: "include",
      method: "POST",
      body: JSON.stringify({ title: "Rain" }),
    }));
    expect(requestHeaders().get("Content-Type")).toBe("application/json");
    expect(requestHeaders().get("X-CSRF-Token")).toBe("csrf");

    await client.json("/api/projects");
    expect(requestHeaders().has("X-CSRF-Token")).toBe(false);
  });

  it("publishes one unauthorized event for a 401", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ detail: "no" }, 401));
    const onUnauthorized = vi.fn();
    const client = new HttpClient({ getCsrfToken: () => "csrf", onUnauthorized });

    await expect(client.json("/api/projects")).rejects.toBeInstanceOf(ApiError);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("throws structured API errors without losing backend code fields", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({
      detail: "Balance too low",
      code: "insufficient_balance",
    }, 402));
    const client = new HttpClient();

    await expect(client.json("/api/render")).rejects.toMatchObject({
      code: "insufficient_balance",
      message: "Balance too low",
      status: 402,
    });
  });

  it("returns undefined for 204 responses", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await expect(new HttpClient().json("/api/auth/logout", { method: "POST" }))
      .resolves.toBeUndefined();
  });

  it("submits form data with credentials and mutation CSRF without forcing JSON content type", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));
    const form = new FormData();
    form.append("file", new File(["x"], "x.png", { type: "image/png" }));

    await new HttpClient({ getCsrfToken: () => "csrf" }).form("/api/upload", { body: form });

    expect(fetch).toHaveBeenCalledWith("/api/upload", expect.objectContaining({
      body: form,
      credentials: "include",
      method: "POST",
    }));
    expect(requestHeaders().has("Content-Type")).toBe(false);
    expect(requestHeaders().get("X-CSRF-Token")).toBe("csrf");
  });
});
