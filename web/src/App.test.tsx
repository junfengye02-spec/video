import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { getStrings } from "./i18n";
import type { ShortDramaProjectResponse, Shot } from "./domain/types";

const apiMocks = vi.hoisted(() => ({
  createDraftProject: vi.fn(),
  createShortDramaProject: vi.fn(),
  generateAsset: vi.fn(),
  loadLatestProject: vi.fn(),
  loadProject: vi.fn(),
  mediaUrl: vi.fn((path: string | null | undefined, projectId?: string | null) => {
    if (!path) {
      return null;
    }
    return path.startsWith("/api/") || !projectId ? path : `/api/projects/${projectId}/media/${path}`;
  }),
  optimizePrompt: vi.fn(),
  regenerateShot: vi.fn(),
  renderProject: vi.fn(),
  saveContinuityPlan: vi.fn(),
  saveGatewayKey: vi.fn(),
  saveShot: vi.fn(),
  subscribeProjectEvents: vi.fn(),
  uploadReferenceImage: vi.fn(),
  uploadShotVideo: vi.fn(),
}));

vi.mock("./api/client", () => apiMocks);

const localProjectStoreMocks = vi.hoisted(() => ({
  deleteProject: vi.fn(),
  listProjectSummaries: vi.fn(),
  loadProjectSnapshot: vi.fn(),
  loadRecentProjectSnapshot: vi.fn(),
  saveProjectSnapshot: vi.fn(),
  setRecentProjectId: vi.fn(),
}));

const localMediaStoreMocks = vi.hoisted(() => ({
  cacheRemoteMedia: vi.fn(),
  loadMediaBlob: vi.fn(),
  saveMediaBlob: vi.fn(),
}));

const localExportMocks = vi.hoisted(() => ({
  exportProjectBackup: vi.fn(),
  importProjectBackup: vi.fn(),
}));

const localStorageEstimateMocks = vi.hoisted(() => ({
  formatBytes: vi.fn((bytes: number | null) => (bytes === null ? "Unknown" : `${bytes} B`)),
  getStorageEstimate: vi.fn(),
}));

const localMediaUrlMocks = vi.hoisted(() => ({
  resolveLocalMediaUrl: vi.fn(),
  revokeLocalMediaUrls: vi.fn(),
}));

vi.mock("./localdb/projectStore", () => localProjectStoreMocks);
vi.mock("./localdb/mediaStore", () => localMediaStoreMocks);
vi.mock("./localdb/mediaUrls", () => localMediaUrlMocks);
vi.mock("./localdb/exportProject", () => localExportMocks);
vi.mock("./localdb/storageEstimate", () => localStorageEstimateMocks);

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
  shot_language: {
    shot_size: "medium_close",
    camera_movement: "dolly_in",
    lighting_key: "neon",
    depth_of_field: "shallow",
    color_temperature: "cool",
  },
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
    assets: [
      {
        id: "asset-char-1",
        kind: "character",
        label: "Mara reference",
        description: "Red coat hero reference",
        prompt: "Mara red coat hero reference",
        reference_images: ["assets/images/character/mara.png"],
        shot_ids: [],
        version: 1,
      },
    ],
  },
  storyboard: { shots: [sampleShot, sampleShot2] },
  consistency_report: { score: 100, issues: [] },
};

const strings = getStrings("en");
const originalNavigatorLanguage = navigator.language;

