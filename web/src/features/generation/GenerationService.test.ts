import { describe, expect, it, vi } from "vitest";
import type { JobEvent, ShotSaveRequest } from "../../domain/types";
import { ApiError } from "../../platform/http/HttpClient";
import { createAcceptedImageTask } from "../../test/fixtures";
import { LocalGenerationService } from "./GenerationService";

function serviceWithJson(json = vi.fn()) {
  const form = vi.fn();
  return {
    form,
    json,
    service: new LocalGenerationService({ http: { json, form } }),
  };
}

const legacyCredentialFields = [
  ["text", "key"],
  ["image", "key"],
  ["video", "key"],
  ["base", "url"],
].map(([prefix, suffix]) => `${prefix}_${suffix}`);
const legacyCredentialPattern = new RegExp(legacyCredentialFields.join("|"));

describe("GenerationService", () => {
  it("loads the capability-scoped model catalog", async () => {
    const configuredProfile = {
      provider: "newapi",
      model_id: "video-a",
      operation: "text_to_video" as const,
      duration_mode: "fixed" as const,
      fixed_duration_seconds: 10,
      supported_duration_seconds: [],
      min_duration_seconds: null,
      max_duration_seconds: null,
      supports_start_frame: false,
      supports_end_frame: false,
      supports_extend: false,
      supports_multi_shot_prompt: false,
      contract_source: "admin_configuration" as const,
      profile_revision: "duration-v1",
      duration_configuration_status: "configured" as const,
    };
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      capability: "video",
      models: ["video-a", "video-b"],
      profiles: [configuredProfile],
    })));

    await expect(service.listModels("video")).resolves.toEqual({
      capability: "video",
      models: ["video-a", "video-b"],
      profiles: [configuredProfile],
    });

    expect(json).toHaveBeenCalledWith("/api/generation/models?capability=video");
  });

  it("rejects a catalog whose capability does not match the request", async () => {
    const { service } = serviceWithJson(vi.fn(async () => ({
      capability: "image",
      models: ["image-a"],
    })));

    await expect(service.listModels("video")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("lists media assets with the frozen query contract", async () => {
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      assets: [],
      next_cursor: null,
    })));

    await service.listAssets({
      scope: "project",
      project_id: "project / one",
      kind: "scene",
      source_type: "ai_generated",
      cursor: "next page",
      limit: 40,
    });

    expect(json).toHaveBeenCalledWith(
      "/api/assets?scope=project&project_id=project+%2F+one&kind=scene&source_type=ai_generated&cursor=next+page&limit=40",
    );
  });

  it("generates images with the exact public payload", async () => {
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      job_id: "image-job",
      assets: [],
    })));
    const payload = {
      kind: "character" as const,
      label: "Mara",
      description: "Red coat",
      prompt: "Cinematic portrait",
      model: "gpt-image-2",
      count: 2,
      size: "1024x1536",
      quality: "high",
      billing_job_id: "billing-job",
    };

    await service.generateImages("project / one", payload);

    expect(json).toHaveBeenCalledWith("/api/projects/project%20%2F%20one/images/generate", {
      method: "POST",
      body: payload,
    });
  });

  it("does not expose the legacy shot batch submit path", () => {
    const { service } = serviceWithJson();
    expect("generateShots" in service).toBe(false);
  });

  it("coalesces identical in-flight plan previews", async () => {
    let resolvePreview!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      resolvePreview = resolve;
    });
    const { json, service } = serviceWithJson(vi.fn(() => pending));
    const payload = {
      video_model: "omni_flash-10s",
      operation: "text_to_video" as const,
      shot_ids: ["s1", "s2"],
      regenerate_unit_ids: [],
    };

    const first = service.previewGenerationPlan("project-1", payload);
    const second = service.previewGenerationPlan("project-1", payload);

    expect(first).toBe(second);
    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith(
      "/api/projects/project-1/generation-plan/preview",
      { method: "POST", body: { ...payload, contract_version: 2 } },
    );

    resolvePreview({ id: "a".repeat(64), generation_units: [] });
    await Promise.all([first, second]);
    json.mockResolvedValueOnce({ id: "a".repeat(64), generation_units: [] });
    await service.previewGenerationPlan("project-1", payload);
    expect(json).toHaveBeenCalledTimes(2);
  });

  it("submits generation unit IDs through the v2 endpoint", async () => {
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      task_id: "task-2",
      status: "queued",
      deduplicated: false,
      task: { id: "task-2" },
    })));
    const payload = {
      generation_plan_id: "a".repeat(64),
      generation_unit_ids: ["unit-1", "unit-2"],
      idempotency_key: "generation-units:command-1",
    };

    await service.generateGenerationUnits("project / one", payload);

    expect(json).toHaveBeenCalledWith(
      "/api/projects/project%20%2F%20one/generation-units/generate",
      { method: "POST", body: { ...payload, contract_version: 2 } },
    );
  });

  it("loads persisted task items and retries one child through project-scoped endpoints", async () => {
    const { json, service } = serviceWithJson(vi.fn(async () => ({ tasks: [] })));

    await service.listTasks("project / one");
    expect(json).toHaveBeenCalledWith(
      "/api/projects/project%20%2F%20one/tasks?include_items=true",
    );

    await service.retryTaskItem("project / one", "task / one", "item / one");
    expect(json).toHaveBeenLastCalledWith(
      "/api/projects/project%20%2F%20one/tasks/task%20%2F%20one/items/item%20%2F%20one/retry",
      { method: "POST", body: {} },
    );
  });

  it("adds a library asset to a project through the frozen endpoint", async () => {
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      asset: { id: "asset / one", reference_images: [] },
      library_asset: { id: "asset / one" },
    })));

    await service.addAssetToProject("p1", "asset / one");

    expect(json).toHaveBeenCalledWith("/api/projects/p1/assets/asset%20%2F%20one/add", {
      method: "POST",
      body: {},
    });
  });

  it("revises only the requested creative plan text sections", async () => {
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      project: { id: "p1" },
      series_bible: { characters: [] },
      storyboard: { shots: [] },
      consistency_report: { score: 100, issues: [] },
    })));
    const payload = {
      sections: ["worldview", "props"] as const,
      feedback: "Make the evidence rules concrete",
      billing_job_id: "b".repeat(32),
    };

    await service.reviseCreativePlan("project / one", {
      ...payload,
      sections: [...payload.sections],
    });

    expect(json).toHaveBeenCalledWith(
      "/api/projects/project%20%2F%20one/creative-plan/revise",
      {
        method: "POST",
        body: {
          sections: ["worldview", "props"],
          feedback: "Make the evidence rules concrete",
          billing_job_id: "b".repeat(32),
        },
      },
    );
  });

  it("optimizes a shot through the shot-json prompt endpoint without provider credentials", async () => {
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      project_id: "p1",
      model: "gpt-5.5",
      optimized_text: "Optimized shot",
      notes: [],
    })));

    await service.optimize("p1", "shot-1", "source prompt");

    expect(json).toHaveBeenCalledWith("/api/projects/p1/prompt-optimize", {
      method: "POST",
      body: {
        target: "shot",
        target_id: "shot-1",
        source_text: "source prompt",
        mode: "shot_json",
      },
    });
    expect(JSON.stringify(json.mock.calls[0]?.[1]?.body)).not.toMatch(legacyCredentialPattern);
  });

  it("optimizes an image prompt as asset text and preserves a retry billing job", async () => {
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      project_id: "p1",
      model: "gpt-5.5",
      optimized_text: "Cinematic rainy alley",
      notes: [],
    })));

    await service.optimizeImagePrompt("p1", "scene", "rainy alley", "b".repeat(32));

    expect(json).toHaveBeenCalledWith("/api/projects/p1/prompt-optimize", {
      method: "POST",
      body: {
        target: "asset",
        target_id: "image-generation-draft",
        asset_kind: "scene",
        source_text: "rainy alley",
        mode: "text",
        billing_job_id: "b".repeat(32),
      },
    });
    expect(JSON.stringify(json.mock.calls[0]?.[1]?.body)).not.toMatch(legacyCredentialPattern);
  });

  it("saves only public shot fields and strips legacy provider credential fields", async () => {
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      job_id: "save-job",
      event: { id: "event-1", stage: "save" },
      shot: { id: "shot-1", prompt: "Edited" },
      storyboard: { shots: [] },
      consistency_report: { score: 100, issues: [] },
    })));
    const [textKey, imageKey, videoKey, baseUrl] = legacyCredentialFields;
    const payload = {
      episode_number: 2,
      prompt: "Edited",
      characters: ["mara"],
      [textKey]: "secret",
      [imageKey]: "secret",
      [videoKey]: "secret",
      [baseUrl]: "https://provider.example",
    } as ShotSaveRequest & Record<string, unknown>;

    await service.saveShot("p1", "shot-1", payload);

    expect(json).toHaveBeenCalledWith("/api/projects/p1/shots/shot-1", {
      method: "PATCH",
      body: {
        episode_number: 2,
        prompt: "Edited",
        characters: ["mara"],
      },
    });
  });

  it("regenerates a shot with an empty browser payload", async () => {
    const accepted = createAcceptedImageTask("regen-task");
    const { json, service } = serviceWithJson(vi.fn(async () => accepted));

    await expect(service.regenerate("p1", "shot-1")).resolves.toBe(accepted);

    expect(json).toHaveBeenCalledWith("/api/projects/p1/shots/shot-1/regenerate", {
      method: "POST",
      body: {},
    });
  });

  it("regenerates a shot with the user-selected video model", async () => {
    const accepted = createAcceptedImageTask("regen-task");
    const { json, service } = serviceWithJson(vi.fn(async () => accepted));

    await expect(service.regenerate("p1", "shot-1", "video-model-v2")).resolves.toBe(accepted);

    expect(json).toHaveBeenCalledWith("/api/projects/p1/shots/shot-1/regenerate", {
      method: "POST",
      body: { video_model: "video-model-v2" },
    });
  });

  it("does not retry the regenerate endpoint while a provider result is pending", async () => {
    const pending = new ApiError(
      409,
      "Video result is pending",
      "provider_result_pending",
      { billing_job_id: "b".repeat(32) },
    );
    const { json, service } = serviceWithJson(vi.fn(async () => { throw pending; }));

    await expect(service.regenerate("p1", "shot-1")).rejects.toBe(pending);
    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith("/api/projects/p1/shots/shot-1/regenerate", {
      method: "POST",
      body: {},
    });
  });

  it("takes over the existing task reported by a generation conflict", async () => {
    const accepted = createAcceptedImageTask("existing-task");
    accepted.task.status = "waiting_provider";
    accepted.status = "waiting_provider";
    const conflict = new ApiError(
      409,
      "Provider generation is already active",
      "provider_generation_in_progress",
      {
        task_id: accepted.task_id,
        task_item_id: accepted.task.items?.[0]?.id,
        billing_job_id: "b".repeat(32),
      },
    );
    const json = vi.fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ tasks: [accepted.task] });
    const service = new LocalGenerationService({ http: { json, form: vi.fn() } });

    await expect(service.regenerate("p1", "shot-1")).resolves.toEqual({
      ...accepted,
      deduplicated: true,
    });
    expect(json).toHaveBeenNthCalledWith(1, "/api/projects/p1/shots/shot-1/regenerate", {
      method: "POST",
      body: {},
    });
    expect(json).toHaveBeenNthCalledWith(
      2,
      "/api/projects/p1/tasks?include_items=true",
    );
  });

  it("saves continuity through the project continuity endpoint", async () => {
    const continuity = {
      project_type: "single_video" as const,
      active_episode_number: null,
      series_bible: {
        worldview: "world",
        main_arc: "arc",
        style_lock: "style",
        visual_rules: "rules",
        taboos: [],
        locations: [],
        props: [],
        relationship_map: [],
      },
      episodes: [],
      story_state: {
        character_knowledge: [],
        relationship_changes: [],
        active_foreshadowing: [],
        resolved_foreshadowing: [],
        prop_state: [],
        character_status: [],
        current_locations: [],
      },
    };
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      project: { id: "p1", title: "Project", mode: "short_drama" },
      continuity_plan: continuity,
    })));

    await service.saveContinuity("p1", continuity);

    expect(json).toHaveBeenCalledWith("/api/projects/p1/continuity", {
      method: "PATCH",
      body: continuity,
    });
  });

  it("uploads a reference image as form data", async () => {
    const { form, service } = serviceWithJson();
    const file = new File(["image"], "mara.png", { type: "image/png" });
    form.mockResolvedValue({
      media: {
        path: "assets/images/mara.png",
        media_url: "/api/projects/p1/media/assets/images/mara.png",
        filename: "mara.png",
        content_type: "image/png",
      },
      asset: {
        id: "asset-1",
        kind: "character",
        label: "Mara",
        reference_images: [],
      },
    });

    await service.uploadReference("p1", {
      kind: "character",
      label: "Mara",
      description: "Red coat",
      prompt: "Mara in a red coat",
      file,
    });

    expect(form).toHaveBeenCalledWith("/api/projects/p1/assets/upload", {
      body: expect.any(FormData),
    });
    const body = form.mock.calls[0]?.[1].body as FormData;
    expect(body.get("kind")).toBe("character");
    expect(body.get("label")).toBe("Mara");
    expect(body.get("file")).toBe(file);
  });

  it("associates a planned resource upload and saves its prompt through the resource API", async () => {
    const { form, json, service } = serviceWithJson(vi.fn(async () => ({
      asset: {
        id: "planned-scene",
        kind: "scene",
        label: "Rainy alley",
        description: "night rain",
        prompt: "revised prompt",
        reference_images: [],
      },
    })));
    const file = new File(["image"], "alley.png", { type: "image/png" });

    await service.uploadReference("p1", {
      kind: "scene",
      label: "Rainy alley",
      description: "night rain",
      prompt: "revised prompt",
      resource_id: "planned-scene",
      file,
    });
    await service.updatePlannedAssetPrompt("p1", "planned-scene", { prompt: "revised prompt" });

    const formBody = form.mock.calls[0]?.[1].body as FormData;
    expect(formBody.get("resource_id")).toBe("planned-scene");
    expect(json).toHaveBeenCalledWith("/api/projects/p1/assets/planned-scene", {
      method: "PATCH",
      body: { prompt: "revised prompt" },
    });
  });

  it("renders without overriding the runtime locked by the server", async () => {
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      job_id: "render-job",
      event: { id: "event-1", stage: "render" },
      project: { id: "p1" },
      storyboard: { shots: [] },
      consistency_report: { score: 100, issues: [] },
      render_report: { version: "1.0", outputs: [] },
      final_path: "renders/final.mp4",
    })));

    await service.render("p1");

    expect(json).toHaveBeenCalledWith("/api/projects/p1/render", {
      method: "POST",
      body: {},
    });
  });

  it("marks an explicit server recovery without changing the normal render payload", async () => {
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      job_id: "render-job",
      event: { id: "event-1", stage: "render" },
      project: { id: "p1" },
      storyboard: { shots: [] },
      consistency_report: { score: 100, issues: [] },
      render_report: { version: "1.0", outputs: [] },
      final_path: "renders/final.mp4",
    })));

    await service.render("p1", true);

    expect(json).toHaveBeenCalledWith("/api/projects/p1/render", {
      method: "POST",
      body: { resume_existing: true },
    });
  });

  it("submits final composition to the persistent asynchronous endpoint", async () => {
    const accepted = {
      task_id: "composition-task",
      status: "queued",
      deduplicated: false,
      task: { id: "composition-task" },
    };
    const { json, service } = serviceWithJson(vi.fn(async () => accepted));

    await expect(service.compose("p1", {
      selected_shot_ids: ["shot-1", "shot-2"],
      render_runtime: "ffmpeg",
      idempotency_key: "composition:p1:once",
    })).resolves.toBe(accepted);

    expect(json).toHaveBeenCalledWith("/api/projects/p1/composition", {
      method: "POST",
      body: {
        selected_shot_ids: ["shot-1", "shot-2"],
        render_runtime: "ffmpeg",
        idempotency_key: "composition:p1:once",
      },
    });
  });

  it("prepares render counts and authoritative quota without starting a render", async () => {
    const prepared = {
      project_id: "p1",
      shot_summary: { total: 3, reusable: 1, to_generate: 2, completed: 1 },
      estimated_units: 1_000_000,
      available_units: 2_000_000,
      estimate_status: "ready",
      output: {
        format: "mp4",
        resolution: "720x1280",
        aspect_ratio: "9:16",
        duration_seconds: 15,
        render_runtime: "ffmpeg",
      },
      continuity: { characters: 2, locations: 1, props: 1, bound_assets: 2 },
      active_job: null,
    };
    const { json, service } = serviceWithJson(vi.fn(async () => prepared));

    await expect(service.prepareRender("p1")).resolves.toBe(prepared);
    expect(json).toHaveBeenCalledWith("/api/projects/p1/render/prepare", {
      method: "POST",
      body: {},
    });
  });

  it("marks EventSource disconnects and reconnects while closing the source on cleanup", () => {
    const close = vi.fn();
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const addEventListener = vi.fn((type: string, listener: (event: MessageEvent) => void) => {
      listeners.set(type, listener);
    });
    const onConnectionChange = vi.fn();
    const service = new LocalGenerationService({
      eventSourceFactory: vi.fn(() => ({ addEventListener, close })),
    });

    const unsubscribe = service.subscribe("p1", vi.fn(), { onConnectionChange });
    listeners.get("open")?.(new MessageEvent("open"));
    listeners.get("error")?.(new MessageEvent("error"));
    listeners.get("open")?.(new MessageEvent("open"));
    unsubscribe();

    expect(onConnectionChange.mock.calls.map(([state]) => state)).toEqual([
      "connecting",
      "connected",
      "disconnected",
      "connected",
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed and cross-project SSE payloads", () => {
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const service = new LocalGenerationService({
      eventSourceFactory: vi.fn(() => ({
        addEventListener: (
          type: string,
          listener: (event: MessageEvent) => void,
        ) => listeners.set(type, listener),
        close: vi.fn(),
      })),
    });
    const onEvent = vi.fn();
    service.subscribe("p1", onEvent);

    listeners.get("job")?.(new MessageEvent("job", { data: "not-json" }));
    listeners.get("job")?.(new MessageEvent("job", { data: JSON.stringify({
      id: "foreign",
      job_id: "job-2",
      project_id: "p2",
      stage: "render",
      status: "running",
      message: "wrong project",
      created_at: "2026-07-12T00:00:00Z",
    }) }));

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("opens and cleans up project job subscriptions", () => {
    const close = vi.fn();
    const addEventListener = vi.fn();
    const events: JobEvent[] = [];
    const eventSourceFactory = vi.fn(() => ({ addEventListener, close }));
    const service = new LocalGenerationService({ eventSourceFactory });

    const unsubscribe = service.subscribe("p1", (event) => events.push(event));
    const listener = addEventListener.mock.calls[0]?.[1] as (message: MessageEvent) => void;
    listener(new MessageEvent("job", {
      data: JSON.stringify({
        id: "event-1",
        job_id: "job-1",
        project_id: "p1",
        stage: "render",
        status: "running",
        message: "Rendering",
        created_at: "2026-07-12T00:00:00Z",
      }),
    }));
    unsubscribe();

    expect(eventSourceFactory).toHaveBeenCalledWith("/api/projects/p1/events");
    expect(addEventListener).toHaveBeenCalledWith("job", expect.any(Function));
    expect(events).toEqual([expect.objectContaining({ id: "event-1", stage: "render" })]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("propagates unauthorized API errors without replacing their type", async () => {
    const error = new ApiError(401, "Authentication required");
    const { service } = serviceWithJson(vi.fn(async () => { throw error; }));

    await expect(service.render("p1")).rejects.toBe(error);
  });

  it("preserves typed payment-required API errors for billing UI handoff", async () => {
    const error = new ApiError(402, "Payment required", "payment_required");
    const { service } = serviceWithJson(vi.fn(async () => { throw error; }));

    await expect(service.regenerate("p1", "shot-1")).rejects.toMatchObject({
      code: "payment_required",
      status: 402,
    });
    await expect(service.generateImages("p1", {
      kind: "scene",
      label: "Rain",
      description: "",
      prompt: "Rainy alley",
      model: "gpt-image-2",
      count: 1,
      size: "1024x1024",
      quality: "standard",
    })).rejects.toBe(error);
  });
});
