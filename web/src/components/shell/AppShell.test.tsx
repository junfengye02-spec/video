import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
      providerPanel: <div>接口表单</div>,
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

  it("shows project navigation and keeps recharge as a development notice", () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AppShell
          project={{ id: "p1", title: "雨夜来信", mode: "short_drama" }}
          providerPanel={<div>接口表单</div>}
        >
          <div>页面内容</div>
        </AppShell>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "分镜编辑" })).toHaveAttribute(
      "href",
      "/projects/p1/storyboard",
    );
    expect(screen.queryByRole("link", { name: "钱包" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "充值" }));
    expect(screen.getByRole("status")).toHaveTextContent("功能开发中");
  });

  it("opens and closes the interface configuration drawer", () => {
    const onOpenChange = vi.fn();
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <AppShell
          project={null}
          providerPanel={<div>接口表单</div>}
          providerOpen={false}
          onProviderOpenChange={onOpenChange}
        >
          <div>项目列表</div>
        </AppShell>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "接口配置" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
