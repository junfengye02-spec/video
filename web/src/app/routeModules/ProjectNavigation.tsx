import type { MouseEvent } from "react";
import { ArrowLeft, Images, SlidersHorizontal } from "lucide-react";
import { Link } from "react-router-dom";
import {
  StageNavigation,
  type StageNavigationItem,
} from "../../components/shell/StageNavigation";
import type { CreativeWorkflow } from "../../domain/types";
import { projectRoutes } from "../routes";
import { workflowAllowsProduction } from "./workflowModel";

const backToProjectsText = "返回项目列表";
const storyboardText = "分镜";
const settingsText = "全局设定";
const resourcesText = "资源库";
const productionText = "成片";
const inspirationText = "灵感";
const planReviewText = "蓝图";

function guardedNavigate(onBeforeNavigate?: () => boolean) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (onBeforeNavigate && !onBeforeNavigate()) event.preventDefault();
  };
}

function projectSectionLabel(projectId: string, pathname: string): string {
  if (pathname === projectRoutes.idea(projectId)) return inspirationText;
  if (pathname === projectRoutes.planReview(projectId)) return planReviewText;
  if (pathname === projectRoutes.settings(projectId)) return settingsText;
  if (pathname === projectRoutes.resources(projectId)) return resourcesText;
  if (pathname === projectRoutes.production(projectId)) return productionText;
  return storyboardText;
}

export function ProjectNavigation({
  onBeforeNavigate,
  pathname,
  projectId,
  workflow,
}: {
  onBeforeNavigate?: () => boolean;
  pathname: string;
  projectId: string;
  workflow: CreativeWorkflow;
}) {
  const ideaPath = projectRoutes.idea(projectId);
  const reviewPath = projectRoutes.planReview(projectId);
  const storyboardPath = projectRoutes.storyboard(projectId);
  const productionPath = projectRoutes.production(projectId);
  let items: StageNavigationItem[];

  if (workflow.phase === "inspiration") {
    items = [
      { id: "idea", label: inspirationText, state: "active", to: ideaPath },
      { id: "plan", label: planReviewText, state: "disabled", unavailableHint: "确认创意并完成规划后解锁" },
      { id: "storyboard", label: storyboardText, state: "disabled", unavailableHint: "批准蓝图后解锁" },
      { id: "production", label: productionText, state: "disabled", unavailableHint: "批准蓝图后解锁" },
    ];
  } else if (!workflowAllowsProduction(workflow)) {
    const revisingIdea = pathname === ideaPath;
    items = [
      { id: "idea", label: inspirationText, state: revisingIdea ? "active" : "done", to: ideaPath },
      { id: "plan", label: planReviewText, state: revisingIdea ? "available" : "active", to: reviewPath },
      { id: "storyboard", label: storyboardText, state: "disabled", unavailableHint: "批准蓝图后解锁" },
      { id: "production", label: productionText, state: "disabled", unavailableHint: "批准蓝图后解锁" },
    ];
  } else {
    const inProduction = pathname === productionPath;
    items = [
      { id: "idea", label: inspirationText, state: "done" },
      { id: "plan", label: planReviewText, state: "done" },
      {
        id: "storyboard",
        label: storyboardText,
        state: inProduction ? "done" : "active",
        to: storyboardPath,
      },
      {
        id: "production",
        label: productionText,
        state: inProduction ? "active" : "available",
        to: productionPath,
      },
    ];
  }

  const handleNavigate = guardedNavigate(onBeforeNavigate);
  return (
    <div className="project-navigation-cluster">
      <StageNavigation items={items} onBeforeNavigate={onBeforeNavigate} />
      {workflow.phase === "approved" ? (
        <nav className="project-tool-navigation" aria-label="项目工具">
          <Link
            className={pathname === projectRoutes.settings(projectId) ? "active" : ""}
            to={projectRoutes.settings(projectId)}
            aria-label={settingsText}
            title={settingsText}
            onClick={handleNavigate}
          >
            <SlidersHorizontal aria-hidden="true" size={15} />
          </Link>
          <Link
            className={pathname === projectRoutes.resources(projectId) ? "active" : ""}
            to={projectRoutes.resources(projectId)}
            aria-label={resourcesText}
            title={resourcesText}
            onClick={handleNavigate}
          >
            <Images aria-hidden="true" size={15} />
          </Link>
        </nav>
      ) : null}
    </div>
  );
}

export function ProjectBreadcrumb({
  onBeforeNavigate,
  pathname,
  project,
}: {
  onBeforeNavigate?: () => boolean;
  pathname: string;
  project: { id: string; title: string };
}) {
  const handleNavigate = guardedNavigate(onBeforeNavigate);
  return (
    <>
      <Link
        to={projectRoutes.list}
        aria-label={backToProjectsText}
        title={backToProjectsText}
        onClick={handleNavigate}
      >
        <ArrowLeft aria-hidden="true" size={16} />
      </Link>
      <span className="workbench-project-context">
        <strong>{project.title}</strong>
        <span>{projectSectionLabel(project.id, pathname)}</span>
      </span>
    </>
  );
}
