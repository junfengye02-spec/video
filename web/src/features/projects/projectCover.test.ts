import { describe, expect, it } from "vitest";
import { createProjectResponse } from "../../test/fixtures";
import { selectProjectCover } from "./projectCover";

describe("selectProjectCover", () => {
  it("prefers a final render, then a generated shot, then a real asset", () => {
    const snapshot = createProjectResponse();
    snapshot.final_path = "renders/final.mp4";
    snapshot.storyboard.shots[0].output_path = "assets/video/shot.mp4";
    snapshot.series_bible.assets = [{
      id: "a1",
      kind: "scene",
      label: "scene",
      reference_images: ["assets/images/scene.webp"],
    }];
    expect(selectProjectCover(snapshot)).toEqual({ kind: "video", source: "renders/final.mp4" });

    snapshot.final_path = null;
    expect(selectProjectCover(snapshot)).toEqual({ kind: "video", source: "assets/video/shot.mp4" });

    snapshot.storyboard.shots[0].output_path = null;
    expect(selectProjectCover(snapshot)).toEqual({ kind: "image", source: "assets/images/scene.webp" });
  });
});
