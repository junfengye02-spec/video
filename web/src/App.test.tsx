import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getStrings } from "./i18n";

const apiMocks = vi.hoisted(() => ({
  createShortDramaProject: vi.fn(),
  loadProject: vi.fn(),
  regenerateShot: vi.fn(),
  renderProject: vi.fn(),
  saveGatewayKey: vi.fn(),
  saveShot: vi.fn(),
  subscribeProjectEvents: vi.fn(),
}));

vi.mock("./api/client", () => apiMocks);

const sampleShot = {
  id: "shot-1",
  scene_id: "scene-1",
  index: 1,
  beat: "Hook",
  prompt: "Mara in red coat finds the envelope.",
  characters: ["char-1"],
  location: "rainy alley",
  props: ["envelope"],
  shot_intent: "Reveal the clue.",
  shot_language: { shot_size: "medium_close", camera_movement: "dolly_in" },
  status: "ready",
  consistency_score: 100,
  output_url: null,
  output_path: null,
  asset_ids: [],
  version: 1,
  history: [],
};

const sampleShot2 = {
  ...sampleShot,
  id: "shot-2",
  index: 2,
  beat: "Turn",
  prompt: "Mara spots her boss across the alley.",
};

const sampleProjectResponse = {
  project: { id: "p1", title: "Rain Alley", mode: "short_drama" },
  series_bible: {
    title: "Rain Alley",
    mode: "short_drama",
    style_lock: "rainy neon suspense",
    characters: [
      {
        id: "char-1",
        name: "Mara",
        role: "lead investigator",
        visual_lock: "red coat, short hair",
        voice: null,
        reference_images: [],
        locked: true,
      },
      {
        id: "char-2",
        name: "Jin",
        role: "boss",
        visual_lock: "dark trench coat",
        voice: null,
        reference_images: [],
        locked: true,
      },
    ],
  },
  storyboard: { shots: [sampleShot, sampleShot2] },
  consistency_report: { score: 100, issues: [] },
};

const strings = getStrings("en");
const originalNavigatorLanguage = navigator.language;

function setNavigatorLanguage(language: string) {
  Object.defineProperty(window.navigator, "language", {
    configurable: true,
    value: language,
  });
}

function enterKeys(
  videoKey = "video-key",
  labels = {
    text: "Text API Key",
    image: "Image API Key",
    video: "Video API Key",
  },
) {
  fireEvent.change(screen.getByLabelText(labels.text), { target: { value: "text-key" } });
  fireEvent.change(screen.getByLabelText(labels.image), { target: { value: "image-key" } });
  fireEvent.change(screen.getByLabelText(labels.video), { target: { value: videoKey } });
}

async function createStoryboard(actionName = "Create storyboard") {
  enterKeys();
  fireEvent.click(screen.getByRole("button", { name: actionName }));
  await waitFor(() => expect(screen.getByRole("button", { name: strings.shotEditor.saveAction })).toBeEnabled());
}

