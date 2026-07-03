import { describe, expect, it, vi } from "vitest";
import type {
  PromptOptimizeRequest,
  ShotRegenerateRequest,
  ShotSaveRequest,
} from "../domain/types";
import {
  createShortDramaProject,
  optimizePrompt,
  regenerateShot,
  renderProject,
  saveShot,
  subscribeProjectEvents,
} from "./client";

describe("createShortDramaProject", () => {
  it("posts prompt, provider keys, and model choices to backend", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ project: { id: "p1", title: "Rain Alley" } }),
    });

    const result = await createShortDramaProject(
      {
        title: "Rain Alley",
        prompt: "rainy short drama",
        text_key: "text-key",
        image_key: "image-key",
        video_key: "video-key",
        base_url: "https://api.0000238.xyz",
        text_model: "gpt-5.5",
        image_model: "gpt-image-2",
        video_model: "veo_3_1-lite",
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/short-drama",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "Rain Alley",
          prompt: "rainy short drama",
          text_key: "text-key",
          image_key: "image-key",
          video_key: "video-key",
          base_url: "https://api.0000238.xyz",
          text_model: "gpt-5.5",
          image_model: "gpt-image-2",
          video_model: "veo_3_1-lite",
        }),
      }),
    );
    expect(result.project.id).toBe("p1");
  });

  it("returns shot intent and structured shot language on storyboard shots", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        project: { id: "p1", title: "Rain Alley" },
        storyboard: {
          shots: [
            {
              id: "shot-1",
              scene_id: "scene-1",
              index: 1,
              beat: "Lin finds the envelope",
              prompt: "Lin in a red coat finds a soaked envelope.",
              characters: ["lin"],
              location: "rainy alley",
              props: ["envelope"],
              status: "ready",
              consistency_score: 92,
              output_url: "https://example.com/shot-1.mp4",
              output_path: "projects/p1/shots/shot-1.mp4",
              asset_ids: [],
              version: 1,
              history: [],
              shot_intent: "Start with a tense clue reveal.",
              shot_language: {
                shot_size: "medium_close",
                camera_movement: "dolly_in",
                lens_mm: 50,
                depth_of_field: "shallow",
                lighting_key: "neon",
                color_temperature: "cool",
              },
            },
          ],
        },
      }),
    });

    const result = await createShortDramaProject(
      {
        title: "Rain Alley",
        prompt: "rainy short drama",
        text_key: "text-key",
        image_key: "image-key",
        video_key: "video-key",
        base_url: "https://api.0000238.xyz",
        text_model: "gpt-5.5",
        image_model: "gpt-image-2",
        video_model: "veo_3_1-lite",
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(result.storyboard.shots[0].shot_language?.shot_size).toBe(
      "medium_close",
    );
    expect(result.storyboard.shots[0].shot_intent).toBe(
      "Start with a tense clue reveal.",
    );
  });
});

describe("ShotSaveRequest", () => {
  it("exposes metadata fields without provider fields for frontend callers", () => {
    const payload: ShotSaveRequest = {
      shot_intent: "Push in as Lin realizes the clue matters.",
      shot_language: {
        shot_size: "medium_close",
        camera_movement: "dolly_in",
        lens_mm: 50,
        depth_of_field: "shallow",
        lighting_key: "neon",
        color_temperature: "cool",
      },
    };

    expect(payload.shot_intent).toBe(
      "Push in as Lin realizes the clue matters.",
    );
    expect(payload.shot_language).toEqual({
      shot_size: "medium_close",
      camera_movement: "dolly_in",
      lens_mm: 50,
      depth_of_field: "shallow",
      lighting_key: "neon",
      color_temperature: "cool",
    });
  });
});

describe("saveShot", () => {
  it("patches edited shot fields to the save endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job_id: "j1",
        event: { id: "e1", stage: "save" },
        shot: { id: "s1", version: 2 },
        storyboard: { shots: [] },
        consistency_report: { score: 100, issues: [] },
      }),
    });
    const payload: ShotSaveRequest = {
      prompt: "edited prompt",
      characters: ["c1"],
      location: "rainy alley",
      props: ["envelope"],
      asset_ids: ["asset-c1-ref"],
      shot_intent: "Hold tension before the clue reveal.",
      shot_language: { shot_size: "medium", camera_movement: "static" },
    };

    const result = await saveShot("p1", "s1", payload, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/shots/s1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify(payload) }),
    );
    expect(result.event.stage).toBe("save");
  });
});

