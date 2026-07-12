import { describe, expect, it, vi } from "vitest";
import type {
  ContinuityPlan,
  PromptOptimizeRequest,
  ShotRegenerateRequest,
  ShotSaveRequest,
} from "../domain/types";
import {
  createDraftProject,
  createShortDramaProject,
  loadLatestProject,
  mediaUrl,
  saveContinuityPlan,
  optimizePrompt,
  regenerateShot,
  renderProject,
  saveShot,
  subscribeProjectEvents,
  uploadReferenceImage,
} from "./client";

describe("mediaUrl", () => {
  it("builds project media URLs for relative image paths", () => {
    expect(mediaUrl("assets/images/character/mara.png", "p1")).toBe(
      "/api/projects/p1/media/assets/images/character/mara.png",
    );
  });
});

describe("createShortDramaProject", () => {
  it("posts only project planning fields to backend", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ project: { id: "p1", title: "Rain Alley" } }),
    });

    const result = await createShortDramaProject(
      {
        title: "Rain Alley",
        prompt: "rainy short drama",
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

describe("createDraftProject", () => {
  it("creates an empty project shell for uploads and resources", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ project: { id: "p1", title: "Draft", project_type: "mini_series" } }),
    });

    const result = await createDraftProject(
      { title: "Draft", project_type: "mini_series" },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "Draft", project_type: "mini_series" }),
      }),
    );
    expect(result.project.id).toBe("p1");
  });
});

describe("loadLatestProject", () => {
  it("loads the latest project snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ project: { id: "p1", title: "Latest", project_type: "single_video" } }),
    });

    const result = await loadLatestProject(fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/latest",
      expect.objectContaining({ method: "GET" }),
    );
    expect(result.project.id).toBe("p1");
  });
});

describe("saveContinuityPlan", () => {
  it("patches series continuity settings", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ project: { id: "p1" }, continuity_plan: { project_type: "long_series" } }),
    });
    const payload: ContinuityPlan = {
      project_type: "long_series",
      active_episode_number: 2,
      series_bible: {
        worldview: "Rain city",
        main_arc: "Expose the relay",
        style_lock: "Neon noir",
        visual_rules: "Red coat stays locked",
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

    const result = await saveContinuityPlan("p1", payload, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/continuity",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify(payload) }),
    );
    expect(result.continuity_plan.project_type).toBe("long_series");
  });
});

describe("uploadReferenceImage", () => {
  it("uploads a reference image through multipart form data", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        media: { path: "assets/images/character/a.png", media_url: "/api/projects/p1/media/assets/images/character/a.png", filename: "a.png", content_type: "image/png" },
        asset: { id: "asset-1", kind: "character", label: "Hero", description: "red coat", prompt: "red coat", reference_images: [], shot_ids: [], version: 1 },
      }),
    });

    const result = await uploadReferenceImage(
      "p1",
      {
        kind: "character",
        label: "Hero",
        description: "red coat",
        prompt: "red coat",
        file: new File(["img"], "hero.png", { type: "image/png" }),
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/assets/upload",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );
    expect(result.asset.id).toBe("asset-1");
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
  it("posts an empty browser payload to the regenerate endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        job_id: "j1",
        event: { id: "e1", stage: "regenerate" },
        shot: { id: "s1", status: "complete" },
        storyboard: { shots: [] },
        consistency_report: { score: 100, issues: [] },
        generation: {
          operation: "reference_to_video",
          reference_image_paths: ["assets/images/character/lin.png"],
          output_path: "assets/video/s1.mp4",
          cost_usd: 0.2,
        },
      }),
    });
    const payload: ShotRegenerateRequest = {};

    const result = await regenerateShot("p1", "s1", payload, fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/shots/s1/regenerate",
      expect.objectContaining({ method: "POST", body: JSON.stringify(payload) }),
    );
    expect(result.event.stage).toBe("regenerate");
    expect(result.generation?.operation).toBe("reference_to_video");
    expect(result.generation?.reference_image_paths).toEqual(["assets/images/character/lin.png"]);
  });
});

describe("renderProject", () => {
  it("posts only render choices to the project render endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ final_path: "projects/p1/renders/final.mp4" }),
    });

    const result = await renderProject(
      "p1",
      {
        render_runtime: "ffmpeg",
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/p1/render",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
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
