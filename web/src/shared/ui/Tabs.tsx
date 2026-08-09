import { useRef, type KeyboardEvent, type ReactNode } from "react";
import styles from "./Controls.module.css";

export interface TabItem<Value extends string> {
  value: Value;
  label: ReactNode;
  disabled?: boolean;
}

export function Tabs<Value extends string>({
  ariaLabel,
  items,
  onValueChange,
  value,
}: {
  ariaLabel: string;
  items: TabItem<Value>[];
  onValueChange: (value: Value) => void;
  value: Value;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusValue = items.some((item) => item.value === value && !item.disabled)
    ? value
    : items.find((item) => !item.disabled)?.value;

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]:not(:disabled)") ?? []);
    const current = tabs.indexOf(event.currentTarget);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
    tabs[next]?.click();
  }

  return (
    <div ref={rootRef} className={styles.tabs} role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.value}
          className={styles.tab}
          type="button"
          role="tab"
          aria-selected={value === item.value}
          tabIndex={focusValue === item.value ? 0 : -1}
          disabled={item.disabled}
          onClick={() => {
            if (item.value !== value) onValueChange(item.value);
          }}
          onKeyDown={handleKeyDown}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
