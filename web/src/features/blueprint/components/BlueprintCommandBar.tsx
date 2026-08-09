import { ArrowRight, Lock } from "lucide-react";
import type { RefObject } from "react";
import { CommandErrorNotice, type CommandError } from "../../../components/feedback/DomainErrorBoundary";
import { Button } from "../../../shared/ui";
import { blueprintCopy as copy } from "../copy";
import styles from "../BlueprintWorkspace.module.css";

export function BlueprintCommandBar({
  allApproved,
  error,
  interactionPending,
  missingCount,
  notice,
  onOpenConfirm,
  openerRef,
}: {
  allApproved: boolean;
  error: CommandError | null;
  interactionPending: boolean;
  missingCount: number;
  notice: string | null;
  onOpenConfirm: () => void;
  openerRef: RefObject<HTMLButtonElement>;
}) {
  return (
    <footer className={styles.commandBar}>
      <div className={styles.commandSummary}>
        <Lock aria-hidden="true" size={17} />
        <p>
          <strong>{allApproved ? "六类蓝图已全部确认" : `还有 ${missingCount} 类待确认`}</strong>
          <span>{allApproved ? "最终确认将锁定当前蓝图版本并进入分镜。" : "未全部确认前，分镜、资源与成片阶段保持锁定。"}</span>
        </p>
      </div>
      <div className={styles.commandMessages} aria-live="polite">
        <CommandErrorNotice error={error} />
        {notice ? <p role="status">{notice}</p> : null}
      </div>
      <Button
        ref={openerRef}
        type="button"
        variant="primary"
        icon={allApproved ? <ArrowRight size={16} /> : <Lock size={15} />}
        disabled={!allApproved || interactionPending}
        onClick={onOpenConfirm}
      >
        {allApproved ? copy.finalApprove : `还有 ${missingCount} 类待确认`}
      </Button>
    </footer>
  );
}
