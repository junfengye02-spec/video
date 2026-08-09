import type { ShortDramaProjectResponse } from "../domain/types";

const PROJECT_MODES = ["short_drama", "general_video"] as const;
const PROJECT_TYPES = ["single_video", "mini_series", "long_series"] as const;
const ASSET_KINDS = ["character", "scene", "prop"] as const;
const ASSET_SOURCE_TYPES = ["upload", "ai_generated", "video_frame"] as const;
const ASSET_STATUSES = ["ready", "missing", "stale", "deleted"] as const;
const SHOT_STATUSES = ["draft", "ready", "generating", "complete", "failed", "stale"] as const;
const CONTINUITY_MODES = ["carry", "cut", "match_cut"] as const;
const FRAME_STATUSES = ["ready", "generating", "failed", "stale"] as const;
const FRAME_SOURCES = ["user", "video_extract", "ai_generated", "inherited"] as const;
const VIDEO_OPERATIONS = [
  "text_to_video",
  "image_to_video",
  "first_last_frame_to_video",
  "extend",
] as const;
const GENERATION_UNIT_STATUSES = [
  "planned",
  "queued",
  "running",
  "waiting_provider",
  "complete",
  "failed",
  "stale",
] as const;
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

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || isNullableString(value);
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isOptionalSafeInteger(value: unknown): boolean {
  return value === undefined || Number.isSafeInteger(value);
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOptionalNullablePositiveNumber(value: unknown): boolean {
  return value === undefined
    || value === null
    || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

function isNullablePositiveNumber(value: unknown): boolean {
  return value === null
    || (typeof value === "number" && Number.isFinite(value) && value > 0);
}

function isOptionalDurationRange(value: unknown): boolean {
  return value === undefined
    || value === null
    || (
      Array.isArray(value)
      && value.length === 2
      && value.every((item) => typeof item === "number" && Number.isFinite(item) && item > 0)
      && Number(value[0]) <= Number(value[1])
    );
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
  if (!isRecord(value)) return false;
  const provenanceValid = value.provenance === undefined
    || value.provenance === null
    || isVideoFrameProvenance(value.provenance);
  const sourceValid = value.source_type === undefined
    || isEnum(value.source_type, ASSET_SOURCE_TYPES);
  const provenanceMatchesSource = value.source_type === "video_frame"
    ? isVideoFrameProvenance(value.provenance)
    : value.provenance === undefined || value.provenance === null;
  return (
    typeof value.id === "string" &&
    isEnum(value.kind, ASSET_KINDS) &&
    typeof value.label === "string" &&
    isOptionalString(value.description) &&
    isOptionalString(value.prompt) &&
    isStringArray(value.reference_images) &&
    isOptionalStringArray(value.media_urls) &&
    isOptionalStringArray(value.shot_ids) &&
    isOptionalSafeInteger(value.version) &&
    isOptionalString(value.origin_project_id) &&
    sourceValid &&
    isOptionalNullableString(value.model) &&
    isOptionalNullableString(value.generation_job_id) &&
    isOptionalString(value.media_url) &&
    (value.status === undefined || isEnum(value.status, ASSET_STATUSES)) &&
    isOptionalString(value.created_at) &&
    provenanceValid &&
    provenanceMatchesSource
  );
}

function isVideoFrameProvenance(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.shot_id === "string" &&
    value.shot_id.length > 0 &&
    Number.isSafeInteger(value.video_version) &&
    Number(value.video_version) >= 1 &&
    typeof value.media_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.media_sha256) &&
    typeof value.sample_time_seconds === "number" &&
    Number.isFinite(value.sample_time_seconds) &&
    value.sample_time_seconds >= 0
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

function isShotFrameReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.asset_id === "string" &&
    value.asset_id.length > 0 &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) >= 1 &&
    isEnum(value.status, FRAME_STATUSES) &&
    isEnum(value.source, FRAME_SOURCES) &&
    isOptionalNullableString(value.generation_job_id) &&
    isOptionalNullableString(value.origin_shot_id) &&
    (value.origin_shot_version === undefined
      || value.origin_shot_version === null
      || (Number.isSafeInteger(value.origin_shot_version) && Number(value.origin_shot_version) >= 1)) &&
    (value.origin_frame_version === undefined
      || value.origin_frame_version === null
      || (Number.isSafeInteger(value.origin_frame_version) && Number(value.origin_frame_version) >= 1))
  );
}

