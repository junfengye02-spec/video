import { describe, expect, it, vi } from "vitest";
import type { ShotRegenerateRequest, ShotSaveRequest } from "../domain/types";
import { createShortDramaProject, regenerateShot, renderProject, saveShot } from "./client";

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
  it("posts provider keys and model choices to the project render endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ final_path: "projects/p1/renders/final.mp4" }),
    });

    const result = await renderProject(
      "p1",
      {
        text_key: "text-key",
        image_key: "image-key",
        video_key: "video-key",
        base_url: "https://api.0000238.xyz",
        text_model: "gpt-5.5",
        image_model: "gpt-image-2",
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
          text_key: "text-key",
          image_key: "image-key",
          video_key: "video-key",
          base_url: "https://api.0000238.xyz",
          text_model: "gpt-5.5",
          image_model: "gpt-image-2",
          video_model: "veo_3_1-fast-fl",
          render_runtime: "ffmpeg",
        }),
      }),
    );
    expect(result.final_path).toContain("final.mp4");
  });
});
