import { useMemo, useState } from "react";
import { Film } from "lucide-react";
import {
  createShortDramaProject,
  renderProject,
  regenerateShot,
  saveGatewayKey,
} from "./api/client";
import { ChatPanel } from "./components/ChatPanel";
import { CharacterLibrary } from "./components/CharacterLibrary";
import { ConsistencyPanel } from "./components/ConsistencyPanel";
import { JobProgress } from "./components/JobProgress";
import { KeyGate } from "./components/KeyGate";
import { StoryboardWaterfall } from "./components/StoryboardWaterfall";
import type {
  ConsistencyReport,
  JobEvent,
  Project,
  SeriesBible,
  Shot,
  Storyboard,
} from "./domain/types";

const DEFAULT_BASE_URL = "https://api.0000238.xyz";
const DEFAULT_TEXT_MODEL = "gpt-5.5";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_VIDEO_MODEL = "omni_flash-10s";
const DEFAULT_PROMPT =
  "Make a 60-second urban reversal short drama: a woman discovers the truth behind her boss on a rainy night.";

export default function App() {
  const [textKey, setTextKey] = useState("");
  const [imageKey, setImageKey] = useState("");
  const [videoKey, setVideoKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [textModel, setTextModel] = useState(DEFAULT_TEXT_MODEL);
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [videoModel, setVideoModel] = useState(DEFAULT_VIDEO_MODEL);
  const [maskedKeys, setMaskedKeys] = useState<{ text: string; image: string; video: string } | null>(null);
  const [title, setTitle] = useState("Rain Alley");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [project, setProject] = useState<Project | null>(null);
  const [seriesBible, setSeriesBible] = useState<SeriesBible | null>(null);
  const [storyboard, setStoryboard] = useState<Storyboard | null>(null);
  const [consistencyReport, setConsistencyReport] = useState<ConsistencyReport | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [savingKey, setSavingKey] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [regeneratingShotId, setRegeneratingShotId] = useState<string | null>(null);
  const [finalPath, setFinalPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedCharacterNames = useMemo(() => {
    const characters = seriesBible?.characters ?? [];
    const ids = new Set(storyboard?.shots.flatMap((shot) => shot.characters) ?? []);
    return characters.filter((character) => ids.has(character.id)).map((character) => character.name);
  }, [seriesBible, storyboard]);

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
      setError("Enter text, image, and video API keys first.");
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
      setError(err instanceof Error ? err.message : "Unable to validate keys.");
    } finally {
      setSavingKey(false);
    }
  }

  async function handleCreateStoryboard() {
    if (!hasRequiredKeys()) {
      setError("Enter text, image, and video API keys before creating a storyboard.");
      return;
    }
    setCreating(true);
    setError(null);
    setEvents([]);
    try {
      const result = await createShortDramaProject({
        title: title.trim() || "Untitled Short Drama",
        prompt: prompt.trim(),
        ...providerCredentials(),
      });
      setProject(result.project);
      setSeriesBible(result.series_bible);
      setStoryboard(result.storyboard);
      setConsistencyReport(result.consistency_report);
      setFinalPath(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create project.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRegenerateShot(shot: Shot) {
    if (!project) {
      return;
    }
    setRegeneratingShotId(shot.id);
    setError(null);
    try {
      const result = await regenerateShot(project.id, shot.id, {
        video_key: videoKey.trim() || undefined,
        base_url: baseUrl.trim(),
        video_model: videoModel.trim() || DEFAULT_VIDEO_MODEL,
      });
      setStoryboard(result.storyboard);
      setConsistencyReport(result.consistency_report);
      setEvents((current) => [...current, result.event]);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to regenerate ${shot.id}.`);
    } finally {
      setRegeneratingShotId(null);
    }
  }

  async function handleRenderFinalVideo() {
    if (!project || !storyboard?.shots.length) {
      setError("Create a storyboard before rendering final video.");
      return;
    }
    if (!hasRequiredKeys()) {
      setError("Enter text, image, and video API keys before rendering final video.");
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
      setEvents((current) => [...current, result.event]);
      setFinalPath(result.final_path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to render final video.");
    } finally {
      setRendering(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="left-rail" aria-label="Project controls">
        <div className="brand-block">
          <span className="brand-mark">OM</span>
          <div>
            <p className="eyebrow">Short Drama Mode</p>
            <h1>OpenMontage Short Drama Workbench</h1>
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
          onSubmit={handleSaveKey}
        />
        <div className="rail-section">
          <p className="rail-label">Project</p>
          <div className="project-row">
            <span>{project?.title ?? "No project yet"}</span>
            <small>{project ? `${storyboard?.shots.length ?? 0} shots` : "Local draft"}</small>
          </div>
        </div>
        <div className="rail-section">
          <p className="rail-label">Active Cast</p>
          <div className="token-list">
            {selectedCharacterNames.length > 0 ? (
              selectedCharacterNames.map((name) => <span key={name}>{name}</span>)
            ) : (
              <span>Waiting</span>
            )}
          </div>
        </div>
      </aside>

      <section className="workspace" aria-label="Storyboard workspace">
        <ChatPanel
          creating={creating}
          prompt={prompt}
          title={title}
          onCreateStoryboard={handleCreateStoryboard}
          onPromptChange={setPrompt}
          onTitleChange={setTitle}
        />
        {error ? <div className="error-banner">{error}</div> : null}
        <StoryboardWaterfall
          regeneratingShotId={regeneratingShotId}
          shots={storyboard?.shots ?? []}
          onRegenerate={handleRegenerateShot}
        />
      </section>

      <aside className="right-panel" aria-label="Production review">
        <CharacterLibrary characters={seriesBible?.characters ?? []} />
        <ConsistencyPanel report={consistencyReport} />
        <JobProgress events={events} />
        {finalPath ? (
          <section className="review-section" aria-label="Final render">
            <div className="section-heading">
              <Film aria-hidden="true" size={18} />
              <h2>Final Video</h2>
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
          {rendering ? "Rendering video" : "Render final video"}
        </button>
      </aside>
    </main>
  );
}
