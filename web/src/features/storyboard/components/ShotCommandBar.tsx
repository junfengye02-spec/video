import { Check, RefreshCw, Sparkles, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CommandErrorNotice,
} from "../../../components/feedback/DomainErrorBoundary";
import { formatCnyUnits } from "../../../billing/money";
import type { AssetRecord, Character, ProjectGenerationPreferences, Shot } from "../../../domain/types";
import { getStrings, type UIStrings } from "../../../i18n";
import { GenerationModelPicker } from "../../generation/GenerationModelPicker";
import { Button, Dialog, IconButton, Tooltip } from "../../../shared/ui";
import type {
  CommandFeedbackState,
  StoryboardController,
} from "../model/useStoryboardController";
import styles from "./ShotCommandBar.module.css";

export function ShotCommandBar({
  allowVideoRegeneration = true,
  assets,
  characters,
  controller,
  generationPreferences,
  strings,
  videoOutdated = false,
  walletAvailableUnits,
}: {
  allowVideoRegeneration?: boolean;
  assets: AssetRecord[];
  characters: Character[];
  controller: StoryboardController;
  generationPreferences?: ProjectGenerationPreferences;
  strings: UIStrings["shotEditor"];
  videoOutdated?: boolean;
  walletAvailableUnits?: number | null;
}) {
  const regenerationOpenerRef = useRef<HTMLButtonElement | null>(null);
  const { selectedShot: shot } = controller;
  const defaultVideoModel = generationPreferences?.video_model || "omni_flash-10s";
  const [videoModel, setVideoModel] = useState(defaultVideoModel);
  const [modelDurationConfigured, setModelDurationConfigured] = useState<boolean | null>(null);
  const pendingRegeneration = controller.regenerateFeedback.phase === "pending";
  useEffect(() => {
    setVideoModel(defaultVideoModel);
    setModelDurationConfigured(null);
  }, [defaultVideoModel, shot?.id]);
  const availableBalance = walletAvailableUnits === null || walletAvailableUnits === undefined
    ? strings.balanceUnavailable
    : strings.availableBalance(formatCnyUnits(walletAvailableUnits));
  const boundCharacterLabels = useMemo(
    () => (shot?.characters ?? []).map((id) => characters.find((item) => item.id === id)?.name ?? id),
    [characters, shot?.characters],
  );
  const boundAssetLabels = useMemo(
    () => (shot?.asset_ids ?? []).map((id) => {
      const asset = assets.find((item) => item.id === id);
      return asset ? `${strings.assetKindLabels[asset.kind]} · ${asset.label}` : id;
    }),
    [assets, shot?.asset_ids, strings.assetKindLabels],
  );

  return (
    <div className={styles.root}>
      <div
        className={styles.saveState}
        data-state={controller.dirty ? "dirty" : videoOutdated ? "outdated" : "saved"}
      >
        <span>
          {controller.dirty
            ? strings.dirtyStatus
            : videoOutdated ? strings.videoOutdatedStatus : strings.savedStatus}
        </span>
        <CommandFeedback feedback={controller.saveFeedback} success={strings.saveSuccess} compact />
      </div>

      <div className={styles.actions}>
        <div className={styles.actionGroup}>
          <Button
            variant="secondary"
            icon={<Sparkles size={16} />}
            loading={controller.optimizeFeedback.phase === "pending"}
            disabled={!shot || controller.anyCommandPending}
            onClick={() => void controller.optimize()}
          >
            {controller.optimizeFeedback.phase === "pending" ? strings.optimizingAction : strings.optimizeAction}
          </Button>
          {controller.draftState.undoOptimization ? (
            <Tooltip content={strings.undoOptimizationAction}>
              <IconButton
                label={strings.undoOptimizationAction}
                icon={<Undo2 size={16} />}
                disabled={!shot || controller.anyCommandPending}
                onClick={controller.undoOptimization}
              />
            </Tooltip>
          ) : null}
        </div>
        <Button
          variant="primary"
          icon={<Check size={16} />}
          loading={controller.saveFeedback.phase === "pending"}
          disabled={!shot || controller.anyCommandPending || !controller.dirty}
          onClick={() => void controller.save()}
        >
          {controller.saveFeedback.phase === "pending" ? strings.savingAction : strings.saveAction}
        </Button>
        {allowVideoRegeneration ? (
          <Button
            ref={regenerationOpenerRef}
            variant="ghost"
            icon={<RefreshCw size={16} />}
            loading={controller.regenerateFeedback.phase === "pending"}
            disabled={!shot || controller.anyCommandPending}
            onClick={controller.openRegenerationDialog}
          >
            {controller.regenerateFeedback.phase === "pending" ? strings.regeneratingAction : strings.regenerateAction}
          </Button>
        ) : null}
      </div>

      {allowVideoRegeneration && controller.dirty ? <p className={styles.draftHint}>{strings.regenerateKeepsDraftHint}</p> : null}
      {!controller.dirty && videoOutdated ? (
        <p className={styles.outdatedHint} role="status">{strings.videoOutdatedHint}</p>
      ) : null}
      <CommandFeedback feedback={controller.optimizeFeedback} success={strings.optimizeSuccess} />
      {allowVideoRegeneration && !controller.regenerationDialogOpen ? (
        <CommandFeedback feedback={controller.regenerateFeedback} success={strings.regenerateSuccess} />
      ) : null}

      <Dialog
        open={allowVideoRegeneration && controller.regenerationDialogOpen && Boolean(shot)}
        title={strings.regenerateConfirmTitle}
        openerRef={regenerationOpenerRef}
        closeDisabled={pendingRegeneration}
        onClose={controller.closeRegenerationDialog}
      >
        {shot ? (
          <div className={styles.dialogContent}>
            <p className={styles.shotIdentity}>{strings.shotIdentity(shot.index, shot.id)}</p>
            <GenerationModelPicker
              capability="video"
              disabled={pendingRegeneration}
              label={strings.videoModelLabel}
              required
              strings={getStrings("zh").modelCatalog}
              value={videoModel}
              onChange={(model) => {
                setVideoModel(model);
                setModelDurationConfigured(null);
              }}
              onAvailabilityChange={setModelDurationConfigured}
            />
            <dl className={styles.impactList}>
              <div>
                <dt>{strings.estimatedBalanceImpactLabel}</dt>
                <dd>{strings.estimatedBalanceImpact}</dd>
              </div>
              <div>
                <dt>{strings.availableBalanceLabel}</dt>
                <dd>{availableBalance}</dd>
              </div>
            </dl>
            <section className={styles.bindingSummary} aria-labelledby="regeneration-binding-title">
              <h3 id="regeneration-binding-title">{strings.bindingSummaryTitle}</h3>
              <dl>
                <BindingSummaryRow label={strings.charactersLabel} values={boundCharacterLabels} empty={strings.emptyBindingLabel} />
                <BindingSummaryRow label={strings.locationLabel} values={shot.location ? [shot.location] : []} empty={strings.emptyBindingLabel} />
                <BindingSummaryRow label={strings.propsLabel} values={shot.props} empty={strings.emptyBindingLabel} />
                <BindingSummaryRow label={strings.referenceAssetsLabel} values={boundAssetLabels} empty={strings.emptyBindingLabel} />
              </dl>
            </section>
            <p className={controller.dirty ? styles.draftWarning : styles.sourceNote}>
              {controller.dirty ? strings.regenerateDirtyDraftNotice : strings.regenerateSavedSourceNotice}
            </p>
            <CommandFeedback feedback={controller.regenerateFeedback} success={strings.regenerateSuccess} />
            <footer className={styles.dialogActions}>
              <Button
                variant="secondary"
                disabled={pendingRegeneration}
                onClick={controller.closeRegenerationDialog}
              >
                {strings.cancelAction}
              </Button>
              <Button
                variant="primary"
                icon={<RefreshCw size={16} />}
                loading={pendingRegeneration}
                disabled={
                  pendingRegeneration
                  || !videoModel.trim()
                  || modelDurationConfigured === false
                }
                onClick={() => void controller.regenerate(videoModel.trim())}
              >
                {pendingRegeneration ? strings.regeneratingAction : strings.confirmRegenerateAction}
              </Button>
            </footer>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

function CommandFeedback({
  compact = false,
  feedback,
  success,
}: {
  compact?: boolean;
  feedback: CommandFeedbackState;
  success: string;
}) {
  if (feedback.phase === "error") return <CommandErrorNotice error={feedback.error} />;
  if (feedback.phase === "success") {
    return (
      <p className={compact ? styles.compactSuccess : styles.success} role="status" data-phase="success">
        <Check aria-hidden="true" size={13} />
        <span>{success}</span>
      </p>
    );
  }
  return null;
}

function BindingSummaryRow({ empty, label, values }: { empty: string; label: string; values: string[] }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{values.length ? values.join("、") : empty}</dd>
    </div>
  );
}
