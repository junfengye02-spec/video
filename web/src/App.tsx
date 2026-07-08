import { useEffect, useMemo, useState } from "react";
import { Boxes, BookOpen, Clapperboard, Film, ListTree, Upload, Workflow } from "lucide-react";
import {
  createDraftProject,
  createShortDramaProject,
  loadLatestProject,
  loadProject,
  mediaUrl,
  optimizePrompt,
  renderProject,
  regenerateShot,
  saveContinuityPlan,
  saveGatewayKey,
  saveShot,
  subscribeProjectEvents,
  uploadReferenceImage,
} from "./api/client";
import { ChatPanel } from "./components/ChatPanel";
import { CharacterLibrary } from "./components/CharacterLibrary";
import { ConsistencyPanel } from "./components/ConsistencyPanel";
import { JobProgress } from "./components/JobProgress";
import { KeyGate } from "./components/KeyGate";
import { ShotEditor } from "./components/ShotEditor";
import { StoryboardWaterfall } from "./components/StoryboardWaterfall";
import { detectLocale, getStrings } from "./i18n";
import type {
  AssetRecord,
  ConsistencyReport,
  ContinuityPlan,
  EpisodeOutlineItem,
  JobEvent,
  PromptOptimizeResponse,
  Project,
  ProjectType,
  ReferenceImageUploadRequest,
  SeriesBible,
  Shot,
  ShotSaveRequest,
  Storyboard,
} from "./domain/types";

const DEFAULT_BASE_URL = "https://api.0000238.xyz";
const DEFAULT_TEXT_MODEL = "gpt-5.5";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_VIDEO_MODEL = "omni_flash-10s";

type StudioView = "storyboard" | "series" | "episodes" | "resources" | "production";

const STUDIO_VIEWS: Array<{
  id: StudioView;
  icon: typeof Clapperboard;
  labelKey: keyof ReturnType<typeof getStrings>["nav"];
  enabledFor: ProjectType[];
}> = [
  { id: "storyboard", icon: Clapperboard, labelKey: "storyboard", enabledFor: ["single_video", "mini_series", "long_series"] },
  { id: "series", icon: BookOpen, labelKey: "series", enabledFor: ["mini_series", "long_series"] },
  { id: "episodes", icon: ListTree, labelKey: "episodes", enabledFor: ["mini_series", "long_series"] },
  { id: "resources", icon: Boxes, labelKey: "resources", enabledFor: ["single_video", "mini_series", "long_series"] },
  { id: "production", icon: Workflow, labelKey: "production", enabledFor: ["single_video", "mini_series", "long_series"] },
];

function emptyContinuityPlan(projectType: ProjectType): ContinuityPlan {
  return {
    project_type: projectType,
    active_episode_number: projectType === "single_video" ? null : 1,
    series_bible: {
      worldview: "",
      main_arc: "",
      style_lock: "",
      visual_rules: "",
      taboos: [],
      locations: [],
      props: [],
      relationship_map: [],
    },
    episodes: [],
    story_state: {
      character_knowledge: [],
      relationship_changes: [],
      active_foreshadowing: [],
      resolved_foreshadowing: [],
      prop_state: [],
      character_status: [],
      current_locations: [],
    },
  };
}

