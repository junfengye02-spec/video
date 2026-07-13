import { Route } from "react-router-dom";
import { ForgotPasswordPage } from "../../pages/ForgotPasswordPage";
import { LoginPage } from "../../pages/LoginPage";
import { RegisterPage } from "../../pages/RegisterPage";
import { ResetPasswordPage } from "../../pages/ResetPasswordPage";

export function accountRoutes() {
  return (
    <>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
    </>
  );
}
