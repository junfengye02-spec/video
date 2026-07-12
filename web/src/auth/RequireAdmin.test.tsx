import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "./AuthProvider";
import type { AuthContextValue } from "./AuthProvider";
import { RequireAdmin } from "./RequireAdmin";

vi.mock("./AuthProvider", () => ({
  useAuth: vi.fn(),
}));

const useAuthMock = vi.mocked(useAuth);

function authValue(overrides: Partial<AuthContextValue>): AuthContextValue {
  return {
    user: null,
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    sendVerification: vi.fn(),
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  const from = (location.state as { from?: Location } | null)?.from;
  return <span>{from ? `${from.pathname}${from.search}${from.hash}` : "none"}</span>;
}

function renderGuard(path = "/admin/billing?tab=orders#latest") {
  return render(
    <MemoryRouter
      future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
      initialEntries={[path]}
    >
      <Routes>
        <Route element={<RequireAdmin />}>
          <Route path="/admin/billing" element={<div>admin billing</div>} />
        </Route>
        <Route path="/login" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RequireAdmin", () => {
  it("keeps admin content hidden while auth is loading", () => {
    useAuthMock.mockReturnValue(authValue({ loading: true }));

    renderGuard();

    expect(screen.getByRole("status")).toHaveTextContent("Checking your session");
    expect(screen.queryByText("admin billing")).not.toBeInTheDocument();
  });

  it("redirects anonymous users to login and preserves the intended URL", () => {
    useAuthMock.mockReturnValue(authValue({ user: null }));

    renderGuard();

    expect(screen.getByText("/admin/billing?tab=orders#latest")).toBeInTheDocument();
    expect(screen.queryByText("admin billing")).not.toBeInTheDocument();
  });

  it("renders a forbidden surface for authenticated non-admin users", () => {
    useAuthMock.mockReturnValue(authValue({
      user: { id: "user-1", email: "user@example.com", role: "user" },
    }));

    renderGuard();

    expect(screen.getByRole("heading", { name: "Not authorized" })).toBeInTheDocument();
    expect(screen.queryByText("admin billing")).not.toBeInTheDocument();
  });

  it("renders children for administrators", () => {
    useAuthMock.mockReturnValue(authValue({
      user: { id: "admin-1", email: "admin@example.com", role: "admin" },
    }));

    renderGuard();

    expect(screen.getByText("admin billing")).toBeInTheDocument();
  });
});
