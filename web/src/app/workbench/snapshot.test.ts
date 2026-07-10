import { describe, expect, it } from "vitest";
import { emptyContinuityPlan } from "./snapshot";

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
});
