import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthProvider";
import { BillingProvider } from "../billing/BillingProvider";
import { AppRoutes } from "./AppRoutes";

export function AppComposition() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <BillingProvider>
          <AppRoutes />
        </BillingProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
