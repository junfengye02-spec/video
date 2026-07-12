import type {
  ContinuityPlan,
  JobEvent,
  ProjectType,
  PromptOptimizeResponse,
  ReferenceImageUploadRequest,
  ShortDramaProjectRequest,
  ShortDramaProjectResponse,
  Shot,
  ShotSaveRequest,
} from "../../domain/types";
import type { LocalMediaRef } from "../../localdb/types";

export type CreateProjectInput = Pick<
  ShortDramaProjectRequest,
  "title" | "prompt"
> & { project_type: ProjectType };

export interface WorkbenchBusyState {
  creating: boolean;
  downloading: boolean;
  optimizingShotId: string | null;
  regeneratingShotId: string | null;
  rendering: boolean;
  savingContinuity: boolean;
  savingShotId: string | null;
  uploadingReference: boolean;
}

export type LocalBackupStatus = "idle" | "saving" | "retrying";

export interface WorkbenchContextValue {
  snapshot: ShortDramaProjectResponse | null;
  selectedShotId: string | null;
  events: JobEvent[];
  error: string | null;
  load: "idle" | "loading" | "ready" | "missing" | "stale";
  readOnly: boolean;
  finalRenderUrl: string | null;
  localMediaUrls: Partial<Record<LocalMediaRef, string>>;
  localBackupStatus: LocalBackupStatus;
  busy: WorkbenchBusyState;
  openLocalProject: (projectId: string) => Promise<boolean>;
  createProject: (input: CreateProjectInput) => Promise<ShortDramaProjectResponse>;
  selectShot: (shotId: string) => void;
  optimizeShotPrompt: (shot: Shot, sourceText: string) => Promise<PromptOptimizeResponse>;
  saveShotChanges: (shotId: string, payload: ShotSaveRequest) => Promise<Shot>;
  regenerateSelectedShot: (shot: Shot) => Promise<void>;
  saveContinuity: (plan: ContinuityPlan) => Promise<void>;
  uploadReference: (payload: ReferenceImageUploadRequest) => Promise<void>;
  renderFinal: () => Promise<void>;
  downloadFinal: () => Promise<void>;
  resolveShotMedia: (shot: Shot) => string | null;
  clearError: () => void;
}
