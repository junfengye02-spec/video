import type {
  AddAssetToProjectResponse,
  AssetRecord,
  ConsistencyReport,
  GenerateImagesRequest,
  GenerateImagesResponse,
  JobEvent,
  ListAssetsRequest,
  ListAssetsResponse,
  MediaAssetKind,
  ProjectGenerationPreferences,
  ProductionConnectionState,
  PromptOptimizeResponse,
  ReferenceImageUploadRequest,
  Shot,
  TaskBatch,
  TaskListResponse,
} from "../../../domain/types";

export type ResourceView = "project" | "all";
export type ImageGenerationParameters = Omit<GenerateImagesRequest, "billing_job_id">;

export interface PendingGenerationQuote {
  billingJobId: string;
  parameters: ImageGenerationParameters;
}

export interface PendingOptimizationQuote {
  billingJobId: string;
  kind: MediaAssetKind;
  sourceText: string;
}

export interface ResourceLibraryControllerProps {
  assets: AssetRecord[];
  consistencyReport: ConsistencyReport | null;
  currentShotId: string | null;
  projectId?: string;
  shots: Shot[];
  uploading: boolean;
  walletAvailableUnits?: number | null;
  generationPreferences?: ProjectGenerationPreferences;
  connectionState?: ProductionConnectionState;
  onAddAssetToProject?: (assetId: string) => Promise<AddAssetToProjectResponse>;
  onBindAsset: (shotId: string, assetId: string, bind: boolean) => Promise<void>;
  onGenerateImages?: (payload: GenerateImagesRequest) => Promise<GenerateImagesResponse>;
  onListAssets?: (payload: ListAssetsRequest) => Promise<ListAssetsResponse>;
  onListTasks?: () => Promise<TaskListResponse>;
  onOptimizeImagePrompt?: (
    kind: MediaAssetKind,
    sourceText: string,
    billingJobId?: string,
  ) => Promise<PromptOptimizeResponse>;
  onSessionExpired?: () => void;
  onRetryTaskItem?: (taskId: string, itemId: string) => Promise<TaskBatch>;
  taskEvents?: JobEvent[];
  onDirtyChange?: (dirty: boolean) => void;
  onUploadReferenceImage: (payload: ReferenceImageUploadRequest) => Promise<void>;
}
