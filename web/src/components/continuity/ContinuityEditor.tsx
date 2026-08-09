import { AlertTriangle, Check, ImageOff, UserRound } from "lucide-react";
import type {
  Character,
  ConsistencyReport,
  ContinuityPlan,
} from "../../domain/types";
import type { UIStrings } from "../../i18n";
import { GenerationModelPicker } from "../../features/generation/GenerationModelPicker";
import { SelectMenu } from "../../shared/ui";
import { EpisodePlanningEditor } from "./EpisodePlanningEditor";
import { LineListTextarea } from "./LineListTextarea";

export type ContinuityEditorStrings = Pick<
  UIStrings,
  "continuity" | "globalSettings" | "modelCatalog"
>;

export interface ContinuityEditorProps {
  plan: ContinuityPlan;
  resetVersion: number;
  strings: ContinuityEditorStrings;
  characters?: Character[];
  consistencyReport?: ConsistencyReport | null;
  onChange: (plan: ContinuityPlan) => void;
}

const EMPTY_SOUND = {
  narration: "",
  dialogue: "",
  ambience: "",
  music_direction: "",
  prompt: "",
  storyboard_prompt_integration: false,
};

const DEFAULT_GENERATION_PREFERENCES = {
  image_model: "gpt-image-2",
  video_model: "omni_flash-10s",
  image_size: "1024x1024",
  image_quality: "standard",
  aspect_ratio: "16:9",
};

