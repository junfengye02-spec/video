import { Navigate, Route, Routes } from "react-router-dom";
import { accountRoutes } from "./routeModules/accountRoutes";
import { billingRoutes } from "./routeModules/billingRoutes";
import { workbenchRoutes } from "./routeModules/workbenchRoutes";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate replace to="/projects" />} />
      {accountRoutes()}
      {billingRoutes()}
      {workbenchRoutes()}
      <Route path="*" element={<Navigate replace to="/projects" />} />
    </Routes>
  );
}
