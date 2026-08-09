import { AlertTriangle, ImageOff, Link2, Unlink, X } from "lucide-react";
import type { RefObject } from "react";
import type { ConsistencyReport, Shot } from "../../domain/types";
import { getStrings, type UIStrings } from "../../i18n";
import { useModalFocus } from "../accessibility/useModalFocus";
import { countLinkedShots, type ResourceLibraryAsset } from "./assetLibrary";
import { AssetKindLabel } from "./AssetKindLabel";
import { AssetMediaPreview } from "./AssetMediaPreview";

export interface AssetDetailDrawerProps {
  asset: ResourceLibraryAsset;
  binding: boolean;
  bindingError: string | null;
  canBind?: boolean;
  consistencyReport: ConsistencyReport | null;
  currentShotId: string | null;
  panelLocked: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  shots: Shot[];
  strings?: UIStrings["resources"];
  onBind: (bind: boolean) => void;
  onClose: () => void;
}

export function AssetDetailDrawer({
  asset,
  binding,
  bindingError,
  canBind = true,
  consistencyReport,
  currentShotId,
  panelLocked,
  returnFocusRef,
  shots,
  strings = getStrings("zh").resources,
  onBind,
  onClose,
}: AssetDetailDrawerProps) {
  const currentShot = shots.find((shot) => shot.id === currentShotId) ?? null;
  const boundToCurrentShot = Boolean(currentShot?.asset_ids.includes(asset.id));
  const linkedShotIds = new Set(
    shots.filter((shot) => shot.asset_ids.includes(asset.id)).map((shot) => shot.id),
  );
  const relevantIssues = consistencyReport?.issues.filter(
    (issue) => Boolean(issue.shot_id && linkedShotIds.has(issue.shot_id)),
  ) ?? [];
  const unavailable = asset.status !== "ready";
  const { panelRef, onKeyDown } = useModalFocus<HTMLDialogElement>({
    open: true,
    onEscape: () => {
      if (!panelLocked) onClose();
    },
    returnFocusRef,
  });

  return (
    <dialog
      ref={panelRef}
      aria-modal="true"
      aria-labelledby="resource-detail-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!panelLocked) {
          onClose();
        }
      }}
      onKeyDown={onKeyDown}
    >
      <div className="section-heading">
        <h2 id="resource-detail-title">{strings.detailDialogTitle}</h2>
        <button
          type="button"
          title={strings.closeDetailAction}
          aria-label={strings.closeDetailAction}
          disabled={panelLocked}
          onClick={onClose}
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>

      <h3>{asset.label}</h3>
      {asset.description ? <p>{asset.description}</p> : null}
      <dl className="asset-detail-meta">
        <div>
          <dt>{strings.kindLabel}</dt>
          <dd><AssetKindLabel kind={asset.kind} strings={strings} /></dd>
        </div>
        <div>
          <dt>{strings.sourceLabel}</dt>
          <dd>{strings.sourceLabels[asset.source_type]}</dd>
        </div>
        <div>
          <dt>{strings.createdAtTitle}</dt>
          <dd>{asset.created_at || strings.unknownCreatedAt}</dd>
        </div>
      </dl>
      <section aria-labelledby="resource-prompt-title">
        <h4 id="resource-prompt-title">{strings.promptLabel}</h4>
        <p>{asset.prompt || strings.noPrompt}</p>
      </section>
      <p>{strings.linkedShotCount(countLinkedShots(asset.id, shots))}</p>

      {unavailable ? (
        <p className="asset-file-status" role="status">
          <ImageOff aria-hidden="true" size={18} />
          {asset.status === "missing" ? strings.fileMissing : strings.fileDeleted}
        </p>
      ) : null}

      {!unavailable && asset.reference_images.length > 0 ? (
        <section aria-labelledby="resource-references-title">
          <h4 id="resource-references-title">{strings.referencesTitle}</h4>
          <div className="asset-list">
            {asset.reference_images.map((url, index) => (
              <AssetMediaPreview
                key={`${url}-${index}`}
                url={url}
                controls
                label={`${asset.label} ${strings.referenceImageLabel(index + 1)}`}
                strings={strings}
              />
            ))}
          </div>
        </section>
      ) : null}

      {!unavailable && asset.media_urls?.length ? (
        <section aria-labelledby="resource-media-title">
          <h4 id="resource-media-title">{strings.mediaTitle}</h4>
          <div className="asset-list">
            {asset.media_urls.map((url, index) => (
              <AssetMediaPreview
                key={`${url}-${index}`}
                url={url}
                controls
                label={`${asset.label} ${strings.mediaItemLabel(index + 1)}`}
                strings={strings}
              />
            ))}
          </div>
        </section>
      ) : null}

      {relevantIssues.length > 0 ? (
        <section aria-labelledby="resource-consistency-title">
          <h4 id="resource-consistency-title">{strings.consistencyIssuesTitle}</h4>
          <ul className="issue-list">
            {relevantIssues.map((issue, index) => (
              <li key={`${issue.code}-${issue.shot_id}-${index}`}>
                <AlertTriangle aria-hidden="true" size={15} />
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {bindingError ? <p role="alert">{bindingError}</p> : null}
      {!canBind ? <p className="empty-state">{strings.addBeforeBinding}</p> : null}
      <button
        className="async-action"
        type="button"
        disabled={!currentShot || panelLocked || !canBind || unavailable}
        onClick={() => onBind(!boundToCurrentShot)}
      >
        {boundToCurrentShot ? <Unlink aria-hidden="true" size={16} /> : <Link2 aria-hidden="true" size={16} />}
        {binding
          ? strings.bindingAction
          : boundToCurrentShot
            ? strings.unbindAction
            : strings.bindAction}
      </button>
    </dialog>
  );
}
