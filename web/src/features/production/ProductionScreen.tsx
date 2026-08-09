import { Film, RefreshCw, WalletCards } from "lucide-react";
import { Link } from "react-router-dom";
import { Dialog } from "../../shared/ui/Dialog";
import { ConsistencyPanel } from "../../components/ConsistencyPanel";
import { CommandErrorNotice } from "../../components/feedback/DomainErrorBoundary";
import { JobProgress } from "../../components/JobProgress";
import { FinalRenderPanel } from "../../components/production/FinalRenderPanel";
import { ShotSelectionPanel } from "../../components/production/ShotSelectionPanel";
import { WorkflowArtifacts } from "../../components/production/WorkflowArtifacts";
import type { ProductionRenderScope, RenderPreparation } from "../../domain/types";
import { useEffect, useMemo, useState } from "react";
import styles from "./ProductionScreen.module.css";
import { useProductionController, type ProductionControllerProps } from "./model/useProductionController";
import { formatCnyUnits } from "../../billing/money";

function units(value: number): string {
  return formatCnyUnits(value);
}

function ConfirmationContent({
  preparation,
  remaking,
  submitting,
  strings,
  onCancel,
  onConfirm,
}: {
  preparation: RenderPreparation;
  remaking: boolean;
  submitting: boolean;
  strings: ReturnType<typeof import("../../i18n").getStrings>["production"]["confirmation"];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const insufficient = preparation.estimated_units !== null && preparation.estimated_units > preparation.available_units;
  const notReady = preparation.readiness?.ready === false;
  return (
    <>
      {remaking ? <p className={styles.remakeNotice}>{strings.remakeNotice}</p> : null}
      <dl className="production-confirm-stats">
        <div><dt>{strings.generateLabel}</dt><dd>{preparation.shot_summary.to_generate}</dd></div>
        <div><dt>{strings.reuseLabel}</dt><dd>{preparation.shot_summary.reusable}</dd></div>
        <div><dt>{strings.estimateLabel}</dt><dd>{units(preparation.estimated_units ?? 0)}</dd></div>
        <div><dt>{strings.balanceLabel}</dt><dd>{units(preparation.available_units)}</dd></div>
      </dl>
      <div className="production-confirm-detail">
        {preparation.render_scope?.kind === "episode" && preparation.render_scope.episode_number !== null ? (
          <p>
            <strong>{strings.scopeLabel}</strong>
            <span>{strings.episodeScope(
              preparation.render_scope.episode_number,
              preparation.render_scope.episode_title ?? "",
            )}</span>
          </p>
        ) : null}
        <p><strong>{strings.outputLabel}</strong><span>{preparation.output.resolution} · {preparation.output.aspect_ratio} · {preparation.output.format.toUpperCase()} · {preparation.output.target_duration_seconds != null
          ? strings.durationComparison(preparation.output.duration_seconds, preparation.output.target_duration_seconds)
          : `${preparation.output.duration_seconds}s`}</span></p>
        <p><strong>{strings.continuityLabel}</strong><span>{preparation.continuity.characters} {strings.charactersUnit} · {preparation.continuity.locations} {strings.locationsUnit} · {preparation.continuity.props} {strings.propsUnit} · {preparation.continuity.bound_assets} {strings.bindingsUnit}</span></p>
      </div>
      {insufficient ? <div className="production-quota-warning" role="alert"><WalletCards aria-hidden="true" size={18} /><p><strong>{strings.insufficientTitle}</strong><span>{strings.insufficientBody}</span></p><Link to="/wallet">{strings.walletAction}</Link></div> : null}
      {notReady ? (
        <ul className="production-readiness-list" aria-label={strings.title}>
          {preparation.readiness?.blockers.map((blocker, index) => (
            <li key={`${blocker.code}:${blocker.shot_id ?? index}`}>{blocker.message}</li>
          ))}
        </ul>
      ) : null}
      <footer>
        <button className="secondary-button" disabled={submitting} onClick={onCancel} type="button">{strings.cancelAction}</button>
        <button className="primary-button async-action" disabled={submitting || insufficient || notReady} onClick={onConfirm} type="button"><Film aria-hidden="true" size={16} />{submitting ? strings.submittingAction : remaking ? strings.remakeConfirmAction : strings.confirmAction}</button>
      </footer>
    </>
  );
}

export function ProductionScreen(props: ProductionControllerProps) {
  const controller = useProductionController(props);
  const {
    strings, commandError, confirmation, preparing, submitting, triggerRef, activeJob,
    serverRendering, renderDisabled, remaking, closeConfirmation, handleRender, handlePrepare,
  } = controller;
  const output = props.production?.output ?? null;
  const continuityPlan = props.continuityPlan ?? null;
  const renderScope: ProductionRenderScope = props.production?.render_scope ?? (
    continuityPlan
      && (continuityPlan.project_type !== "single_video" || continuityPlan.episodes.length > 0)
      ? {
          kind: "episode",
          episode_number: continuityPlan.active_episode_number ?? 1,
          episode_title: continuityPlan.episodes.find(
            (episode) => episode.episode_number === (continuityPlan.active_episode_number ?? 1),
          )?.title ?? null,
          total_episodes: continuityPlan.episodes.length,
        }
      : { kind: "single_video", episode_number: null, episode_title: null, total_episodes: 0 }
  );
  const hasEpisodeTags = props.shots.some((shot) => shot.episode_number !== null && shot.episode_number !== undefined);
  const scopedShots = useMemo(() => (
    renderScope.kind === "episode" && renderScope.episode_number !== null && hasEpisodeTags
      ? props.shots.filter((shot) => shot.episode_number === renderScope.episode_number)
      : props.shots
  ), [hasEpisodeTags, props.shots, renderScope.episode_number, renderScope.kind]);
  const scopedShotKey = scopedShots.map((shot) => shot.id).join("|");
  const [selectedShotIds, setSelectedShotIds] = useState<string[]>([]);
  const [retryingItemId, setRetryingItemId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedShotIds(scopedShots.map((shot) => shot.id));
  }, [props.projectId, renderScope.episode_number, renderScope.kind, scopedShotKey]);

  const toggleShot = (shotId: string) => {
    setSelectedShotIds((current) => (
      current.includes(shotId)
        ? current.filter((id) => id !== shotId)
        : scopedShots.filter((shot) => current.includes(shot.id) || shot.id === shotId).map((shot) => shot.id)
    ));
  };
  const statusLabel = props.rendering || serverRendering
    ? strings.statusLabels.running
    : activeJob?.status === "failed"
      ? strings.statusLabels.failed
      : props.finalPath
        ? strings.statusLabels.complete
        : props.shotCount ? strings.statusLabels.ready : strings.statusLabels.empty;
  const episodeRenderAction = renderScope.kind === "episode" && renderScope.episode_number !== null
    ? (remaking
      ? strings.remakeEpisodeAction(renderScope.episode_number)
      : strings.renderEpisodeAction(renderScope.episode_number))
    : null;
  const selectionEmpty = selectedShotIds.length === 0;
  const renderCommandDisabled = renderDisabled || selectionEmpty;
  const readiness = props.production?.readiness ?? null;

  const retryTask = async (taskId: string, itemId: string) => {
    if (!props.onRetryTaskItem || retryingItemId) return;
    setRetryingItemId(itemId);
    try {
      await props.onRetryTaskItem(taskId, itemId);
      await props.onRefresh?.();
    } finally {
      setRetryingItemId(null);
    }
  };

  return (
    <section className={`${styles.root} production-page`} aria-label={strings.pageLabel}>
      <header className="production-page-heading">
        <div><span>{strings.eyebrow}</span><h1>{strings.title}</h1><p>{strings.description}</p></div>
        <strong data-status={statusLabel === strings.statusLabels.failed ? "failed" : "default"}>{statusLabel}</strong>
      </header>
      <div className="production-layout">
        <main className="production-main">
          <ShotSelectionPanel
            disabled={props.rendering || submitting || preparing}
            onSelectAll={() => setSelectedShotIds(scopedShots.map((shot) => shot.id))}
            onToggle={toggleShot}
            selectedShotIds={selectedShotIds}
            shots={scopedShots}
            strings={strings.shotSelection}
          />
          <FinalRenderPanel
            activeEpisodeNumber={renderScope.episode_number}
            aspectRatio={output?.aspect_ratio ?? null}
            downloading={props.downloading}
            episodeOutputs={props.renderReport?.outputs ?? []}
            episodePlan={continuityPlan?.episodes ?? []}
            finalPath={props.finalPath}
            finalRenderUrl={props.finalRenderUrl}
            projectId={props.projectId}
            strings={strings.finalRender}
            onDownload={props.onDownload}
          />
          {readiness ? <section className="production-readiness" aria-label={strings.readinessTitle}>
            <div className="section-heading"><RefreshCw aria-hidden="true" size={18} /><h2>{strings.readinessTitle}</h2></div>
            {readiness?.ready ? (
              <p data-state="ready">{strings.readinessReady}</p>
            ) : (
              <>
                <p data-state="blocked">{strings.readinessBlocked}</p>
                <ul className="production-readiness-list">
                  {(readiness?.blockers ?? []).map((blocker, index) => (
                    <li key={`${blocker.code}:${blocker.shot_id ?? index}`}>
                      <span>{blocker.message}</span>
                      {blocker.retryable && blocker.task_id && blocker.task_item_id && props.onRetryTaskItem ? (
                        <button
                          className="secondary-button"
                          disabled={retryingItemId !== null}
                          onClick={() => { void retryTask(blocker.task_id as string, blocker.task_item_id as string); }}
                          type="button"
                        >
                          <RefreshCw aria-hidden="true" size={14} />
                          {retryingItemId === blocker.task_item_id ? strings.retryingTaskAction : strings.retryTaskAction}
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section> : null}
          <JobProgress activeJob={activeJob} connectionState={props.connectionState} events={props.events} refreshing={props.refreshing} rendering={props.rendering} strings={strings.jobProgress} onRefresh={props.onRefresh} />
        </main>
        <aside className="production-evidence" aria-label={strings.evidenceLabel}>
          <WorkflowArtifacts artifacts={props.workflowArtifacts} shotSummary={props.production?.shot_summary ?? null} strings={strings.workflowArtifacts} />
          <ConsistencyPanel report={props.consistencyReport} strings={strings.consistency} />
        </aside>
      </div>
      <div className="production-command-area">
        <div><strong>{output ? `${output.resolution} · ${output.aspect_ratio} · ${output.format.toUpperCase()}` : strings.outputPending}</strong><span>{strings.billingBoundary}</span></div>
        <CommandErrorNotice error={commandError} />
        {props.onRetryTaskItem && activeJob?.status === "failed" && activeJob.task_item_id && activeJob.retryable ? <button className="secondary-button" disabled={retryingItemId !== null} onClick={() => { void retryTask(activeJob.id, activeJob.task_item_id as string); }} type="button"><RefreshCw aria-hidden="true" size={16} />{retryingItemId ? strings.retryingTaskAction : strings.retryTaskAction}</button> : null}
        {props.onRefresh && activeJob?.status === "failed" ? <button className="secondary-button" disabled={props.refreshing} onClick={() => { void props.onRefresh?.(); }} type="button"><RefreshCw aria-hidden="true" size={16} />{props.refreshing ? strings.jobProgress.refreshingAction : strings.jobProgress.refreshAction}</button> : null}
        <button className="render-button async-action" disabled={renderCommandDisabled} onClick={() => { void handlePrepare(selectedShotIds); }} ref={triggerRef} type="button"><Film aria-hidden="true" size={16} />{props.rendering || submitting ? strings.renderingAction : preparing ? strings.preparingAction : episodeRenderAction ?? (remaking ? strings.remakeAction : strings.renderAction)}</button>
      </div>
      {confirmation ? <Dialog closeDisabled={submitting} labelledBy="production-confirm-title" onClose={closeConfirmation} open openerRef={triggerRef} title={remaking ? strings.confirmation.remakeTitle : strings.confirmation.title}><ConfirmationContent preparation={confirmation} remaking={remaking} submitting={submitting} strings={strings.confirmation} onCancel={closeConfirmation} onConfirm={() => { void handleRender(confirmation.selected_shot_ids ?? selectedShotIds); }} /></Dialog> : null}
    </section>
  );
}
