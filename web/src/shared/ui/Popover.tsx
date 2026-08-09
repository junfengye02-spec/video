import {
  useEffect,
  useId,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { ScaleFade } from "../motion";
import styles from "./Overlays.module.css";

const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface PopoverTriggerProps {
  ref: MutableRefObject<HTMLButtonElement | null>;
  "aria-controls": string;
  "aria-expanded": boolean;
  "aria-haspopup": "dialog";
  onClick: () => void;
}

export function Popover({
  children,
  label,
  trigger,
}: {
  children: ReactNode;
  label: string;
  trigger: (props: PopoverTriggerProps) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus());

    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      queueMicrotask(() => triggerRef.current?.focus());
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={styles.popoverRoot}>
      {trigger({
        ref: triggerRef,
        "aria-controls": id,
        "aria-expanded": open,
        "aria-haspopup": "dialog",
        onClick: () => setOpen((current) => !current),
      })}
      {open ? (
        <ScaleFade>
          <div
            ref={panelRef}
            id={id}
            className={styles.popover}
            role="dialog"
            aria-label={label}
          >
            {children}
          </div>
        </ScaleFade>
      ) : null}
    </div>
  );
}
