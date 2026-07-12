import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router-dom";
import { mediaUrl } from "../api/client";
import { RequireAdmin } from "../auth/RequireAdmin";
import { RequireAuth } from "../auth/RequireAuth";
import { useAuth } from "../auth/AuthProvider";
import { useBilling } from "../billing/BillingProvider";
import { AppShell } from "../components/shell/AppShell";
import type { AssetRecord } from "../domain/types";
import { getStrings } from "../i18n";
import type { LocalMediaRef } from "../localdb/types";
import { ForgotPasswordPage } from "../pages/ForgotPasswordPage";
import { GlobalSettingsPage } from "../pages/GlobalSettingsPage";
import { LoginPage } from "../pages/LoginPage";
import { NewProjectPage } from "../pages/NewProjectPage";
import { OrdersPage } from "../pages/OrdersPage";
import { ProductionPage } from "../pages/ProductionPage";
import { ProjectsPage } from "../pages/ProjectsPage";
import { RegisterPage } from "../pages/RegisterPage";
import { ResetPasswordPage } from "../pages/ResetPasswordPage";
import { ResourceLibraryPage } from "../pages/ResourceLibraryPage";
import { StoryboardPage } from "../pages/StoryboardPage";
import { WalletPage } from "../pages/WalletPage";
import { BillingAdminPage } from "../pages/admin/BillingAdminPage";
import { projectRoutes } from "./routes";
import { WorkbenchProvider } from "./workbench/WorkbenchProvider";
import { emptyContinuityPlan } from "./workbench/snapshot";
import { useWorkbench } from "./workbench/useWorkbench";

const zh = getStrings("zh");

type ProjectLayoutContext = {
  onDirtyChange: (dirty: boolean) => void;
};

type ProjectLoadState = {
  error?: string;
  projectId: string | null;
  status: "error" | "loading" | "missing" | "ready";
};

function ErrorSurface() {
  const { clearError, error } = useWorkbench();
  if (!error) return null;

  return (
    <div className="workbench-error" role="alert">
      <span>{error}</span>
      <button type="button" aria-label="关闭错误提示" onClick={clearError}>关闭</button>
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

function useShellProps() {
  const auth = useAuth();
  const billing = useBilling();
  return {
    accountEmail: auth.user?.email ?? null,
    isAdmin: auth.user?.role === "admin",
    walletAvailableUnits: billing.wallet?.available_units ?? null,
    walletLoading: billing.loading,
    onLogout: auth.logout,
  };
}

function WorkbenchProviderLayout() {
  return (
    <WorkbenchProvider>
      <Outlet />
    </WorkbenchProvider>
  );
}

function BillingShellLayout() {
  const shellProps = useShellProps();
  return (
    <AppShell project={null} {...shellProps}>
      <Outlet />
    </AppShell>
  );
}

function RootLayout() {
  const shellProps = useShellProps();

  return (
    <AppShell project={null} {...shellProps}>
      <ErrorSurface />
      <Outlet />
    </AppShell>
  );
}

function ProjectLayout() {
  const { projectId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { openLocalProject, snapshot } = useWorkbench();
  const shellProps = useShellProps();
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
              : "无法读取当前浏览器中的项目。",
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
        <h1 id="missing-project-title">此项目不在当前浏览器中</h1>
        <Link to={projectRoutes.list}>返回项目列表</Link>
      </section>
    );
  } else if (currentLoadState.status === "error") {
    content = <p role="alert">{currentLoadState.error}</p>;
  } else if (!activeSnapshot || currentLoadState.status === "loading") {
    content = <p role="status">正在加载当前浏览器中的项目...</p>;
  } else {
    content = <Outlet context={{ onDirtyChange: setDirty } satisfies ProjectLayoutContext} />;
  }

  return (
    <AppShell
      project={activeSnapshot?.project ?? null}
      {...shellProps}
      onBeforeNavigate={confirmNavigation}
    >
      <ErrorSurface />
      <LocalBackupStatusSurface />
      {content}
    </AppShell>
  );
}

function NewProjectRoute() {
  const navigate = useNavigate();
  const { createProject } = useWorkbench();

  return (
    <NewProjectPage
      onCreate={createProject}
      onCreated={(projectId, plannedShotCount) => {
        navigate(projectRoutes.storyboard(projectId), { state: { plannedShotCount } });
      }}
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
  const plannedShotCount = typeof location.state?.plannedShotCount === "number"
    ? location.state.plannedShotCount
    : null;
  if (!snapshot) return null;

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
      onOptimizePrompt={optimizeShotPrompt}
      onSaveShot={saveShotChanges}
      onRegenerateShot={regenerateSelectedShot}
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
  if (!snapshot) return null;

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
      onRender={renderFinal}
    />
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate replace to="/projects" />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<BillingShellLayout />}>
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/orders" element={<OrdersPage />} />
        </Route>
        <Route element={<WorkbenchProviderLayout />}>
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
      <Route element={<RequireAdmin />}>
        <Route element={<BillingShellLayout />}>
          <Route path="/admin/billing" element={<BillingAdminPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate replace to="/projects" />} />
    </Routes>
  );
}
