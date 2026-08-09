import { LoaderCircle } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import styles from "./Controls.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  loading?: boolean;
  variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { children, className, disabled, icon, loading = false, type = "button", variant = "secondary", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={[styles.button, styles[variant], className].filter(Boolean).join(" ")}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      type={type}
      {...props}
    >
      <span className={styles.buttonContent}>
        {icon ? <span aria-hidden="true">{icon}</span> : null}
        <span>{children}</span>
      </span>
      {loading ? (
        <span className={styles.loader} aria-hidden="true">
          <LoaderCircle className={styles.spinner} size={17} />
        </span>
      ) : null}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, icon, label, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={[styles.iconButton, className].filter(Boolean).join(" ")}
      type={type}
      aria-label={label}
      {...props}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
});
