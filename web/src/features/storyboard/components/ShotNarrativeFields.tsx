import type { EpisodeOutlineItem, Shot } from "../../../domain/types";
import type { UIStrings } from "../../../i18n";
import type { ShotDraftFields } from "../model/shotDraft";
import { SelectMenu } from "../../../shared/ui";
import styles from "./ShotInspector.module.css";

export function ShotNarrativeFields({
  draft,
  episodes,
  shot,
  strings,
  updateDraft,
}: {
  draft: ShotDraftFields;
  episodes: EpisodeOutlineItem[];
  shot: Shot | null;
  strings: UIStrings["shotEditor"];
  updateDraft: (update: (draft: ShotDraftFields) => ShotDraftFields) => void;
}) {
  const orderedEpisodes = [...episodes].sort(
    (left, right) => left.episode_number - right.episode_number,
  );
  const currentEpisodeMissing = draft.episodeNumber !== null
    && !orderedEpisodes.some((episode) => episode.episode_number === draft.episodeNumber);

  return (
    <section className={styles.section} aria-labelledby="shot-narrative-fields">
      <h3 id="shot-narrative-fields">{strings.narrativeSectionTitle}</h3>
      <div className={styles.readonlyField}>
        <span>{strings.beatLabel}</span>
        <p>{shot?.beat || strings.unspecifiedOption}</p>
      </div>
      <div className={styles.fields}>
        {orderedEpisodes.length > 0 ? (
          <SelectMenu
              label={strings.episodeLabel}
              value={String(draft.episodeNumber ?? "")}
              disabled={!shot}
              onValueChange={(value) => updateDraft((current) => ({
                ...current,
                episodeNumber: value ? Number(value) : null,
              }))}
              options={[
                { value: "", label: strings.episodeUnassignedOption },
                ...(currentEpisodeMissing ? [{ value: String(draft.episodeNumber ?? ""), label: strings.episodeUnavailableOption(draft.episodeNumber ?? 0) }] : []),
                ...orderedEpisodes.map((episode) => ({ value: String(episode.episode_number), label: strings.episodeOption(episode.episode_number, episode.title) })),
              ]}
            />
        ) : null}
        <label className={styles.promptField}>
          <span>{strings.promptLabel}</span>
          <textarea
            value={draft.prompt}
            disabled={!shot}
            rows={6}
            onChange={(event) => updateDraft((current) => ({ ...current, prompt: event.target.value }))}
          />
        </label>
        <label>
          <span>{strings.locationLabel}</span>
          <input
            value={draft.location}
            disabled={!shot}
            onChange={(event) => updateDraft((current) => ({ ...current, location: event.target.value }))}
          />
        </label>
        <label>
          <span>{strings.propsLabel}</span>
          <input
            value={draft.props}
            disabled={!shot}
            onChange={(event) => updateDraft((current) => ({ ...current, props: event.target.value }))}
          />
        </label>
        <label className={styles.promptField}>
          <span>{strings.intentLabel}</span>
          <textarea
            value={draft.shotIntent}
            disabled={!shot}
            rows={3}
            onChange={(event) => updateDraft((current) => ({ ...current, shotIntent: event.target.value }))}
          />
        </label>
      </div>
    </section>
  );
}
