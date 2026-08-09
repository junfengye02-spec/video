import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useId, useRef, type ReactNode, type RefObject } from "react";
import { IconButton } from "./Button";
import styles from "./Overlays.module.css";
import { useOverlayFocus } from "./useOverlayFocus";

export function Drawer({ children, onClose, open, openerRef, title }: {
  children: ReactNode;
  onClose: () => void;
  open: boolean;
  openerRef?: RefObject<HTMLElement>;
  title: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const close = useOverlayFocus(open, panelRef, onClose, openerRef);
  if (!open) return null;

  return createPortal(
    <div className={`${styles.backdrop} ${styles.drawerBackdrop}`} onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <aside ref={panelRef} className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className={styles.drawerHeader}>
          <h2 id={titleId} className={styles.drawerTitle}>{title}</h2>
          <IconButton label="关闭" icon={<X size={17} />} onClick={close} />
        </header>
        <div className={styles.drawerBody}>{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