function isShotContinuity(value: unknown): boolean {
  return (
    isRecord(value) &&
    isEnum(value.mode, CONTINUITY_MODES) &&
    typeof value.inherit_previous_tail === "boolean" &&
    isNullableString(value.explicit_user_first_frame_asset_id) &&
    isNullableString(value.inherited_first_frame_asset_id) &&
    isNullableString(value.last_frame_asset_id) &&
    (value.first_frame === null || isShotFrameReference(value.first_frame)) &&
    (value.last_frame === null || isShotFrameReference(value.last_frame)) &&
    typeof value.stale === "boolean" &&
    isOptionalString(value.composition) &&
    isOptionalString(value.subject_pose) &&
    isOptionalString(value.gaze) &&
    isOptionalString(value.motion_direction) &&
    isOptionalString(value.lighting) &&
    isOptionalString(value.scene_state)
  );
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
    (value.continuity === undefined || isShotContinuity(value.continuity)) &&
    isOptionalNullableString(value.beat_id) &&
    isOptionalNullablePositiveNumber(value.recommended_duration_seconds) &&
    isOptionalDurationRange(value.duration_range_seconds) &&
    isOptionalBoolean(value.can_merge_with_next) &&
    isOptionalBoolean(value.must_complete_action) &&
    isOptionalBoolean(value.must_preserve_emotion) &&
    isOptionalNullableString(value.cannot_split_reason) &&
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
    (value.episode_number === undefined ||
      value.episode_number === null ||
      (Number.isSafeInteger(value.episode_number) && Number(value.episode_number) >= 1)) &&
    isOptionalNullableString(value.beat_id) &&
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
    (value.continuity === undefined || isShotContinuity(value.continuity)) &&
    isOptionalNullablePositiveNumber(value.recommended_duration_seconds) &&
    isOptionalDurationRange(value.duration_range_seconds) &&
    isOptionalBoolean(value.can_merge_with_next) &&
    isOptionalBoolean(value.must_complete_action) &&
    isOptionalBoolean(value.must_preserve_emotion) &&
    isOptionalNullableString(value.cannot_split_reason) &&
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

function isNarrativeBeat(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    Number.isSafeInteger(value.index) &&
    Number(value.index) >= 1 &&
    typeof value.summary === "string" &&
    value.summary.length > 0 &&
    typeof value.recommended_duration_seconds === "number" &&
    Number.isFinite(value.recommended_duration_seconds) &&
    value.recommended_duration_seconds > 0 &&
    isOptionalDurationRange(value.duration_range_seconds) &&
    value.duration_range_seconds !== undefined &&
    value.duration_range_seconds !== null &&
    typeof value.can_merge_with_next === "boolean" &&
    typeof value.must_complete_action === "boolean" &&
    typeof value.must_preserve_emotion === "boolean" &&
    isNullableString(value.cannot_split_reason)
  );
}

function hasValidNarrativeBeats(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value)) return false;
  const brief = value.brief;
  if (brief === undefined || brief === null) return true;
  if (!isRecord(brief)) return false;
  return brief.narrative_beats === undefined
    || (Array.isArray(brief.narrative_beats) && brief.narrative_beats.every(isNarrativeBeat));
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
    (value.episode_number === undefined ||
      value.episode_number === null ||
      (Number.isSafeInteger(value.episode_number) && Number(value.episode_number) >= 1)) &&
    (value.episode_title === undefined || isNullableString(value.episode_title)) &&
    isOptionalStringArray(value.shot_ids) &&
    typeof value.format === "string" &&
    typeof value.resolution === "string" &&
    typeof value.duration_seconds === "number" &&
    Number.isFinite(value.duration_seconds) &&
    (value.file_size_bytes === undefined
      || (Number.isSafeInteger(value.file_size_bytes) && Number(value.file_size_bytes) >= 0))
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

