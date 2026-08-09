import { Film, RefreshCw } from "lucide-react";
import type {
  AssetRecord,
  Character,
  EpisodeOutlineItem,
  GenerateImagesRequest,
  GenerateImagesResponse,
  GenerationExecutionUnit,
  ProjectGenerationPreferences,
  ReferenceImageUploadRequest,
  ReferenceImageUploadResponse,
  TaskBatch,
  TaskListResponse,
  JobEvent,
  Shot,
} from "../../../domain/types";
import { getStrings } from "../../../i18n";
import { Button } from "../../../shared/ui";
import type { StoryboardController } from "../model/useStoryboardController";
import { CameraControls } from "./CameraControls";
import { ShotBindings } from "./ShotBindings";
import { ShotCommandBar } from "./ShotCommandBar";
import { ShotKeyframes } from "./ShotKeyframes";
import { ShotNarrativeFields } from "./ShotNarrativeFields";
import styles from "./ShotInspector.module.css";

export interface ShotInspectorProps {
  allowShotVideoRegeneration?: boolean;
  assets: AssetRecord[];
  characters: Character[];
  controller: StoryboardController;
  episodes: EpisodeOutlineItem[];
  generationPreferences?: ProjectGenerationPreferences;
  projectAspectRatio?: string | null;
  projectId: string;
  uploadingFirstFrame?: boolean;
  onUploadFirstFrame?: (
    payload: ReferenceImageUploadRequest,
  ) => Promise<ReferenceImageUploadResponse>;
  onGenerateKeyframe?: (payload: GenerateImagesRequest) => Promise<GenerateImagesResponse>;
  onListTasks?: () => Promise<TaskListResponse>;
  onRetryTaskItem?: (taskId: string, itemId: string) => Promise<TaskBatch>;
  onSessionExpired?: () => void;
  taskEvents?: JobEvent[];
  generationUnit?: GenerationExecutionUnit | null;
  generationUnitNumber?: number | null;
  generationUnitSourceShots?: Shot[];
  generationUnitRegenerationRequested?: boolean;
  onRegenerateGenerationUnit?: (unitId: string) => void;
  videoOutdated?: boolean;
  walletAvailableUnits?: number | null;
}

export function ShotInspector({
  allowShotVideoRegeneration = true,
  assets,
  characters,
  controller,
  episodes,
  generationPreferences,
  projectId,
  projectAspectRatio = null,
  uploadingFirstFrame = false,
  onUploadFirstFrame,
  onGenerateKeyframe,
  onListTasks,
  onRetryTaskItem,
  onSessionExpired,
  taskEvents,
  generationUnit = null,
  generationUnitNumber = null,
  generationUnitSourceShots = [],
  generationUnitRegenerationRequested = false,
  onRegenerateGenerationUnit,
  videoOutdated = false,
  walletAvailableUnits = null,
}: ShotInspectorProps) {
  const strings = getStrings("zh").shotEditor;
  const { selectedShot: shot } = controller;

  return (
    <section className={styles.root} aria-label={getStrings("zh").storyboardPage.inspectorLabel}>
      <header className={styles.header}>
        <div>
          <h2>{strings.title}</h2>
          {shot ? <span>{strings.shotIdentity(shot.index, shot.id)}</span> : null}
        </div>
        {shot ? (
          <span
            className={styles.dirtyStatus}
            data-state={controller.dirty ? "dirty" : videoOutdated ? "outdated" : "saved"}
            role="status"
          >
            {controller.dirty
              ? strings.dirtyStatus
              : videoOutdated ? strings.videoOutdatedStatus : strings.savedStatus}
          </span>
        ) : null}
      </header>

      <div className={styles.body}>
        {!shot ? <p className={styles.empty}>{strings.emptyState}</p> : null}
        {generationUnit ? (
          <section className={styles.generationUnitSection} aria-labelledby="generation-unit-inspector-title">
            <div className={styles.generationUnitHeading}>
              <div>
                <Film aria-hidden="true" size={16} />
                <h3 id="generation-unit-inspector-title">视频生成单元</h3>
              </div>
              <span>U{String(generationUnitNumber ?? 1).padStart(2, "0")}</span>
            </div>
            <dl className={styles.generationUnitDetails}>
              <div>
                <dt>来源分镜</dt>
                <dd>{generationUnitSourceShots.length
                  ? generationUnitSourceShots.map((sourceShot) => `分镜 ${String(sourceShot.index).padStart(2, "0")}`).join("、")
                  : generationUnit.source_shot_ids.join("、")}</dd>
              </div>
              <div>
                <dt>模型与时长</dt>
                <dd>{generationUnit.model_id}{generationUnit.requested_duration_seconds
                  ? ` · ${generationUnit.requested_duration_seconds} 秒`
                  : ""}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{generationUnitRegenerationRequested ? "已加入重生成计划" : "视频可预览"}</dd>
              </div>
            </dl>
            <Button
              variant="secondary"
              icon={<RefreshCw size={16} />}
              disabled={generationUnitRegenerationRequested || !onRegenerateGenerationUnit}
              onClick={() => onRegenerateGenerationUnit?.(generationUnit.id)}
            >
              {generationUnitRegenerationRequested ? "已加入重生成计划" : "重新生成此单元"}
            </Button>
          </section>
        ) : null}
        <ShotNarrativeFields
          draft={controller.draftState.draft}
          episodes={episodes}
          shot={shot}
          strings={strings}
          updateDraft={controller.updateDraft}
        />
        <CameraControls
          draft={controller.draftState.draft}
          shot={shot}
          strings={strings}
          updateShotLanguage={controller.updateShotLanguage}
        />
        <ShotKeyframes
          assets={assets}
          busy={uploadingFirstFrame}
          draft={controller.draftState.draft}
          generationPreferences={generationPreferences}
          projectId={projectId}
          projectAspectRatio={projectAspectRatio}
          shot={shot}
          strings={strings}
          onGenerate={onGenerateKeyframe}
          onListTasks={onListTasks}
          onRetryTaskItem={onRetryTaskItem}
          onSessionExpired={onSessionExpired}
          taskEvents={taskEvents}
          onUpload={onUploadFirstFrame}
          updateDraft={controller.updateDraft}
          walletAvailableUnits={walletAvailableUnits}
        />
        <ShotBindings
          assets={assets}
          characters={characters}
          draft={controller.draftState.draft}
          shot={shot}
          strings={strings}
          updateDraft={controller.updateDraft}
        />
      </div>
      <ShotCommandBar
        allowVideoRegeneration={allowShotVideoRegeneration}
        assets={assets}
        characters={characters}
        controller={controller}
        generationPreferences={generationPreferences}
        strings={strings}
        videoOutdated={videoOutdated}
        walletAvailableUnits={walletAvailableUnits}
      />
    </section>
  );
}
