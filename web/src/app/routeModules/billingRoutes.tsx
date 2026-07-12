import { Outlet, Route } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { RequireAdmin } from "../../auth/RequireAdmin";
import { RequireAuth } from "../../auth/RequireAuth";
import { useBilling } from "../../billing/BillingProvider";
import { AppShell } from "../../components/shell/AppShell";
import { OrdersPage } from "../../pages/OrdersPage";
import { WalletPage } from "../../pages/WalletPage";
import { BillingAdminPage } from "../../pages/admin/BillingAdminPage";

function useShellProps() {
  const auth = useAuth();
  const billing = useBilling();
  return {
    accountEmail: auth.user?.email ?? null,
    isAdmin: auth.user?.role === "admin",
    walletAvailableUnits: billing.wallet?.available_units ?? null,
    walletLoading: billing.loading,
    onLogout: auth.logout,
  };
}

function BillingShellLayout() {
  const shellProps = useShellProps();
  return (
    <AppShell project={null} {...shellProps}>
      <Outlet />
    </AppShell>
  );
}

export function billingRoutes() {
  return (
    <>
      <Route element={<RequireAuth />}>
        <Route element={<BillingShellLayout />}>
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/orders" element={<OrdersPage />} />
        </Route>
      </Route>
      <Route element={<RequireAdmin />}>
        <Route element={<BillingShellLayout />}>
          <Route path="/admin/billing" element={<BillingAdminPage />} />
        </Route>
      </Route>
    </>
  );
}

