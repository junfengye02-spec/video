import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CommandErrorNotice, type CommandError } from "../../../components/feedback/DomainErrorBoundary";
import type {
  GenerationExecutionSnapshot,
  GenerationPlan,
  Shot,
  TaskItem,
} from "../../../domain/types";
import { GenerationModelPicker } from "../../generation/GenerationModelPicker";
import { getStrings } from "../../../i18n";
import { useReducedMotion } from "../../../shared/motion";
import { SelectMenu, type SelectMenuOption } from "../../../shared/ui";
import { GenerationPlanPanel } from "./GenerationPlanPanel";
import { revealSelectedItem } from "../model/storyboardScroll";
import { shotMediaKind } from "./shotMedia";
import { ShotStatusLabel, ShotTaskStatusLabel } from "./ShotStatus";
import styles from "./ShotList.module.css";

export interface ShotListProps {
  active?: boolean;
  shots: Shot[];
  selectedShotId: string | null;
  resolveShotMedia: (shot: Shot) => string | null;
  onSelect: (shotId: string) => void;
  episodeOptions?: SelectMenuOption<string>[];
  selectedEpisodeNumber?: number | null;
  switchingEpisode?: boolean;
  onEpisodeChange?: (value: string) => void;
  generationItems?: Map<string, { batchId: string; item: TaskItem }>;
  generationUnitItems?: Map<string, { batchId: string; item: TaskItem }>;
  generationError?: CommandError | null;
  generationExecution?: GenerationExecutionSnapshot | null;
  generationPlan?: GenerationPlan | null;
  previewingGenerationPlan?: boolean;
  confirmingGenerationPlan?: boolean;
  revisingStoryboard?: boolean;
  regenerateUnitIds?: Set<string>;
  submittingGeneration?: boolean;
  videoModel?: string;
  onVideoModelChange?: (model: string) => void;
  onAcceptLongerDuration?: () => void;
  onGeneratePendingUnits?: () => void;
  onRegenerateUnit?: (unitId: string) => void;
  onReviseStoryboard?: () => void;
  retryingItemId?: string | null;
  onRetryItem?: (batchId: string, itemId: string) => void;
}

