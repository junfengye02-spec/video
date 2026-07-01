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

export interface SeriesBible {
  title?: string;
  mode?: ProjectMode;
  style_lock?: string;
  characters: Character[];
}

export type ShotStatus = "draft" | "ready" | "generating" | "complete" | "failed";

export interface Shot {
  id: string;
  scene_id: string;
  index: number;
  beat: string;
  prompt: string;
  characters: string[];
  location: string | null;
  props: string[];
  status: ShotStatus;
  consistency_score: number;
  output_url: string | null;
  output_path: string | null;
  aspect_ratio?: string;
  visual_style?: string;
  version?: number;
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
}

export interface RegenerateShotResponse {
  job_id: string;
  event: JobEvent;
  shot: Shot;
  storyboard: Storyboard;
  consistency_report: ConsistencyReport;
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
