// @ts-expect-error The Vitest runtime provides Node built-ins, but the browser tsconfig omits them.
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetRecord, GenerateImagesResponse, MediaAsset } from "../domain/types";
import { getStrings } from "../i18n";
import { ApiError } from "../platform/http/HttpClient";
import { createAcceptedImageTask, createProjectResponse } from "../test/fixtures";
import { chooseSelectMenuOption, selectMenuOptions } from "../test/selectMenu";
import { ResourceLibraryPage, type ResourceLibraryPageProps } from "./ResourceLibraryPage";

const project = createProjectResponse();
const strings = getStrings("zh").resources;
const resourceProps: ResourceLibraryPageProps = {
  assets: project.series_bible.assets ?? [],
  consistencyReport: project.consistency_report,
  currentShotId: "shot-1",
  shots: project.storyboard.shots,
  uploading: false,
  onBindAsset: vi.fn().mockResolvedValue(undefined),
  onUploadReferenceImage: vi.fn().mockResolvedValue(undefined),
};
const secondaryAsset: AssetRecord = {
  id: "prop-envelope",
  kind: "prop",
  label: "信封",
  description: "雨夜发现的密封信件",
  prompt: "红色火漆封口",
  reference_images: [],
};

function mediaAsset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: "media-ai-1",
    origin_project_id: "p1",
    kind: "character",
    source_type: "ai_generated",
    label: "AI Mara",
    description: "Red coat portrait",
    prompt: "Cinematic red coat character",
    model: "gpt-image-2",
    generation_job_id: "image-job-1",
    media_url: "/api/projects/p1/media/assets/images/generated/image-job-1-0.png",
    status: "ready",
    created_at: "2026-07-14T08:00:00Z",
    ...overrides,
  };
}

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("ResourceLibraryPage", () => {
  it("shows AI-planned resources and prefills the generation drawer", () => {
    const plannedCharacter: AssetRecord = {
      id: "character-c1",
      kind: "character",
      label: "Lin",
      description: "lead investigator",
      prompt: "red coat, short hair, consistent facial identity",
      reference_images: [],
      planned: true,
    };
    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[plannedCharacter]}
        onGenerateImages={vi.fn()}
      />,
    );

    expect(screen.getByText(strings.plannedPreview)).toBeInTheDocument();
    expect(screen.getByText(strings.plannedSourceLabel)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.generatePlannedAction })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));

    expect(screen.getByRole("button", { name: strings.kindLabel })).toHaveTextContent(
      strings.kindLabels.character,
    );
    expect(screen.getByLabelText(strings.labelLabel)).toHaveValue("Lin");
    expect(screen.getByLabelText(strings.descriptionLabel)).toHaveValue("lead investigator");
    expect(screen.getByLabelText(strings.promptLabel)).toHaveValue(
      "red coat, short hair, consistent facial identity",
    );
    expect(screen.getByText(strings.plannedPrefillNotice)).toBeInTheDocument();
  });

  it("uploads a reference image into the selected planned resource", async () => {
    const onUploadReferenceImage = vi.fn().mockResolvedValue(undefined);
    const plannedCharacter: AssetRecord = {
      id: "character-c1",
      kind: "character",
      label: "Lin",
      description: "lead investigator",
      prompt: "red coat, short hair",
      reference_images: [],
      planned: true,
    };
    const file = new File(["portrait"], "lin.png", { type: "image/png" });
    render(<ResourceLibraryPage {...resourceProps} assets={[plannedCharacter]} onUploadReferenceImage={onUploadReferenceImage} />);

    fireEvent.click(screen.getByRole("button", { name: strings.viewAsset("Lin") }));
    fireEvent.click(screen.getByRole("button", { name: strings.uploadPlannedReferenceAction }));
    fireEvent.change(screen.getByLabelText(strings.fileLabel), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: strings.submitUploadAction }));

    await waitFor(() => expect(onUploadReferenceImage).toHaveBeenCalledWith({
      kind: "character",
      label: "Lin",
      description: "lead investigator",
      prompt: "red coat, short hair",
      file,
      resource_id: "character-c1",
    }));
  });

  it("saves an edited planned prompt before submitting its generation task", async () => {
    const onUpdatePlannedAssetPrompt = vi.fn().mockResolvedValue(undefined);
    const onGenerateImages = vi.fn().mockResolvedValue(createAcceptedImageTask());
    const plannedCharacter: AssetRecord = {
      id: "character-c1",
      kind: "character",
      label: "Lin",
      description: "lead investigator",
      prompt: "red coat, short hair",
      reference_images: [],
      planned: true,
    };
    render(<ResourceLibraryPage {...resourceProps} assets={[plannedCharacter]} onGenerateImages={onGenerateImages} onUpdatePlannedAssetPrompt={onUpdatePlannedAssetPrompt} />);

    fireEvent.click(screen.getByRole("button", { name: strings.generatePlannedAction }));
    fireEvent.change(screen.getByLabelText(strings.promptLabel), { target: { value: "edited cinematic prompt" } });
    fireEvent.click(screen.getByRole("button", { name: strings.submitGenerateAction }));

    await waitFor(() => expect(onUpdatePlannedAssetPrompt).toHaveBeenCalledWith(
      "character-c1",
      { prompt: "edited cinematic prompt" },
    ));
    await waitFor(() => expect(onGenerateImages).toHaveBeenCalled());
    expect(onUpdatePlannedAssetPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      onGenerateImages.mock.invocationCallOrder[0],
    );
  });

  it("pairs distinct character, scene and prop icons with text labels", () => {
    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[
          ...(project.series_bible.assets ?? []),
          { ...secondaryAsset, id: "scene-rain", kind: "scene", label: "雨巷" },
          secondaryAsset,
        ]}
      />,
    );

    expect(document.querySelector('[data-resource-kind-icon="character"]')).toBeInTheDocument();
    expect(document.querySelector('[data-resource-kind-icon="scene"]')).toBeInTheDocument();
    expect(document.querySelector('[data-resource-kind-icon="prop"]')).toBeInTheDocument();
    expect(document.querySelector('[data-resource-kind-icon="character"]')).toHaveTextContent(strings.kindLabels.character);
    expect(document.querySelector('[data-resource-kind-icon="scene"]')).toHaveTextContent(strings.kindLabels.scene);
    expect(document.querySelector('[data-resource-kind-icon="prop"]')).toHaveTextContent(strings.kindLabels.prop);
  });

  it("keeps thumbnail geometry stable across loading, video and load failure states", async () => {
    const image = mediaAsset({ id: "broken-image", label: "Broken Image", media_url: "/broken.png" });
    const video = mediaAsset({ id: "video-asset", label: "Video Asset", media_url: "/clip.webm" });
    const { container } = render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[]}
        projectId="p1"
        onListAssets={vi.fn(async () => ({ assets: [image, video], next_cursor: null }))}
      />,
    );

    await screen.findByRole("button", { name: strings.viewAsset("Broken Image") });
    expect(screen.getAllByText(strings.loadingPreview).length).toBeGreaterThan(0);
    expect(container.querySelector('video[src="/clip.webm"]')).toBeInTheDocument();
    const brokenImage = container.querySelector('img[src="/broken.png"]');
    expect(brokenImage).toBeInTheDocument();
    fireEvent.error(brokenImage!);
    expect(await screen.findByText(strings.previewFailed)).toBeInTheDocument();
    expect(container.querySelector('img[src="/broken.png"]')).not.toBeInTheDocument();
  });

  it("uses saved project generation preferences as real drawer defaults", () => {
    render(
      <ResourceLibraryPage
        {...resourceProps}
        generationPreferences={{
          image_model: "saved-image-model",
          video_model: "saved-video-model",
          image_size: "1536x1024",
          image_quality: "high",
          aspect_ratio: "16:9",
        }}
        onGenerateImages={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));

    expect(screen.getByLabelText(strings.modelLabel)).toHaveValue("saved-image-model");
    expect(screen.getByRole("button", { name: strings.sizeLabel })).toHaveTextContent(
      strings.sizeLabels["1536x1024"],
    );
    expect(screen.getByRole("button", { name: strings.qualityLabel })).toHaveTextContent(
      strings.qualityLabels.high,
    );
  });

  it("confirms dirty generation and upload drawer close attempts and reports route dirtiness", () => {
    const onDirtyChange = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <ResourceLibraryPage
        {...resourceProps}
        onDirtyChange={onDirtyChange}
        onGenerateImages={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));
    fireEvent.change(screen.getByLabelText(strings.labelLabel), { target: { value: "未保存生成" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: strings.closeGenerateAction }));
    expect(confirm).toHaveBeenCalledWith(strings.discardDrawerChanges);
    expect(screen.getByRole("dialog", { name: strings.generateDialogTitle })).toBeInTheDocument();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: strings.closeGenerateAction }));
    expect(screen.queryByRole("dialog", { name: strings.generateDialogTitle })).not.toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: strings.uploadResourceAction }));
    fireEvent.change(screen.getByLabelText(strings.descriptionLabel), { target: { value: "未保存上传" } });
    const uploadDialog = screen.getByRole("dialog", { name: strings.uploadDialogTitle });
    confirm.mockReturnValue(false);
    fireEvent.keyDown(uploadDialog, { key: "Escape" });
    expect(uploadDialog).toBeInTheDocument();
    confirm.mockReturnValue(true);
    fireEvent.keyDown(uploadDialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: strings.uploadDialogTitle })).not.toBeInTheDocument();
  });

  it("shows AI generation as the primary entry and upload as the secondary entry", () => {
    render(
      <ResourceLibraryPage
        {...resourceProps}
        onGenerateImages={vi.fn()}
      />,
    );

    const generate = screen.getByRole("button", { name: strings.generateImagesAction });
    const upload = screen.getByRole("button", { name: strings.uploadResourceAction });
    expect(generate).toHaveClass("primary-button");
    expect(upload).toHaveClass("secondary-button");

    fireEvent.click(generate);
    expect(screen.getByRole("dialog", { name: strings.generateDialogTitle })).toBeInTheDocument();
    fireEvent.click(upload);
    expect(screen.queryByRole("dialog", { name: strings.generateDialogTitle })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: strings.uploadDialogTitle })).toBeInTheDocument();
  });

  it("switches project and personal views and filters by kind, source, and searchable text", async () => {
    const projectUpload = mediaAsset({
      id: "project-upload",
      kind: "scene",
      source_type: "upload",
      label: "Uploaded Alley",
      description: "Night rain",
      prompt: "Wet pavement",
    });
    const projectAi = mediaAsset({ id: "project-ai", label: "Project AI Character" });
    const libraryAi = mediaAsset({
      id: "library-ai",
      origin_project_id: "p2",
      kind: "prop",
      label: "Library Lantern",
      description: "Weathered brass light",
      prompt: "Brass lantern on a dark table",
    });
    const onListAssets = vi.fn(async ({ scope }: { scope: "all" | "project" }) => ({
      assets: scope === "project"
        ? [projectUpload, projectAi]
        : [projectUpload, projectAi, libraryAi],
      next_cursor: null,
    }));
    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[]}
        projectId="p1"
        onListAssets={onListAssets}
      />,
    );

    expect(await screen.findByRole("button", { name: strings.viewAsset("Uploaded Alley") })).toBeInTheDocument();
    chooseSelectMenuOption(strings.sourceFilterLabel, strings.sourceLabels.ai_generated);
    expect(screen.queryByRole("button", { name: strings.viewAsset("Uploaded Alley") })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.viewAsset("Project AI Character") })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: strings.allView }));
    expect(await screen.findByRole("button", { name: strings.viewAsset("Library Lantern") })).toBeInTheDocument();
    chooseSelectMenuOption(strings.filterLabel, strings.kindLabels.prop);
    fireEvent.change(screen.getByLabelText(strings.searchLabel), { target: { value: "brass" } });
    expect(screen.getByRole("button", { name: strings.viewAsset("Library Lantern") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: strings.viewAsset("Project AI Character") })).not.toBeInTheDocument();
    expect(onListAssets).toHaveBeenCalledWith({
      scope: "project",
      project_id: "p1",
      cursor: undefined,
      limit: 100,
    });
    expect(onListAssets).toHaveBeenCalledWith({
      scope: "all",
      project_id: undefined,
      cursor: undefined,
      limit: 100,
    });
  });

  it("submits the exact generation payload and closes after the task is accepted", async () => {
    const onGenerateImages = vi.fn(async (): Promise<GenerateImagesResponse> => createAcceptedImageTask());
    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[]}
        projectId="p1"
        onGenerateImages={onGenerateImages}
        onListAssets={vi.fn(async () => ({ assets: [], next_cursor: null }))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));
    chooseSelectMenuOption(strings.kindLabel, strings.kindLabels.scene);
    fireEvent.change(screen.getByLabelText(strings.labelLabel), { target: { value: "  Rain Keyframe  " } });
    fireEvent.change(screen.getByLabelText(strings.descriptionLabel), { target: { value: "  Night alley  " } });
    fireEvent.change(screen.getByLabelText(strings.promptLabel), { target: { value: "  Wet cinematic street  " } });
    fireEvent.change(screen.getByLabelText(strings.modelLabel), { target: { value: "image-model-v2" } });
    fireEvent.change(screen.getByLabelText(strings.countLabel), { target: { value: "2" } });
    chooseSelectMenuOption(strings.sizeLabel, strings.sizeLabels["1536x1024"]);
    chooseSelectMenuOption(strings.qualityLabel, strings.qualityLabels.high);
    fireEvent.click(screen.getByRole("button", { name: strings.submitGenerateAction }));

    await waitFor(() => expect(onGenerateImages).toHaveBeenCalledWith({
      kind: "scene",
      label: "Rain Keyframe",
      description: "Night alley",
      prompt: "Wet cinematic street",
      model: "image-model-v2",
      count: 2,
      size: "1536x1024",
      quality: "high",
      resource_ids: [],
    }));
    expect(screen.queryByRole("dialog", { name: strings.generateDialogTitle })).not.toBeInTheDocument();
  });

  it("AI-optimizes an image prompt and can undo the replacement", async () => {
    const onOptimizeImagePrompt = vi.fn().mockResolvedValue({
      project_id: "p1",
      model: "gpt-5.5",
      optimized_text: "Cinematic detective portrait, neon rim light, shallow depth of field",
      notes: [],
    });
    render(
      <ResourceLibraryPage
        {...resourceProps}
        projectId="p1"
        onGenerateImages={vi.fn()}
        onOptimizeImagePrompt={onOptimizeImagePrompt}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));
    const prompt = screen.getByLabelText(strings.promptLabel);
    expect(screen.getByRole("button", { name: "AI \u4f18\u5316\u63d0\u793a\u8bcd" })).toBeDisabled();
    fireEvent.change(prompt, { target: { value: "Detective portrait" } });

    fireEvent.click(screen.getByRole("button", { name: "AI \u4f18\u5316\u63d0\u793a\u8bcd" }));

    expect(await screen.findByDisplayValue(
      "Cinematic detective portrait, neon rim light, shallow depth of field",
    )).toBeInTheDocument();
    expect(onOptimizeImagePrompt).toHaveBeenCalledWith(
      "character",
      "Detective portrait",
      undefined,
    );
    fireEvent.click(screen.getByRole("button", { name: "\u64a4\u9500\u4f18\u5316" }));
    expect(screen.getByLabelText(strings.promptLabel)).toHaveValue("Detective portrait");
  });

  it("retries unchanged prompt optimization with its payment quote", async () => {
    const onOptimizeImagePrompt = vi.fn()
      .mockRejectedValueOnce(new ApiError(402, "Payment required", "payment_required_quote", {
        billing_job_id: "c".repeat(32),
      }))
      .mockResolvedValueOnce({
        project_id: "p1",
        model: "gpt-5.5",
        optimized_text: "Optimized paid prompt",
        notes: [],
      });
    render(
      <MemoryRouter>
        <ResourceLibraryPage
          {...resourceProps}
          projectId="p1"
          onGenerateImages={vi.fn()}
          onOptimizeImagePrompt={onOptimizeImagePrompt}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));
    fireEvent.change(screen.getByLabelText(strings.promptLabel), {
      target: { value: "Paid prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "AI \u4f18\u5316\u63d0\u793a\u8bcd" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("\u4f59\u989d\u4e0d\u8db3");

    fireEvent.click(screen.getByRole("button", { name: "AI \u4f18\u5316\u63d0\u793a\u8bcd" }));

    await waitFor(() => expect(onOptimizeImagePrompt).toHaveBeenCalledTimes(2));
    expect(onOptimizeImagePrompt).toHaveBeenLastCalledWith(
      "character",
      "Paid prompt",
      "c".repeat(32),
    );
    expect(await screen.findByDisplayValue("Optimized paid prompt")).toBeInTheDocument();
  });

  it("starts a new optimization quote when the resource type changes", async () => {
    const onOptimizeImagePrompt = vi.fn()
      .mockRejectedValueOnce(new ApiError(402, "Payment required", "payment_required_quote", {
        billing_job_id: "d".repeat(32),
      }))
      .mockResolvedValueOnce({
        project_id: "p1",
        model: "gpt-5.5",
        optimized_text: "Prop turnaround sheet",
        notes: [],
      });
    render(
      <MemoryRouter>
        <ResourceLibraryPage
          {...resourceProps}
          projectId="p1"
          onGenerateImages={vi.fn()}
          onOptimizeImagePrompt={onOptimizeImagePrompt}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));
    fireEvent.change(screen.getByLabelText(strings.promptLabel), {
      target: { value: "Evidence envelope" },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.optimizePromptAction }));
    expect(await screen.findByRole("alert")).toHaveTextContent("\u4f59\u989d\u4e0d\u8db3");

    chooseSelectMenuOption(strings.kindLabel, strings.kindLabels.prop);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: strings.optimizePromptAction }));

    await waitFor(() => expect(onOptimizeImagePrompt).toHaveBeenCalledTimes(2));
    expect(onOptimizeImagePrompt).toHaveBeenLastCalledWith(
      "prop",
      "Evidence envelope",
      undefined,
    );
  });

  it("locks generation fields and closing while prompt optimization is pending", async () => {
    const deferred = createDeferred<{
      project_id: string;
      model: string;
      optimized_text: string;
      notes: string[];
    }>();
    const onOptimizeImagePrompt = vi.fn().mockReturnValue(deferred.promise);
    render(
      <ResourceLibraryPage
        {...resourceProps}
        projectId="p1"
        onGenerateImages={vi.fn()}
        onOptimizeImagePrompt={onOptimizeImagePrompt}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));
    fireEvent.change(screen.getByLabelText(strings.promptLabel), {
      target: { value: "Rainy alley" },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.optimizePromptAction }));

    await waitFor(() => expect(onOptimizeImagePrompt).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText(strings.kindLabel)).toBeDisabled();
    expect(screen.getByLabelText(strings.promptLabel)).toBeDisabled();
    expect(screen.getByRole("button", { name: strings.closeGenerateAction })).toBeDisabled();
    expect(screen.getByRole("button", { name: strings.submitGenerateAction })).toBeDisabled();

    await act(async () => deferred.resolve({
      project_id: "p1",
      model: "gpt-5.5",
      optimized_text: "Four-angle rainy alley continuity board",
      notes: [],
    }));
    expect(await screen.findByDisplayValue("Four-angle rainy alley continuity board")).toBeEnabled();
  });

  it("restores generated assets through GET whenever the resource page is re-entered", async () => {
    const restored = mediaAsset({ id: "restored-ai", label: "Restored AI Asset" });
    const onListAssets = vi.fn(async () => ({ assets: [restored], next_cursor: null }));
    const first = render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[]}
        projectId="p1"
        onListAssets={onListAssets}
      />,
    );
    expect(await screen.findByRole("button", { name: strings.viewAsset("Restored AI Asset") })).toBeInTheDocument();
    first.unmount();

    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[]}
        projectId="p1"
        onListAssets={onListAssets}
      />,
    );
    expect(await screen.findByRole("button", { name: strings.viewAsset("Restored AI Asset") })).toBeInTheDocument();
    expect(onListAssets).toHaveBeenCalledTimes(2);
  });

  it("keeps generation values and the drawer open after a failed request", async () => {
    const onGenerateImages = vi.fn().mockRejectedValue(new Error("Generation rejected"));
    render(<ResourceLibraryPage {...resourceProps} onGenerateImages={onGenerateImages} />);
    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));
    fireEvent.change(screen.getByLabelText(strings.labelLabel), { target: { value: "Kept name" } });
    fireEvent.change(screen.getByLabelText(strings.promptLabel), { target: { value: "Kept prompt" } });
    fireEvent.click(screen.getByRole("button", { name: strings.submitGenerateAction }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Generation rejected");
    expect(screen.getByRole("dialog", { name: strings.generateDialogTitle })).toBeInTheDocument();
    expect(screen.getByLabelText(strings.labelLabel)).toHaveValue("Kept name");
    expect(screen.getByLabelText(strings.promptLabel)).toHaveValue("Kept prompt");
  });

  it("uses the existing payment-required wallet recovery notice for AI generation", async () => {
    const onGenerateImages = vi.fn().mockRejectedValue(
      new ApiError(402, "Payment required", "payment_required_quote", {
        billing_job_id: "b".repeat(32),
      }),
    );
    render(
      <MemoryRouter>
        <ResourceLibraryPage
          {...resourceProps}
          onGenerateImages={onGenerateImages}
          walletAvailableUnits={800_000}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));
    fireEvent.change(screen.getByLabelText(strings.labelLabel), { target: { value: "Paid image" } });
    fireEvent.change(screen.getByLabelText(strings.promptLabel), { target: { value: "Premium prompt" } });
    fireEvent.click(screen.getByRole("button", { name: strings.submitGenerateAction }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("\u4f59\u989d\u4e0d\u8db3");
    expect(alert).toHaveTextContent("¥0.80");
    expect(within(alert).getByRole("link")).toHaveAttribute("href", "/wallet");
    expect(within(alert).getByRole("link")).toHaveAttribute("target", "_blank");
    expect(screen.getByLabelText(strings.promptLabel)).toHaveValue("Premium prompt");
  });

  it("retries an unchanged image request with the original payment quote", async () => {
    const generated = mediaAsset({ id: "paid-image", label: "Paid image" });
    const onGenerateImages = vi.fn()
      .mockRejectedValueOnce(new ApiError(402, "Payment required", "payment_required_quote", {
        billing_job_id: "b".repeat(32),
      }))
      .mockResolvedValueOnce(createAcceptedImageTask("paid-task"));
    render(
      <MemoryRouter>
        <ResourceLibraryPage {...resourceProps} onGenerateImages={onGenerateImages} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));
    fireEvent.change(screen.getByLabelText(strings.labelLabel), { target: { value: "Paid image" } });
    fireEvent.change(screen.getByLabelText(strings.promptLabel), { target: { value: "Premium prompt" } });
    fireEvent.click(screen.getByRole("button", { name: strings.submitGenerateAction }));
    expect(await screen.findByRole("alert")).toHaveTextContent("\u4f59\u989d\u4e0d\u8db3");

    fireEvent.click(screen.getByRole("button", { name: strings.submitGenerateAction }));

    await waitFor(() => expect(onGenerateImages).toHaveBeenCalledTimes(2));
    expect(onGenerateImages).toHaveBeenLastCalledWith(expect.objectContaining({
      billing_job_id: "b".repeat(32),
      label: "Paid image",
      prompt: "Premium prompt",
    }));
    expect(screen.queryByRole("dialog", { name: strings.generateDialogTitle })).not.toBeInTheDocument();
  });

  it("starts a new image quote when generation inputs change after payment is required", async () => {
    const onGenerateImages = vi.fn()
      .mockRejectedValueOnce(new ApiError(402, "Payment required", "payment_required_quote", {
        billing_job_id: "b".repeat(32),
      }))
      .mockResolvedValueOnce(createAcceptedImageTask("new-task"));
    render(
      <MemoryRouter>
        <ResourceLibraryPage {...resourceProps} onGenerateImages={onGenerateImages} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));
    fireEvent.change(screen.getByLabelText(strings.labelLabel), { target: { value: "Changed image" } });
    fireEvent.change(screen.getByLabelText(strings.promptLabel), { target: { value: "Original prompt" } });
    fireEvent.click(screen.getByRole("button", { name: strings.submitGenerateAction }));
    expect(await screen.findByRole("alert")).toHaveTextContent("\u4f59\u989d\u4e0d\u8db3");

    fireEvent.change(screen.getByLabelText(strings.promptLabel), { target: { value: "Changed prompt" } });
    fireEvent.click(screen.getByRole("button", { name: strings.submitGenerateAction }));

    await waitFor(() => expect(onGenerateImages).toHaveBeenCalledTimes(2));
    expect(onGenerateImages).toHaveBeenLastCalledWith({
      kind: "character",
      label: "Changed image",
      description: "",
      prompt: "Changed prompt",
      model: "gpt-image-2",
      count: 1,
      size: "1024x1024",
      quality: "standard",
      resource_ids: [],
    });
  });

  it("does not carry a payment quote into another project", async () => {
    const onGenerateImages = vi.fn()
      .mockRejectedValueOnce(new ApiError(402, "Payment required", "payment_required_quote", {
        billing_job_id: "b".repeat(32),
      }))
      .mockResolvedValueOnce(createAcceptedImageTask("new-project-task"));
    const rendered = render(
      <MemoryRouter>
        <ResourceLibraryPage
          {...resourceProps}
          projectId="project-one"
          onGenerateImages={onGenerateImages}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));
    fireEvent.change(screen.getByLabelText(strings.labelLabel), { target: { value: "Project image" } });
    fireEvent.change(screen.getByLabelText(strings.promptLabel), { target: { value: "Shared prompt" } });
    fireEvent.click(screen.getByRole("button", { name: strings.submitGenerateAction }));
    expect(await screen.findByRole("alert")).toHaveTextContent("\u4f59\u989d\u4e0d\u8db3");

    rendered.rerender(
      <MemoryRouter>
        <ResourceLibraryPage
          {...resourceProps}
          projectId="project-two"
          onGenerateImages={onGenerateImages}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: strings.submitGenerateAction }));

    await waitFor(() => expect(onGenerateImages).toHaveBeenCalledTimes(2));
    expect(onGenerateImages).toHaveBeenLastCalledWith({
      kind: "character",
      label: "Project image",
      description: "",
      prompt: "Shared prompt",
      model: "gpt-image-2",
      count: 1,
      size: "1024x1024",
      quality: "standard",
      resource_ids: [],
    });
  });

  it("adds a personal resource to the project and then enables shot binding", async () => {
    const libraryAsset = mediaAsset({
      id: "library-character",
      origin_project_id: "p2",
      label: "Shared Character",
    });
    const onListAssets = vi.fn(async ({ scope }: { scope: "all" | "project" }) => ({
      assets: scope === "all" ? [libraryAsset] : [],
      next_cursor: null,
    }));
    const onAddAssetToProject = vi.fn(async () => ({
      asset: {
        id: libraryAsset.id,
        kind: libraryAsset.kind,
        label: libraryAsset.label,
        description: libraryAsset.description,
        prompt: libraryAsset.prompt,
        reference_images: [libraryAsset.media_url],
        media_urls: [],
      },
      library_asset: libraryAsset,
    }));
    const onBindAsset = vi.fn().mockResolvedValue(undefined);
    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[]}
        projectId="p1"
        onAddAssetToProject={onAddAssetToProject}
        onBindAsset={onBindAsset}
        onListAssets={onListAssets}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.allView }));
    await screen.findByRole("button", { name: strings.viewAsset("Shared Character") });
    fireEvent.click(screen.getByRole("button", { name: strings.addToProjectAction }));
    await waitFor(() => expect(onAddAssetToProject).toHaveBeenCalledWith("library-character"));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: strings.addToProjectAction })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: strings.viewAsset("Shared Character") }));
    const bind = screen.getByRole("button", { name: strings.bindAction });
    expect(bind).toBeEnabled();
    fireEvent.click(bind);
    await waitFor(() => expect(onBindAsset).toHaveBeenCalledWith(
      "shot-1",
      "library-character",
      true,
    ));
  });

  it("never renders broken media for missing assets and disables add and bind", async () => {
    const missing = mediaAsset({
      id: "missing-library-asset",
      origin_project_id: "p2",
      label: "Missing Library Asset",
      media_url: "/broken-file.png",
      status: "missing",
    });
    const onListAssets = vi.fn(async ({ scope }: { scope: "all" | "project" }) => ({
      assets: scope === "all" ? [missing] : [],
      next_cursor: null,
    }));
    const { container } = render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[]}
        projectId="p1"
        onAddAssetToProject={vi.fn()}
        onListAssets={onListAssets}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.allView }));
    const preview = await screen.findByRole("button", { name: strings.viewAsset("Missing Library Asset") });
    expect(screen.getByText(strings.fileMissing)).toBeInTheDocument();
    expect(container.querySelector('img[src="/broken-file.png"]')).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: strings.addToProjectAction })).toBeDisabled();

    fireEvent.click(preview);
    expect(screen.getByRole("button", { name: strings.bindAction })).toBeDisabled();
    expect(screen.getAllByText(strings.fileMissing).length).toBeGreaterThan(0);
  });

  it("locks every resource transition while AI generation is pending", async () => {
    const pending = createDeferred<GenerateImagesResponse>();
    const onGenerateImages = vi.fn().mockReturnValue(pending.promise);
    render(<ResourceLibraryPage {...resourceProps} onGenerateImages={onGenerateImages} />);
    fireEvent.click(screen.getByRole("button", { name: strings.generateImagesAction }));
    fireEvent.change(screen.getByLabelText(strings.labelLabel), { target: { value: "Pending image" } });
    fireEvent.change(screen.getByLabelText(strings.promptLabel), { target: { value: "Pending prompt" } });
    fireEvent.click(screen.getByRole("button", { name: strings.submitGenerateAction }));

    const dialog = screen.getByRole("dialog", { name: strings.generateDialogTitle });
    expect(screen.getByRole("button", { name: strings.generatingImagesAction })).toBeDisabled();
    expect(screen.getByRole("button", { name: strings.uploadResourceAction })).toBeEnabled();
    expect(screen.getByRole("button", { name: strings.allView })).toBeEnabled();
    expect(screen.getByRole("button", { name: strings.closeGenerateAction })).toBeDisabled();
    expect(screen.getByRole("button", { name: strings.viewAsset("\u739b\u62c9") })).toBeEnabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).toBeInTheDocument();

    pending.resolve(createAcceptedImageTask("pending-task"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: strings.generateDialogTitle })).not.toBeInTheDocument();
    });
  });

  it("keeps all resource controls and drawers within the mobile viewport", () => {
    const responsive = readFileSync("src/styles/responsive.css", "utf8");
    const pageStyles = readFileSync("src/styles/pages.css", "utf8");

    expect(responsive).toMatch(/dialog\[aria-labelledby="resource-generate-title"\][\s\S]*max-width:\s*100vw/);
    expect(responsive).toMatch(/\.resource-library-actions\s*\{[\s\S]*width:\s*100%/);
    expect(responsive).toMatch(/\.resource-generation-options\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(pageStyles).toMatch(/\.resource-results\s*\{[\s\S]*min-width:\s*0/);
  });

  it("supports single, multi, select-all, and deselect-all generation", async () => {
    const onGenerateImages = vi.fn(async () => createAcceptedImageTask("batch-task"));
    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[...resourceProps.assets, secondaryAsset]}
        projectId="p1"
        onGenerateImages={onGenerateImages}
      />,
    );

    fireEvent.click(screen.getByLabelText(strings.selectResource("\u739b\u62c9")));
    expect(screen.getByText(strings.selectedResourceCount(1))).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(strings.selectResource("\u4fe1\u5c01")));
    expect(screen.getByText(strings.selectedResourceCount(2))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(strings.batchModelLabel), {
      target: { value: "image-model-v2" },
    });
    fireEvent.click(screen.getByRole("button", { name: strings.generateSelectedAction }));

    await waitFor(() => expect(onGenerateImages).toHaveBeenCalledWith(expect.objectContaining({
      count: 1,
      model: "image-model-v2",
      resource_ids: ["asset-char-1", "prop-envelope"],
    })));
    fireEvent.click(screen.getByLabelText(strings.selectAllAction));
    expect(screen.getByText(strings.selectedResourceCount(2))).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(strings.deselectAllAction));
    expect(screen.getByText(strings.selectedResourceCount(0))).toBeInTheDocument();
  });

  it("restores per-resource task state and does not lock unrelated resource controls", async () => {
    const accepted = createAcceptedImageTask("running-task", "asset-char-1");
    accepted.task.status = "running";
    accepted.task.items![0].status = "running";
    accepted.task.items![0].progress = 40;
    const onListTasks = vi.fn(async () => ({ tasks: [accepted.task] }));
    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[...resourceProps.assets, secondaryAsset]}
        projectId="p1"
        onListTasks={onListTasks}
      />,
    );

    expect(await screen.findByText(strings.taskStatusLabels.running)).toBeInTheDocument();
    expect(screen.getByLabelText(strings.selectResource("\u739b\u62c9"))).toBeDisabled();
    expect(screen.getByLabelText(strings.selectResource("\u4fe1\u5c01"))).toBeEnabled();
    expect(screen.getByRole("button", { name: strings.viewAsset("\u4fe1\u5c01") })).toBeEnabled();
    expect(screen.getByRole("button", { name: strings.uploadResourceAction })).toBeEnabled();
    expect(screen.getByLabelText(strings.filterLabel)).toBeEnabled();
    expect(screen.getByLabelText(strings.sourceFilterLabel)).toBeEnabled();
    expect(screen.getByLabelText(strings.searchLabel)).toBeEnabled();
    expect(onListTasks).toHaveBeenCalled();
  });

  it("retries only the failed resource item and refreshes tasks after an SSE event", async () => {
    const failed = createAcceptedImageTask("failed-task", "asset-char-1");
    failed.task.status = "failed";
    failed.task.items![0].status = "failed";
    const retried = createAcceptedImageTask("failed-task", "asset-char-1").task;
    const onListTasks = vi.fn(async () => ({ tasks: [failed.task] }));
    const onRetryTaskItem = vi.fn(async () => retried);
    const onListAssets = vi.fn(async () => ({ assets: [], next_cursor: null }));
    const rendered = render(
      <ResourceLibraryPage
        {...resourceProps}
        projectId="p1"
        onListAssets={onListAssets}
        onListTasks={onListTasks}
        onRetryTaskItem={onRetryTaskItem}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: strings.retryResourceAction }));
    await waitFor(() => expect(onRetryTaskItem).toHaveBeenCalledWith("failed-task", "failed-task-item"));

    rendered.rerender(
      <ResourceLibraryPage
        {...resourceProps}
        projectId="p1"
        onListAssets={onListAssets}
        onListTasks={onListTasks}
        onRetryTaskItem={onRetryTaskItem}
        taskEvents={[{
          id: "event-1",
          job_id: "failed-task",
          project_id: "p1",
          stage: "task_item",
          status: "complete",
          message: "complete",
          created_at: "2026-07-21T00:00:00Z",
        }]}
      />,
    );
    await waitFor(() => expect(onListTasks).toHaveBeenCalledTimes(2));
    expect(onListAssets).toHaveBeenCalled();
  });

  it("never shows asset detail and upload drawers at the same time", () => {
    render(<ResourceLibraryPage {...resourceProps} />);
    const asset = screen.getByRole("button", { name: "查看资源 玛拉" });
    expect(asset.closest(".resource-layout")).toBeInTheDocument();
    expect(asset.closest(".asset-grid")).toBeInTheDocument();
    fireEvent.click(asset);
    const detail = screen.getByRole("dialog", { name: "资源详情" });
    expect(detail).toBeInTheDocument();
    expect(detail).toHaveAttribute("aria-modal", "true");
    fireEvent.click(screen.getByRole("button", { name: "上传资源" }));
    expect(screen.queryByRole("dialog", { name: "资源详情" })).not.toBeInTheDocument();
    const upload = screen.getByRole("dialog", { name: "上传资源" });
    expect(upload).toBeInTheDocument();
    expect(upload).toHaveAttribute("aria-modal", "true");
  });

  it("manages initial focus, Escape and opener focus for both resource drawers", async () => {
    render(<ResourceLibraryPage {...resourceProps} />);

    const assetOpener = screen.getByRole("button", { name: "查看资源 玛拉" });
    fireEvent.click(assetOpener);
    const detail = screen.getByRole("dialog", { name: "资源详情" });
    const closeDetail = within(detail).getByRole("button", { name: "关闭资源详情" });
    expect(closeDetail).toHaveAttribute("title", "关闭资源详情");
    await waitFor(() => expect(closeDetail).toHaveFocus());
    const detailButtons = within(detail).getAllByRole("button");
    const lastDetailButton = detailButtons[detailButtons.length - 1];
    lastDetailButton.focus();
    fireEvent.keyDown(detail, { key: "Tab" });
    expect(closeDetail).toHaveFocus();
    fireEvent.keyDown(detail, { key: "Tab", shiftKey: true });
    expect(lastDetailButton).toHaveFocus();

    fireEvent.keyDown(detail, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "资源详情" })).not.toBeInTheDocument();
    await waitFor(() => expect(assetOpener).toHaveFocus());

    const uploadOpener = screen.getByRole("button", { name: "上传资源" });
    fireEvent.click(uploadOpener);
    const upload = screen.getByRole("dialog", { name: "上传资源" });
    const closeUpload = within(upload).getByRole("button", { name: "关闭上传资源" });
    expect(closeUpload).toHaveAttribute("title", "关闭上传资源");
    await waitFor(() => expect(closeUpload).toHaveFocus());
    const lastUploadControl = within(upload).getByLabelText("参考图");
    lastUploadControl.focus();
    fireEvent.keyDown(upload, { key: "Tab" });
    expect(closeUpload).toHaveFocus();
    fireEvent.keyDown(upload, { key: "Tab", shiftKey: true });
    expect(lastUploadControl).toHaveFocus();

    fireEvent.keyDown(upload, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "上传资源" })).not.toBeInTheDocument();
    await waitFor(() => expect(uploadOpener).toHaveFocus());
  });

  it("binds the selected resource through the current shot save contract", async () => {
    const onBindAsset = vi.fn().mockResolvedValue(undefined);
    const originalShotIds = resourceProps.assets[0].shot_ids;
    render(
      <ResourceLibraryPage
        {...resourceProps}
        currentShotId="shot-1"
        onBindAsset={onBindAsset}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));
    fireEvent.click(screen.getByRole("button", { name: "绑定到当前分镜" }));

    await waitFor(() => {
      expect(onBindAsset).toHaveBeenCalledWith("shot-1", "asset-char-1", true);
    });
    expect(resourceProps.assets[0].shot_ids).toBe(originalShotIds);
  });

  it("unbinds an asset already linked to the current shot", async () => {
    const onBindAsset = vi.fn().mockResolvedValue(undefined);
    const shots = resourceProps.shots.map((shot) => (
      shot.id === "shot-1" ? { ...shot, asset_ids: ["asset-char-1"] } : shot
    ));
    render(<ResourceLibraryPage {...resourceProps} shots={shots} onBindAsset={onBindAsset} />);
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));
    fireEvent.click(screen.getByRole("button", { name: "从当前分镜解绑" }));

    await waitFor(() => {
      expect(onBindAsset).toHaveBeenCalledWith("shot-1", "asset-char-1", false);
    });
  });

  it("disables binding when there is no current shot", () => {
    const onBindAsset = vi.fn().mockResolvedValue(undefined);
    render(
      <ResourceLibraryPage
        {...resourceProps}
        currentShotId={null}
        onBindAsset={onBindAsset}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));

    expect(screen.getByRole("button", { name: "绑定到当前分镜" })).toBeDisabled();
    expect(onBindAsset).not.toHaveBeenCalled();
  });

  it("keeps detail open and reports a binding failure after clearing its busy state", async () => {
    const deferred = createDeferred();
    const onBindAsset = vi.fn().mockReturnValue(deferred.promise);
    render(<ResourceLibraryPage {...resourceProps} onBindAsset={onBindAsset} />);
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));
    fireEvent.click(screen.getByRole("button", { name: "绑定到当前分镜" }));

    expect(screen.getByRole("button", { name: "正在更新绑定" })).toBeDisabled();
    deferred.reject(new Error("绑定请求被拒绝"));

    expect(await screen.findByRole("alert")).toHaveTextContent("绑定请求被拒绝");
    expect(screen.getByRole("dialog", { name: "资源详情" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "绑定到当前分镜" })).toBeEnabled();
  });

  it("keeps a pending unbind anchored to its asset and gates every panel transition", async () => {
    const deferred = createDeferred();
    const onBindAsset = vi.fn().mockReturnValue(deferred.promise);
    const shots = resourceProps.shots.map((shot) => (
      shot.id === "shot-1" ? { ...shot, asset_ids: ["asset-char-1"] } : shot
    ));
    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[...resourceProps.assets, secondaryAsset]}
        shots={shots}
        onBindAsset={onBindAsset}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));
    fireEvent.click(screen.getByRole("button", { name: "从当前分镜解绑" }));

    expect(onBindAsset).toHaveBeenCalledWith("shot-1", "asset-char-1", false);
    expect(screen.getByRole("button", { name: "正在更新绑定" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在更新绑定" })).toHaveClass("async-action");
    const otherAsset = screen.getByRole("button", { name: "查看资源 信封" });
    const upload = screen.getByRole("button", { name: "上传资源" });
    const close = screen.getByRole("button", { name: "关闭资源详情" });
    expect(otherAsset).toBeDisabled();
    expect(upload).toBeDisabled();
    expect(close).toBeDisabled();

    fireEvent.click(otherAsset);
    fireEvent.click(upload);
    fireEvent.click(close);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "资源详情" }), { key: "Escape" });
    const detail = screen.getByRole("dialog", { name: "资源详情" });
    expect(within(detail).getByRole("heading", { name: "玛拉" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "上传资源" })).not.toBeInTheDocument();

    deferred.reject(new Error("解绑请求被拒绝"));

    expect(await screen.findByRole("alert")).toHaveTextContent("解绑请求被拒绝");
    expect(within(screen.getByRole("dialog", { name: "资源详情" })).getByRole("heading", { name: "玛拉" })).toBeInTheDocument();
    await waitFor(() => {
      expect(otherAsset).toBeEnabled();
      expect(upload).toBeEnabled();
      expect(close).toBeEnabled();
    });
  });

  it("renders all resource media and only consistency issues for linked shots", () => {
    const asset: AssetRecord = {
      ...resourceProps.assets[0],
      prompt: "红色风衣，短发，冷色写实",
      reference_images: ["/refs/mara-front.png", "/refs/mara-profile.png"],
      media_urls: ["/media/mara-turnaround.mp4", "/media/mara-poster.webp"],
    };
    const shots = resourceProps.shots.map((shot) => (
      shot.id === "shot-1" ? { ...shot, asset_ids: [asset.id, asset.id] } : shot
    ));
    const consistencyReport = {
      score: 60,
      issues: [
        { shot_id: "shot-1", severity: "warning" as const, code: "wardrobe", message: "风衣颜色不一致" },
        { shot_id: "shot-2", severity: "error" as const, code: "lighting", message: "未关联分镜问题" },
        { shot_id: null, severity: "info" as const, code: "project", message: "项目级提示" },
      ],
    };
    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[asset]}
        shots={shots}
        consistencyReport={consistencyReport}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));
    const detail = screen.getByRole("dialog", { name: "资源详情" });

    expect(screen.getByText("红色风衣，短发，冷色写实")).toBeInTheDocument();
    expect(within(detail).getByText("已关联 1 个分镜")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "玛拉 参考图 1" })).toHaveAttribute("src", "/refs/mara-front.png");
    expect(screen.getByRole("img", { name: "玛拉 参考图 2" })).toHaveAttribute("src", "/refs/mara-profile.png");
    expect(screen.getByLabelText("玛拉 媒体 1")).toHaveAttribute("src", "/media/mara-turnaround.mp4");
    expect(screen.getByRole("img", { name: "玛拉 媒体 2" })).toHaveAttribute("src", "/media/mara-poster.webp");
    expect(screen.getByText("风衣颜色不一致")).toBeInTheDocument();
    expect(screen.queryByText("未关联分镜问题")).not.toBeInTheDocument();
    expect(screen.queryByText("项目级提示")).not.toBeInTheDocument();
  });

  it("does not render a consistency section without issues for linked shots", () => {
    render(
      <ResourceLibraryPage
        {...resourceProps}
        consistencyReport={{
          score: 80,
          issues: [{ shot_id: "shot-2", severity: "warning", code: "other", message: "其他分镜" }],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));

    expect(screen.queryByRole("heading", { name: "相关一致性问题" })).not.toBeInTheDocument();
  });

  it("offers only character, scene and prop upload types and requires a file", () => {
    const onUploadReferenceImage = vi.fn().mockResolvedValue(undefined);
    render(
      <ResourceLibraryPage
        {...resourceProps}
        onUploadReferenceImage={onUploadReferenceImage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上传资源" }));

    expect(selectMenuOptions("资源类型")).toEqual(["角色", "场景", "道具"]);
    expect(screen.getByRole("button", { name: "提交上传" })).toBeDisabled();
    expect(onUploadReferenceImage).not.toHaveBeenCalled();
  });

  it("submits the exact trimmed reference image upload payload", async () => {
    const onUploadReferenceImage = vi.fn().mockResolvedValue(undefined);
    const file = new File(["rain"], "rain.webp", { type: "image/webp" });
    render(
      <ResourceLibraryPage
        {...resourceProps}
        onUploadReferenceImage={onUploadReferenceImage}
      />,
    );
    const opener = screen.getByRole("button", { name: "上传资源" });
    fireEvent.click(opener);
    chooseSelectMenuOption("资源类型", "场景");
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "  雨巷  " } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "  夜雨旧城  " } });
    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "  冷色石板路  " } });
    fireEvent.change(screen.getByLabelText("参考图"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "提交上传" }));

    await waitFor(() => {
      expect(onUploadReferenceImage).toHaveBeenCalledWith({
        kind: "scene",
        label: "雨巷",
        description: "夜雨旧城",
        prompt: "冷色石板路",
        file,
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "上传资源" })).not.toBeInTheDocument();
    });
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("retains the upload panel and form values when upload rejects", async () => {
    const onUploadReferenceImage = vi.fn().mockRejectedValue(new Error("上传请求被拒绝"));
    const file = new File(["mara"], "mara.png", { type: "image/png" });
    render(
      <ResourceLibraryPage
        {...resourceProps}
        onUploadReferenceImage={onUploadReferenceImage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上传资源" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "保留的名称" } });
    fireEvent.change(screen.getByLabelText("参考图"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "提交上传" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("上传请求被拒绝");
    expect(screen.getByRole("dialog", { name: "上传资源" })).toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toHaveValue("保留的名称");
    expect(screen.getByRole("button", { name: "提交上传" })).toBeEnabled();
  });

  it("keeps a pending upload mounted and gates every panel transition", async () => {
    const deferred = createDeferred();
    const onUploadReferenceImage = vi.fn().mockReturnValue(deferred.promise);
    const file = new File(["rain"], "rain.webp", { type: "image/webp" });
    render(
      <ResourceLibraryPage
        {...resourceProps}
        assets={[...resourceProps.assets, secondaryAsset]}
        onUploadReferenceImage={onUploadReferenceImage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上传资源" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "保留的雨巷" } });
    fireEvent.change(screen.getByLabelText("描述"), { target: { value: "保留的描述" } });
    fireEvent.change(screen.getByLabelText("参考图"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "提交上传" }));

    expect(onUploadReferenceImage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "正在上传" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在上传" })).toHaveClass("async-action");
    const otherAsset = screen.getByRole("button", { name: "查看资源 信封" });
    const upload = screen.getByRole("button", { name: "上传资源" });
    const close = screen.getByRole("button", { name: "关闭上传资源" });
    expect(otherAsset).toBeDisabled();
    expect(upload).toBeDisabled();
    expect(close).toBeDisabled();

    fireEvent.click(otherAsset);
    fireEvent.click(upload);
    fireEvent.click(close);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "上传资源" }), { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "上传资源" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "资源详情" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toHaveValue("保留的雨巷");

    deferred.reject(new Error("延迟上传被拒绝"));

    expect(await screen.findByRole("alert")).toHaveTextContent("延迟上传被拒绝");
    expect(screen.getByRole("dialog", { name: "上传资源" })).toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toHaveValue("保留的雨巷");
    expect(screen.getByLabelText("描述")).toHaveValue("保留的描述");
    await waitFor(() => {
      expect(otherAsset).toBeEnabled();
      expect(upload).toBeEnabled();
      expect(close).toBeEnabled();
    });
  });

  it("honors the externally supplied uploading busy state", () => {
    const { rerender } = render(<ResourceLibraryPage {...resourceProps} uploading={false} />);
    fireEvent.click(screen.getByRole("button", { name: "上传资源" }));
    rerender(<ResourceLibraryPage {...resourceProps} uploading />);

    expect(screen.getByRole("button", { name: "正在上传" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭上传资源" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "上传资源" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "查看资源 玛拉" })).toBeDisabled();
  });

  it("does not surface a malformed unsupported resource kind", () => {
    const malformedAsset = {
      id: "audio-rain",
      kind: "audio",
      label: "雨声音效",
      reference_images: [],
    } as unknown as AssetRecord;
    render(<ResourceLibraryPage {...resourceProps} assets={[...resourceProps.assets, malformedAsset]} />);

    expect(screen.queryByRole("button", { name: "查看资源 雨声音效" })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("资源筛选")).queryByRole("option", { name: "音频" })).not.toBeInTheDocument();
  });
});