export function ShotList({
  active = true,
  shots,
  selectedShotId,
  resolveShotMedia,
  onSelect,
  episodeOptions = [],
  selectedEpisodeNumber = null,
  switchingEpisode = false,
  onEpisodeChange,
  generationItems = new Map(),
  generationUnitItems = new Map(),
  generationError = null,
  generationExecution = null,
  generationPlan = null,
  previewingGenerationPlan = false,
  confirmingGenerationPlan = false,
  revisingStoryboard = false,
  regenerateUnitIds = new Set(),
  submittingGeneration = false,
  videoModel = "omni_flash-10s",
  onVideoModelChange,
  onAcceptLongerDuration,
  onGeneratePendingUnits,
  onRegenerateUnit,
  onReviseStoryboard,
  retryingItemId = null,
  onRetryItem,
}: ShotListProps) {
  const strings = getStrings("zh");
  const reducedMotion = useReducedMotion();
  const listRef = useRef<HTMLOListElement | null>(null);
  const modelPickerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const [modelDurationConfigured, setModelDurationConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    if (!active) return;
    const list = listRef.current;
    const item = selectedShotId ? itemRefs.current.get(selectedShotId) : null;
    if (!list || !item) return;
    return revealSelectedItem(list, item, "vertical", reducedMotion);
  }, [active, reducedMotion, selectedShotId]);
  const busyStatuses = new Set([
    "queued",
    "running",
    "waiting_dependency",
    "waiting_provider",
    "awaiting_payment",
  ]);
  return (
    <nav className={styles.root} aria-label={strings.storyboardPage.shotListLabel}>
      <header className={styles.header}>
        <div>
          <span>{strings.storyboardPage.shotListLabel}</span>
          <strong>{shots.length}</strong>
        </div>
        <p>{shots.length ? strings.storyboardPage.shotRangeLabel(1, shots.length, shots.length) : null}</p>
      </header>
      <div className={styles.generationControls}>
        {episodeOptions.length > 1 && selectedEpisodeNumber != null ? (
          <SelectMenu
            disabled={switchingEpisode || !onEpisodeChange}
            label={strings.storyboardPage.episodePickerLabel}
            value={String(selectedEpisodeNumber)}
            options={episodeOptions}
            onValueChange={(value) => onEpisodeChange?.(value)}
          />
        ) : null}
        <div ref={modelPickerRef}>
          <GenerationModelPicker
            capability="video"
            disabled={submittingGeneration || confirmingGenerationPlan || !onGeneratePendingUnits}
            label={strings.storyboardPage.videoModelLabel}
            required
            strings={strings.modelCatalog}
            value={videoModel}
            onChange={(model) => onVideoModelChange?.(model)}
            onAvailabilityChange={setModelDurationConfigured}
          />
        </div>
        <GenerationPlanPanel
          confirmingPlan={confirmingGenerationPlan}
          execution={generationExecution}
          generationItems={generationUnitItems}
          generationPlan={generationPlan}
          modelDurationConfigured={modelDurationConfigured}
          previewing={previewingGenerationPlan}
          revisingStoryboard={revisingStoryboard}
          regenerateUnitIds={regenerateUnitIds}
          retryingItemId={retryingItemId}
          shots={shots}
          strings={strings.storyboardPage}
          submitting={submittingGeneration}
          onAcceptLonger={() => onAcceptLongerDuration?.()}
          onChooseModel={() => {
            const control = modelPickerRef.current?.querySelector<HTMLElement>("button, input, select");
            control?.focus();
            control?.click();
          }}
          onGenerate={() => onGeneratePendingUnits?.()}
          onRegenerateUnit={(unitId) => onRegenerateUnit?.(unitId)}
          onReviseStoryboard={() => onReviseStoryboard?.()}
          onRetryItem={onRetryItem}
        />
        {generationError ? (
          <div className={styles.generationError}>
            <CommandErrorNotice error={generationError} />
          </div>
        ) : null}
      </div>
      {shots.length === 0 ? (
        <p className={styles.empty}>{strings.storyboardPage.emptyShots}</p>
      ) : (
        <ol ref={listRef} className={styles.list} data-testid="shot-scroll-list">
          {shots.map((shot) => {
            const mediaUrl = resolveShotMedia(shot);
            const generationItem = generationItems.get(shot.id)?.item;
            const dependencyMessage = generationItem
              && ["previous_shot_missing", "dependency_failed", "dependency_cancelled"].includes(
                generationItem.error_code ?? "",
              )
              ? strings.storyboardPage.previousShotMissing
              : null;
            const retryable = Boolean(
              generationItem?.retryable
              && generationItem.status !== "waiting_provider"
              && ["failed", "awaiting_payment", "waiting_dependency"].includes(generationItem.status)
              && generationItem.attempt_count < 10
              && onRetryItem,
            ) || Boolean(
              generationItem
              && generationItem.status === "failed"
              && generationItem.attempt_count < 10
              && onRetryItem,
            );
            return (
              <li key={shot.id}>
                <button
                  ref={(node) => {
                    if (node) itemRefs.current.set(shot.id, node);
                    else itemRefs.current.delete(shot.id);
                  }}
                  type="button"
                  aria-label={strings.storyboardPage.selectShotLabel(shot.index)}
                  aria-pressed={selectedShotId === shot.id}
                  onClick={() => onSelect(shot.id)}
                >
                  <span className={styles.thumbnail} aria-hidden={mediaUrl ? undefined : "true"}>
                    {mediaUrl ? <ShotThumbnail mediaUrl={mediaUrl} shot={shot} /> : <span />}
                  </span>
                  <span className={styles.copy}>
                    <span className={styles.titleRow}>
                      <span className={styles.index}>{String(shot.index).padStart(2, "0")}</span>
                      <strong>{strings.storyboardPage.shotTitle(shot.index)}</strong>
                    </span>
                    <span className={styles.beat}>{shot.beat}</span>
                    <span className={styles.meta}>
                      <span />
                      {generationItem
                        ? <ShotTaskStatusLabel status={generationItem.status} />
                        : <ShotStatusLabel status={shot.status} />}
                    </span>
                    {dependencyMessage ? (
                      <span className={styles.dependencyMessage}>{dependencyMessage}</span>
                    ) : null}
                  </span>
                </button>
                {retryable && generationItem ? (
                  <button
                    type="button"
                    className={styles.retryAction}
                    disabled={retryingItemId !== null}
                    onClick={() => onRetryItem?.(
                      generationItems.get(shot.id)?.batchId ?? generationItem.batch_id,
                      generationItem.id,
                    )}
                  >
                    <RefreshCw aria-hidden="true" size={13} />
                    <span>{retryingItemId === generationItem.id
                      ? strings.storyboardPage.retryingShotAction
                      : strings.storyboardPage.retryShotAction}</span>
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </nav>
  );
}

function ShotThumbnail({ mediaUrl, shot }: { mediaUrl: string; shot: Shot }) {
  const strings = getStrings("zh").storyboardPage;
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const kind = shotMediaKind(shot, mediaUrl);

  useEffect(() => setFailed(false), [mediaUrl, shot.id]);
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (!video) return;
      if (!video.paused) video.pause();
      // Keep src intact because StrictMode can replay cleanup without unmounting the DOM node.
    };
  }, []);

  if (failed) return <span />;
  if (kind === "image") {
    return (
      <img
        src={mediaUrl}
        alt={`${strings.shotTitle(shot.index)} ${strings.thumbnailLabel}`}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <video
      ref={videoRef}
      aria-label={`${strings.shotTitle(shot.index)} ${strings.thumbnailLabel}`}
      src={mediaUrl}
      muted
      playsInline
      preload="metadata"
      onError={() => setFailed(true)}
    />
  );
}
