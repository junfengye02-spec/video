import { FolderPlus, Sparkles } from "lucide-react";
import type { Shot } from "../../domain/types";
import type { TaskItem } from "../../domain/types";
import { getStrings, type UIStrings } from "../../i18n";
import { countLinkedShots, type ResourceLibraryAsset } from "./assetLibrary";
import { AssetKindLabel } from "./AssetKindLabel";
import { AssetMediaPreview } from "./AssetMediaPreview";

export interface AssetGridProps {
  assets: ResourceLibraryAsset[];
  addingAssetId?: string | null;
  disabled: boolean;
  projectAssetIds?: ReadonlySet<string>;
  showAddActions?: boolean;
  shots: Shot[];
  strings?: UIStrings["resources"];
  onAdd?: (assetId: string) => void;
  onGenerate?: (assetId: string, opener: HTMLButtonElement) => void;
  selectedAssetIds?: ReadonlySet<string>;
  taskItemsByAssetId?: ReadonlyMap<string, { batchId: string; item: TaskItem }>;
  retryingItemId?: string | null;
  onRetry?: (batchId: string, itemId: string) => void;
  onToggleSelection?: (assetId: string, selected: boolean) => void;
  onSelect: (assetId: string, opener: HTMLButtonElement) => void;
}

function createdAtLabel(asset: ResourceLibraryAsset, strings: UIStrings["resources"]): string {
  if (!asset.created_at) return strings.createdAtLabel(strings.unknownCreatedAt);
  const value = new Date(asset.created_at);
  if (Number.isNaN(value.getTime())) return strings.createdAtLabel(strings.unknownCreatedAt);
  return strings.createdAtLabel(new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
  }).format(value));
}

export function AssetGrid({
  assets,
  addingAssetId = null,
  disabled,
  projectAssetIds = new Set<string>(),
  showAddActions = false,
  shots,
  strings = getStrings("zh").resources,
  onAdd,
  onGenerate,
  selectedAssetIds = new Set<string>(),
  taskItemsByAssetId = new Map(),
  retryingItemId = null,
  onRetry,
  onToggleSelection,
  onSelect,
}: AssetGridProps) {
  if (assets.length === 0) {
    return <p className="empty-state">{strings.emptyState}</p>;
  }

  return (
    <div className="asset-grid">
      {assets.map((asset) => {
        const thumbnail = asset.media_url
          || asset.media_urls?.find((url) => !/\.(?:mp4|mov|webm)(?:[?#]|$)/i.test(url))
          || asset.reference_images[0];
        const unavailable = asset.status !== "ready";
        const planned = asset.planned === true;
        const canAdd = showAddActions && !projectAssetIds.has(asset.id);
        const task = taskItemsByAssetId.get(asset.id);
        const taskActive = [
          "queued",
          "running",
          "waiting_dependency",
          "awaiting_payment",
          "failed",
        ].includes(task?.item.status ?? "");

        return (
          <article className="asset-card" key={asset.id} data-task-status={task?.item.status}>
            {projectAssetIds.has(asset.id) ? (
              <label className="asset-card-selection">
                <input
                  type="checkbox"
                  checked={selectedAssetIds.has(asset.id)}
                  disabled={taskActive}
                  aria-label={strings.selectResource(asset.label)}
                  onChange={(event) => onToggleSelection?.(asset.id, event.target.checked)}
                />
              </label>
            ) : null}
            <button
              className="asset-card-preview"
              type="button"
              aria-label={strings.viewAsset(asset.label)}
              disabled={disabled}
              onClick={(event) => onSelect(asset.id, event.currentTarget)}
            >
              {planned ? (
                <span className="asset-media-placeholder asset-planned-placeholder">
                  <Sparkles aria-hidden="true" size={22} />
                  {strings.plannedPreview}
                </span>
              ) : unavailable ? (
                <span className="asset-media-placeholder">
                  {asset.status === "missing" ? strings.fileMissing : strings.fileDeleted}
                </span>
              ) : (
                <AssetMediaPreview
                  url={thumbnail}
                  label={asset.label}
                  strings={strings}
                />
              )}
              <strong>{asset.label}</strong>
            </button>
            <div className="asset-card-badges">
              <AssetKindLabel kind={asset.kind} strings={strings} />
              <small>{planned ? strings.plannedSourceLabel : strings.sourceLabels[asset.source_type]}</small>
            </div>
            <span>{planned ? strings.plannedStatus : createdAtLabel(asset, strings)}</span>
            <span>{strings.linkedShotCount(countLinkedShots(asset.id, shots))}</span>
            {task ? (
              <div className="asset-task-status" role="status">
                <span>{strings.taskStatusLabels[task.item.status]}</span>
                <small>{task.item.progress}%</small>
              </div>
            ) : null}
            {task && ["failed", "awaiting_payment"].includes(task.item.status) && task.item.retryable ? (
              <button
                className="secondary-button async-action"
                type="button"
                disabled={retryingItemId === task.item.id || !onRetry}
                onClick={() => onRetry?.(task.batchId, task.item.id)}
              >
                {retryingItemId === task.item.id ? strings.retryingResourceAction : strings.retryResourceAction}
              </button>
            ) : null}
            {planned ? (
              <button
                className="asset-card-add primary-button async-action"
                type="button"
                disabled={disabled || taskActive || !onGenerate}
                onClick={(event) => onGenerate?.(asset.id, event.currentTarget)}
              >
                <Sparkles aria-hidden="true" size={15} />
                {strings.generatePlannedAction}
              </button>
            ) : null}
            {canAdd ? (
              <button
                className="asset-card-add secondary-button async-action"
                type="button"
                disabled={disabled || unavailable || !onAdd}
                onClick={() => onAdd?.(asset.id)}
              >
                <FolderPlus aria-hidden="true" size={15} />
                {addingAssetId === asset.id ? strings.addingToProjectAction : strings.addToProjectAction}
              </button>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
