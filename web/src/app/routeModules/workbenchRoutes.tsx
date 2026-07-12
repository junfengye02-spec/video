import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";
import { RequireAuth } from "../../auth/RequireAuth";
import { useBilling } from "../../billing/BillingProvider";
import { DomainErrorBoundary } from "../../components/feedback/DomainErrorBoundary";
import { AppShell } from "../../components/shell/AppShell";
import type { AssetRecord, Shot, ShotSaveRequest } from "../../domain/types";
import { AccountShellAction } from "../../features/account/AccountShellAction";
import { BillingShellAction } from "../../features/billing/BillingShellAction";
import { WorkbenchSessionProvider } from "../../features/workbench/WorkbenchSessionProvider";
import { getStrings } from "../../i18n";
import type { LocalMediaRef } from "../../localdb/types";
import { mediaUrl } from "../../api/client";
import { GlobalSettingsPage } from "../../pages/GlobalSettingsPage";
import { NewProjectPage } from "../../pages/NewProjectPage";
import { ProductionPage } from "../../pages/ProductionPage";
import { ProjectsPage } from "../../pages/ProjectsPage";
import { ResourceLibraryPage } from "../../pages/ResourceLibraryPage";
import { StoryboardPage } from "../../pages/StoryboardPage";
import { projectRoutes } from "../routes";
import { emptyContinuityPlan } from "../workbench/snapshot";
import { useWorkbench } from "../workbench/useWorkbench";

const zh = getStrings("zh");
const closeErrorLabel = "\u5173\u95ed\u9519\u8bef\u63d0\u793a";
const closeErrorText = "\u5173\u95ed";
const missingProjectTitle = "\u6b64\u9879\u76ee\u4e0d\u5728\u5f53\u524d\u6d4f\u89c8\u5668\u4e2d";
const backToProjectsText = "\u8fd4\u56de\u9879\u76ee\u5217\u8868";
const loadingProjectText = "\u6b63\u5728\u52a0\u8f7d\u5f53\u524d\u6d4f\u89c8\u5668\u4e2d\u7684\u9879\u76ee...";
const projectListText = "\u9879\u76ee\u5217\u8868";
const storyboardText = "\u5206\u955c\u7f16\u8f91";
const settingsText = "\u5168\u5c40\u8bbe\u5b9a";
const resourcesText = "\u8d44\u6e90\u5e93";
const productionText = "\u5236\u4f5c\u4e0e\u6210\u7247";

type ProjectLayoutContext = {
  onDirtyChange: (dirty: boolean) => void;
};

type ProjectLoadState = {
  error?: string;
  projectId: string | null;
  status: "error" | "loading" | "missing" | "ready";
};

function useSessionExpiredNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  return useCallback(() => {
    navigate("/login", {
      replace: true,
      state: {
        from: {
          hash: location.hash,
          pathname: location.pathname,
          search: location.search,
        },
      },
    });
  }, [location.hash, location.pathname, location.search, navigate]);
}

function useWorkbenchCommandRecovery() {
  const { clearError } = useWorkbench();
  const billing = useBilling();
  const onSessionExpired = useSessionExpiredNavigation();
  const claimCommandError = useCallback(() => clearError(), [clearError]);

  return {
    claimCommandError,
    onSessionExpired,
    walletAvailableUnits: billing.wallet?.available_units ?? null,
  };
}

function ErrorSurface() {
  const { clearError, error } = useWorkbench();
  if (!error) return null;

  return (
    <div className="workbench-error" role="alert">
      <span>{error}</span>
      <button type="button" aria-label={closeErrorLabel} onClick={clearError}>
        {closeErrorText}
      </button>
    </div>
  );
}

function LocalBackupStatusSurface() {
  const { localBackupStatus } = useWorkbench();
  if (localBackupStatus === "idle") return null;

  return (
    <p className="workbench-local-backup-status" role="status">
      {zh.localBackup[localBackupStatus]}
    </p>
  );
}

function guardedNavigate(onBeforeNavigate?: () => boolean) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (onBeforeNavigate && !onBeforeNavigate()) {
      event.preventDefault();
    }
  };
}

