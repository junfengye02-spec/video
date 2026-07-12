import { useContext } from "react";
import { WorkbenchContext } from "../../features/workbench/WorkbenchSessionProvider";

export function useWorkbench() {
  const context = useContext(WorkbenchContext);
  if (!context) {
    throw new Error("useWorkbench must be used within a WorkbenchSessionProvider");
  }
  return context;
}
