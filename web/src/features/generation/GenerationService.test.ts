import { describe, expect, it, vi } from "vitest";
import type { JobEvent, ShotSaveRequest } from "../../domain/types";
import { ApiError } from "../../platform/http/HttpClient";
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
        prompt: "Edited",
        characters: ["mara"],
      },
    });
  });

  it("regenerates a shot with an empty browser payload", async () => {
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      job_id: "regen-job",
      event: { id: "event-1", stage: "regenerate" },
      shot: { id: "shot-1" },
      storyboard: { shots: [] },
      consistency_report: { score: 100, issues: [] },
    })));

    await service.regenerate("p1", "shot-1");

    expect(json).toHaveBeenCalledWith("/api/projects/p1/shots/shot-1/regenerate", {
      method: "POST",
      body: {},
    });
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

  it("renders with the server-selected ffmpeg runtime payload", async () => {
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
      body: { render_runtime: "ffmpeg" },
    });
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
  });
});
