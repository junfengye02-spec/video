import {
  Check,
  ChevronRight,
  Clock3,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Video,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type {
  GenerationExecutionSnapshot,
  GenerationExecutionUnit,
  GenerationPlan,
  GenerationUnit,
  Shot,
  TaskItem,
  VideoModelProfile,
} from "../../../domain/types";
import type { UIStrings } from "../../../i18n";
import { Button, Dialog } from "../../../shared/ui";
import styles from "./GenerationPlanPanel.module.css";

type UnitRecord = GenerationUnit | GenerationExecutionUnit;

export interface GenerationPlanPanelProps {
  confirmingPlan?: boolean;
  execution?: GenerationExecutionSnapshot | null;
  generationItems?: Map<string, { batchId: string; item: TaskItem }>;
  generationPlan: GenerationPlan | null;
  modelDurationConfigured?: boolean | null;
  previewing: boolean;
  revisingStoryboard?: boolean;
  regenerateUnitIds?: Set<string>;
  retryingItemId?: string | null;
  shots: Shot[];
  strings: UIStrings["storyboardPage"];
  submitting: boolean;
  onAcceptLonger: () => void;
  onChooseModel: () => void;
  onGenerate: () => void;
  onRegenerateUnit: (unitId: string) => void;
  onReviseStoryboard?: () => void;
  onRetryItem?: (batchId: string, itemId: string) => void;
}

export function GenerationPlanPanel({
  confirmingPlan = false,
  execution = null,
  generationItems = new Map(),
  generationPlan,
  modelDurationConfigured = null,
  previewing,
  revisingStoryboard = false,
  regenerateUnitIds = new Set(),
  retryingItemId = null,
  shots,
  strings,
  submitting,
  onAcceptLonger,
  onChooseModel,
  onGenerate,
  onRegenerateUnit,
  onReviseStoryboard,
  onRetryItem,
}: GenerationPlanPanelProps) {
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const [regenerationUnit, setRegenerationUnit] = useState<UnitRecord | null>(null);
  const shotsById = useMemo(
    () => new Map(shots.map((shot) => [shot.id, shot])),
    [shots],
  );
  const rows = useMemo(
    () => generationRows(generationPlan, execution),
    [execution, generationPlan],
  );
  const executionStatuses = new Map(
    (execution?.generation_units ?? []).map((unit) => [`${unit.id}:${unit.revision}`, unit.status]),
  );
  const pendingUnitIds = generationPlan?.generation_units
    .filter((unit) => (
      unit.status === "planned"
      && !generationItems.has(unit.id)
      && !executionStatuses.has(`${unit.id}:${unit.revision}`)
    ))
    .map((unit) => unit.id) ?? [];
  const requiresDecision = Boolean(
    generationPlan && (!generationPlan.can_generate || generationPlan.requires_confirmation),
  );
  const recommendedContentDuration = generationPlan
    ? totalRecommendedContentDuration(generationPlan.generation_units)
    : null;
  const requestedDurationTotal = generationPlan
    ? totalRequestedDuration(generationPlan.generation_units)
    : null;

  function openRegeneration(unit: UnitRecord, opener: HTMLButtonElement) {
    openerRef.current = opener;
    setRegenerationUnit(unit);
  }

  function confirmRegeneration() {
    if (!regenerationUnit) return;
    onRegenerateUnit(regenerationUnit.id);
    setRegenerationUnit(null);
  }

  return (
    <section className={styles.root} aria-label={strings.generationPlanRegionLabel}>
      {previewing ? (
        <div className={styles.loading} role="status">
          <RefreshCw aria-hidden="true" size={14} />
          <span>{strings.generationPlanLoading}</span>
        </div>
      ) : generationPlan ? (
        <>
          <header className={styles.summary} data-blocked={requiresDecision ? "true" : "false"}>
            <div>
              <strong>{strings.generationPlanCounts(
                generationPlan.storyboard_shot_count,
                generationPlan.generation_unit_count,
                generationPlan.native_total_duration_seconds,
              )}</strong>
              <span>{strings.generationPlanModel(generationPlan.provider, generationPlan.model_id)}</span>
            </div>
            <dl aria-label={strings.durationComparisonLabel}>
              <Metric
                label={strings.recommendedContentDurationLabel}
                value={strings.durationValue(recommendedContentDuration)}
              />
              <Metric
                label={strings.requestedDurationTotalLabel}
                value={strings.durationValue(requestedDurationTotal)}
              />
              <Metric
                label={strings.nativeDurationLabel}
                value={strings.durationValue(generationPlan.native_total_duration_seconds)}
              />
              <Metric
                label={strings.targetDurationLabel}
                value={strings.durationValue(generationPlan.target_duration_seconds)}
              />
              <Metric
                label={strings.durationDifferenceLabel}
                value={strings.durationDifferenceValue(generationPlan.duration_difference_seconds)}
                tone={(generationPlan.duration_difference_seconds ?? 0) > 0 ? "warning" : "neutral"}
              />
            </dl>
          </header>

          {generationPlan.issues.length ? (
            <div className={styles.issues} role={requiresDecision ? "alert" : "status"}>
              {generationPlan.issues.map((issue, index) => (
                <p key={`${issue.code}-${issue.unit_id ?? issue.shot_id ?? index}`}>{issue.message}</p>
              ))}
            </div>
          ) : null}

          {requiresDecision ? (
            <div className={styles.decisions} aria-label={strings.adaptationActionsLabel}>
              {hasOption(generationPlan, "accept_longer_duration")
                && !hasUnresolvedGenerationBlocker(generationPlan) ? (
                <Button
                  variant="secondary"
                  loading={confirmingPlan}
                  disabled={confirmingPlan}
                  icon={<Clock3 size={14} />}
                  onClick={onAcceptLonger}
                >
                  {strings.acceptLongerDurationAction}
                </Button>
              ) : null}
              {hasOption(generationPlan, "revise_or_merge_storyboard") ? (
                <Button
                  variant="secondary"
                  loading={revisingStoryboard}
                  disabled={revisingStoryboard || !onReviseStoryboard}
                  icon={<ChevronRight size={14} />}
                  onClick={onReviseStoryboard}
                >
                  {strings.reviseStoryboardAction}
                </Button>
              ) : null}
              {hasOption(generationPlan, "choose_compatible_model") ? (
                <Button variant="secondary" icon={<Video size={14} />} onClick={onChooseModel}>
                  {strings.chooseCompatibleModelAction}
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className={styles.unitList}>
            {rows.map((row, index) => {
              const task = generationItems.get(row.unit.id);
              const status = task?.item.status ?? row.unit.status;
              const protectedUnit = generationPlan.protected_generation_unit_ids.includes(row.unit.id);
              const active = "active" in row.unit && row.unit.active === true;
              const planned = row.source === "plan" && row.unit.status === "planned";
              const replacement = Boolean(row.unit.replaces_unit_id)
                || regenerateUnitIds.has(row.unit.id);
              const canRegenerate = status === "complete"
                && (active || protectedUnit)
                && !regenerateUnitIds.has(row.unit.id);
              const profile = unitProfile(row.unit);
              const unitContentDuration = recommendedContentDurationForUnit(row.unit);
              return (
                <article
                  key={`${row.unit.id}:${row.unit.revision}:${row.source}`}
                  className={styles.unit}
                  data-status={status}
                  data-protected={protectedUnit || active ? "true" : "false"}
                >
                  <header>
                    <span className={styles.unitIndex}>{strings.generationUnitIndex(index + 1)}</span>
                    <span className={styles.badges}>
                      {protectedUnit ? <UnitBadge icon={<LockKeyhole size={12} />} label={strings.unitStatusProtected} /> : null}
                      {active ? <UnitBadge icon={<ShieldCheck size={12} />} label={strings.unitStatusActive} /> : null}
                      {replacement ? <UnitBadge icon={<RefreshCw size={12} />} label={strings.unitStatusRegenerate} /> : null}
                      <UnitBadge
                        icon={planned ? <Check size={12} /> : undefined}
                        label={unitStatusLabel(status, strings)}
                      />
                    </span>
                  </header>
                  <div className={styles.unitMeta}>
                    <span>{strings.recommendedContentDurationValue(unitContentDuration)}</span>
                    <span aria-hidden="true">→</span>
                    <span>{strings.requestedDurationValue(row.unit.requested_duration_seconds)}</span>
                    <span>{strings.providerModelValue(row.unit.provider, row.unit.model_id)}</span>
                  </div>
                  {row.unit.output_asset_id || row.unit.output_path ? (
                    <p className={styles.assetPath}>
                      {strings.unitAssetValue(row.unit.output_asset_id, row.unit.output_path)}
                    </p>
                  ) : null}
                  <ol className={styles.sourceList}>
                    {row.unit.source_shot_ids.map((shotId, sourceIndex) => {
                      const shot = shotsById.get(shotId);
                      const beatId = row.unit.source_beat_ids[sourceIndex] ?? shot?.beat_id ?? shotId;
                      return (
                        <li key={shotId}>
                          <span>{shot ? strings.shotTitle(shot.index) : shotId}</span>
                          <strong>{shot?.beat || beatId}</strong>
                          <small>{strings.sourceBeatId(beatId)}</small>
                        </li>
                      );
                    })}
                  </ol>
                  <div className={styles.capabilities}>
                    <span>{profile
                      ? strings.unitDurationContract(profile.duration_mode)
                      : strings.unitCapabilityUnknown}</span>
                    {boundaryText(row.unit, shotsById, strings) ? (
                      <span>{boundaryText(row.unit, shotsById, strings)}</span>
                    ) : null}
                  </div>
                  {row.source === "retained" ? (
                    <p className={styles.retainedNote}>{strings.activeMediaRetained}</p>
                  ) : null}
                  {canRegenerate ? (
                    <button
                      type="button"
                      className={styles.regenerateAction}
                      onClick={(event) => openRegeneration(row.unit, event.currentTarget)}
                    >
                      <RefreshCw aria-hidden="true" size={13} />
                      <span>{strings.regenerateUnitAction}</span>
                    </button>
                  ) : null}
                  {task?.item.status === "failed" && task.item.retryable && onRetryItem ? (
                    <button
                      type="button"
                      className={styles.retryAction}
                      disabled={retryingItemId !== null}
                      onClick={() => onRetryItem(task.batchId, task.item.id)}
                    >
                      <RefreshCw aria-hidden="true" size={13} />
                      <span>{retryingItemId === task.item.id
                        ? strings.retryingUnitAction
                        : strings.retryUnitAction}</span>
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>

          <Button
            variant="primary"
            icon={<Video size={15} />}
            loading={submitting}
            disabled={
              !pendingUnitIds.length
              || submitting
              || confirmingPlan
              || generationPlan.requires_confirmation
              || !generationPlan.can_generate
              || modelDurationConfigured === false
            }
            onClick={onGenerate}
          >
            {submitting
              ? strings.submittingUnitsAction
              : strings.generatePendingUnitsAction(pendingUnitIds.length)}
          </Button>
        </>
      ) : (
        <p className={styles.empty}>{strings.generationPlanEmpty}</p>
      )}

      <Dialog
        open={Boolean(regenerationUnit)}
        title={regenerationUnit && regenerationUnit.source_shot_ids.length > 1
          ? strings.regenerateMultiUnitTitle
          : strings.regenerateSingleUnitTitle}
        openerRef={openerRef}
        onClose={() => setRegenerationUnit(null)}
      >
        {regenerationUnit ? (
          <div className={styles.dialogContent}>
            <p>{regenerationUnit.source_shot_ids.length > 1
              ? strings.regenerateMultiUnitBody(regenerationUnit.source_shot_ids.length)
              : strings.regenerateSingleUnitBody}</p>
            <ol>
              {regenerationUnit.source_shot_ids.map((shotId, index) => {
                const shot = shotsById.get(shotId);
                const beatId = regenerationUnit.source_beat_ids[index] ?? shot?.beat_id ?? shotId;
                return (
                  <li key={shotId}>
                    <strong>{shot ? strings.shotTitle(shot.index) : shotId}</strong>
                    <span>{shot?.beat || beatId}</span>
                  </li>
                );
              })}
            </ol>
            {regenerationUnit.source_shot_ids.length > 1 ? (
              <p className={styles.revisionNote}>{strings.regeneratePartialRevisionNotice}</p>
            ) : null}
            <footer>
              <Button variant="secondary" onClick={() => setRegenerationUnit(null)}>
                {strings.cancelUnitRegenerationAction}
              </Button>
              <Button variant="primary" icon={<RefreshCw size={15} />} onClick={confirmRegeneration}>
                {regenerationUnit.source_shot_ids.length > 1
                  ? strings.confirmWholeUnitRegenerationAction
                  : strings.confirmUnitRegenerationAction}
              </Button>
            </footer>
          </div>
        ) : null}
      </Dialog>
    </section>
  );
}

function Metric({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: "neutral" | "warning";
  value: string;
}) {
  return (
    <div data-tone={tone}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function UnitBadge({ icon, label }: { icon?: ReactNode; label: string }) {
  return <span>{icon}{label}</span>;
}

function generationRows(
  plan: GenerationPlan | null,
  execution: GenerationExecutionSnapshot | null,
): Array<{ source: "plan" | "retained"; unit: UnitRecord }> {
  if (!plan) return [];
  const executionByRevision = new Map(
    (execution?.generation_units ?? []).map((unit) => [`${unit.id}:${unit.revision}`, unit]),
  );
  const planKeys = new Set<string>();
  const rows: Array<{ source: "plan" | "retained"; unit: UnitRecord }> = plan.generation_units.map((unit) => {
    const key = `${unit.id}:${unit.revision}`;
    planKeys.add(key);
    return { source: "plan", unit: executionByRevision.get(key) ?? unit };
  });
  const selectedShots = new Set(plan.shot_ids);
  for (const unit of execution?.generation_units ?? []) {
    const key = `${unit.id}:${unit.revision}`;
    if (
      planKeys.has(key)
      || unit.active !== true
      || !unit.source_shot_ids.every((shotId) => selectedShots.has(shotId))
    ) continue;
    rows.push({ source: "retained", unit });
  }
  const positions = new Map(plan.shot_ids.map((shotId, index) => [shotId, index]));
  return rows.sort((left, right) => {
    const position = (positions.get(left.unit.source_shot_ids[0]) ?? Number.MAX_SAFE_INTEGER)
      - (positions.get(right.unit.source_shot_ids[0]) ?? Number.MAX_SAFE_INTEGER);
    if (position) return position;
    if (left.source !== right.source) return left.source === "retained" ? -1 : 1;
    return left.unit.id.localeCompare(right.unit.id);
  });
}

function hasOption(plan: GenerationPlan, option: string): boolean {
  const aliases: Record<string, string[]> = {
    accept_longer_duration: ["accept_longer_duration", "accept_model_duration"],
    revise_or_merge_storyboard: ["revise_or_merge_storyboard", "revise_storyboard"],
    choose_compatible_model: ["choose_compatible_model"],
  };
  return (aliases[option] ?? [option]).some((candidate) => plan.adaptation_options.includes(candidate));
}

function hasUnresolvedGenerationBlocker(plan: GenerationPlan): boolean {
  return plan.issues.some((issue) => (
    issue.code === "beat_cannot_split"
    || issue.code === "generation_partition_impossible"
    || issue.code === "video_generation_adaptation_required"
    || issue.code === "video_model_contract_unknown"
  ));
}

function unitProfile(unit: UnitRecord): VideoModelProfile | null {
  return unit.profile ?? null;
}

function recommendedContentDurationForUnit(unit: UnitRecord): number | null {
  const durations = (unit.prompt_segments ?? [])
    .map((segment) => segment.recommended_content_duration_seconds)
    .filter((value): value is number => (
      typeof value === "number" && Number.isFinite(value) && value > 0
    ));
  return durations.length
    ? durations.reduce((total, duration) => total + duration, 0)
    : null;
}

function totalRecommendedContentDuration(units: UnitRecord[]): number | null {
  const durations = units
    .map(recommendedContentDurationForUnit)
    .filter((value): value is number => value !== null);
  return durations.length
    ? durations.reduce((total, duration) => total + duration, 0)
    : null;
}

function totalRequestedDuration(units: UnitRecord[]): number | null {
  const durations = units
    .map((unit) => unit.requested_duration_seconds)
    .filter((value): value is number => (
      typeof value === "number" && Number.isFinite(value) && value > 0
    ));
  return durations.length
    ? durations.reduce((total, duration) => total + duration, 0)
    : null;
}

function boundaryText(
  unit: UnitRecord,
  shotsById: Map<string, Shot>,
  strings: UIStrings["storyboardPage"],
): string | null {
  const reasons = unit.source_shot_ids
    .map((shotId) => shotsById.get(shotId)?.cannot_split_reason?.trim())
    .filter((value): value is string => Boolean(value));
  return reasons.length
    ? strings.unitBoundaryReasons([...new Set(reasons)].join(" / "))
    : strings.unitBoundaryCount(Math.max(0, unit.source_shot_ids.length - 1));
}

function unitStatusLabel(
  status: string,
  strings: UIStrings["storyboardPage"],
): string {
  const labels: Record<string, string> = {
    planned: strings.unitStatusPending,
    queued: strings.unitStatusQueued,
    running: strings.unitStatusRunning,
    waiting_provider: strings.unitStatusWaiting,
    waiting_dependency: strings.unitStatusWaiting,
    awaiting_payment: strings.unitStatusWaiting,
    complete: strings.unitStatusComplete,
    failed: strings.unitStatusFailed,
    cancelled: strings.unitStatusFailed,
    stale: strings.unitStatusStale,
  };
  return labels[status] ?? status;
}
