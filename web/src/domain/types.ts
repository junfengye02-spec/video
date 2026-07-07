export type ProjectMode = "short_drama" | "general_video";

export interface Project {
  id: string;
  title: string;
  mode: ProjectMode;
  created_at?: string;
  updated_at?: string;
}

export interface GatewayKeySession {
  masked_keys: {
    text: string;
    image: string;
    video: string;
  };
  provider: "syapi";
  base_url: string;
  models: ProviderModels;
  valid: boolean;
}

export interface ProviderCredentials {
  text_key: string;
  image_key: string;
  video_key: string;
  base_url: string;
  text_model: string;
  image_model: string;
  video_model: string;
}

export interface ProviderModels {
  text: string;
  image: string;
  video: string;
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
  kind: string;
  label: string;
  reference_images: string[];
}

export interface SeriesBible {
  title?: string;
  mode?: ProjectMode;
  style_lock?: string;
  characters: Character[];
  assets?: AssetRecord[];
}

export type ShotStatus = "draft" | "ready" | "generating" | "complete" | "failed";

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
export interface Shot {
  id: string;
  scene_id: string;
  index: number;
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
  aspect_ratio?: string;
  visual_style?: string;
}

export interface ShotRevision {
  version: number;
  source: "create" | "prompt_edit" | "regenerate";
  prompt: string;
  characters: string[];
  location: string | null;
  props: string[];
  asset_ids: string[];
  shot_intent?: string | null;
  shot_language?: ShotLanguage | null;
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

export interface JobEvent {
  id: string;
  job_id: string;
  project_id: string;
  stage: string;
  status: string;
  message: string;
  created_at: string;
}

export interface ShortDramaProjectRequest {
  title: string;
  prompt: string;
  text_key: string;
  image_key: string;
  video_key: string;
  base_url: string;
  text_model: string;
  image_model: string;
  video_model: string;
}

export interface ShortDramaProjectResponse {
  project: Project;
  series_bible: SeriesBible;
  storyboard: Storyboard;
  consistency_report: ConsistencyReport;
  render_report?: RenderReport | null;
  final_path?: string | null;
}

export interface ShotGenerationSummary {
  operation: "text_to_video" | "image_to_video" | "reference_to_video" | "first_last_frame_to_video";
  reference_image_paths: string[];
  output_path?: string | null;
  cost_usd?: number | null;
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
  format: string;
  resolution: string;
  duration_seconds: number;
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
}

export interface RenderProjectRequest {
  text_key?: string | null;
  image_key?: string | null;
  video_key: string;
  base_url: string;
  text_model?: string | null;
  image_model?: string | null;
  video_model: string;
  render_runtime: "ffmpeg";
}

export interface PromptOptimizeRequest {
  target: "project" | "shot" | "asset";
  target_id: string;
  source_text: string;
  text_key: string;
  base_url: string;
  text_model: string;
  mode?: "text" | "shot_json";
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
  prompt?: string | null;
  characters?: string[] | null;
  location?: string | null;
  props?: string[] | null;
  asset_ids?: string[] | null;
  shot_intent?: string | null;
  shot_language?: ShotLanguage | null;
}

export interface ShotRegenerateRequest {
  video_key: string;
  base_url: string;
  video_model: string;
}
