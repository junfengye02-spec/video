import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useParams } from "react-router-dom";
import { DomainErrorBoundary } from "../../components/feedback/DomainErrorBoundary";
import { AppShell } from "../../components/shell/AppShell";
import { AccountShellAction } from "../../features/account/AccountShellAction";
import { BillingShellAction } from "../../features/billing/BillingShellAction";
import { getStrings } from "../../i18n";
import { projectRoutes } from "../routes";
import { useWorkbench } from "../workbench/useWorkbench";
import { ProjectBreadcrumb, ProjectNavigation } from "./ProjectNavigation";
import { useDirtyNavigation } from "./useDirtyNavigation";
import { creativeWorkflowFor } from "./workflowModel";
import { LocalBackupStatusSurface, WorkbenchErrorSurface } from "./WorkbenchRouteSurfaces";

const zh = getStrings("zh");
const missingProjectTitle = "此项目不在当前浏览器中";
const backToProjectsText = "返回项目列表";
const loadingProjectText = "正在加载当前浏览器中的项目...";

export type ProjectLayoutContext = {
  onDirtyChange: (dirty: boolean) => void;
};

type ProjectLoadState = {
  error?: string;
  projectId: string | null;
  status: "error" | "loading" | "missing" | "ready";
};

export function ProjectLayout() {
  const { projectId } = useParams();
  const location = useLocation();
  const { openLocalProject, snapshot } = useWorkbench();
  const requestGenerationRef = useRef(0);
  const requestedProjectId = projectId ?? null;
  const { confirmNavigation, onDirtyChange } = useDirtyNavigation(
    requestedProjectId,
    zh.storyboardPage.discardChangesConfirm,
  );
  const [loadState, setLoadState] = useState<ProjectLoadState>({
    projectId: requestedProjectId,
    status: "loading",
  });
  const currentLoadState = loadState.projectId === requestedProjectId
    ? loadState
    : { projectId: requestedProjectId, status: "loading" as const };
  const activeSnapshot = snapshot?.project.id === projectId ? snapshot : null;

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    if (!projectId) {
      setLoadState({ projectId: null, status: "missing" });
      return;
    }
    if (snapshot?.project.id === projectId) {
      setLoadState({ projectId, status: "ready" });
      return;
    }

    setLoadState({ projectId, status: "loading" });
    void openLocalProject(projectId)
      .then((found) => {
        if (generation === requestGenerationRef.current) {
          setLoadState({ projectId, status: found ? "ready" : "missing" });
        }
      })
      .catch((loadError: unknown) => {
        if (generation === requestGenerationRef.current) {
          setLoadState({
            error: loadError instanceof Error && loadError.message
              ? loadError.message
              : zh.projectsPage.loadError,
            projectId,
            status: "error",
          });
        }
      });
  }, [openLocalProject, projectId, snapshot?.project.id]);

  let content;
  if (currentLoadState.status === "missing") {
    content = (
      <section aria-labelledby="missing-project-title">
        <h1 id="missing-project-title">{missingProjectTitle}</h1>
        <Link to={projectRoutes.list}>{backToProjectsText}</Link>
      </section>
    );
  } else if (currentLoadState.status === "error") {
    content = <p role="alert">{currentLoadState.error}</p>;
  } else if (!activeSnapshot || currentLoadState.status === "loading") {
    content = <p role="status">{loadingProjectText}</p>;
  } else {
    content = <Outlet context={{ onDirtyChange } satisfies ProjectLayoutContext} />;
  }

  return (
    <AppShell
      project={activeSnapshot?.project ?? null}
      breadcrumb={activeSnapshot ? (
        <ProjectBreadcrumb
          project={activeSnapshot.project}
          pathname={location.pathname}
          onBeforeNavigate={confirmNavigation}
        />
      ) : null}
      projectNavigation={activeSnapshot ? (
        <ProjectNavigation
          projectId={activeSnapshot.project.id}
          pathname={location.pathname}
          workflow={creativeWorkflowFor(activeSnapshot)}
          onBeforeNavigate={confirmNavigation}
        />
      ) : null}
      accountAction={<AccountShellAction onBeforeNavigate={confirmNavigation} />}
      billingAction={<BillingShellAction onBeforeNavigate={confirmNavigation} />}
      onBeforeNavigate={confirmNavigation}
    >
      <WorkbenchErrorSurface />
      <LocalBackupStatusSurface />
      <DomainErrorBoundary resetKeys={[projectId, location.pathname]}>
        {content}
      </DomainErrorBoundary>
    </AppShell>
  );
}
