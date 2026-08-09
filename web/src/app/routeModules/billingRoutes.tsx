import { Outlet, Route } from "react-router-dom";
import { RequireAdmin } from "../../auth/RequireAdmin";
import { RequireAuth } from "../../auth/RequireAuth";
import { AppShell } from "../../components/shell/AppShell";
import { AccountShellAction } from "../../features/account/AccountShellAction";
import { BillingShellAction } from "../../features/billing/BillingShellAction";
import { OrdersPage } from "../../pages/OrdersPage";
import { WalletPage } from "../../pages/WalletPage";
import { BillingAdminPage } from "../../pages/admin/BillingAdminPage";
import { VideoModelAdminPage } from "../../pages/admin/VideoModelAdminPage";

function BillingShellLayout() {
  return (
    <AppShell
      project={null}
      breadcrumb={null}
      accountAction={<AccountShellAction />}
      billingAction={<BillingShellAction />}
    >
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
          <Route path="/admin/video-models" element={<VideoModelAdminPage />} />
        </Route>
      </Route>
    </>
  );
}
