import { LogOut, ShieldCheck, UserCircle } from "lucide-react";
import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { projectRoutes } from "../../app/routes";
import { useAuth } from "../../auth/AuthProvider";

interface AccountShellActionProps {
  onBeforeNavigate?: () => boolean;
}

const adminBillingText = "\u8d26\u5355\u7ba1\u7406";
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
        <Link to={projectRoutes.adminBilling} onClick={handleNavigate}>
          <ShieldCheck aria-hidden="true" size={16} />
          {adminBillingText}
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
