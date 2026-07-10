import type { ShortDramaProjectResponse } from "../domain/types";

const PROJECT_MODES = ["short_drama", "general_video"] as const;
const PROJECT_TYPES = ["single_video", "mini_series", "long_series"] as const;
const ASSET_KINDS = ["character", "scene", "prop"] as const;
const SHOT_STATUSES = ["draft", "ready", "generating", "complete", "failed"] as const;
const SHOT_SIZES = [
  "extreme_wide",
  "wide",
  "medium_wide",
  "medium",
  "medium_close",
  "close_up",
  "extreme_close_up",
  "over_shoulder",
  "insert",
  "establishing",
] as const;
const CAMERA_MOVEMENTS = [
  "static",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "dolly_in",
  "dolly_out",
  "tracking_left",
  "tracking_right",
  "crane_up",
  "crane_down",
  "handheld",
  "steadicam",
  "whip_pan",
  "orbital",
  "zoom_in",
  "zoom_out",
  "rack_focus",
] as const;
const LIGHTING_KEYS = [
  "high_key",
  "low_key",
  "natural",
  "golden_hour",
  "blue_hour",
  "tungsten_warm",
  "neon",
  "silhouette",
  "rim_lit",
  "volumetric",
  "overcast_soft",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEnum<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isOptionalSafeInteger(value: unknown): boolean {
  return value === undefined || Number.isSafeInteger(value);
}

function isProjectType(value: unknown): boolean {
  return isEnum(value, PROJECT_TYPES);
}

function isCharacter(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.role === "string" &&
    typeof value.visual_lock === "string" &&
    isNullableString(value.voice) &&
    isStringArray(value.reference_images) &&
    typeof value.locked === "boolean"
  );
}

function isAsset(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    isEnum(value.kind, ASSET_KINDS) &&
    typeof value.label === "string" &&
    isOptionalString(value.description) &&
    isOptionalString(value.prompt) &&
    isStringArray(value.reference_images) &&
    isOptionalStringArray(value.media_urls) &&
    isOptionalStringArray(value.shot_ids) &&
    isOptionalSafeInteger(value.version)
  );
}

function isShotLanguage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.shot_size === undefined || value.shot_size === null || isEnum(value.shot_size, SHOT_SIZES)) &&
    (value.camera_movement === undefined ||
      value.camera_movement === null ||
      isEnum(value.camera_movement, CAMERA_MOVEMENTS)) &&
    (value.lens_mm === undefined ||
      value.lens_mm === null ||
      [14, 24, 35, 50, 85, 135, 200].includes(value.lens_mm as number)) &&
    (value.lighting_key === undefined ||
      value.lighting_key === null ||
      isEnum(value.lighting_key, LIGHTING_KEYS)) &&
    (value.depth_of_field === undefined ||
      value.depth_of_field === null ||
      isEnum(value.depth_of_field, ["shallow", "medium", "deep"] as const)) &&
    (value.color_temperature === undefined ||
      value.color_temperature === null ||
      isEnum(value.color_temperature, ["cool", "neutral", "warm", "mixed"] as const))
  );
}

function isOptionalShotLanguage(value: unknown): boolean {
  return value === undefined || value === null || isShotLanguage(value);
}

function isShotRevision(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.version) &&
    isEnum(value.source, ["create", "prompt_edit", "regenerate"] as const) &&
    typeof value.prompt === "string" &&
    isStringArray(value.characters) &&
    isNullableString(value.location) &&
    isStringArray(value.props) &&
    isStringArray(value.asset_ids) &&
    (value.shot_intent === undefined || isNullableString(value.shot_intent)) &&
    isOptionalShotLanguage(value.shot_language) &&
    typeof value.updated_at === "string"
  );
}

function isShot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.scene_id === "string" &&
    Number.isSafeInteger(value.index) &&
    typeof value.beat === "string" &&
    typeof value.prompt === "string" &&
    isStringArray(value.characters) &&
    isNullableString(value.location) &&
    isStringArray(value.props) &&
    (value.shot_intent === undefined || isNullableString(value.shot_intent)) &&
    isOptionalShotLanguage(value.shot_language) &&
    isEnum(value.status, SHOT_STATUSES) &&
    typeof value.consistency_score === "number" &&
    Number.isFinite(value.consistency_score) &&
    isNullableString(value.output_url) &&
    isNullableString(value.output_path) &&
    isStringArray(value.asset_ids) &&
    Number.isSafeInteger(value.version) &&
    Array.isArray(value.history) &&
    value.history.every(isShotRevision) &&
    isOptionalString(value.aspect_ratio) &&
    isOptionalString(value.visual_style)
  );
}

function isConsistencyIssue(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNullableString(value.shot_id) &&
    isEnum(value.severity, ["info", "warning", "error"] as const) &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

function isContinuitySeriesBible(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.worldview === "string" &&
    typeof value.main_arc === "string" &&
    typeof value.style_lock === "string" &&
    typeof value.visual_rules === "string" &&
    isStringArray(value.taboos) &&
    isStringArray(value.locations) &&
    isStringArray(value.props) &&
    isStringArray(value.relationship_map)
  );
}

