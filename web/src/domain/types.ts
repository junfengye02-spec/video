export type ProjectMode = "short_drama" | "general_video";
export type ProjectType = "single_video" | "mini_series" | "long_series";

export interface Project {
  id: string;
  title: string;
  mode: ProjectMode;
  project_type?: ProjectType;
  created_at?: string;
  updated_at?: string;
}

export interface Character {
  id: string;
  name: string;
  role: string;
  visual_lock: string;
  voice: string | null;
  reference_images: string[];
  locked: boolean;
}

export interface AssetRecord {
  id: string;
  kind: "character" | "scene" | "prop";
  label: string;
  description?: string;
  prompt?: string;
  reference_images: string[];
  media_urls?: string[];
  shot_ids?: string[];
  version?: number;
  origin_project_id?: string;
  source_type?: MediaAssetSourceType;
  model?: string | null;
  generation_job_id?: string | null;
  media_asset_id?: string | null;
  media_url?: string;
  status?: MediaAssetStatus;
  created_at?: string;
  provenance?: VideoFrameProvenance | null;
  planned?: boolean;
}

export type MediaAssetKind = "character" | "scene" | "prop";
export type MediaAssetSourceType = "upload" | "ai_generated" | "video_frame";
export type MediaAssetStatus = "ready" | "missing" | "stale" | "deleted";

export interface VideoFrameProvenance {
  shot_id: string;
  video_version: number;
  media_sha256: string;
  sample_time_seconds: number;
}

export interface MediaAsset {
  id: string;
  origin_project_id: string;
  kind: MediaAssetKind;
  source_type: MediaAssetSourceType;
  label: string;
  description: string;
  prompt: string;
  model: string | null;
  generation_job_id: string | null;
  provenance?: VideoFrameProvenance | null;
  media_url: string;
  status: MediaAssetStatus;
  created_at: string;
}

export interface ListAssetsRequest {
  scope: "all" | "project";
  project_id?: string;
  kind?: MediaAssetKind;
  source_type?: MediaAssetSourceType;
  cursor?: string;
  limit?: number;
}

export interface ListAssetsResponse {
  assets: MediaAsset[];
  next_cursor: string | null;
}

export interface GenerateImagesRequest {
  kind: MediaAssetKind;
  label: string;
  description: string;
  prompt: string;
  model: string;
  count: number;
  size: string;
  quality: string;
  billing_job_id?: string;
  resource_ids?: string[];
  shot_id?: string;
  frame_target?: "first" | "last";
  idempotency_key?: string;
}

export type TaskItemStatus = "queued" | "running" | "awaiting_payment"
  | "waiting_dependency" | "waiting_provider" | "complete" | "failed" | "cancelled";
export type TaskBatchStatus = TaskItemStatus | "partial_failure";

export interface TaskDependency {
  item_id: string;
  status: TaskItemStatus;
}

export interface TaskItem {
  id: string;
  batch_id: string;
  position: number;
  task_type: string;
  status: TaskItemStatus;
  idempotency_key: string;
  input: Record<string, unknown>;
  target_entity_type: string | null;
  target_entity_id: string | null;
  target_entity_version: number | null;
  attempt_count: number;
  max_attempts: number;
  progress: number;
  retryable: boolean;
  error_code: string | null;
  error_message: string | null;
  result: Record<string, unknown> | null;
  billing_job_id: string | null;
  provider_wait_started_at: string | null;
  provider_next_poll_at: string | null;
  provider_poll_count: number;
  dependencies: TaskDependency[];
  created_at: string;
  updated_at: string;
}

export interface TaskBatch {
  id: string;
  project_id: string;
  task_type: string;
  status: TaskBatchStatus;
  idempotency_key: string;
  snapshot?: Record<string, unknown>;
  progress: number;
  total_items: number;
  completed_items: number;
  failed_items: number;
  error_code: string | null;
  error_message: string | null;
  billing_job_id?: string | null;
  created_at: string;
  updated_at: string;
  items: TaskItem[] | null;
}