describe("optimizePrompt", () => {
  it("posts mode and returns structured shot fields from the optimize endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
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
      }),
    });
    const payload: PromptOptimizeRequest = {
      target: "shot",
      target_id: "s1",
      source_text: "Lin opens envelope.",
      text_key: "text-key",
      base_url: "https://api.0000238.xyz",
      text_model: "gpt-5.5",
      mode: "shot_json",
    };

    const result = await optimizePrompt("p1", payload, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/prompt-optimize",
      expect.objectContaining({ method: "POST", body: JSON.stringify(payload) }),
    );
    expect(result.optimized_text).toContain("red coat");
    expect(result.shot_intent).toContain("betrayal");
    expect(result.shot_language?.camera_movement).toBe("dolly_in");
  });

  it("supports text-mode optimization when mode and structured shot fields are omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        project_id: "p1",
        model: "gpt-5.5",
        optimized_text: "Tighten the alley prompt around Lin's discovery and the rain-soaked envelope.",
        notes: ["rewritten by text model"],
      }),
    });
    const payload: PromptOptimizeRequest = {
      target: "project",
      target_id: "brief-1",
      source_text: "Lin opens envelope.",
      text_key: "text-key",
      base_url: "https://api.0000238.xyz",
      text_model: "gpt-5.5",
    };

    const result = await optimizePrompt("p1", payload, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/prompt-optimize",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
    expect(result.optimized_text).toContain("rain-soaked envelope");
    expect(result.shot_intent).toBeUndefined();
    expect(result.shot_language).toBeUndefined();
  });
});

describe("regenerateShot", () => {
  it("posts provider fields only to the regenerate endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job_id: "j1",
        event: { id: "e1", stage: "regenerate" },
        shot: { id: "s1", status: "complete" },
        storyboard: { shots: [] },
        consistency_report: { score: 100, issues: [] },
      }),
    });
    const payload: ShotRegenerateRequest = {
      video_key: "video-key",
      base_url: "https://api.0000238.xyz",
      video_model: "omni_flash-10s",
    };

    const result = await regenerateShot("p1", "s1", payload, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/shots/s1/regenerate",
      expect.objectContaining({ method: "POST", body: JSON.stringify(payload) }),
    );
    expect(result.event.stage).toBe("regenerate");
  });
});

describe("renderProject", () => {
  it("posts only the required video key and render choices to the project render endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ final_path: "projects/p1/renders/final.mp4" }),
    });

    const result = await renderProject(
      "p1",
      {
        video_key: "video-key",
        base_url: "https://api.0000238.xyz",
        video_model: "veo_3_1-fast-fl",
        render_runtime: "ffmpeg",
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/render",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          video_key: "video-key",
          base_url: "https://api.0000238.xyz",
          video_model: "veo_3_1-fast-fl",
          render_runtime: "ffmpeg",
        }),
      }),
    );
    expect(result.final_path).toContain("final.mp4");
  });
});

describe("subscribeProjectEvents", () => {
  it("opens event stream, forwards job events, and returns cleanup", () => {
    const close = vi.fn();
    const addEventListener = vi.fn();
    const instances: Array<{
      url: string;
      addEventListener: typeof addEventListener;
      close: typeof close;
      onerror: ((event: Event) => void) | null;
    }> = [];
    const onEvent = vi.fn();

    class FakeEventSource {
      url: string;
      addEventListener = addEventListener;
      close = close;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        instances.push(this);
      }
    }

    const originalEventSource = globalThis.EventSource;
    vi.stubGlobal("EventSource", FakeEventSource);

    const cleanup = subscribeProjectEvents("p1", onEvent);
    const jobListener = addEventListener.mock.calls[0]?.[1] as (event: MessageEvent) => void;

    expect(instances[0]?.url).toBe("/api/projects/p1/events");
    expect(addEventListener).toHaveBeenCalledWith("job", expect.any(Function));

    jobListener(
      new MessageEvent("job", {
        data: JSON.stringify({
          id: "e1",
          job_id: "j1",
          project_id: "p1",
          stage: "render",
          status: "running",
          message: "Rendering",
          created_at: "2026-07-03T00:00:00Z",
        }),
      }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e1", stage: "render", status: "running" }),
    );

    instances[0]?.onerror?.(new Event("error"));
    expect(close).not.toHaveBeenCalled();
    cleanup();

    expect(close).toHaveBeenCalledTimes(1);

    vi.stubGlobal("EventSource", originalEventSource);
  });
});
