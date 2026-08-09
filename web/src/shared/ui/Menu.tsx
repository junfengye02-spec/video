import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode } from "react";
import { ScaleFade } from "../motion";
import styles from "./Overlays.module.css";

const MenuCloseContext = createContext<() => void>(() => undefined);

export interface MenuTriggerProps {
  ref: MutableRefObject<HTMLButtonElement | null>;
  "aria-controls": string;
  "aria-expanded": boolean;
  "aria-haspopup": "menu";
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

export function Menu({
  children,
  label,
  placement = "auto",
  trigger,
}: {
  children: ReactNode;
  label: string;
  placement?: "auto" | "bottom" | "top";
  trigger: (props: MenuTriggerProps) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<"first" | "last">("first");
  const [resolvedPlacement, setResolvedPlacement] = useState<"bottom" | "top">("bottom");
  const [alignment, setAlignment] = useState<"left" | "right">("right");
  const [availableHeight, setAvailableHeight] = useState(320);

  useLayoutEffect(() => {
    if (!open || !rootRef.current || !menuRef.current) return;
    const gutter = 12;
    const rootBounds = rootRef.current.getBoundingClientRect();
    const menuBounds = menuRef.current.getBoundingClientRect();
    const spaceAbove = Math.max(0, rootBounds.top - gutter);
    const spaceBelow = Math.max(0, window.innerHeight - rootBounds.bottom - gutter);
    const nextPlacement = placement === "auto"
      ? spaceBelow >= Math.min(menuBounds.height, 320) || spaceBelow >= spaceAbove
        ? "bottom"
        : "top"
      : placement;
    const canAlignRight = rootBounds.right - menuBounds.width >= gutter;
    const canAlignLeft = rootBounds.left + menuBounds.width <= window.innerWidth - gutter;
    setResolvedPlacement(nextPlacement);
    setAlignment(canAlignRight || !canAlignLeft ? "right" : "left");
    setAvailableHeight(Math.max(96, Math.floor(nextPlacement === "top" ? spaceAbove : spaceBelow)));
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? []);
    (initialFocusRef.current === "last" ? items[items.length - 1] : items[0])?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  function openMenu(initialFocus: "first" | "last") {
    initialFocusRef.current = initialFocus;
    setOpen(true);
  }

  function closeMenu(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? []);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "Tab") {
      setOpen(false);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  }

  return (
    <div
      ref={rootRef}
      className={styles.menuRoot}
      data-align={alignment}
      data-placement={resolvedPlacement}
    >
      {trigger({
        ref: triggerRef,
        "aria-controls": id,
        "aria-expanded": open,
        "aria-haspopup": "menu",
        onClick: () => setOpen((current) => !current),
        onKeyDown: (event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(event.key === "ArrowUp" ? "last" : "first");
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            closeMenu(true);
          }
        },
      })}
      {open ? (
        <ScaleFade>
          <div
            ref={menuRef}
            id={id}
            className={styles.menu}
            role="menu"
            aria-label={label}
            style={{ maxHeight: Math.min(320, availableHeight) }}
            onKeyDown={handleKeyDown}
          >
            <MenuCloseContext.Provider value={() => closeMenu(false)}>
              {children}
            </MenuCloseContext.Provider>
          </div>
        </ScaleFade>
      ) : null}
    </div>
  );
}

export function MenuItem({ danger = false, icon, onSelect, selected = false, ...props }: {
  danger?: boolean;
  icon?: ReactNode;
  onSelect?: () => void;
  selected?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  const closeMenu = useContext(MenuCloseContext);
  return (
    <button
      className={styles.menuItem}
      type="button"
      role="menuitem"
      data-danger={danger || undefined}
      data-selected={selected || undefined}
      onClick={() => {
        onSelect?.();
        closeMenu();
      }}
      {...props}
    >
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <span className={styles.menuItemLabel}>{props.children}</span>
    </button>
  );
}
