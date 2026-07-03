import type { ShotStatus } from "./domain/types";

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
    shotCountLabel: (count: number) => string;
    localDraftLabel: string;
    activeCastLabel: string;
    waitingLabel: string;
    finalRenderLabel: string;
      finalVideoTitle: string;
      renderFinalVideoAction: string;
      renderingVideoAction: string;
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
    saveAction: string;
    savingAction: string;
  };
  storyboardWaterfall: {
    regionLabel: string;
    title: string;
    emptyState: string;
    noLocationFallback: string;
    scoreLabel: (score: number) => string;
    versionLabel: (version: number) => string;
    regenerateShotLabel: (shotIndex: number) => string;
    statusLabels: Record<ShotStatus, string>;
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
      shotCountLabel: (count: number) => `${count} shots`,
      localDraftLabel: "Local draft",
      activeCastLabel: "Active Cast",
      waitingLabel: "Waiting",
      finalRenderLabel: "Final render",
      finalVideoTitle: "Final Video",
      renderFinalVideoAction: "Render final video",
      renderingVideoAction: "Rendering video",
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
      saveAction: "Save shot",
      savingAction: "Saving shot",
    },
    storyboardWaterfall: {
      regionLabel: "Storyboard waterfall",
      title: "Storyboard Waterfall",
      emptyState: "No shots generated.",
      noLocationFallback: "No location",
      scoreLabel: (score: number) => `Score ${score}`,
      versionLabel: (version: number) => `Version ${version}`,
      regenerateShotLabel: (shotIndex: number) => `Regenerate shot ${shotIndex}`,
      statusLabels: {
        draft: "draft",
        ready: "ready",
        generating: "generating",
        complete: "complete",
        failed: "failed",
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
    appShell: {
      workbenchTitle: "OpenMontage 短剧工作台",
      projectControlsLabel: "\u9879\u76ee\u63a7\u5236",
      workspaceLabel: "\u5206\u955c\u5de5\u4f5c\u533a",
      productionReviewLabel: "\u5236\u4f5c\u590d\u6838",
      shortDramaMode: "\u77ed\u5267\u6a21\u5f0f",
      projectLabel: "\u9879\u76ee",
      noProjectYet: "\u5c1a\u672a\u521b\u5efa\u9879\u76ee",
      shotCountLabel: (count: number) => `${count} \u4e2a\u955c\u5934`,
      localDraftLabel: "\u672c\u5730\u8349\u7a3f",
      activeCastLabel: "\u5f53\u524d\u89d2\u8272",
      waitingLabel: "\u7b49\u5f85\u4e2d",
      finalRenderLabel: "\u6700\u7ec8\u6e32\u67d3",
      finalVideoTitle: "\u6700\u7ec8\u89c6\u9891",
      renderFinalVideoAction: "\u6e32\u67d3\u6700\u7ec8\u89c6\u9891",
      renderingVideoAction: "\u6b63\u5728\u6e32\u67d3\u89c6\u9891",
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
      promptLabel: "\u955c\u5934\u63d0\u793a\u8bcd",
      locationLabel: "\u573a\u666f",
      charactersLabel: "\u89d2\u8272",
      propsLabel: "\u9053\u5177",
      intentLabel: "\u955c\u5934\u610f\u56fe",
      saveAction: "\u4fdd\u5b58\u955c\u5934",
      savingAction: "\u6b63\u5728\u4fdd\u5b58\u955c\u5934",
    },
    storyboardWaterfall: {
      regionLabel: "\u5206\u955c\u7011\u5e03",
      title: "\u5206\u955c\u7011\u5e03",
      emptyState: "\u5c1a\u672a\u751f\u6210\u955c\u5934\u3002",
      noLocationFallback: "\u672a\u8bbe\u7f6e\u573a\u666f",
      scoreLabel: (score: number) => `\u5206\u6570 ${score}`,
      versionLabel: (version: number) => `\u7248\u672c ${version}`,
      regenerateShotLabel: (shotIndex: number) => `\u91cd\u65b0\u751f\u6210\u955c\u5934 ${shotIndex}`,
      statusLabels: {
        draft: "\u8349\u7a3f",
        ready: "\u5c31\u7eea",
        generating: "\u751f\u6210\u4e2d",
        complete: "\u5df2\u5b8c\u6210",
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
