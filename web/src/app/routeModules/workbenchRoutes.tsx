import { useCallback, useEffect, useMemo } from "react";
import {
  Navigate,
  Outlet,
  Route,
  useLocation,
  useNavigate,
  useOutletContext,
} from "react-router-dom";
import { RequireAuth } from "../../auth/RequireAuth";
import { DomainErrorBoundary } from "../../components/feedback/DomainErrorBoundary";
import { AppShell } from "../../components/shell/AppShell";
import type {
  AssetRecord,
  CreativeWorkflow,
  Shot,
  ShotSaveRequest,
} from "../../domain/types";
import { AccountShellAction } from "../../features/account/AccountShellAction";
import { BillingShellAction } from "../../features/billing/BillingShellAction";
import { withPlannedCharacterAssets } from "../../features/resources/model/plannedAssets";
import { generationUnitMediaForShot } from "../../features/storyboard/model/generationUnitMedia";
import { getStrings } from "../../i18n";
import type { LocalMediaRef } from "../../localdb/types";
import { mediaUrl } from "../../api/client";
import { GlobalSettingsPage } from "../../pages/GlobalSettingsPage";
import { creativeBriefToPrompt, InspirationPage } from "../../pages/InspirationPage";
import { PlanReviewPage } from "../../pages/PlanReviewPage";
import { ProductionPage } from "../../pages/ProductionPage";
import { ProjectsPage } from "../../pages/ProjectsPage";
import { ResourceLibraryPage } from "../../pages/ResourceLibraryPage";
import { StoryboardPage } from "../../pages/StoryboardPage";
import { projectRoutes } from "../routes";
import { emptyContinuityPlan } from "../workbench/snapshot";
import { useWorkbench } from "../workbench/useWorkbench";
import { WorkbenchSessionLayout } from "./WorkbenchSessionLayout";
import { ApprovedProjectGate, ProjectIndexRoute } from "./workflowGates";
import {
  creativeWorkflowFor,
  workflowAllowsProduction,
  workflowHasActiveStoryboardRevision,
} from "./workflowModel";
import { ProjectLayout, type ProjectLayoutContext } from "./ProjectLayout";
import { useWorkbenchCommandRecovery } from "./workbenchRouteRecovery";
import { WorkbenchErrorSurface } from "./WorkbenchRouteSurfaces";

const zh = getStrings("zh");

function storedInspirationTextModel(
  projectId: string,
  workflowModel?: string | null,
): string | undefined {
  const persisted = workflowModel?.trim();
  if (persisted) return persisted;
  if (typeof window === "undefined") return undefined;
  try {
    const sessionModel = window.sessionStorage
      .getItem(`openmontage.inspirationTextModel:${projectId}`)
      ?.trim();
    return sessionModel || undefined;
  } catch {
    return undefined;
  }
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
      <WorkbenchErrorSurface />
      <DomainErrorBoundary resetKeys={[location.pathname]}>
        <Outlet />
      </DomainErrorBoundary>
    </AppShell>
  );
}

function ProjectsRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const { createDraft } = useWorkbench();
  const {
    claimCommandError,
    onSessionExpired,
    walletAvailableUnits,
  } = useWorkbenchCommandRecovery();
  const handleCreateDraft = useCallback(async (...args: Parameters<typeof createDraft>) => {
    try {
      return await createDraft(...args);
    } catch (error) {
      claimCommandError();
      throw error;
    }
  }, [claimCommandError, createDraft]);

  return (
    <ProjectsPage
      autoFocusComposer={Boolean(location.state?.focusComposer)}
      onCreateDraft={handleCreateDraft}
      onStarted={(projectId, initialMessage, textModel) => {
        navigate(projectRoutes.idea(projectId), { state: { initialMessage, textModel } });
      }}
      onSessionExpired={onSessionExpired}
      walletAvailableUnits={walletAvailableUnits}
    />
  );
}