function projectSectionLabel(projectId: string, pathname: string): string {
  if (pathname === projectRoutes.settings(projectId)) return settingsText;
  if (pathname === projectRoutes.resources(projectId)) return resourcesText;
  if (pathname === projectRoutes.production(projectId)) return productionText;
  return storyboardText;
}

function ProjectNavigation({
  onBeforeNavigate,
  projectId,
}: {
  onBeforeNavigate?: () => boolean;
  projectId: string;
}) {
  const handleNavigate = guardedNavigate(onBeforeNavigate);
  return (
    <>
      <NavLink to={projectRoutes.storyboard(projectId)} onClick={handleNavigate}>
        {storyboardText}
      </NavLink>
      <NavLink to={projectRoutes.settings(projectId)} onClick={handleNavigate}>
        {settingsText}
      </NavLink>
      <NavLink to={projectRoutes.resources(projectId)} onClick={handleNavigate}>
        {resourcesText}
      </NavLink>
      <NavLink to={projectRoutes.production(projectId)} onClick={handleNavigate}>
        {productionText}
      </NavLink>
    </>
  );
}

function ProjectBreadcrumb({
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
      <Link to={projectRoutes.list} onClick={handleNavigate}>{projectListText}</Link>
      <span>{project.title}</span>
      <span>{projectSectionLabel(project.id, pathname)}</span>
    </>
  );
}

function WorkbenchSessionLayout() {
  return (
    <WorkbenchSessionProvider>
      <Outlet />
    </WorkbenchSessionProvider>
  );
}

function RootLayout() {
  const location = useLocation();
  return (
    <AppShell
      project={null}
      breadcrumb={null}
      accountAction={<AccountShellAction />}
      billingAction={<BillingShellAction />}
    >
      <ErrorSurface />
      <DomainErrorBoundary resetKeys={[location.pathname]}>
        <Outlet />
      </DomainErrorBoundary>
    </AppShell>
  );
}

function ProjectLayout() {
  const { projectId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { openLocalProject, snapshot } = useWorkbench();
  const requestGenerationRef = useRef(0);
  const acceptedHistoryIndexRef = useRef<number | null>(
    typeof window.history.state?.idx === "number" ? window.history.state.idx : null,
  );
  const restoringHistoryRef = useRef(false);
  const requestedProjectId = projectId ?? null;
  const [dirty, setDirty] = useState(false);
  const [loadState, setLoadState] = useState<ProjectLoadState>({
    projectId: requestedProjectId,
    status: "loading",
  });
  const currentLoadState = loadState.projectId === requestedProjectId
    ? loadState
    : { projectId: requestedProjectId, status: "loading" as const };
  const activeSnapshot = snapshot?.project.id === projectId ? snapshot : null;

  const confirmNavigation = useCallback(
    () => !dirty || window.confirm(zh.storyboardPage.discardChangesConfirm),
    [dirty],
  );

  useEffect(() => setDirty(false), [projectId]);

  useEffect(() => {
    if (typeof window.history.state?.idx === "number") {
      acceptedHistoryIndexRef.current = window.history.state.idx;
    }
  }, [location.key]);

  useLayoutEffect(() => {
    if (!dirty) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const handlePopState = (event: PopStateEvent) => {
      const nextIndex = typeof event.state?.idx === "number" ? event.state.idx : null;
      if (restoringHistoryRef.current) {
        restoringHistoryRef.current = false;
        acceptedHistoryIndexRef.current = nextIndex;
        return;
      }
      if (window.confirm(zh.storyboardPage.discardChangesConfirm)) {
        acceptedHistoryIndexRef.current = nextIndex;
        return;
      }

      event.stopImmediatePropagation();
      const currentIndex = acceptedHistoryIndexRef.current;
      if (currentIndex !== null && nextIndex !== null && currentIndex !== nextIndex) {
        restoringHistoryRef.current = true;
        window.history.go(currentIndex - nextIndex);
        return;
      }
      navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true });
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("popstate", handlePopState, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("popstate", handlePopState, true);
    };
  }, [dirty, location.hash, location.pathname, location.search, navigate]);

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
    content = <Outlet context={{ onDirtyChange: setDirty } satisfies ProjectLayoutContext} />;
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
          onBeforeNavigate={confirmNavigation}
        />
      ) : null}
      accountAction={<AccountShellAction onBeforeNavigate={confirmNavigation} />}
      billingAction={<BillingShellAction onBeforeNavigate={confirmNavigation} />}
      onBeforeNavigate={confirmNavigation}
    >
      <ErrorSurface />
      <LocalBackupStatusSurface />
      <DomainErrorBoundary resetKeys={[projectId, location.pathname]}>
        {content}
      </DomainErrorBoundary>
    </AppShell>
  );
}

