import { LogOut, ShieldCheck, UserCircle, Video } from "lucide-react";
import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { projectRoutes } from "../../app/routes";
import { useAuth } from "../../auth/AuthProvider";

interface AccountShellActionProps {
  onBeforeNavigate?: () => boolean;
}

const adminBillingText = "\u8d26\u5355\u7ba1\u7406";
const adminVideoModelsText = "\u6a21\u578b\u7ba1\u7406";
const logoutText = "\u9000\u51fa";

export function AccountShellAction({ onBeforeNavigate }: AccountShellActionProps) {
  const auth = useAuth();
  const handleNavigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (onBeforeNavigate && !onBeforeNavigate()) {
      event.preventDefault();
    }
  };

  return (
    <>
      {auth.user?.role === "admin" ? (
        <Link
          className="admin-shell-link"
          to={projectRoutes.adminBilling}
          title={adminBillingText}
          aria-label={adminBillingText}
          onClick={handleNavigate}
        >
          <ShieldCheck aria-hidden="true" size={16} />
          <span>{adminBillingText}</span>
        </Link>
      ) : null}
      {auth.user?.role === "admin" ? (
        <Link
          className="admin-shell-link"
          to={projectRoutes.adminVideoModels}
          title={adminVideoModelsText}
          aria-label={adminVideoModelsText}
          onClick={handleNavigate}
        >
          <Video aria-hidden="true" size={16} />
          <span>{adminVideoModelsText}</span>
        </Link>
      ) : null}
      {auth.user?.email ? (
        <span className="workbench-account">
          <UserCircle aria-hidden="true" size={16} />
          {auth.user.email}
        </span>
      ) : null}
      <button type="button" onClick={() => void auth.logout()}>
        <LogOut aria-hidden="true" size={16} />
        {logoutText}
      </button>
    </>
  );
}
