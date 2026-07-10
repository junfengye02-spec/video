import type {
  ContinuityPlan,
  GatewayKeySession,
  JobEvent,
  ProjectType,
  PromptOptimizeResponse,
  ProviderCredentials,
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
  savingProvider: boolean;
  savingShotId: string | null;
  uploadingReference: boolean;
}

export interface WorkbenchContextValue {
  snapshot: ShortDramaProjectResponse | null;
  selectedShotId: string | null;
  events: JobEvent[];
  error: string | null;
  finalRenderUrl: string | null;
  localMediaUrls: Partial<Record<LocalMediaRef, string>>;
  providerCredentials: ProviderCredentials;
  maskedKeys: GatewayKeySession["masked_keys"] | null;
  providerReady: boolean;
  busy: WorkbenchBusyState;
  openLocalProject: (projectId: string) => Promise<boolean>;
  createProject: (input: CreateProjectInput) => Promise<ShortDramaProjectResponse>;
  saveProvider: () => Promise<void>;
  updateProviderField: <K extends keyof ProviderCredentials>(
    key: K,
    value: ProviderCredentials[K],
  ) => void;
  selectShot: (shotId: string) => void;
  optimizeShotPrompt: (shot: Shot, sourceText: string) => Promise<PromptOptimizeResponse>;
  saveShotChanges: (shotId: string, payload: ShotSaveRequest) => Promise<void>;
  regenerateSelectedShot: (shot: Shot) => Promise<void>;
  saveContinuity: (plan: ContinuityPlan) => Promise<void>;
  uploadReference: (payload: ReferenceImageUploadRequest) => Promise<void>;
  renderFinal: () => Promise<void>;
  downloadFinal: () => Promise<void>;
  resolveShotMedia: (shot: Shot) => string | null;
  clearError: () => void;
}
