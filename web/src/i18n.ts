import type {
  CameraMovement,
  MediaAssetSourceType,
  ShotSize,
  ShotStatus,
  TaskItemStatus,
} from "./domain/types";

export type Locale = "en" | "zh";

export interface UIStrings {
  appFlow: {
    defaultTitle: string;
    defaultPrompt: string;
    untitledProjectTitle: string;
  };
  localBackup: {
    saving: string;
    retrying: string;
  };
  modelCatalog: {
    loading: string;
    loadError: string;
    empty: string;
    refresh: string;
    unconfiguredDuration: string;
    fixedDuration: (seconds: number) => string;
    supportedDurations: (seconds: number[]) => string;
    flexibleDuration: (minimum: number | null, maximum: number | null) => string;
    frameCapabilityBoth: string;
    frameCapabilityStart: string;
    frameCapabilityEnd: string;
    frameCapabilityNone: string;
  };
  adminVideoModels: {
    navigationLabel: string;
    eyebrow: string;
    title: string;
    description: string;
    refreshAction: string;
    refreshingAction: string;
    searchLabel: string;
    searchPlaceholder: string;
    loading: string;
    loadError: string;
    retryAction: string;
    catalogUnavailable: string;
    empty: string;
    noMatches: string;
    modelListLabel: string;
    resultCount: (visible: number, total: number) => string;
    configuredStatus: string;
    unconfiguredStatus: string;
    catalogAvailableStatus: string;
    catalogMissingStatus: string;
    durationInputLabel: (modelId: string) => string;
    currentDurationLabel: string;
    durationValue: (seconds: number) => string;
    durationUnconfigured: string;
    versionLabel: string;
    versionValue: (version: number) => string;
    newVersion: string;
    revisionLabel: string;
    revisionUnavailable: string;
    updatedLabel: string;
    neverUpdated: string;
    invalidDuration: string;
    saveAction: string;
    savingAction: string;
    confirmTitle: (modelId: string) => string;
    confirmDescription: (before: string, after: string) => string;
    reasonLabel: string;
    reasonPlaceholder: string;
    auditNotice: string;
    cancelAction: string;
    confirmAction: string;
    success: (modelId: string, version: number) => string;
    conflict: string;
    forbidden: string;
    csrfError: string;
    saveError: string;
    deleteAction: string;
    deletingAction: string;
    deleteTitle: (modelId: string) => string;
    deleteDescription: (modelId: string) => string;
    deleteReasonLabel: string;
    deleteReasonPlaceholder: string;
    confirmDeleteAction: string;
    deleteSuccess: (modelId: string) => string;
    deleteConflict: string;
    deleteCatalogError: string;
    deleteError: string;
  };
  appShell: {
    workbenchTitle: string;
    projectControlsLabel: string;
    workspaceLabel: string;
    productionReviewLabel: string;
    shortDramaMode: string;
    projectLabel: string;
    noProjectYet: string;
    newDraftAction: string;
    exportProjectAction: string;
    importProjectAction: string;
    storageLabel: string;
    browserLocalStorageHint: string;
    storageUsageLabel: (usage: string) => string;
    shotCountLabel: (count: number) => string;
    localDraftLabel: string;
    activeCastLabel: string;
    waitingLabel: string;
    finalRenderLabel: string;
    finalVideoTitle: string;
    downloadFinalVideoAction: string;
    downloadingFinalVideoAction: string;
    renderFinalVideoAction: string;
    renderingVideoAction: string;
  };
  projectsPage: {
    title: string;
    localStorageNote: string;
    createAction: string;
    importAction: string;
    importDirectoryAction: string;
    importingAction: string;
    cancelImportAction: string;
    importProgress: (
      bytesRead: number,
      totalBytes: number,
      entriesRead: number,
      totalEntries: number,
    ) => string;
    workerUnavailableError: string;
    loading: string;
    emptyState: string;
    shotCount: (count: number) => string;
    updatedAt: (value: string) => string;
    finalRenderReady: string;
    openAction: string;
    openProject: (title: string) => string;
    exportAction: string;
    exportingAction: string;
    exportProject: (title: string) => string;
    deleteAction: string;
    deleteProject: (title: string) => string;
    deleteDialogTitle: string;
    deleteDialogBody: (title: string) => string;
    cancelAction: string;
    confirmDeleteAction: string;
    deletingAction: string;
    overwriteDialogTitle: string;
    overwriteDialogBody: (title: string) => string;
    confirmOverwriteAction: string;
    overwritingAction: string;
    loadError: string;
    exportError: string;
    importError: string;
    deleteError: string;
  };
  newProjectPage: {
    title: string;
    backToProjects: string;
    projectTitleLabel: string;
    projectTitlePlaceholder: string;
    projectTypeLabel: string;
    singleVideo: string;
    miniSeries: string;
    longSeries: string;
    promptLabel: string;
    promptPlaceholder: string;
    createAction: string;
    creatingAction: string;
    createError: string;
    createDraftAction: string;
    creatingDraftAction: string;
    createDraftError: string;
  };
  nav: {
    ariaLabel: string;
    storyboard: string;
    series: string;
    episodes: string;
    resources: string;
    production: string;
  };
  projectType: {
    label: string;
    singleVideo: string;
    miniSeries: string;
    longSeries: string;
    lockedHint: string;
  };
  chatPanel: {
    regionLabel: string;
    title: string;
    projectTitleLabel: string;
    promptLabel: string;
    createStoryboardAction: string;
    creatingStoryboardAction: string;
  };
  errors: {
    createProjectFallback: string;
    renderRequiresStoryboard: string;
    renderFallback: string;
    saveShotFallback: string;
    optimizeShotFallback: string;
    createStoryboardRequiresPrompt: string;
    saveContinuityFallback: string;
    uploadReferenceFallback: string;
    readOnlyProjectFallback: string;
    localProjectSaveFallback: string;
    exportProjectFallback: string;
    importProjectFallback: string;
    downloadFinalVideoFallback: string;
    regenerateShotFallback: (shotId: string) => string;
    regenerateShotTimeout: string;
  };
  shotEditor: {
    title: string;
    regionLabel: string;
    emptyState: string;
    shotIdentity: (shotIndex: number, shotId: string) => string;
    beatLabel: string;
    episodeLabel: string;
    episodeUnassignedOption: string;
    episodeOption: (episodeNumber: number, title: string) => string;
    episodeUnavailableOption: (episodeNumber: number) => string;
    narrativeSectionTitle: string;
    shotLanguageSectionTitle: string;
    dirtyStatus: string;
    savedStatus: string;
    videoOutdatedStatus: string;
    videoOutdatedHint: string;
    promptLabel: string;
    locationLabel: string;
    charactersLabel: string;
    propsLabel: string;
    intentLabel: string;
    shotSizeLabel: string;
    cameraMovementLabel: string;
    lensLabel: string;
    lightingLabel: string;
    depthOfFieldLabel: string;
    colorTemperatureLabel: string;
    unspecifiedOption: string;
    shotSizeOptions: Record<ShotSize, string>;
    cameraMovementOptions: Record<CameraMovement, string>;
    lensOptions: Record<"14" | "24" | "35" | "50" | "85" | "135" | "200", string>;
    lightingOptions: Record<
      "high_key" | "low_key" | "natural" | "golden_hour" | "blue_hour" | "tungsten_warm" | "neon" | "silhouette" | "rim_lit" | "volumetric" | "overcast_soft",
      string
    >;
    depthOfFieldOptions: Record<"shallow" | "medium" | "deep", string>;
    colorTemperatureOptions: Record<"cool" | "neutral" | "warm" | "mixed", string>;
    referenceAssetsLabel: string;
    keyframesSectionTitle: string;
    continuityModeLabel: string;
    continuityModes: Record<"carry" | "cut" | "match_cut", string>;
    inheritPreviousTailLabel: string;
    firstFrameLabel: string;
    tailFrameLabel: string;
    uploadFirstFrameAction: string;
    selectFirstFrameLabel: string;
    removeFirstFrameAction: string;
    removeTailFrameAction: string;
    generateFirstFrameAction: string;
    generateTailFrameAction: string;
    generateFirstFrameDialogTitle: string;
    generateTailFrameDialogTitle: string;
    keyframeGenerationFailed: string;
    keyframeAwaitingPayment: string;
    retryKeyframeGenerationAction: string;
    retryFirstFrameUploadAction: string;
    firstFrameUploadFailed: string;
    uploadingFirstFrameStatus: string;
    noExplicitFirstFrameOption: string;
    firstFrameSourceUser: string;
    firstFrameSourceInherited: string;
    firstFrameSourceAi: string;
    tailFrameSourceExtracted: string;
    noFirstFrame: string;
    noTailFrame: string;
    frameStaleStatus: string;
    frameReadyStatus: string;
    noSavedReferenceAssetsYet: string;
    noCharactersYet: string;
    missingBindingLabel: string;
    assetKindLabels: Record<"character" | "scene" | "prop", string>;
    textToVideoMode: string;
    imageToVideoMode: (count: number) => string;
    optimizeAction: string;
    optimizingAction: string;
    optimizeSuccess: string;
    undoOptimizationAction: string;
    saveAction: string;
    savingAction: string;
    saveSuccess: string;
    regenerateAction: string;
    videoModelLabel: string;
    regeneratingAction: string;
    regenerateSuccess: string;
    saveBeforeRegenerateHint: string;
    regenerateKeepsDraftHint: string;
    regenerateConfirmTitle: string;
    confirmRegenerateAction: string;
    cancelAction: string;
    estimatedBalanceImpactLabel: string;
    estimatedBalanceImpact: string;
    availableBalanceLabel: string;
    availableBalance: (units: string) => string;
    balanceUnavailable: string;
    bindingSummaryTitle: string;
    emptyBindingLabel: string;
    regenerateDirtyDraftNotice: string;
    regenerateSavedSourceNotice: string;
  };
  storyboardPage: {
    shotListLabel: string;
    previewLabel: string;
    previewTabLabel: string;
    orderLabel: string;
    inspectorLabel: string;
    viewControlLabel: string;
    tabletPanelsLabel: string;
    openShotListLabel: string;
    openInspectorLabel: string;
    emptyPlannerTitle: string;
    planPromptLabel: string;
    planPromptPlaceholder: string;
    planAction: string;
    planningAction: string;
    planError: string;
    emptyShots: string;
    noSelectedShot: string;
    noPreviewMedia: string;
    previewLoading: string;
    previewError: string;
    previewGenerating: string;
    thumbnailLabel: string;
    estimatedDuration: (durationSeconds: number) => string;
    shotTitle: (shotIndex: number) => string;
    selectShotLabel: (shotIndex: number) => string;
    selectOrderedShotLabel: (shotIndex: number) => string;
    previousShotPageLabel: string;
    nextShotPageLabel: string;
    shotRangeLabel: (start: number, end: number, total: number) => string;
    orderPaginationLabel: string;
    previewMediaLabel: (shotIndex: number) => string;
    plannedShotCount: (count: number) => string;
    discardChangesConfirm: string;
    episodePickerLabel: string;
    episodeOption: (episodeNumber: number, title: string) => string;
    switchEpisodeError: string;
    videoModelLabel: string;
    generationPlanLoading: string;
    generationPlanError: string;
    generationPlanRegionLabel: string;
    generationPlanCounts: (beatCount: number, unitCount: number, nativeSeconds: number | null) => string;
    generationPlanModel: (provider: string, model: string) => string;
    durationComparisonLabel: string;
    recommendedContentDurationLabel: string;
    requestedDurationTotalLabel: string;
    targetDurationLabel: string;
    nativeDurationLabel: string;
    durationDifferenceLabel: string;
    durationValue: (seconds: number | null) => string;
    durationDifferenceValue: (seconds: number | null) => string;
    adaptationActionsLabel: string;
    acceptLongerDurationAction: string;
    reviseStoryboardAction: string;
    chooseCompatibleModelAction: string;
    generationUnitIndex: (index: number) => string;
    recommendedContentDurationValue: (seconds: number | null) => string;
    requestedDurationValue: (seconds: number | null) => string;
    providerModelValue: (provider: string, model: string) => string;
    unitAssetValue: (assetId: string | null, outputPath: string | null) => string;
    sourceBeatId: (beatId: string) => string;
    unitDurationContract: (durationMode: string) => string;
    unitCapabilityUnknown: string;
    unitBoundaryReasons: (reasons: string) => string;
    unitBoundaryCount: (count: number) => string;
    unitStatusProtected: string;
    unitStatusActive: string;
    unitStatusRegenerate: string;
    unitStatusPending: string;
    unitStatusQueued: string;
    unitStatusRunning: string;
    unitStatusWaiting: string;
    unitStatusComplete: string;
    unitStatusFailed: string;
    unitStatusStale: string;
    activeMediaRetained: string;
    regenerateUnitAction: string;
    retryUnitAction: string;
    retryingUnitAction: string;
    generatePendingUnitsAction: (count: number) => string;
    submittingUnitsAction: string;
    generationPlanEmpty: string;
    regenerateMultiUnitTitle: string;
    regenerateSingleUnitTitle: string;
    regenerateMultiUnitBody: (count: number) => string;
    regenerateSingleUnitBody: string;
    regeneratePartialRevisionNotice: string;
    cancelUnitRegenerationAction: string;
    confirmWholeUnitRegenerationAction: string;
    confirmUnitRegenerationAction: string;
    retryShotAction: string;
    retryingShotAction: string;
    compositionReadyTitle: string;
    compositionReadyBody: string;
    continueToCompositionAction: string;
    shotTaskStatusLabels: Record<TaskItemStatus, string>;
    previousShotMissing: string;
    generateUnitsError: string;
    generationUnitsDisabledError: string;
    generationUnitsUpgradeRequiredError: string;
    generationModeConflictError: string;
    generationPlanStaleError: string;
    generationPlanSelectionError: string;
    generationUnitPartialSelectionError: string;
    generationPlanConfirmationError: string;
    generationPlanBlockedError: string;
  };
  storyboardWaterfall: {
    regionLabel: string;
    title: string;
    emptyState: string;
    noLocationFallback: string;
    scoreLabel: (score: number) => string;
    versionLabel: (version: number) => string;
    editShotLabel: (shotIndex: number) => string;
    regenerateShotLabel: (shotIndex: number) => string;
    statusLabels: Record<ShotStatus, string>;
  };
  continuity: {
    ariaLabel: string;
    seriesTitle: string;
    episodesTitle: string;
    storyStateTitle: string;
    worldview: string;
    mainArc: string;
    seriesPrompt: string;
    styleLock: string;
    visualRules: string;
    taboos: string;
    locations: string;
    props: string;
    relationshipMap: string;
    save: string;
    saving: string;
    addEpisode: string;
    currentProductionEpisode: (episodeNumber: number | null) => string;
    setCurrentEpisode: (episodeNumber: number) => string;
    currentEpisodeBadge: string;
    episodeTitle: string;
    goal: string;
    conflict: string;
    twist: string;
    cliffhanger: string;
    inheritedState: string;
    episodePrompt: string;
    episodeOutline: string;
    locked: string;
    characterKnowledge: string;
    relationshipChanges: string;
    activeForeshadowing: string;
    resolvedForeshadowing: string;
    propState: string;
    characterStatus: string;
    currentLocations: string;
  };
  globalSettings: {
    title: string;
    directoryLabel: string;
    worldviewTitle: string;
    charactersTitle: string;
    storyCoreTitle: string;
    visualRulesTitle: string;
    charactersRelationshipsTitle: string;
    storyStateTitle: string;
    soundTitle: string;
    generationPreferencesTitle: string;
    episodePlanningTitle: string;
    notice: string;
    save: string;
    saving: string;
    saved: string;
    unsaved: string;
    saveError: string;
    workflowApproved: string;
    workflowNotApproved: string;
    characterRosterTitle: string;
    noCharacters: string;
    characterReferenceMissing: string;
    characterVisualMissing: string;
    continuityIssuesTitle: string;
    noContinuityIssues: string;
    narrationLabel: string;
    dialogueLabel: string;
    ambienceLabel: string;
    musicDirectionLabel: string;
    soundPromptLabel: string;
    integrateSoundLabel: string;
    imageModelLabel: string;
    videoModelLabel: string;
    imageSizeLabel: string;
    imageQualityLabel: string;
    aspectRatioLabel: string;
    episodeHeading: (episodeNumber: number, title: string) => string;
    episodeFieldLabel: (episodeNumber: number, field: string) => string;
  };
  resources: {
    title: string;
    emptyState: string;
    viewLabel: string;
    projectView: string;
    allView: string;
    filterLabel: string;
    allKindsLabel: string;
    sourceFilterLabel: string;
    allSourcesLabel: string;
    sourceLabel: string;
    sourceLabels: Record<MediaAssetSourceType, string>;
    searchLabel: string;
    searchPlaceholder: string;
    kindLabel: string;
    kindLabels: Record<"character" | "scene" | "prop", string>;
    labelLabel: string;
    descriptionLabel: string;
    promptLabel: string;
    fileLabel: string;
    uploadAction: string;
    uploadingAction: string;
    uploadResourceAction: string;
    generateImagesAction: string;
    selectionLabel: string;
    selectAllAction: string;
    deselectAllAction: string;
    selectResource: (label: string) => string;
    selectedResourceCount: (count: number) => string;
    generateSelectedAction: string;
    submittingBatchAction: string;
    taskStatusLabels: Record<TaskItemStatus, string>;
    retryResourceAction: string;
    retryingResourceAction: string;
    plannedSourceLabel: string;
    plannedStatus: string;
    plannedPreview: string;
    generatePlannedAction: string;
    plannedPrefillNotice: string;
    generatePlannedTitle: (label: string) => string;
    viewAsset: (label: string) => string;
    detailDialogTitle: string;
    uploadDialogTitle: string;
    generateDialogTitle: string;
    closeDetailAction: string;
    closeUploadAction: string;
    closeGenerateAction: string;
    linkedShotCount: (count: number) => string;
    referencesTitle: string;
    referenceImageLabel: (index: number) => string;
    mediaTitle: string;
    mediaItemLabel: (index: number) => string;
    consistencyIssuesTitle: string;
    noPrompt: string;
    bindAction: string;
    unbindAction: string;
    bindingAction: string;
    bindError: string;
    submitUploadAction: string;
    uploadingResourceAction: string;
    uploadError: string;
    batchModelLabel: string;
    modelLabel: string;
    countLabel: string;
    sizeLabel: string;
    qualityLabel: string;
    sizeLabels: Record<"1024x1024" | "1536x1024" | "1024x1536", string>;
    qualityLabels: Record<"standard" | "high", string>;
    optimizePromptAction: string;
    optimizingPromptAction: string;
    undoPromptOptimizationAction: string;
    optimizePromptError: string;
    submitGenerateAction: string;
    generatingImagesAction: string;
    generateError: string;
    loadingAssets: string;
    listError: string;
    addToProjectAction: string;
    addingToProjectAction: string;
    addError: string;
    addBeforeBinding: string;
    createdAtTitle: string;
    createdAtLabel: (value: string) => string;
    unknownCreatedAt: string;
    fileMissing: string;
    fileDeleted: string;
    noPreview: string;
    loadingPreview: string;
    previewFailed: string;
    discardDrawerChanges: string;
  };
  production: {
    pageLabel: string;
    jobProgress: {
      regionLabel: string;
      title: string;
      emptyState: string;
      stageLabels: Record<"idle" | "preparing" | "queued" | "generating" | "composing" | "finalizing" | "quota" | "failed" | "complete", string>;
      stageDescriptions: Record<"preparing" | "queued" | "generating" | "composing" | "finalizing" | "quota" | "failed" | "complete", string>;
      steps: string[];
      connectionLabels: Record<"connecting" | "connected" | "disconnected", string>;
      refreshAction: string;
      refreshingAction: string;
    };
    workflowArtifacts: {
      regionLabel: string;
      title: string;
      emptyState: string;
      existsStatus: string;
      missingStatus: string;
      pathLabel: string;
      shotSummaryLabel: string;
      totalShotsLabel: string;
      reusableShotsLabel: string;
      generateShotsLabel: string;
      completedShotsLabel: string;
    };
    consistency: {
      regionLabel: string;
      title: string;
      noReport: string;
      noIssues: string;
      severityLabels: Record<"info" | "warning" | "error", string>;
      paginationLabel: string;
      paginationStatusLabel: string;
      previousPageLabel: string;
      nextPageLabel: string;
      paginationStatus: (page: number, pageCount: number, issueCount: number) => string;
    };
    shotSelection: {
      regionLabel: string;
      title: string;
      selectedCount: (selected: number, total: number) => string;
      selectAllAction: string;
      emptySelection: string;
      shotLabel: (index: number, beat: string) => string;
      statusLabels: Record<"draft" | "ready" | "generating" | "complete" | "failed" | "stale", string>;
    };
    finalRender: {
      regionLabel: string;
      title: string;
      previewLabel: string;
      noPreview: string;
      loadingPreview: string;
      previewError: string;
      pathLabel: string;
      downloadAction: string;
      downloadingAction: string;
      scopeLabel: string;
      episodeListLabel: string;
      currentEpisode: (episode: number, title: string) => string;
      episodeHeading: (episode: number, title: string) => string;
      episodeCompleted: string;
      episodePending: string;
      usedShots: (shotIds: string[]) => string;
      downloadEpisode: (episode: number) => string;
    };
    confirmation: {
      eyebrow: string;
      remakeEyebrow: string;
      title: string;
      remakeTitle: string;
      remakeNotice: string;
      closeAction: string;
      generateLabel: string;
      reuseLabel: string;
      estimateLabel: string;
      balanceLabel: string;
      outputLabel: string;
      durationComparison: (actual: number, target: number) => string;
      scopeLabel: string;
      episodeScope: (episode: number, title: string) => string;
      continuityLabel: string;
      charactersUnit: string;
      locationsUnit: string;
      propsUnit: string;
      bindingsUnit: string;
      insufficientTitle: string;
      insufficientBody: string;
      walletAction: string;
      cancelAction: string;
      confirmAction: string;
      remakeConfirmAction: string;
      submittingAction: string;
    };
    eyebrow: string;
    title: string;
    description: string;
    evidenceLabel: string;
    statusLabels: Record<"empty" | "ready" | "running" | "failed" | "complete", string>;
    outputPending: string;
    billingBoundary: string;
    readinessTitle: string;
    readinessReady: string;
    readinessBlocked: string;
    retryTaskAction: string;
    retryingTaskAction: string;
    renderAction: string;
    renderEpisodeAction: (episode: number) => string;
    remakeEpisodeAction: (episode: number) => string;
    renderingAction: string;
    preparingAction: string;
    remakeAction: string;
  };
  billing: {
    walletTitle: string;
    walletNote: string;
    ordersTitle: string;
    ordersNote: string;
    balanceLabel: string;
    heldLabel: string;
    availableLabel: string;
    topupTitle: string;
    walletEntriesTitle: string;
    ordersLink: string;
    loading: string;
    noWalletEntries: string;
    emptyOrders: string;
    rechargeButton: string;
    creatingOrder: string;
    createOrderError: string;
    topupAmountLabel: string;
    invalidTopupAmount: string;
    loadError: string;
    paymentReturnTrusted: string;
    amountLabel: string;
    maskedOrderLabel: string;
    createdLabel: string;
    orderStatusLabels: Record<"pending" | "paid" | "expired" | "failed", string>;
  };
}

