import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useBilling } from "../../billing/BillingProvider";
import { useWorkbench } from "../workbench/useWorkbench";

export function useSessionExpiredNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  return useCallback(() => {
    navigate("/login", {
      replace: true,
      state: {
        from: {
          hash: location.hash,
          pathname: location.pathname,
          search: location.search,
        },
      },
    });
  }, [location.hash, location.pathname, location.search, navigate]);
}

export function useWorkbenchCommandRecovery() {
  const { clearError } = useWorkbench();
  const billing = useBilling();
  const onSessionExpired = useSessionExpiredNavigation();
  const claimCommandError = useCallback(() => clearError(), [clearError]);

  return {
    claimCommandError,
    onSessionExpired,
    walletAvailableUnits: billing.wallet?.available_units ?? null,
  };
}
