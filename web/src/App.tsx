import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./app/AppRoutes";
import { WorkbenchProvider } from "./app/workbench/WorkbenchProvider";

export default function App() {
  return (
    <BrowserRouter>
      <WorkbenchProvider>
        <AppRoutes />
      </WorkbenchProvider>
    </BrowserRouter>
  );
}
