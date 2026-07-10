import { useEffect, useMemo, useRef, useState } from "react";
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
import { AppShell } from "../components/shell/AppShell";
import { ProviderDrawer } from "../components/shell/ProviderDrawer";
import type { AssetRecord } from "../domain/types";
import { getStrings } from "../i18n";
import type { LocalMediaRef } from "../localdb/types";
import { GlobalSettingsPage } from "../pages/GlobalSettingsPage";
import { NewProjectPage } from "../pages/NewProjectPage";
import { ProductionPage } from "../pages/ProductionPage";
import { ProjectsPage } from "../pages/ProjectsPage";
import { ResourceLibraryPage } from "../pages/ResourceLibraryPage";
import { StoryboardPage } from "../pages/StoryboardPage";
import { projectRoutes } from "./routes";
import { emptyContinuityPlan } from "./workbench/snapshot";
import { useWorkbench } from "./workbench/useWorkbench";

const zh = getStrings("zh");

type RootLayoutContext = {
  openProvider: () => void;
};

function ProviderPanel() {
  const {
    busy,
    maskedKeys,
    providerCredentials,
    saveProvider,
    updateProviderField,
  } = useWorkbench();

  return (
    <ProviderDrawer
      credentials={providerCredentials}
      maskedKeys={maskedKeys}
      saving={busy.savingProvider}
      strings={zh.keyGate}
      onFieldChange={updateProviderField}
      onSubmit={() => void saveProvider().catch(() => undefined)}
    />
  );
}

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

function RootLayout() {
  const [providerOpen, setProviderOpen] = useState(false);

  return (
    <AppShell
      project={null}
      providerOpen={providerOpen}
      providerPanel={<ProviderPanel />}
      onProviderOpenChange={setProviderOpen}
    >
      <ErrorSurface />
      <Outlet context={{ openProvider: () => setProviderOpen(true) } satisfies RootLayoutContext} />
    </AppShell>
  );
}

function ProjectLayout() {
  const { projectId } = useParams();
  const { openLocalProject, snapshot } = useWorkbench();
  const requestGenerationRef = useRef(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing">("loading");
  const activeSnapshot = snapshot?.project.id === projectId ? snapshot : null;

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    if (!projectId) {
      setLoadState("missing");
      return;
    }
    if (snapshot?.project.id === projectId) {
      setLoadState("ready");
      return;
    }

    setLoadState("loading");
    void openLocalProject(projectId)
      .then((found) => {
        if (generation === requestGenerationRef.current) {
          setLoadState(found ? "ready" : "missing");
        }
      })
      .catch(() => {
        if (generation === requestGenerationRef.current) {
          setLoadState("missing");
        }
      });
  }, [openLocalProject, projectId, snapshot?.project.id]);

  let content;
  if (loadState === "missing") {
    content = (
      <section aria-labelledby="missing-project-title">
        <h1 id="missing-project-title">此项目不在当前浏览器中</h1>
        <Link to={projectRoutes.list}>返回项目列表</Link>
      </section>
    );
  } else if (!activeSnapshot || loadState === "loading") {
    content = <p role="status">正在加载当前浏览器中的项目...</p>;
  } else {
    content = <Outlet />;
  }

  return (
    <AppShell project={activeSnapshot?.project ?? null} providerPanel={<ProviderPanel />}>
      <ErrorSurface />
      {content}
    </AppShell>
  );
}

function NewProjectRoute() {
  const navigate = useNavigate();
  const { openProvider } = useOutletContext<RootLayoutContext>();
  const { createProject, providerReady } = useWorkbench();

  return (
    <NewProjectPage
      providerReady={providerReady}
      onOpenProvider={openProvider}
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
  return assets.map((asset) => ({
    ...asset,
    media_urls: Array.from(new Set(
      [...(asset.media_urls ?? []), ...(asset.reference_images ?? [])]
        .map((path) => isLocalMediaRef(path) ? localMediaUrls[path] ?? null : mediaUrl(path, projectId))
        .filter((url): url is string => Boolean(url)),
    )),
  }));
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
      onOptimizePrompt={optimizeShotPrompt}
      onSaveShot={saveShotChanges}
      onRegenerateShot={regenerateSelectedShot}
    />
  );
}

function GlobalSettingsRoute() {
  const { busy, saveContinuity, snapshot } = useWorkbench();
  if (!snapshot) return null;
  const projectType = snapshot.project.project_type
    ?? snapshot.continuity_plan?.project_type
    ?? "single_video";

  return (
    <GlobalSettingsPage
      plan={snapshot.continuity_plan ?? emptyContinuityPlan(projectType)}
      saving={busy.savingContinuity}
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
      <Route path="*" element={<Navigate replace to="/projects" />} />
    </Routes>
  );
}
