import { useEffect, useRef, useState } from "react";
import type { ContinuityPlan, EpisodeOutlineItem } from "../../domain/types";
import type { UIStrings } from "../../i18n";

export type ContinuityEditorStrings = Pick<UIStrings, "continuity" | "globalSettings">;

export interface ContinuityEditorProps {
  plan: ContinuityPlan;
  resetVersion: number;
  strings: ContinuityEditorStrings;
  onChange: (plan: ContinuityPlan) => void;
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

function LineListTextarea({
  resetVersion,
  value,
  onChange,
}: {
  resetVersion: number;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const joinedValue = joinLines(value);
  const [rawValue, setRawValue] = useState(joinedValue);
  const focusedRef = useRef(false);
  const joinedValueRef = useRef(joinedValue);
  joinedValueRef.current = joinedValue;

  useEffect(() => {
    if (!focusedRef.current) {
      setRawValue(joinedValue);
    }
  }, [joinedValue]);

  useEffect(() => {
    setRawValue(joinedValueRef.current);
  }, [resetVersion]);

  return (
    <textarea
      rows={3}
      value={rawValue}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(event) => {
        setRawValue(event.target.value);
        onChange(splitLines(event.target.value));
      }}
      onBlur={() => {
        focusedRef.current = false;
        setRawValue(joinedValue);
      }}
    />
  );
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

export function ContinuityEditor({ plan, resetVersion, strings, onChange }: ContinuityEditorProps) {
  const labels = strings.continuity;
  const groups = strings.globalSettings;
  const isSeries = plan.project_type !== "single_video";

  const updateSeriesBible = <K extends keyof ContinuityPlan["series_bible"]>(
    field: K,
    value: ContinuityPlan["series_bible"][K],
  ) => {
    onChange({
      ...plan,
      series_bible: { ...plan.series_bible, [field]: value },
    });
  };

  const updateStoryState = <K extends keyof ContinuityPlan["story_state"]>(
    field: K,
    value: ContinuityPlan["story_state"][K],
  ) => {
    onChange({
      ...plan,
      story_state: { ...plan.story_state, [field]: value },
    });
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

  const episodeLabel = (episodeNumber: number, field: string) =>
    groups.episodeFieldLabel(episodeNumber, field);

  return (
    <div className="continuity-panel" aria-label={labels.ariaLabel}>
      <section className="continuity-subsection">
        <h2>{groups.storyCoreTitle}</h2>
        <div className="continuity-grid">
          <label>
            <span>{labels.worldview}</span>
            <textarea
              rows={3}
              value={plan.series_bible.worldview}
              onChange={(event) => updateSeriesBible("worldview", event.target.value)}
            />
          </label>
          <label>
            <span>{labels.mainArc}</span>
            <textarea
              rows={3}
              value={plan.series_bible.main_arc}
              onChange={(event) => updateSeriesBible("main_arc", event.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="continuity-subsection">
        <h2>{groups.visualRulesTitle}</h2>
        <div className="continuity-grid">
          <label>
            <span>{labels.styleLock}</span>
            <textarea
              rows={3}
              value={plan.series_bible.style_lock}
              onChange={(event) => updateSeriesBible("style_lock", event.target.value)}
            />
          </label>
          <label>
            <span>{labels.visualRules}</span>
            <textarea
              rows={3}
              value={plan.series_bible.visual_rules}
              onChange={(event) => updateSeriesBible("visual_rules", event.target.value)}
            />
          </label>
          <label>
            <span>{labels.taboos}</span>
            <LineListTextarea
              resetVersion={resetVersion}
              value={plan.series_bible.taboos}
              onChange={(value) => updateSeriesBible("taboos", value)}
            />
          </label>
        </div>
      </section>

      <section className="continuity-subsection">
        <h2>{groups.charactersRelationshipsTitle}</h2>
        <div className="continuity-grid">
          <label>
            <span>{labels.relationshipMap}</span>
            <LineListTextarea
              resetVersion={resetVersion}
              value={plan.series_bible.relationship_map}
              onChange={(value) => updateSeriesBible("relationship_map", value)}
            />
          </label>
          <label>
            <span>{labels.characterKnowledge}</span>
            <LineListTextarea
              resetVersion={resetVersion}
              value={plan.story_state.character_knowledge}
              onChange={(value) => updateStoryState("character_knowledge", value)}
            />
          </label>
          <label>
            <span>{labels.characterStatus}</span>
            <LineListTextarea
              resetVersion={resetVersion}
              value={plan.story_state.character_status}
              onChange={(value) => updateStoryState("character_status", value)}
            />
          </label>
          <label>
            <span>{labels.relationshipChanges}</span>
            <LineListTextarea
              resetVersion={resetVersion}
              value={plan.story_state.relationship_changes}
              onChange={(value) => updateStoryState("relationship_changes", value)}
            />
          </label>
        </div>
      </section>

      <section className="continuity-subsection">
        <h2>{groups.storyStateTitle}</h2>
        <div className="continuity-grid">
          <label>
            <span>{labels.activeForeshadowing}</span>
            <LineListTextarea
              resetVersion={resetVersion}
              value={plan.story_state.active_foreshadowing}
              onChange={(value) => updateStoryState("active_foreshadowing", value)}
            />
          </label>
          <label>
            <span>{labels.resolvedForeshadowing}</span>
            <LineListTextarea
              resetVersion={resetVersion}
              value={plan.story_state.resolved_foreshadowing}
              onChange={(value) => updateStoryState("resolved_foreshadowing", value)}
            />
          </label>
          <label>
            <span>{labels.propState}</span>
            <LineListTextarea
              resetVersion={resetVersion}
              value={plan.story_state.prop_state}
              onChange={(value) => updateStoryState("prop_state", value)}
            />
          </label>
          <label>
            <span>{labels.currentLocations}</span>
            <LineListTextarea
              resetVersion={resetVersion}
              value={plan.story_state.current_locations}
              onChange={(value) => updateStoryState("current_locations", value)}
            />
          </label>
          <label>
            <span>{labels.locations}</span>
            <LineListTextarea
              resetVersion={resetVersion}
              value={plan.series_bible.locations}
              onChange={(value) => updateSeriesBible("locations", value)}
            />
          </label>
          <label>
            <span>{labels.props}</span>
            <LineListTextarea
              resetVersion={resetVersion}
              value={plan.series_bible.props}
              onChange={(value) => updateSeriesBible("props", value)}
            />
          </label>
        </div>
      </section>

      {isSeries ? (
        <section className="continuity-subsection">
          <h2>{groups.episodePlanningTitle}</h2>
          <div className="episode-actions">
            <p className="active-episode-summary">
              {labels.currentProductionEpisode(plan.active_episode_number)}
            </p>
            <button className="secondary-button" type="button" onClick={addEpisode}>
              {labels.addEpisode}
            </button>
          </div>
          <div className="episode-list">
            {plan.episodes.map((episode) => (
              <article key={episode.episode_number} className="episode-row episode-editor">
                <div className="episode-toolbar">
                  <strong>{groups.episodeHeading(episode.episode_number, episode.title)}</strong>
                  {plan.active_episode_number === episode.episode_number ? (
                    <span className="status-pill">{labels.currentEpisodeBadge}</span>
                  ) : (
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => onChange({ ...plan, active_episode_number: episode.episode_number })}
                    >
                      {labels.setCurrentEpisode(episode.episode_number)}
                    </button>
                  )}
                </div>
                <div className="continuity-grid">
                  <label>
                    <span>{episodeLabel(episode.episode_number, labels.episodeTitle)}</span>
                    <input
                      value={episode.title}
                      onChange={(event) => updateEpisode(episode.episode_number, { title: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>{episodeLabel(episode.episode_number, labels.goal)}</span>
                    <textarea
                      rows={3}
                      value={episode.goal}
                      onChange={(event) => updateEpisode(episode.episode_number, { goal: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>{episodeLabel(episode.episode_number, labels.conflict)}</span>
                    <textarea
                      rows={3}
                      value={episode.conflict}
                      onChange={(event) => updateEpisode(episode.episode_number, { conflict: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>{episodeLabel(episode.episode_number, labels.twist)}</span>
                    <textarea
                      rows={3}
                      value={episode.twist}
                      onChange={(event) => updateEpisode(episode.episode_number, { twist: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>{episodeLabel(episode.episode_number, labels.cliffhanger)}</span>
                    <textarea
                      rows={3}
                      value={episode.cliffhanger}
                      onChange={(event) => updateEpisode(episode.episode_number, { cliffhanger: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>{episodeLabel(episode.episode_number, labels.inheritedState)}</span>
                    <LineListTextarea
                      resetVersion={resetVersion}
                      value={episode.inherited_state}
                      onChange={(value) => updateEpisode(episode.episode_number, { inherited_state: value })}
                    />
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={episode.locked}
                      onChange={(event) => updateEpisode(episode.episode_number, { locked: event.target.checked })}
                    />
                    <span>{episodeLabel(episode.episode_number, labels.locked)}</span>
                  </label>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
