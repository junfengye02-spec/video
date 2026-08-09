import type {
  AssetRecord,
  CreativeWorkflow,
  PlanSectionApproval,
  PlanSectionId,
  ShortDramaProjectResponse,
  Shot,
} from "../../domain/types";

export const PLAN_SECTION_IDS: readonly PlanSectionId[] = [
  "worldview",
  "characters",
  "scenes",
  "props",
  "sound",
  "storyboard",
];

export type BlueprintField = {
  label: string;
  value: string | string[] | null;
  prompt?: boolean;
};

export type BlueprintEntry = {
  id: string;
  title: string;
  subtitle?: string | null;
  fields: BlueprintField[];
};

export type BlueprintDocument = {
  id: PlanSectionId;
  title: string;
  description: string;
  count: number;
  entries: BlueprintEntry[];
};

export const BLUEPRINT_SECTION_COPY: Record<PlanSectionId, {
  label: string;
  shortLabel: string;
  description: string;
}> = {
  worldview: {
    label: "世界观与视觉规则",
    shortLabel: "世界观",
    description: "为人物、场景、道具与分镜提供统一的叙事边界和视觉基础。",
  },
  characters: {
    label: "人物设定",
    shortLabel: "人物",
    description: "角色定位、造型、服装、表演方向与人物提示词。",
  },
  scenes: {
    label: "场景设定",
    shortLabel: "场景",
    description: "地点、时间、光线、空间关系与场景提示词。",
  },
  props: {
    label: "关键道具",
    shortLabel: "道具",
    description: "道具外观、材质、叙事用途、连续性与生成提示词。",
  },
  sound: {
    label: "声音与配乐",
    shortLabel: "声音",
    description: "旁白、对白、环境声、音乐方向与声音提示词。",
  },
  storyboard: {
    label: "分镜规划",
    shortLabel: "分镜",
    description: "逐镜头核对节拍、景别、机位、运动、时长与画面提示词。",
  },
};

const EMPTY_SECTION: PlanSectionApproval = {
  status: "pending",
  revision: 1,
  feedback: null,
  updated_at: null,
};

const SHOT_SIZE_LABELS: Record<string, string> = {
  extreme_wide: "大远景",
  wide: "远景",
  medium_wide: "中远景",
  medium: "中景",
  medium_close: "中近景",
  close_up: "近景",
  extreme_close_up: "特写",
  over_shoulder: "过肩镜头",
  insert: "插入镜头",
  establishing: "建立镜头",
};

