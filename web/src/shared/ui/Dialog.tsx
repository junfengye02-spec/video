import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useId, useRef, type ReactNode, type RefObject } from "react";
import { IconButton } from "./Button";
import styles from "./Overlays.module.css";
import { useOverlayFocus } from "./useOverlayFocus";

export function Dialog({
  children,
  closeDisabled = false,
  labelledBy,
  onClose,
  open,
  openerRef,
  title,
}: {
  children: ReactNode;
  closeDisabled?: boolean;
  labelledBy?: string;
  onClose: () => void;
  open: boolean;
  openerRef?: RefObject<HTMLElement>;
  title: ReactNode;
}) {
  const generatedId = useId();
  const titleId = labelledBy ?? generatedId;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const close = useOverlayFocus(open, panelRef, () => {
    if (!closeDisabled) onClose();
  }, openerRef);
  if (!open) return null;

  return createPortal(
    <div className={styles.backdrop} onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <div ref={panelRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className={styles.dialogHeader}>
          <h2 id={titleId} className={styles.dialogTitle}>{title}</h2>
          <IconButton label="关闭" icon={<X size={17} />} disabled={closeDisabled} onClick={close} />
        </header>
        <div className={styles.dialogBody}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