function NewProjectRoute() {
  return <Navigate replace to={projectRoutes.list} state={{ focusComposer: true }} />;
}

function InspirationRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    busy,
    developInspiration,
    uploadInspirationAttachment,
    planStoryboard,
    snapshot,
    updateInspirationIntent,
  } = useWorkbench();
  const {
    claimCommandError,
    onSessionExpired,
    walletAvailableUnits,
  } = useWorkbenchCommandRecovery();
  if (!snapshot) return null;
  const workflow = creativeWorkflowFor(snapshot);
  const projectType = snapshot.project.project_type
    ?? snapshot.continuity_plan?.project_type
    ?? "single_video";
  if (workflowAllowsProduction(workflow)) {
    return <Navigate replace to={projectRoutes.storyboard(snapshot.project.id)} />;
  }
  if (workflow.phase !== "inspiration") {
    return <Navigate replace to={projectRoutes.planReview(snapshot.project.id)} />;
  }

  const handleDevelop = (
    messages: Parameters<typeof developInspiration>[0]["messages"],
    textModel: string,
    onDelta?: (text: string) => void,
  ) =>
    developInspiration({ messages, text_model: textModel }, onDelta)
      .then(() => undefined)
      .catch((error: unknown) => {
        claimCommandError();
        throw error;
      });
  const handlePlan = (
    brief: NonNullable<CreativeWorkflow["brief"]>,
    controlEndFrames: boolean,
    textModel: string,
  ) =>
    planStoryboard(creativeBriefToPrompt(brief, projectType), controlEndFrames, textModel)
      .then((result) => navigate(projectRoutes.planReview(result.project.id)))
      .catch((error: unknown) => {
        claimCommandError();
        throw error;
      });
  const initialMessage = typeof location.state?.initialMessage === "string"
    ? location.state.initialMessage
    : "";
  const initialTextModel = typeof location.state?.textModel === "string"
    ? location.state.textModel
    : "gpt-5.5";
  const handleInitialMessageConsumed = () => {
    if (!initialMessage) return;
    const currentState = location.state && typeof location.state === "object"
      ? location.state as Record<string, unknown>
      : {};
    const { initialMessage: _consumed, ...remainingState } = currentState;
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: remainingState,
    });
  };

  return (
    <InspirationPage
      workflow={workflow}
      projectType={projectType}
      initialMessage={initialMessage}
      initialTextModel={initialTextModel}
      sessionKey={snapshot.project.id}
      developing={busy.developingIdea}
      planning={busy.creating}
      onDevelop={handleDevelop}
      onUploadAttachment={uploadInspirationAttachment}
      onInitialMessageConsumed={handleInitialMessageConsumed}
      onPlan={handlePlan}
      onUpdateEndFrameIntent={(enabled) => updateInspirationIntent({
        control_end_frames: enabled,
      }).then(() => undefined)}
      onSessionExpired={onSessionExpired}
      walletAvailableUnits={walletAvailableUnits}
    />
  );
}

