import { useEffect, useMemo, useState } from "react";
import { Film } from "lucide-react";
import {
  createShortDramaProject,
  renderProject,
  regenerateShot,
  saveGatewayKey,
  saveShot,
  subscribeProjectEvents,
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
  ConsistencyReport,
  JobEvent,
  Project,
  SeriesBible,
  Shot,
  ShotSaveRequest,
  Storyboard,
} from "./domain/types";

const DEFAULT_BASE_URL = "https://api.0000238.xyz";
const DEFAULT_TEXT_MODEL = "gpt-5.5";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_VIDEO_MODEL = "omni_flash-10s";

function appendUniqueEvent(current: JobEvent[], event: JobEvent) {
  if (current.some((existing) => existing.id === event.id)) {
    return current;
  }
  return [...current, event];
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
  const [title, setTitle] = useState(strings.appFlow.defaultTitle);
  const [prompt, setPrompt] = useState(strings.appFlow.defaultPrompt);
  const [project, setProject] = useState<Project | null>(null);
  const [seriesBible, setSeriesBible] = useState<SeriesBible | null>(null);
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [consistencyReport, setConsistencyReport] = useState<ConsistencyReport | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [savingKey, setSavingKey] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [savingShotId, setSavingShotId] = useState<string | null>(null);
  const [regeneratingShotId, setRegeneratingShotId] = useState<string | null>(null);
  const [finalPath, setFinalPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedCharacterNames = useMemo(() => {
    const characters = seriesBible?.characters ?? [];
    const ids = new Set(storyboard?.shots.flatMap((shot) => shot.characters) ?? []);
    return characters.filter((character) => ids.has(character.id)).map((character) => character.name);
  }, [seriesBible, storyboard]);

  const selectedShot = useMemo(() => storyboard?.shots[0] ?? null, [storyboard]);

  useEffect(() => {
    if (!project?.id) {
      return;
    }

    return subscribeProjectEvents(project.id, (event) => {
      setEvents((current) => appendUniqueEvent(current, event));
    });
  }, [project?.id]);

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
    setCreating(true);
    setError(null);
    setEvents([]);
    try {
      const result = await createShortDramaProject({
        title: title.trim() || strings.appFlow.untitledProjectTitle,
        prompt: prompt.trim(),
        ...providerCredentials(),
      });
      setProject(result.project);
      setSeriesBible(result.series_bible);
      setStoryboard(result.storyboard);
      setConsistencyReport(result.consistency_report);
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
    } finally {
      setSavingShotId(null);
    }
  }

  async function handleRegenerateShot(shot: Shot) {
    if (!project) {
      return;
    }
    if (!videoKey.trim()) {
      setError(strings.errors.regenerateRequiresVideoKey);
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
    if (!hasRequiredKeys()) {
      setError(strings.errors.renderRequiresKeys);
      return;
    }
    setRendering(true);
    setError(null);
    setFinalPath(null);
    try {
      const result = await renderProject(project.id, {
        ...providerCredentials(),
        render_runtime: "ffmpeg",
      });
      setStoryboard(result.storyboard);
      setConsistencyReport(result.consistency_report);
      setEvents((current) => appendUniqueEvent(current, result.event));
      setFinalPath(result.final_path);
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
        <ChatPanel
          creating={creating}
          projectTitlePlaceholder={strings.appFlow.defaultTitle}
          prompt={prompt}
          strings={strings.chatPanel}
          title={title}
          onCreateStoryboard={handleCreateStoryboard}
          onPromptChange={setPrompt}
          onTitleChange={setTitle}
        />
        {error ? <div className="error-banner">{error}</div> : null}
        <ShotEditor
          shot={selectedShot}
          saving={savingShotId === selectedShot?.id}
          strings={strings.shotEditor}
          onSaveShot={handleSaveShot}
        />
        <StoryboardWaterfall
          regeneratingShotId={regeneratingShotId}
          shots={storyboard?.shots ?? []}
          strings={strings.storyboardWaterfall}
          onRegenerate={handleRegenerateShot}
        />
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
