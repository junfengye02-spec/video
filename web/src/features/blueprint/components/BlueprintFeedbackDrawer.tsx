import { RefreshCw } from "lucide-react";
import type { RefObject } from "react";
import { BLUEPRINT_SECTION_COPY } from "../../../components/blueprint/blueprintModel";
import { CommandErrorNotice, type CommandError } from "../../../components/feedback/DomainErrorBoundary";
import type { PlanSectionId } from "../../../domain/types";
import { Button, Drawer } from "../../../shared/ui";
import { blueprintCopy as copy } from "../copy";
import styles from "../BlueprintOverlays.module.css";

export function BlueprintFeedbackDrawer({
  commandError,
  draft,
  impactLabels,
  loading,
  onChange,
  onClose,
  onSubmit,
  open,
  openerRef,
  section,
  validationError,
}: {
  commandError: CommandError | null;
  draft: string;
  impactLabels: string[];
  loading: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  open: boolean;
  openerRef: RefObject<HTMLElement>;
  section: PlanSectionId;
  validationError: string | null;
}) {
  const impactId = `blueprint-impact-${section}`;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      openerRef={openerRef}
      title={`${copy.feedbackLabel} · ${BLUEPRINT_SECTION_COPY[section].shortLabel}`}
    >
      <div className={styles.feedbackBody}>
        <p>反馈会按当前分类保存，并交给文本规划接口重新生成。</p>
        <label>
          <span>{copy.feedbackLabel}</span>
          <textarea
            value={draft}
            disabled={loading}
            aria-describedby={impactId}
            aria-invalid={validationError ? "true" : undefined}
            placeholder={copy.feedbackPlaceholder}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
        <p id={impactId} className={styles.impact}>
          <RefreshCw aria-hidden="true" size={14} />
          <span>{copy.revisionImpact}<strong>{impactLabels.join("、")}</strong></span>
        </p>
        {validationError ? <p className={styles.feedbackError} role="alert">{validationError}</p> : null}
        <CommandErrorNotice error={commandError} />
        <Button
          type="button"
          variant="primary"
          icon={<RefreshCw aria-hidden="true" size={15} />}
          loading={loading}
          disabled={!draft.trim()}
          onClick={onSubmit}
        >
          {loading ? copy.revisingSection : copy.submitChanges}
        </Button>
      </div>
    </Drawer>
  );
}