function PlanReviewRoute() {
  const navigate = useNavigate();
  const {
    approveStoryboard,
    busy,
    events,
    listTasks,
    reviseCreativePlan,
    retryTaskItem,
    snapshot,
    updatePlanSection,
  } = useWorkbench();
  const {
    claimCommandError,
    onSessionExpired,
    walletAvailableUnits,
  } = useWorkbenchCommandRecovery();
  if (!snapshot) return null;
  const workflow = creativeWorkflowFor(snapshot);
  if (workflowHasActiveStoryboardRevision(workflow)) {
    return <Navigate replace to={projectRoutes.storyboardRevision(snapshot.project.id)} />;
  }
  if (workflowAllowsProduction(workflow)) {
    return <Navigate replace to={projectRoutes.storyboard(snapshot.project.id)} />;
  }
  if (workflow.phase === "inspiration" || !snapshot.storyboard.shots.length) {
    return <Navigate replace to={projectRoutes.idea(snapshot.project.id)} />;
  }

  const handleApprove = () => approveStoryboard()
    .then((result) => navigate(projectRoutes.storyboard(result.project.id), { replace: true }))
    .catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handleConfirmSection = (section: Parameters<typeof updatePlanSection>[0], revision: number) =>
    updatePlanSection(section, { status: "approved", revision })
      .then(() => undefined)
      .catch((error: unknown) => {
        claimCommandError();
        throw error;
      });
  const handleRequestChanges = async (
    section: Parameters<typeof updatePlanSection>[0],
    feedback: string,
    revision: number,
  ) => {
    try {
      await updatePlanSection(section, {
        status: "changes_requested",
        feedback,
        revision,
      });
      await reviseCreativePlan({ sections: [section], feedback });
    } catch (error) {
      claimCommandError();
      throw error;
    }
  };

  return (
    <PlanReviewPage
      snapshot={snapshot}
      approving={busy.approvingPlan}
      revising={busy.revisingPlan}
      updatingSection={busy.updatingPlanSection}
      onApprove={handleApprove}
      onConfirmSection={handleConfirmSection}
      onListTasks={listTasks}
      onRequestChanges={handleRequestChanges}
      onRetryTaskItem={retryTaskItem}
      onSessionExpired={onSessionExpired}
      walletAvailableUnits={walletAvailableUnits}
      taskEvents={events}
    />
  );
}

function StoryboardRevisionRoute() {
  const navigate = useNavigate();
  const {
    approveStoryboard,
    busy,
    cancelStoryboardRevision,
    events,
    listTasks,
    reviseCreativePlan,
    retryTaskItem,
    snapshot,
    updatePlanSection,
  } = useWorkbench();
  const {
    claimCommandError,
    onSessionExpired,
    walletAvailableUnits,
  } = useWorkbenchCommandRecovery();
  if (!snapshot) return null;
  const workflow = creativeWorkflowFor(snapshot);
  if (!workflowHasActiveStoryboardRevision(workflow)) {
    if (workflowAllowsProduction(workflow)) {
      return <Navigate replace to={projectRoutes.storyboard(snapshot.project.id)} />;
    }
    return <Navigate replace to={projectRoutes.planReview(snapshot.project.id)} />;
  }

  const handleApprove = () => approveStoryboard()
    .then((result) => navigate(projectRoutes.storyboard(result.project.id), { replace: true }))
    .catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handleCancel = () => cancelStoryboardRevision()
    .then((result) => navigate(projectRoutes.storyboard(result.project.id), { replace: true }))
    .catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handleConfirmSection = (section: Parameters<typeof updatePlanSection>[0], revision: number) =>
    updatePlanSection(section, { status: "approved", revision })
      .then(() => undefined)
      .catch((error: unknown) => {
        claimCommandError();
        throw error;
      });
  const handleRequestChanges = async (
    section: Parameters<typeof updatePlanSection>[0],
    feedback: string,
    revision: number,
  ) => {
    try {
      await updatePlanSection(section, {
        status: "changes_requested",
        feedback,
        revision,
      });
      await reviseCreativePlan({ sections: [section], feedback });
    } catch (error) {
      claimCommandError();
      throw error;
    }
  };

  return (
    <PlanReviewPage
      snapshot={snapshot}
      approving={busy.approvingPlan}
      revising={busy.revisingPlan}
      updatingSection={busy.updatingPlanSection}
      initialSection="storyboard"
      revisionMode
      onApprove={handleApprove}
      onCancelRevision={handleCancel}
      onConfirmSection={handleConfirmSection}
      onListTasks={listTasks}
      onRequestChanges={handleRequestChanges}
      onRetryTaskItem={retryTaskItem}
      onSessionExpired={onSessionExpired}
      walletAvailableUnits={walletAvailableUnits}
      taskEvents={events}
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
      media_url: asset.media_url ? resolveUrl(asset.media_url) ?? "" : asset.media_url,
    };
  });
}