function cloneProjectResponse(): ShortDramaProjectResponse {
  return structuredClone(sampleProjectResponse) as ShortDramaProjectResponse;
}

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
  fireEvent.change(screen.getByLabelText(strings.chatPanel.promptLabel), {
    target: { value: "rain-night urban reversal short drama" },
  });
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
    apiMocks.createShortDramaProject.mockResolvedValue(cloneProjectResponse());
    apiMocks.loadProject.mockResolvedValue(cloneProjectResponse());
    localProjectStoreMocks.loadRecentProjectSnapshot.mockResolvedValue(null);
    localProjectStoreMocks.saveProjectSnapshot.mockResolvedValue(undefined);
    localProjectStoreMocks.setRecentProjectId.mockResolvedValue(undefined);
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue(null);
    localMediaUrlMocks.resolveLocalMediaUrl.mockImplementation((ref: string) => Promise.resolve(`blob:${ref}`));
    localMediaUrlMocks.revokeLocalMediaUrls.mockReturnValue(undefined);
    localExportMocks.exportProjectBackup.mockResolvedValue(new Blob(["backup"], { type: "application/zip" }));
    localExportMocks.importProjectBackup.mockResolvedValue(cloneProjectResponse());
    localStorageEstimateMocks.getStorageEstimate.mockResolvedValue({
      usageBytes: 2048,
      quotaBytes: 4096,
      persisted: false,
    });
    localStorageEstimateMocks.formatBytes.mockImplementation((bytes: number | null) =>
      bytes === null ? "Unknown" : `${bytes} B`,
    );
    apiMocks.optimizePrompt.mockResolvedValue({
      project_id: "p1",
      model: "gpt-5.5",
      optimized_text: "Lin in red coat opens the soaked envelope under neon rain.",
      notes: ["rewritten by text model as structured shot JSON"],
      shot_intent: "Push into the clue as Lin realizes the betrayal.",
      shot_language: {
        shot_size: "close_up",
        camera_movement: "dolly_in",
        lens_mm: 85,
        depth_of_field: "shallow",
      },
    });
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

  it("requires a story prompt before creating a storyboard", async () => {
    render(<App />);
    enterKeys();

    fireEvent.click(screen.getByRole("button", { name: strings.chatPanel.createStoryboardAction }));

    expect(await screen.findByText("Enter a story prompt before creating the storyboard.")).toBeInTheDocument();
    expect(apiMocks.createShortDramaProject).not.toHaveBeenCalled();
  });

  it("hides series settings for single videos and reveals them for series projects", () => {
    setNavigatorLanguage("zh-CN");
    const zh = getStrings("zh");

    render(<App />);

    expect(screen.getByRole("tab", { name: zh.nav.storyboard })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: zh.nav.series })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: zh.nav.episodes })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: zh.nav.resources })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: zh.nav.production })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(zh.projectType.miniSeries));

    expect(screen.getByRole("tab", { name: zh.nav.series })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: zh.nav.episodes })).toBeInTheDocument();
  });

  it("locks the project type after a project is created", async () => {
    render(<App />);
    enterKeys();
    fireEvent.click(screen.getByLabelText(strings.projectType.miniSeries));
    fireEvent.change(screen.getByLabelText(strings.chatPanel.promptLabel), {
      target: { value: "rain-night urban reversal short drama" },
    });

    fireEvent.click(screen.getByRole("button", { name: strings.chatPanel.createStoryboardAction }));

    await waitFor(() =>
      expect(apiMocks.createShortDramaProject).toHaveBeenCalledWith(
        expect.objectContaining({ project_type: "mini_series" }),
      ),
    );
    expect(screen.getByLabelText(strings.projectType.singleVideo)).toBeDisabled();
    expect(screen.getByLabelText(strings.projectType.miniSeries)).toBeDisabled();
    expect(screen.getByLabelText(strings.projectType.longSeries)).toBeDisabled();
    expect(screen.getByText("Project type is locked after creation.")).toBeInTheDocument();
  });

  it("shows complete continuity fields for series and episode settings", () => {
    setNavigatorLanguage("zh-CN");
    const zh = getStrings("zh");

    render(<App />);
    fireEvent.click(screen.getByLabelText(zh.projectType.miniSeries));
    fireEvent.click(screen.getByRole("tab", { name: zh.nav.series }));

    expect(screen.getByLabelText(zh.continuity.worldview)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.mainArc)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.styleLock)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.visualRules)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.taboos)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.locations)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.relationshipMap)).toBeInTheDocument();
    expect(screen.getByText(zh.continuity.storyStateTitle)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.characterKnowledge)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.activeForeshadowing)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: zh.nav.episodes }));

    expect(screen.getByRole("button", { name: zh.continuity.addEpisode })).toBeInTheDocument();
    expect(screen.getByText(zh.continuity.currentProductionEpisode(1))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: zh.continuity.addEpisode }));

    expect(screen.getByLabelText(zh.continuity.episodeTitle)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.goal)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.conflict)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.twist)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.cliffhanger)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.inheritedState)).toBeInTheDocument();
    expect(screen.getByLabelText(zh.continuity.locked)).toBeInTheDocument();
  });

  it("keeps character selection framed while aligning it with regular shot fields", async () => {
    render(<App />);
    await createStoryboard();

    const characterGroup = screen.getByRole("group", { name: strings.shotEditor.charactersLabel });
    expect(characterGroup).toHaveClass("character-binding-group");
    expect(characterGroup).not.toHaveClass("asset-binding-group");
    expect(characterGroup.querySelector(".character-binding-options")).not.toBeNull();
  });

  it("shows resource library images from backend reference image paths", async () => {
    render(<App />);
    await createStoryboard();

    fireEvent.click(screen.getByRole("tab", { name: strings.nav.resources }));

    const image = screen.getByRole("img", { name: "Mara reference" });
    expect(apiMocks.mediaUrl).toHaveBeenCalledWith("assets/images/character/mara.png", "p1");
    expect(image).toHaveAttribute("src", "/api/projects/p1/media/assets/images/character/mara.png");
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

  it("requires an explicit asset save before image-to-video regeneration", async () => {
    apiMocks.saveShot.mockResolvedValue({
      job_id: "save-job",
      event: {
        id: "save-event",
        job_id: "save-job",
        project_id: "p1",
        stage: "save",
        status: "complete",
        message: "Shot saved",
        created_at: "now",
      },
      shot: { ...sampleShot, asset_ids: ["asset-char-1"] },
      storyboard: {
        shots: [
          { ...sampleShot, asset_ids: ["asset-char-1"] },
          sampleShot2,
        ],
      },
      consistency_report: { score: 100, issues: [] },
    });
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "regen-job",
      event: {
        id: "regen-event",
        job_id: "regen-job",
        project_id: "p1",
        stage: "regenerate",
        status: "complete",
        message: "Shot regenerated",
        created_at: "now",
      },
      shot: { ...sampleShot, status: "complete", asset_ids: ["asset-char-1"] },
      storyboard: { shots: [{ ...sampleShot, status: "complete", asset_ids: ["asset-char-1"] }, sampleShot2] },
      consistency_report: { score: 100, issues: [] },
      generation: {
        operation: "reference_to_video",
        reference_image_paths: ["assets/images/character/mara.png"],
        output_path: "assets/video/shot-1.mp4",
        cost_usd: 0.2,
      },
    });

    render(<App />);
    await createStoryboard();

    expect(screen.getByText("Text-to-video: no saved reference image selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Mara reference/i }));
    expect(screen.getByText("Image-to-video: 1 reference image selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.shotEditor.regenerateAction })).toBeDisabled();
    expect(screen.getByText(strings.shotEditor.saveBeforeRegenerateHint)).toBeInTheDocument();
    expect(apiMocks.saveShot).not.toHaveBeenCalled();
    expect(apiMocks.regenerateShot).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.saveAction }));

    await waitFor(() =>
      expect(apiMocks.saveShot).toHaveBeenCalledWith(
        "p1",
        sampleShot.id,
        expect.objectContaining({ asset_ids: ["asset-char-1"] }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: strings.shotEditor.regenerateAction })).toBeEnabled(),
    );
    expect(apiMocks.regenerateShot).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.regenerateAction }));

    await waitFor(() => expect(apiMocks.regenerateShot).toHaveBeenCalledTimes(1));
    expect(apiMocks.saveShot).toHaveBeenCalledTimes(1);
    expect(apiMocks.saveShot.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.regenerateShot.mock.invocationCallOrder[0],
    );
  });

  it("caps the displayed image-to-video reference count at three", async () => {
    const projectWithManyReferences = cloneProjectResponse();
    projectWithManyReferences.series_bible.assets![0].reference_images = [
      "assets/images/character/mara-1.png",
      "assets/images/character/mara-2.png",
      "assets/images/character/mara-3.png",
      "assets/images/character/mara-4.png",
    ];
    apiMocks.createShortDramaProject.mockResolvedValue(projectWithManyReferences);
    apiMocks.loadProject.mockResolvedValue(projectWithManyReferences);

    render(<App />);
    await createStoryboard();

    fireEvent.click(screen.getByRole("checkbox", { name: /Mara reference/i }));

    expect(screen.getByText("Image-to-video: 3 reference images selected")).toBeInTheDocument();
  });

  it("keeps regeneration disabled when an explicit save fails", async () => {
    apiMocks.saveShot.mockRejectedValueOnce(new Error("save exploded"));

    render(<App />);
    await createStoryboard();
    fireEvent.change(screen.getByLabelText(strings.shotEditor.promptLabel), {
      target: { value: "Unsaved prompt" },
    });

    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.saveAction }));

    expect(await screen.findByText("save exploded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.shotEditor.regenerateAction })).toBeDisabled();
    expect(apiMocks.regenerateShot).not.toHaveBeenCalled();
  });

  it("edits shot language and character bindings with structured controls", async () => {
    render(<App />);
    await createStoryboard();

    expect(screen.getByLabelText("Shot size")).toBeInTheDocument();
    expect(screen.getByLabelText("Camera movement")).toBeInTheDocument();
    expect(screen.getByLabelText("Shot intent")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("checkbox", { name: /Mara/i })[0]).toBeChecked());

    fireEvent.change(screen.getByLabelText("Shot size"), { target: { value: "close_up" } });
    fireEvent.change(screen.getByLabelText("Camera movement"), { target: { value: "dolly_in" } });
    fireEvent.change(screen.getByLabelText("Shot intent"), { target: { value: "Push into Mara's realization." } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Jin/i }));

    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.saveAction }));

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

  it("shows the full backend shot language enum in editor controls", async () => {
    const projectWithFullEnumShot = cloneProjectResponse();
    projectWithFullEnumShot.storyboard.shots = [
      {
        ...sampleShot,
        shot_language: {
          shot_size: "insert",
          camera_movement: "whip_pan",
          lighting_key: "neon",
          depth_of_field: "shallow",
          color_temperature: "cool",
        },
      } as Shot,
    ];
    apiMocks.createShortDramaProject.mockResolvedValue(projectWithFullEnumShot);

    render(<App />);
    await createStoryboard();

    expect(screen.getByLabelText(strings.shotEditor.shotSizeLabel)).toHaveValue("insert");
    expect(screen.getByLabelText(strings.shotEditor.cameraMovementLabel)).toHaveValue("whip_pan");
  });

  it("selects a storyboard shot for editing instead of always editing the first shot", async () => {
    render(<App />);
    await createStoryboard();

    expect(screen.getByLabelText(strings.shotEditor.promptLabel)).toHaveValue(sampleShot.prompt);

    fireEvent.click(screen.getByRole("button", { name: "Edit shot 2" }));

    expect(screen.getByLabelText(strings.shotEditor.promptLabel)).toHaveValue(sampleShot2.prompt);
    fireEvent.change(screen.getByLabelText(strings.shotEditor.promptLabel), {
      target: { value: "Mara spots her boss in the rain reflection." },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.saveAction }));

    await waitFor(() => expect(apiMocks.saveShot).toHaveBeenCalledWith(
      "p1",
      "shot-2",
      expect.objectContaining({
        prompt: "Mara spots her boss in the rain reflection.",
      }),
    ));
  });

  it("optimizes a shot prompt into prompt, intent, and shot language before save", async () => {
    render(<App />);
    await createStoryboard();

    fireEvent.change(screen.getByLabelText(strings.shotEditor.promptLabel), {
      target: { value: "Lin opens envelope." },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.optimizeAction }));

    await waitFor(() => expect(apiMocks.optimizePrompt).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        target: "shot",
        target_id: "shot-1",
        source_text: "Lin opens envelope.",
        mode: "shot_json",
      }),
    ));
    expect(screen.getByLabelText(strings.shotEditor.promptLabel)).toHaveValue(
      "Lin in red coat opens the soaked envelope under neon rain.",
    );
    expect(screen.getByLabelText(strings.shotEditor.intentLabel)).toHaveValue(
      "Push into the clue as Lin realizes the betrayal.",
    );
    expect(screen.getByLabelText(strings.shotEditor.shotSizeLabel)).toHaveValue("close_up");
    expect(screen.getByLabelText(strings.shotEditor.cameraMovementLabel)).toHaveValue("dolly_in");

    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.saveAction }));

    await waitFor(() => expect(apiMocks.saveShot).toHaveBeenCalledWith(
      "p1",
      "shot-1",
      expect.objectContaining({
        prompt: "Lin in red coat opens the soaked envelope under neon rain.",
        shot_intent: "Push into the clue as Lin realizes the betrayal.",
        shot_language: expect.objectContaining({
          shot_size: "close_up",
          camera_movement: "dolly_in",
        }),
      }),
    ));
  });

  it("preserves existing shot language fields when optimize returns only a subset", async () => {
    apiMocks.optimizePrompt.mockResolvedValueOnce({
      project_id: "p1",
      model: "gpt-5.5",
      optimized_text: "Lin in red coat opens the soaked envelope under neon rain.",
      notes: ["rewritten by text model as structured shot JSON"],
      shot_intent: "Push into the clue as Lin realizes the betrayal.",
      shot_language: {
        shot_size: "close_up",
        camera_movement: "dolly_in",
      },
    });

    render(<App />);
    await createStoryboard();

    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.optimizeAction }));

    await waitFor(() =>
      expect(apiMocks.saveShot).not.toHaveBeenCalled(),
    );

    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.saveAction }));

    await waitFor(() => expect(apiMocks.saveShot).toHaveBeenCalledWith(
      "p1",
      "shot-1",
      expect.objectContaining({
        shot_language: expect.objectContaining({
          shot_size: "close_up",
          camera_movement: "dolly_in",
          lighting_key: "neon",
          depth_of_field: "shallow",
          color_temperature: "cool",
        }),
      }),
    ));
  });

  it("preserves newer user-entered shot intent when optimize resolves without shot_intent", async () => {
    let resolveOptimize: ((value: {
      project_id: string;
      model: string;
      optimized_text: string;
      notes: string[];
      shot_language?: { shot_size: "close_up" };
    }) => void) | undefined;

    apiMocks.optimizePrompt.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOptimize = resolve;
      }),
    );

    render(<App />);
    await createStoryboard();

    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.optimizeAction }));
    await waitFor(() => expect(apiMocks.optimizePrompt).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(strings.shotEditor.intentLabel), {
      target: { value: "Hold on Mara as she rethinks the clue." },
    });

    resolveOptimize?.({
      project_id: "p1",
      model: "gpt-5.5",
      optimized_text: "Lin in red coat opens the soaked envelope under neon rain.",
      notes: ["rewritten by text model as structured shot JSON"],
      shot_language: { shot_size: "close_up" },
    });

    await waitFor(() =>
      expect(screen.getByLabelText(strings.shotEditor.promptLabel)).toHaveValue(
        "Lin in red coat opens the soaked envelope under neon rain.",
      ),
    );
    expect(screen.getByLabelText(strings.shotEditor.intentLabel)).toHaveValue(
      "Hold on Mara as she rethinks the clue.",
    );

    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.saveAction }));

    await waitFor(() => expect(apiMocks.saveShot).toHaveBeenCalledWith(
      "p1",
      "shot-1",
      expect.objectContaining({
        shot_intent: "Hold on Mara as she rethinks the clue.",
      }),
    ));
  });

  it("falls back to the default base URL when shot optimization is triggered with a blank base URL input", async () => {
    render(<App />);
    await createStoryboard();

    fireEvent.change(screen.getByLabelText(strings.keyGate.baseUrlLabel), {
      target: { value: "   " },
    });
    fireEvent.change(screen.getByLabelText(strings.shotEditor.promptLabel), {
      target: { value: "Lin opens envelope." },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.optimizeAction }));

    await waitFor(() =>
      expect(apiMocks.optimizePrompt).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          base_url: "https://api.0000238.xyz",
          mode: "shot_json",
        }),
      ),
    );
  });

  it("requires a video key before regenerating a shot", async () => {
    render(<App />);
    enterKeys();
    fireEvent.change(screen.getByLabelText(strings.chatPanel.promptLabel), {
      target: { value: "rain-night urban reversal short drama" },
    });
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
    fireEvent.change(screen.getByLabelText(zh.chatPanel.promptLabel), {
      target: { value: "rain-night urban reversal short drama" },
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
    fireEvent.change(screen.getByLabelText(zh.chatPanel.promptLabel), {
      target: { value: "rain-night urban reversal short drama" },
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
    fireEvent.change(screen.getByLabelText(zh.chatPanel.promptLabel), {
      target: { value: "rain-night urban reversal short drama" },
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
            path: "renders/final.mp4",
            format: "mp4",
            resolution: "720x1280",
            duration_seconds: 25,
          },
        ],
      },
      final_path: "renders/final.mp4",
    });

    render(<App />);
    enterKeys();
    fireEvent.change(screen.getByLabelText(strings.chatPanel.promptLabel), {
      target: { value: "rain-night urban reversal short drama" },
    });
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

  it("caches final render media locally and keeps the local final path", async () => {
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue("local://media/final-1");
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
            path: "renders/final.mp4",
            format: "mp4",
            resolution: "720x1280",
            duration_seconds: 25,
          },
        ],
      },
      final_path: "renders/final.mp4",
    });

    render(<App />);
    enterKeys();
    fireEvent.change(screen.getByLabelText(strings.chatPanel.promptLabel), {
      target: { value: "rain-night urban reversal short drama" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create storyboard" }));

    await screen.findByRole("button", { name: "Render final video" });
    fireEvent.click(screen.getByRole("button", { name: "Render final video" }));

    await waitFor(() =>
      expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledWith("/api/projects/p1/media/renders/final.mp4", {
        projectId: "p1",
        sourcePath: "renders/final.mp4",
      }),
    );
    await waitFor(() =>
      expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({ final_path: "local://media/final-1" }),
      ),
    );
    expect(apiMocks.loadProject).not.toHaveBeenCalled();
    expect(await screen.findByText("local://media/final-1")).toBeInTheDocument();
  });

  it("keeps successful render results without requiring a follow-up project refresh", async () => {
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
            path: "renders/final.mp4",
            format: "mp4",
            resolution: "720x1280",
            duration_seconds: 25,
          },
        ],
      },
      final_path: "renders/final.mp4",
    });

    render(<App />);
    await createStoryboard();

    fireEvent.click(screen.getByRole("button", { name: "Render final video" }));

    expect(await screen.findByText("renders/final.mp4")).toBeInTheDocument();
    expect(apiMocks.loadProject).not.toHaveBeenCalled();
    expect(screen.queryByText(strings.errors.renderFallback)).not.toBeInTheDocument();
  });

  it("restores the recent browser-local project on mount without calling server latest", async () => {
    apiMocks.loadLatestProject.mockRejectedValue(new Error("server latest must not be called"));
    localProjectStoreMocks.loadRecentProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "Rain Alley",
      updatedAt: "2026-07-08T00:00:00.000Z",
      snapshot: cloneProjectResponse(),
    });

    render(<App />);

    await waitFor(() => expect(localProjectStoreMocks.loadRecentProjectSnapshot).toHaveBeenCalled());
    expect(apiMocks.loadLatestProject).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: strings.shotEditor.saveAction })).toBeEnabled();
    expect(screen.getByText("Rain Alley")).toBeInTheDocument();
  });

  it("starts a new local draft from a loaded project so another project type can be selected", async () => {
    localProjectStoreMocks.loadRecentProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "Rain Alley",
      updatedAt: "2026-07-08T00:00:00.000Z",
      snapshot: cloneProjectResponse(),
    });

    render(<App />);

    expect(await screen.findByText("Rain Alley")).toBeInTheDocument();
    expect(screen.getByLabelText(strings.projectType.miniSeries)).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "New draft" }));

    await waitFor(() => expect(localProjectStoreMocks.setRecentProjectId).toHaveBeenCalledWith(null));
    expect(screen.getByText(strings.appShell.noProjectYet)).toBeInTheDocument();
    expect(screen.getByLabelText(strings.projectType.miniSeries)).toBeEnabled();

    fireEvent.click(screen.getByLabelText(strings.projectType.miniSeries));

    expect(screen.getByRole("tab", { name: strings.nav.series })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: strings.nav.episodes })).toBeInTheDocument();
  });

  it("saves created projects to browser-local storage", async () => {
    render(<App />);

    await createStoryboard();

    await waitFor(() => expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ project: expect.objectContaining({ id: "p1" }) }),
    ));
  });

  it("shows browser-local storage controls and imports a backup into the workspace", async () => {
    render(<App />);

    expect(await screen.findByText("Local storage")).toBeInTheDocument();
    expect(screen.getByText("Projects are saved in this browser. Export backups before clearing browser data.")).toBeInTheDocument();
    expect(screen.getByText("Browser storage used: 2048 B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export project" })).toBeDisabled();

    await createStoryboard();

    expect(screen.getByRole("button", { name: "Export project" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Export project" }));
    await waitFor(() => expect(localExportMocks.exportProjectBackup).toHaveBeenCalledWith("p1"));

    const fileInput = screen.getByLabelText("Import project");
    const backupFile = new File(["backup"], "rain.omproj", { type: "application/zip" });
    fireEvent.change(fileInput, { target: { files: [backupFile] } });

    await waitFor(() => expect(localExportMocks.importProjectBackup).toHaveBeenCalledWith(backupFile));
    expect(screen.getByText("Rain Alley")).toBeInTheDocument();
  });

  it("caches regenerated shot media locally and persists the updated snapshot", async () => {
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue("local://media/shot-1");
    apiMocks.regenerateShot.mockResolvedValue({
      job_id: "j-regenerate",
      event: {
        id: "e-regenerate",
        job_id: "j-regenerate",
        project_id: "p1",
        stage: "regenerate",
        status: "complete",
        message: "Regenerated",
        created_at: "now",
      },
      shot: { ...sampleShot, output_path: "assets/video/shot-1.mp4", output_url: null },
      storyboard: {
        shots: [
          { ...sampleShot, output_path: "assets/video/shot-1.mp4", output_url: null },
          sampleShot2,
        ],
      },
      consistency_report: { score: 100, issues: [] },
    });

    render(<App />);
    await createStoryboard();

    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.regenerateAction }));

    await waitFor(() =>
      expect(localMediaStoreMocks.cacheRemoteMedia).toHaveBeenCalledWith("/api/projects/p1/media/assets/video/shot-1.mp4", {
        projectId: "p1",
        sourcePath: "assets/video/shot-1.mp4",
      }),
    );
    await waitFor(() =>
      expect(localProjectStoreMocks.saveProjectSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({
          storyboard: expect.objectContaining({
            shots: expect.arrayContaining([
              expect.objectContaining({ id: "shot-1", output_path: "local://media/shot-1" }),
            ]),
          }),
        }),
      ),
    );
  });

  it("resolves browser-local media refs for restored project previews", async () => {
    const localSnapshot = cloneProjectResponse();
    localSnapshot.series_bible.assets = [
      {
        id: "asset-local",
        kind: "character",
        label: "Local reference",
        description: "Stored in browser",
        prompt: "reference",
        reference_images: ["local://media/asset-1"],
        media_urls: [],
        shot_ids: [],
        version: 1,
      },
    ];
    localSnapshot.final_path = "local://media/final-1";
    localProjectStoreMocks.loadRecentProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "Rain Alley",
      updatedAt: "2026-07-08T00:00:00.000Z",
      snapshot: localSnapshot,
    });

    render(<App />);

    await waitFor(() => expect(localMediaUrlMocks.resolveLocalMediaUrl).toHaveBeenCalledWith("local://media/asset-1"));
    await waitFor(() => expect(localMediaUrlMocks.resolveLocalMediaUrl).toHaveBeenCalledWith("local://media/final-1"));

    fireEvent.click(screen.getByRole("tab", { name: strings.nav.resources }));

    const image = await screen.findByRole("img", { name: "Local reference" });
    expect(image).toHaveAttribute("src", "blob:local://media/asset-1");
    const finalVideo = screen.getByLabelText(strings.appShell.finalVideoTitle);
    expect(finalVideo).toHaveAttribute("src", "blob:local://media/final-1");
  });

  it("downloads the browser-local final video as an mp4", async () => {
    const localSnapshot = cloneProjectResponse();
    localSnapshot.final_path = "local://media/final-1";
    localProjectStoreMocks.loadRecentProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "Rain Alley",
      updatedAt: "2026-07-08T00:00:00.000Z",
      snapshot: localSnapshot,
    });
    localMediaStoreMocks.loadMediaBlob.mockResolvedValue(new Blob(["final-video"], { type: "video/mp4" }));
    const createObjectUrl = vi.fn(() => "blob:download-final");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
    const click = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
      const element = originalCreateElement(tagName, options);
      if (tagName.toLowerCase() === "a") {
        element.click = click;
      }
      return element;
    });

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Download final video" }));

    await waitFor(() => expect(localMediaStoreMocks.loadMediaBlob).toHaveBeenCalledWith("local://media/final-1"));
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    const link = createElement.mock.results.find((result) => result.value instanceof HTMLAnchorElement)
      ?.value as HTMLAnchorElement;
    expect(link.download).toBe("Rain Alley-final.mp4");
    expect(link.href).toBe("blob:download-final");
    expect(click).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:download-final");
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
    fireEvent.change(screen.getByLabelText(strings.chatPanel.promptLabel), {
      target: { value: "rain-night urban reversal short drama" },
    });
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
    fireEvent.change(screen.getByLabelText(zh.chatPanel.promptLabel), {
      target: { value: "rain-night urban reversal short drama" },
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

  it("starts Chinese project title and prompt fields blank while preserving title fallback", async () => {
    setNavigatorLanguage("zh-CN");
    const zh = getStrings("zh");

    render(<App />);

    expect(screen.getByLabelText(zh.chatPanel.projectTitleLabel)).toHaveValue("");
    expect(screen.getByLabelText(zh.chatPanel.promptLabel)).toHaveValue("");
    expect(screen.queryByDisplayValue(zh.appFlow.defaultTitle)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(zh.appFlow.defaultPrompt)).not.toBeInTheDocument();

    enterKeys("video-key", {
      text: zh.keyGate.textKeyLabel,
      image: zh.keyGate.imageKeyLabel,
      video: zh.keyGate.videoKeyLabel,
    });
    fireEvent.change(screen.getByLabelText(zh.chatPanel.promptLabel), {
      target: { value: "rain-night urban reversal short drama" },
    });
    fireEvent.click(screen.getByRole("button", { name: zh.chatPanel.createStoryboardAction }));

    await waitFor(() => expect(apiMocks.createShortDramaProject).toHaveBeenCalled());
    expect(apiMocks.createShortDramaProject).toHaveBeenCalledWith(
      expect.objectContaining({
        title: zh.appFlow.untitledProjectTitle,
        prompt: "rain-night urban reversal short drama",
      }),
    );
  });

  it("provides bilingual shot draft workflow strings", () => {
    const zh = getStrings("zh");

    expect(strings.shotEditor.promptLabel).toBe("Shot prompt");
    expect(strings.shotEditor.optimizeAction).toBe("AI optimize prompt");
    expect(strings.shotEditor.undoOptimizationAction).toBe("Undo optimization");
    expect(strings.shotEditor.saveAction).toBe("Save changes");
    expect(strings.shotEditor.regenerateAction).toBe("Regenerate");
    expect(strings.shotEditor.saveBeforeRegenerateHint).toBe("Save changes first");
    expect(strings.errors.missingVideoKeyForRegenerate).toBe("Enter a video API key before regenerating a shot.");
    expect(strings.errors.missingVideoKeyForRender).toBe("Enter a video API key before rendering final video.");

    expect(zh.shotEditor.promptLabel).toBeTruthy();
    expect(zh.shotEditor.optimizeAction).toBeTruthy();
    expect(zh.shotEditor.undoOptimizationAction).toBeTruthy();
    expect(zh.shotEditor.saveAction).toBeTruthy();
    expect(zh.shotEditor.regenerateAction).toBeTruthy();
    expect(zh.shotEditor.saveBeforeRegenerateHint).toBeTruthy();
    expect(zh.errors.missingVideoKeyForRegenerate).toBeTruthy();
    expect(zh.errors.missingVideoKeyForRender).toBeTruthy();
  });

  it("does not render the Chinese seeded project title as a placeholder", () => {
    setNavigatorLanguage("zh-CN");
    const zh = getStrings("zh");

    render(<App />);

    expect(screen.getByLabelText(zh.chatPanel.projectTitleLabel)).not.toHaveAttribute("placeholder");
  });

  it("subscribes to project events after storyboard creation and appends only unique events", async () => {
    render(<App />);
    enterKeys();
    fireEvent.change(screen.getByLabelText(strings.chatPanel.promptLabel), {
      target: { value: "rain-night urban reversal short drama" },
    });

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
