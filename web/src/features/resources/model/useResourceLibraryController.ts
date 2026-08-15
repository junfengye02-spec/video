import { useEffect, useMemo, useRef, useState } from "react";
import {
  filterAssets,
  mergeMediaAssets,
  type AssetKindFilter,
  type AssetSourceFilter,
  type ResourceLibraryAsset,
  type ResourcePanelState,
} from "../../../components/resources/assetLibrary";
import {
  commandErrorFrom,
  type CommandError,
} from "../../../components/feedback/DomainErrorBoundary";
import type {
  GenerateImagesRequest,
  MediaAsset,
  MediaAssetKind,
  PromptOptimizeResponse,
  TaskBatch,
  TaskItem,
} from "../../../domain/types";
import { getStrings } from "../../../i18n";
import {
  combineAssets,
  imageGenerationParameters,
  listEveryAssetPage,
  sameImageGenerationParameters,
} from "./resourceLibraryCommands";
import type {
  PendingGenerationQuote,
  PendingOptimizationQuote,
  ResourceLibraryControllerProps,
  ResourceView,
} from "./resourceLibraryTypes";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useResourceLibraryController({
  assets,
  consistencyReport,
  currentShotId,
  projectId = "",
  shots,
  uploading,
  walletAvailableUnits = null,
  generationPreferences,
  connectionState = "connected",
  onAddAssetToProject,
  onBindAsset,
  onGenerateImages,
  onListAssets,
  onListTasks,
  onOptimizeImagePrompt,
  onSessionExpired,
  onRetryTaskItem,
  taskEvents = [],
  onDirtyChange,
  onUploadReferenceImage,
  onUpdatePlannedAssetPrompt,
}: ResourceLibraryControllerProps) {
  const strings = getStrings("zh").resources;
  const [view, setView] = useState<ResourceView>("project");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<AssetKindFilter>("all");
  const [sourceType, setSourceType] = useState<AssetSourceFilter>("all");
  const [panel, setPanel] = useState<ResourcePanelState>({ mode: "closed" });
  const [projectMediaAssets, setProjectMediaAssets] = useState<MediaAsset[]>([]);
  const [allMediaAssets, setAllMediaAssets] = useState<MediaAsset[]>([]);
  const [allAssetsLoaded, setAllAssetsLoaded] = useState(false);
  const [loadingScope, setLoadingScope] = useState<ResourceView | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [binding, setBinding] = useState(false);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [uploadPending, setUploadPending] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [generationPending, setGenerationPending] = useState(false);
  const [generationError, setGenerationError] = useState<CommandError | null>(null);
  const [pendingGenerationQuote, setPendingGenerationQuote] = useState<PendingGenerationQuote | null>(null);
  const [optimizationPending, setOptimizationPending] = useState(false);
  const [optimizationError, setOptimizationError] = useState<CommandError | null>(null);
  const [pendingOptimizationQuote, setPendingOptimizationQuote] = useState<PendingOptimizationQuote | null>(null);
  const [addingAssetId, setAddingAssetId] = useState<string | null>(null);
  const [libraryCommandError, setLibraryCommandError] = useState<CommandError | null>(null);
  const [drawerDirty, setDrawerDirty] = useState(false);
  const [selectedResourceIds, setSelectedResourceIds] = useState<Set<string>>(new Set());
  const [resourceTasks, setResourceTasks] = useState<TaskBatch[]>([]);
  const [retryingItemId, setRetryingItemId] = useState<string | null>(null);
  const panelOpenerRef = useRef<HTMLElement | null>(null);
  const requestIdsRef = useRef<Record<ResourceView, number>>({ project: 0, all: 0 });
  const operationPending = binding || uploadPending || uploading
    || optimizationPending || addingAssetId !== null;

  useEffect(() => onDirtyChange?.(drawerDirty), [drawerDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    setGenerationError(null);
    setPendingGenerationQuote(null);
    setOptimizationError(null);
    setPendingOptimizationQuote(null);
  }, [projectId]);

  useEffect(() => {
    setSelectedResourceIds(new Set());
    setResourceTasks([]);
    if (!projectId || !onListTasks) return;
    void onListTasks()
      .then((response) => setResourceTasks(response.tasks.filter((task) => task.task_type === "resource_image.generate")))
      .catch(() => undefined);
  }, [onListTasks, projectId]);

  useEffect(() => {
    requestIdsRef.current.project += 1;
    requestIdsRef.current.all += 1;
    setProjectMediaAssets([]);
    setAllMediaAssets([]);
    setAllAssetsLoaded(false);
    setListError(null);
    if (!onListAssets || !projectId) return;
    const requestId = requestIdsRef.current.project;
    setLoadingScope("project");
    void listEveryAssetPage(onListAssets, "project", projectId)
      .then((loadedAssets) => {
        if (requestIdsRef.current.project === requestId) {
          setProjectMediaAssets((current) => mergeMediaAssets(loadedAssets, current));
        }
      })
      .catch((error: unknown) => {
        if (requestIdsRef.current.project !== requestId) return;
        const recovered = commandErrorFrom(error, {
          fallback: strings.listError,
          onSessionExpired,
          walletAvailableUnits,
        });
        setListError(recovered?.kind === "message" ? recovered.message : strings.listError);
      })
      .finally(() => {
        if (requestIdsRef.current.project === requestId) setLoadingScope(null);
      });
  }, [onListAssets, onSessionExpired, projectId, strings.listError, walletAvailableUnits]);

  useEffect(() => {
    if (view !== "all" || allAssetsLoaded || !onListAssets || !projectId) return;
    const requestId = ++requestIdsRef.current.all;
    setLoadingScope("all");
    setListError(null);
    void listEveryAssetPage(onListAssets, "all", projectId)
      .then((loadedAssets) => {
        if (requestIdsRef.current.all === requestId) {
          setAllMediaAssets((current) => mergeMediaAssets(loadedAssets, current));
          setAllAssetsLoaded(true);
        }
      })
      .catch((error: unknown) => {
        if (requestIdsRef.current.all !== requestId) return;
        const recovered = commandErrorFrom(error, {
          fallback: strings.listError,
          onSessionExpired,
          walletAvailableUnits,
        });
        setListError(recovered?.kind === "message" ? recovered.message : strings.listError);
      })
      .finally(() => {
        if (requestIdsRef.current.all === requestId) setLoadingScope(null);
      });
  }, [allAssetsLoaded, onListAssets, onSessionExpired, projectId, strings.listError, view, walletAvailableUnits]);

  const projectAssets = useMemo(() => combineAssets(assets, projectMediaAssets, projectId), [assets, projectId, projectMediaAssets]);
  const allAssets = useMemo(() => combineAssets(assets, allMediaAssets, projectId), [allMediaAssets, assets, projectId]);
  const projectAssetIds = useMemo(
    () => new Set(projectAssets.map((asset) => asset.id)),
    [projectAssets],
  );
  const visibleAssets = view === "project" ? projectAssets : allAssets;
  const filteredAssets = useMemo(
    () => filterAssets(visibleAssets, { kind, query, sourceType }),
    [kind, query, sourceType, visibleAssets],
  );
  const selectableIds = useMemo(
    () => new Set(filteredAssets.filter((asset) => projectAssetIds.has(asset.id)).map((asset) => asset.id)),
    [filteredAssets, projectAssetIds],
  );
  const latestResourceItems = useMemo(() => {
    const mapped = new Map<string, { batchId: string; item: TaskItem }>();
    for (const task of resourceTasks) {
      for (const item of task.items ?? []) {
        const resourceId = item.target_entity_type === "resource_asset" ? item.target_entity_id : null;
        if (resourceId && !mapped.has(resourceId)) mapped.set(resourceId, { batchId: task.id, item });
      }
    }
    return mapped;
  }, [resourceTasks]);
  const hasActiveResourceTasks = resourceTasks.some((task) => [
    "queued",
    "running",
    "waiting_dependency",
    "awaiting_payment",
  ].includes(task.status));

  useEffect(() => {
    if (!projectId || !onListTasks || (!hasActiveResourceTasks && connectionState !== "disconnected")) {
      return undefined;
    }
    let active = true;
    const poll = () => {
      void onListTasks()
        .then((response) => {
          if (active) setResourceTasks(
            response.tasks.filter((task) => task.task_type === "resource_image.generate"),
          );
        })
        .catch(() => undefined);
    };
    const timer = globalThis.setInterval(poll, 2_000);
    return () => {
      active = false;
      globalThis.clearInterval(timer);
    };
  }, [connectionState, hasActiveResourceTasks, onListTasks, projectId]);

  useEffect(() => {
    setSelectedResourceIds((current) => new Set([...current].filter((id) => selectableIds.has(id))));
  }, [selectableIds]);

  const latestTaskEvent = taskEvents[taskEvents.length - 1];
  useEffect(() => {
    if (!latestTaskEvent || !onListTasks || !projectId
      || !["task", "task_item"].includes(latestTaskEvent.stage)) return;
    void onListTasks().then((response) => {
      setResourceTasks(response.tasks.filter((task) => task.task_type === "resource_image.generate"));
    }).catch(() => undefined);
    if (["complete", "failed", "cancelled"].includes(latestTaskEvent.status)
      && onListAssets) {
      void listEveryAssetPage(onListAssets, "project", projectId)
        .then((loaded) => setProjectMediaAssets((current) => mergeMediaAssets(loaded, current)))
        .catch(() => undefined);
    }
  }, [latestTaskEvent?.id, onListAssets, onListTasks, projectId]);
  const selectedAsset = panel.mode === "detail"
    ? [...projectAssets, ...allAssets].find((asset) => asset.id === panel.assetId) ?? null
    : null;
  const selectedGenerationAsset = panel.mode === "generate" && panel.assetId
    ? projectAssets.find((asset) => asset.id === panel.assetId) ?? null
    : null;

  const clearPanelErrors = () => {
    setBindingError(null);
    setUploadError(null);
    setGenerationError(null);
    setPendingGenerationQuote(null);
    setOptimizationError(null);
    setPendingOptimizationQuote(null);
    setLibraryCommandError(null);
  };

  const canReplacePanel = () => !operationPending
    && (!drawerDirty || window.confirm(strings.discardDrawerChanges));

  const openDetail = (assetId: string, opener: HTMLButtonElement) => {
    if (!canReplacePanel()) return;
    clearPanelErrors();
    setDrawerDirty(false);
    panelOpenerRef.current = opener;
    setPanel({ mode: "detail", assetId });
  };
  const openUpload = (opener: HTMLButtonElement, assetId?: string) => {
    if (!canReplacePanel()) return;
    clearPanelErrors();
    setDrawerDirty(false);
    panelOpenerRef.current = opener;
    const plannedAsset = assetId
      ? projectAssets.find((asset) => asset.id === assetId && asset.planned)
      : undefined;
    setPanel({ mode: "upload", assetId: plannedAsset?.id });
  };
  const openGenerate = (opener: HTMLButtonElement, assetId?: string) => {
    if (!canReplacePanel()) return;
    clearPanelErrors();
    setDrawerDirty(false);
    panelOpenerRef.current = opener;
    const plannedAsset = assetId
      ? projectAssets.find((asset) => asset.id === assetId && asset.planned)
      : filteredAssets.find((asset) => asset.planned)
        ?? projectAssets.find((asset) => asset.planned);
    setPanel({ mode: "generate", assetId: plannedAsset?.id });
  };
  const closePanel = () => {
    if (operationPending) return;
    setDrawerDirty(false);
    setPanel({ mode: "closed" });
    clearPanelErrors();
  };

  const handleBind = async (bind: boolean) => {
    if (operationPending || panel.mode !== "detail" || !currentShotId
      || !shots.some((shot) => shot.id === currentShotId)
      || !projectAssetIds.has(panel.assetId) || selectedAsset?.status !== "ready"
      || selectedAsset.planned) return;
    const assetId = panel.assetId;
    setBinding(true);
    setBindingError(null);
    try { await onBindAsset(currentShotId, assetId, bind); }
    catch (error) { setBindingError(errorMessage(error, strings.bindError)); }
    finally { setBinding(false); }
  };

  const handleUpload = async (payload: Parameters<typeof onUploadReferenceImage>[0]) => {
    if (operationPending) return;
    setUploadPending(true);
    setUploadError(null);
    try {
      await onUploadReferenceImage(payload);
      setPanel((current) => current.mode === "upload" ? { mode: "closed" } : current);
    } catch (error) { setUploadError(errorMessage(error, strings.uploadError)); }
    finally { setUploadPending(false); }
  };

  const handleGenerate = async (payload: GenerateImagesRequest) => {
    if (operationPending || !onGenerateImages) return;
    const parameters = imageGenerationParameters(payload);
    const retryBillingJobId = pendingGenerationQuote
      && sameImageGenerationParameters(parameters, pendingGenerationQuote.parameters)
      ? pendingGenerationQuote.billingJobId : null;
    const resourceIds = selectedGenerationAsset ? [selectedGenerationAsset.id] : [];
    const requestPayload: GenerateImagesRequest = retryBillingJobId
      ? { ...parameters, resource_ids: resourceIds, billing_job_id: retryBillingJobId }
      : { ...parameters, resource_ids: resourceIds };
    setGenerationPending(true);
    setGenerationError(null);
    setOptimizationError(null);
    try {
      if (selectedGenerationAsset && onUpdatePlannedAssetPrompt) {
        await onUpdatePlannedAssetPrompt(selectedGenerationAsset.id, { prompt: payload.prompt });
      }
      const result = await onGenerateImages(requestPayload);
      setPendingGenerationQuote(null);
      setResourceTasks((current) => [result.task, ...current.filter((task) => task.id !== result.task.id)]);
      setPanel((current) => current.mode === "generate" ? { mode: "closed" } : current);
    } catch (error) {
      const recovered = commandErrorFrom(error, { fallback: strings.generateError, onSessionExpired, walletAvailableUnits });
      setGenerationError(recovered);
      setPendingGenerationQuote(recovered?.kind === "payment" && recovered.billingJobId
        ? { billingJobId: recovered.billingJobId, parameters } : null);
    } finally { setGenerationPending(false); }
  };

  const toggleResourceSelection = (assetId: string, selected: boolean) => {
    if (!selectableIds.has(assetId) || [
      "queued",
      "running",
      "waiting_dependency",
      "awaiting_payment",
      "failed",
    ].includes(latestResourceItems.get(assetId)?.item.status ?? "")) return;
    setSelectedResourceIds((current) => {
      const next = new Set(current);
      if (selected) next.add(assetId); else next.delete(assetId);
      return next;
    });
  };

  const toggleAllResources = () => {
    const available = [...selectableIds].filter((id) => ![
      "queued",
      "running",
      "waiting_dependency",
      "awaiting_payment",
      "failed",
    ].includes(latestResourceItems.get(id)?.item.status ?? ""));
    setSelectedResourceIds(selectedResourceIds.size === available.length ? new Set() : new Set(available));
  };

  const handleGenerateSelected = async (imageModel?: string) => {
    if (!onGenerateImages || selectedResourceIds.size === 0) return;
    const first = projectAssets.find((asset) => selectedResourceIds.has(asset.id));
    if (!first) return;
    setGenerationPending(true);
    setGenerationError(null);
    try {
      const result = await onGenerateImages({
        kind: first.kind,
        label: first.label,
        description: first.description ?? "",
        prompt: first.prompt || first.description || first.label,
        model: imageModel?.trim() || generationPreferences?.image_model || "gpt-image-2",
        count: 1,
        size: generationPreferences?.image_size ?? "1024x1024",
        quality: generationPreferences?.image_quality ?? "standard",
        resource_ids: [...selectedResourceIds],
      });
      setResourceTasks((current) => [result.task, ...current.filter((task) => task.id !== result.task.id)]);
      setSelectedResourceIds(new Set());
    } catch (error) {
      setGenerationError(commandErrorFrom(error, { fallback: strings.generateError, onSessionExpired, walletAvailableUnits }));
    } finally {
      setGenerationPending(false);
    }
  };

  const handleRetryResource = async (batchId: string, itemId: string) => {
    if (!onRetryTaskItem || retryingItemId) return;
    setRetryingItemId(itemId);
    try {
      const task = await onRetryTaskItem(batchId, itemId);
      setResourceTasks((current) => [task, ...current.filter((candidate) => candidate.id !== task.id)]);
    } catch (error) {
      setGenerationError(commandErrorFrom(error, { fallback: strings.generateError, onSessionExpired, walletAvailableUnits }));
    } finally {
      setRetryingItemId(null);
    }
  };

  const handleOptimizationInputChange = (nextKind: MediaAssetKind, sourceText: string) => {
    setOptimizationError(null);
    if (pendingOptimizationQuote && (pendingOptimizationQuote.kind !== nextKind
      || pendingOptimizationQuote.sourceText !== sourceText.trim())) setPendingOptimizationQuote(null);
  };

  const handleOptimizePrompt = async (nextKind: MediaAssetKind, sourceText: string): Promise<PromptOptimizeResponse> => {
    if (operationPending || !onOptimizeImagePrompt) throw new Error(strings.optimizePromptError);
    const normalizedSourceText = sourceText.trim();
    const retryBillingJobId = pendingOptimizationQuote?.kind === nextKind
      && pendingOptimizationQuote.sourceText === normalizedSourceText
      ? pendingOptimizationQuote.billingJobId : undefined;
    setOptimizationPending(true);
    setOptimizationError(null);
    setGenerationError(null);
    try {
      const result = await onOptimizeImagePrompt(nextKind, normalizedSourceText, retryBillingJobId);
      setPendingOptimizationQuote(null);
      return result;
    } catch (error) {
      const recovered = commandErrorFrom(error, { fallback: strings.optimizePromptError, onSessionExpired, walletAvailableUnits });
      setOptimizationError(recovered);
      setPendingOptimizationQuote(recovered?.kind === "payment" && recovered.billingJobId
        ? { billingJobId: recovered.billingJobId, kind: nextKind, sourceText: normalizedSourceText } : null);
      throw error;
    } finally { setOptimizationPending(false); }
  };

  const handleAddToProject = async (assetId: string) => {
    if (operationPending || !onAddAssetToProject) return;
    const target = allMediaAssets.find((asset) => asset.id === assetId);
    if (target?.status !== "ready") return;
    setAddingAssetId(assetId);
    setLibraryCommandError(null);
    try {
      const result = await onAddAssetToProject(assetId);
      setProjectMediaAssets((current) => mergeMediaAssets(current, [result.library_asset]));
      setAllMediaAssets((current) => mergeMediaAssets(current, [result.library_asset]));
    } catch (error) {
      setLibraryCommandError(commandErrorFrom(error, { fallback: strings.addError, onSessionExpired, walletAvailableUnits }));
    } finally { setAddingAssetId(null); }
  };

  return {
    strings,
    view, setView,
    query, setQuery,
    kind, setKind,
    sourceType, setSourceType,
    panel, panelOpenerRef,
    projectAssetIds, filteredAssets, selectedAsset, selectedGenerationAsset,
    selectableIds, selectedResourceIds, latestResourceItems, retryingItemId,
    loadingScope, listError, operationPending, addingAssetId,
    binding, bindingError, uploadPending, uploadError,
    generationPending, generationError, optimizationPending, optimizationError,
    libraryCommandError, generationPreferences, shots, consistencyReport, currentShotId,
    onGenerateImages,
    openDetail, openUpload, openGenerate, closePanel,
    handleBind, handleUpload, handleGenerate, handleOptimizePrompt,
    handleOptimizationInputChange, handleAddToProject, setDrawerDirty,
    toggleResourceSelection, toggleAllResources, handleGenerateSelected, handleRetryResource,
  };
}
