import { Menu, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { projectRoutes } from "../../app/routes";
import { RouteTransition } from "../../shared/motion";
import { MiseLogo } from "../brand/MiseLogo";
import { IconButton } from "../ui/CommandButton";
import styles from "./AppShell.module.css";

const breadcrumbLabel = "项目位置";
const primaryNavigationLabel = "主导航";
const mobileMenuLabel = "打开导航菜单";
const closeMobileMenuLabel = "关闭导航菜单";

export interface AppShellProps {
  project: { id: string; title: string } | null;
  breadcrumb: ReactNode;
  projectNavigation?: ReactNode;
  accountAction: ReactNode;
  billingAction: ReactNode;
  onBeforeNavigate?: () => boolean;
  children: ReactNode;
}

function HomeNavigation({
  onBeforeNavigate,
  pathname,
}: {
  onBeforeNavigate?: () => boolean;
  pathname: string;
}) {
  function handleNavigate(event: MouseEvent<HTMLAnchorElement>) {
    if (onBeforeNavigate && !onBeforeNavigate()) event.preventDefault();
  }

  return (
    <nav className="workbench-primary-navigation" aria-label={primaryNavigationLabel}>
      <NavLink end to={projectRoutes.list} onClick={handleNavigate}>创作</NavLink>
      <span aria-disabled="true" title="打开项目后可进入资源库">资源</span>
      <NavLink
        to={projectRoutes.wallet}
        aria-current={pathname === projectRoutes.wallet ? "page" : undefined}
        onClick={handleNavigate}
      >
        充值
      </NavLink>
      <NavLink
        to={projectRoutes.orders}
        aria-current={pathname === projectRoutes.orders ? "page" : undefined}
        onClick={handleNavigate}
      >
        订单
      </NavLink>
    </nav>
  );
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
  const location = useLocation();
  const mobileMenuId = useId();
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => setMobileMenuOpen(false), [location.key]);

  function handleBrandNavigate(event: MouseEvent<HTMLAnchorElement>) {
    if (onBeforeNavigate && !onBeforeNavigate()) event.preventDefault();
  }

  function handleHeaderKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape" || !mobileMenuOpen) return;
    event.preventDefault();
    setMobileMenuOpen(false);
    window.queueMicrotask(() => menuButtonRef.current?.focus());
  }

  const navigation = projectNavigation ?? (
    <HomeNavigation pathname={location.pathname} onBeforeNavigate={onBeforeNavigate} />
  );

  return (
    <div className={`${styles.shell} workbench-shell ${project ? "has-project" : "is-global"}`}>
      <header className={`${styles.topbar} workbench-topbar`} onKeyDown={handleHeaderKeyDown}>
        <div className="workbench-topbar-leading">
          <Link
            className="workbench-brand"
            to={projectRoutes.list}
            aria-label="mise studio"
            onClick={handleBrandNavigate}
          >
            <MiseLogo />
          </Link>
          {breadcrumb ? (
            <nav className="workbench-breadcrumb" aria-label={breadcrumbLabel}>
              {breadcrumb}
            </nav>
          ) : null}
        </div>

        <div className="workbench-topbar-navigation">{navigation}</div>

        <div className="workbench-topbar-actions">
          {billingAction}
          {accountAction}
        </div>

        <IconButton
          ref={menuButtonRef}
          className="workbench-menu-button"
          label={mobileMenuOpen ? closeMobileMenuLabel : mobileMenuLabel}
          icon={mobileMenuOpen ? <X size={19} /> : <Menu size={19} />}
          aria-expanded={mobileMenuOpen}
          aria-controls={mobileMenuId}
          onClick={() => setMobileMenuOpen((current) => !current)}
        />

        <div
          id={mobileMenuId}
          className={`${styles.mobileMenu} workbench-mobile-menu`}
          role="region"
          aria-label="移动端导航菜单"
          hidden={!mobileMenuOpen}
        >
          {mobileMenuOpen ? (
            <>
              <div className="workbench-mobile-navigation">{navigation}</div>
              <div className="workbench-mobile-actions">
                {billingAction}
                {accountAction}
              </div>
            </>
          ) : null}
        </div>
      </header>

      <div className="workbench-body">
        <main
          className={`${styles.content} workbench-content`}
          data-full-bleed={/\/storyboard$/.test(location.pathname) ? "true" : undefined}
        >
          <RouteTransition routeKey={location.pathname}>{children}</RouteTransition>
        </main>
      </div>
    </div>
  );
}
