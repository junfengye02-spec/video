import type {
  ContinuityPlan,
  ProjectType,
  ShortDramaProjectResponse,
  Shot,
} from "../domain/types";

export function createShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: "shot-1",
    scene_id: "scene-1",
    index: 1,
    beat: "发现信封",
    prompt: "雨夜巷口，玛拉发现一封信",
    characters: ["char-1"],
    location: "雨巷",
    props: ["信封"],
    shot_intent: "建立悬念",
    shot_language: { shot_size: "medium_close", camera_movement: "dolly_in" },
    status: "ready",
    consistency_score: 100,
    output_url: null,
    output_path: null,
    asset_ids: [],
    version: 1,
    history: [],
    ...overrides,
  };
}

export function createContinuityPlan(projectType: ProjectType): ContinuityPlan {
  return {
    project_type: projectType,
    active_episode_number: projectType === "single_video" ? null : 1,
    series_bible: {
      worldview: "近未来沿海城市",
      main_arc: "找出匿名信的寄件人",
      style_lock: "冷色写实悬疑",
      visual_rules: "角色服装和主色保持一致",
      taboos: [],
      locations: ["雨巷"],
      props: ["信封"],
      relationship_map: ["玛拉与林警官互不信任"],
    },
    episodes: projectType === "single_video"
      ? []
      : [{
          episode_number: 1,
          title: "匿名信",
          goal: "查明来信目的",
          conflict: "线索互相矛盾",
          twist: "寄件人就在身边",
          cliffhanger: "第二封信出现",
          inherited_state: [],
          locked: false,
        }],
    story_state: {
      character_knowledge: [],
      relationship_changes: [],
      active_foreshadowing: [],
      resolved_foreshadowing: [],
      prop_state: ["信封尚未拆开"],
      character_status: ["玛拉保持警惕"],
      current_locations: ["雨巷"],
    },
  };
}

export function createProjectResponse(
  options: { projectType?: ProjectType; shotCount?: number } = {},
): ShortDramaProjectResponse {
  const projectType = options.projectType ?? "single_video";
  const shotCount = options.shotCount ?? 2;
  return {
    project: { id: "p1", title: "雨夜来信", mode: "short_drama", project_type: projectType },
    series_bible: {
      title: "雨夜来信",
      mode: "short_drama",
      style_lock: "冷色写实悬疑",
      characters: [{
        id: "char-1",
        name: "玛拉",
        role: "调查者",
        visual_lock: "红色风衣，短发",
        voice: null,
        reference_images: [],
        locked: true,
      }],
      assets: [{
        id: "asset-char-1",
        kind: "character",
        label: "玛拉",
        description: "红色风衣角色参考",
        prompt: "红色风衣，短发，冷色写实",
        reference_images: ["assets/images/character/mara.png"],
        media_urls: [],
        shot_ids: [],
        version: 1,
      }],
    },
    storyboard: {
      shots: Array.from({ length: shotCount }, (_, index) => createShot({
        id: `shot-${index + 1}`,
        index: index + 1,
        beat: `分镜 ${index + 1}`,
      })),
    },
    consistency_report: { score: 100, issues: [] },
    continuity_plan: createContinuityPlan(projectType),
    workflow_artifacts: [{ name: "storyboard.json", path: "storyboard.json", exists: true }],
    render_report: null,
    final_path: null,
  };
}
