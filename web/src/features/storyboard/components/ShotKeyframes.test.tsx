import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AssetRecord,
  GenerateImagesResponse,
  JobEvent,
  ReferenceImageUploadResponse,
  Shot,
  TaskBatch,
} from "../../../domain/types";
import { getStrings } from "../../../i18n";
import { createAcceptedImageTask, createShot } from "../../../test/fixtures";
import { fieldsFromShot, type ShotDraftFields } from "../model/shotDraft";
import { ShotKeyframes } from "./ShotKeyframes";
import { chooseSelectMenuOption } from "../../../test/selectMenu";

afterEach(cleanup);

const assets: AssetRecord[] = [
  {
    id: "user-frame",
    kind: "scene",
    label: "User frame",
    reference_images: ["/user.png"],
    source_type: "upload",
    status: "ready",
  },
  {
    id: "tail-frame",
    kind: "scene",
    label: "Tail frame",
    reference_images: ["/tail.png"],
    source_type: "video_frame",
    status: "ready",
  },
  {
    id: "ai-frame",
    kind: "scene",
    label: "AI frame",
    reference_images: ["/ai.png"],
    source_type: "ai_generated",
    status: "ready",
  },
];

function shot(overrides: Partial<Shot> = {}): Shot {
  return createShot({
    continuity: {
      mode: "carry",
      inherit_previous_tail: true,
      explicit_user_first_frame_asset_id: "user-frame",
      inherited_first_frame_asset_id: "tail-frame",
      last_frame_asset_id: null,
      first_frame: {
        asset_id: "user-frame",
        version: 1,
        status: "ready",
        source: "user",
      },
      last_frame: null,
      stale: false,
    },
    ...overrides,
  });
}

function Harness({
  aspectRatio = "16:9",
  initialShot = shot(),
  onGenerate,
  onListTasks,
  onRetryTaskItem,
  onUpload,
  taskEvents,
}: {
  aspectRatio?: string | null;
  initialShot?: Shot;
  onGenerate?: ComponentProps<typeof ShotKeyframes>["onGenerate"];
  onListTasks?: ComponentProps<typeof ShotKeyframes>["onListTasks"];
  onRetryTaskItem?: ComponentProps<typeof ShotKeyframes>["onRetryTaskItem"];
  onUpload?: (payload: Parameters<NonNullable<ComponentProps<typeof ShotKeyframes>["onUpload"]>>[0]) => Promise<ReferenceImageUploadResponse>;
  taskEvents?: JobEvent[];
}) {
  const [draft, setDraft] = useState<ShotDraftFields>(() => fieldsFromShot(initialShot));
  return (
    <MemoryRouter>
      <ShotKeyframes
        assets={assets}
        busy={false}
        draft={draft}
        projectAspectRatio={aspectRatio}
        projectId="p1"
        shot={initialShot}
        strings={getStrings("zh").shotEditor}
        onGenerate={onGenerate}
        onListTasks={onListTasks}
        onRetryTaskItem={onRetryTaskItem}
        onUpload={onUpload}
        taskEvents={taskEvents}
        updateDraft={(update) => setDraft((current) => update(current))}
      />
    </MemoryRouter>
  );
}

function generatedResponse(id: string, target: "first" | "last" = "first"): GenerateImagesResponse {
  const response = createAcceptedImageTask(`job-${id}`);
  const item = response.task.items![0];
  item.target_entity_type = "shot_frame";
  item.target_entity_id = "shot-1";
  item.target_entity_version = 1;
  item.input = { shot_id: "shot-1", frame_target: target };
  return response;
}

function completedFrameTask(target: "first" | "last", assetId: string): TaskBatch {
  const response = generatedResponse(`${target}-complete`, target);
  response.task.status = "complete";
  response.task.progress = 100;
  response.task.completed_items = 1;
  const item = response.task.items![0];
  item.status = "complete";
  item.progress = 100;
  item.result = {
    frame_target: target,
    published_assets: [{
      id: assetId,
      kind: "scene",
      label: `${target} frame`,
      reference_images: [`/${assetId}.png`],
      media_urls: [`/api/projects/p1/media/${assetId}.png`],
      media_url: `/api/projects/p1/media/${assetId}.png`,
      source_type: "ai_generated",
      status: "ready",
    }],
  };
  return response.task;
}

