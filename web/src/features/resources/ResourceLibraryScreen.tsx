import { Boxes, Search, Sparkles, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { AssetDetailDrawer } from "../../components/resources/AssetDetailDrawer";
import { AssetGenerationDrawer } from "../../components/resources/AssetGenerationDrawer";
import { AssetGrid } from "../../components/resources/AssetGrid";
import { AssetUploadDrawer } from "../../components/resources/AssetUploadDrawer";
import { CommandErrorNotice } from "../../components/feedback/DomainErrorBoundary";
import { GenerationModelPicker } from "../generation/GenerationModelPicker";
import { getStrings } from "../../i18n";
import { SelectMenu } from "../../shared/ui";
import styles from "./ResourceLibrary.module.css";
import { useResourceLibraryController } from "./model/useResourceLibraryController";
import type { ResourceLibraryControllerProps } from "./model/resourceLibraryTypes";

export function ResourceLibraryScreen(props: ResourceLibraryControllerProps) {
  const controller = useResourceLibraryController(props);
  const {
    strings, view, setView, query, setQuery, kind, setKind, sourceType, setSourceType,
    panel, panelOpenerRef, projectAssetIds, filteredAssets, selectedAsset, selectedGenerationAsset,
    selectableIds, selectedResourceIds, latestResourceItems, retryingItemId,
    loadingScope, listError, operationPending, addingAssetId, binding, bindingError, generationPending,
    generationError, optimizationPending, optimizationError, libraryCommandError,
    generationPreferences, shots, consistencyReport, currentShotId, onGenerateImages,
    openDetail, openUpload, openGenerate, closePanel, handleBind, handleUpload,
    handleGenerate, handleOptimizePrompt, handleOptimizationInputChange,
    handleAddToProject, setDrawerDirty,
    toggleResourceSelection, toggleAllResources, handleGenerateSelected, handleRetryResource,
  } = controller;
  const availableSelectableIds = [...selectableIds].filter(
    (id) => !["queued", "running", "waiting_dependency", "awaiting_payment", "failed"].includes(
      latestResourceItems.get(id)?.item.status ?? "",
    ),
  );
  const allAvailableSelected = availableSelectableIds.length > 0
    && availableSelectableIds.every((id) => selectedResourceIds.has(id));
  const defaultImageModel = generationPreferences?.image_model || "gpt-image-2";
  const [batchImageModel, setBatchImageModel] = useState(defaultImageModel);
  useEffect(
    () => setBatchImageModel(defaultImageModel),
    [defaultImageModel, props.projectId],
  );

  return (
    <section className={`${styles.root} storyboard-panel resource-library`} aria-labelledby="resource-library-title">
      <header className="section-heading">
        <div className={styles.titleGroup}>
          <Boxes aria-hidden="true" size={18} />
          <h1 id="resource-library-title">{strings.title}</h1>
        </div>
        <div className="resource-library-actions">
          <button className="primary-button" type="button" disabled={operationPending || !onGenerateImages} onClick={(event) => openGenerate(event.currentTarget)}>
            <Sparkles aria-hidden="true" size={16} />{strings.generateImagesAction}
          </button>
          <button className="secondary-button" type="button" disabled={operationPending} onClick={(event) => openUpload(event.currentTarget)}>
            <Upload aria-hidden="true" size={16} />{strings.uploadResourceAction}
          </button>
        </div>
      </header>

      <div className={styles.toolbar}>
        <div className="resource-view-switch" role="group" aria-label={strings.viewLabel}>
          <button type="button" aria-pressed={view === "project"} disabled={operationPending} onClick={() => setView("project")}>{strings.projectView}</button>
          <button type="button" aria-pressed={view === "all"} disabled={operationPending} onClick={() => setView("all")}>{strings.allView}</button>
        </div>
        <div className="resource-form resource-filters" role="search">
          <SelectMenu disabled={operationPending} label={strings.filterLabel} value={kind} onValueChange={setKind} options={[{ value: "all", label: strings.allKindsLabel }, { value: "character", label: strings.kindLabels.character }, { value: "scene", label: strings.kindLabels.scene }, { value: "prop", label: strings.kindLabels.prop }]} />
          <SelectMenu disabled={operationPending} label={strings.sourceFilterLabel} value={sourceType} onValueChange={setSourceType} options={[{ value: "all", label: strings.allSourcesLabel }, { value: "ai_generated", label: strings.sourceLabels.ai_generated }, { value: "upload", label: strings.sourceLabels.upload }]} />
          <label><span>{strings.searchLabel}</span><span className={styles.searchField}><Search aria-hidden="true" size={16} /><input type="search" value={query} disabled={operationPending} placeholder={strings.searchPlaceholder} onChange={(event) => setQuery(event.target.value)} /></span></label>
        </div>
      </div>

      <div className={styles.batchModel}>
        <GenerationModelPicker
          capability="image"
          disabled={generationPending || !onGenerateImages}
          label={strings.batchModelLabel}
          required
          strings={getStrings("zh").modelCatalog}
          value={batchImageModel}
          onChange={setBatchImageModel}
        />
      </div>

      <div className="resource-selection-toolbar" role="group" aria-label={strings.selectionLabel}>
        <label>
          <input
            type="checkbox"
            checked={allAvailableSelected}
            aria-label={allAvailableSelected ? strings.deselectAllAction : strings.selectAllAction}
            onChange={toggleAllResources}
          />
          <span>{strings.selectedResourceCount(selectedResourceIds.size)}</span>
        </label>
        <button
          className="primary-button"
          type="button"
          disabled={selectedResourceIds.size === 0 || !batchImageModel.trim() || generationPending || !onGenerateImages}
          onClick={() => void handleGenerateSelected(batchImageModel.trim())}
        >
          <Sparkles aria-hidden="true" size={16} />
          {generationPending ? strings.submittingBatchAction : strings.generateSelectedAction}
        </button>
      </div>

      <div className={`resource-layout ${styles.content}`}>
        <div className="resource-results">
          {loadingScope === view ? <p role="status">{strings.loadingAssets}</p> : null}
          {listError ? <p role="alert">{listError}</p> : null}
          <CommandErrorNotice error={libraryCommandError} />
          {panel.mode !== "generate" ? <CommandErrorNotice error={generationError} /> : null}
          <AssetGrid assets={filteredAssets} addingAssetId={addingAssetId} disabled={operationPending} projectAssetIds={projectAssetIds} selectedAssetIds={selectedResourceIds} taskItemsByAssetId={latestResourceItems} retryingItemId={retryingItemId} showAddActions={view === "all"} shots={shots} strings={strings} onAdd={(assetId) => void handleAddToProject(assetId)} onGenerate={(assetId, opener) => openGenerate(opener, assetId)} onRetry={(batchId, itemId) => void handleRetryResource(batchId, itemId)} onToggleSelection={toggleResourceSelection} onSelect={openDetail} />
        </div>
      </div>

      {selectedAsset ? <AssetDetailDrawer asset={selectedAsset} binding={binding} bindingError={bindingError} canBind={projectAssetIds.has(selectedAsset.id) && !selectedAsset.planned} consistencyReport={consistencyReport} currentShotId={currentShotId} panelLocked={operationPending} returnFocusRef={panelOpenerRef} shots={shots} strings={strings} onBind={(bind) => void handleBind(bind)} onUploadReference={() => openUpload(panelOpenerRef.current as HTMLButtonElement, selectedAsset.id)} onClose={closePanel} /> : null}
      {panel.mode === "upload" ? <AssetUploadDrawer key={panel.assetId ?? "manual"} busy={operationPending} error={controller.uploadError} resource={panel.assetId ? selectedAsset ?? props.assets.find((asset) => asset.id === panel.assetId) : undefined} returnFocusRef={panelOpenerRef} strings={strings} onClose={closePanel} onDirtyChange={setDrawerDirty} onSubmit={handleUpload} /> : null}
      {panel.mode === "generate" ? <AssetGenerationDrawer key={selectedGenerationAsset?.id ?? "manual"} busy={generationPending} error={optimizationError ?? generationError} optimizing={optimizationPending} generationPreferences={generationPreferences} initialDescription={selectedGenerationAsset?.description} initialKind={selectedGenerationAsset?.kind} initialLabel={selectedGenerationAsset?.label} initialPrompt={selectedGenerationAsset?.prompt} prefillNotice={selectedGenerationAsset ? strings.plannedPrefillNotice : undefined} returnFocusRef={panelOpenerRef} strings={strings} title={selectedGenerationAsset ? strings.generatePlannedTitle(selectedGenerationAsset.label) : undefined} onClose={closePanel} onDirtyChange={setDrawerDirty} onOptimizationInputChange={handleOptimizationInputChange} onOptimizePrompt={props.onOptimizeImagePrompt ? handleOptimizePrompt : undefined} onSubmit={handleGenerate} /> : null}
    </section>
  );
}
