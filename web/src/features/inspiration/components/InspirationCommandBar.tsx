import { ArrowRight, Check, MessageCircle, ShieldCheck, Sparkles } from "lucide-react";
import { CommandErrorNotice, type CommandError } from "../../../components/feedback/DomainErrorBoundary";
import { Button } from "../../../shared/ui";
import { inspirationCopy as copy } from "../copy";
import styles from "./CreativeBrief.module.css";

export function InspirationCommandBar({
  controlEndFrames,
  developing,
  error,
  hasBrief,
  onConfirm,
  onControlEndFramesChange,
  onRetry,
  intentSaving,
  planning,
  planSubmitted,
  ready,
}: {
  controlEndFrames: boolean;
  developing: boolean;
  error: CommandError | null;
  hasBrief: boolean;
  onConfirm: () => void;
  onControlEndFramesChange: (enabled: boolean) => void;
  onRetry: () => void;
  intentSaving: boolean;
  planning: boolean;
  planSubmitted: boolean;
  ready: boolean;
}) {
  return (
    <footer className={styles.commandBar} aria-label={copy.confirm}>
      <label className={styles.endFrameControl}>
        <input
          type="checkbox"
          checked={controlEndFrames}
          disabled={!hasBrief || !ready || planning || intentSaving}
          onChange={(event) => onControlEndFramesChange(event.target.checked)}
        />
        <span>{copy.endFrameControl}</span>
        {intentSaving ? <small role="status">{copy.endFrameControlSaving}</small> : null}
      </label>
      <div className={styles.assurance}>
        <ShieldCheck aria-hidden="true" size={18} />
        <p>
          <strong>{copy.assurance}</strong>
          <span>{copy.assuranceDetail}</span>
        </p>
      </div>
      <div className={`${styles.readiness} ${ready ? styles.ready : styles.pending}`} aria-live="polite">
        {ready ? <Check aria-hidden="true" size={15} /> : <MessageCircle aria-hidden="true" size={15} />}
        <span>{hasBrief ? (ready ? copy.ready : copy.notReady) : copy.noBrief}</span>
      </div>
      {planning ? (
        <div className={styles.planningStatus} role="status" aria-label={copy.planningStatus}>
          <Sparkles aria-hidden="true" size={16} />
          <span>{planSubmitted ? copy.submitted : copy.confirming}</span>
        </div>
      ) : null}
      <Button
        type="button"
        variant="primary"
        className={styles.confirmCommand}
        icon={<ArrowRight size={16} />}
        loading={planning}
        disabled={!hasBrief || !ready || developing || intentSaving}
        onClick={onConfirm}
      >
        {copy.confirm}
      </Button>
      <div className={styles.commandFeedback} aria-live="assertive">
        <CommandErrorNotice error={error} />
      </div>
      {error ? (
        <Button
          type="button"
          variant="secondary"
          icon={<Sparkles size={16} />}
          disabled={planning}
          onClick={onRetry}
        >
          {copy.retryPlan}
        </Button>
      ) : null}
    </footer>
  );
}
