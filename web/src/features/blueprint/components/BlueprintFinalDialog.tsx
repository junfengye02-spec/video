import { ArrowRight, Lock } from "lucide-react";
import type { RefObject } from "react";
import { CommandErrorNotice, type CommandError } from "../../../components/feedback/DomainErrorBoundary";
import { Button, Dialog } from "../../../shared/ui";
import { blueprintCopy as copy } from "../copy";
import styles from "../BlueprintOverlays.module.css";

export function BlueprintFinalDialog({
  error,
  loading,
  onClose,
  onConfirm,
  open,
  openerRef,
}: {
  error: CommandError | null;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
  open: boolean;
  openerRef: RefObject<HTMLElement>;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      openerRef={openerRef}
      title={copy.finalConfirmTitle}
    >
      <div className={styles.finalDialogBody}>
        <div className={styles.finalDialogMessage}>
          <Lock aria-hidden="true" size={18} />
          <p>
            <strong>当前六类蓝图将被锁定</strong>
            <span>确认后进入分镜阶段，图片、视频和成片制作才会按既有门禁逐步解锁。</span>
          </p>
        </div>
        <CommandErrorNotice error={error} />
        <div className={styles.dialogActions}>
          <Button type="button" variant="secondary" disabled={loading} onClick={onClose}>
            {copy.finalCancel}
          </Button>
          <Button
            type="button"
            variant="primary"
            icon={<ArrowRight size={16} />}
            loading={loading}
            onClick={onConfirm}
          >
            {loading ? copy.finalApproving : copy.finalConfirm}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