const CAMERA_MOVEMENT_LABELS: Record<string, string> = {
  static: "固定",
  pan_left: "向左摇摄",
  pan_right: "向右摇摄",
  tilt_up: "向上摇摄",
  tilt_down: "向下摇摄",
  dolly_in: "推近",
  dolly_out: "拉远",
  tracking_left: "向左跟拍",
  tracking_right: "向右跟拍",
  crane_up: "升镜",
  crane_down: "降镜",
  handheld: "手持",
  steadicam: "稳定器跟拍",
  whip_pan: "甩镜",
  orbital: "环绕",
  zoom_in: "变焦推近",
  zoom_out: "变焦拉远",
  rack_focus: "焦点转移",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uniqueText(values: Array<string | null | undefined>): string | null {
  const items = Array.from(new Set(values.map(text).filter((value): value is string => Boolean(value))));
  return items.length ? items.join("\n") : null;
}

function assetMatches(asset: AssetRecord, ids: Array<string | null | undefined>): boolean {
  const candidates = new Set(ids.map(text).filter((value): value is string => Boolean(value)));
  return candidates.has(asset.id) || candidates.has(asset.label);
}

function shotsForCharacter(shots: Shot[], id: string, name: string): Shot[] {
  return shots.filter((shot) => shot.characters.includes(id) || shot.characters.includes(name));
}

function shotsForProp(shots: Shot[], asset: AssetRecord): Shot[] {
  return shots.filter((shot) => (
    shot.props.includes(asset.id)
    || shot.props.includes(asset.label)
    || shot.asset_ids.includes(asset.id)
  ));
}

function shotCues(shots: Shot[]): string[] | null {
  const cues = shots.map((shot) => uniqueText([shot.beat, shot.shot_intent])).filter(
    (value): value is string => Boolean(value),
  );
  return cues.length ? cues : null;
}

function plannedAssets(snapshot: ShortDramaProjectResponse): AssetRecord[] {
  const assets = snapshot.series_bible.assets ?? [];
  const plannedIds = new Set(snapshot.creative_workflow?.planned_asset_ids ?? []);
  return plannedIds.size ? assets.filter((asset) => plannedIds.has(asset.id)) : assets;
}

function worldviewDocument(snapshot: ShortDramaProjectResponse): BlueprintDocument {
  const series = snapshot.series_bible;
  const continuity = snapshot.continuity_plan?.series_bible;
  const worldview = text(continuity?.worldview) ?? text(series.worldview);
  const visualRules = text(continuity?.visual_rules) ?? text(series.visual_rules);
  const styleLock = text(continuity?.style_lock) ?? text(series.style_lock);
  const boundaries = continuity?.taboos?.filter((item) => text(item)) ?? [];

  return {
    id: "worldview",
    title: BLUEPRINT_SECTION_COPY.worldview.label,
    description: BLUEPRINT_SECTION_COPY.worldview.description,
    count: worldview || visualRules || styleLock ? 1 : 0,
    entries: [{
      id: "worldview-foundation",
      title: "故事世界与视觉基础",
      fields: [
        { label: "时空", value: worldview },
        { label: "规则", value: styleLock },
        { label: "叙事边界", value: boundaries.length ? boundaries : null },
        { label: "主线", value: text(continuity?.main_arc) ?? text(series.main_arc) },
        { label: "视觉规则", value: visualRules ?? styleLock },
        { label: "世界观与视觉母提示词", value: uniqueText([worldview, styleLock, visualRules]), prompt: true },
      ],
    }],
  };
}

function characterDocument(snapshot: ShortDramaProjectResponse, assets: AssetRecord[]): BlueprintDocument {
  const characterAssets = assets.filter((asset) => asset.kind === "character");
  const entries = snapshot.series_bible.characters.map((character) => {
    const asset = characterAssets.find((item) => assetMatches(item, [character.id, character.name]));
    const performance = shotCues(shotsForCharacter(snapshot.storyboard.shots, character.id, character.name));
    return {
      id: character.id,
      title: character.name,
      subtitle: text(character.role),
      fields: [
        { label: "角色定位", value: text(character.role) },
        { label: "外貌锁定", value: text(character.visual_lock) },
        { label: "服装", value: text(asset?.description) ?? text(character.visual_lock) },
        { label: "表演", value: performance ?? text(character.voice) },
        // visual_lock is the character-level source of truth; legacy asset prompts can be stale.
        { label: "人物提示词", value: text(character.visual_lock), prompt: true },
      ],
    } satisfies BlueprintEntry;
  });
  return {
    id: "characters",
    title: BLUEPRINT_SECTION_COPY.characters.label,
    description: BLUEPRINT_SECTION_COPY.characters.description,
    count: entries.length,
    entries,
  };
}

function sceneDocument(assets: AssetRecord[]): BlueprintDocument {
  const entries = assets.filter((asset) => asset.kind === "scene").map((asset) => ({
    id: asset.id,
    title: asset.label,
    subtitle: text(asset.description),
    fields: [
      { label: "地点", value: text(asset.label) },
      { label: "时间", value: text(asset.description) },
      { label: "光线", value: text(asset.prompt) ?? text(asset.description) },
      { label: "空间关系", value: text(asset.description) },
      { label: "场景提示词", value: text(asset.prompt), prompt: true },
    ],
  } satisfies BlueprintEntry));
  return {
    id: "scenes",
    title: BLUEPRINT_SECTION_COPY.scenes.label,
    description: BLUEPRINT_SECTION_COPY.scenes.description,
    count: entries.length,
    entries,
  };
}

function propDocument(snapshot: ShortDramaProjectResponse, assets: AssetRecord[]): BlueprintDocument {
  const continuityProps = snapshot.continuity_plan?.series_bible.props ?? [];
  const entries = assets.filter((asset) => asset.kind === "prop").map((asset) => {
    const usage = shotCues(shotsForProp(snapshot.storyboard.shots, asset));
    const continuity = continuityProps.filter((item) => item.includes(asset.label));
    return {
      id: asset.id,
      title: asset.label,
      subtitle: text(asset.description),
      fields: [
        { label: "外观", value: text(asset.description) },
        { label: "材质", value: text(asset.prompt) },
        { label: "叙事用途", value: usage },
        { label: "连续性", value: continuity.length ? continuity : text(asset.description) },
        { label: "道具提示词", value: text(asset.prompt), prompt: true },
      ],
    } satisfies BlueprintEntry;
  });
  return {
    id: "props",
    title: BLUEPRINT_SECTION_COPY.props.label,
    description: BLUEPRINT_SECTION_COPY.props.description,
    count: entries.length,
    entries,
  };
}

function soundDocument(snapshot: ShortDramaProjectResponse): BlueprintDocument {
  const sound = snapshot.series_bible.sound_plan;
  const hasSoundPlan = Boolean(sound && Object.values(sound).some((value) => text(value)));
  return {
    id: "sound",
    title: BLUEPRINT_SECTION_COPY.sound.label,
    description: BLUEPRINT_SECTION_COPY.sound.description,
    count: hasSoundPlan ? 1 : 0,
    entries: [{
      id: "sound-plan",
      title: "声音规划",
      fields: [
        { label: "旁白", value: text(sound?.narration) },
        { label: "对白", value: text(sound?.dialogue) },
        { label: "环境声", value: text(sound?.ambience) },
        { label: "音乐方向", value: text(sound?.music_direction) },
        { label: "声音提示词", value: text(sound?.prompt), prompt: true },
      ],
    }],
  };
}

function storyboardDocument(snapshot: ShortDramaProjectResponse): BlueprintDocument {
  const shots = snapshot.storyboard.shots;
  const entries = shots.map((shot, index) => {
    const language = shot.shot_language;
    const cameraPosition = uniqueText([
      text(shot.location),
      language?.lens_mm ? `${language.lens_mm}mm 镜头` : null,
    ]);
    return {
      id: shot.id,
      title: `镜头 ${String(index + 1).padStart(2, "0")}`,
      subtitle: text(shot.beat),
      fields: [
        { label: "节拍", value: text(shot.beat) },
        { label: "景别", value: language?.shot_size ? SHOT_SIZE_LABELS[language.shot_size] ?? language.shot_size : null },
        { label: "机位", value: cameraPosition },
        { label: "运动", value: language?.camera_movement ? CAMERA_MOVEMENT_LABELS[language.camera_movement] ?? language.camera_movement : null },
        { label: "画面提示词", value: text(shot.prompt), prompt: true },
      ],
    } satisfies BlueprintEntry;
  });
  return {
    id: "storyboard",
    title: BLUEPRINT_SECTION_COPY.storyboard.label,
    description: BLUEPRINT_SECTION_COPY.storyboard.description,
    count: entries.length,
    entries,
  };
}

export function blueprintDocuments(snapshot: ShortDramaProjectResponse): Record<PlanSectionId, BlueprintDocument> {
  const assets = plannedAssets(snapshot);
  const documents = [
    worldviewDocument(snapshot),
    characterDocument(snapshot, assets),
    sceneDocument(assets),
    propDocument(snapshot, assets),
    soundDocument(snapshot),
    storyboardDocument(snapshot),
  ];
  return Object.fromEntries(documents.map((document) => [document.id, document])) as Record<PlanSectionId, BlueprintDocument>;
}

export function planSectionsFor(workflow: CreativeWorkflow): Record<PlanSectionId, PlanSectionApproval> {
  const fallbackStatus = workflow.phase === "approved" ? "approved" : "pending";
  return Object.fromEntries(PLAN_SECTION_IDS.map((section) => [
    section,
    workflow.plan_sections?.[section] ?? { ...EMPTY_SECTION, status: fallbackStatus },
  ])) as Record<PlanSectionId, PlanSectionApproval>;
}

export function affectedSectionLabels(section: PlanSectionId, soundAffectsStoryboard: boolean): string[] {
  const dependencies: Record<PlanSectionId, PlanSectionId[]> = {
    worldview: ["worldview", "characters", "scenes", "props", "storyboard"],
    characters: ["characters", "storyboard"],
    scenes: ["scenes", "storyboard"],
    props: ["props", "storyboard"],
    sound: soundAffectsStoryboard ? ["sound", "storyboard"] : ["sound"],
    storyboard: ["storyboard"],
  };
  return dependencies[section].map((id) => BLUEPRINT_SECTION_COPY[id].shortLabel);
}
