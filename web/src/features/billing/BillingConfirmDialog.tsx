import { AlertTriangle, X } from "lucide-react";
import type { RefObject } from "react";
import { useModalFocus } from "../../components/accessibility/useModalFocus";

interface BillingConfirmDialogProps {
  confirmLabel: string;
  description: string;
  error: string | null;
  pending: boolean;
  reason: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
  onReasonChange: (reason: string) => void;
}

export function BillingConfirmDialog({
  confirmLabel,
  description,
  error,
  pending,
  reason,
  returnFocusRef,
  title,
  onCancel,
  onConfirm,
  onReasonChange,
}: BillingConfirmDialogProps) {
  const { panelRef, onKeyDown } = useModalFocus<HTMLDivElement>({
    open: true,
    onEscape: () => {
      if (!pending) onCancel();
    },
    returnFocusRef,
  });

  return (
    <div className="billing-dialog-backdrop" role="presentation">
      <div
        ref={panelRef}
        className="billing-confirm-dialog"
        role="dialog"
        aria-labelledby="billing-confirm-title"
        aria-describedby="billing-confirm-description"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header>
          <div>
            <span><AlertTriangle aria-hidden="true" size={16} /> 高风险操作</span>
            <h2 id="billing-confirm-title">{title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭确认对话框"
            title="关闭"
            disabled={pending}
            onClick={onCancel}
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <p id="billing-confirm-description">{description}</p>
        <p className="billing-review-notice">
          此操作会写入管理员审计记录。请在提交前再次核对对象、数值和影响范围。
        </p>
        <label htmlFor="billing-confirm-reason">
          操作原因
          <textarea
            id="billing-confirm-reason"
            maxLength={500}
            rows={3}
            value={reason}
            disabled={pending}
            onChange={(event) => onReasonChange(event.target.value)}
          />
        </label>
        {error ? <p className="billing-dialog-error" role="alert">{error}</p> : null}
        <footer>
          <button className="secondary-button" type="button" disabled={pending} onClick={onCancel}>
            取消
          </button>
          <button
            className="danger-button async-action"
            type="button"
            disabled={pending || !reason.trim()}
            onClick={onConfirm}
          >
            <AlertTriangle aria-hidden="true" size={16} />
            {pending ? "正在提交" : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
