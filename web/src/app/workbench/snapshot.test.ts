import { describe, expect, it } from "vitest";
import { createProjectResponse, createShot } from "../../test/fixtures";
import {
  emptyContinuityPlan,
  mergeAuthoritativeMediaOverlays,
  replaceShotInSnapshot,
} from "./snapshot";

const snapshot = createProjectResponse();
const sampleShot = createShot();

describe("replaceShotInSnapshot", () => {
  it("replaces one shot while preserving project render metadata", () => {
    const next = replaceShotInSnapshot(snapshot, { ...sampleShot, prompt: "\u65b0\u63d0\u793a\u8bcd" });

    expect(next.storyboard.shots[0].prompt).toBe("\u65b0\u63d0\u793a\u8bcd");
    expect(next.final_path).toBe(snapshot.final_path);
    expect(next.render_report).toBe(snapshot.render_report);
  });
});

describe("emptyContinuityPlan", () => {
  it("creates the complete single-video continuity shape without an active episode", () => {
    expect(emptyContinuityPlan("single_video")).toEqual({
      project_type: "single_video",
      active_episode_number: null,
      series_bible: {
        worldview: "",
        main_arc: "",
        style_lock: "",
        visual_rules: "",
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
    });
  });

  it.each(["mini_series", "long_series"] as const)(
    "starts %s at episode one",
    (projectType) => {
      expect(emptyContinuityPlan(projectType)).toMatchObject({
        project_type: projectType,
        active_episode_number: 1,
      });
    },
  );

  it("builds a complete empty continuity plan for each project type", () => {
    expect(emptyContinuityPlan("single_video").active_episode_number).toBeNull();
    expect(emptyContinuityPlan("mini_series").active_episode_number).toBe(1);
    expect(emptyContinuityPlan("long_series").series_bible.relationship_map).toEqual([]);
  });
});

describe("mergeAuthoritativeMediaOverlays", () => {
  it("retains compatible local shot, final, and asset media while accepting server metadata", () => {
    const current = createProjectResponse();
    const authoritative = structuredClone(current);
    const report = {
      version: "1.0" as const,
      outputs: [{
        path: "renders/final.mp4",
        format: "mp4",
        resolution: "1080x1920",
        duration_seconds: 20,
      }],
    };
    current.storyboard.shots[0].output_path = "local://media/cached-shot";
    current.final_path = "local://media/cached-final";
    current.render_report = report;
    current.series_bible.assets![0].reference_images = ["local://media/cached-asset"];
    authoritative.storyboard.shots[0].output_path = "assets/video/shot-1.mp4";
    authoritative.final_path = null;
    authoritative.render_report = report;
    authoritative.series_bible.assets![0].label = "Authoritative asset label";
    authoritative.series_bible.assets![0].reference_images = ["assets/images/character/mara.png"];

    const merged = mergeAuthoritativeMediaOverlays(authoritative, current);

    expect(merged.storyboard.shots[0].output_path).toBe("local://media/cached-shot");
    expect(merged.final_path).toBe("local://media/cached-final");
    expect(merged.series_bible.assets![0].reference_images).toEqual(["local://media/cached-asset"]);
    expect(merged.series_bible.assets![0].label).toBe("Authoritative asset label");
  });

  it("does not retain local media over a new authoritative generation", () => {
    const current = createProjectResponse();
    const authoritative = structuredClone(current);
    current.storyboard.shots[0].output_path = "local://media/old-shot";
    current.series_bible.assets![0].reference_images = ["local://media/old-asset"];
    authoritative.storyboard.shots[0].version += 1;
    authoritative.storyboard.shots[0].output_path = "assets/video/new-shot.mp4";
    authoritative.series_bible.assets![0].version = (current.series_bible.assets![0].version ?? 0) + 1;
    authoritative.series_bible.assets![0].reference_images = ["assets/images/new-asset.png"];

    const merged = mergeAuthoritativeMediaOverlays(authoritative, current);

    expect(merged.storyboard.shots[0].output_path).toBe("assets/video/new-shot.mp4");
    expect(merged.series_bible.assets![0].reference_images).toEqual(["assets/images/new-asset.png"]);
  });
});