function isGenerationPromptSegment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const current = (
    typeof value.id === "string" && value.id.length > 0 &&
    typeof value.source_shot_id === "string" && value.source_shot_id.length > 0 &&
    typeof value.source_beat_id === "string" && value.source_beat_id.length > 0 &&
    Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 1 &&
    Number.isSafeInteger(value.segment_index) && Number(value.segment_index) >= 1 &&
    Number.isSafeInteger(value.segment_count) && Number(value.segment_count) >= 1 &&
    isNullablePositiveNumber(value.recommended_content_duration_seconds) &&
    typeof value.prompt === "string" && value.prompt.length > 0 &&
    isEnum(value.transition, ["continuous", "cut", "match_cut"] as const) &&
    isStringArray(value.continuity_requirements) &&
    typeof value.start_state === "string" && value.start_state.length > 0 &&
    typeof value.action_progress === "string" && value.action_progress.length > 0 &&
    typeof value.end_state === "string" && value.end_state.length > 0
  );
  if (current) return true;

  // Preserve imports created before generation segments became first-class records.
  return (
    typeof value.shot_id === "string" &&
    typeof value.beat_id === "string" &&
    typeof value.prompt === "string" &&
    isNullablePositiveNumber(value.recommended_duration_seconds) &&
    isEnum(value.transition, ["continuous", "cut", "match_cut"] as const)
  );
}

function isGenerationExecutionUnit(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.source_shot_versions)) return false;
  const sourceShotIds = value.source_shot_ids;
  const versionEntries = Object.entries(value.source_shot_versions);
  return (
    typeof value.id === "string" && value.id.length > 0 &&
    typeof value.plan_id === "string" && /^[0-9a-f]{64}$/.test(value.plan_id) &&
    Number.isSafeInteger(value.revision) && Number(value.revision) >= 1 &&
    isEnum(value.status, GENERATION_UNIT_STATUSES) &&
    (value.active === undefined || typeof value.active === "boolean") &&
    isStringArray(sourceShotIds) && sourceShotIds.length > 0 &&
    versionEntries.length === sourceShotIds.length &&
    versionEntries.every(([shotId, version]) =>
      sourceShotIds.includes(shotId) && Number.isSafeInteger(version) && Number(version) >= 1) &&
    isStringArray(value.source_beat_ids) &&
    value.source_beat_ids.length === sourceShotIds.length &&
    (value.source_segment_ids === undefined || isStringArray(value.source_segment_ids)) &&
    (value.prompt_segments === undefined || (
      Array.isArray(value.prompt_segments) &&
      value.prompt_segments.every(isGenerationPromptSegment)
    )) &&
    typeof value.provider === "string" &&
    typeof value.model_id === "string" &&
    isEnum(value.operation, VIDEO_OPERATIONS) &&
    (value.profile_revision === undefined || typeof value.profile_revision === "string") &&
    (value.profile === undefined || isRecord(value.profile)) &&
    isNullablePositiveNumber(value.requested_duration_seconds) &&
    isNullablePositiveNumber(value.source_duration_seconds) &&
    isNullablePositiveNumber(value.timeline_duration_seconds) &&
    isNullableString(value.output_asset_id) &&
    isNullableString(value.output_path) &&
    isNullableString(value.task_item_id) &&
    isNullableString(value.billing_job_id) &&
    isNullableString(value.replaces_unit_id) &&
    (value.diagnostics === undefined || isRecord(value.diagnostics)) &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isGenerationExecution(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.version === "1.0" &&
    typeof value.project_id === "string" &&
    typeof value.updated_at === "string" &&
    isStringArray(value.active_generation_unit_ids) &&
    Array.isArray(value.generation_units) &&
    value.generation_units.every(isGenerationExecutionUnit)
  );
}

function normalizeProjectType(value: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(value.project)) return value;
  const continuityType = isRecord(value.continuity_plan)
    ? value.continuity_plan.project_type
    : undefined;
  const projectType = value.project.project_type !== undefined
    ? value.project.project_type
    : isProjectType(continuityType)
      ? continuityType
      : "single_video";
  const seriesBible = isRecord(value.series_bible) ? value.series_bible : null;
  const normalizedSeriesMode = seriesBible
    && seriesBible.mode !== undefined
    && !isEnum(seriesBible.mode, PROJECT_MODES)
    && isEnum(value.project.mode, PROJECT_MODES)
    ? value.project.mode
    : seriesBible?.mode;
  return {
    ...value,
    project: {
      ...value.project,
      project_type: projectType,
    },
    ...(seriesBible
      ? { series_bible: { ...seriesBible, mode: normalizedSeriesMode } }
      : {}),
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
    hasValidNarrativeBeats(value.creative_workflow) &&
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
    (value.generation_execution === undefined ||
      value.generation_execution === null ||
      isGenerationExecution(value.generation_execution)) &&
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