function useDecoratedAssets() {
  const { localMediaUrls, snapshot } = useWorkbench();
  return useMemo(
    () => snapshot
      ? decorateAssets(
          withPlannedCharacterAssets(
            snapshot.series_bible.assets ?? [],
            snapshot.series_bible.characters,
            snapshot.storyboard.shots,
            snapshot.creative_workflow?.planned_asset_ids,
          ),
          snapshot.project.id,
          localMediaUrls,
        )
      : [],
    [localMediaUrls, snapshot],
  );
}

function StoryboardRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const { onDirtyChange } = useOutletContext<ProjectLayoutContext>();
  const assets = useDecoratedAssets();
  const {
    busy,
    generateImages,
    generateGenerationUnits,
    previewGenerationPlan,
    events,
    listTasks,
    optimizeShotPrompt,
    planStoryboard,
    beginStoryboardRevision,
    productionConnection,
    regenerateSelectedShot,
    resolveShotMedia,
    saveContinuity,
    saveShotChanges,
    selectShot,
    selectedShotId,
    snapshot,
    retryTaskItem,
    uploadReference,
  } = useWorkbench();
  const {
    claimCommandError,
    onSessionExpired,
    walletAvailableUnits,
  } = useWorkbenchCommandRecovery();
  const resolveGenerationUnitMedia = useCallback((shot: Shot) => (
    generationUnitMediaForShot(
      snapshot?.generation_execution,
      shot.id,
      (path) => snapshot ? mediaUrl(path, snapshot.project.id) : null,
      shot.version,
    )
  ), [snapshot]);
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
  const handleRegenerateShot = (shot: Shot, videoModel?: string) =>
    regenerateSelectedShot(shot, videoModel).catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handlePlanStoryboard = (prompt: string) =>
    planStoryboard(prompt)
      .then(() => undefined)
      .catch((error: unknown) => {
        claimCommandError();
        throw error;
      });
  const handleUploadFirstFrame = (payload: Parameters<typeof uploadReference>[0]) =>
    uploadReference(payload).catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handleGenerateKeyframe = (payload: Parameters<typeof generateImages>[0]) =>
    generateImages(payload).catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handleGenerateGenerationUnits = (
    payload: Parameters<typeof generateGenerationUnits>[0],
  ) => generateGenerationUnits(payload).catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handlePreviewGenerationPlan = (
    payload: Parameters<typeof previewGenerationPlan>[0],
  ) => previewGenerationPlan(payload).catch((error: unknown) => {
    claimCommandError();
    throw error;
  });
  const handleReviseStoryboard = () => beginStoryboardRevision()
    .then((result) => {
      navigate(projectRoutes.storyboardRevision(result.project.id));
    })
    .catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handleSelectEpisode = (episodeNumber: number) => {
    const continuityPlan = snapshot.continuity_plan;
    if (!continuityPlan || continuityPlan.active_episode_number === episodeNumber) {
      return Promise.resolve();
    }
    return saveContinuity({
      ...continuityPlan,
      active_episode_number: episodeNumber,
    }).catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  };

  return (
    <StoryboardPage
      projectId={snapshot.project.id}
      assets={assets}
      characters={snapshot.series_bible.characters ?? []}
      episodes={snapshot.continuity_plan?.episodes ?? []}
      activeEpisodeNumber={snapshot.continuity_plan?.active_episode_number ?? null}
      generationPreferences={snapshot.continuity_plan?.generation_preferences}
      generationExecution={snapshot.generation_execution}
      optimizingShotId={busy.optimizingShotId}
      regeneratingShotId={busy.regeneratingShotId}
      savingShotId={busy.savingShotId}
      uploadingFirstFrame={busy.uploadingReference}
      planning={busy.creating}
      selectedShotId={selectedShotId}
      shots={snapshot.storyboard.shots}
      plannedShotCount={plannedShotCount}
      initialPlanPrompt={snapshot.series_bible.project_brief ?? ""}
      textModel={storedInspirationTextModel(
        snapshot.project.id,
        snapshot.creative_workflow?.text_model,
      )}
      projectAspectRatio={snapshot.creative_workflow?.brief?.aspect_ratio ?? null}
      projectDurationSeconds={snapshot.creative_workflow?.brief?.duration_seconds ?? null}
      resolveShotMedia={resolveShotMedia}
      resolveGenerationUnitMedia={resolveGenerationUnitMedia}
      resolveGenerationUnitPath={(path) => mediaUrl(path, snapshot.project.id)}
      resolveShotFallbackMedia={(shot) => (
        shot.output_path?.startsWith("local://media/")
          ? mediaUrl(shot.output_url, snapshot.project.id)
          : null
      )}
      onSelectShot={selectShot}
      onSelectEpisode={handleSelectEpisode}
      onDirtyChange={onDirtyChange}
      onOptimizePrompt={handleOptimizePrompt}
      onPlanStoryboard={handlePlanStoryboard}
      onSaveShot={handleSaveShot}
      onRegenerateShot={handleRegenerateShot}
      onGenerateKeyframe={handleGenerateKeyframe}
      onGenerateGenerationUnits={handleGenerateGenerationUnits}
      onPreviewGenerationPlan={handlePreviewGenerationPlan}
      onReviseStoryboard={handleReviseStoryboard}
      onListTasks={listTasks}
      onRetryTaskItem={retryTaskItem}
      onUploadFirstFrame={handleUploadFirstFrame}
      onSessionExpired={onSessionExpired}
      taskEvents={events}
      walletAvailableUnits={walletAvailableUnits}
      connectionState={productionConnection}
      productionUrl={projectRoutes.production(snapshot.project.id)}
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
      characters={snapshot.series_bible.characters}
      consistencyReport={snapshot.consistency_report}
      workflow={creativeWorkflowFor(snapshot)}
      onDirtyChange={onDirtyChange}
      onSave={saveContinuity}
    />
  );
}