export interface TaskAcceptedResponse {
  task_id: string;
  status: TaskBatchStatus;
  deduplicated: boolean;
  task: TaskBatch;
}

export type GenerateImagesResponse = TaskAcceptedResponse;

export type GenerationCapability = "text" | "image" | "video";

export type VideoOperation = "text_to_video" | "image_to_video"
  | "first_last_frame_to_video" | "extend";

export const GENERATION_UNITS_CONTRACT_VERSION = 2 as const;

export interface VideoModelProfile {
  provider: string;
  model_id: string;
  operation: VideoOperation;
  duration_mode: "fixed" | "supported_values" | "flexible" | "unknown";
  fixed_duration_seconds: number | null;
  supported_duration_seconds: number[];
  min_duration_seconds: number | null;
  max_duration_seconds: number | null;
  supports_start_frame: boolean;
  supports_end_frame: boolean;
  supports_extend: boolean;
  supports_sequential_beats?: boolean;
  supports_multi_shot_prompt: boolean;
  max_narrative_beats_per_unit?: number;
  max_reference_images?: number | null;
  contract_source: "provider_catalog" | "verified_override" | "admin_configuration";
  profile_revision: string;
  duration_configuration_status: "configured" | "unconfigured";
}

export interface GenerationModelsResponse {
  capability: GenerationCapability;
  models: string[];
  profiles?: VideoModelProfile[];
}

export interface GenerationPlanIssue {
  code: string;
  message: string;
  shot_id: string | null;
  unit_id: string | null;
}

export type GenerationUnitStatus = "planned" | "queued" | "running"
  | "waiting_provider" | "complete" | "failed" | "stale";

export interface GenerationPromptSegment {
  id: string;
  source_shot_id: string;
  source_beat_id: string;
  sequence: number;
  segment_index: number;
  segment_count: number;
  recommended_content_duration_seconds: number | null;
  prompt: string;
  transition: "continuous" | "cut" | "match_cut";
  continuity_requirements: string[];
  start_state: string;
  action_progress: string;
  end_state: string;
}

export interface GenerationUnit {
  id: string;
  revision: number;
  status: GenerationUnitStatus;
  shot_ids: string[];
  source_shot_ids: string[];
  source_beat_ids: string[];
  source_segment_ids: string[];
  prompt_segments: GenerationPromptSegment[];
  provider: string;
  model_id: string;
  operation: VideoOperation;
  requested_duration_seconds: number | null;
  source_duration_seconds: number | null;
  timeline_duration_seconds: number | null;
  output_asset_id: string | null;
  output_path: string | null;
  billing_job_id: string | null;
  task_item_id: string | null;
  replaces_unit_id: string | null;
  profile: VideoModelProfile;
}

export interface GenerationPlan {
  version: "1.0";
  id: string;
  storyboard_revision: string;
  provider: string;
  model_id: string;
  shot_ids: string[];
  storyboard_shot_count: number;
  generation_unit_count: number;
  protected_generation_unit_ids: string[];
  pending_shot_ids: string[];
  covered_shot_ids: string[];
  covered_segment_ids: string[];
  target_duration_seconds: number | null;
  native_total_duration_seconds: number | null;
  timeline_total_duration_seconds: number | null;
  duration_difference_seconds: number | null;
  compatible_with_target: boolean;
  requires_confirmation: boolean;
  can_generate: boolean;
  confirmed_strategy: "accept_model_duration" | "accept_longer_duration" | null;
  issues: GenerationPlanIssue[];
  adaptation_options: string[];
  generation_segments: GenerationPromptSegment[];
  generation_units: GenerationUnit[];
}

export interface GenerationPlanPreviewRequest {
  contract_version?: typeof GENERATION_UNITS_CONTRACT_VERSION;
  video_model: string;
  text_model?: string;
  operation?: VideoOperation;
  shot_ids: string[];
  regenerate_unit_ids?: string[];
  confirmed_strategy?: "accept_model_duration" | "accept_longer_duration";
}

