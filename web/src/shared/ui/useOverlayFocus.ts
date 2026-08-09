import { useCallback, useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useOverlayFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement>,
  onClose: () => void,
  openerRef?: RefObject<HTMLElement>,
) {
  const onCloseRef = useRef(onClose);
  const closingRef = useRef(false);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    onCloseRef.current();
  }, []);

  useEffect(() => {
    if (!open) return;
    closingRef.current = false;
    const opener = openerRef?.current ?? document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () => Array.from(panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter((item) => !item.hidden && item.getAttribute("aria-hidden") !== "true");
    queueMicrotask(() => (focusables()[0] ?? panel)?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        panel?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      queueMicrotask(() => opener?.focus());
    };
  }, [open, openerRef, panelRef, requestClose]);

  return requestClose;
}
