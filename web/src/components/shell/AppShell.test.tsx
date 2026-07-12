import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

afterEach(() => {
  cleanup();
});

describe("AppShell", () => {
  it("runs the navigation guard for the brand and every project navigation link", () => {
    const onBeforeNavigate = vi.fn(() => false);
    const props = {
      children: <div />,
      project: { id: "p1", title: "雨夜来信", mode: "short_drama" as const },
      onBeforeNavigate,
    } as ComponentProps<typeof AppShell>;
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AppShell {...props}>
          <div>页面内容</div>
        </AppShell>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "OpenMontage" }));
    fireEvent.click(screen.getByRole("link", { name: "分镜编辑" }));
    fireEvent.click(screen.getByRole("link", { name: "全局设定" }));
    fireEvent.click(screen.getByRole("link", { name: "资源库" }));
    fireEvent.click(screen.getByRole("link", { name: "制作与成片" }));

    expect(onBeforeNavigate).toHaveBeenCalledTimes(5);
  });

  it("navigates the wallet action and removes provider configuration controls", async () => {
    render(
      <MemoryRouter
        future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
        initialEntries={["/projects/p1/storyboard"]}
      >
        <Routes>
          <Route
            path="/projects/:projectId/storyboard"
            element={(
              <AppShell
                project={{ id: "p1", title: "雨夜来信", mode: "short_drama" }}
                accountEmail="user@example.com"
                walletAvailableUnits={1234}
              >
                <div>页面内容</div>
              </AppShell>
            )}
          />
          <Route path="/wallet" element={<h1>Wallet destination</h1>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "分镜编辑" })).toHaveAttribute(
      "href",
      "/projects/p1/storyboard",
    );
    expect(screen.queryByRole("button", { name: "接口配置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /credential/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: /钱包 1,234/ }));
    expect(await screen.findByRole("heading", { name: "Wallet destination" })).toBeInTheDocument();
  });

  it("shows account actions and only exposes billing administration to admins", () => {
    const onLogout = vi.fn();
    const { rerender } = render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AppShell
          project={null}
          accountEmail="user@example.com"
          onLogout={onLogout}
        >
          <div>项目列表</div>
        </AppShell>
      </MemoryRouter>,
    );

    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "账单管理" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "退出" }));
    expect(onLogout).toHaveBeenCalledTimes(1);

    rerender(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AppShell
          project={null}
          accountEmail="admin@example.com"
          isAdmin
        >
          <div>项目列表</div>
        </AppShell>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "账单管理" })).toHaveAttribute(
      "href",
      "/admin/billing",
    );
  });
});
