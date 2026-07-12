import { CreditCard, LogOut, ReceiptText, ShieldCheck, UserCircle } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { projectRoutes } from "../../app/routes";
import type { Project } from "../../domain/types";

export interface AppShellProps {
  children: ReactNode;
  project: Project | null;
  accountEmail?: string | null;
  isAdmin?: boolean;
  walletAvailableUnits?: number | null;
  walletLoading?: boolean;
  onBeforeNavigate?: () => boolean;
  onLogout?: () => void | Promise<void>;
}

function walletLabel(value: number | null | undefined, loading: boolean): string {
  if (loading || value === null || value === undefined) return "钱包";
  return `钱包 ${value.toLocaleString("zh-CN")}`;
}

export function AppShell({
  children,
  project,
  accountEmail,
  isAdmin = false,
  walletAvailableUnits,
  walletLoading = false,
  onBeforeNavigate,
  onLogout,
}: AppShellProps) {
  const handleNavigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (onBeforeNavigate && !onBeforeNavigate()) {
      event.preventDefault();
    }
  };

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
        <Link className="workbench-brand" to={projectRoutes.list} onClick={handleNavigate}>
          OpenMontage
        </Link>
        <span className="workbench-project-title">{project?.title ?? "项目工作台"}</span>
        <div className="workbench-topbar-actions">
          <Link to={projectRoutes.wallet} onClick={handleNavigate}>
            <CreditCard aria-hidden="true" size={16} />
            {walletLabel(walletAvailableUnits, walletLoading)}
          </Link>
          <Link to={projectRoutes.orders} onClick={handleNavigate}>
            <ReceiptText aria-hidden="true" size={16} />
            订单
          </Link>
          {isAdmin ? (
            <Link to={projectRoutes.adminBilling} onClick={handleNavigate}>
              <ShieldCheck aria-hidden="true" size={16} />
              账单管理
            </Link>
          ) : null}
          {accountEmail ? (
            <span className="workbench-account">
              <UserCircle aria-hidden="true" size={16} />
              {accountEmail}
            </span>
          ) : null}
          {onLogout ? (
            <button type="button" onClick={() => void onLogout()}>
              <LogOut aria-hidden="true" size={16} />
              退出
            </button>
          ) : null}
        </div>
      </header>
      <div className="workbench-body">
        {project ? (
          <aside className="project-navigation" aria-label="项目导航">
            {links.map(([label, to]) => (
              <NavLink key={to} to={to} onClick={handleNavigate}>{label}</NavLink>
            ))}
          </aside>
        ) : null}
        <main className="workbench-content">{children}</main>
      </div>
    </div>
  );
}