export function ContinuityEditor({
  plan,
  resetVersion,
  strings,
  characters = [],
  consistencyReport = null,
  onChange,
}: ContinuityEditorProps) {
  const labels = strings.continuity;
  const groups = strings.globalSettings;
  const isSeries = plan.project_type !== "single_video";
  const sound = { ...EMPTY_SOUND, ...(plan.sound ?? {}) };
  const generationPreferences = {
    ...DEFAULT_GENERATION_PREFERENCES,
    ...(plan.generation_preferences ?? {}),
  };

  const updateSeriesBible = <K extends keyof ContinuityPlan["series_bible"]>(
    field: K,
    value: ContinuityPlan["series_bible"][K],
  ) => onChange({
    ...plan,
    series_bible: { ...plan.series_bible, [field]: value },
  });

  const updateStoryState = <K extends keyof ContinuityPlan["story_state"]>(
    field: K,
    value: ContinuityPlan["story_state"][K],
  ) => onChange({
    ...plan,
    story_state: { ...plan.story_state, [field]: value },
  });

  const updateSound = <K extends keyof typeof sound>(field: K, value: (typeof sound)[K]) => {
    onChange({ ...plan, sound: { ...sound, [field]: value } });
  };

  const updateGenerationPreference = <K extends keyof typeof generationPreferences>(
    field: K,
    value: (typeof generationPreferences)[K],
  ) => onChange({
    ...plan,
    generation_preferences: { ...generationPreferences, [field]: value },
  });

  return (
    <div className="continuity-panel" aria-label={labels.ariaLabel}>
      <section className="continuity-subsection" id="settings-worldview">
        <h2 id="settings-worldview-title" tabIndex={-1}>{groups.worldviewTitle}</h2>
        <h3>{groups.storyCoreTitle}</h3>
        <div className="continuity-grid">
          <label>
            <span>{labels.worldview}</span>
            <textarea rows={5} value={plan.series_bible.worldview} onChange={(event) => updateSeriesBible("worldview", event.target.value)} />
          </label>
          <label>
            <span>{labels.mainArc}</span>
            <textarea rows={5} value={plan.series_bible.main_arc} onChange={(event) => updateSeriesBible("main_arc", event.target.value)} />
          </label>
          {isSeries ? (
            <label className="is-wide">
              <span>{labels.seriesPrompt}</span>
              <textarea rows={5} value={plan.series_bible.series_prompt ?? ""} onChange={(event) => updateSeriesBible("series_prompt", event.target.value)} />
            </label>
          ) : null}
        </div>
        <h3>{groups.storyStateTitle}</h3>
        <div className="continuity-grid">
          <label><span>{labels.activeForeshadowing}</span><LineListTextarea resetVersion={resetVersion} value={plan.story_state.active_foreshadowing} onChange={(value) => updateStoryState("active_foreshadowing", value)} /></label>
          <label><span>{labels.resolvedForeshadowing}</span><LineListTextarea resetVersion={resetVersion} value={plan.story_state.resolved_foreshadowing} onChange={(value) => updateStoryState("resolved_foreshadowing", value)} /></label>
          <label><span>{labels.currentLocations}</span><LineListTextarea resetVersion={resetVersion} value={plan.story_state.current_locations} onChange={(value) => updateStoryState("current_locations", value)} /></label>
          <label><span>{labels.propState}</span><LineListTextarea resetVersion={resetVersion} value={plan.story_state.prop_state} onChange={(value) => updateStoryState("prop_state", value)} /></label>
          <label><span>{labels.locations}</span><LineListTextarea resetVersion={resetVersion} value={plan.series_bible.locations} onChange={(value) => updateSeriesBible("locations", value)} /></label>
          <label><span>{labels.props}</span><LineListTextarea resetVersion={resetVersion} value={plan.series_bible.props} onChange={(value) => updateSeriesBible("props", value)} /></label>
        </div>
      </section>

      <section className="continuity-subsection" id="settings-characters">
        <h2 id="settings-characters-title" tabIndex={-1}>{groups.charactersTitle}</h2>
        <h3>{groups.characterRosterTitle}</h3>
        {characters.length ? (
          <ul className="continuity-character-list">
            {characters.map((character) => (
              <li key={character.id}>
                <span className="continuity-character-icon"><UserRound aria-hidden="true" size={17} /></span>
                <span>
                  <strong>{character.name}</strong>
                  <small>{character.role || character.id}</small>
                </span>
                <span className="continuity-character-flags">
                  {character.reference_images.length ? <Check aria-label="reference ready" size={15} /> : <span><ImageOff aria-hidden="true" size={14} />{groups.characterReferenceMissing}</span>}
                  {!character.visual_lock ? <span><AlertTriangle aria-hidden="true" size={14} />{groups.characterVisualMissing}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : <p className="empty-state">{groups.noCharacters}</p>}

        <h3>{groups.charactersRelationshipsTitle}</h3>
        <div className="continuity-grid">
          <label><span>{labels.relationshipMap}</span><LineListTextarea resetVersion={resetVersion} value={plan.series_bible.relationship_map} onChange={(value) => updateSeriesBible("relationship_map", value)} /></label>
          <label><span>{labels.characterKnowledge}</span><LineListTextarea resetVersion={resetVersion} value={plan.story_state.character_knowledge} onChange={(value) => updateStoryState("character_knowledge", value)} /></label>
          <label><span>{labels.characterStatus}</span><LineListTextarea resetVersion={resetVersion} value={plan.story_state.character_status} onChange={(value) => updateStoryState("character_status", value)} /></label>
          <label><span>{labels.relationshipChanges}</span><LineListTextarea resetVersion={resetVersion} value={plan.story_state.relationship_changes} onChange={(value) => updateStoryState("relationship_changes", value)} /></label>
        </div>

        <h3>{groups.continuityIssuesTitle}</h3>
        {consistencyReport?.issues.length ? (
          <ul className="continuity-issue-list">
            {consistencyReport.issues.map((issue, index) => (
              <li key={`${issue.code}-${issue.shot_id ?? "project"}-${index}`} data-severity={issue.severity}>
                <AlertTriangle aria-hidden="true" size={16} />
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        ) : <p className="empty-state">{groups.noContinuityIssues}</p>}
      </section>

      <section className="continuity-subsection" id="settings-visual">
        <h2 id="settings-visual-title" tabIndex={-1}>{groups.visualRulesTitle}</h2>
        <div className="continuity-grid">
          <label><span>{labels.styleLock}</span><textarea rows={5} value={plan.series_bible.style_lock} onChange={(event) => updateSeriesBible("style_lock", event.target.value)} /></label>
          <label><span>{labels.visualRules}</span><textarea rows={5} value={plan.series_bible.visual_rules} onChange={(event) => updateSeriesBible("visual_rules", event.target.value)} /></label>
          <label><span>{labels.taboos}</span><LineListTextarea resetVersion={resetVersion} value={plan.series_bible.taboos} onChange={(value) => updateSeriesBible("taboos", value)} /></label>
        </div>
      </section>

      <section className="continuity-subsection" id="settings-sound">
        <h2 id="settings-sound-title" tabIndex={-1}>{groups.soundTitle}</h2>
        <div className="continuity-grid">
          <label><span>{groups.narrationLabel}</span><textarea rows={4} value={sound.narration} onChange={(event) => updateSound("narration", event.target.value)} /></label>
          <label><span>{groups.dialogueLabel}</span><textarea rows={4} value={sound.dialogue} onChange={(event) => updateSound("dialogue", event.target.value)} /></label>
          <label><span>{groups.ambienceLabel}</span><textarea rows={4} value={sound.ambience} onChange={(event) => updateSound("ambience", event.target.value)} /></label>
          <label><span>{groups.musicDirectionLabel}</span><textarea rows={4} value={sound.music_direction} onChange={(event) => updateSound("music_direction", event.target.value)} /></label>
          <label className="is-wide"><span>{groups.soundPromptLabel}</span><textarea rows={5} value={sound.prompt} onChange={(event) => updateSound("prompt", event.target.value)} /></label>
          <label className="checkbox-row is-wide"><input type="checkbox" checked={sound.storyboard_prompt_integration} onChange={(event) => updateSound("storyboard_prompt_integration", event.target.checked)} /><span>{groups.integrateSoundLabel}</span></label>
        </div>
      </section>

      <section className="continuity-subsection" id="settings-generation">
        <h2 id="settings-generation-title" tabIndex={-1}>{groups.generationPreferencesTitle}</h2>
        <div className="continuity-grid continuity-preferences-grid">
          <GenerationModelPicker
            capability="image"
            label={groups.imageModelLabel}
            strings={strings.modelCatalog}
            value={generationPreferences.image_model}
            onChange={(value) => updateGenerationPreference("image_model", value)}
          />
          <GenerationModelPicker
            capability="video"
            label={groups.videoModelLabel}
            strings={strings.modelCatalog}
            value={generationPreferences.video_model}
            onChange={(value) => updateGenerationPreference("video_model", value)}
          />
          <SelectMenu label={groups.imageSizeLabel} value={generationPreferences.image_size} onValueChange={(value) => updateGenerationPreference("image_size", value)} options={[{ value: "1024x1024", label: "1024 x 1024" }, { value: "1536x1024", label: "1536 x 1024" }, { value: "1024x1536", label: "1024 x 1536" }]} />
          <SelectMenu label={groups.imageQualityLabel} value={generationPreferences.image_quality} onValueChange={(value) => updateGenerationPreference("image_quality", value)} options={[{ value: "standard", label: "standard" }, { value: "high", label: "high" }]} />
          <SelectMenu label={groups.aspectRatioLabel} value={generationPreferences.aspect_ratio} onValueChange={(value) => updateGenerationPreference("aspect_ratio", value)} options={[{ value: "16:9", label: "16:9" }, { value: "9:16", label: "9:16" }, { value: "1:1", label: "1:1" }, { value: "4:3", label: "4:3" }]} />
        </div>
      </section>

      {isSeries ? (
        <EpisodePlanningEditor
          plan={plan}
          resetVersion={resetVersion}
          labels={labels}
          groups={groups}
          onChange={onChange}
        />
      ) : null}
    </div>
  );
}
