import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import styles from "./Controls.module.css";

type TooltipChildProps = { "aria-describedby"?: string };

export function Tooltip({
  children,
  content,
}: {
  children: ReactElement<TooltipChildProps>;
  content: ReactNode;
}) {
  const id = useId();
  const describedBy = children.props["aria-describedby"];
  return (
    <span className={styles.tooltipRoot}>
      {cloneElement(children, { "aria-describedby": [describedBy, id].filter(Boolean).join(" ") })}
      <span id={id} className={styles.tooltip} role="tooltip">{content}</span>
    </span>
  );
}
