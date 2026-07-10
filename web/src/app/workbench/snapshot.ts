import type { ContinuityPlan, ProjectType } from "../../domain/types";

export function emptyContinuityPlan(projectType: ProjectType): ContinuityPlan {
  return {
    project_type: projectType,
    active_episode_number: projectType === "single_video" ? null : 1,
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
  };
}