function isEpisode(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.episode_number) &&
    typeof value.title === "string" &&
    typeof value.goal === "string" &&
    typeof value.conflict === "string" &&
    typeof value.twist === "string" &&
    typeof value.cliffhanger === "string" &&
    isStringArray(value.inherited_state) &&
    typeof value.locked === "boolean"
  );
}

function isStoryState(value: unknown): boolean {
  return (
    isRecord(value) &&
    isStringArray(value.character_knowledge) &&
    isStringArray(value.relationship_changes) &&
    isStringArray(value.active_foreshadowing) &&
    isStringArray(value.resolved_foreshadowing) &&
    isStringArray(value.prop_state) &&
    isStringArray(value.character_status) &&
    isStringArray(value.current_locations)
  );
}

function isContinuityPlan(value: unknown): boolean {
  return (
    isRecord(value) &&
    isProjectType(value.project_type) &&
    (value.active_episode_number === null || Number.isSafeInteger(value.active_episode_number)) &&
    isContinuitySeriesBible(value.series_bible) &&
    Array.isArray(value.episodes) &&
    value.episodes.every(isEpisode) &&
    isStoryState(value.story_state)
  );
}

function isWorkflowArtifact(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.path === "string" &&
    typeof value.exists === "boolean"
  );
}

function isRenderOutput(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    (value.media_url === undefined || isNullableString(value.media_url)) &&
    typeof value.format === "string" &&
    typeof value.resolution === "string" &&
    typeof value.duration_seconds === "number" &&
    Number.isFinite(value.duration_seconds)
  );
}

function isRenderReport(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.version === "1.0" &&
    Array.isArray(value.outputs) &&
    value.outputs.every(isRenderOutput) &&
    isOptionalStringArray(value.warnings) &&
    isOptionalStringArray(value.verification_notes)
  );
}

function normalizeProjectType(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.project) || value.project.project_type !== undefined) return value;
  const continuityType = isRecord(value.continuity_plan)
    ? value.continuity_plan.project_type
    : undefined;
  return {
    ...value,
    project: {
      ...value.project,
      project_type: isProjectType(continuityType) ? continuityType : "single_video",
    },
  };
}

function isCompleteSnapshot(value: unknown): value is ShortDramaProjectResponse {
  if (!isRecord(value) || !isRecord(value.project) || !isRecord(value.series_bible)) return false;
  return (
    typeof value.project.id === "string" &&
    value.project.id.length > 0 &&
    typeof value.project.title === "string" &&
    value.project.title.length > 0 &&
    isEnum(value.project.mode, PROJECT_MODES) &&
    isProjectType(value.project.project_type) &&
    isOptionalString(value.project.created_at) &&
    isOptionalString(value.project.updated_at) &&
    isOptionalString(value.series_bible.title) &&
    (value.series_bible.mode === undefined || isEnum(value.series_bible.mode, PROJECT_MODES)) &&
    isOptionalString(value.series_bible.style_lock) &&
    Array.isArray(value.series_bible.characters) &&
    value.series_bible.characters.every(isCharacter) &&
    (value.series_bible.assets === undefined ||
      (Array.isArray(value.series_bible.assets) && value.series_bible.assets.every(isAsset))) &&
    isRecord(value.storyboard) &&
    Array.isArray(value.storyboard.shots) &&
    value.storyboard.shots.every(isShot) &&
    isRecord(value.consistency_report) &&
    typeof value.consistency_report.score === "number" &&
    Number.isFinite(value.consistency_report.score) &&
    Array.isArray(value.consistency_report.issues) &&
    value.consistency_report.issues.every(isConsistencyIssue) &&
    (value.continuity_plan === undefined ||
      value.continuity_plan === null ||
      isContinuityPlan(value.continuity_plan)) &&
    (value.workflow_artifacts === undefined ||
      (Array.isArray(value.workflow_artifacts) && value.workflow_artifacts.every(isWorkflowArtifact))) &&
    (value.render_report === undefined ||
      value.render_report === null ||
      isRenderReport(value.render_report)) &&
    (value.final_path === undefined || isNullableString(value.final_path))
  );
}

export function normalizeAndValidateProjectSnapshot(value: unknown): ShortDramaProjectResponse {
  if (!isRecord(value)) throw new Error("Backup project metadata is invalid");
  const normalized = normalizeProjectType(value);
  if (!isCompleteSnapshot(normalized)) {
    throw new Error("Backup project metadata is invalid");
  }
  if (
    normalized.continuity_plan &&
    normalized.project.project_type !== normalized.continuity_plan.project_type
  ) {
    throw new Error("Backup project metadata is invalid: project types disagree");
  }
  return normalized;
}