function uploadResponse(): ReferenceImageUploadResponse {
  return {
    media: {
      path: "assets/images/scene/upload.png",
      media_url: "/upload.png",
      filename: "upload.png",
      content_type: "image/png",
    },
    asset: {
      id: "uploaded-frame",
      kind: "scene",
      label: "Uploaded frame",
      reference_images: ["/upload.png"],
    },
    library_asset: {
      id: "uploaded-frame",
      origin_project_id: "p1",
      kind: "scene",
      source_type: "upload",
      label: "Uploaded frame",
      description: "",
      prompt: "",
      model: null,
      generation_job_id: null,
      media_url: "/upload.png",
      status: "ready",
      created_at: "2026-07-20T00:00:00Z",
    },
  };
}

describe("ShotKeyframes", () => {
  it("shows the explicit user frame first and falls back to inherited tail after removal", async () => {
    render(<Harness />);

    expect(screen.getByText("用户图片")).toBeInTheDocument();
    expect(screen.getAllByRole("img")[0]).toHaveAttribute("src", "/user.png");

    fireEvent.click(screen.getByRole("button", { name: "移除显式首帧" }));

    expect(screen.getByText("从上一镜头视频继承（免费）")).toBeInTheDocument();
    expect(screen.getAllByRole("img")[0]).toHaveAttribute("src", "/tail.png");
  });

  it("preserves the draft on upload failure and retries the same file", async () => {
    const onUpload = vi.fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(uploadResponse());
    render(<Harness initialShot={shot({ continuity: {
      ...shot().continuity!,
      explicit_user_first_frame_asset_id: null,
      first_frame: null,
    } })} onUpload={onUpload} />);
    const file = new File(["image"], "first.png", { type: "image/png" });

    fireEvent.change(screen.getByLabelText("上传首帧"), { target: { files: [file] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("首帧上传失败");
    expect(screen.getByText("从上一镜头视频继承（免费）")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试上传" }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("用户图片")).toBeInTheDocument();
  });

  it("distinguishes a quoted AI asset from a user upload", () => {
    render(<Harness />);

    chooseSelectMenuOption("选择已有资源", "AI frame");

    expect(screen.getByText("AI 生成（独立报价）")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "首帧" })).toHaveAttribute("src", "/ai.png");
  });

  it("ignores an upload response after switching projects", async () => {
    let resolveUpload!: (value: ReferenceImageUploadResponse) => void;
    const pending = new Promise<ReferenceImageUploadResponse>((resolve) => {
      resolveUpload = resolve;
    });
    const updateDraft = vi.fn();
    const firstShot = shot();
    const props = {
      assets,
      busy: false,
      draft: fieldsFromShot(firstShot),
      projectId: "p1",
      shot: firstShot,
      strings: getStrings("zh").shotEditor,
      onUpload: vi.fn(() => pending),
      updateDraft,
    };
    const view = render(<ShotKeyframes {...props} />);

    fireEvent.change(screen.getByLabelText("上传首帧"), {
      target: { files: [new File(["image"], "first.png", { type: "image/png" })] },
    });
    view.rerender(
      <ShotKeyframes
        {...props}
        projectId="p2"
        shot={shot({ id: "s2" })}
      />,
    );
    resolveUpload(uploadResponse());
    await Promise.resolve();
    await Promise.resolve();

    expect(updateDraft).not.toHaveBeenCalled();
  });

  it("accepts an asynchronous AI first-frame task after quote confirmation", async () => {
    const strings = getStrings("zh");
    const onGenerate = vi.fn()
      .mockRejectedValueOnce({
        status: 402,
        code: "payment_required_quote",
        details: {
          billing_job_id: "0123456789abcdef0123456789abcdef",
          available_units: 9_000_000,
          required_units: 1_200_000,
        },
      })
      .mockResolvedValueOnce(generatedResponse("ai-first-new"));
    render(<Harness onGenerate={onGenerate} />);

    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.generateFirstFrameAction }));
    fireEvent.click(screen.getByRole("button", { name: strings.resources.submitGenerateAction }));

    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(1));
    expect(onGenerate.mock.calls[0][0]).toMatchObject({
      kind: "scene",
      count: 1,
      model: "gpt-image-2",
      size: "1536x1024",
      shot_id: "shot-1",
      frame_target: "first",
    });
    expect(onGenerate.mock.calls[0][0]).not.toHaveProperty("billing_job_id");
    expect(screen.getByRole("alert")).toHaveTextContent("¥1.20");

    fireEvent.click(screen.getByRole("button", { name: strings.resources.submitGenerateAction }));
    await waitFor(() => expect(onGenerate).toHaveBeenCalledTimes(2));
    expect(onGenerate.mock.calls[1][0]).toEqual({
      ...onGenerate.mock.calls[0][0],
      billing_job_id: "0123456789abcdef0123456789abcdef",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText(strings.shotEditor.firstFrameSourceAi)).not.toBeInTheDocument();
  });

  it("locks duplicate AI tail submission while the asynchronous request is pending", async () => {
    const strings = getStrings("zh");
    let resolveGeneration!: (value: GenerateImagesResponse) => void;
    const pending = new Promise<GenerateImagesResponse>((resolve) => {
      resolveGeneration = resolve;
    });
    const onGenerate = vi.fn<NonNullable<ComponentProps<typeof ShotKeyframes>["onGenerate"]>>(
      () => pending,
    );
    render(<Harness onGenerate={onGenerate} />);

    fireEvent.click(screen.getByRole("button", { name: strings.shotEditor.generateTailFrameAction }));
    const submit = screen.getByRole("button", { name: strings.resources.submitGenerateAction });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate.mock.calls[0][0]).toMatchObject({ count: 1, kind: "scene" });

    resolveGeneration(generatedResponse("ai-tail-new", "last"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("img", { name: strings.shotEditor.tailFrameLabel })).not.toBeInTheDocument();
  });

  it("restores completed first and last frame tasks after a fresh mount", async () => {
    const onListTasks = vi.fn(async () => ({
      tasks: [
        completedFrameTask("last", "restored-last"),
        completedFrameTask("first", "restored-first"),
      ],
    }));
    render(<Harness onListTasks={onListTasks} />);

    await waitFor(() => expect(onListTasks).toHaveBeenCalled());
    expect(await screen.findByRole("img", { name: getStrings("zh").shotEditor.firstFrameLabel }))
      .toHaveAttribute("src", "/api/projects/p1/media/restored-first.png");
    expect(screen.getByRole("img", { name: getStrings("zh").shotEditor.tailFrameLabel }))
      .toHaveAttribute("src", "/api/projects/p1/media/restored-last.png");
    expect(screen.getAllByText(getStrings("zh").shotEditor.firstFrameSourceAi)).toHaveLength(2);
  });

  it("refreshes frame tasks from SSE and does not apply payment-blocked results", async () => {
    const waiting = generatedResponse("waiting-first", "first").task;
    waiting.status = "awaiting_payment";
    waiting.items![0].status = "awaiting_payment";
    const complete = completedFrameTask("first", "sse-first");
    const onListTasks = vi.fn()
      .mockResolvedValueOnce({ tasks: [waiting] })
      .mockResolvedValueOnce({ tasks: [complete] });
    const onRetryTaskItem = vi.fn(async () => complete);
    const initialEvent: JobEvent[] = [];
    const view = render(
      <Harness
        onListTasks={onListTasks}
        onRetryTaskItem={onRetryTaskItem}
        taskEvents={initialEvent}
      />,
    );

    expect(await screen.findByText(getStrings("zh").shotEditor.keyframeAwaitingPayment))
      .toBeInTheDocument();
    expect(screen.getByRole("img", { name: getStrings("zh").shotEditor.firstFrameLabel }))
      .toHaveAttribute("src", "/user.png");

    view.rerender(
      <Harness
        onListTasks={onListTasks}
        onRetryTaskItem={onRetryTaskItem}
        taskEvents={[{
          id: "task-event-1",
          job_id: complete.id,
          project_id: "p1",
          stage: "task_item",
          status: "complete",
          message: "complete",
          created_at: "2026-07-21T00:00:00Z",
        }]}
      />,
    );
    expect(await screen.findByRole("img", { name: getStrings("zh").shotEditor.firstFrameLabel }))
      .toHaveAttribute("src", "/api/projects/p1/media/sse-first.png");
  });
});
