import { forwardRef, type HTMLAttributes } from "react";
import styles from "./Surface.module.css";

export type SurfaceTone = "content" | "raised" | "floating";

export const Surface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { tone?: SurfaceTone }>(
  function Surface({ className, tone = "content", ...props }, ref) {
    return <div ref={ref} className={[styles.surface, styles[tone], className].filter(Boolean).join(" ")} {...props} />;
  },
);
