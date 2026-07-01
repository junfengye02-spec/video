import { describe, expect, it, vi } from "vitest";
import { createShortDramaProject, renderProject } from "./client";

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