function NewProjectRoute() {
  const navigate = useNavigate();
  const { createProject } = useWorkbench();
  const {
    claimCommandError,
    onSessionExpired,
    walletAvailableUnits,
  } = useWorkbenchCommandRecovery();
  const handleCreate = useCallback(async (...args: Parameters<typeof createProject>) => {
    try {
      return await createProject(...args);
    } catch (error) {
      claimCommandError();
      throw error;
    }
  }, [claimCommandError, createProject]);

  return (
    <NewProjectPage
      onCreate={handleCreate}
      onCreated={(projectId, plannedShotCount) => {
        navigate(projectRoutes.storyboard(projectId), { state: { plannedShotCount } });
      }}
      onSessionExpired={onSessionExpired}
      walletAvailableUnits={walletAvailableUnits}
    />
  );
}

function isLocalMediaRef(value: string): value is LocalMediaRef {
  return value.startsWith("local://media/");
}

function decorateAssets(
  assets: AssetRecord[],
  projectId: string,
  localMediaUrls: Partial<Record<LocalMediaRef, string>>,
): AssetRecord[] {
  const resolveUrl = (path: string) => (
    isLocalMediaRef(path) ? localMediaUrls[path] ?? null : mediaUrl(path, projectId)
  );

  return assets.map((asset) => {
    const referenceImages = Array.from(new Set(
      asset.reference_images
        .map(resolveUrl)
        .filter((url): url is string => Boolean(url)),
    ));
    const referenceImageUrls = new Set(referenceImages);
    const mediaUrls = Array.from(new Set(
      (asset.media_urls ?? [])
        .map(resolveUrl)
        .filter((url): url is string => Boolean(url))
        .filter((url) => !referenceImageUrls.has(url)),
    ));

    return {
      ...asset,
      reference_images: referenceImages,
      media_urls: mediaUrls,
    };
  });
}

function useDecoratedAssets() {
  const { localMediaUrls, snapshot } = useWorkbench();
  return useMemo(
    () => snapshot
      ? decorateAssets(snapshot.series_bible.assets ?? [], snapshot.project.id, localMediaUrls)
      : [],
    [localMediaUrls, snapshot],
  );
}

function StoryboardRoute() {
  const location = useLocation();
  const { onDirtyChange } = useOutletContext<ProjectLayoutContext>();
  const assets = useDecoratedAssets();
  const {
    busy,
    optimizeShotPrompt,
    regenerateSelectedShot,
    resolveShotMedia,
    saveShotChanges,
    selectShot,
    selectedShotId,
    snapshot,
  } = useWorkbench();
  const {
    claimCommandError,
    onSessionExpired,
    walletAvailableUnits,
  } = useWorkbenchCommandRecovery();
  const plannedShotCount = typeof location.state?.plannedShotCount === "number"
    ? location.state.plannedShotCount
    : null;
  if (!snapshot) return null;

  const handleOptimizePrompt = (shot: Shot, sourceText: string) =>
    optimizeShotPrompt(shot, sourceText).catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handleSaveShot = (shotId: string, payload: ShotSaveRequest) =>
    saveShotChanges(shotId, payload).catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handleRegenerateShot = (shot: Shot) =>
    regenerateSelectedShot(shot).catch((error: unknown) => {
      claimCommandError();
      throw error;
    });

  return (
    <StoryboardPage
      assets={assets}
      characters={snapshot.series_bible.characters ?? []}
      optimizingShotId={busy.optimizingShotId}
      regeneratingShotId={busy.regeneratingShotId}
      savingShotId={busy.savingShotId}
      selectedShotId={selectedShotId}
      shots={snapshot.storyboard.shots}
      plannedShotCount={plannedShotCount}
      resolveShotMedia={resolveShotMedia}
      onSelectShot={selectShot}
      onDirtyChange={onDirtyChange}
      onOptimizePrompt={handleOptimizePrompt}
      onSaveShot={handleSaveShot}
      onRegenerateShot={handleRegenerateShot}
      onSessionExpired={onSessionExpired}
      walletAvailableUnits={walletAvailableUnits}
    />
  );
}

