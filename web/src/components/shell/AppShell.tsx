import { CreditCard, Settings2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import type { Project } from "../../domain/types";
import { projectRoutes } from "../../app/routes";
import { ToastRegion } from "../feedback/ToastRegion";

export interface AppShellProps {
  children: ReactNode;
  project: Project | null;
  providerPanel: ReactNode;
  providerOpen?: boolean;
  onProviderOpenChange?: (open: boolean) => void;
}

export function AppShell({
  children,
  project,
  providerPanel,
  providerOpen,
  onProviderOpenChange,
}: AppShellProps) {
  const [localProviderOpen, setLocalProviderOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const drawerOpen = providerOpen ?? localProviderOpen;
  const setDrawerOpen = onProviderOpenChange ?? setLocalProviderOpen;

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const links = project
    ? [
        ["分镜编辑", projectRoutes.storyboard(project.id)],
        ["全局设定", projectRoutes.settings(project.id)],
        ["资源库", projectRoutes.resources(project.id)],
        ["制作与成片", projectRoutes.production(project.id)],
      ]
    : [];

  return (
    <div className="workbench-shell">
      <header className="workbench-topbar">
        <Link className="workbench-brand" to={projectRoutes.list}>OpenMontage</Link>
        <span className="workbench-project-title">{project?.title ?? "项目工作台"}</span>
        <div className="workbench-topbar-actions">
          <button type="button" onClick={() => setDrawerOpen(true)}>
            <Settings2 aria-hidden="true" size={16} />接口配置
          </button>
          <button type="button" onClick={() => setToast("功能开发中")}>
            <CreditCard aria-hidden="true" size={16} />充值
          </button>
        </div>
      </header>
      <div className="workbench-body">
        {project ? (
          <aside className="project-navigation" aria-label="项目导航">
            {links.map(([label, to]) => (
              <NavLink key={to} to={to}>{label}</NavLink>
            ))}
          </aside>
        ) : null}
        <main className="workbench-content">{children}</main>
      </div>
      {drawerOpen ? (
        <div className="drawer-layer" role="dialog" aria-modal="true" aria-label="接口配置">
          <button type="button" aria-label="关闭接口配置" onClick={() => setDrawerOpen(false)}>×</button>
          {providerPanel}
        </div>
      ) : null}
      <ToastRegion message={toast} />
    </div>
  );
}
