import type { CameraMovement, ShotSize, ShotStatus } from "./domain/types";

export type Locale = "en" | "zh";

export interface UIStrings {
  appFlow: {
    defaultTitle: string;
    defaultPrompt: string;
    untitledProjectTitle: string;
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
    importingAction: string;
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
    openProvider: string;
    createAction: string;
    creatingAction: string;
    createError: string;
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
  keyGate: {
    textKeyLabel: string;
    imageKeyLabel: string;
    videoKeyLabel: string;
    textModelLabel: string;
    imageModelLabel: string;
    videoModelLabel: string;
    baseUrlLabel: string;
    useKeysAction: string;
    updateKeysAction: string;
    checkingAction: string;
    keysNotSet: string;
    activeKeysStatus: (maskedKeys: { text: string; image: string; video: string }) => string;
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
    saveKeysRequiresAll: string;
    saveKeysFallback: string;
    createStoryboardRequiresKeys: string;
    createProjectFallback: string;
    renderRequiresStoryboard: string;
    renderFallback: string;
    saveShotFallback: string;
    optimizeShotFallback: string;
    createStoryboardRequiresPrompt: string;
    saveContinuityFallback: string;
    uploadReferenceFallback: string;
    localProjectSaveFallback: string;
    exportProjectFallback: string;
    importProjectFallback: string;
    downloadFinalVideoFallback: string;
    missingTextKeyForOptimize: string;
    missingVideoKeyForRender: string;
    missingVideoKeyForRegenerate: string;
    regenerateShotFallback: (shotId: string) => string;
  };
  shotEditor: {
    title: string;
    regionLabel: string;
    emptyState: string;
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
    noSavedReferenceAssetsYet: string;
    textToVideoMode: string;
    imageToVideoMode: (count: number) => string;
    optimizeAction: string;
    optimizingAction: string;
    undoOptimizationAction: string;
    saveAction: string;
    savingAction: string;
    regenerateAction: string;
    regeneratingAction: string;
    saveBeforeRegenerateHint: string;
  };
  storyboardPage: {
    shotListLabel: string;
    previewLabel: string;
    orderLabel: string;
    inspectorLabel: string;
    emptyShots: string;
    noSelectedShot: string;
    noPreviewMedia: string;
    shotTitle: (shotIndex: number) => string;
    selectShotLabel: (shotIndex: number) => string;
    selectOrderedShotLabel: (shotIndex: number) => string;
    previewMediaLabel: (shotIndex: number) => string;
    plannedShotCount: (count: number) => string;
    discardChangesConfirm: string;
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
    locked: string;
    characterKnowledge: string;
    relationshipChanges: string;
    activeForeshadowing: string;
    resolvedForeshadowing: string;
    propState: string;
    characterStatus: string;
    currentLocations: string;
  };
  resources: {
    title: string;
    emptyState: string;
    kindLabel: string;
    labelLabel: string;
    descriptionLabel: string;
    promptLabel: string;
    fileLabel: string;
    uploadAction: string;
    uploadingAction: string;
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
    appShell: {
      workbenchTitle: "OpenMontage Short Drama Workbench",
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
      importingAction: "Importing...",
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
      openProvider: "Open provider settings",
      createAction: "Plan storyboard with AI",
      creatingAction: "Planning storyboard...",
      createError: "Unable to plan the storyboard.",
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
    keyGate: {
      textKeyLabel: "Text API Key",
      imageKeyLabel: "Image API Key",
      videoKeyLabel: "Video API Key",
      textModelLabel: "Text Model",
      imageModelLabel: "Image Model",
      videoModelLabel: "Video Model",
      baseUrlLabel: "Gateway Base URL",
      useKeysAction: "Validate keys",
      updateKeysAction: "Revalidate keys",
      checkingAction: "Validating",
      keysNotSet: "Keys not validated",
      activeKeysStatus: (maskedKeys) => `Active T ${maskedKeys.text} / I ${maskedKeys.image} / V ${maskedKeys.video}`,
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
      saveKeysRequiresAll: "Enter text, image, and video API keys first.",
      saveKeysFallback: "Unable to validate keys.",
      createStoryboardRequiresKeys: "Enter text, image, and video API keys before creating a storyboard.",
      createProjectFallback: "Unable to create project.",
      renderRequiresStoryboard: "Create a storyboard before rendering final video.",
      renderFallback: "Unable to render final video.",
      saveShotFallback: "Unable to save shot.",
      optimizeShotFallback: "Unable to optimize shot prompt.",
      createStoryboardRequiresPrompt: "Enter a story prompt before creating the storyboard.",
      saveContinuityFallback: "Unable to save continuity settings.",
      uploadReferenceFallback: "Unable to upload reference image.",
      localProjectSaveFallback:
        "This project is open, but the browser could not save the local draft. Export the project before closing this tab.",
      exportProjectFallback: "Project export failed.",
      importProjectFallback: "Project import failed.",
      downloadFinalVideoFallback: "Final video download failed.",
      missingTextKeyForOptimize: "Enter a text API key before optimizing a shot prompt.",
      missingVideoKeyForRender: "Enter a video API key before rendering final video.",
      missingVideoKeyForRegenerate: "Enter a video API key before regenerating a shot.",
      regenerateShotFallback: (shotId: string) => `Unable to regenerate ${shotId}.`,
    },
    shotEditor: {
      title: "Shot Editor",
      regionLabel: "Shot editor",
      emptyState: "Create a storyboard to edit shot metadata.",
      promptLabel: "Shot prompt",
      locationLabel: "Location",
      charactersLabel: "Characters",
      propsLabel: "Props",
      intentLabel: "Shot intent",
      shotSizeLabel: "Shot size",
      cameraMovementLabel: "Camera movement",
      lensLabel: "Lens",
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
      noSavedReferenceAssetsYet: "No saved reference assets yet.",
      textToVideoMode: "Text-to-video: no saved reference image selected",
      imageToVideoMode: (count) => `Image-to-video: ${count} reference image${count === 1 ? "" : "s"} selected`,
      optimizeAction: "AI optimize prompt",
      optimizingAction: "Optimizing prompt",
      undoOptimizationAction: "Undo optimization",
      saveAction: "Save changes",
      savingAction: "Saving changes",
      regenerateAction: "Regenerate",
      regeneratingAction: "Regenerating",
      saveBeforeRegenerateHint: "Save changes first",
    },
    storyboardPage: {
      shotListLabel: "Shot list",
      previewLabel: "Shot preview",
      orderLabel: "Shot order",
      inspectorLabel: "Shot inspector",
      emptyShots: "No shots generated.",
      noSelectedShot: "Select or create a shot to preview it.",
      noPreviewMedia: "No preview media is available for this shot yet.",
      shotTitle: (shotIndex: number) => `Shot ${shotIndex}`,
      selectShotLabel: (shotIndex: number) => `Select shot ${shotIndex}`,
      selectOrderedShotLabel: (shotIndex: number) => `Select shot ${shotIndex} in order`,
      previewMediaLabel: (shotIndex: number) => `Shot ${shotIndex} preview media`,
      plannedShotCount: (count: number) => `AI planned ${count} shots for you`,
      discardChangesConfirm: "This shot has unsaved changes. Discard them?",
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
      },
    },
    continuity: {
      ariaLabel: "Continuity workbench",
      seriesTitle: "Series Bible",
      episodesTitle: "Episode Settings",
      storyStateTitle: "Story State",
      worldview: "Worldview",
      mainArc: "Main arc",
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
      locked: "Locked",
      characterKnowledge: "Character knowledge",
      relationshipChanges: "Relationship changes",
      activeForeshadowing: "Active foreshadowing",
      resolvedForeshadowing: "Resolved foreshadowing",
      propState: "Prop state",
      characterStatus: "Character status",
      currentLocations: "Current locations",
    },
    resources: {
      title: "Resource Library",
      emptyState: "No saved resources yet.",
      kindLabel: "Resource type",
      labelLabel: "Name",
      descriptionLabel: "Description",
      promptLabel: "Prompt",
      fileLabel: "Reference image",
      uploadAction: "Upload reference",
      uploadingAction: "Uploading reference",
    },
  },
  zh: {
    appFlow: {
      defaultTitle: "\u96e8\u5df7",
      defaultPrompt:
        "\u521b\u4f5c\u4e00\u4e2a 60 \u79d2\u7684\u90fd\u5e02\u53cd\u8f6c\u77ed\u5267\uff1a\u96e8\u591c\u91cc\uff0c\u4e00\u540d\u5973\u4eba\u53d1\u73b0\u4e86\u8001\u677f\u80cc\u540e\u7684\u771f\u76f8\u3002",
      untitledProjectTitle: "\u672a\u547d\u540d\u77ed\u5267",
    },
    appShell: {
      workbenchTitle: "OpenMontage 短剧工作台",
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
      importingAction: "\u6b63\u5728\u5bfc\u5165...",
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
      openProvider: "\u6253\u5f00\u63a5\u53e3\u914d\u7f6e",
      createAction: "AI \u89c4\u5212\u5206\u955c",
      creatingAction: "\u6b63\u5728\u89c4\u5212\u5206\u955c...",
      createError: "\u65e0\u6cd5\u89c4\u5212\u5206\u955c\u3002",
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
    keyGate: {
      textKeyLabel: "Text API \u5bc6\u94a5",
      imageKeyLabel: "Image API \u5bc6\u94a5",
      videoKeyLabel: "Video API \u5bc6\u94a5",
      textModelLabel: "Text \u6a21\u578b",
      imageModelLabel: "Image \u6a21\u578b",
      videoModelLabel: "Video \u6a21\u578b",
      baseUrlLabel: "\u7f51\u5173 Base URL",
      useKeysAction: "\u9a8c\u8bc1\u5bc6\u94a5",
      updateKeysAction: "\u91cd\u65b0\u9a8c\u8bc1\u5bc6\u94a5",
      checkingAction: "\u6b63\u5728\u9a8c\u8bc1",
      keysNotSet: "\u5bc6\u94a5\u672a\u9a8c\u8bc1",
      activeKeysStatus: (maskedKeys) =>
        `\u5f53\u524d T ${maskedKeys.text} / I ${maskedKeys.image} / V ${maskedKeys.video}`,
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
      saveKeysRequiresAll: "\u8bf7\u5148\u8f93\u5165 text\u3001image \u548c video API key\u3002",
      saveKeysFallback: "\u65e0\u6cd5\u9a8c\u8bc1 key\u3002",
      createStoryboardRequiresKeys:
        "\u8bf7\u5148\u8f93\u5165 text\u3001image \u548c video API key\uff0c\u518d\u521b\u5efa\u6545\u4e8b\u677f\u3002",
      createProjectFallback: "\u65e0\u6cd5\u521b\u5efa\u9879\u76ee\u3002",
      renderRequiresStoryboard: "\u8bf7\u5148\u521b\u5efa\u6545\u4e8b\u677f\uff0c\u518d\u6e32\u67d3\u6700\u7ec8\u89c6\u9891\u3002",
      renderFallback: "\u65e0\u6cd5\u6e32\u67d3\u6700\u7ec8\u89c6\u9891\u3002",
      saveShotFallback: "\u65e0\u6cd5\u4fdd\u5b58\u955c\u5934\u3002",
      optimizeShotFallback: "\u65e0\u6cd5\u4f18\u5316\u955c\u5934\u63d0\u793a\u8bcd\u3002",
      createStoryboardRequiresPrompt: "\u8bf7\u5148\u8f93\u5165\u6545\u4e8b\u63d0\u793a\uff0c\u518d\u521b\u5efa\u6545\u4e8b\u677f\u3002",
      saveContinuityFallback: "\u65e0\u6cd5\u4fdd\u5b58\u8fde\u7eed\u6027\u8bbe\u5b9a\u3002",
      uploadReferenceFallback: "\u65e0\u6cd5\u4e0a\u4f20\u53c2\u8003\u56fe\u3002",
      localProjectSaveFallback:
        "\u9879\u76ee\u5df2\u6253\u5f00\uff0c\u4f46\u6d4f\u89c8\u5668\u65e0\u6cd5\u4fdd\u5b58\u672c\u5730\u8349\u7a3f\u3002\u5173\u95ed\u6b64\u6807\u7b7e\u9875\u524d\u8bf7\u5148\u5bfc\u51fa\u9879\u76ee\u3002",
      exportProjectFallback: "\u9879\u76ee\u5bfc\u51fa\u5931\u8d25\u3002",
      importProjectFallback: "\u9879\u76ee\u5bfc\u5165\u5931\u8d25\u3002",
      downloadFinalVideoFallback: "\u6700\u7ec8\u89c6\u9891\u4e0b\u8f7d\u5931\u8d25\u3002",
      missingTextKeyForOptimize:
        "\u8bf7\u5148\u8f93\u5165 text API key\uff0c\u518d\u4f18\u5316\u955c\u5934\u63d0\u793a\u8bcd\u3002",
      missingVideoKeyForRender:
        "\u8bf7\u5148\u8f93\u5165 video API key\uff0c\u518d\u6e32\u67d3\u6700\u7ec8\u89c6\u9891\u3002",
      missingVideoKeyForRegenerate:
        "\u8bf7\u5148\u8f93\u5165 video API key\uff0c\u518d\u91cd\u65b0\u751f\u6210\u955c\u5934\u3002",
      regenerateShotFallback: (shotId: string) =>
        `\u65e0\u6cd5\u91cd\u65b0\u751f\u6210\u955c\u5934 ${shotId}\u3002`,
    },
    shotEditor: {
      title: "\u955c\u5934\u7f16\u8f91",
      regionLabel: "\u955c\u5934\u7f16\u8f91",
      emptyState: "\u8bf7\u5148\u521b\u5efa\u6545\u4e8b\u677f\uff0c\u518d\u7f16\u8f91\u955c\u5934\u5143\u6570\u636e\u3002",
      promptLabel: "\u5206\u955c\u63d0\u793a\u8bcd",
      locationLabel: "\u573a\u666f",
      charactersLabel: "\u89d2\u8272",
      propsLabel: "\u9053\u5177",
      intentLabel: "\u955c\u5934\u610f\u56fe",
      shotSizeLabel: "\u666f\u522b",
      cameraMovementLabel: "\u8fd0\u955c\u65b9\u5f0f",
      lensLabel: "\u955c\u5934\u7126\u6bb5",
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
      noSavedReferenceAssetsYet: "\u5c1a\u672a\u4fdd\u5b58\u53c2\u8003\u8d44\u6e90\u3002",
      textToVideoMode: "\u6587\u751f\u89c6\u9891\uff1a\u5f53\u524d\u672a\u9009\u4e2d\u53c2\u8003\u56fe",
      imageToVideoMode: (count) => `\u56fe\u751f\u89c6\u9891\uff1a\u5df2\u9009 ${count} \u5f20\u53c2\u8003\u56fe`,
      optimizeAction: "AI \u4f18\u5316\u63d0\u793a\u8bcd",
      optimizingAction: "\u6b63\u5728\u4f18\u5316\u63d0\u793a\u8bcd",
      undoOptimizationAction: "\u64a4\u9500\u4f18\u5316",
      saveAction: "\u4fdd\u5b58\u4fee\u6539",
      savingAction: "\u6b63\u5728\u4fdd\u5b58\u4fee\u6539",
      regenerateAction: "\u91cd\u65b0\u751f\u6210",
      regeneratingAction: "\u6b63\u5728\u91cd\u65b0\u751f\u6210",
      saveBeforeRegenerateHint: "\u8bf7\u5148\u4fdd\u5b58\u4fee\u6539",
    },
    storyboardPage: {
      shotListLabel: "\u5206\u955c\u5217\u8868",
      previewLabel: "\u5206\u955c\u9884\u89c8",
      orderLabel: "\u5206\u955c\u987a\u5e8f",
      inspectorLabel: "\u5206\u955c\u68c0\u67e5\u5668",
      emptyShots: "\u5c1a\u672a\u751f\u6210\u5206\u955c\u3002",
      noSelectedShot: "\u8bf7\u9009\u62e9\u6216\u521b\u5efa\u5206\u955c\u4ee5\u8fdb\u884c\u9884\u89c8\u3002",
      noPreviewMedia: "\u5f53\u524d\u5206\u955c\u5c1a\u65e0\u9884\u89c8\u5a92\u4f53",
      shotTitle: (shotIndex: number) => `\u5206\u955c ${shotIndex}`,
      selectShotLabel: (shotIndex: number) => `\u9009\u62e9\u5206\u955c ${shotIndex}`,
      selectOrderedShotLabel: (shotIndex: number) => `\u5728\u987a\u5e8f\u4e2d\u9009\u62e9\u5206\u955c ${shotIndex}`,
      previewMediaLabel: (shotIndex: number) => `\u5206\u955c ${shotIndex} \u9884\u89c8\u5a92\u4f53`,
      plannedShotCount: (count: number) => `AI \u5df2\u4e3a\u4f60\u89c4\u5212 ${count} \u4e2a\u5206\u955c`,
      discardChangesConfirm: "\u5f53\u524d\u5206\u955c\u6709\u672a\u4fdd\u5b58\u4fee\u6539\uff0c\u786e\u5b9a\u653e\u5f03\u5417\uff1f",
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
      },
    },
    continuity: {
      ariaLabel: "\u8fde\u7eed\u6027\u5de5\u4f5c\u53f0",
      seriesTitle: "\u5168\u96c6\u8bbe\u5b9a",
      episodesTitle: "\u5206\u96c6\u8bbe\u5b9a",
      storyStateTitle: "\u6545\u4e8b\u72b6\u6001",
      worldview: "\u4e16\u754c\u89c2",
      mainArc: "\u4e3b\u7ebf",
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
      locked: "\u9501\u5b9a",
      characterKnowledge: "\u89d2\u8272\u8ba4\u77e5",
      relationshipChanges: "\u5173\u7cfb\u53d8\u5316",
      activeForeshadowing: "\u8fdb\u884c\u4e2d\u4f0f\u7b14",
      resolvedForeshadowing: "\u5df2\u56de\u6536\u4f0f\u7b14",
      propState: "\u9053\u5177\u72b6\u6001",
      characterStatus: "\u89d2\u8272\u72b6\u6001",
      currentLocations: "\u5f53\u524d\u4f4d\u7f6e",
    },
    resources: {
      title: "\u8d44\u6e90\u5e93",
      emptyState: "\u5c1a\u672a\u4fdd\u5b58\u8d44\u6e90\u3002",
      kindLabel: "\u8d44\u6e90\u7c7b\u578b",
      labelLabel: "\u540d\u79f0",
      descriptionLabel: "\u63cf\u8ff0",
      promptLabel: "\u63d0\u793a\u8bcd",
      fileLabel: "\u53c2\u8003\u56fe",
      uploadAction: "\u4e0a\u4f20\u53c2\u8003",
      uploadingAction: "\u6b63\u5728\u4e0a\u4f20\u53c2\u8003",
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