function GlobalSettingsRoute() {
  const { onDirtyChange } = useOutletContext<ProjectLayoutContext>();
  const { busy, saveContinuity, snapshot } = useWorkbench();
  if (!snapshot) return null;
  const projectType = snapshot.project.project_type
    ?? snapshot.continuity_plan?.project_type
    ?? "single_video";

  return (
    <GlobalSettingsPage
      plan={snapshot.continuity_plan ?? emptyContinuityPlan(projectType)}
      saving={busy.savingContinuity}
      onDirtyChange={onDirtyChange}
      onSave={saveContinuity}
    />
  );
}

function ResourceLibraryRoute() {
  const assets = useDecoratedAssets();
  const {
    busy,
    saveShotChanges,
    selectedShotId,
    snapshot,
    uploadReference,
  } = useWorkbench();
  if (!snapshot) return null;

  async function bindAsset(shotId: string, assetId: string, bind: boolean) {
    const shot = snapshot?.storyboard.shots.find((item) => item.id === shotId);
    if (!shot) return;
    const nextAssetIds = bind
      ? Array.from(new Set([...shot.asset_ids, assetId]))
      : shot.asset_ids.filter((id) => id !== assetId);
    await saveShotChanges(shotId, { asset_ids: nextAssetIds });
  }

  return (
    <ResourceLibraryPage
      assets={assets}
      consistencyReport={snapshot.consistency_report}
      currentShotId={selectedShotId}
      shots={snapshot.storyboard.shots}
      uploading={busy.uploadingReference}
      onBindAsset={bindAsset}
      onUploadReferenceImage={uploadReference}
    />
  );
}

function ProductionRoute() {
  const {
    busy,
    downloadFinal,
    events,
    finalRenderUrl,
    renderFinal,
    snapshot,
  } = useWorkbench();
  const {
    claimCommandError,
    onSessionExpired,
    walletAvailableUnits,
  } = useWorkbenchCommandRecovery();
  if (!snapshot) return null;

  const handleRender = () =>
    renderFinal().catch((error: unknown) => {
      claimCommandError();
      throw error;
    });

  return (
    <ProductionPage
      consistencyReport={snapshot.consistency_report}
      downloading={busy.downloading}
      events={events}
      finalPath={snapshot.final_path ?? null}
      finalRenderUrl={finalRenderUrl}
      rendering={busy.rendering}
      shotCount={snapshot.storyboard.shots.length}
      workflowArtifacts={snapshot.workflow_artifacts ?? []}
      onDownload={downloadFinal}
      onRender={handleRender}
      onSessionExpired={onSessionExpired}
      walletAvailableUnits={walletAvailableUnits}
    />
  );
}

export function workbenchRoutes() {
  return (
    <Route element={<RequireAuth />}>
      <Route element={<WorkbenchSessionLayout />}>
        <Route path="/projects" element={<RootLayout />}>
          <Route index element={<ProjectsPage />} />
          <Route path="new" element={<NewProjectRoute />} />
        </Route>
        <Route path="/projects/:projectId" element={<ProjectLayout />}>
          <Route index element={<Navigate replace to="storyboard" />} />
          <Route path="storyboard" element={<StoryboardRoute />} />
          <Route path="settings" element={<GlobalSettingsRoute />} />
          <Route path="resources" element={<ResourceLibraryRoute />} />
          <Route path="production" element={<ProductionRoute />} />
        </Route>
      </Route>
    </Route>
  );
}
