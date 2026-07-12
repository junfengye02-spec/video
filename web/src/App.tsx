import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./app/AppRoutes";
import { AuthProvider } from "./auth/AuthProvider";
import { BillingProvider } from "./billing/BillingProvider";

export default function App() {
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
