import type { ContinuityPlan, EpisodeOutlineItem } from "../../domain/types";
import type { UIStrings } from "../../i18n";
import { LineListTextarea } from "./LineListTextarea";

function createEpisode(index: number): EpisodeOutlineItem {
  return {
    episode_number: index,
    title: "",
    goal: "",
    conflict: "",
    twist: "",
    cliffhanger: "",
    inherited_state: [],
    prompt: "",
    outline: "",
    locked: false,
  };
}

export function EpisodePlanningEditor({
  plan,
  resetVersion,
  labels,
  groups,
  onChange,
}: {
  plan: ContinuityPlan;
  resetVersion: number;
  labels: UIStrings["continuity"];
  groups: UIStrings["globalSettings"];
  onChange: (plan: ContinuityPlan) => void;
}) {
  const updateEpisode = (episodeNumber: number, updates: Partial<EpisodeOutlineItem>) => {
    onChange({
      ...plan,
      episodes: plan.episodes.map((episode) => (
        episode.episode_number === episodeNumber ? { ...episode, ...updates } : episode
      )),
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

  const episodeLabel = (episodeNumber: number, field: string) => (
    groups.episodeFieldLabel(episodeNumber, field)
  );

  return (
    <section className="continuity-subsection" id="settings-episodes">
      <h2 id="settings-episodes-title" tabIndex={-1}>{groups.episodePlanningTitle}</h2>
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
              <label><span>{episodeLabel(episode.episode_number, labels.episodeTitle)}</span><input value={episode.title} onChange={(event) => updateEpisode(episode.episode_number, { title: event.target.value })} /></label>
              <label><span>{episodeLabel(episode.episode_number, labels.goal)}</span><textarea rows={3} value={episode.goal} onChange={(event) => updateEpisode(episode.episode_number, { goal: event.target.value })} /></label>
              <label><span>{episodeLabel(episode.episode_number, labels.conflict)}</span><textarea rows={3} value={episode.conflict} onChange={(event) => updateEpisode(episode.episode_number, { conflict: event.target.value })} /></label>
              <label><span>{episodeLabel(episode.episode_number, labels.twist)}</span><textarea rows={3} value={episode.twist} onChange={(event) => updateEpisode(episode.episode_number, { twist: event.target.value })} /></label>
              <label><span>{episodeLabel(episode.episode_number, labels.cliffhanger)}</span><textarea rows={3} value={episode.cliffhanger} onChange={(event) => updateEpisode(episode.episode_number, { cliffhanger: event.target.value })} /></label>
              <label><span>{episodeLabel(episode.episode_number, labels.episodeOutline)}</span><textarea rows={4} value={episode.outline ?? ""} onChange={(event) => updateEpisode(episode.episode_number, { outline: event.target.value })} /></label>
              <label className="is-wide"><span>{episodeLabel(episode.episode_number, labels.episodePrompt)}</span><textarea rows={4} value={episode.prompt ?? ""} onChange={(event) => updateEpisode(episode.episode_number, { prompt: event.target.value })} /></label>
              <label><span>{episodeLabel(episode.episode_number, labels.inheritedState)}</span><LineListTextarea resetVersion={resetVersion} value={episode.inherited_state} onChange={(value) => updateEpisode(episode.episode_number, { inherited_state: value })} /></label>
              <label className="checkbox-row"><input type="checkbox" checked={episode.locked} onChange={(event) => updateEpisode(episode.episode_number, { locked: event.target.checked })} /><span>{episodeLabel(episode.episode_number, labels.locked)}</span></label>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
