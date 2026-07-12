import { describe, expect, it, vi } from "vitest";
import type { JobEvent, ShotSaveRequest } from "../../domain/types";
import { ApiError } from "../../platform/http/HttpClient";
import { LocalGenerationService } from "./GenerationService";

function serviceWithJson(json = vi.fn()) {
  return {
    json,
    service: new LocalGenerationService({ http: { json } }),
  };
}

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
    expect(JSON.stringify(json.mock.calls[0]?.[1]?.body)).not.toMatch(
      /text_key|image_key|video_key|base_url/,
    );
  });

  it("saves only public shot fields and strips legacy provider credential fields", async () => {
    const { json, service } = serviceWithJson(vi.fn(async () => ({
      job_id: "save-job",
      event: { id: "event-1", stage: "save" },
      shot: { id: "shot-1", prompt: "Edited" },
      storyboard: { shots: [] },
      consistency_report: { score: 100, issues: [] },
    })));
    const payload = {
      prompt: "Edited",
      characters: ["mara"],
      text_key: "secret",
      image_key: "secret",
      video_key: "secret",
      base_url: "https://provider.example",
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
