import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
// @ts-expect-error The Vitest runtime provides Node built-ins, but the browser tsconfig omits them.
import { readFileSync } from "node:fs";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

afterEach(() => {
  cleanup();
});

describe("AppShell", () => {
  it("renders supplied shell slots and places project navigation in the topbar", () => {
    render(
      <MemoryRouter
        future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
        initialEntries={["/projects/p1/storyboard"]}
      >
        <AppShell
          project={{ id: "p1", title: "Rain Alley" }}
          breadcrumb={<><a href="/projects">项目列表</a><span>Rain Alley</span></>}
          projectNavigation={<a href="/projects/p1/storyboard">分镜编辑</a>}
          accountAction={<button type="button">账户动作</button>}
          billingAction={<a href="/wallet">钱包 1,234</a>}
        >
          <div>页面内容</div>
        </AppShell>
      </MemoryRouter>,
    );

    expect(screen.getByRole("navigation", { name: "项目位置" })).toHaveTextContent(
      "项目列表Rain Alley",
    );
    expect(screen.getByRole("link", { name: "分镜编辑" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "账户动作" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "钱包 1,234" })).toBeInTheDocument();
  });

  it("runs the navigation guard for the brand link", () => {
    const onBeforeNavigate = vi.fn(() => false);
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AppShell
          project={null}
          breadcrumb={null}
          accountAction={null}
          billingAction={null}
          onBeforeNavigate={onBeforeNavigate}
        >
          <div>项目列表</div>
        </AppShell>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "mise studio" }));

    expect(onBeforeNavigate).toHaveBeenCalledTimes(1);
  });

  it("does not import domain hooks or provider configuration controls", () => {
    const source = readFileSync("src/components/shell/AppShell.tsx", "utf8");
    const providerConfigPattern = new RegExp([
      ["text", "key"].join("_"),
      ["image", "key"].join("_"),
      ["video", "key"].join("_"),
      ["base", "url"].join("_"),
      "Provider" + "Drawer",
      "Key" + "Gate",
    ].join("|"));

    expect(source).not.toMatch(/useAuth|useBilling|AuthProvider|BillingProvider/);
    expect(source).not.toMatch(/walletAvailableUnits|accountEmail|onLogout/);
    expect(source).not.toMatch(providerConfigPattern);
  });

  it("opens an accessible narrow-screen menu without losing supplied slots", () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AppShell
          project={null}
          breadcrumb={null}
          accountAction={<button type="button">账户动作</button>}
          billingAction={<a href="/wallet">额度 1,234</a>}
        >
          <div>项目列表</div>
        </AppShell>
      </MemoryRouter>,
    );

    const menuButton = screen.getByRole("button", { name: "打开导航菜单" });
    expect(menuButton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menuButton);

    const menu = screen.getByRole("region", { name: "移动端导航菜单" });
    expect(screen.getByRole("button", { name: "关闭导航菜单" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(menu).getByRole("link", { name: "额度 1,234" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "账户动作" })).toBeInTheDocument();
  });
});
