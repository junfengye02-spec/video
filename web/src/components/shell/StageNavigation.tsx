import { Check } from "lucide-react";
import type { MouseEvent } from "react";
import { Link } from "react-router-dom";

export type StageState = "active" | "available" | "disabled" | "done";

export interface StageNavigationItem {
  id: string;
  label: string;
  state: StageState;
  to?: string;
  unavailableHint?: string;
}

export function StageNavigation({
  items,
  onBeforeNavigate,
}: {
  items: StageNavigationItem[];
  onBeforeNavigate?: () => boolean;
}) {
  function handleNavigate(event: MouseEvent<HTMLAnchorElement>) {
    if (onBeforeNavigate && !onBeforeNavigate()) event.preventDefault();
  }

  return (
    <nav className="stage-navigation" aria-label="项目阶段">
      <ol>
        {items.map((item, index) => {
          const content = (
            <>
              <span className="stage-navigation-index" aria-hidden="true">
                {item.state === "done" ? <Check size={11} strokeWidth={2.5} /> : index + 1}
              </span>
              <span>{item.label}</span>
            </>
          );
          return (
            <li key={item.id} data-state={item.state}>
              {item.to && item.state !== "disabled" ? (
                <Link
                  to={item.to}
                  aria-current={item.state === "active" ? "step" : undefined}
                  onClick={handleNavigate}
                >
                  {content}
                </Link>
              ) : (
                <span
                  aria-current={item.state === "active" ? "step" : undefined}
                  aria-disabled={item.state === "disabled" || undefined}
                  title={item.unavailableHint}
                >
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