const STRINGS: Record<Locale, UIStrings> = {
  en: {
    appFlow: {
      defaultTitle: "Rain Alley",
      defaultPrompt:
        "Make a 60-second urban reversal short drama: a woman discovers the truth behind her boss on a rainy night.",
      untitledProjectTitle: "Untitled Short Drama",
    },
    localBackup: {
      saving: "Saving to this browser",
      retrying: "Local backup will retry later",
    },
    modelCatalog: {
      loading: "Loading available models...",
      loadError: "Could not load available models. Keep the current value or retry.",
      empty: "No available models were returned. You can keep using the current value.",
      refresh: "Refresh available models",
      unconfiguredDuration: "The administrator has not configured a generation duration",
      fixedDuration: (seconds) => `Fixed ${seconds}s`,
      supportedDurations: (seconds) => `Supports ${seconds.join(" / ")}s`,
      flexibleDuration: (minimum, maximum) => `Adjustable ${minimum ?? "?"}-${maximum ?? "?"}s`,
      frameCapabilityBoth: "Native first and last frames",
      frameCapabilityStart: "Native first frame",
      frameCapabilityEnd: "Native last frame",
      frameCapabilityNone: "Native first/last frames unavailable",
    },
    adminVideoModels: {
      navigationLabel: "Model management",
      eyebrow: "Administrator",
      title: "Video model durations",
      description: "NewAPI video model catalog and per-call duration settings",
      refreshAction: "Refresh catalog",
      refreshingAction: "Refreshing",
      searchLabel: "Search by model ID",
      searchPlaceholder: "Enter a model ID",
      loading: "Loading video model catalog...",
      loadError: "Unable to load video model settings.",
      retryAction: "Retry",
      catalogUnavailable: "The NewAPI catalog could not be refreshed. Persisted settings remain available below.",
      empty: "No catalog models or persisted settings are available.",
      noMatches: "No model IDs match this search.",
      modelListLabel: "Video model duration settings",
      resultCount: (visible, total) => `${visible} of ${total} models`,
      configuredStatus: "Configured",
      unconfiguredStatus: "Unconfigured",
      catalogAvailableStatus: "In catalog",
      catalogMissingStatus: "Missing from catalog",
      durationInputLabel: (modelId) => `Per-call duration for ${modelId}`,
      currentDurationLabel: "Current duration",
      durationValue: (seconds) => `${seconds}s`,
      durationUnconfigured: "Not configured",
      versionLabel: "Version",
      versionValue: (version) => `v${version}`,
      newVersion: "New setting",
      revisionLabel: "Profile revision",
      revisionUnavailable: "Pending configuration",
      updatedLabel: "Updated",
      neverUpdated: "Never",
      invalidDuration: "Enter a finite number greater than zero.",
      saveAction: "Review change",
      savingAction: "Saving",
      confirmTitle: (modelId) => `Confirm ${modelId}`,
      confirmDescription: (before, after) => `Per-call duration: ${before} -> ${after}`,
      reasonLabel: "Change reason",
      reasonPlaceholder: "Record why this duration was verified or changed",
      auditNotice: "The reason and before/after values will be recorded in the administrator audit log.",
      cancelAction: "Cancel",
      confirmAction: "Save duration",
      success: (modelId, version) => `${modelId} saved as version ${version}.`,
      conflict: "Another administrator updated this model. The latest settings have been loaded; review them before saving again.",
      forbidden: "Administrator access is required for this operation.",
      csrfError: "The session security token is stale. Sign in again before saving.",
      saveError: "Unable to save the model duration.",
      deleteAction: "Delete setting",
      deletingAction: "Deleting",
      deleteTitle: (modelId) => `Delete ${modelId}`,
      deleteDescription: (modelId) => `${modelId} is missing from the NewAPI catalog. Delete its persisted duration setting?`,
      deleteReasonLabel: "Deletion reason",
      deleteReasonPlaceholder: "Record why this missing model setting is being removed",
      confirmDeleteAction: "Delete setting",
      deleteSuccess: (modelId) => `${modelId} was removed.`,
      deleteConflict: "This model changed or returned to the catalog. The latest catalog has been loaded.",
      deleteCatalogError: "The NewAPI catalog could not be verified, so the setting was not deleted.",
      deleteError: "Unable to delete the missing model setting.",
    },
    appShell: {
      workbenchTitle: "mise studio",
      projectControlsLabel: "Project controls",
      workspaceLabel: "Storyboard workspace",
      productionReviewLabel: "Production review",
      shortDramaMode: "Short Drama Mode",
      projectLabel: "Project",
      noProjectYet: "No project yet",
      newDraftAction: "New draft",
      exportProjectAction: "Export project",
      importProjectAction: "Import project",
      storageLabel: "Local storage",
      browserLocalStorageHint: "Projects are saved in this browser. Export backups before clearing browser data.",
      storageUsageLabel: (usage: string) => `Browser storage used: ${usage}`,
      shotCountLabel: (count: number) => `${count} shots`,
      localDraftLabel: "Local draft",
      activeCastLabel: "Active Cast",
      waitingLabel: "Waiting",
      finalRenderLabel: "Final render",
      finalVideoTitle: "Final Video",
      downloadFinalVideoAction: "Download final video",
      downloadingFinalVideoAction: "Preparing download",
      renderFinalVideoAction: "Render final video",
      renderingVideoAction: "Rendering video",
    },
    projectsPage: {
      title: "Projects",
      localStorageNote: "Projects are stored in this browser.",
      createAction: "New project",
      importAction: "Import project",
      importDirectoryAction: "Choose extracted backup",
      importingAction: "Importing...",
      cancelImportAction: "Cancel import",
      importProgress: (bytesRead, totalBytes, entriesRead, totalEntries) =>
        `${bytesRead} / ${totalBytes} bytes, ${entriesRead} / ${totalEntries} entries`,
      workerUnavailableError:
        "This browser cannot read the compressed backup. Choose the extracted backup folder instead.",
      loading: "Loading local projects...",
      emptyState: "No local projects yet.",
      shotCount: (count: number) => `${count} shots`,
      updatedAt: (value: string) => `Updated ${value}`,
      finalRenderReady: "Final render ready",
      openAction: "Open",
      openProject: (title: string) => `Open ${title}`,
      exportAction: "Export",
      exportingAction: "Exporting...",
      exportProject: (title: string) => `Export ${title}`,
      deleteAction: "Delete",
      deleteProject: (title: string) => `Delete ${title}`,
      deleteDialogTitle: "Delete project",
      deleteDialogBody: (title: string) => `Delete “${title}”? This action cannot be undone.`,
      cancelAction: "Cancel",
      confirmDeleteAction: "Confirm delete",
      deletingAction: "Deleting...",
      overwriteDialogTitle: "Overwrite existing project",
      overwriteDialogBody: (title: string) =>
        `A local project named "${title}" already exists. Replace it with this backup?`,
      confirmOverwriteAction: "Confirm overwrite",
      overwritingAction: "Overwriting...",
      loadError: "Unable to load local projects.",
      exportError: "Unable to export project.",
      importError: "Unable to import project.",
      deleteError: "Unable to delete project.",
    },
    newProjectPage: {
      title: "New project",
      backToProjects: "Back to projects",
      projectTitleLabel: "Project title",
      projectTitlePlaceholder: "Untitled project",
      projectTypeLabel: "Project type",
      singleVideo: "Single video",
      miniSeries: "Mini series",
      longSeries: "Long series",
      promptLabel: "Story and visual requirements",
      promptPlaceholder: "Describe the story, characters, mood, and visual direction.",
      createAction: "Plan storyboard with AI",
      creatingAction: "Planning storyboard...",
      createError: "Unable to plan the storyboard.",
      createDraftAction: "Create project and open resources",
      creatingDraftAction: "Creating project...",
      createDraftError: "Unable to create the project.",
    },
    nav: {
      ariaLabel: "Studio sections",
      storyboard: "Storyboard",
      series: "Series Bible",
      episodes: "Episodes",
      resources: "Resources",
      production: "Production",
    },
    projectType: {
      label: "Project type",
      singleVideo: "Single video",
      miniSeries: "Mini series",
      longSeries: "Long series",
      lockedHint: "Project type is locked after creation.",
    },
    chatPanel: {
      regionLabel: "Production assistant",
      title: "Production Assistant",
      projectTitleLabel: "Project Title",
      promptLabel: "Short Drama Prompt",
      createStoryboardAction: "Create storyboard",
      creatingStoryboardAction: "Creating",
    },
    errors: {
      createProjectFallback: "Unable to create project.",
      renderRequiresStoryboard: "Create a storyboard before rendering final video.",
      renderFallback: "Unable to render final video.",
      saveShotFallback: "Unable to save shot.",
      optimizeShotFallback: "Unable to optimize shot prompt.",
      createStoryboardRequiresPrompt: "Enter a story prompt before creating the storyboard.",
      saveContinuityFallback: "Unable to save continuity settings.",
      uploadReferenceFallback: "Unable to upload reference image.",
      readOnlyProjectFallback:
        "This project is an offline read-only copy. Reconnect before making changes.",
      localProjectSaveFallback:
        "This project is open, but the browser could not save the local draft. Export the project before closing this tab.",
      exportProjectFallback: "Project export failed.",
      importProjectFallback: "Project import failed.",
      downloadFinalVideoFallback: "Final video download failed.",
      regenerateShotFallback: (shotId: string) => `Unable to regenerate ${shotId}.`,
      regenerateShotTimeout: "The regeneration request timed out. The service may still be processing it; refresh before retrying.",
    },
    shotEditor: {
      title: "Shot Editor",
      regionLabel: "Shot editor",
      emptyState: "Create a storyboard to edit shot metadata.",
      shotIdentity: (shotIndex, shotId) => `Shot ${shotIndex} · ${shotId}`,
      beatLabel: "Beat",
      episodeLabel: "Episode assignment",
      episodeUnassignedOption: "Unassigned",
      episodeOption: (episodeNumber, title) => (
        title ? `Episode ${episodeNumber} - ${title}` : `Episode ${episodeNumber}`
      ),
      episodeUnavailableOption: (episodeNumber) => `Episode ${episodeNumber} (not in plan)`,
      narrativeSectionTitle: "Narrative and frame",
      shotLanguageSectionTitle: "Camera language",
      dirtyStatus: "Unsaved",
      savedStatus: "Saved",
      videoOutdatedStatus: "Video update required",
      videoOutdatedHint:
        "The changes are saved. The old video remains available for preview, and the affected unit is selected for regeneration in the shot list.",
      promptLabel: "Shot prompt",
      locationLabel: "Location",
      charactersLabel: "Characters",
      propsLabel: "Props",
      intentLabel: "Shot intent",
      shotSizeLabel: "Shot size",
      cameraMovementLabel: "Camera movement",
      lensLabel: "Camera position / lens",
      lightingLabel: "Lighting",
      depthOfFieldLabel: "Depth of field",
      colorTemperatureLabel: "Color temperature",
      unspecifiedOption: "Unspecified",
      shotSizeOptions: {
        extreme_wide: "Extreme wide",
        wide: "Wide",
        medium_wide: "Medium wide",
        medium: "Medium",
        medium_close: "Medium close",
        close_up: "Close up",
        extreme_close_up: "Extreme close up",
        over_shoulder: "Over shoulder",
        insert: "Insert",
        establishing: "Establishing",
      },
      cameraMovementOptions: {
        static: "Static",
        pan_left: "Pan left",
        pan_right: "Pan right",
        tilt_up: "Tilt up",
        tilt_down: "Tilt down",
        dolly_in: "Dolly in",
        dolly_out: "Dolly out",
        tracking_left: "Tracking left",
        tracking_right: "Tracking right",
        crane_up: "Crane up",
        crane_down: "Crane down",
        handheld: "Handheld",
        steadicam: "Steadicam",
        whip_pan: "Whip pan",
        orbital: "Orbital",
        zoom_in: "Zoom in",
        zoom_out: "Zoom out",
        rack_focus: "Rack focus",
      },
      lensOptions: {
        "14": "14 mm",
        "24": "24 mm",
        "35": "35 mm",
        "50": "50 mm",
        "85": "85 mm",
        "135": "135 mm",
        "200": "200 mm",
      },
      lightingOptions: {
        high_key: "High key",
        low_key: "Low key",
        natural: "Natural",
        golden_hour: "Golden hour",
        blue_hour: "Blue hour",
        tungsten_warm: "Tungsten warm",
        neon: "Neon",
        silhouette: "Silhouette",
        rim_lit: "Rim lit",
        volumetric: "Volumetric",
        overcast_soft: "Overcast soft",
      },
      depthOfFieldOptions: {
        shallow: "Shallow",
        medium: "Medium",
        deep: "Deep",
      },
      colorTemperatureOptions: {
        cool: "Cool",
        neutral: "Neutral",
        warm: "Warm",
        mixed: "Mixed",
      },
      referenceAssetsLabel: "Reference assets",
      keyframesSectionTitle: "Continuity frames",
      continuityModeLabel: "Transition intent",
      continuityModes: {
        carry: "Continuous action",
        cut: "Cut",
        match_cut: "Match cut",
      },
      inheritPreviousTailLabel: "Use previous shot tail frame",
      firstFrameLabel: "First frame",
      tailFrameLabel: "Tail frame",
      uploadFirstFrameAction: "Upload first frame",
      selectFirstFrameLabel: "Select existing asset",
      removeFirstFrameAction: "Remove explicit first frame",
      removeTailFrameAction: "Remove tail frame",
      generateFirstFrameAction: "AI first frame (quote required)",
      generateTailFrameAction: "AI target tail frame (quote required)",
      generateFirstFrameDialogTitle: "Generate a continuity first frame",
      generateTailFrameDialogTitle: "Generate an explicit target tail frame",
      keyframeGenerationFailed: "Keyframe generation failed.",
      keyframeAwaitingPayment: "Payment is required before keyframe generation can continue.",
      retryKeyframeGenerationAction: "Retry generation",
      retryFirstFrameUploadAction: "Retry upload",
      firstFrameUploadFailed: "First-frame upload failed.",
      uploadingFirstFrameStatus: "Uploading first frame",
      noExplicitFirstFrameOption: "Use inherited frame or references",
      firstFrameSourceUser: "User image",
      firstFrameSourceInherited: "Inherited from previous video (free)",
      firstFrameSourceAi: "AI generated (quoted separately)",
      tailFrameSourceExtracted: "Extracted from current video (free)",
      noFirstFrame: "No first frame",
      noTailFrame: "Created after video completion",
      frameStaleStatus: "Stale",
      frameReadyStatus: "Current",
      noSavedReferenceAssetsYet: "No saved reference assets yet.",
      noCharactersYet: "No characters are available for binding.",
      missingBindingLabel: "Missing source record",
      assetKindLabels: {
        character: "Character",
        scene: "Scene",
        prop: "Prop",
      },
      textToVideoMode: "Text-to-video: no saved reference image selected",
      imageToVideoMode: (count) => `Image-to-video: ${count} reference image${count === 1 ? "" : "s"} selected`,
      optimizeAction: "AI optimize prompt",
      optimizingAction: "Optimizing prompt",
      optimizeSuccess: "The optimized result is in the unsaved draft.",
      undoOptimizationAction: "Undo optimization",
      saveAction: "Save changes",
      savingAction: "Saving changes",
      saveSuccess: "Changes saved.",
      regenerateAction: "Regenerate video",
      videoModelLabel: "Video model for this regeneration",
      regeneratingAction: "Regenerating video",
      regenerateSuccess: "Video regeneration completed. The draft was preserved.",
      saveBeforeRegenerateHint: "Save changes first",
      regenerateKeepsDraftHint: "Unsaved draft will be retained.",
      regenerateConfirmTitle: "Confirm video regeneration",
      confirmRegenerateAction: "Confirm regeneration",
      cancelAction: "Cancel",
      estimatedBalanceImpactLabel: "Estimated credit impact",
      estimatedBalanceImpact:
        "The server quotes and holds credits for the current video model, then settles on success under the existing billing rules.",
      availableBalanceLabel: "Current balance",
      availableBalance: (units) => `${units} credits available`,
      balanceUnavailable: "Balance is not currently available. The server-side balance gate still applies.",
      bindingSummaryTitle: "Saved generation bindings",
      emptyBindingLabel: "None",
      regenerateDirtyDraftNotice:
        "This generation uses the most recently saved version. Your unsaved draft remains in the inspector and is not saved automatically.",
      regenerateSavedSourceNotice: "This generation uses the most recently saved shot and bindings.",
    },
    storyboardPage: {
      shotListLabel: "Shot list",
      previewLabel: "Shot preview",
      previewTabLabel: "Preview",
      orderLabel: "Shot order",
      inspectorLabel: "Shot inspector",
      viewControlLabel: "Storyboard views",
      tabletPanelsLabel: "Storyboard side panels",
      openShotListLabel: "Open shot list",
      openInspectorLabel: "Open shot inspector",
      emptyPlannerTitle: "Plan storyboard",
      planPromptLabel: "Story and visual direction",
      planPromptPlaceholder: "Describe the story, characters, mood, and visual direction.",
      planAction: "Plan storyboard with AI",
      planningAction: "Planning storyboard...",
      planError: "Unable to plan the storyboard.",
      emptyShots: "No shots generated.",
      noSelectedShot: "Select or create a shot to preview it.",
      noPreviewMedia: "No preview media is available for this shot yet.",
      previewLoading: "Loading preview media...",
      previewError: "Preview media could not be loaded.",
      previewGenerating: "Video generation is in progress",
      thumbnailLabel: "thumbnail preview",
      estimatedDuration: (durationSeconds) => `Est. ${durationSeconds.toFixed(1)}s`,
      shotTitle: (shotIndex: number) => `Shot ${shotIndex}`,
      selectShotLabel: (shotIndex: number) => `Select shot ${shotIndex}`,
      selectOrderedShotLabel: (shotIndex: number) => `Select shot ${shotIndex} in order`,
      previousShotPageLabel: "Previous shots",
      nextShotPageLabel: "Next shots",
      shotRangeLabel: (start, end, total) => `Shots ${start}-${end} of ${total}`,
      orderPaginationLabel: "Shot order pagination",
      previewMediaLabel: (shotIndex: number) => `Shot ${shotIndex} preview media`,
      plannedShotCount: (count: number) => `AI planned ${count} shots for you`,
      discardChangesConfirm: "This shot has unsaved changes. Discard them?",
      episodePickerLabel: "Current episode",
      episodeOption: (episodeNumber, title) => title
        ? `Episode ${episodeNumber} · ${title}`
        : `Episode ${episodeNumber}`,
      switchEpisodeError: "Unable to switch the current episode.",
      videoModelLabel: "Video model for this generation",
      generationPlanLoading: "Checking model duration and frame capabilities...",
      generationPlanError: "Unable to preview this model adaptation.",
      generationPlanRegionLabel: "Video generation units",
      generationPlanCounts: (beatCount, unitCount, nativeSeconds) => (
        `${beatCount} narrative beats / ${unitCount} video generation units / est. ${nativeSeconds ?? "unknown"}s`
      ),
      generationPlanModel: (provider, model) => `${provider} / ${model}`,
      durationComparisonLabel: "Generation plan duration comparison",
      recommendedContentDurationLabel: "Content recommendation",
      requestedDurationTotalLabel: "Model requests",
      targetDurationLabel: "Target",
      nativeDurationLabel: "Native total",
      durationDifferenceLabel: "Difference",
      durationValue: (seconds) => seconds == null ? "Unknown" : `${seconds}s`,
      durationDifferenceValue: (seconds) => seconds == null
        ? "Unknown"
        : `${seconds > 0 ? "+" : ""}${seconds}s`,
      adaptationActionsLabel: "Duration adaptation actions",
      acceptLongerDurationAction: "Accept longer result",
      reviseStoryboardAction: "Reduce or merge storyboard beats",
      chooseCompatibleModelAction: "Choose a compatible model",
      generationUnitIndex: (index) => `U${index}`,
      recommendedContentDurationValue: (seconds) => `Content ${seconds ?? "unknown"}s`,
      requestedDurationValue: (seconds) => `Request ${seconds ?? "unknown"}s`,
      providerModelValue: (provider, model) => `${provider} · ${model}`,
      unitAssetValue: (assetId, outputPath) => `Asset ${assetId ?? "unbound"} · ${outputPath ?? "path pending"}`,
      sourceBeatId: (beatId) => `Beat ${beatId}`,
      unitDurationContract: (durationMode) => `${durationMode} model duration contract`,
      unitCapabilityUnknown: "Model capability contract unavailable",
      unitBoundaryReasons: (reasons) => `Boundary constraints: ${reasons}`,
      unitBoundaryCount: (count) => count
        ? `${count} verified internal merge ${count === 1 ? "boundary" : "boundaries"}`
        : "Single-shot unit · no internal merge boundary",
      unitStatusProtected: "protected",
      unitStatusActive: "active",
      unitStatusRegenerate: "regenerate",
      unitStatusPending: "pending",
      unitStatusQueued: "queued",
      unitStatusRunning: "running",
      unitStatusWaiting: "waiting",
      unitStatusComplete: "complete",
      unitStatusFailed: "failed",
      unitStatusStale: "stale",
      activeMediaRetained: "The current active media remains available until the replacement succeeds.",
      regenerateUnitAction: "Regenerate this unit",
      retryUnitAction: "Retry this unit",
      retryingUnitAction: "Retrying...",
      generatePendingUnitsAction: (count) => `Generate ${count} pending ${count === 1 ? "unit" : "units"}`,
      submittingUnitsAction: "Submitting units...",
      generationPlanEmpty: "Select a video model to preview generation units.",
      regenerateMultiUnitTitle: "Regenerate the complete multi-shot unit",
      regenerateSingleUnitTitle: "Replace this generation unit",
      regenerateMultiUnitBody: (count) => `This asset carries ${count} ordered storyboard beats. Regeneration replaces the complete unit only.`,
      regenerateSingleUnitBody: "The current asset stays active until the replacement succeeds.",
      regeneratePartialRevisionNotice: "To change only one beat, revise the storyboard first and create a new plan.",
      cancelUnitRegenerationAction: "Cancel",
      confirmWholeUnitRegenerationAction: "Regenerate complete unit",
      confirmUnitRegenerationAction: "Confirm replacement",
      retryShotAction: "Retry this shot",
      retryingShotAction: "Retrying...",
      compositionReadyTitle: "All selected shots are ready",
      compositionReadyBody: "Continue to review dependencies and submit the final composition.",
      continueToCompositionAction: "Continue to compose",
      shotTaskStatusLabels: {
        queued: "queued",
        running: "generating",
        awaiting_payment: "payment required",
        waiting_dependency: "waiting for previous shot",
        waiting_provider: "provider generating",
        complete: "complete",
        failed: "failed",
        cancelled: "cancelled",
      },
      previousShotMissing: "The previous shot has not been generated, so this shot cannot be generated yet.",
      generateUnitsError: "Unable to submit the pending generation units.",
      generationUnitsDisabledError: "Generation units v2 is not enabled for this environment. Keep this project read-only or ask an administrator to complete the release gates before enabling it.",
      generationUnitsUpgradeRequiredError: "This plan requires generation units v2. Reload after the project upgrade or ask an administrator to complete the backfill.",
      generationModeConflictError: "This project already uses a different generation submission mode. Complete its upgrade or continue in read-only compatibility mode.",
      generationPlanStaleError: "The storyboard, model profile, or protected units changed. Preview a fresh plan before submitting again.",
      generationPlanSelectionError: "The pending unit selection no longer matches the server plan. Refresh the plan and retry.",
      generationUnitPartialSelectionError: "This scope splits an existing multi-shot unit. Open the complete episode or revise the storyboard first.",
      generationPlanConfirmationError: "Confirm the duration strategy through the server plan before generating.",
      generationPlanBlockedError: "This model cannot generate the current mapping. Choose one of the adaptation actions above.",
    },
    storyboardWaterfall: {
      regionLabel: "Storyboard waterfall",
      title: "Storyboard Waterfall",
      emptyState: "No shots generated.",
      noLocationFallback: "No location",
      scoreLabel: (score: number) => `Score ${score}`,
      versionLabel: (version: number) => `Version ${version}`,
      editShotLabel: (shotIndex: number) => `Edit shot ${shotIndex}`,
      regenerateShotLabel: (shotIndex: number) => `Regenerate shot ${shotIndex}`,
      statusLabels: {
        draft: "draft",
        ready: "ready",
        generating: "generating",
        complete: "complete",
        failed: "failed",
        stale: "needs regeneration",
      },
    },
    continuity: {
      ariaLabel: "Continuity workbench",
      seriesTitle: "Series Bible",
      episodesTitle: "Episode Settings",
      storyStateTitle: "Story State",
      worldview: "Worldview",
      mainArc: "Main arc",
      seriesPrompt: "Series prompt",
      styleLock: "Style lock",
      visualRules: "Visual rules",
      taboos: "Taboos",
      locations: "Locations",
      props: "Props",
      relationshipMap: "Relationship map",
      save: "Save continuity",
      saving: "Saving continuity",
      addEpisode: "Add episode",
      currentProductionEpisode: (episodeNumber) =>
        episodeNumber ? `Current production episode: ${episodeNumber}` : "No current production episode selected",
      setCurrentEpisode: (episodeNumber) => `Set episode ${episodeNumber} as current`,
      currentEpisodeBadge: "Current",
      episodeTitle: "Episode title",
      goal: "Goal",
      conflict: "Conflict",
      twist: "Twist",
      cliffhanger: "Cliffhanger",
      inheritedState: "Inherited state",
      episodePrompt: "Episode prompt",
      episodeOutline: "Episode outline",
      locked: "Locked",
      characterKnowledge: "Character knowledge",
      relationshipChanges: "Relationship changes",
      activeForeshadowing: "Active foreshadowing",
      resolvedForeshadowing: "Resolved foreshadowing",
      propState: "Prop state",
      characterStatus: "Character status",
      currentLocations: "Current locations",
    },
    globalSettings: {
      title: "Global Settings",
      directoryLabel: "Global settings directory",
      worldviewTitle: "World and story continuity",
      charactersTitle: "Character continuity",
      storyCoreTitle: "Story Core",
      visualRulesTitle: "Visual Rules",
      charactersRelationshipsTitle: "Characters and Relationships",
      storyStateTitle: "Story State",
      soundTitle: "Sound",
      generationPreferencesTitle: "Generation Preferences",
      episodePlanningTitle: "Episode Planning",
      notice: "Only affects future optimization and generation; completed storyboards will not be changed.",
      save: "Save global settings",
      saving: "Saving global settings",
      saved: "Global settings saved",
      unsaved: "Unsaved changes",
      saveError: "Unable to save global settings.",
      workflowApproved: "Blueprint finally approved",
      workflowNotApproved: "Blueprint approval is incomplete",
      characterRosterTitle: "Project character roster",
      noCharacters: "No characters are stored in the current project.",
      characterReferenceMissing: "Reference image missing",
      characterVisualMissing: "Visual lock missing",
      continuityIssuesTitle: "Current continuity findings",
      noContinuityIssues: "No continuity conflicts are currently reported.",
      narrationLabel: "Narration rules",
      dialogueLabel: "Dialogue rules",
      ambienceLabel: "Ambience",
      musicDirectionLabel: "Music direction",
      soundPromptLabel: "Sound prompt",
      integrateSoundLabel: "Include sound direction in future storyboard prompts",
      imageModelLabel: "Default image model",
      videoModelLabel: "Default video model",
      imageSizeLabel: "Default image size",
      imageQualityLabel: "Default image quality",
      aspectRatioLabel: "Default aspect ratio",
      episodeHeading: (episodeNumber, title) => `Episode ${episodeNumber}${title ? `: ${title}` : ""}`,
      episodeFieldLabel: (episodeNumber, field) => `Episode ${episodeNumber} ${field}`,
    },
    resources: {
      title: "Resource Library",
      emptyState: "No saved resources yet.",
      viewLabel: "Resource view",
      projectView: "This project",
      allView: "My resources",
      filterLabel: "Resource filter",
      allKindsLabel: "All resources",
      sourceFilterLabel: "Source filter",
      allSourcesLabel: "All sources",
      sourceLabel: "Source",
      sourceLabels: {
        upload: "Upload",
        ai_generated: "AI generated",
        video_frame: "Extracted video frame",
      },
      searchLabel: "Search resources",
      searchPlaceholder: "Search names, descriptions, and prompts",
      kindLabel: "Resource type",
      kindLabels: {
        character: "Character",
        scene: "Scene",
        prop: "Prop",
      },
      labelLabel: "Name",
      descriptionLabel: "Description",
      promptLabel: "Prompt",
      fileLabel: "Reference image",
      uploadAction: "Upload reference",
      uploadingAction: "Uploading reference",
      uploadResourceAction: "Upload resource",
      generateImagesAction: "Generate with AI",
      selectionLabel: "Resource selection",
      selectAllAction: "Select all visible resources",
      deselectAllAction: "Deselect all visible resources",
      selectResource: (label) => `Select ${label}`,
      selectedResourceCount: (count) => `${count} selected`,
      generateSelectedAction: "Generate selected",
      submittingBatchAction: "Submitting",
      taskStatusLabels: {
        queued: "Queued",
        running: "Generating",
        awaiting_payment: "Payment required",
        waiting_dependency: "Waiting",
        waiting_provider: "Waiting for provider",
        complete: "Complete",
        failed: "Failed",
        cancelled: "Cancelled",
      },
      retryResourceAction: "Retry",
      retryingResourceAction: "Retrying",
      plannedSourceLabel: "AI planned",
      plannedStatus: "Ready to generate",
      plannedPreview: "Prompt ready",
      generatePlannedAction: "Generate this resource",
      plannedPrefillNotice: "Name, description, and prompt were filled from the approved AI plan.",
      generatePlannedTitle: (label) => `Generate ${label}`,
      viewAsset: (label) => `View resource ${label}`,
      detailDialogTitle: "Resource details",
      uploadDialogTitle: "Upload resource",
      generateDialogTitle: "Generate resource with AI",
      closeDetailAction: "Close resource details",
      closeUploadAction: "Close resource upload",
      closeGenerateAction: "Close AI generation",
      linkedShotCount: (count) => `Linked to ${count} shots`,
      referencesTitle: "Reference images",
      referenceImageLabel: (index) => `reference image ${index}`,
      mediaTitle: "Media",
      mediaItemLabel: (index) => `media ${index}`,
      consistencyIssuesTitle: "Related consistency issues",
      noPrompt: "No prompt saved.",
      bindAction: "Bind to current shot",
      unbindAction: "Unbind from current shot",
      bindingAction: "Updating resource binding",
      bindError: "Unable to update the resource binding.",
      submitUploadAction: "Submit upload",
      uploadingResourceAction: "Uploading",
      uploadError: "Unable to upload the resource.",
      batchModelLabel: "Model for selected resources",
      modelLabel: "Model",
      countLabel: "Quantity",
      sizeLabel: "Size",
      qualityLabel: "Quality",
      sizeLabels: {
        "1024x1024": "Square (1024 x 1024)",
        "1536x1024": "Landscape (1536 x 1024)",
        "1024x1536": "Portrait (1024 x 1536)",
      },
      qualityLabels: {
        standard: "Standard",
        high: "High",
      },
      optimizePromptAction: "AI optimize prompt",
      optimizingPromptAction: "Optimizing prompt",
      undoPromptOptimizationAction: "Undo optimization",
      optimizePromptError: "Unable to optimize the prompt.",
      submitGenerateAction: "Generate images",
      generatingImagesAction: "Generating images",
      generateError: "Unable to generate the resource.",
      loadingAssets: "Loading resources...",
      listError: "Unable to load the resource library.",
      addToProjectAction: "Add to current project",
      addingToProjectAction: "Adding to project",
      addError: "Unable to add the resource to this project.",
      addBeforeBinding: "Add this resource to the current project before binding it to a shot.",
      createdAtTitle: "Created",
      createdAtLabel: (value) => `Created ${value}`,
      unknownCreatedAt: "Time unavailable",
      fileMissing: "File awaiting recovery",
      fileDeleted: "File deleted",
      noPreview: "No preview",
      loadingPreview: "Loading preview",
      previewFailed: "Preview failed to load",
      discardDrawerChanges: "Discard the unsaved resource form?",
    },
    production: {
      pageLabel: "Production",
      jobProgress: {
        regionLabel: "Production progress",
        title: "Production progress",
        emptyState: "No active jobs.",
        stageLabels: {
          idle: "Ready to produce",
          preparing: "Preparing the production",
          queued: "Waiting to compose",
          generating: "Generating missing shots",
          composing: "Composing the final video",
          finalizing: "Finalizing the file",
          quota: "More balance is required",
          failed: "Production needs attention",
          complete: "Final video ready",
        },
        stageDescriptions: {
          preparing: "Checking shots, resources, and the render plan.",
          queued: "Shots are ready and the final composition is queued.",
          generating: "Only missing shots are generated; completed shots are reused.",
          composing: "Approved shots are being assembled into the output specification.",
          finalizing: "The final file and render report are being verified.",
          quota: "Top up, then return here to continue from the server job.",
          failed: "Review the error and refresh server facts before retrying.",
          complete: "Preview or download the server final file.",
        },
        steps: ["Prepare", "Shots", "Compose", "Verify"],
        connectionLabels: {
          connecting: "Connecting to live updates",
          connected: "Live updates connected",
          disconnected: "Live updates interrupted; server facts are preserved",
        },
        refreshAction: "Refresh status",
        refreshingAction: "Refreshing status",
      },
      workflowArtifacts: {
        regionLabel: "Workflow artifacts",
        title: "Workflow artifacts",
        emptyState: "No workflow artifacts yet.",
        existsStatus: "Available",
        missingStatus: "Missing",
        pathLabel: "Path",
        shotSummaryLabel: "Shot production summary",
        totalShotsLabel: "Total",
        reusableShotsLabel: "Reuse",
        generateShotsLabel: "Generate",
        completedShotsLabel: "Complete",
      },
      consistency: {
        regionLabel: "Consistency check",
        title: "Consistency check",
        noReport: "No report yet.",
        noIssues: "No issues found",
        severityLabels: {
          info: "Info",
          warning: "Warning",
          error: "Error",
        },
        paginationLabel: "Consistency issue pages",
        paginationStatusLabel: "Consistency issue pagination status",
        previousPageLabel: "Previous consistency issues",
        nextPageLabel: "Next consistency issues",
        paginationStatus: (page, pageCount, issueCount) => `Page ${page} of ${pageCount}, ${issueCount} issues`,
      },
      shotSelection: {
        regionLabel: "Shots included in this render",
        title: "Shots in this render",
        selectedCount: (selected, total) => `${selected} of ${total} selected`,
        selectAllAction: "Select all shots",
        emptySelection: "Select at least one shot before rendering.",
        shotLabel: (index, beat) => `Select shot ${index}${beat ? `: ${beat}` : ""}`,
        statusLabels: {
          draft: "Draft",
          ready: "Ready",
          generating: "Generating",
          complete: "Generated",
          failed: "Failed",
          stale: "Needs regeneration",
        },
      },
      finalRender: {
        regionLabel: "Final render",
        title: "Final render",
        previewLabel: "Final render preview",
        noPreview: "No final render preview yet.",
        loadingPreview: "Loading final video",
        previewError: "The final video could not be previewed. Refresh or download the source file.",
        pathLabel: "Path",
        downloadAction: "Download final render",
        downloadingAction: "Preparing download",
        scopeLabel: "Current render scope",
        episodeListLabel: "Episode renders",
        currentEpisode: (episode, title) => `Rendering episode ${episode}${title ? ` · ${title}` : ""}`,
        episodeHeading: (episode, title) => `Episode ${episode}${title ? ` · ${title}` : ""}`,
        episodeCompleted: "Complete",
        episodePending: "Pending",
        usedShots: (shotIds) => `Shots used: ${shotIds.join(", ")}`,
        downloadEpisode: (episode) => `Download episode ${episode}`,
      },
      confirmation: {
        eyebrow: "Production boundary",
        remakeEyebrow: "New paid production",
        title: "Confirm production",
        remakeTitle: "Confirm remake",
        remakeNotice: "The current final video remains available until the new version completes.",
        closeAction: "Close confirmation",
        generateLabel: "Generate shots",
        reuseLabel: "Reuse shots",
        estimateLabel: "Estimated units",
        balanceLabel: "Available units",
        outputLabel: "Output",
        durationComparison: (actual, target) => `Actual ${actual}s · creative target ${target}s`,
        scopeLabel: "Render scope",
        episodeScope: (episode, title) => `Episode ${episode}${title ? ` · ${title}` : ""}`,
        continuityLabel: "Continuity and resources",
        charactersUnit: "characters",
        locationsUnit: "locations",
        propsUnit: "props",
        bindingsUnit: "bindings",
        insufficientTitle: "Insufficient balance",
        insufficientBody: "The server estimate exceeds the current available balance.",
        walletAction: "Open wallet",
        cancelAction: "Cancel",
        confirmAction: "Confirm and produce",
        remakeConfirmAction: "Confirm remake",
        submittingAction: "Starting production",
      },
      eyebrow: "Production",
      title: "Final video",
      description: "Review the final output, current production step, and the facts required to continue.",
      evidenceLabel: "Production evidence",
      statusLabels: {
        empty: "Not started",
        ready: "Ready",
        running: "In production",
        failed: "Needs attention",
        complete: "Complete",
      },
      outputPending: "Output specification pending",
      billingBoundary: "Generation and billing are confirmed by the server before production starts.",
      readinessTitle: "Composition readiness",
      readinessReady: "Every selected shot has usable media and required control frames.",
      readinessBlocked: "Complete or retry these items before composing.",
      retryTaskAction: "Retry item",
      retryingTaskAction: "Retrying...",
      renderAction: "Generate final render",
      renderEpisodeAction: (episode) => `Generate episode ${episode}`,
      remakeEpisodeAction: (episode) => `Remake episode ${episode}`,
      renderingAction: "Generating final render",
      preparingAction: "Checking production",
      remakeAction: "Remake",
    },
    billing: {
      walletTitle: "Wallet",
      walletNote: "Balances are refreshed from the server.",
      ordersTitle: "Top-up orders",
      ordersNote: "Payment history uses server-verified order status.",
      balanceLabel: "Balance",
      heldLabel: "Estimated maximum hold",
      availableLabel: "Available balance",
      topupTitle: "Top up balance",
      walletEntriesTitle: "Wallet entries",
      ordersLink: "Orders",
      loading: "Loading...",
      noWalletEntries: "No wallet entries yet.",
      emptyOrders: "No top-up orders yet.",
      rechargeButton: "Top up with Alipay",
      creatingOrder: "Creating order",
      createOrderError: "Unable to create the payment order.",
      topupAmountLabel: "Top-up amount (CNY)",
      invalidTopupAmount: "Enter an amount from CNY 0.01 to CNY 100,000.00.",
      loadError: "Unable to load billing data.",
      paymentReturnTrusted: "Balance follows the server order status.",
      amountLabel: "Amount",
      maskedOrderLabel: "Order",
      createdLabel: "Created",
      orderStatusLabels: {
        pending: "Pending",
        paid: "Paid",
        expired: "Expired",
        failed: "Failed",
      },
    },
  },
  zh: {
    appFlow: {
      defaultTitle: "\u96e8\u5df7",
      defaultPrompt:
        "\u521b\u4f5c\u4e00\u4e2a 60 \u79d2\u7684\u90fd\u5e02\u53cd\u8f6c\u77ed\u5267\uff1a\u96e8\u591c\u91cc\uff0c\u4e00\u540d\u5973\u4eba\u53d1\u73b0\u4e86\u8001\u677f\u80cc\u540e\u7684\u771f\u76f8\u3002",
      untitledProjectTitle: "\u672a\u547d\u540d\u77ed\u5267",
    },
    localBackup: {
      saving: "\u6b63\u5728\u4fdd\u5b58\u5230\u672c\u673a",
      retrying: "\u672c\u673a\u5907\u4efd\u7a0d\u540e\u91cd\u8bd5",
    },
    modelCatalog: {
      loading: "\u6b63\u5728\u83b7\u53d6\u53ef\u7528\u6a21\u578b...",
      loadError: "\u83b7\u53d6\u53ef\u7528\u6a21\u578b\u5931\u8d25\uff0c\u53ef\u7ee7\u7eed\u4f7f\u7528\u5f53\u524d\u503c\u6216\u91cd\u8bd5\u3002",
      empty: "\u63a5\u53e3\u672a\u8fd4\u56de\u53ef\u7528\u6a21\u578b\uff0c\u53ef\u7ee7\u7eed\u4f7f\u7528\u5f53\u524d\u503c\u3002",
      refresh: "\u5237\u65b0\u53ef\u7528\u6a21\u578b",
      unconfiguredDuration: "\u7ba1\u7406\u5458\u5c1a\u672a\u914d\u7f6e\u751f\u6210\u65f6\u957f",
      fixedDuration: (seconds) => `\u56fa\u5b9a ${seconds} \u79d2`,
      supportedDurations: (seconds) => `\u652f\u6301 ${seconds.join(" / ")} \u79d2`,
      flexibleDuration: (minimum, maximum) => `\u53ef\u8c03 ${minimum ?? "?"}-${maximum ?? "?"} \u79d2`,
      frameCapabilityBoth: "\u652f\u6301\u539f\u751f\u9996\u5c3e\u5e27",
      frameCapabilityStart: "\u652f\u6301\u539f\u751f\u9996\u5e27",
      frameCapabilityEnd: "\u652f\u6301\u539f\u751f\u5c3e\u5e27",
      frameCapabilityNone: "\u539f\u751f\u9996\u5c3e\u5e27\u672a\u652f\u6301",
    },
    adminVideoModels: {
      navigationLabel: "\u6a21\u578b\u7ba1\u7406",
      eyebrow: "\u7ba1\u7406\u5458",
      title: "\u89c6\u9891\u6a21\u578b\u65f6\u957f",
      description: "NewAPI \u89c6\u9891\u6a21\u578b\u76ee\u5f55\u4e0e\u5355\u6b21\u8c03\u7528\u65f6\u957f",
      refreshAction: "\u5237\u65b0\u76ee\u5f55",
      refreshingAction: "\u5237\u65b0\u4e2d",
      searchLabel: "\u6309\u6a21\u578b ID \u641c\u7d22",
      searchPlaceholder: "\u8f93\u5165\u6a21\u578b ID",
      loading: "\u6b63\u5728\u52a0\u8f7d\u89c6\u9891\u6a21\u578b\u76ee\u5f55...",
      loadError: "\u65e0\u6cd5\u52a0\u8f7d\u89c6\u9891\u6a21\u578b\u914d\u7f6e\u3002",
      retryAction: "\u91cd\u8bd5",
      catalogUnavailable: "NewAPI \u76ee\u5f55\u5237\u65b0\u5931\u8d25\uff0c\u4e0b\u65b9\u4ecd\u4fdd\u7559\u5df2\u6301\u4e45\u5316\u7684\u914d\u7f6e\u3002",
      empty: "\u5f53\u524d\u6ca1\u6709\u76ee\u5f55\u6a21\u578b\u6216\u5386\u53f2\u914d\u7f6e\u3002",
      noMatches: "\u6ca1\u6709\u5339\u914d\u7684\u6a21\u578b ID\u3002",
      modelListLabel: "\u89c6\u9891\u6a21\u578b\u65f6\u957f\u914d\u7f6e",
      resultCount: (visible, total) => `\u663e\u793a ${visible} / ${total} \u4e2a\u6a21\u578b`,
      configuredStatus: "\u5df2\u914d\u7f6e",
      unconfiguredStatus: "\u672a\u914d\u7f6e",
      catalogAvailableStatus: "\u76ee\u5f55\u53ef\u7528",
      catalogMissingStatus: "\u76ee\u5f55\u5df2\u7f3a\u5931",
      durationInputLabel: (modelId) => `${modelId} \u7684\u5355\u6b21\u751f\u6210\u65f6\u957f`,
      currentDurationLabel: "\u5f53\u524d\u65f6\u957f",
      durationValue: (seconds) => `${seconds} \u79d2`,
      durationUnconfigured: "\u5c1a\u672a\u914d\u7f6e",
      versionLabel: "\u7248\u672c",
      versionValue: (version) => `v${version}`,
      newVersion: "\u65b0\u914d\u7f6e",
      revisionLabel: "Profile revision",
      revisionUnavailable: "\u5f85\u914d\u7f6e",
      updatedLabel: "\u66f4\u65b0\u65f6\u95f4",
      neverUpdated: "\u5c1a\u672a\u66f4\u65b0",
      invalidDuration: "\u8bf7\u8f93\u5165\u5927\u4e8e 0 \u7684\u6709\u9650\u6570\u503c\u3002",
      saveAction: "\u590d\u6838\u53d8\u66f4",
      savingAction: "\u4fdd\u5b58\u4e2d",
      confirmTitle: (modelId) => `\u786e\u8ba4 ${modelId}`,
      confirmDescription: (before, after) => `\u5355\u6b21\u751f\u6210\u65f6\u957f\uff1a${before} -> ${after}`,
      reasonLabel: "\u53d8\u66f4\u539f\u56e0",
      reasonPlaceholder: "\u8bb0\u5f55\u6b64\u65f6\u957f\u7684\u9a8c\u8bc1\u6216\u53d8\u66f4\u539f\u56e0",
      auditNotice: "\u539f\u56e0\u4e0e\u53d8\u66f4\u524d\u540e\u7684\u6570\u503c\u5c06\u5199\u5165\u7ba1\u7406\u5458\u5ba1\u8ba1\u8bb0\u5f55\u3002",
      cancelAction: "\u53d6\u6d88",
      confirmAction: "\u4fdd\u5b58\u65f6\u957f",
      success: (modelId, version) => `${modelId} \u5df2\u4fdd\u5b58\u4e3a v${version}\u3002`,
      conflict: "\u5176\u4ed6\u7ba1\u7406\u5458\u5df2\u66f4\u65b0\u6b64\u6a21\u578b\u3002\u5df2\u52a0\u8f7d\u6700\u65b0\u914d\u7f6e\uff0c\u8bf7\u590d\u6838\u540e\u91cd\u8bd5\u3002",
      forbidden: "\u6b64\u64cd\u4f5c\u9700\u8981\u7ba1\u7406\u5458\u6743\u9650\u3002",
      csrfError: "\u4f1a\u8bdd\u5b89\u5168\u4ee4\u724c\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55\u540e\u4fdd\u5b58\u3002",
      saveError: "\u65e0\u6cd5\u4fdd\u5b58\u6a21\u578b\u65f6\u957f\u3002",
      deleteAction: "\u5220\u9664\u914d\u7f6e",
      deletingAction: "\u5220\u9664\u4e2d",
      deleteTitle: (modelId) => `\u5220\u9664 ${modelId}`,
      deleteDescription: (modelId) => `${modelId} \u5df2\u4e0d\u5728 NewAPI \u76ee\u5f55\u4e2d\uff0c\u662f\u5426\u5220\u9664\u5b83\u5df2\u6301\u4e45\u5316\u7684\u65f6\u957f\u914d\u7f6e\uff1f`,
      deleteReasonLabel: "\u5220\u9664\u539f\u56e0",
      deleteReasonPlaceholder: "\u8bb0\u5f55\u5220\u9664\u8be5\u7f3a\u5931\u6a21\u578b\u914d\u7f6e\u7684\u539f\u56e0",
      confirmDeleteAction: "\u786e\u8ba4\u5220\u9664",
      deleteSuccess: (modelId) => `${modelId} \u5df2\u5220\u9664\u3002`,
      deleteConflict: "\u8be5\u6a21\u578b\u5df2\u53d8\u66f4\u6216\u91cd\u65b0\u51fa\u73b0\u5728\u76ee\u5f55\u4e2d\uff0c\u5df2\u52a0\u8f7d\u6700\u65b0\u76ee\u5f55\u3002",
      deleteCatalogError: "\u65e0\u6cd5\u6821\u9a8c NewAPI \u76ee\u5f55\uff0c\u672a\u5220\u9664\u8be5\u914d\u7f6e\u3002",
      deleteError: "\u65e0\u6cd5\u5220\u9664\u7f3a\u5931\u7684\u6a21\u578b\u914d\u7f6e\u3002",
    },
    appShell: {
      workbenchTitle: "mise studio",
      projectControlsLabel: "\u9879\u76ee\u63a7\u5236",
      workspaceLabel: "\u5206\u955c\u5de5\u4f5c\u533a",
      productionReviewLabel: "\u5236\u4f5c\u590d\u6838",
      shortDramaMode: "\u77ed\u5267\u6a21\u5f0f",
      projectLabel: "\u9879\u76ee",
      noProjectYet: "\u5c1a\u672a\u521b\u5efa\u9879\u76ee",
      newDraftAction: "\u65b0\u5efa\u8349\u7a3f",
      exportProjectAction: "\u5bfc\u51fa\u9879\u76ee",
      importProjectAction: "\u5bfc\u5165\u9879\u76ee",
      storageLabel: "\u672c\u5730\u5b58\u50a8",
      browserLocalStorageHint:
        "\u9879\u76ee\u4fdd\u5b58\u5728\u6b64\u6d4f\u89c8\u5668\u4e2d\u3002\u6e05\u9664\u6d4f\u89c8\u5668\u6570\u636e\u524d\u8bf7\u5148\u5bfc\u51fa\u5907\u4efd\u3002",
      storageUsageLabel: (usage: string) => `\u6d4f\u89c8\u5668\u5b58\u50a8\u5df2\u7528\uff1a${usage}`,
      shotCountLabel: (count: number) => `${count} \u4e2a\u955c\u5934`,
      localDraftLabel: "\u672c\u5730\u8349\u7a3f",
      activeCastLabel: "\u5f53\u524d\u89d2\u8272",
      waitingLabel: "\u7b49\u5f85\u4e2d",
      finalRenderLabel: "\u6700\u7ec8\u6e32\u67d3",
      finalVideoTitle: "\u6700\u7ec8\u89c6\u9891",
      downloadFinalVideoAction: "\u4e0b\u8f7d\u6700\u7ec8\u89c6\u9891",
      downloadingFinalVideoAction: "\u6b63\u5728\u51c6\u5907\u4e0b\u8f7d",
      renderFinalVideoAction: "\u6e32\u67d3\u6700\u7ec8\u89c6\u9891",
      renderingVideoAction: "\u6b63\u5728\u6e32\u67d3\u89c6\u9891",
    },
    projectsPage: {
      title: "\u9879\u76ee",
      localStorageNote: "\u9879\u76ee\u4fdd\u5b58\u5728\u5f53\u524d\u6d4f\u89c8\u5668\u4e2d\u3002",
      createAction: "\u65b0\u5efa\u9879\u76ee",
      importAction: "\u5bfc\u5165\u9879\u76ee",
      importDirectoryAction: "\u9009\u62e9\u5df2\u89e3\u538b\u5907\u4efd",
      importingAction: "\u6b63\u5728\u5bfc\u5165...",
      cancelImportAction: "\u53d6\u6d88\u5bfc\u5165",
      importProgress: (bytesRead, totalBytes, entriesRead, totalEntries) =>
        `${bytesRead} / ${totalBytes} \u5b57\u8282\uff0c${entriesRead} / ${totalEntries} \u4e2a\u6761\u76ee`,
      workerUnavailableError:
        "\u5f53\u524d\u6d4f\u89c8\u5668\u65e0\u6cd5\u8bfb\u53d6\u538b\u7f29\u5907\u4efd\uff0c\u8bf7\u9009\u62e9\u5df2\u89e3\u538b\u5907\u4efd\u6587\u4ef6\u5939\u3002",
      loading: "\u6b63\u5728\u52a0\u8f7d\u672c\u5730\u9879\u76ee...",
      emptyState: "\u6682\u65e0\u672c\u5730\u9879\u76ee\u3002",
      shotCount: (count: number) => `${count} \u4e2a\u5206\u955c`,
      updatedAt: (value: string) => `\u66f4\u65b0\u4e8e ${value}`,
      finalRenderReady: "\u5df2\u6709\u6210\u7247",
      openAction: "\u6253\u5f00",
      openProject: (title: string) => `\u6253\u5f00 ${title}`,
      exportAction: "\u5bfc\u51fa",
      exportingAction: "\u6b63\u5728\u5bfc\u51fa...",
      exportProject: (title: string) => `\u5bfc\u51fa ${title}`,
      deleteAction: "\u5220\u9664",
      deleteProject: (title: string) => `\u5220\u9664 ${title}`,
      deleteDialogTitle: "\u5220\u9664\u9879\u76ee",
      deleteDialogBody: (title: string) => `\u786e\u5b9a\u8981\u5220\u9664\u201c${title}\u201d\u5417\uff1f\u6b64\u64cd\u4f5c\u65e0\u6cd5\u64a4\u9500\u3002`,
      cancelAction: "\u53d6\u6d88",
      confirmDeleteAction: "\u786e\u8ba4\u5220\u9664",
      deletingAction: "\u6b63\u5728\u5220\u9664...",
      overwriteDialogTitle: "\u8986\u76d6\u73b0\u6709\u9879\u76ee",
      overwriteDialogBody: (title: string) =>
        `\u672c\u5730\u9879\u76ee\u201c${title}\u201d\u5df2\u5b58\u5728\u3002\u786e\u5b9a\u4f7f\u7528\u6b64\u5907\u4efd\u8986\u76d6\u5417\uff1f`,
      confirmOverwriteAction: "\u786e\u8ba4\u8986\u76d6",
      overwritingAction: "\u6b63\u5728\u8986\u76d6...",
      loadError: "\u65e0\u6cd5\u52a0\u8f7d\u672c\u5730\u9879\u76ee\u3002",
      exportError: "\u65e0\u6cd5\u5bfc\u51fa\u9879\u76ee\u3002",
      importError: "\u65e0\u6cd5\u5bfc\u5165\u9879\u76ee\u3002",
      deleteError: "\u65e0\u6cd5\u5220\u9664\u9879\u76ee\u3002",
    },
    newProjectPage: {
      title: "\u65b0\u5efa\u9879\u76ee",
      backToProjects: "\u8fd4\u56de\u9879\u76ee\u5217\u8868",
      projectTitleLabel: "\u9879\u76ee\u6807\u9898",
      projectTitlePlaceholder: "\u672a\u547d\u540d\u9879\u76ee",
      projectTypeLabel: "\u9879\u76ee\u7c7b\u578b",
      singleVideo: "\u5355\u89c6\u9891",
      miniSeries: "\u77ed\u7cfb\u5217",
      longSeries: "\u957f\u7cfb\u5217",
      promptLabel: "\u6545\u4e8b\u4e0e\u753b\u9762\u8981\u6c42",
      promptPlaceholder: "\u63cf\u8ff0\u6545\u4e8b\u3001\u89d2\u8272\u3001\u6c1b\u56f4\u548c\u753b\u9762\u65b9\u5411\u3002",
      createAction: "AI \u89c4\u5212\u5206\u955c",
      creatingAction: "\u6b63\u5728\u89c4\u5212\u5206\u955c...",
      createError: "\u65e0\u6cd5\u89c4\u5212\u5206\u955c\u3002",
      createDraftAction: "\u5148\u521b\u5efa\u9879\u76ee\u5e76\u6253\u5f00\u8d44\u6e90\u5e93",
      creatingDraftAction: "\u6b63\u5728\u521b\u5efa\u9879\u76ee...",
      createDraftError: "\u65e0\u6cd5\u521b\u5efa\u9879\u76ee\u3002",
    },
    nav: {
      ariaLabel: "\u5de5\u4f5c\u53f0\u5206\u533a",
      storyboard: "\u6545\u4e8b\u677f",
      series: "\u5168\u96c6\u8bbe\u5b9a",
      episodes: "\u5206\u96c6\u8bbe\u5b9a",
      resources: "\u8d44\u6e90\u5e93",
      production: "\u751f\u4ea7",
    },
    projectType: {
      label: "\u9879\u76ee\u7c7b\u578b",
      singleVideo: "\u5355\u89c6\u9891",
      miniSeries: "\u77ed\u7cfb\u5217",
      longSeries: "\u957f\u7cfb\u5217",
      lockedHint: "\u9879\u76ee\u521b\u5efa\u540e\uff0c\u9879\u76ee\u7c7b\u578b\u4e0d\u53ef\u66f4\u6539\u3002",
    },
    chatPanel: {
      regionLabel: "\u5236\u4f5c\u52a9\u624b",
      title: "\u5236\u4f5c\u52a9\u624b",
      projectTitleLabel: "\u9879\u76ee\u6807\u9898",
      promptLabel: "\u77ed\u5267\u63d0\u793a\u8bcd",
      createStoryboardAction: "\u521b\u5efa\u6545\u4e8b\u677f",
      creatingStoryboardAction: "\u6b63\u5728\u521b\u5efa",
    },
    errors: {
      createProjectFallback: "\u65e0\u6cd5\u521b\u5efa\u9879\u76ee\u3002",
      renderRequiresStoryboard: "\u8bf7\u5148\u521b\u5efa\u6545\u4e8b\u677f\uff0c\u518d\u6e32\u67d3\u6700\u7ec8\u89c6\u9891\u3002",
      renderFallback: "\u65e0\u6cd5\u6e32\u67d3\u6700\u7ec8\u89c6\u9891\u3002",
      saveShotFallback: "\u65e0\u6cd5\u4fdd\u5b58\u955c\u5934\u3002",
      optimizeShotFallback: "\u65e0\u6cd5\u4f18\u5316\u955c\u5934\u63d0\u793a\u8bcd\u3002",
      createStoryboardRequiresPrompt: "\u8bf7\u5148\u8f93\u5165\u6545\u4e8b\u63d0\u793a\uff0c\u518d\u521b\u5efa\u6545\u4e8b\u677f\u3002",
      saveContinuityFallback: "\u65e0\u6cd5\u4fdd\u5b58\u8fde\u7eed\u6027\u8bbe\u5b9a\u3002",
      uploadReferenceFallback: "\u65e0\u6cd5\u4e0a\u4f20\u53c2\u8003\u56fe\u3002",
      readOnlyProjectFallback:
        "\u5f53\u524d\u9879\u76ee\u662f\u79bb\u7ebf\u53ea\u8bfb\u526f\u672c\uff0c\u8bf7\u5728\u8fde\u63a5\u6062\u590d\u540e\u518d\u4fee\u6539\u3002",
      localProjectSaveFallback:
        "\u9879\u76ee\u5df2\u6253\u5f00\uff0c\u4f46\u6d4f\u89c8\u5668\u65e0\u6cd5\u4fdd\u5b58\u672c\u5730\u8349\u7a3f\u3002\u5173\u95ed\u6b64\u6807\u7b7e\u9875\u524d\u8bf7\u5148\u5bfc\u51fa\u9879\u76ee\u3002",
      exportProjectFallback: "\u9879\u76ee\u5bfc\u51fa\u5931\u8d25\u3002",
      importProjectFallback: "\u9879\u76ee\u5bfc\u5165\u5931\u8d25\u3002",
      downloadFinalVideoFallback: "\u6700\u7ec8\u89c6\u9891\u4e0b\u8f7d\u5931\u8d25\u3002",
      regenerateShotFallback: (shotId: string) =>
        `\u65e0\u6cd5\u91cd\u65b0\u751f\u6210\u955c\u5934 ${shotId}\u3002`,
      regenerateShotTimeout: "\u91cd\u751f\u6210\u8bf7\u6c42\u7b49\u5f85\u8d85\u65f6\uff0c\u670d\u52a1\u53ef\u80fd\u4ecd\u5728\u540e\u53f0\u5904\u7406\uff0c\u8bf7\u5237\u65b0\u540e\u518d\u91cd\u8bd5\u3002",
    },
    shotEditor: {
      title: "\u955c\u5934\u7f16\u8f91",
      regionLabel: "\u955c\u5934\u7f16\u8f91",
      emptyState: "\u8bf7\u5148\u521b\u5efa\u6545\u4e8b\u677f\uff0c\u518d\u7f16\u8f91\u955c\u5934\u5143\u6570\u636e\u3002",
      shotIdentity: (shotIndex, shotId) => `\u5206\u955c ${shotIndex} \u00b7 ${shotId}`,
      beatLabel: "\u8282\u62cd",
      episodeLabel: "\u6240\u5c5e\u5206\u96c6",
      episodeUnassignedOption: "\u672a\u5206\u914d",
      episodeOption: (episodeNumber, title) => (
        title
          ? `\u7b2c ${episodeNumber} \u96c6 \u00b7 ${title}`
          : `\u7b2c ${episodeNumber} \u96c6`
      ),
      episodeUnavailableOption: (episodeNumber) => (
        `\u7b2c ${episodeNumber} \u96c6\uff08\u5df2\u4e0d\u5728\u5206\u96c6\u8ba1\u5212\u4e2d\uff09`
      ),
      narrativeSectionTitle: "\u753b\u9762\u4e0e\u53d9\u4e8b",
      shotLanguageSectionTitle: "\u955c\u5934\u8bed\u8a00",
      dirtyStatus: "\u672a\u4fdd\u5b58",
      savedStatus: "\u5df2\u4fdd\u5b58",
      videoOutdatedStatus: "\u9700\u91cd\u65b0\u751f\u6210",
      videoOutdatedHint:
        "\u4fee\u6539\u5df2\u4fdd\u5b58\uff0c\u65e7\u89c6\u9891\u4ecd\u53ef\u9884\u89c8\u3002\u53d7\u5f71\u54cd\u7684\u5b8c\u6574\u5355\u5143\u5df2\u5728\u5de6\u4fa7\u81ea\u52a8\u52a0\u5165\u91cd\u751f\u6210\u8ba1\u5212\u3002",
      promptLabel: "\u5206\u955c\u63d0\u793a\u8bcd",
      locationLabel: "\u573a\u666f",
      charactersLabel: "\u89d2\u8272",
      propsLabel: "\u9053\u5177",
      intentLabel: "\u955c\u5934\u610f\u56fe",
      shotSizeLabel: "\u666f\u522b",
      cameraMovementLabel: "\u8fd0\u955c\u65b9\u5f0f",
      lensLabel: "\u673a\u4f4d / \u955c\u5934\u7126\u6bb5",
      lightingLabel: "\u6253\u5149",
      depthOfFieldLabel: "\u666f\u6df1",
      colorTemperatureLabel: "\u8272\u6e29",
      unspecifiedOption: "\u672a\u6307\u5b9a",
      shotSizeOptions: {
        extreme_wide: "\u5927\u8fdc\u666f",
        wide: "\u8fdc\u666f",
        medium_wide: "\u4e2d\u8fdc\u666f",
        medium: "\u4e2d\u666f",
        medium_close: "\u4e2d\u8fd1\u666f",
        close_up: "\u7279\u5199",
        extreme_close_up: "\u5927\u7279\u5199",
        over_shoulder: "\u8fc7\u80a9\u955c\u5934",
        insert: "\u63d2\u5165\u7279\u5199",
        establishing: "\u5efa\u7acb\u955c\u5934",
      },
      cameraMovementOptions: {
        static: "\u56fa\u5b9a",
        pan_left: "\u5de6\u6447",
        pan_right: "\u53f3\u6447",
        tilt_up: "\u4e0a\u4ef0",
        tilt_down: "\u4e0b\u4fef",
        dolly_in: "\u63a8\u955c",
        dolly_out: "\u62c9\u955c",
        tracking_left: "\u5de6\u79fb\u8ddf\u62cd",
        tracking_right: "\u53f3\u79fb\u8ddf\u62cd",
        crane_up: "\u5347\u964d\u4e0a\u79fb",
        crane_down: "\u5347\u964d\u4e0b\u79fb",
        handheld: "\u624b\u6301",
        steadicam: "\u7a33\u5b9a\u5668",
        whip_pan: "\u5feb\u901f\u6447\u955c",
        orbital: "\u73af\u7ed5",
        zoom_in: "\u53d8\u7126\u63a8\u8fd1",
        zoom_out: "\u53d8\u7126\u62c9\u8fdc",
        rack_focus: "\u7126\u70b9\u8f6c\u79fb",
      },
      lensOptions: {
        "14": "14 \u6beb\u7c73",
        "24": "24 \u6beb\u7c73",
        "35": "35 \u6beb\u7c73",
        "50": "50 \u6beb\u7c73",
        "85": "85 \u6beb\u7c73",
        "135": "135 \u6beb\u7c73",
        "200": "200 \u6beb\u7c73",
      },
      lightingOptions: {
        high_key: "\u9ad8\u8c03",
        low_key: "\u4f4e\u8c03",
        natural: "\u81ea\u7136\u5149",
        golden_hour: "\u9ec4\u660f\u5149",
        blue_hour: "\u84dd\u8c03\u65f6\u5206",
        tungsten_warm: "\u6696\u8272\u94a8\u4e1d\u706f",
        neon: "\u9713\u8679",
        silhouette: "\u526a\u5f71",
        rim_lit: "\u8f6e\u5ed3\u5149",
        volumetric: "\u4f53\u79ef\u5149",
        overcast_soft: "\u9634\u5929\u67d4\u5149",
      },
      depthOfFieldOptions: {
        shallow: "\u6d45",
        medium: "\u4e2d",
        deep: "\u6df1",
      },
      colorTemperatureOptions: {
        cool: "\u51b7\u8272",
        neutral: "\u4e2d\u6027",
        warm: "\u6696\u8272",
        mixed: "\u6df7\u5408",
      },
      referenceAssetsLabel: "\u53c2\u8003\u8d44\u6e90",
      keyframesSectionTitle: "\u9996\u5c3e\u5173\u952e\u5e27",
      continuityModeLabel: "\u955c\u5934\u8854\u63a5\u610f\u56fe",
      continuityModes: {
        carry: "\u8fde\u7eed\u52a8\u4f5c",
        cut: "\u786c\u5207",
        match_cut: "\u5339\u914d\u526a\u8f91",
      },
      inheritPreviousTailLabel: "\u4f7f\u7528\u4e0a\u4e00\u955c\u5934\u5c3e\u5e27",
      firstFrameLabel: "\u9996\u5e27",
      tailFrameLabel: "\u5c3e\u5e27",
      uploadFirstFrameAction: "\u4e0a\u4f20\u9996\u5e27",
      selectFirstFrameLabel: "\u9009\u62e9\u5df2\u6709\u8d44\u6e90",
      removeFirstFrameAction: "\u79fb\u9664\u663e\u5f0f\u9996\u5e27",
      removeTailFrameAction: "\u79fb\u9664\u5c3e\u5e27",
      generateFirstFrameAction: "AI \u751f\u6210\u9996\u5e27\uff08\u9700\u62a5\u4ef7\uff09",
      generateTailFrameAction: "AI \u751f\u6210\u76ee\u6807\u5c3e\u5e27\uff08\u9700\u62a5\u4ef7\uff09",
      generateFirstFrameDialogTitle: "\u751f\u6210\u8fde\u7eed\u6027\u9996\u5e27",
      generateTailFrameDialogTitle: "\u751f\u6210\u660e\u786e\u76ee\u6807\u5c3e\u5e27",
      keyframeGenerationFailed: "\u5173\u952e\u5e27\u751f\u6210\u5931\u8d25\u3002",
      keyframeAwaitingPayment: "\u652f\u4ed8\u540e\u624d\u80fd\u7ee7\u7eed\u751f\u6210\u5173\u952e\u5e27\u3002",
      retryKeyframeGenerationAction: "\u91cd\u8bd5\u751f\u6210",
      retryFirstFrameUploadAction: "\u91cd\u8bd5\u4e0a\u4f20",
      firstFrameUploadFailed: "\u9996\u5e27\u4e0a\u4f20\u5931\u8d25\u3002",
      uploadingFirstFrameStatus: "\u6b63\u5728\u4e0a\u4f20\u9996\u5e27",
      noExplicitFirstFrameOption: "\u4f7f\u7528\u7ee7\u627f\u5e27\u6216\u666e\u901a\u53c2\u8003\u56fe",
      firstFrameSourceUser: "\u7528\u6237\u56fe\u7247",
      firstFrameSourceInherited: "\u4ece\u4e0a\u4e00\u955c\u5934\u89c6\u9891\u7ee7\u627f\uff08\u514d\u8d39\uff09",
      firstFrameSourceAi: "AI \u751f\u6210\uff08\u72ec\u7acb\u62a5\u4ef7\uff09",
      tailFrameSourceExtracted: "\u4ece\u5f53\u524d\u89c6\u9891\u62bd\u53d6\uff08\u514d\u8d39\uff09",
      noFirstFrame: "\u6682\u65e0\u9996\u5e27",
      noTailFrame: "\u89c6\u9891\u5b8c\u6210\u540e\u81ea\u52a8\u62bd\u53d6",
      frameStaleStatus: "\u5df2\u8fc7\u671f",
      frameReadyStatus: "\u5f53\u524d\u7248\u672c",
      noSavedReferenceAssetsYet: "\u5c1a\u672a\u4fdd\u5b58\u53c2\u8003\u8d44\u6e90\u3002",
      noCharactersYet: "\u5c1a\u65e0\u53ef\u7ed1\u5b9a\u89d2\u8272\u3002",
      missingBindingLabel: "\u6e90\u8bb0\u5f55\u5df2\u7f3a\u5931",
      assetKindLabels: {
        character: "\u89d2\u8272",
        scene: "\u573a\u666f",
        prop: "\u9053\u5177",
      },
      textToVideoMode: "\u6587\u751f\u89c6\u9891\uff1a\u5f53\u524d\u672a\u9009\u4e2d\u53c2\u8003\u56fe",
      imageToVideoMode: (count) => `\u56fe\u751f\u89c6\u9891\uff1a\u5df2\u9009 ${count} \u5f20\u53c2\u8003\u56fe`,
      optimizeAction: "AI \u4f18\u5316\u63d0\u793a\u8bcd",
      optimizingAction: "\u6b63\u5728\u4f18\u5316\u63d0\u793a\u8bcd",
      optimizeSuccess: "AI \u4f18\u5316\u7ed3\u679c\u5df2\u5199\u5165\u672a\u4fdd\u5b58\u8349\u7a3f\u3002",
      undoOptimizationAction: "\u64a4\u9500\u4f18\u5316",
      saveAction: "\u4fdd\u5b58\u4fee\u6539",
      savingAction: "\u6b63\u5728\u4fdd\u5b58\u4fee\u6539",
      saveSuccess: "\u5206\u955c\u4fee\u6539\u5df2\u4fdd\u5b58\u3002",
      regenerateAction: "\u91cd\u65b0\u751f\u6210\u89c6\u9891",
      videoModelLabel: "\u672c\u6b21\u91cd\u65b0\u751f\u6210\u7684\u89c6\u9891\u6a21\u578b",
      regeneratingAction: "\u6b63\u5728\u91cd\u65b0\u751f\u6210\u89c6\u9891",
      regenerateSuccess: "\u89c6\u9891\u5df2\u91cd\u65b0\u751f\u6210\uff0c\u5f53\u524d\u8349\u7a3f\u4fdd\u6301\u4e0d\u53d8\u3002",
      saveBeforeRegenerateHint: "\u8bf7\u5148\u4fdd\u5b58\u4fee\u6539",
      regenerateKeepsDraftHint: "\u672a\u4fdd\u5b58\u8349\u7a3f\u4f1a\u7ee7\u7eed\u4fdd\u7559\u3002",
      regenerateConfirmTitle: "\u786e\u8ba4\u91cd\u65b0\u751f\u6210\u89c6\u9891",
      confirmRegenerateAction: "\u786e\u8ba4\u91cd\u65b0\u751f\u6210",
      cancelAction: "\u53d6\u6d88",
      estimatedBalanceImpactLabel: "\u9884\u8ba1\u8d39\u7528",
      estimatedBalanceImpact:
        "\u670d\u52a1\u7aef\u5c06\u6309\u5f53\u524d\u89c6\u9891\u6a21\u578b\u5b9e\u65f6\u62a5\u4ef7\u5e76\u9884\u6263\u4eba\u6c11\u5e01\uff0c\u6210\u529f\u540e\u6309\u5206\u5411\u4e0a\u53d6\u6574\u7ed3\u7b97\u3002",
      availableBalanceLabel: "\u5f53\u524d\u4f59\u989d",
      availableBalance: (units) => `\u53ef\u7528\u4f59\u989d ${units}`,
      balanceUnavailable: "\u6682\u65f6\u65e0\u6cd5\u8bfb\u53d6\u4f59\u989d\uff0c\u63d0\u4ea4\u65f6\u4ecd\u7531\u670d\u52a1\u7aef\u6267\u884c\u4f59\u989d\u95e8\u7981\u3002",
      bindingSummaryTitle: "\u672c\u6b21\u751f\u6210\u7684\u5df2\u4fdd\u5b58\u7ed1\u5b9a",
      emptyBindingLabel: "\u672a\u7ed1\u5b9a",
      regenerateDirtyDraftNotice:
        "\u672c\u6b21\u751f\u6210\u4f7f\u7528\u6700\u8fd1\u5df2\u4fdd\u5b58\u7248\u672c\u3002\u672a\u4fdd\u5b58\u8349\u7a3f\u4f1a\u7559\u5728\u68c0\u67e5\u5668\u4e2d\uff0c\u4e0d\u4f1a\u81ea\u52a8\u4fdd\u5b58\u3002",
      regenerateSavedSourceNotice: "\u672c\u6b21\u751f\u6210\u4f7f\u7528\u6700\u8fd1\u5df2\u4fdd\u5b58\u7684\u5206\u955c\u4e0e\u7ed1\u5b9a\u3002",
    },
    storyboardPage: {
      shotListLabel: "\u5206\u955c\u5217\u8868",
      previewLabel: "\u5206\u955c\u9884\u89c8",
      previewTabLabel: "\u9884\u89c8",
      orderLabel: "\u5206\u955c\u987a\u5e8f",
      inspectorLabel: "\u5206\u955c\u68c0\u67e5\u5668",
      viewControlLabel: "\u5206\u955c\u89c6\u56fe",
      tabletPanelsLabel: "\u5206\u955c\u4fa7\u680f",
      openShotListLabel: "\u6253\u5f00\u5206\u955c\u5217\u8868",
      openInspectorLabel: "\u6253\u5f00\u5206\u955c\u68c0\u67e5\u5668",
      emptyPlannerTitle: "\u89c4\u5212\u5206\u955c",
      planPromptLabel: "\u6545\u4e8b\u4e0e\u753b\u9762\u8981\u6c42",
      planPromptPlaceholder: "\u63cf\u8ff0\u6545\u4e8b\u3001\u89d2\u8272\u3001\u6c1b\u56f4\u548c\u753b\u9762\u65b9\u5411\u3002",
      planAction: "AI \u89c4\u5212\u5206\u955c",
      planningAction: "\u6b63\u5728\u89c4\u5212\u5206\u955c...",
      planError: "\u65e0\u6cd5\u89c4\u5212\u5206\u955c\u3002",
      emptyShots: "\u5c1a\u672a\u751f\u6210\u5206\u955c\u3002",
      noSelectedShot: "\u8bf7\u9009\u62e9\u6216\u521b\u5efa\u5206\u955c\u4ee5\u8fdb\u884c\u9884\u89c8\u3002",
      noPreviewMedia: "\u5f53\u524d\u5206\u955c\u5c1a\u65e0\u9884\u89c8\u5a92\u4f53",
      previewLoading: "\u6b63\u5728\u52a0\u8f7d\u9884\u89c8\u5a92\u4f53...",
      previewError: "\u9884\u89c8\u5a92\u4f53\u52a0\u8f7d\u5931\u8d25\u3002",
      previewGenerating: "\u89c6\u9891\u6b63\u5728\u751f\u6210",
      thumbnailLabel: "\u7f29\u7565\u9884\u89c8",
      estimatedDuration: (durationSeconds) => `\u9884\u8ba1 ${durationSeconds.toFixed(1)} \u79d2`,
      shotTitle: (shotIndex: number) => `\u5206\u955c ${shotIndex}`,
      selectShotLabel: (shotIndex: number) => `\u9009\u62e9\u5206\u955c ${shotIndex}`,
      selectOrderedShotLabel: (shotIndex: number) => `\u5728\u987a\u5e8f\u4e2d\u9009\u62e9\u5206\u955c ${shotIndex}`,
      previousShotPageLabel: "\u4e0a\u4e00\u7ec4\u5206\u955c",
      nextShotPageLabel: "\u4e0b\u4e00\u7ec4\u5206\u955c",
      shotRangeLabel: (start, end, total) => `\u7b2c ${start}-${end} \u955c\uff0c\u5171 ${total} \u955c`,
      orderPaginationLabel: "\u5206\u955c\u987a\u5e8f\u5206\u9875",
      previewMediaLabel: (shotIndex: number) => `\u5206\u955c ${shotIndex} \u9884\u89c8\u5a92\u4f53`,
      plannedShotCount: (count: number) => `AI \u5df2\u4e3a\u4f60\u89c4\u5212 ${count} \u4e2a\u5206\u955c`,
      discardChangesConfirm: "\u5f53\u524d\u5206\u955c\u6709\u672a\u4fdd\u5b58\u4fee\u6539\uff0c\u786e\u5b9a\u653e\u5f03\u5417\uff1f",
      episodePickerLabel: "\u5f53\u524d\u5206\u96c6",
      episodeOption: (episodeNumber, title) => title
        ? `\u7b2c ${episodeNumber} \u96c6 \u00b7 ${title}`
        : `\u7b2c ${episodeNumber} \u96c6`,
      switchEpisodeError: "\u65e0\u6cd5\u5207\u6362\u5f53\u524d\u5206\u96c6\u3002",
      videoModelLabel: "\u672c\u6b21\u751f\u6210\u7684\u89c6\u9891\u6a21\u578b",
      generationPlanLoading: "\u6b63\u5728\u68c0\u67e5\u6a21\u578b\u65f6\u957f\u4e0e\u9996\u5c3e\u5e27\u80fd\u529b...",
      generationPlanError: "\u65e0\u6cd5\u9884\u89c8\u5f53\u524d\u6a21\u578b\u9002\u914d\u65b9\u6848\u3002",
      generationPlanRegionLabel: "\u89c6\u9891\u751f\u6210\u5355\u5143",
      generationPlanCounts: (beatCount, unitCount, nativeSeconds) => (
        `${beatCount} \u4e2a\u53d9\u4e8b\u8282\u62cd / ${unitCount} \u4e2a\u89c6\u9891\u751f\u6210\u5355\u5143 / \u9884\u8ba1 ${nativeSeconds ?? "\u672a\u77e5"} \u79d2`
      ),
      generationPlanModel: (provider, model) => `${provider} / ${model}`,
      durationComparisonLabel: "\u751f\u6210\u8ba1\u5212\u65f6\u957f\u5bf9\u6bd4",
      recommendedContentDurationLabel: "\u5185\u5bb9\u5efa\u8bae\u65f6\u957f",
      requestedDurationTotalLabel: "\u6a21\u578b\u8bf7\u6c42\u65f6\u957f",
      targetDurationLabel: "\u76ee\u6807\u65f6\u957f",
      nativeDurationLabel: "\u539f\u751f\u603b\u65f6\u957f",
      durationDifferenceLabel: "\u65f6\u957f\u5dee\u503c",
      durationValue: (seconds) => seconds == null ? "\u672a\u77e5" : `${seconds} \u79d2`,
      durationDifferenceValue: (seconds) => seconds == null
        ? "\u672a\u77e5"
        : `${seconds > 0 ? "+" : ""}${seconds} \u79d2`,
      adaptationActionsLabel: "\u65f6\u957f\u9002\u914d\u64cd\u4f5c",
      acceptLongerDurationAction: "\u63a5\u53d7\u66f4\u957f\u6210\u7247",
      reviseStoryboardAction: "\u51cf\u5c11\u6216\u5408\u5e76\u5206\u955c",
      chooseCompatibleModelAction: "\u66f4\u6362\u517c\u5bb9\u6a21\u578b",
      generationUnitIndex: (index) => `U${index}`,
      recommendedContentDurationValue: (seconds) => `\u5185\u5bb9\u5efa\u8bae ${seconds ?? "\u672a\u77e5"} \u79d2`,
      requestedDurationValue: (seconds) => `\u8bf7\u6c42 ${seconds ?? "\u672a\u77e5"} \u79d2`,
      providerModelValue: (provider, model) => `${provider} \u00b7 ${model}`,
      unitAssetValue: (assetId, outputPath) => `\u7d20\u6750 ${assetId ?? "\u672a\u7ed1\u5b9a"} \u00b7 ${outputPath ?? "\u8def\u5f84\u5f85\u5b9a"}`,
      sourceBeatId: (beatId) => `\u8282\u62cd ${beatId}`,
      unitDurationContract: (durationMode) => `${durationMode} \u6a21\u578b\u65f6\u957f\u5951\u7ea6`,
      unitCapabilityUnknown: "\u6a21\u578b\u80fd\u529b\u5951\u7ea6\u4e0d\u53ef\u7528",
      unitBoundaryReasons: (reasons) => `\u8fb9\u754c\u7ea6\u675f\uff1a${reasons}`,
      unitBoundaryCount: (count) => count
        ? `${count} \u4e2a\u5df2\u786e\u8ba4\u7684\u5185\u90e8\u5408\u5e76\u8fb9\u754c`
        : "\u5355\u5206\u955c\u5355\u5143 \u00b7 \u65e0\u5185\u90e8\u5408\u5e76\u8fb9\u754c",
      unitStatusProtected: "\u5df2\u4fdd\u62a4",
      unitStatusActive: "\u5f53\u524d\u53ef\u7528",
      unitStatusRegenerate: "\u5f85\u6574\u4f53\u91cd\u751f\u6210",
      unitStatusPending: "\u5f85\u751f\u6210",
      unitStatusQueued: "\u6392\u961f\u4e2d",
      unitStatusRunning: "\u751f\u6210\u4e2d",
      unitStatusWaiting: "\u7b49\u5f85\u4e2d",
      unitStatusComplete: "\u5df2\u5b8c\u6210",
      unitStatusFailed: "\u5931\u8d25",
      unitStatusStale: "\u5df2\u8fc7\u671f",
      activeMediaRetained: "\u66ff\u6362\u6210\u529f\u524d\uff0c\u5f53\u524d active \u7d20\u6750\u4ecd\u53ef\u7528\u3002",
      regenerateUnitAction: "\u91cd\u65b0\u751f\u6210\u6b64\u5355\u5143",
      retryUnitAction: "\u91cd\u8bd5\u6b64\u5355\u5143",
      retryingUnitAction: "\u6b63\u5728\u91cd\u8bd5...",
      generatePendingUnitsAction: (count) => `\u751f\u6210 ${count} \u4e2a\u5f85\u5904\u7406\u5355\u5143`,
      submittingUnitsAction: "\u6b63\u5728\u63d0\u4ea4\u5355\u5143...",
      generationPlanEmpty: "\u9009\u62e9\u89c6\u9891\u6a21\u578b\u540e\u9884\u89c8\u751f\u6210\u5355\u5143\u3002",
      regenerateMultiUnitTitle: "\u6574\u4f53\u91cd\u751f\u6210\u591a\u5206\u955c\u5355\u5143",
      regenerateSingleUnitTitle: "\u66ff\u6362\u6b64\u751f\u6210\u5355\u5143",
      regenerateMultiUnitBody: (count) => `\u6b64\u7d20\u6750\u627f\u8f7d ${count} \u4e2a\u6709\u5e8f\u53d9\u4e8b\u8282\u62cd\uff0c\u53ea\u80fd\u6574\u4f53\u66ff\u6362\u3002`,
      regenerateSingleUnitBody: "\u65b0\u7d20\u6750\u6210\u529f\u524d\uff0c\u5f53\u524d\u7d20\u6750\u4f1a\u7ee7\u7eed\u4fdd\u6301 active\u3002",
      regeneratePartialRevisionNotice: "\u5982\u679c\u53ea\u9700\u4fee\u6539\u4e00\u4e2a\u8282\u62cd\uff0c\u8bf7\u5148\u4fee\u6539 storyboard \u5f62\u6210 revision\uff0c\u518d\u521b\u5efa\u65b0\u8ba1\u5212\u3002",
      cancelUnitRegenerationAction: "\u53d6\u6d88",
      confirmWholeUnitRegenerationAction: "\u6574\u4f53\u91cd\u65b0\u751f\u6210",
      confirmUnitRegenerationAction: "\u786e\u8ba4\u66ff\u6362",
      retryShotAction: "\u91cd\u8bd5\u5f53\u524d\u5206\u955c",
      retryingShotAction: "\u6b63\u5728\u91cd\u8bd5...",
      compositionReadyTitle: "\u5f53\u524d\u8303\u56f4\u955c\u5934\u5df2\u5c31\u7eea",
      compositionReadyBody: "\u7ee7\u7eed\u68c0\u67e5\u4f9d\u8d56\u5e76\u63d0\u4ea4\u6700\u7ec8\u5f02\u6b65\u5408\u6210\u3002",
      continueToCompositionAction: "\u8fdb\u5165\u5408\u6210",
      shotTaskStatusLabels: {
        queued: "\u6392\u961f\u4e2d",
        running: "\u751f\u6210\u4e2d",
        awaiting_payment: "\u5f85\u652f\u4ed8",
        waiting_dependency: "\u7b49\u5f85\u4e0a\u4e00\u955c",
        waiting_provider: "\u4f9b\u5e94\u5546\u751f\u6210\u4e2d",
        complete: "\u5df2\u5b8c\u6210",
        failed: "\u5931\u8d25",
        cancelled: "\u5df2\u53d6\u6d88",
      },
      previousShotMissing: "\u4e0a\u4e00\u4e2a\u5206\u955c\u672a\u751f\u6210\uff0c\u6682\u65f6\u65e0\u6cd5\u751f\u6210\u5f53\u524d\u5206\u955c\u3002",
      generateUnitsError: "\u65e0\u6cd5\u63d0\u4ea4\u5f85\u5904\u7406\u751f\u6210\u5355\u5143\u3002",
      generationUnitsDisabledError: "\u5f53\u524d\u73af\u5883\u672a\u5f00\u542f generation units v2\u3002\u8bf7\u4fdd\u6301\u53ea\u8bfb\uff0c\u6216\u7531\u7ba1\u7406\u5458\u5b8c\u6210\u53d1\u5e03\u95e8\u540e\u518d\u5f00\u542f\u3002",
      generationUnitsUpgradeRequiredError: "\u6b64\u8ba1\u5212\u5fc5\u987b\u4f7f\u7528 generation units v2\u3002\u9879\u76ee\u5347\u7ea7\u6216 backfill \u5b8c\u6210\u540e\u8bf7\u91cd\u65b0\u52a0\u8f7d\u3002",
      generationModeConflictError: "\u6b64\u9879\u76ee\u5df2\u4f7f\u7528\u53e6\u4e00\u79cd\u751f\u6210\u63d0\u4ea4\u6a21\u5f0f\u3002\u8bf7\u5b8c\u6210\u5347\u7ea7\uff0c\u6216\u4fdd\u6301\u53ea\u8bfb\u517c\u5bb9\u3002",
      generationPlanStaleError: "storyboard\u3001\u6a21\u578b profile \u6216 protected units \u5df2\u53d8\u5316\uff0c\u8bf7\u91cd\u65b0\u9884\u89c8\u540e\u518d\u63d0\u4ea4\u3002",
      generationPlanSelectionError: "\u5f85\u5904\u7406\u5355\u5143\u5df2\u4e0e\u670d\u52a1\u7aef\u8ba1\u5212\u4e0d\u4e00\u81f4\uff0c\u8bf7\u5237\u65b0\u8ba1\u5212\u540e\u91cd\u8bd5\u3002",
      generationUnitPartialSelectionError: "\u5f53\u524d\u8303\u56f4\u62c6\u5206\u4e86\u5df2\u6709\u7684\u591a\u5206\u955c\u5355\u5143\u3002\u8bf7\u6253\u5f00\u5b8c\u6574\u5206\u96c6\uff0c\u6216\u5148\u4fee\u6539 storyboard\u3002",
      generationPlanConfirmationError: "\u751f\u6210\u524d\u5fc5\u987b\u901a\u8fc7\u670d\u52a1\u7aef\u8ba1\u5212\u786e\u8ba4\u65f6\u957f\u7b56\u7565\u3002",
      generationPlanBlockedError: "\u5f53\u524d\u6a21\u578b\u65e0\u6cd5\u751f\u6210\u6b64\u6620\u5c04\uff0c\u8bf7\u6267\u884c\u4e0a\u65b9\u4efb\u4e00\u9002\u914d\u64cd\u4f5c\u3002",
    },
    storyboardWaterfall: {
      regionLabel: "\u5206\u955c\u7011\u5e03",
      title: "\u5206\u955c\u7011\u5e03",
      emptyState: "\u5c1a\u672a\u751f\u6210\u955c\u5934\u3002",
      noLocationFallback: "\u672a\u8bbe\u7f6e\u573a\u666f",
      scoreLabel: (score: number) => `\u5206\u6570 ${score}`,
      versionLabel: (version: number) => `\u7248\u672c ${version}`,
      editShotLabel: (shotIndex: number) => `\u7f16\u8f91\u955c\u5934 ${shotIndex}`,
      regenerateShotLabel: (shotIndex: number) => `\u91cd\u65b0\u751f\u6210\u955c\u5934 ${shotIndex}`,
      statusLabels: {
        draft: "\u8349\u7a3f",
        ready: "\u5c31\u7eea",
        generating: "\u751f\u6210\u4e2d",
        complete: "\u5df2\u5b8c\u6210",
        failed: "\u5931\u8d25",
        stale: "\u5f85\u91cd\u65b0\u751f\u6210",
      },
    },
    continuity: {
      ariaLabel: "\u8fde\u7eed\u6027\u5de5\u4f5c\u53f0",
      seriesTitle: "\u5168\u96c6\u8bbe\u5b9a",
      episodesTitle: "\u5206\u96c6\u8bbe\u5b9a",
      storyStateTitle: "\u6545\u4e8b\u72b6\u6001",
      worldview: "\u4e16\u754c\u89c2",
      mainArc: "\u4e3b\u7ebf",
      seriesPrompt: "\u7cfb\u5217\u7ea7\u63d0\u793a\u8bcd",
      styleLock: "\u98ce\u683c\u9501\u5b9a",
      visualRules: "\u89c6\u89c9\u89c4\u5219",
      taboos: "\u7981\u5fcc",
      locations: "\u573a\u666f",
      props: "\u9053\u5177",
      relationshipMap: "\u5173\u7cfb\u56fe",
      save: "\u4fdd\u5b58\u8fde\u7eed\u6027",
      saving: "\u6b63\u5728\u4fdd\u5b58\u8fde\u7eed\u6027",
      addEpisode: "\u6dfb\u52a0\u5206\u96c6",
      currentProductionEpisode: (episodeNumber) =>
        episodeNumber ? `\u5f53\u524d\u5236\u4f5c\u96c6\uff1a\u7b2c ${episodeNumber} \u96c6` : "\u5c1a\u672a\u9009\u62e9\u5f53\u524d\u5236\u4f5c\u96c6",
      setCurrentEpisode: (episodeNumber) => `\u8bbe\u7b2c ${episodeNumber} \u96c6\u4e3a\u5f53\u524d\u5236\u4f5c\u96c6`,
      currentEpisodeBadge: "\u5f53\u524d\u5236\u4f5c",
      episodeTitle: "\u5206\u96c6\u6807\u9898",
      goal: "\u76ee\u6807",
      conflict: "\u51b2\u7a81",
      twist: "\u53cd\u8f6c",
      cliffhanger: "\u60ac\u5ff5",
      inheritedState: "\u7ee7\u627f\u72b6\u6001",
      episodePrompt: "\u5206\u96c6\u63d0\u793a\u8bcd",
      episodeOutline: "\u5206\u96c6\u5927\u7eb2",
      locked: "\u9501\u5b9a",
      characterKnowledge: "\u89d2\u8272\u8ba4\u77e5",
      relationshipChanges: "\u5173\u7cfb\u53d8\u5316",
      activeForeshadowing: "\u8fdb\u884c\u4e2d\u4f0f\u7b14",
      resolvedForeshadowing: "\u5df2\u56de\u6536\u4f0f\u7b14",
      propState: "\u9053\u5177\u72b6\u6001",
      characterStatus: "\u89d2\u8272\u72b6\u6001",
      currentLocations: "\u5f53\u524d\u4f4d\u7f6e",
    },
    globalSettings: {
      title: "\u5168\u5c40\u8bbe\u5b9a",
      directoryLabel: "\u5168\u5c40\u8bbe\u5b9a\u76ee\u5f55",
      worldviewTitle: "\u4e16\u754c\u89c2",
      charactersTitle: "\u4eba\u7269\u8fde\u7eed\u6027",
      storyCoreTitle: "\u6545\u4e8b\u6838\u5fc3",
      visualRulesTitle: "\u89c6\u89c9\u89c4\u5219",
      charactersRelationshipsTitle: "\u89d2\u8272\u4e0e\u5173\u7cfb",
      storyStateTitle: "\u6545\u4e8b\u72b6\u6001",
      soundTitle: "\u58f0\u97f3",
      generationPreferencesTitle: "\u751f\u6210\u504f\u597d",
      episodePlanningTitle: "\u5206\u96c6\u89c4\u5212",
      notice: "\u53ea\u5f71\u54cd\u540e\u7eed\u4f18\u5316\u548c\u751f\u6210\uff0c\u4e0d\u4f1a\u4fee\u6539\u5df2\u5b8c\u6210\u5206\u955c",
      save: "\u4fdd\u5b58\u5168\u5c40\u8bbe\u5b9a",
      saving: "\u6b63\u5728\u4fdd\u5b58\u5168\u5c40\u8bbe\u5b9a",
      saved: "\u5168\u5c40\u8bbe\u5b9a\u5df2\u4fdd\u5b58",
      unsaved: "\u6709\u672a\u4fdd\u5b58\u4fee\u6539",
      saveError: "\u65e0\u6cd5\u4fdd\u5b58\u5168\u5c40\u8bbe\u5b9a\u3002",
      workflowApproved: "\u84dd\u56fe\u5df2\u6700\u7ec8\u6279\u51c6",
      workflowNotApproved: "\u84dd\u56fe\u6279\u51c6\u5c1a\u672a\u5b8c\u6210",
      characterRosterTitle: "\u9879\u76ee\u4eba\u7269\u540d\u518c",
      noCharacters: "\u5f53\u524d\u9879\u76ee\u5c1a\u672a\u4fdd\u5b58\u4eba\u7269\u3002",
      characterReferenceMissing: "\u7f3a\u5c11\u53c2\u8003\u56fe",
      characterVisualMissing: "\u7f3a\u5c11\u9020\u578b\u9501\u5b9a",
      continuityIssuesTitle: "\u5f53\u524d\u8fde\u7eed\u6027\u95ee\u9898",
      noContinuityIssues: "\u5f53\u524d\u6ca1\u6709\u62a5\u544a\u8fde\u7eed\u6027\u51b2\u7a81\u3002",
      narrationLabel: "\u65c1\u767d\u89c4\u5219",
      dialogueLabel: "\u5bf9\u767d\u89c4\u5219",
      ambienceLabel: "\u73af\u5883\u58f0",
      musicDirectionLabel: "\u97f3\u4e50\u65b9\u5411",
      soundPromptLabel: "\u58f0\u97f3\u63d0\u793a\u8bcd",
      integrateSoundLabel: "\u540e\u7eed\u5206\u955c\u63d0\u793a\u8bcd\u4e2d\u5e26\u5165\u58f0\u97f3\u65b9\u5411",
      imageModelLabel: "\u9ed8\u8ba4\u56fe\u50cf\u6a21\u578b",
      videoModelLabel: "\u9ed8\u8ba4\u89c6\u9891\u6a21\u578b",
      imageSizeLabel: "\u9ed8\u8ba4\u56fe\u50cf\u5c3a\u5bf8",
      imageQualityLabel: "\u9ed8\u8ba4\u56fe\u50cf\u8d28\u91cf",
      aspectRatioLabel: "\u9ed8\u8ba4\u753b\u5e45",
      episodeHeading: (episodeNumber, title) =>
        `\u7b2c ${episodeNumber} \u96c6${title ? `\uff1a${title}` : ""}`,
      episodeFieldLabel: (episodeNumber, field) => `\u7b2c ${episodeNumber} \u96c6${field}`,
    },
    resources: {
      title: "\u8d44\u6e90\u5e93",
      emptyState: "\u5c1a\u672a\u4fdd\u5b58\u8d44\u6e90\u3002",
      viewLabel: "\u8d44\u6e90\u89c6\u56fe",
      projectView: "\u672c\u9879\u76ee",
      allView: "\u6211\u7684\u8d44\u6e90",
      filterLabel: "\u8d44\u6e90\u7b5b\u9009",
      allKindsLabel: "\u5168\u90e8\u8d44\u6e90",
      sourceFilterLabel: "\u6765\u6e90\u7b5b\u9009",
      allSourcesLabel: "\u5168\u90e8\u6765\u6e90",
      sourceLabel: "\u6765\u6e90",
      sourceLabels: {
        upload: "\u4e0a\u4f20",
        ai_generated: "AI \u751f\u6210",
        video_frame: "\u89c6\u9891\u5c3e\u5e27\u62bd\u53d6",
      },
      searchLabel: "\u641c\u7d22\u8d44\u6e90",
      searchPlaceholder: "\u641c\u7d22\u540d\u79f0\u3001\u63cf\u8ff0\u548c\u63d0\u793a\u8bcd",
      kindLabel: "\u8d44\u6e90\u7c7b\u578b",
      kindLabels: {
        character: "\u89d2\u8272",
        scene: "\u573a\u666f",
        prop: "\u9053\u5177",
      },
      labelLabel: "\u540d\u79f0",
      descriptionLabel: "\u63cf\u8ff0",
      promptLabel: "\u63d0\u793a\u8bcd",
      fileLabel: "\u53c2\u8003\u56fe",
      uploadAction: "\u4e0a\u4f20\u53c2\u8003",
      uploadingAction: "\u6b63\u5728\u4e0a\u4f20\u53c2\u8003",
      uploadResourceAction: "\u4e0a\u4f20\u8d44\u6e90",
      generateImagesAction: "AI \u751f\u56fe",
      selectionLabel: "\u8d44\u6e90\u9009\u62e9",
      selectAllAction: "\u5168\u9009\u5f53\u524d\u8d44\u6e90",
      deselectAllAction: "\u53d6\u6d88\u5168\u9009",
      selectResource: (label) => `\u9009\u62e9 ${label}`,
      selectedResourceCount: (count) => `\u5df2\u9009 ${count} \u4e2a`,
      generateSelectedAction: "\u751f\u6210\u6240\u9009\u8d44\u6e90",
      submittingBatchAction: "\u6b63\u5728\u63d0\u4ea4",
      taskStatusLabels: {
        queued: "\u6392\u961f\u4e2d",
        running: "\u751f\u6210\u4e2d",
        awaiting_payment: "\u5f85\u652f\u4ed8",
        waiting_dependency: "\u7b49\u5f85\u4e2d",
        waiting_provider: "\u7b49\u5f85\u4f9b\u5e94\u5546",
        complete: "\u5df2\u5b8c\u6210",
        failed: "\u751f\u6210\u5931\u8d25",
        cancelled: "\u5df2\u53d6\u6d88",
      },
      retryResourceAction: "\u91cd\u8bd5",
      retryingResourceAction: "\u6b63\u5728\u91cd\u8bd5",
      plannedSourceLabel: "AI \u89c4\u5212",
      plannedStatus: "\u5f85\u751f\u6210",
      plannedPreview: "\u63d0\u793a\u8bcd\u5df2\u5c31\u7eea",
      generatePlannedAction: "\u751f\u6210\u6b64\u8d44\u6e90",
      plannedPrefillNotice: "\u5df2\u4ece\u6279\u51c6\u7684 AI \u89c4\u5212\u81ea\u52a8\u586b\u5165\u540d\u79f0\u3001\u63cf\u8ff0\u548c\u63d0\u793a\u8bcd\u3002",
      generatePlannedTitle: (label) => `\u751f\u6210\u8d44\u6e90\uff1a${label}`,
      viewAsset: (label) => `\u67e5\u770b\u8d44\u6e90 ${label}`,
      detailDialogTitle: "\u8d44\u6e90\u8be6\u60c5",
      uploadDialogTitle: "\u4e0a\u4f20\u8d44\u6e90",
      generateDialogTitle: "AI \u751f\u6210\u8d44\u6e90",
      closeDetailAction: "\u5173\u95ed\u8d44\u6e90\u8be6\u60c5",
      closeUploadAction: "\u5173\u95ed\u4e0a\u4f20\u8d44\u6e90",
      closeGenerateAction: "\u5173\u95ed AI \u751f\u56fe",
      linkedShotCount: (count) => `\u5df2\u5173\u8054 ${count} \u4e2a\u5206\u955c`,
      referencesTitle: "\u53c2\u8003\u56fe",
      referenceImageLabel: (index) => `\u53c2\u8003\u56fe ${index}`,
      mediaTitle: "\u5a92\u4f53",
      mediaItemLabel: (index) => `\u5a92\u4f53 ${index}`,
      consistencyIssuesTitle: "\u76f8\u5173\u4e00\u81f4\u6027\u95ee\u9898",
      noPrompt: "\u5c1a\u672a\u4fdd\u5b58\u63d0\u793a\u8bcd\u3002",
      bindAction: "\u7ed1\u5b9a\u5230\u5f53\u524d\u5206\u955c",
      unbindAction: "\u4ece\u5f53\u524d\u5206\u955c\u89e3\u7ed1",
      bindingAction: "\u6b63\u5728\u66f4\u65b0\u7ed1\u5b9a",
      bindError: "\u65e0\u6cd5\u66f4\u65b0\u8d44\u6e90\u7ed1\u5b9a\u3002",
      submitUploadAction: "\u63d0\u4ea4\u4e0a\u4f20",
      uploadingResourceAction: "\u6b63\u5728\u4e0a\u4f20",
      uploadError: "\u65e0\u6cd5\u4e0a\u4f20\u8d44\u6e90\u3002",
      batchModelLabel: "\u6240\u9009\u8d44\u6e90\u7684\u751f\u6210\u6a21\u578b",
      modelLabel: "\u6a21\u578b",
      countLabel: "\u6570\u91cf",
      sizeLabel: "\u5c3a\u5bf8",
      qualityLabel: "\u8d28\u91cf",
      sizeLabels: {
        "1024x1024": "\u65b9\u5f62\uff081024 x 1024\uff09",
        "1536x1024": "\u6a2a\u5411\uff081536 x 1024\uff09",
        "1024x1536": "\u7ad6\u5411\uff081024 x 1536\uff09",
      },
      qualityLabels: {
        standard: "\u6807\u51c6",
        high: "\u9ad8\u8d28\u91cf",
      },
      optimizePromptAction: "AI \u4f18\u5316\u63d0\u793a\u8bcd",
      optimizingPromptAction: "\u6b63\u5728\u4f18\u5316\u63d0\u793a\u8bcd",
      undoPromptOptimizationAction: "\u64a4\u9500\u4f18\u5316",
      optimizePromptError: "\u65e0\u6cd5\u4f18\u5316\u63d0\u793a\u8bcd\u3002",
      submitGenerateAction: "\u5f00\u59cb\u751f\u6210",
      generatingImagesAction: "\u6b63\u5728\u751f\u6210",
      generateError: "\u65e0\u6cd5\u751f\u6210\u8d44\u6e90\u3002",
      loadingAssets: "\u6b63\u5728\u52a0\u8f7d\u8d44\u6e90...",
      listError: "\u65e0\u6cd5\u52a0\u8f7d\u8d44\u6e90\u5e93\u3002",
      addToProjectAction: "\u52a0\u5165\u5f53\u524d\u9879\u76ee",
      addingToProjectAction: "\u6b63\u5728\u52a0\u5165",
      addError: "\u65e0\u6cd5\u5c06\u8d44\u6e90\u52a0\u5165\u5f53\u524d\u9879\u76ee\u3002",
      addBeforeBinding: "\u8bf7\u5148\u5c06\u8be5\u8d44\u6e90\u52a0\u5165\u5f53\u524d\u9879\u76ee\uff0c\u518d\u7ed1\u5b9a\u5206\u955c\u3002",
      createdAtTitle: "\u521b\u5efa\u65f6\u95f4",
      createdAtLabel: (value) => `\u521b\u5efa\u4e8e ${value}`,
      unknownCreatedAt: "\u65f6\u95f4\u672a\u77e5",
      fileMissing: "\u6587\u4ef6\u5f85\u6062\u590d",
      fileDeleted: "\u6587\u4ef6\u5df2\u5220\u9664",
      noPreview: "\u6682\u65e0\u9884\u89c8",
      loadingPreview: "\u6b63\u5728\u52a0\u8f7d\u9884\u89c8",
      previewFailed: "\u9884\u89c8\u52a0\u8f7d\u5931\u8d25",
      discardDrawerChanges: "\u653e\u5f03\u8d44\u6e90\u8868\u5355\u4e2d\u7684\u672a\u4fdd\u5b58\u4fee\u6539\uff1f",
    },
    production: {
      pageLabel: "\u6210\u7247\u5236\u4f5c",
      jobProgress: {
        regionLabel: "\u5236\u4f5c\u8fdb\u5ea6",
        title: "\u5236\u4f5c\u8fdb\u5ea6",
        emptyState: "\u6682\u65e0\u8fdb\u884c\u4e2d\u7684\u4efb\u52a1",
        stageLabels: {
          idle: "\u5df2\u51c6\u5907\u5236\u4f5c",
          preparing: "\u6b63\u5728\u51c6\u5907\u5236\u4f5c",
          queued: "\u5df2\u6392\u961f\u7b49\u5f85\u5408\u6210",
          generating: "\u6b63\u5728\u751f\u6210\u5f85\u8865\u955c\u5934",
          composing: "\u6b63\u5728\u5408\u6210\u6210\u7247",
          finalizing: "\u6b63\u5728\u6821\u9a8c\u6210\u7247",
          quota: "\u9700\u8981\u8865\u8db3\u989d\u5ea6",
          failed: "\u5236\u4f5c\u9700\u8981\u5904\u7406",
          complete: "\u6210\u7247\u5df2\u5b8c\u6210",
        },
        stageDescriptions: {
          preparing: "\u6b63\u5728\u6838\u5bf9\u955c\u5934\u3001\u8d44\u6e90\u548c\u8f93\u51fa\u8ba1\u5212\u3002",
          queued: "\u955c\u5934\u5df2\u5c31\u7eea\uff0c\u6700\u7ec8\u5408\u6210\u5df2\u8fdb\u5165\u961f\u5217\u3002",
          generating: "\u4ec5\u751f\u6210\u7f3a\u5931\u955c\u5934\uff0c\u5df2\u5b8c\u6210\u955c\u5934\u4f1a\u590d\u7528\u3002",
          composing: "\u6b63\u5728\u6309\u5f53\u524d\u8f93\u51fa\u89c4\u683c\u7ec4\u5408\u5df2\u6279\u51c6\u955c\u5934\u3002",
          finalizing: "\u6b63\u5728\u6821\u9a8c\u6700\u7ec8\u6587\u4ef6\u548c\u6e32\u67d3\u62a5\u544a\u3002",
          quota: "\u8865\u8db3\u989d\u5ea6\u540e\u8fd4\u56de\u6b64\u9875\uff0c\u53ef\u4ece\u670d\u52a1\u7aef\u4efb\u52a1\u7ee7\u7eed\u3002",
          failed: "\u67e5\u770b\u9519\u8bef\u5e76\u5237\u65b0\u670d\u52a1\u7aef\u72b6\u6001\u540e\u91cd\u8bd5\u3002",
          complete: "\u53ef\u9884\u89c8\u6216\u4e0b\u8f7d\u670d\u52a1\u7aef\u6700\u7ec8\u6587\u4ef6\u3002",
        },
        steps: ["\u51c6\u5907", "\u955c\u5934", "\u5408\u6210", "\u6821\u9a8c"],
        connectionLabels: {
          connecting: "\u6b63\u5728\u8fde\u63a5\u5b9e\u65f6\u66f4\u65b0",
          connected: "\u5b9e\u65f6\u66f4\u65b0\u5df2\u8fde\u63a5",
          disconnected: "\u5b9e\u65f6\u66f4\u65b0\u4e2d\u65ad\uff0c\u670d\u52a1\u7aef\u4e8b\u5b9e\u5df2\u4fdd\u7559",
        },
        refreshAction: "\u5237\u65b0\u72b6\u6001",
        refreshingAction: "\u6b63\u5728\u5237\u65b0",
      },
      workflowArtifacts: {
        regionLabel: "\u5de5\u4f5c\u6d41\u4ea7\u7269",
        title: "\u5de5\u4f5c\u6d41\u4ea7\u7269",
        emptyState: "\u6682\u65e0\u5de5\u4f5c\u6d41\u4ea7\u7269",
        existsStatus: "\u5df2\u751f\u6210",
        missingStatus: "\u7f3a\u5931",
        pathLabel: "\u8def\u5f84",
        shotSummaryLabel: "\u955c\u5934\u5236\u4f5c\u6458\u8981",
        totalShotsLabel: "\u5168\u90e8",
        reusableShotsLabel: "\u590d\u7528",
        generateShotsLabel: "\u5f85\u751f\u6210",
        completedShotsLabel: "\u5df2\u5b8c\u6210",
      },
      consistency: {
        regionLabel: "\u4e00\u81f4\u6027\u68c0\u67e5",
        title: "\u4e00\u81f4\u6027\u68c0\u67e5",
        noReport: "\u6682\u65e0\u62a5\u544a",
        noIssues: "\u672a\u53d1\u73b0\u95ee\u9898",
        severityLabels: {
          info: "\u4fe1\u606f",
          warning: "\u8b66\u544a",
          error: "\u9519\u8bef",
        },
        paginationLabel: "\u4e00\u81f4\u6027\u95ee\u9898\u5206\u9875",
        paginationStatusLabel: "\u4e00\u81f4\u6027\u95ee\u9898\u5206\u9875\u72b6\u6001",
        previousPageLabel: "\u4e0a\u4e00\u9875\u4e00\u81f4\u6027\u95ee\u9898",
        nextPageLabel: "\u4e0b\u4e00\u9875\u4e00\u81f4\u6027\u95ee\u9898",
        paginationStatus: (page, pageCount, issueCount) => `\u7b2c ${page} / ${pageCount} \u9875\uff0c\u5171 ${issueCount} \u9879`,
      },
      shotSelection: {
        regionLabel: "\u672c\u6b21\u5408\u6210\u7684\u955c\u5934",
        title: "\u672c\u96c6\u5408\u6210\u955c\u5934",
        selectedCount: (selected, total) => `\u5df2\u9009 ${selected} / ${total} \u4e2a\u955c\u5934`,
        selectAllAction: "\u5168\u9009\u955c\u5934",
        emptySelection: "\u81f3\u5c11\u9009\u62e9\u4e00\u4e2a\u955c\u5934\u624d\u80fd\u5408\u6210\u3002",
        shotLabel: (index, beat) => `\u9009\u62e9\u7b2c ${index} \u955c${beat ? `\uff1a${beat}` : ""}`,
        statusLabels: {
          draft: "\u8349\u7a3f",
          ready: "\u5df2\u5c31\u7eea",
          generating: "\u751f\u6210\u4e2d",
          complete: "\u5df2\u751f\u6210",
          failed: "\u751f\u6210\u5931\u8d25",
          stale: "\u9700\u91cd\u65b0\u751f\u6210",
        },
      },
      finalRender: {
        regionLabel: "\u6700\u7ec8\u6210\u7247",
        title: "\u6700\u7ec8\u6210\u7247",
        previewLabel: "\u6700\u7ec8\u6210\u7247\u9884\u89c8",
        noPreview: "\u6682\u65e0\u6700\u7ec8\u6210\u7247\u9884\u89c8",
        loadingPreview: "\u6b63\u5728\u52a0\u8f7d\u6210\u7247",
        previewError: "\u6210\u7247\u9884\u89c8\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u5237\u65b0\u6216\u4e0b\u8f7d\u539f\u6587\u4ef6\u3002",
        pathLabel: "\u8def\u5f84",
        downloadAction: "\u4e0b\u8f7d\u6700\u7ec8\u6210\u7247",
        downloadingAction: "\u6b63\u5728\u51c6\u5907\u4e0b\u8f7d",
        scopeLabel: "\u5f53\u524d\u5408\u6210\u8303\u56f4",
        episodeListLabel: "\u5206\u96c6\u6210\u7247",
        currentEpisode: (episode, title) => `\u672c\u6b21\u5408\u6210\uff1a\u7b2c ${episode} \u96c6${title ? ` \u00b7 ${title}` : ""}`,
        episodeHeading: (episode, title) => `\u7b2c ${episode} \u96c6${title ? ` \u00b7 ${title}` : ""}`,
        episodeCompleted: "\u5df2\u5b8c\u6210",
        episodePending: "\u5f85\u5408\u6210",
        usedShots: (shotIds) => `\u4f7f\u7528\u955c\u5934\uff1a${shotIds.join("\u3001")}`,
        downloadEpisode: (episode) => `\u4e0b\u8f7d\u7b2c ${episode} \u96c6`,
      },
      confirmation: {
        eyebrow: "\u5236\u4f5c\u4e0e\u8ba1\u8d39\u8fb9\u754c",
        remakeEyebrow: "\u65b0\u7684\u4ed8\u8d39\u5236\u4f5c",
        title: "\u786e\u8ba4\u5f00\u59cb\u5236\u4f5c",
        remakeTitle: "\u786e\u8ba4\u91cd\u65b0\u5236\u4f5c",
        remakeNotice: "\u73b0\u6709\u6210\u7247\u4f1a\u4fdd\u7559\u5230\u65b0\u7248\u672c\u5236\u4f5c\u6210\u529f\u3002",
        closeAction: "\u5173\u95ed\u786e\u8ba4",
        generateLabel: "\u751f\u6210\u955c\u5934",
        reuseLabel: "\u590d\u7528\u955c\u5934",
        estimateLabel: "\u9884\u8ba1\u8d39\u7528",
        balanceLabel: "\u53ef\u7528\u989d\u5ea6",
        outputLabel: "\u8f93\u51fa\u89c4\u683c",
        durationComparison: (actual, target) => `\u5b9e\u9645 ${actual} \u79d2 \u00b7 \u521b\u610f\u76ee\u6807 ${target} \u79d2`,
        scopeLabel: "\u5408\u6210\u8303\u56f4",
        episodeScope: (episode, title) => `\u7b2c ${episode} \u96c6${title ? ` \u00b7 ${title}` : ""}`,
        continuityLabel: "\u8fde\u7eed\u6027\u4e0e\u8d44\u6e90",
        charactersUnit: "\u4f4d\u4eba\u7269",
        locationsUnit: "\u4e2a\u573a\u666f",
        propsUnit: "\u4ef6\u9053\u5177",
        bindingsUnit: "\u5904\u7ed1\u5b9a",
        insufficientTitle: "\u989d\u5ea6\u4e0d\u8db3",
        insufficientBody: "\u670d\u52a1\u7aef\u9884\u4f30\u8d85\u8fc7\u5f53\u524d\u53ef\u7528\u989d\u5ea6\u3002",
        walletAction: "\u524d\u5f80\u94b1\u5305",
        cancelAction: "\u53d6\u6d88",
        confirmAction: "\u786e\u8ba4\u5e76\u5f00\u59cb\u5236\u4f5c",
        remakeConfirmAction: "\u786e\u8ba4\u91cd\u65b0\u5236\u4f5c",
        submittingAction: "\u6b63\u5728\u5f00\u59cb\u5236\u4f5c",
      },
      eyebrow: "\u5236\u4f5c\u4e0e\u6210\u7247",
      title: "\u6700\u7ec8\u6210\u7247",
      description: "\u5728\u8fd9\u91cc\u67e5\u770b\u6210\u7247\u3001\u5f53\u524d\u5236\u4f5c\u6b65\u9aa4\u4e0e\u7ee7\u7eed\u6240\u9700\u7684\u771f\u5b9e\u4fe1\u606f\u3002",
      evidenceLabel: "\u5236\u4f5c\u4f9d\u636e",
      statusLabels: {
        empty: "\u672a\u5f00\u59cb",
        ready: "\u5df2\u5c31\u7eea",
        running: "\u5236\u4f5c\u4e2d",
        failed: "\u9700\u5904\u7406",
        complete: "\u5df2\u5b8c\u6210",
      },
      outputPending: "\u5f85\u786e\u8ba4\u8f93\u51fa\u89c4\u683c",
      billingBoundary: "\u751f\u6210\u4e0e\u8ba1\u8d39\u7531\u670d\u52a1\u7aef\u5728\u5f00\u59cb\u5236\u4f5c\u524d\u786e\u8ba4\u3002",
      readinessTitle: "\u5408\u6210\u5c31\u7eea\u68c0\u67e5",
      readinessReady: "\u5df2\u9009\u955c\u5934\u5747\u6709\u53ef\u7528\u6210\u7247\uff0c\u6240\u9700\u9996\u5c3e\u63a7\u5236\u5e27\u4e5f\u5df2\u5b8c\u6210\u3002",
      readinessBlocked: "\u8bf7\u5148\u5b8c\u6210\u6216\u91cd\u8bd5\u4ee5\u4e0b\u9879\u76ee\uff0c\u518d\u63d0\u4ea4\u5408\u6210\u3002",
      retryTaskAction: "\u91cd\u8bd5\u5f53\u524d\u9879",
      retryingTaskAction: "\u6b63\u5728\u91cd\u8bd5...",
      renderAction: "\u751f\u6210\u6700\u7ec8\u6210\u7247",
      renderEpisodeAction: (episode) => `\u751f\u6210\u7b2c ${episode} \u96c6\u6210\u7247`,
      remakeEpisodeAction: (episode) => `\u91cd\u65b0\u5408\u6210\u7b2c ${episode} \u96c6`,
      renderingAction: "\u6b63\u5728\u751f\u6210\u6700\u7ec8\u6210\u7247",
      preparingAction: "\u6b63\u5728\u68c0\u67e5\u5236\u4f5c\u4fe1\u606f",
      remakeAction: "\u91cd\u65b0\u5236\u4f5c",
    },
    billing: {
      walletTitle: "\u94b1\u5305",
      walletNote: "\u4eba\u6c11\u5e01\u4f59\u989d\u548c\u9884\u6263\u91d1\u989d\u4ee5\u670d\u52a1\u5668\u72b6\u6001\u4e3a\u51c6\u3002",
      ordersTitle: "\u5145\u503c\u8ba2\u5355",
      ordersNote: "\u652f\u4ed8\u8bb0\u5f55\u4ee5\u670d\u52a1\u5668\u9a8c\u8bc1\u540e\u7684\u8ba2\u5355\u72b6\u6001\u4e3a\u51c6\u3002",
      balanceLabel: "\u4f59\u989d",
      heldLabel: "\u9884\u6263\u91d1\u989d",
      availableLabel: "\u53ef\u7528\u4f59\u989d",
      topupTitle: "\u4f59\u989d\u5145\u503c",
      walletEntriesTitle: "\u94b1\u5305\u660e\u7ec6",
      ordersLink: "\u5145\u503c\u8ba2\u5355",
      loading: "\u6b63\u5728\u52a0\u8f7d...",
      noWalletEntries: "\u6682\u65e0\u94b1\u5305\u660e\u7ec6\u3002",
      emptyOrders: "\u6682\u65e0\u5145\u503c\u8ba2\u5355\u3002",
      rechargeButton: "\u652f\u4ed8\u5b9d\u5145\u503c",
      creatingOrder: "\u6b63\u5728\u521b\u5efa\u8ba2\u5355",
      createOrderError: "\u65e0\u6cd5\u521b\u5efa\u652f\u4ed8\u8ba2\u5355\u3002",
      topupAmountLabel: "\u5145\u503c\u91d1\u989d\uff08\u5143\uff09",
      invalidTopupAmount: "\u8bf7\u8f93\u5165 0.01 \u5143\u81f3 100000.00 \u5143\u7684\u5145\u503c\u91d1\u989d\u3002",
      loadError: "\u65e0\u6cd5\u52a0\u8f7d\u8ba1\u8d39\u6570\u636e\u3002",
      paymentReturnTrusted: "\u4f59\u989d\u4ee5\u670d\u52a1\u5668\u8ba2\u5355\u72b6\u6001\u4e3a\u51c6",
      amountLabel: "\u91d1\u989d",
      maskedOrderLabel: "\u8ba2\u5355",
      createdLabel: "\u521b\u5efa\u65f6\u95f4",
      orderStatusLabels: {
        pending: "\u5f85\u652f\u4ed8",
        paid: "\u5df2\u652f\u4ed8",
        expired: "\u5df2\u8fc7\u671f",
        failed: "\u5931\u8d25",
      },
    },
  },
};

export function getStrings(locale: Locale = "en"): UIStrings {
  return STRINGS[locale];
}

export function detectLocale(language: string | null | undefined): Locale {
  if (typeof language === "string" && language.toLowerCase().startsWith("zh")) {
    return "zh";
  }
  return "en";
}
