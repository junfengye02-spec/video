import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStrings } from "../i18n";
import { createProjectResponse } from "../test/fixtures";
import { chooseSelectMenuOption } from "../test/selectMenu";
import { buildInitialIdea } from "../components/projects/ProjectComposer";
import { NewProjectPage, type NewProjectPageProps } from "./NewProjectPage";

const startAction = "\u5f00\u59cb\u804a\u7075\u611f";
const startingAction = "\u6b63\u5728\u51c6\u5907\u521b\u4f5c\u7a7a\u95f4...";
const ideaLabel = "\u4f60\u60f3\u505a\u4e00\u652f\u4ec0\u4e48\u6837\u7684\u89c6\u9891\uff1f";

function renderPage(props: Partial<NewProjectPageProps> = {}) {
  return render(
    <MemoryRouter>
      <NewProjectPage
        onCreateDraft={vi.fn()}
        onStarted={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("NewProjectPage", () => {
  it("navigates back to projects through React Router", async () => {
    render(
      <MemoryRouter initialEntries={["/projects/new"]}>
        <Routes>
          <Route path="/projects/new" element={<NewProjectPage onCreateDraft={vi.fn()} onStarted={vi.fn()} />} />
          <Route path="/projects" element={<h1>Projects destination</h1>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: getStrings("zh").newProjectPage.backToProjects }));

    expect(await screen.findByRole("heading", { name: "Projects destination" })).toBeInTheDocument();
  });

  it("creates a draft from the first chat message before opening inspiration", async () => {
    const draft = createProjectResponse({ shotCount: 0 });
    const onCreateDraft = vi.fn().mockResolvedValue(draft);
    const onStarted = vi.fn();
    const strings = getStrings("zh").newProjectPage;
    renderPage({ onCreateDraft, onStarted });

    fireEvent.click(screen.getByRole("button", { name: "创作设置" }));
    fireEvent.change(screen.getByLabelText(strings.projectTitleLabel), {
      target: { value: "\u660e\u65e5\u6765\u4fe1" },
    });
    chooseSelectMenuOption(strings.projectTypeLabel, strings.miniSeries);
    fireEvent.change(screen.getByLabelText(ideaLabel), {
      target: { value: "  \u5feb\u9012\u5458\u6536\u5230\u4e00\u5c01\u6765\u81ea\u660e\u5929\u7684\u4fe1  " },
    });
    fireEvent.change(screen.getByLabelText("\u7075\u611f\u6587\u672c\u6a21\u578b"), {
      target: { value: "text-model-v2" },
    });
    fireEvent.click(screen.getByRole("button", { name: startAction }));

    const initialMessage = buildInitialIdea(
      "\u5feb\u9012\u5458\u6536\u5230\u4e00\u5c01\u6765\u81ea\u660e\u5929\u7684\u4fe1",
      "story",
      "16:9",
    );
    await waitFor(() => expect(onCreateDraft).toHaveBeenCalledWith({
      title: "\u660e\u65e5\u6765\u4fe1",
      title_source: "user",
      project_type: "mini_series",
      prompt: initialMessage,
    }));
    expect(onStarted).toHaveBeenCalledWith(
      draft.project.id,
      initialMessage,
      "text-model-v2",
    );
  });

  it("marks the fallback title so inspiration may replace it", async () => {
    const draft = createProjectResponse({ shotCount: 0 });
    const onCreateDraft = vi.fn().mockResolvedValue(draft);
    renderPage({ onCreateDraft });
    fireEvent.change(screen.getByLabelText(ideaLabel), {
      target: { value: "\u8ffd\u9010\u5f02\u5e38\u5929\u5149\u7684\u65c5\u884c\u8005" },
    });
    fireEvent.click(screen.getByRole("button", { name: startAction }));

    await waitFor(() => expect(onCreateDraft).toHaveBeenCalledWith(expect.objectContaining({
      title: getStrings("zh").newProjectPage.projectTitlePlaceholder,
      title_source: "placeholder",
    })));
  });

  it("keeps duration in the creative brief instead of limiting it to presets", () => {
    renderPage();

    expect(screen.queryByRole("combobox", { name: "\u65f6\u957f" })).not.toBeInTheDocument();
    expect(buildInitialIdea("\u751f\u6210 20 \u79d2\u821e\u8e48\u77ed\u7247", "concept", "9:16")).toContain(
      "\u751f\u6210 20 \u79d2\u821e\u8e48\u77ed\u7247",
    );
  });

  it("requires a first message", async () => {
    const onCreateDraft = vi.fn();
    renderPage({ onCreateDraft });

    fireEvent.click(screen.getByRole("button", { name: startAction }));

    expect(onCreateDraft).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      getStrings("zh").errors.createStoryboardRequiresPrompt,
    );
  });

  it("shows progress and recovers when draft creation fails", async () => {
    let rejectCreate: (reason: unknown) => void = () => undefined;
    const onCreateDraft = vi.fn().mockReturnValue(new Promise((_, reject) => {
      rejectCreate = reject;
    }));
    renderPage({ onCreateDraft });
    fireEvent.change(screen.getByLabelText(ideaLabel), {
      target: { value: "\u96e8\u591c\u60ac\u7591\u6545\u4e8b" },
    });

    fireEvent.click(screen.getByRole("button", { name: startAction }));
    expect(screen.getByRole("button", { name: startingAction })).toBeDisabled();
    rejectCreate(new Error("Draft failed"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Draft failed");
    expect(screen.getByRole("button", { name: startAction })).toBeEnabled();
  });

  it("hands unauthorized failures to session recovery", async () => {
    const onSessionExpired = vi.fn();
    renderPage({
      onCreateDraft: vi.fn().mockRejectedValue({ code: "unauthorized", status: 401 }),
      onSessionExpired,
    });
    fireEvent.change(screen.getByLabelText(ideaLabel), {
      target: { value: "\u9700\u8981\u767b\u5f55\u7684\u6545\u4e8b" },
    });
    fireEvent.click(screen.getByRole("button", { name: startAction }));

    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
  });
});
