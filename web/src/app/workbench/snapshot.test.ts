import { describe, expect, it } from "vitest";
import { createProjectResponse, createShot } from "../../test/fixtures";
import { emptyContinuityPlan, replaceShotInSnapshot } from "./snapshot";

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
