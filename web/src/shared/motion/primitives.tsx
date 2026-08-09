import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import styles from "./Motion.module.css";

type MotionProps = HTMLAttributes<HTMLDivElement> & { children: ReactNode };

function classes(base: string, className?: string) {
  return [base, className].filter(Boolean).join(" ");
}

export function Fade({ className, ...props }: MotionProps) {
  return <div className={classes(styles.fade, className)} {...props} />;
}

export function LiftFade({ className, ...props }: MotionProps) {
  return <div className={classes(styles.liftFade, className)} {...props} />;
}

export function ScaleFade({ className, style, ...props }: MotionProps & { origin?: string }) {
  const { origin, ...rest } = props;
  return (
    <div
      className={classes(styles.scaleFade, className)}
      style={{ ...style, "--motion-origin": origin } as CSSProperties}
      {...rest}
    />
  );
}

export function SlidePanel({ className, ...props }: MotionProps) {
  return <div className={classes(styles.slidePanel, className)} {...props} />;
}

export function RouteTransition({ children, routeKey }: { children: ReactNode; routeKey: string }) {
  return <div key={routeKey} className={styles.route}>{children}</div>;
}
