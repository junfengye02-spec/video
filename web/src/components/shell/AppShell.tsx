import type { MouseEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { projectRoutes } from "../../app/routes";

const projectNavigationLabel = "\u9879\u76ee\u5bfc\u822a";
const breadcrumbLabel = "\u9762\u5305\u5c51";

export interface AppShellProps {
  project: { id: string; title: string } | null;
  breadcrumb: ReactNode;
  projectNavigation?: ReactNode;
  accountAction: ReactNode;
  billingAction: ReactNode;
  onBeforeNavigate?: () => boolean;
  children: ReactNode;
}

export function AppShell({
  accountAction,
  billingAction,
  breadcrumb,
  children,
  onBeforeNavigate,
  project,
  projectNavigation,
}: AppShellProps) {
  const handleNavigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (onBeforeNavigate && !onBeforeNavigate()) {
      event.preventDefault();
    }
  };

  return (
    <div className="workbench-shell">
      <header className="workbench-topbar">
        <Link className="workbench-brand" to={projectRoutes.list} onClick={handleNavigate}>
          OpenMontage
        </Link>
        <span className="workbench-project-title">
          {project?.title ?? "\u9879\u76ee\u5de5\u4f5c\u53f0"}
        </span>
        <div className="workbench-topbar-actions">
          {billingAction}
          {accountAction}
        </div>
      </header>
      <div className="workbench-body">
        {projectNavigation ? (
          <aside className="project-navigation" aria-label={projectNavigationLabel}>
            {projectNavigation}
          </aside>
        ) : null}
        <main className="workbench-content">
          {breadcrumb ? (
            <nav className="workbench-breadcrumb" aria-label={breadcrumbLabel}>
              {breadcrumb}
            </nav>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
