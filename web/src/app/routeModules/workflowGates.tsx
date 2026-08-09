import { Navigate, Outlet, useOutletContext } from "react-router-dom";
import { projectRoutes } from "../routes";
import { useWorkbench } from "../workbench/useWorkbench";
import {
  creativeWorkflowFor,
  workflowAllowsProduction,
  workflowHasActiveStoryboardRevision,
} from "./workflowModel";

type ProjectLayoutContext = {
  onDirtyChange: (dirty: boolean) => void;
};

export function ProjectIndexRoute() {
  const { snapshot } = useWorkbench();
  if (!snapshot) return null;
  const workflow = creativeWorkflowFor(snapshot);
  if (workflowAllowsProduction(workflow)) return <Navigate replace to="storyboard" />;
  if (workflow.phase !== "inspiration") return <Navigate replace to="plan-review" />;
  return <Navigate replace to="idea" />;
}

export function ApprovedProjectGate() {
  const { snapshot } = useWorkbench();
  const layoutContext = useOutletContext<ProjectLayoutContext>();
  if (!snapshot) return null;
  const workflow = creativeWorkflowFor(snapshot);
  if (workflowHasActiveStoryboardRevision(workflow)) {
    return <Navigate replace to={projectRoutes.storyboardRevision(snapshot.project.id)} />;
  }
  if (workflow.phase !== "inspiration" && !workflowAllowsProduction(workflow)) {
    return <Navigate replace to={projectRoutes.planReview(snapshot.project.id)} />;
  }
  if (!workflowAllowsProduction(workflow)) {
    return <Navigate replace to={projectRoutes.idea(snapshot.project.id)} />;
  }
  return <Outlet context={layoutContext} />;
}
