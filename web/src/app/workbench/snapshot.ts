import type {
  ContinuityPlan,
  ProjectType,
  ShortDramaProjectResponse,
  Shot,
} from "../../domain/types";

export function replaceShotInSnapshot(
  snapshot: ShortDramaProjectResponse,
  shot: Shot,
): ShortDramaProjectResponse {
  return {
    ...snapshot,
    storyboard: {
      ...snapshot.storyboard,
      shots: snapshot.storyboard.shots.map((item) => (item.id === shot.id ? shot : item)),
    },
  };
}

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