function ResourceLibraryRoute() {
  const { onDirtyChange } = useOutletContext<ProjectLayoutContext>();
  const assets = useDecoratedAssets();
  const {
    addAssetToProject,
    busy,
    events,
    generateImages,
    listAssets,
    listTasks,
    optimizeImagePrompt,
    productionConnection,
    saveShotChanges,
    retryTaskItem,
    selectedShotId,
    snapshot,
    uploadReference,
    updatePlannedAssetPrompt,
  } = useWorkbench();
  const {
    claimCommandError,
    onSessionExpired,
    walletAvailableUnits,
  } = useWorkbenchCommandRecovery();
  if (!snapshot) return null;

  async function bindAsset(shotId: string, assetId: string, bind: boolean) {
    const shot = snapshot?.storyboard.shots.find((item) => item.id === shotId);
    if (!shot) return;
    const nextAssetIds = bind
      ? Array.from(new Set([...shot.asset_ids, assetId]))
      : shot.asset_ids.filter((id) => id !== assetId);
    await saveShotChanges(shotId, { asset_ids: nextAssetIds });
  }

  const handleGenerateImages = (payload: Parameters<typeof generateImages>[0]) =>
    generateImages(payload).catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handleOptimizeImagePrompt = (
    kind: Parameters<typeof optimizeImagePrompt>[0],
    sourceText: string,
    billingJobId?: string,
  ) => optimizeImagePrompt(kind, sourceText, billingJobId).catch((error: unknown) => {
    claimCommandError();
    throw error;
  });
  const handleAddAsset = (assetId: string) =>
    addAssetToProject(assetId).catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handleUpload = (payload: Parameters<typeof uploadReference>[0]) =>
    uploadReference(payload).then(() => undefined).catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handleUpdatePlannedAssetPrompt = (
    assetId: string,
    payload: Parameters<typeof updatePlannedAssetPrompt>[1],
  ) => updatePlannedAssetPrompt(assetId, payload).catch((error: unknown) => {
    claimCommandError();
    throw error;
  });

  return (
    <ResourceLibraryPage
      assets={assets}
      consistencyReport={snapshot.consistency_report}
      currentShotId={selectedShotId}
      projectId={snapshot.project.id}
      shots={snapshot.storyboard.shots}
      uploading={busy.uploadingReference}
      walletAvailableUnits={walletAvailableUnits}
      generationPreferences={snapshot.continuity_plan?.generation_preferences}
      connectionState={productionConnection}
      onAddAssetToProject={handleAddAsset}
      onBindAsset={bindAsset}
      onGenerateImages={handleGenerateImages}
      onListAssets={listAssets}
      onListTasks={listTasks}
      onRetryTaskItem={retryTaskItem}
      onOptimizeImagePrompt={handleOptimizeImagePrompt}
      onSessionExpired={onSessionExpired}
      onDirtyChange={onDirtyChange}
      onUploadReferenceImage={handleUpload}
      onUpdatePlannedAssetPrompt={handleUpdatePlannedAssetPrompt}
      taskEvents={events}
    />
  );
}

