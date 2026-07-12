import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStrings } from "../i18n";
import { createProjectResponse } from "../test/fixtures";
import { NewProjectPage, type NewProjectPageProps } from "./NewProjectPage";

function renderPage(props: NewProjectPageProps) {
  return render(
    <MemoryRouter>
      <NewProjectPage {...props} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("NewProjectPage", () => {
  it("navigates back to projects through the React Router session", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/new"]}>
        <Routes>
          <Route
            path="/projects/new"
            element={(
              <NewProjectPage
                onCreate={vi.fn()}
                onCreated={vi.fn()}
              />
            )}
          />
          <Route path="/projects" element={<h1>Projects destination</h1>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", {
      name: getStrings("zh").newProjectPage.backToProjects,
    }));

    expect(await screen.findByRole("heading", { name: "Projects destination" })).toBeInTheDocument();
  });

  it("submits title, project type and master prompt without a shot count", async () => {
    const onCreate = vi.fn().mockResolvedValue(createProjectResponse({ shotCount: 2 }));
    const onCreated = vi.fn();
    renderPage({ onCreate, onCreated });

    fireEvent.change(screen.getByLabelText("项目标题"), { target: { value: "雨夜来信" } });
    fireEvent.change(screen.getByLabelText("故事与画面要求"), { target: { value: "一封信改变两个人的命运" } });
    fireEvent.click(screen.getByRole("button", { name: "AI 规划分镜" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0]).toEqual({
      title: "雨夜来信",
      prompt: "一封信改变两个人的命运",
      project_type: "single_video",
    });
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty("shot_count");
    expect(onCreated).toHaveBeenCalledWith("p1", 2);
  });

  it("uses a trimmed prompt and an untitled fallback", async () => {
    const onCreate = vi.fn().mockResolvedValue(createProjectResponse());
    renderPage({ onCreate, onCreated: vi.fn() });

    fireEvent.change(screen.getByLabelText("项目标题"), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText("故事与画面要求"), { target: { value: "  雨夜追踪  " } });
    fireEvent.change(screen.getByLabelText("项目类型"), { target: { value: "mini_series" } });
    fireEvent.click(screen.getByRole("button", { name: "AI 规划分镜" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      title: "未命名项目",
      prompt: "雨夜追踪",
      project_type: "mini_series",
    }));
  });

  it("does not expose provider configuration before AI creation", () => {
    renderPage({ onCreate: vi.fn(), onCreated: vi.fn() });

    expect(screen.getByRole("button", { name: "AI 规划分镜" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "打开接口配置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(document.querySelector('[name="shot_count"]')).not.toBeInTheDocument();
  });

  it("rejects an empty trimmed prompt with an accessible error", async () => {
    const onCreate = vi.fn();
    renderPage({ onCreate, onCreated: vi.fn() });
    fireEvent.change(screen.getByLabelText("故事与画面要求"), { target: { value: "   " } });

    fireEvent.click(screen.getByRole("button", { name: "AI 规划分镜" }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      getStrings("zh").errors.createStoryboardRequiresPrompt,
    );
  });

  it("shows wallet recovery details for payment-required creation", async () => {
    const strings = getStrings("zh").newProjectPage;
    const onCreate = vi.fn().mockRejectedValue({
      code: "payment_required",
      required_units: 1200,
      status: 402,
    });
    renderPage({
      onCreate,
      onCreated: vi.fn(),
      walletAvailableUnits: 800,
    });

    fireEvent.change(screen.getByLabelText(strings.promptLabel), {
      target: { value: "\u9700\u8981\u751f\u6210\u7684\u6545\u4e8b" },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.createAction }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("\u4f59\u989d\u4e0d\u8db3");
    expect(alert).toHaveTextContent("\u53ef\u7528\u4f59\u989d 800");
    expect(alert).toHaveTextContent("\u672c\u6b21\u6700\u591a\u9700\u8981 1,200");
    expect(screen.getByRole("link", { name: "\u524d\u5f80\u94b1\u5305" })).toHaveAttribute("href", "/wallet");
  });

  it("hands unauthorized creation failures to session recovery", async () => {
    const strings = getStrings("zh").newProjectPage;
    const onSessionExpired = vi.fn();
    const onCreate = vi.fn().mockRejectedValue({ code: "unauthorized", status: 401 });
    renderPage({ onCreate, onCreated: vi.fn(), onSessionExpired });

    fireEvent.change(screen.getByLabelText(strings.promptLabel), {
      target: { value: "\u9700\u8981\u767b\u5f55\u7684\u6545\u4e8b" },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.createAction }));

    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows creation progress and recovers from a rejected request", async () => {
    let rejectCreate: (reason: unknown) => void = () => undefined;
    const onCreate = vi.fn().mockReturnValue(new Promise((_, reject) => {
      rejectCreate = reject;
    }));
    renderPage({ onCreate, onCreated: vi.fn() });

    fireEvent.change(screen.getByLabelText("故事与画面要求"), {
      target: { value: "雨夜追踪" },
    });

    fireEvent.click(screen.getByRole("button", { name: "AI 规划分镜" }));
    expect(screen.getByRole("button", { name: "正在规划分镜..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在规划分镜..." })).toHaveClass("async-action");

    rejectCreate(new Error("AI 规划失败"));

    expect(await screen.findByRole("alert")).toHaveTextContent("AI 规划失败");
    expect(screen.getByRole("button", { name: "AI 规划分镜" })).toBeEnabled();
  });
});
