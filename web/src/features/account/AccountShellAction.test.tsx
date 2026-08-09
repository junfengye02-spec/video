import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountShellAction } from "./AccountShellAction";

const authMocks = vi.hoisted(() => ({
  value: {
    user: { id: "user-1", email: "user@example.com", role: "user" } as null | {
      id: string;
      email: string;
      role: "user" | "admin";
    },
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    sendVerification: vi.fn(),
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
  },
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => authMocks.value,
}));

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.value = {
    ...authMocks.value,
    user: { id: "user-1", email: "user@example.com", role: "user" },
    logout: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
});

describe("AccountShellAction", () => {
  it("shows the signed-in account and logs out", () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AccountShellAction />
      </MemoryRouter>,
    );

    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "账单管理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "模型管理" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(authMocks.value.logout).toHaveBeenCalledTimes(1);
  });

  it("exposes administration links only for admins and honors the navigation guard", () => {
    const onBeforeNavigate = vi.fn(() => false);
    authMocks.value = {
      ...authMocks.value,
      user: { id: "admin-1", email: "admin@example.com", role: "admin" },
    };

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AccountShellAction onBeforeNavigate={onBeforeNavigate} />
      </MemoryRouter>,
    );

    const adminLink = screen.getByRole("link", { name: "账单管理" });
    expect(adminLink).toHaveAttribute("href", "/admin/billing");
    expect(screen.getByRole("link", { name: "模型管理" }))
      .toHaveAttribute("href", "/admin/video-models");
    fireEvent.click(adminLink);
    expect(onBeforeNavigate).toHaveBeenCalledTimes(1);
  });
});