function ProductionRoute() {
  const {
    busy,
    downloadFinal,
    events,
    finalRenderUrl,
    prepareFinalRender,
    productionConnection,
    refreshProduction,
    renderFinal,
    retryTaskItem,
    snapshot,
  } = useWorkbench();
  const {
    claimCommandError,
    onSessionExpired,
    walletAvailableUnits,
  } = useWorkbenchCommandRecovery();
  if (!snapshot) return null;

  const handleRender = (selectedShotIds?: string[]) =>
    renderFinal(selectedShotIds).catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handlePrepareRender = (selectedShotIds?: string[]) =>
    prepareFinalRender(selectedShotIds).catch((error: unknown) => {
      claimCommandError();
      throw error;
    });
  const handleRefresh = () =>
    refreshProduction().catch((error: unknown) => {
      claimCommandError();
      throw error;
    });

  return (
    <ProductionPage
      consistencyReport={snapshot.consistency_report}
      connectionState={productionConnection}
      downloading={busy.downloading}
      events={events}
      finalPath={snapshot.final_path ?? null}
      finalRenderUrl={finalRenderUrl}
      projectId={snapshot.project.id}
      continuityPlan={snapshot.continuity_plan ?? null}
      renderReport={snapshot.render_report ?? null}
      production={snapshot.production ?? null}
      refreshing={busy.refreshingProduction}
      rendering={busy.rendering}
      shots={snapshot.storyboard.shots}
      shotCount={snapshot.production?.shot_summary.total ?? snapshot.storyboard.shots.length}
      workflowArtifacts={snapshot.workflow_artifacts ?? []}
      onDownload={downloadFinal}
      onPrepareRender={handlePrepareRender}
      onRefresh={handleRefresh}
      onRetryTaskItem={retryTaskItem}
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
          <Route index element={<ProjectsRoute />} />
          <Route path="new" element={<NewProjectRoute />} />
        </Route>
        <Route path="/projects/:projectId" element={<ProjectLayout />}>
          <Route index element={<ProjectIndexRoute />} />
          <Route path="idea" element={<InspirationRoute />} />
          <Route path="plan-review" element={<PlanReviewRoute />} />
          <Route path="storyboard/revision" element={<StoryboardRevisionRoute />} />
          <Route element={<ApprovedProjectGate />}>
            <Route path="storyboard" element={<StoryboardRoute />} />
            <Route path="settings" element={<GlobalSettingsRoute />} />
            <Route path="resources" element={<ResourceLibraryRoute />} />
            <Route path="production" element={<ProductionRoute />} />
          </Route>
        </Route>
      </Route>
    </Route>
  );
}