describe("App", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    setNavigatorLanguage("en-US");
    apiMocks.createShortDramaProject.mockResolvedValue(sampleProjectResponse);
    apiMocks.loadProject.mockResolvedValue(sampleProjectResponse);
    apiMocks.subscribeProjectEvents.mockReturnValue(vi.fn());
    apiMocks.saveShot.mockResolvedValue({
      job_id: "j-save",
      event: {
        id: "e-save",
        job_id: "j-save",
        project_id: "p1",
        stage: "save",
        status: "complete",
        message: "Shot saved",
        created_at: "now",
      },
      shot: { ...sampleShot, prompt: "Lin pauses under the neon sign.", version: 2 },
      storyboard: { shots: [{ ...sampleShot, prompt: "Lin pauses under the neon sign.", version: 2 }] },
      consistency_report: { score: 100, issues: [] },
    });
  });

  afterEach(() => {
    setNavigatorLanguage(originalNavigatorLanguage);
  });

  it("renders the key gate and workbench shell", () => {
    render(<App />);
    expect(screen.getByText("OpenMontage Short Drama Workbench")).toBeInTheDocument();
    expect(screen.getByLabelText("Text API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Image API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Video API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Text Model")).toHaveValue("gpt-5.5");
    expect(screen.getByLabelText("Image Model")).toHaveValue("gpt-image-2");
    expect(screen.getByLabelText("Video Model")).toHaveValue("omni_flash-10s");
    expect(screen.getByRole("button", { name: "Render final video" })).toBeDisabled();
  });

  it("localizes key gate and storyboard creation controls for zh-CN browser locales", () => {
    setNavigatorLanguage("zh-CN");
    const zh = getStrings("zh");

    render(<App />);

    expect(screen.getByLabelText(zh.keyGate.textKeyLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.keyGate.imageKeyLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.keyGate.videoKeyLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.keyGate.textModelLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.keyGate.imageModelLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.keyGate.videoModelLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.keyGate.baseUrlLabel)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: zh.chatPanel.title })).toBeInTheDocument();
    expect(screen.getByLabelText(zh.chatPanel.projectTitleLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.chatPanel.promptLabel)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: zh.keyGate.useKeysAction })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: zh.chatPanel.createStoryboardAction })).toBeInTheDocument();
    expect(screen.getByText(zh.keyGate.keysNotSet)).toBeInTheDocument();
  });

  it("saves shot metadata without provider fields", async () => {
    render(<App />);
    await createStoryboard();
    fireEvent.change(screen.getByLabelText(strings.shotEditor.promptLabel), {
      target: { value: "Lin pauses under the neon sign." },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.saveAction }));

    await waitFor(() => expect(apiMocks.saveShot).toHaveBeenCalled());
    expect(apiMocks.saveShot).toHaveBeenCalledWith(
      "p1",
      sampleShot.id,
      expect.objectContaining({ prompt: "Lin pauses under the neon sign." }),
    );
    expect(apiMocks.saveShot.mock.calls[0]?.[2]).not.toHaveProperty("video_key");
    expect(apiMocks.saveShot.mock.calls[0]?.[2]).not.toHaveProperty("base_url");
    expect(apiMocks.saveShot.mock.calls[0]?.[2]).not.toHaveProperty("video_model");
    expect(apiMocks.regenerateShot).not.toHaveBeenCalled();
  });

  it("edits shot language and character bindings with structured controls", async () => {
    render(<App />);
    await createStoryboard();

    expect(screen.getByLabelText("Shot size")).toBeInTheDocument();
    expect(screen.getByLabelText("Camera movement")).toBeInTheDocument();
    expect(screen.getByLabelText("Shot intent")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Mara/i })).toBeChecked();

    fireEvent.change(screen.getByLabelText("Shot size"), { target: { value: "close_up" } });
    fireEvent.change(screen.getByLabelText("Camera movement"), { target: { value: "dolly_in" } });
    fireEvent.change(screen.getByLabelText("Shot intent"), { target: { value: "Push into Mara's realization." } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Jin/i }));

    fireEvent.click(screen.getByRole("button", { name: "Save shot" }));

    await waitFor(() => expect(apiMocks.saveShot).toHaveBeenCalled());
    expect(apiMocks.saveShot).toHaveBeenCalledWith(
      "p1",
      "shot-1",
      expect.objectContaining({
        characters: ["char-1", "char-2"],
        shot_intent: "Push into Mara's realization.",
        shot_language: expect.objectContaining({
          shot_size: "close_up",
          camera_movement: "dolly_in",
        }),
      }),
    );
  });

  it("requires a video key before regenerating a shot", async () => {
    render(<App />);
    enterKeys();
    fireEvent.click(screen.getByRole("button", { name: "Create storyboard" }));

    await screen.findByRole("button", { name: "Regenerate shot 1" });
    fireEvent.change(screen.getByLabelText("Video API Key"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate shot 1" }));

    expect(await screen.findByText(strings.errors.missingVideoKeyForRegenerate)).toBeInTheDocument();
    expect(apiMocks.regenerateShot).not.toHaveBeenCalled();
  });

  it("renders the regenerate-key error in Chinese for zh-CN browser locales", async () => {
    setNavigatorLanguage("zh-CN");
    const zh = getStrings("zh");

    render(<App />);
    enterKeys("video-key", {
      text: zh.keyGate.textKeyLabel,
      image: zh.keyGate.imageKeyLabel,
      video: zh.keyGate.videoKeyLabel,
    });
    fireEvent.click(screen.getByRole("button", { name: zh.chatPanel.createStoryboardAction }));

    await screen.findByRole("button", { name: zh.storyboardWaterfall.regenerateShotLabel(1) });
    fireEvent.change(screen.getByLabelText(zh.keyGate.videoKeyLabel), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: zh.storyboardWaterfall.regenerateShotLabel(1) }));

    expect(await screen.findByText(zh.errors.missingVideoKeyForRegenerate)).toBeInTheDocument();
    expect(apiMocks.regenerateShot).not.toHaveBeenCalled();
  });

  it("renders StoryboardWaterfall copy from Chinese i18n for zh-CN browser locales", async () => {
    setNavigatorLanguage("zh-CN");
    const zh = getStrings("zh");

    render(<App />);
    enterKeys("video-key", {
      text: zh.keyGate.textKeyLabel,
      image: zh.keyGate.imageKeyLabel,
      video: zh.keyGate.videoKeyLabel,
    });
    fireEvent.click(screen.getByRole("button", { name: zh.chatPanel.createStoryboardAction }));

    expect(await screen.findByRole("heading", { name: zh.storyboardWaterfall.title })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: zh.storyboardWaterfall.regionLabel })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: zh.storyboardWaterfall.regenerateShotLabel(1) })).toBeInTheDocument();
  });

  it("renders missing required key errors in Chinese for create-storyboard and render flows", async () => {
    setNavigatorLanguage("zh-CN");
    const zh = getStrings("zh");

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: zh.chatPanel.createStoryboardAction }));
    expect(await screen.findByText(zh.errors.createStoryboardRequiresKeys)).toBeInTheDocument();
    expect(apiMocks.createShortDramaProject).not.toHaveBeenCalled();

    enterKeys("video-key", {
      text: zh.keyGate.textKeyLabel,
      image: zh.keyGate.imageKeyLabel,
      video: zh.keyGate.videoKeyLabel,
    });
    fireEvent.click(screen.getByRole("button", { name: zh.chatPanel.createStoryboardAction }));
    await screen.findByRole("button", { name: zh.storyboardWaterfall.regenerateShotLabel(1) });

    fireEvent.change(screen.getByLabelText(zh.keyGate.videoKeyLabel), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: zh.appShell.renderFinalVideoAction }));

    expect(await screen.findByText(zh.errors.missingVideoKeyForRender)).toBeInTheDocument();
    expect(apiMocks.renderProject).not.toHaveBeenCalled();
  });

  it("allows render with only a video key after a storyboard exists", async () => {
    apiMocks.renderProject.mockResolvedValue({
      job_id: "render-1",
      event: {
        id: "event-render-1",
        job_id: "render-1",
        project_id: "p1",
        stage: "render",
        status: "complete",
        message: "Rendered",
        created_at: "now",
      },
      project: sampleProjectResponse.project,
      storyboard: sampleProjectResponse.storyboard,
      consistency_report: sampleProjectResponse.consistency_report,
      render_report: {
        version: "1.0",
        outputs: [
          {
            path: "projects/p1/renders/final.mp4",
            format: "mp4",
            resolution: "720x1280",
            duration_seconds: 25,
          },
        ],
      },
      final_path: "projects/p1/renders/final.mp4",
    });

    render(<App />);
    enterKeys();
    fireEvent.click(screen.getByRole("button", { name: "Create storyboard" }));

    await screen.findByRole("button", { name: "Render final video" });
    fireEvent.change(screen.getByLabelText("Text API Key"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Image API Key"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Render final video" }));

    await waitFor(() =>
      expect(apiMocks.renderProject).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ video_key: "video-key" }),
      ),
    );
  });

  it("refreshes project state after render and restores final_path from the loaded snapshot", async () => {
    apiMocks.renderProject.mockResolvedValue({
      job_id: "render-1",
      event: {
        id: "event-render-1",
        job_id: "render-1",
        project_id: "p1",
        stage: "render",
        status: "complete",
        message: "Rendered",
        created_at: "now",
      },
      project: sampleProjectResponse.project,
      storyboard: sampleProjectResponse.storyboard,
      consistency_report: sampleProjectResponse.consistency_report,
      render_report: {
        version: "1.0",
        outputs: [],
      },
      final_path: "",
    });
    apiMocks.loadProject.mockResolvedValue({
      ...sampleProjectResponse,
      render_report: {
        version: "1.0",
        outputs: [
          {
            path: "projects/p1/renders/final.mp4",
            format: "mp4",
            resolution: "720x1280",
            duration_seconds: 25,
          },
        ],
      },
      final_path: "projects/p1/renders/final.mp4",
    });

    render(<App />);
    enterKeys();
    fireEvent.click(screen.getByRole("button", { name: "Create storyboard" }));

    await screen.findByRole("button", { name: "Render final video" });
    fireEvent.click(screen.getByRole("button", { name: "Render final video" }));

    await waitFor(() => expect(apiMocks.loadProject).toHaveBeenCalledWith("p1"));
    expect(await screen.findByText("projects/p1/renders/final.mp4")).toBeInTheDocument();
  });

  it("does not auto-load a stored project on mount", async () => {
    window.localStorage.setItem("openmontage:projectId", "p1");

    render(<App />);

    await waitFor(() => expect(apiMocks.loadProject).not.toHaveBeenCalled());
    expect(screen.queryByText("projects/p1/renders/final.mp4")).not.toBeInTheDocument();
  });

  it("localizes storyboard status labels in Chinese while preserving current English labels", async () => {
    apiMocks.createShortDramaProject.mockResolvedValue({
      ...sampleProjectResponse,
      storyboard: {
        shots: [
          sampleShot,
          { ...sampleShot2, status: "generating" },
          { ...sampleShot2, id: "s3", index: 3, status: "complete" },
          { ...sampleShot2, id: "s4", index: 4, status: "failed" },
        ],
      },
    });

    render(<App />);
    enterKeys();
    fireEvent.click(screen.getByRole("button", { name: "Create storyboard" }));

    expect(await screen.findAllByText("ready")).toHaveLength(1);
    expect(screen.getAllByText("generating")).toHaveLength(1);
    expect(screen.getAllByText("complete")).toHaveLength(1);
    expect(screen.getAllByText("failed")).toHaveLength(1);

    cleanup();
    setNavigatorLanguage("zh-CN");
    const zh = getStrings("zh");

    render(<App />);
    enterKeys("video-key", {
      text: zh.keyGate.textKeyLabel,
      image: zh.keyGate.imageKeyLabel,
      video: zh.keyGate.videoKeyLabel,
    });
    fireEvent.click(screen.getByRole("button", { name: zh.chatPanel.createStoryboardAction }));

    expect(await screen.findAllByText(zh.storyboardWaterfall.statusLabels.ready)).toHaveLength(1);
    expect(screen.getAllByText(zh.storyboardWaterfall.statusLabels.generating)).toHaveLength(1);
    expect(screen.getAllByText(zh.storyboardWaterfall.statusLabels.complete)).toHaveLength(1);
    expect(screen.getAllByText(zh.storyboardWaterfall.statusLabels.failed)).toHaveLength(1);
    expect(screen.queryByText("ready")).not.toBeInTheDocument();
    expect(screen.queryByText("generating")).not.toBeInTheDocument();
    expect(screen.queryByText("complete")).not.toBeInTheDocument();
    expect(screen.queryByText("failed")).not.toBeInTheDocument();
  });

  it("uses Chinese seeded app flow copy and create-project fallback for zh-CN browser locales", async () => {
    setNavigatorLanguage("zh-CN");
    const zh = getStrings("zh");

    render(<App />);

    expect(screen.getByDisplayValue(zh.appFlow.defaultTitle)).toBeInTheDocument();
    expect(screen.getByDisplayValue(zh.appFlow.defaultPrompt)).toBeInTheDocument();

    enterKeys("video-key", {
      text: zh.keyGate.textKeyLabel,
      image: zh.keyGate.imageKeyLabel,
      video: zh.keyGate.videoKeyLabel,
    });
    fireEvent.change(screen.getByDisplayValue(zh.appFlow.defaultTitle), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: zh.chatPanel.createStoryboardAction }));

    await waitFor(() => expect(apiMocks.createShortDramaProject).toHaveBeenCalled());
    expect(apiMocks.createShortDramaProject).toHaveBeenCalledWith(
      expect.objectContaining({
        title: zh.appFlow.untitledProjectTitle,
        prompt: zh.appFlow.defaultPrompt,
      }),
    );
  });

  it("provides bilingual task 4 shot editor strings while preserving the current English copy", () => {
    const zh = getStrings("zh");

    expect(strings.shotEditor.promptLabel).toBe("Shot prompt");
    expect(strings.shotEditor.saveAction).toBe("Save shot");
    expect(strings.errors.missingVideoKeyForRegenerate).toBe("Enter a video API key before regenerating a shot.");
    expect(strings.errors.missingVideoKeyForRender).toBe("Enter a video API key before rendering final video.");

    expect(zh.shotEditor.promptLabel).toBeTruthy();
    expect(zh.shotEditor.saveAction).toBeTruthy();
    expect(zh.errors.missingVideoKeyForRegenerate).toBeTruthy();
    expect(zh.errors.missingVideoKeyForRender).toBeTruthy();
  });

  it("renders the Chinese project-title placeholder for zh-CN browser locales", () => {
    setNavigatorLanguage("zh-CN");
    const zh = getStrings("zh");

    render(<App />);

    expect(screen.getByLabelText(zh.chatPanel.projectTitleLabel)).toHaveAttribute(
      "placeholder",
      zh.appFlow.defaultTitle,
    );
  });

  it("subscribes to project events after storyboard creation and appends only unique events", async () => {
    render(<App />);
    enterKeys();

    fireEvent.click(screen.getByRole("button", { name: "Create storyboard" }));

    await waitFor(() =>
      expect(apiMocks.subscribeProjectEvents).toHaveBeenCalledWith("p1", expect.any(Function)),
    );

    const onEvent = apiMocks.subscribeProjectEvents.mock.calls[0]?.[1] as (event: {
      id: string;
      job_id: string;
      project_id: string;
      stage: string;
      status: string;
      message: string;
      created_at: string;
    }) => void;

    onEvent({
      id: "event-1",
      job_id: "job-1",
      project_id: "p1",
      stage: "render",
      status: "running",
      message: "Rendering final video",
      created_at: "2026-07-03T00:00:00Z",
    });
    onEvent({
      id: "event-1",
      job_id: "job-1",
      project_id: "p1",
      stage: "render",
      status: "running",
      message: "Rendering final video",
      created_at: "2026-07-03T00:00:01Z",
    });

    expect(await screen.findByText("Rendering final video")).toBeInTheDocument();
    expect(screen.getAllByText("Rendering final video")).toHaveLength(1);
  });
});
