import { useCallback, useEffect, useRef, type KeyboardEventHandler, type RefObject } from "react";

export interface ModalFocusOptions {
  open: boolean;
  onEscape: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isHidden(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return true;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return true;
  const parent = element.parentElement;
  return parent ? isHidden(parent) : false;
}

function focusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && !isHidden(element));
}

export function useModalFocus<T extends HTMLElement>({
  open,
  onEscape,
  returnFocusRef,
}: ModalFocusOptions): {
  panelRef: RefObject<T>;
  onKeyDown: KeyboardEventHandler<T>;
} {
  const panelRef = useRef<T>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        returnFocusRef.current?.focus();
      }
      return undefined;
    }

    wasOpenRef.current = true;
    const panel = panelRef.current;
    const dialog = panel instanceof HTMLDialogElement ? panel : null;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    let cancelled = false;
    window.queueMicrotask(() => {
      if (cancelled) return;
      const panel = panelRef.current;
      if (!panel) return;
      const [first] = focusableElements(panel);
      (first ?? panel).focus();
    });

    return () => {
      cancelled = true;
      if (dialog?.open) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        returnFocusRef.current?.focus();
      }
    };
  }, [open, returnFocusRef]);

  const onKeyDown = useCallback<KeyboardEventHandler<T>>((event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== "Tab") return;

    const panel = panelRef.current;
    if (!panel) return;
    const controls = focusableElements(panel);
    if (controls.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }

    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !panel.contains(active)) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (active === last || !panel.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }, [onEscape]);

  return { panelRef, onKeyDown };
}
