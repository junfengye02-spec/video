import { Outlet } from "react-router-dom";
import { WorkbenchSessionProvider } from "../../features/workbench/WorkbenchSessionProvider";

export function WorkbenchSessionLayout() {
  return (
    <WorkbenchSessionProvider>
      <Outlet />
    </WorkbenchSessionProvider>
  );
}
