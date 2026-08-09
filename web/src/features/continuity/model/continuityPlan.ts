import type { ContinuityPlan } from "../../../domain/types";

const EMPTY_SOUND = {
  narration: "",
  dialogue: "",
  ambience: "",
  music_direction: "",
  prompt: "",
  storyboard_prompt_integration: false,
};

const DEFAULT_GENERATION_PREFERENCES = {
  image_model: "gpt-image-2",
  video_model: "omni_flash-10s",
  image_size: "1024x1024",
  image_quality: "standard",
  aspect_ratio: "16:9",
};

export function cloneContinuityPlan(plan: ContinuityPlan): ContinuityPlan {
  return {
    ...plan,
    series_bible: {
      ...plan.series_bible,
      taboos: [...plan.series_bible.taboos],
      locations: [...plan.series_bible.locations],
      props: [...plan.series_bible.props],
      relationship_map: [...plan.series_bible.relationship_map],
    },
    episodes: plan.episodes.map((episode) => ({
      ...episode,
      inherited_state: [...episode.inherited_state],
    })),
    story_state: {
      character_knowledge: [...plan.story_state.character_knowledge],
      character_status: [...plan.story_state.character_status],
      relationship_changes: [...plan.story_state.relationship_changes],
      active_foreshadowing: [...plan.story_state.active_foreshadowing],
      resolved_foreshadowing: [...plan.story_state.resolved_foreshadowing],
      prop_state: [...plan.story_state.prop_state],
      current_locations: [...plan.story_state.current_locations],
    },
    sound: { ...EMPTY_SOUND, ...(plan.sound ?? {}) },
    generation_preferences: {
      ...DEFAULT_GENERATION_PREFERENCES,
      ...(plan.generation_preferences ?? {}),
    },
  };
}

export function sameContinuityPlan(left: ContinuityPlan, right: ContinuityPlan): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
