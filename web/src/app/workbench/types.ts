import type {
  AddAssetToProjectResponse,
  ContinuityPlan,
  DraftProjectRequest,
  GenerateImagesRequest,
  GenerateImagesResponse,
  GenerationPlan,
  GenerationPlanPreviewRequest,
  GenerationUnitsGenerateRequest,
  GenerationUnitsGenerateResponse,
  InspirationChatRequest,
  InspirationAttachment,
  InspirationIntentUpdateRequest,
  JobEvent,
  ListAssetsRequest,
  ListAssetsResponse,
  MediaAssetKind,
  CreativePlanReviseRequest,
  PlanSectionId,
  PlanSectionUpdateRequest,
  ProductionConnectionState,
  ProjectType,
  PromptOptimizeResponse,
  ReferenceImageUploadRequest,
  ReferenceImageUploadResponse,
  RenderPreparation,
  ShortDramaProjectRequest,
  ShortDramaProjectResponse,
  Shot,
  ShotSaveRequest,
  TaskBatch,
  TaskListResponse,
} from "../../domain/types";
import type { LocalMediaRef } from "../../localdb/types";

export type CreateProjectInput = Pick<
  ShortDramaProjectRequest,
  "title" | "prompt"
> & { project_type: ProjectType };

export interface WorkbenchBusyState {
  approvingPlan: boolean;
  creating: boolean;
  developingIdea: boolean;
  downloading: boolean;
  preparingRender: boolean;
  refreshingProduction: boolean;
  optimizingShotId: string | null;
  regeneratingShotId: string | null;
  rendering: boolean;
  revisingPlan: boolean;
  savingContinuity: boolean;
  savingShotId: string | null;
  uploadingReference: boolean;
  updatingPlanSection: PlanSectionId | null;
}

export type LocalBackupStatus = "idle" | "saving" | "retrying";

export interface WorkbenchContextValue {
  snapshot: ShortDramaProjectResponse | null;
  selectedShotId: string | null;
  events: JobEvent[];
  productionConnection: ProductionConnectionState;
  error: string | null;
  load: "idle" | "loading" | "ready" | "missing" | "stale";
  readOnly: boolean;
  finalRenderUrl: string | null;
  localMediaUrls: Partial<Record<LocalMediaRef, string>>;
  localBackupStatus: LocalBackupStatus;
  busy: WorkbenchBusyState;
  openLocalProject: (projectId: string) => Promise<boolean>;
  createProject: (input: CreateProjectInput) => Promise<ShortDramaProjectResponse>;
  createDraft: (input: DraftProjectRequest) => Promise<ShortDramaProjectResponse>;
  developInspiration: (
    input: InspirationChatRequest,
    onDelta?: (text: string) => void,
  ) => Promise<ShortDramaProjectResponse>;
  uploadInspirationAttachment: (file: File) => Promise<InspirationAttachment>;
  updateInspirationIntent: (
    input: InspirationIntentUpdateRequest,
  ) => Promise<ShortDramaProjectResponse>;
  planStoryboard: (
    prompt: string,
    controlEndFrames?: boolean,
    textModel?: string,
  ) => Promise<ShortDramaProjectResponse>;
  approveStoryboard: () => Promise<ShortDramaProjectResponse>;
  beginStoryboardRevision: () => Promise<ShortDramaProjectResponse>;
  cancelStoryboardRevision: () => Promise<ShortDramaProjectResponse>;
  updatePlanSection: (
    section: PlanSectionId,
    input: PlanSectionUpdateRequest,
  ) => Promise<ShortDramaProjectResponse>;
  reviseCreativePlan: (
    input: CreativePlanReviseRequest,
  ) => Promise<ShortDramaProjectResponse>;
  selectShot: (shotId: string) => void;
  optimizeShotPrompt: (shot: Shot, sourceText: string) => Promise<PromptOptimizeResponse>;
  optimizeImagePrompt: (
    kind: MediaAssetKind,
    sourceText: string,
    billingJobId?: string,
  ) => Promise<PromptOptimizeResponse>;
  saveShotChanges: (shotId: string, payload: ShotSaveRequest) => Promise<Shot>;
  regenerateSelectedShot: (shot: Shot, videoModel?: string) => Promise<void>;
  saveContinuity: (plan: ContinuityPlan) => Promise<void>;
  listAssets: (payload: ListAssetsRequest) => Promise<ListAssetsResponse>;
  generateImages: (payload: GenerateImagesRequest) => Promise<GenerateImagesResponse>;
  previewGenerationPlan: (payload: GenerationPlanPreviewRequest) => Promise<GenerationPlan>;
  generateGenerationUnits: (
    payload: GenerationUnitsGenerateRequest,
  ) => Promise<GenerationUnitsGenerateResponse>;
  listTasks: () => Promise<TaskListResponse>;
  retryTaskItem: (taskId: string, itemId: string) => Promise<TaskBatch>;
  addAssetToProject: (assetId: string) => Promise<AddAssetToProjectResponse>;
  uploadReference: (
    payload: ReferenceImageUploadRequest,
  ) => Promise<ReferenceImageUploadResponse>;
  updatePlannedAssetPrompt: (assetId: string, payload: { prompt: string }) => Promise<void>;
  prepareFinalRender: (selectedShotIds?: string[]) => Promise<RenderPreparation>;
  refreshProduction: () => Promise<void>;
  renderFinal: (selectedShotIds?: string[]) => Promise<void>;
  downloadFinal: () => Promise<void>;
  resolveShotMedia: (shot: Shot) => string | null;
  clearError: () => void;
}
