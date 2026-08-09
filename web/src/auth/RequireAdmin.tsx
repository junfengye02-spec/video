import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./AuthProvider";

export function RequireAdmin() {
  const auth = useAuth();
  const location = useLocation();

  if (auth.loading) {
    return <p role="status">Checking your session...</p>;
  }
  if (!auth.user) {
    return <Navigate replace to="/login" state={{ from: location }} />;
  }
  if (auth.user.role !== "admin") {
    return (
      <section aria-labelledby="not-authorized-title">
        <h1 id="not-authorized-title">Not authorized</h1>
        <p>This account cannot access administration.</p>
      </section>
    );
  }
  return <Outlet />;
}
