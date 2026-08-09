import { Check, ChevronDown } from "lucide-react";
import { useId } from "react";
import { Menu, MenuItem } from "./Menu";
import styles from "./SelectMenu.module.css";

export interface SelectMenuOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectMenuProps<T extends string> {
  compact?: boolean;
  disabled?: boolean;
  label: string;
  onValueChange: (value: T) => void;
  options: readonly SelectMenuOption<T>[];
  placement?: "auto" | "bottom" | "top";
  required?: boolean;
  value: T;
}

export function SelectMenu<T extends string>({
  compact = false,
  disabled = false,
  label,
  onValueChange,
  options,
  placement = "auto",
  required = false,
  value,
}: SelectMenuProps<T>) {
  const labelId = useId();
  const selectedOption = options.find((option) => option.value === value);

  return (
    <div className={styles.root} data-compact={compact}>
      <span id={labelId} className={styles.label}>{label}</span>
      <Menu
        label={label}
        placement={placement}
        trigger={(triggerProps) => (
          <button
            {...triggerProps}
            type="button"
            className={styles.trigger}
            aria-labelledby={labelId}
            aria-required={required || undefined}
            disabled={disabled}
            title={selectedOption?.label ?? value}
          >
            <span>{selectedOption?.label ?? value}</span>
            <ChevronDown aria-hidden="true" size={14} />
          </button>
        )}
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <MenuItem
              key={option.value}
              disabled={option.disabled}
              selected={selected}
              title={option.label}
              icon={<Check size={14} style={{ opacity: selected ? 1 : 0 }} />}
              onSelect={() => onValueChange(option.value)}
            >
              {option.label}
            </MenuItem>
          );
        })}
      </Menu>
    </div>
  );
}