function appendUniqueEvent(current: JobEvent[], event: JobEvent) {
  if (current.some((existing) => existing.id === event.id)) {
    return current;
  }
  return [...current, event];
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinLines(value: string[]): string {
  return value.join("\n");
}

function createEpisode(index: number): EpisodeOutlineItem {
  return {
    episode_number: index,
    title: "",
    goal: "",
    conflict: "",
    twist: "",
    cliffhanger: "",
    inherited_state: [],
    locked: false,
  };
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

function decorateAssetMedia(asset: AssetRecord, projectId: string | null | undefined): AssetRecord {
  const mediaUrls = uniqueValues(
    [...(asset.media_urls ?? []), ...(asset.reference_images ?? [])]
      .map((path) => mediaUrl(path, projectId))
      .filter((url): url is string => Boolean(url)),
  );
  return {
    ...asset,
    media_urls: mediaUrls,
  };
}

export default function App() {
  const strings = useMemo(() => getStrings(detectLocale(globalThis.navigator?.language)), []);
  const [textKey, setTextKey] = useState("");
  const [imageKey, setImageKey] = useState("");
  const [videoKey, setVideoKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [textModel, setTextModel] = useState(DEFAULT_TEXT_MODEL);
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [videoModel, setVideoModel] = useState(DEFAULT_VIDEO_MODEL);
  const [maskedKeys, setMaskedKeys] = useState<{ text: string; image: string; video: string } | null>(null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [projectType, setProjectType] = useState<ProjectType>("single_video");
  const [project, setProject] = useState<Project | null>(null);
  const [seriesBible, setSeriesBible] = useState<SeriesBible | null>(null);
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [continuityPlan, setContinuityPlan] = useState<ContinuityPlan>(() => emptyContinuityPlan("single_video"));
  const [consistencyReport, setConsistencyReport] = useState<ConsistencyReport | null>(null);
  const [workflowArtifacts, setWorkflowArtifacts] = useState<Array<{ name: string; path: string; exists: boolean }>>([]);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [savingKey, setSavingKey] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [savingContinuity, setSavingContinuity] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);
  const [optimizingShotId, setOptimizingShotId] = useState<string | null>(null);
  const [savingShotId, setSavingShotId] = useState<string | null>(null);
  const [regeneratingShotId, setRegeneratingShotId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<StudioView>("storyboard");
  const [finalPath, setFinalPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedCharacterNames = useMemo(() => {
    const characters = seriesBible?.characters ?? [];
    const ids = new Set(storyboard?.shots.flatMap((shot) => shot.characters) ?? []);
    return characters.filter((character) => ids.has(character.id)).map((character) => character.name);
  }, [seriesBible, storyboard]);

  const selectedShot = useMemo(() => storyboard?.shots[0] ?? null, [storyboard]);
  const assets = useMemo(
    () => (seriesBible?.assets ?? []).map((asset) => decorateAssetMedia(asset, project?.id)),
    [project?.id, seriesBible],
  );
  const visibleStudioViews = useMemo(
    () => STUDIO_VIEWS.filter((view) => view.enabledFor.includes(projectType)),
    [projectType],
  );

  useEffect(() => {
    if (!project?.id) {
      return;
    }

    return subscribeProjectEvents(project.id, (event) => {
      setEvents((current) => appendUniqueEvent(current, event));
    });
  }, [project?.id]);

  useEffect(() => {
    if (!visibleStudioViews.some((view) => view.id === activeView)) {
      setActiveView("storyboard");
    }
  }, [activeView, visibleStudioViews]);

  useEffect(() => {
    let cancelled = false;

    async function resumeLatestProject() {
      try {
        const snapshot = await loadLatestProject();
        if (!cancelled) {
          applyProjectSnapshot(snapshot);
        }
      } catch {
        // Empty workbenches should stay on the local draft view.
      }
    }

    void resumeLatestProject();

    return () => {
      cancelled = true;
    };
  }, []);

  function providerCredentials() {
    return {
      text_key: textKey.trim(),
      image_key: imageKey.trim(),
      video_key: videoKey.trim(),
      base_url: baseUrl.trim(),
      text_model: textModel.trim() || DEFAULT_TEXT_MODEL,
      image_model: imageModel.trim() || DEFAULT_IMAGE_MODEL,
      video_model: videoModel.trim() || DEFAULT_VIDEO_MODEL,
    };
  }

  function hasRequiredKeys() {
    return Boolean(textKey.trim() && imageKey.trim() && videoKey.trim());
  }

  function applyProjectSnapshot(snapshot: Awaited<ReturnType<typeof loadProject>>) {
    const nextProjectType = snapshot.project.project_type ?? snapshot.continuity_plan?.project_type ?? projectType;
    setProject(snapshot.project);
    setProjectType(nextProjectType);
    setSeriesBible(snapshot.series_bible);
    setStoryboard(snapshot.storyboard);
    setContinuityPlan(snapshot.continuity_plan ?? emptyContinuityPlan(nextProjectType));
    setConsistencyReport(snapshot.consistency_report);
    setWorkflowArtifacts(snapshot.workflow_artifacts ?? []);
    setFinalPath(snapshot.final_path ?? null);
  }

  async function refreshProjectState(projectId: string) {
    const snapshot = await loadProject(projectId);
    applyProjectSnapshot(snapshot);
  }

  function handleProjectTypeChange(nextProjectType: ProjectType) {
    if (project) {
      setError(strings.projectType.lockedHint);
      return;
    }
    setProjectType(nextProjectType);
    if (nextProjectType === "single_video" && (activeView === "series" || activeView === "episodes")) {
      setActiveView("storyboard");
    }
    setContinuityPlan((current) => ({
      ...current,
      project_type: nextProjectType,
      active_episode_number: nextProjectType === "single_video" ? null : (current.active_episode_number ?? 1),
    }));
  }

  async function handleSaveKey() {
    if (!hasRequiredKeys()) {
      setError(strings.errors.saveKeysRequiresAll);
      return;
    }
    setSavingKey(true);
    setError(null);
    try {
      const session = await saveGatewayKey(providerCredentials());
      setMaskedKeys(session.masked_keys);
      setBaseUrl(session.base_url);
      setTextModel(session.models.text);
      setImageModel(session.models.image);
      setVideoModel(session.models.video);
    } catch (err) {
      setError(err instanceof Error ? err.message : strings.errors.saveKeysFallback);
    } finally {
      setSavingKey(false);
    }
  }

  async function handleCreateStoryboard() {
    if (!hasRequiredKeys()) {
      setError(strings.errors.createStoryboardRequiresKeys);
      return;
    }
    if (!prompt.trim()) {
      setError(strings.errors.createStoryboardRequiresPrompt);
      return;
    }
    setCreating(true);
    setError(null);
    setEvents([]);
    try {
      const result = await createShortDramaProject({
        title: title.trim() || strings.appFlow.untitledProjectTitle,
        prompt: prompt.trim(),
        project_type: projectType,
        ...providerCredentials(),
      });
      applyProjectSnapshot(result);
      setFinalPath(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : strings.errors.createProjectFallback);
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveShot(shotId: string, payload: ShotSaveRequest) {
    if (!project) {
      return;
    }
    setSavingShotId(shotId);
    setError(null);
    try {
      const result = await saveShot(project.id, shotId, payload);
      setStoryboard(result.storyboard);
      setConsistencyReport(result.consistency_report);
      setEvents((current) => appendUniqueEvent(current, result.event));
      setFinalPath(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : strings.errors.saveShotFallback);
      throw err instanceof Error ? err : new Error(strings.errors.saveShotFallback);
    } finally {
      setSavingShotId(null);
    }
  }

  async function ensureProjectForResources(): Promise<Project> {
    if (project) {
      return project;
    }
    setCreating(true);
    try {
      const snapshot = await createDraftProject({
        title: title.trim() || strings.appFlow.untitledProjectTitle,
        project_type: projectType,
      });
      applyProjectSnapshot(snapshot);
      return snapshot.project;
    } finally {
      setCreating(false);
    }
  }

  async function handleSaveContinuity() {
    if (!project) {
      setError(strings.errors.createProjectFallback);
      return;
    }
    setSavingContinuity(true);
    setError(null);
    try {
      const result = await saveContinuityPlan(project.id, continuityPlan);
      setProject(result.project);
      setProjectType(result.continuity_plan.project_type);
      setContinuityPlan(result.continuity_plan);
      await refreshProjectState(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : strings.errors.saveContinuityFallback);
    } finally {
      setSavingContinuity(false);
    }
  }

  async function handleUploadReferenceImage(payload: ReferenceImageUploadRequest) {
    setUploadingReference(true);
    setError(null);
    try {
      const uploadProject = await ensureProjectForResources();
      const result = await uploadReferenceImage(uploadProject.id, payload);
      const uploadedAsset = decorateAssetMedia(
        {
          ...result.asset,
          media_urls: [...(result.asset.media_urls ?? []), result.media.media_url],
        },
        uploadProject.id,
      );
      setSeriesBible((current) =>
        current
          ? {
              ...current,
              assets: [...(current.assets ?? []), uploadedAsset],
            }
          : current,
      );
      await refreshProjectState(uploadProject.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : strings.errors.uploadReferenceFallback);
    } finally {
      setUploadingReference(false);
    }
  }

  async function handleOptimizeShotPrompt(shot: Shot, sourceText: string): Promise<PromptOptimizeResponse> {
    if (!project) {
      throw new Error(strings.errors.optimizeShotFallback);
    }
    if (!textKey.trim()) {
      const message = strings.errors.missingTextKeyForOptimize;
      setError(message);
      throw new Error(message);
    }
    setOptimizingShotId(shot.id);
    setError(null);
    try {
      return await optimizePrompt(project.id, {
        target: "shot",
        target_id: shot.id,
        source_text: sourceText,
        text_key: textKey.trim(),
        base_url: baseUrl.trim() || DEFAULT_BASE_URL,
        text_model: textModel.trim() || DEFAULT_TEXT_MODEL,
        mode: "shot_json",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : strings.errors.optimizeShotFallback;
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setOptimizingShotId(null);
    }
  }

  async function handleRegenerateShot(shot: Shot) {
    if (!project) {
      return;
    }
    if (!videoKey.trim()) {
      setError(strings.errors.missingVideoKeyForRegenerate);
      return;
    }
    setRegeneratingShotId(shot.id);
    setError(null);
    try {
      const result = await regenerateShot(project.id, shot.id, {
        video_key: videoKey.trim(),
        base_url: baseUrl.trim(),
        video_model: videoModel.trim() || DEFAULT_VIDEO_MODEL,
      });
      setStoryboard(result.storyboard);
      setConsistencyReport(result.consistency_report);
      setEvents((current) => appendUniqueEvent(current, result.event));
    } catch (err) {
      setError(err instanceof Error ? err.message : strings.errors.regenerateShotFallback(shot.id));
    } finally {
      setRegeneratingShotId(null);
    }
  }

  async function handleRenderFinalVideo() {
    if (!project || !storyboard?.shots.length) {
      setError(strings.errors.renderRequiresStoryboard);
      return;
    }
    if (!videoKey.trim()) {
      setError(strings.errors.missingVideoKeyForRender);
      return;
    }
    setRendering(true);
    setError(null);
    setFinalPath(null);
    try {
      const result = await renderProject(project.id, {
        video_key: videoKey.trim(),
        base_url: baseUrl.trim(),
        video_model: videoModel.trim() || DEFAULT_VIDEO_MODEL,
        render_runtime: "ffmpeg",
      });
      setEvents((current) => appendUniqueEvent(current, result.event));
      setProject(result.project);
      setStoryboard(result.storyboard);
      setConsistencyReport(result.consistency_report);
      setFinalPath(result.final_path ?? null);
      void refreshProjectState(project.id).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : strings.errors.renderFallback);
    } finally {
      setRendering(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="left-rail" aria-label={strings.appShell.projectControlsLabel}>
        <div className="brand-block">
          <span className="brand-mark">OM</span>
          <div>
            <p className="eyebrow">{strings.appShell.shortDramaMode}</p>
            <h1>{strings.appShell.workbenchTitle}</h1>
          </div>
        </div>
        <KeyGate
          baseUrl={baseUrl}
          textKey={textKey}
          imageKey={imageKey}
          videoKey={videoKey}
          textModel={textModel}
          imageModel={imageModel}
          videoModel={videoModel}
          maskedKeys={maskedKeys}
          saving={savingKey}
          onBaseUrlChange={setBaseUrl}
          onTextKeyChange={setTextKey}
          onImageKeyChange={setImageKey}
          onVideoKeyChange={setVideoKey}
          onTextModelChange={setTextModel}
          onImageModelChange={setImageModel}
          onVideoModelChange={setVideoModel}
          strings={strings.keyGate}
          onSubmit={handleSaveKey}
        />
        <div className="rail-section">
          <p className="rail-label">{strings.appShell.projectLabel}</p>
          <div className="project-row">
            <span>{project?.title ?? strings.appShell.noProjectYet}</span>
            <small>
              {project
                ? strings.appShell.shotCountLabel(storyboard?.shots.length ?? 0)
                : strings.appShell.localDraftLabel}
            </small>
          </div>
        </div>
        <div className="rail-section">
          <p className="rail-label">{strings.appShell.activeCastLabel}</p>
          <div className="token-list">
            {selectedCharacterNames.length > 0 ? (
              selectedCharacterNames.map((name) => <span key={name}>{name}</span>)
            ) : (
              <span>{strings.appShell.waitingLabel}</span>
            )}
          </div>
        </div>
      </aside>

      <section className="workspace" aria-label={strings.appShell.workspaceLabel}>
        <nav className="studio-nav" aria-label={strings.nav.ariaLabel} role="tablist">
          {visibleStudioViews.map(({ id, icon: Icon, labelKey }) => (
            <button
              key={id}
              className={`studio-nav-button${activeView === id ? " is-active" : ""}`}
              type="button"
              role="tab"
              aria-selected={activeView === id}
              onClick={() => setActiveView(id)}
            >
              <Icon aria-hidden="true" size={16} />
              {strings.nav[labelKey]}
            </button>
          ))}
        </nav>
        {error ? <div className="error-banner">{error}</div> : null}
        {activeView === "storyboard" ? (
          <>
            <ProjectTypeSelector
              disabled={Boolean(project)}
              strings={strings.projectType}
              value={projectType}
              onChange={handleProjectTypeChange}
            />
            <ChatPanel
              creating={creating}
              prompt={prompt}
              strings={strings.chatPanel}
              title={title}
              onCreateStoryboard={handleCreateStoryboard}
              onPromptChange={setPrompt}
              onTitleChange={setTitle}
            />
            <ShotEditor
              assets={assets}
              characters={seriesBible?.characters ?? []}
              optimizing={optimizingShotId === selectedShot?.id}
              regenerating={regeneratingShotId === selectedShot?.id}
              shot={selectedShot}
              saving={savingShotId === selectedShot?.id}
              strings={strings.shotEditor}
              onOptimizePrompt={handleOptimizeShotPrompt}
              onRegenerateShot={handleRegenerateShot}
              onSaveShot={handleSaveShot}
            />
            <StoryboardWaterfall
              regeneratingShotId={regeneratingShotId}
              shots={storyboard?.shots ?? []}
              strings={strings.storyboardWaterfall}
              onRegenerate={handleRegenerateShot}
            />
          </>
        ) : null}
        {activeView === "series" ? (
          <ContinuityEditor
            mode="series"
            plan={continuityPlan}
            saving={savingContinuity}
            strings={strings.continuity}
            onChange={setContinuityPlan}
            onSave={handleSaveContinuity}
          />
        ) : null}
        {activeView === "episodes" ? (
          <ContinuityEditor
            mode="episodes"
            plan={continuityPlan}
            saving={savingContinuity}
            strings={strings.continuity}
            onChange={setContinuityPlan}
            onSave={handleSaveContinuity}
          />
        ) : null}
        {activeView === "resources" ? (
          <ResourceLibrary
            assets={assets}
            uploading={uploadingReference}
            strings={strings.resources}
            onUploadReferenceImage={handleUploadReferenceImage}
          />
        ) : null}
        {activeView === "production" ? (
          <section className="storyboard-panel">
            <div className="section-heading">
              <Workflow aria-hidden="true" size={18} />
              <h2>{strings.nav.production}</h2>
            </div>
            <div className="workflow-list">
              {workflowArtifacts.length > 0 ? (
                workflowArtifacts.map((artifact) => (
                  <span key={artifact.name} className={artifact.exists ? "workflow-ok" : "workflow-missing"}>
                    {artifact.name}
                  </span>
                ))
              ) : (
                <p className="empty-state">{strings.storyboardWaterfall.emptyState}</p>
              )}
            </div>
          </section>
        ) : null}
      </section>

      <aside className="right-panel" aria-label={strings.appShell.productionReviewLabel}>
        <CharacterLibrary characters={seriesBible?.characters ?? []} />
        <ConsistencyPanel report={consistencyReport} />
        <JobProgress events={events} />
        {finalPath ? (
          <section className="review-section" aria-label={strings.appShell.finalRenderLabel}>
            <div className="section-heading">
              <Film aria-hidden="true" size={18} />
              <h2>{strings.appShell.finalVideoTitle}</h2>
            </div>
            <p className="final-path">{finalPath}</p>
          </section>
        ) : null}
        <button
          className="render-button"
          type="button"
          disabled={!project || !storyboard?.shots.length || rendering}
          onClick={handleRenderFinalVideo}
        >
          <Film aria-hidden="true" size={16} />
          {rendering ? strings.appShell.renderingVideoAction : strings.appShell.renderFinalVideoAction}
        </button>
      </aside>
    </main>
  );
}

function ProjectTypeSelector({
  disabled = false,
  strings,
  value,
  onChange,
}: {
  disabled?: boolean;
  strings: ReturnType<typeof getStrings>["projectType"];
  value: ProjectType;
  onChange: (value: ProjectType) => void;
}) {
  const options: Array<{ value: ProjectType; label: string }> = [
    { value: "single_video", label: strings.singleVideo },
    { value: "mini_series", label: strings.miniSeries },
    { value: "long_series", label: strings.longSeries },
  ];
  return (
    <fieldset className="project-type-selector" disabled={disabled}>
      <legend>{strings.label}</legend>
      <div className="segmented-control">
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name="project-type"
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      {disabled ? <p className="locked-hint">{strings.lockedHint}</p> : null}
    </fieldset>
  );
}

function ContinuityEditor({
  mode,
  plan,
  saving,
  strings,
  onChange,
  onSave,
}: {
  mode: "series" | "episodes";
  plan: ContinuityPlan;
  saving: boolean;
  strings: ReturnType<typeof getStrings>["continuity"];
  onChange: (plan: ContinuityPlan) => void;
  onSave: () => void;
}) {
  const updateSeriesBible = (field: keyof ContinuityPlan["series_bible"], value: string | string[]) => {
    onChange({ ...plan, series_bible: { ...plan.series_bible, [field]: value } });
  };

  const updateStoryState = (field: keyof ContinuityPlan["story_state"], value: string[]) => {
    onChange({ ...plan, story_state: { ...plan.story_state, [field]: value } });
  };

  const updateEpisode = (episodeNumber: number, updates: Partial<EpisodeOutlineItem>) => {
    onChange({
      ...plan,
      episodes: plan.episodes.map((episode) =>
        episode.episode_number === episodeNumber ? { ...episode, ...updates } : episode,
      ),
    });
  };

  const addEpisode = () => {
    const nextNumber = Math.max(0, ...plan.episodes.map((episode) => episode.episode_number)) + 1;
    onChange({
      ...plan,
      active_episode_number: plan.active_episode_number ?? nextNumber,
      episodes: [...plan.episodes, createEpisode(nextNumber)],
    });
  };

  return (
    <section className="storyboard-panel continuity-panel" aria-label={strings.ariaLabel}>
      <div className="section-heading">
        <BookOpen aria-hidden="true" size={18} />
        <h2>{mode === "series" ? strings.seriesTitle : strings.episodesTitle}</h2>
      </div>
      {mode === "series" ? (
        <>
          <div className="continuity-grid">
            <label>
              <span>{strings.worldview}</span>
              <textarea
                rows={3}
                value={plan.series_bible.worldview}
                onChange={(event) => updateSeriesBible("worldview", event.target.value)}
              />
            </label>
            <label>
              <span>{strings.mainArc}</span>
              <textarea
                rows={3}
                value={plan.series_bible.main_arc}
                onChange={(event) => updateSeriesBible("main_arc", event.target.value)}
              />
            </label>
            <label>
              <span>{strings.styleLock}</span>
              <textarea
                rows={3}
                value={plan.series_bible.style_lock}
                onChange={(event) => updateSeriesBible("style_lock", event.target.value)}
              />
            </label>
            <label>
              <span>{strings.visualRules}</span>
              <textarea
                rows={3}
                value={plan.series_bible.visual_rules}
                onChange={(event) => updateSeriesBible("visual_rules", event.target.value)}
              />
            </label>
            <label>
              <span>{strings.taboos}</span>
              <textarea
                rows={3}
                value={joinLines(plan.series_bible.taboos)}
                onChange={(event) => updateSeriesBible("taboos", splitLines(event.target.value))}
              />
            </label>
            <label>
              <span>{strings.locations}</span>
              <textarea
                rows={3}
                value={joinLines(plan.series_bible.locations)}
                onChange={(event) => updateSeriesBible("locations", splitLines(event.target.value))}
              />
            </label>
            <label>
              <span>{strings.props}</span>
              <textarea
                rows={3}
                value={joinLines(plan.series_bible.props)}
                onChange={(event) => updateSeriesBible("props", splitLines(event.target.value))}
              />
            </label>
            <label>
              <span>{strings.relationshipMap}</span>
              <textarea
                rows={3}
                value={joinLines(plan.series_bible.relationship_map)}
                onChange={(event) => updateSeriesBible("relationship_map", splitLines(event.target.value))}
              />
            </label>
          </div>
          <div className="continuity-subsection">
            <h3>{strings.storyStateTitle}</h3>
            <div className="continuity-grid">
              <label>
                <span>{strings.characterKnowledge}</span>
                <textarea
                  rows={3}
                  value={joinLines(plan.story_state.character_knowledge)}
                  onChange={(event) => updateStoryState("character_knowledge", splitLines(event.target.value))}
                />
              </label>
              <label>
                <span>{strings.relationshipChanges}</span>
                <textarea
                  rows={3}
                  value={joinLines(plan.story_state.relationship_changes)}
                  onChange={(event) => updateStoryState("relationship_changes", splitLines(event.target.value))}
                />
              </label>
              <label>
                <span>{strings.activeForeshadowing}</span>
                <textarea
                  rows={3}
                  value={joinLines(plan.story_state.active_foreshadowing)}
                  onChange={(event) => updateStoryState("active_foreshadowing", splitLines(event.target.value))}
                />
              </label>
              <label>
                <span>{strings.resolvedForeshadowing}</span>
                <textarea
                  rows={3}
                  value={joinLines(plan.story_state.resolved_foreshadowing)}
                  onChange={(event) => updateStoryState("resolved_foreshadowing", splitLines(event.target.value))}
                />
              </label>
              <label>
                <span>{strings.propState}</span>
                <textarea
                  rows={3}
                  value={joinLines(plan.story_state.prop_state)}
                  onChange={(event) => updateStoryState("prop_state", splitLines(event.target.value))}
                />
              </label>
              <label>
                <span>{strings.characterStatus}</span>
                <textarea
                  rows={3}
                  value={joinLines(plan.story_state.character_status)}
                  onChange={(event) => updateStoryState("character_status", splitLines(event.target.value))}
                />
              </label>
              <label>
                <span>{strings.currentLocations}</span>
                <textarea
                  rows={3}
                  value={joinLines(plan.story_state.current_locations)}
                  onChange={(event) => updateStoryState("current_locations", splitLines(event.target.value))}
                />
              </label>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="episode-actions">
            <p className="active-episode-summary">{strings.currentProductionEpisode(plan.active_episode_number)}</p>
            <button className="secondary-button" type="button" onClick={addEpisode}>
              {strings.addEpisode}
            </button>
          </div>
          <div className="episode-list">
            {plan.episodes.length > 0 ? (
              plan.episodes.map((episode) => (
                <article key={episode.episode_number} className="episode-row episode-editor">
                  <div className="episode-toolbar">
                    <strong>
                      {episode.episode_number}. {episode.title || strings.episodesTitle}
                    </strong>
                    {plan.active_episode_number === episode.episode_number ? (
                      <span className="status-pill">{strings.currentEpisodeBadge}</span>
                    ) : (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => onChange({ ...plan, active_episode_number: episode.episode_number })}
                      >
                        {strings.setCurrentEpisode(episode.episode_number)}
                      </button>
                    )}
                  </div>
                  <div className="continuity-grid">
                    <label>
                      <span>{strings.episodeTitle}</span>
                      <input
                        value={episode.title}
                        onChange={(event) => updateEpisode(episode.episode_number, { title: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{strings.goal}</span>
                      <textarea
                        rows={3}
                        value={episode.goal}
                        onChange={(event) => updateEpisode(episode.episode_number, { goal: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{strings.conflict}</span>
                      <textarea
                        rows={3}
                        value={episode.conflict}
                        onChange={(event) => updateEpisode(episode.episode_number, { conflict: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{strings.twist}</span>
                      <textarea
                        rows={3}
                        value={episode.twist}
                        onChange={(event) => updateEpisode(episode.episode_number, { twist: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{strings.cliffhanger}</span>
                      <textarea
                        rows={3}
                        value={episode.cliffhanger}
                        onChange={(event) => updateEpisode(episode.episode_number, { cliffhanger: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>{strings.inheritedState}</span>
                      <textarea
                        rows={3}
                        value={joinLines(episode.inherited_state)}
                        onChange={(event) =>
                          updateEpisode(episode.episode_number, { inherited_state: splitLines(event.target.value) })
                        }
                      />
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={episode.locked}
                        onChange={(event) => updateEpisode(episode.episode_number, { locked: event.target.checked })}
                      />
                      <span>{strings.locked}</span>
                    </label>
                  </div>
                </article>
              ))
            ) : (
              <p className="empty-state">{strings.episodesTitle}</p>
            )}
          </div>
        </>
      )}
      <button className="primary-button" type="button" disabled={saving} onClick={onSave}>
        {saving ? strings.saving : strings.save}
      </button>
    </section>
  );
}

function ResourceLibrary({
  assets,
  uploading,
  strings,
  onUploadReferenceImage,
}: {
  assets: AssetRecord[];
  uploading: boolean;
  strings: ReturnType<typeof getStrings>["resources"];
  onUploadReferenceImage: (payload: ReferenceImageUploadRequest) => void;
}) {
  const [kind, setKind] = useState<ReferenceImageUploadRequest["kind"]>("character");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [file, setFile] = useState<File | null>(null);

  return (
    <section className="storyboard-panel resource-library">
      <div className="section-heading">
        <Boxes aria-hidden="true" size={18} />
        <h2>{strings.title}</h2>
      </div>
      <form
        className="resource-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!file) {
            return;
          }
          onUploadReferenceImage({
            kind,
            label: label.trim() || file.name,
            description: description.trim(),
            prompt: prompt.trim(),
            file,
          });
        }}
      >
        <label>
          {strings.kindLabel}
          <select value={kind} onChange={(event) => setKind(event.target.value as ReferenceImageUploadRequest["kind"])}>
            <option value="character">character</option>
            <option value="scene">scene</option>
            <option value="prop">prop</option>
          </select>
        </label>
        <label>
          {strings.labelLabel}
          <input value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label>
          {strings.descriptionLabel}
          <input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label>
          {strings.promptLabel}
          <textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
        </label>
        <label>
          {strings.fileLabel}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <button className="primary-button" type="submit" disabled={uploading || !file}>
          <Upload aria-hidden="true" size={16} />
          {uploading ? strings.uploadingAction : strings.uploadAction}
        </button>
      </form>
      <div className="asset-list">
        {assets.length > 0 ? (
          assets.map((asset) => (
            <article className="asset-card" key={asset.id}>
              <strong>{asset.label}</strong>
              <small>{asset.kind}</small>
              {asset.media_urls?.[0] ? <img src={asset.media_urls[0]} alt={asset.label} /> : null}
            </article>
          ))
        ) : (
          <p className="empty-state">{strings.emptyState}</p>
        )}
      </div>
    </section>
  );
}
