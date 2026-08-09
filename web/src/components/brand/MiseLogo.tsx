import type { HTMLAttributes } from "react";

export interface MiseLogoProps extends HTMLAttributes<HTMLSpanElement> {
  compact?: boolean;
}

export function MiseLogo({ className = "", compact = false, ...props }: MiseLogoProps) {
  return (
    <span
      className={`mise-logo ${compact ? "mise-logo-compact" : ""} ${className}`.trim()}
      {...props}
    >
      <span className="mise-logo-mark" aria-hidden="true">m</span>
      <span className="mise-logo-wordmark">
        <strong>mise</strong>
        {!compact ? <span>studio</span> : null}
      </span>
    </span>
  );
}
