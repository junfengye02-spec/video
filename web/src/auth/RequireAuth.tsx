import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";

export function RequireAuth() {
  const auth = useAuth();
  const location = useLocation();

  if (auth.loading) {
    return <p role="status">Checking your session...</p>;
  }
  if (!auth.user) {
    return <Navigate replace to="/login" state={{ from: location }} />;
  }
  return <Outlet />;
}