export interface GenerationExecutionUnit {
  id: string;
  plan_id: string;
  revision: number;
  status: GenerationUnitStatus;
  active?: boolean;
  source_shot_ids: string[];
  source_shot_versions: Record<string, number>;
  source_beat_ids: string[];
  source_segment_ids: string[];
  prompt_segments?: GenerationPromptSegment[];
  provider: string;
  model_id: string;
  operation: VideoOperation;
  profile_revision?: string;
  profile?: VideoModelProfile;
  requested_duration_seconds: number | null;
  source_duration_seconds: number | null;
  timeline_duration_seconds: number | null;
  output_asset_id: string | null;
  output_path: string | null;
  task_item_id: string | null;
  billing_job_id: string | null;
  replaces_unit_id: string | null;
  diagnostics?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface GenerationExecutionSnapshot {
  version: "1.0";
  project_id: string;
  updated_at: string;
  active_generation_unit_ids: string[];
  generation_units: GenerationExecutionUnit[];
}

export interface GenerationUnitsGenerateRequest {
  contract_version?: typeof GENERATION_UNITS_CONTRACT_VERSION;
  generation_plan_id: string;
  generation_unit_ids: string[];
  idempotency_key: string;
}

export type GenerationUnitsGenerateResponse = TaskAcceptedResponse;

export type CompositionAcceptedResponse = GenerateImagesResponse;
export type RegenerateShotAcceptedResponse = TaskAcceptedResponse;

export interface TaskListResponse {
  tasks: TaskBatch[];
}

export interface AddAssetToProjectResponse {
  asset: AssetRecord;
  library_asset: MediaAsset;
}

export interface SeriesBible {
  title?: string;
  mode?: ProjectMode;
  style_lock?: string;
  project_brief?: string;
  worldview?: string;
  main_arc?: string;
  visual_rules?: string;
  series_prompt?: string;
  relationship_map?: string[];
  sound_plan?: SoundPlan | null;
  characters: Character[];
  assets?: AssetRecord[];
}

export interface SoundPlan {
  narration: string;
  dialogue: string;
  ambience: string;
  music_direction: string;
  prompt: string;
  storyboard_prompt_integration: boolean;
}

export interface InspirationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface NarrativeBeat {
  id: string;
  index: number;
  summary: string;
  recommended_duration_seconds: number;
  duration_range_seconds: [number, number];
  can_merge_with_next: boolean;
  must_complete_action: boolean;
  must_preserve_emotion: boolean;
  cannot_split_reason: string | null;
}

export interface CreativeBrief {
  title: string;
  logline: string;
  audience: string;
  format: string;
  duration_seconds: number | null;
  aspect_ratio: string;
  genre: string;
  tone: string;
  visual_style: string;
  story_outline: string;
  must_have: string[];
  open_questions: string[];
  narrative_beats?: NarrativeBeat[];
}

export type CreativeWorkflowPhase = "inspiration" | "plan_review" | "approved";

export type PlanSectionId =
  | "worldview"
  | "characters"
  | "scenes"
  | "props"
  | "sound"
  | "storyboard";

export type PlanSectionStatus = "pending" | "approved" | "changes_requested";

export interface PlanSectionApproval {
  status: PlanSectionStatus;
  revision: number;
  feedback: string | null;
  updated_at: string | null;
}

export interface StoryboardRevisionSession {
  section: "storyboard";
  source: "generation_plan_duration";
  started_at: string;
  original_approved_at: string | null;
  section_revision: number;
}

export interface CreativeWorkflow {
  phase: CreativeWorkflowPhase;
  messages: InspirationMessage[];
  brief: CreativeBrief | null;
  ready_to_confirm: boolean;
  control_end_frames?: boolean;
  text_model?: string | null;
  planned_asset_ids: string[];
  approved_at: string | null;
  brief_confirmed_at?: string | null;
  plan_generated_at?: string | null;
  revision_session?: StoryboardRevisionSession | null;
  plan_sections?: Record<PlanSectionId, PlanSectionApproval>;
}

export interface PlanSectionUpdateRequest {
  status: Exclude<PlanSectionStatus, "pending">;
  feedback?: string;
  revision: number;
}

export interface CreativePlanReviseRequest {
  sections: PlanSectionId[];
  feedback: string;
  text_model?: string;
  billing_job_id?: string;
}

export interface InspirationChatRequest {
  messages: InspirationMessage[];
  text_model?: string;
  billing_job_id?: string;
}

export interface InspirationIntentUpdateRequest {
  control_end_frames: boolean;
}

export type ShotStatus = "draft" | "ready" | "generating" | "complete" | "failed" | "stale";

export type ShotSize =
  | "extreme_wide"
  | "wide"
  | "medium_wide"
  | "medium"
  | "medium_close"
  | "close_up"
  | "extreme_close_up"
  | "over_shoulder"
  | "insert"
  | "establishing";

export type CameraMovement =
  | "static"
  | "pan_left"
  | "pan_right"
  | "tilt_up"
  | "tilt_down"
  | "dolly_in"
  | "dolly_out"
  | "tracking_left"
  | "tracking_right"
  | "crane_up"
  | "crane_down"
  | "handheld"
  | "steadicam"
  | "whip_pan"
  | "orbital"
  | "zoom_in"
  | "zoom_out"
  | "rack_focus";

export interface ShotLanguage {
  shot_size?: ShotSize | null;
  camera_movement?: CameraMovement | null;
  lens_mm?: 14 | 24 | 35 | 50 | 85 | 135 | 200 | null;
  lighting_key?:
    | "high_key"
    | "low_key"
    | "natural"
    | "golden_hour"
    | "blue_hour"
    | "tungsten_warm"
    | "neon"
    | "silhouette"
    | "rim_lit"
    | "volumetric"
    | "overcast_soft"
    | null;
  depth_of_field?: "shallow" | "medium" | "deep" | null;
  color_temperature?: "cool" | "neutral" | "warm" | "mixed" | null;
}

export type ShotContinuityMode = "carry" | "cut" | "match_cut";
export type ShotFrameSource = "user" | "video_extract" | "ai_generated" | "inherited";
export type ShotFrameStatus = "ready" | "generating" | "failed" | "stale";

export interface ShotFrameReference {
  asset_id: string;
  version: number;
  status: ShotFrameStatus;
  source: ShotFrameSource;
  generation_job_id?: string | null;
  origin_shot_id?: string | null;
  origin_shot_version?: number | null;
  origin_frame_version?: number | null;
}

export interface ShotContinuity {
  mode: ShotContinuityMode;
  inherit_previous_tail: boolean;
  explicit_user_first_frame_asset_id: string | null;
  inherited_first_frame_asset_id: string | null;
  last_frame_asset_id: string | null;
  first_frame: ShotFrameReference | null;
  last_frame: ShotFrameReference | null;
  stale: boolean;
  composition?: string;
  subject_pose?: string;
  gaze?: string;
  motion_direction?: string;
  lighting?: string;
  scene_state?: string;
}
export interface Shot {
  id: string;
  scene_id: string;
  index: number;
  episode_number?: number | null;
  beat_id?: string | null;
  beat: string;
  prompt: string;
  characters: string[];
  location: string | null;
  props: string[];
  shot_intent?: string | null;
  shot_language?: ShotLanguage | null;
  status: ShotStatus;
  consistency_score: number;
  output_url: string | null;
  output_path: string | null;
  asset_ids: string[];
  version: number;
  history: ShotRevision[];
  continuity?: ShotContinuity;
  recommended_duration_seconds?: number | null;
  duration_range_seconds?: [number, number] | null;
  can_merge_with_next?: boolean;
  must_complete_action?: boolean;
  must_preserve_emotion?: boolean;
  cannot_split_reason?: string | null;
  aspect_ratio?: string;
  visual_style?: string;
}

export interface ShotRevision {
  version: number;
  source: "create" | "prompt_edit" | "regenerate" | "ai_generated_frame";
  prompt: string;
  characters: string[];
  location: string | null;
  props: string[];
  asset_ids: string[];
  shot_intent?: string | null;
  shot_language?: ShotLanguage | null;
  continuity?: ShotContinuity;
  beat_id?: string | null;
  recommended_duration_seconds?: number | null;
  duration_range_seconds?: [number, number] | null;
  can_merge_with_next?: boolean;
  must_complete_action?: boolean;
  must_preserve_emotion?: boolean;
  cannot_split_reason?: string | null;
  updated_at: string;
}
export interface Storyboard {
  shots: Shot[];
}

export interface ConsistencyIssue {
  shot_id: string | null;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
}

export interface ConsistencyReport {
  score: number;
  issues: ConsistencyIssue[];
}

export interface ContinuitySeriesBible {
  worldview: string;
  main_arc: string;
  style_lock: string;
  visual_rules: string;
  series_prompt?: string;
  taboos: string[];
  locations: string[];
  props: string[];
  relationship_map: string[];
}

export interface EpisodeOutlineItem {
  episode_number: number;
  title: string;
  goal: string;
  conflict: string;
  twist: string;
  cliffhanger: string;
  inherited_state: string[];
  prompt?: string;
  outline?: string;
  locked: boolean;
}

export interface StoryState {
  character_knowledge: string[];
  relationship_changes: string[];
  active_foreshadowing: string[];
  resolved_foreshadowing: string[];
  prop_state: string[];
  character_status: string[];
  current_locations: string[];
}

export interface ContinuitySound {
  narration: string;
  dialogue: string;
  ambience: string;
  music_direction: string;
  prompt: string;
  storyboard_prompt_integration: boolean;
}

export interface ProjectGenerationPreferences {
  image_model: string;
  video_model: string;
  image_size: string;
  image_quality: string;
  aspect_ratio: string;
}

export interface ContinuityPlan {
  project_type: ProjectType;
  active_episode_number: number | null;
  series_bible: ContinuitySeriesBible;
  episodes: EpisodeOutlineItem[];
  story_state: StoryState;
  sound?: ContinuitySound;
  generation_preferences?: ProjectGenerationPreferences;
}

export interface WorkflowArtifactStatus {
  name: string;
  path: string;
  exists: boolean;
}

export interface JobEvent {
  id: string;
  job_id: string;
  project_id: string;
  stage: string;
  status: string;
  message: string;
  created_at: string;
}

export type ProductionConnectionState = "connecting" | "connected" | "disconnected";

export interface ProductionShotSummary {
  total: number;
  reusable: number;
  to_generate: number;
  completed: number;
}

export interface ProductionOutputSpec {
  format: string;
  resolution: string;
  aspect_ratio: string;
  duration_seconds: number;
  target_duration_seconds?: number | null;
  duration_difference_seconds?: number | null;
  render_runtime: string;
}

export interface ProductionRenderScope {
  kind: "single_video" | "episode";
  episode_number: number | null;
  episode_title: string | null;
  total_episodes: number;
}

export interface ProductionContinuitySummary {
  characters: number;
  locations: number;
  props: number;
  bound_assets: number;
}

export interface ProductionActiveJob {
  id: string;
  status: string;
  updated_at: string;
  billing_job_id: string | null;
  estimated_units: number | null;
  resume_available?: boolean;
  task_item_id?: string | null;
  retryable?: boolean;
}

export interface CompositionReadinessBlocker {
  code: string;
  message: string;
  shot_id: string | null;
  task_id: string | null;
  task_item_id: string | null;
  task_status: TaskItemStatus | null;
  retryable: boolean;
}

export interface CompositionReadiness {
  ready: boolean;
  selected_shot_ids: string[];
  reusable_shot_ids: string[];
  blockers: CompositionReadinessBlocker[];
}

export interface ProductionSnapshot {
  shot_summary: ProductionShotSummary;
  output: ProductionOutputSpec;
  continuity: ProductionContinuitySummary;
  render_scope?: ProductionRenderScope;
  selected_shot_ids?: string[];
  active_job: ProductionActiveJob | null;
  readiness?: CompositionReadiness;
}

export interface RenderPreparation extends ProductionSnapshot {
  project_id: string;
  estimated_units: number | null;
  available_units: number;
  estimate_status: "ready" | "not_required";
  duration_compatibility?: {
    reprobed_shot_ids: string[];
    uses_full_source_by_default: boolean;
  };
}

export interface ShortDramaProjectRequest {
  title: string;
  prompt: string;
  project_type?: ProjectType;
  shot_count?: number;
}

export interface ShortDramaProjectResponse {
  project: Project;
  series_bible: SeriesBible;
  storyboard: Storyboard;
  consistency_report: ConsistencyReport;
  creative_workflow?: CreativeWorkflow;
  continuity_plan?: ContinuityPlan | null;
  workflow_artifacts?: WorkflowArtifactStatus[];
  render_report?: RenderReport | null;
  generation_execution?: GenerationExecutionSnapshot | null;
  final_path?: string | null;
  production?: ProductionSnapshot | null;
}

export interface DraftProjectRequest {
  title: string;
  project_type: ProjectType;
  prompt?: string;
}

export interface ShotGenerationSummary {
  operation: "text_to_video" | "image_to_video" | "reference_to_video" | "first_last_frame_to_video";
  reference_image_paths: string[];
  output_path?: string | null;
  requested_duration_seconds?: number | null;
  source_duration_seconds?: number | null;
  timeline_duration_seconds?: number | null;
  cost_usd?: number | null;
  degraded_from_operation?: "first_last_frame_to_video" | null;
  referenced_asset_ids?: string[];
}

export interface RegenerateShotResponse {
  job_id: string;
  event: JobEvent;
  shot: Shot;
  storyboard: Storyboard;
  consistency_report: ConsistencyReport;
  generation?: ShotGenerationSummary;
}

export interface RenderReportOutput {
  path: string;
  media_url?: string | null;
  episode_number?: number | null;
  episode_title?: string | null;
  shot_ids?: string[];
  format: string;
  resolution: string;
  duration_seconds: number;
  file_size_bytes?: number;
}

export interface RenderReport {
  version: "1.0";
  outputs: RenderReportOutput[];
  warnings?: string[];
  verification_notes?: string[];
}

export interface RenderProjectResponse {
  job_id: string;
  event: JobEvent;
  project: Project;
  storyboard: Storyboard;
  consistency_report: ConsistencyReport;
  render_report: RenderReport;
  final_path: string;
  production?: ProductionSnapshot | null;
}

export interface RenderProjectRequest {
  render_runtime?: "remotion" | "hyperframes" | "ffmpeg";
  resume_existing?: boolean;
  selected_shot_ids?: string[];
  idempotency_key?: string;
}

export interface PromptOptimizeRequest {
  target: "project" | "shot" | "asset";
  target_id: string;
  source_text: string;
  asset_kind?: MediaAssetKind;
  text_model?: string;
  mode?: "text" | "shot_json";
  billing_job_id?: string;
}

export interface PromptOptimizeResponse {
  project_id: string;
  model: string;
  optimized_text: string;
  notes: string[];
  shot_intent?: string | null;
  shot_language?: ShotLanguage | null;
}

export interface ShotSaveRequest {
  episode_number?: number | null;
  prompt?: string | null;
  characters?: string[] | null;
  location?: string | null;
  props?: string[] | null;
  asset_ids?: string[] | null;
  shot_intent?: string | null;
  shot_language?: ShotLanguage | null;
  continuity?: ShotContinuity | null;
}

export interface ShotRegenerateRequest {
  video_model?: string;
  billing_job_id?: string;
}

export interface ContinuityPlanResponse {
  project: Project;
  continuity_plan: ContinuityPlan;
}

export interface MediaFile {
  path: string;
  media_url: string;
  filename: string;
  content_type: string;
}

export interface ReferenceImageUploadRequest {
  kind: "character" | "scene" | "prop";
  label: string;
  description: string;
  prompt: string;
  file: File;
}

export interface ReferenceImageUploadResponse {
  media: MediaFile;
  asset: AssetRecord;
  library_asset: MediaAsset;
}
