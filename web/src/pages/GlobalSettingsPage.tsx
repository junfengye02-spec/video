import { useEffect, useState } from "react";
import { ContinuityEditor } from "../components/continuity/ContinuityEditor";
import type { ContinuityPlan } from "../domain/types";
import { getStrings } from "../i18n";

export interface GlobalSettingsPageProps {
  plan: ContinuityPlan;
  saving: boolean;
  onSave: (plan: ContinuityPlan) => Promise<void>;
}

function cloneContinuityPlan(plan: ContinuityPlan): ContinuityPlan {
  return {
    ...plan,
    series_bible: {
      ...plan.series_bible,
      taboos: [...plan.series_bible.taboos],
      locations: [...plan.series_bible.locations],
      props: [...plan.series_bible.props],
      relationship_map: [...plan.series_bible.relationship_map],
    },
    episodes: plan.episodes.map((episode) => ({
      ...episode,
      inherited_state: [...episode.inherited_state],
    })),
    story_state: {
      character_knowledge: [...plan.story_state.character_knowledge],
      character_status: [...plan.story_state.character_status],
      relationship_changes: [...plan.story_state.relationship_changes],
      active_foreshadowing: [...plan.story_state.active_foreshadowing],
      resolved_foreshadowing: [...plan.story_state.resolved_foreshadowing],
      prop_state: [...plan.story_state.prop_state],
      current_locations: [...plan.story_state.current_locations],
    },
  };
}

export function GlobalSettingsPage({ plan, saving, onSave }: GlobalSettingsPageProps) {
  const strings = getStrings("zh").globalSettings;
  const [draft, setDraft] = useState(() => cloneContinuityPlan(plan));
  const [baseline, setBaseline] = useState(() => cloneContinuityPlan(plan));
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  useEffect(() => {
    setDraft(cloneContinuityPlan(plan));
    setBaseline(cloneContinuityPlan(plan));
    setError(null);
  }, [plan]);

  const handleSave = async () => {
    if (saving || !dirty) {
      return;
    }
    setError(null);
    try {
      await onSave(draft);
      setBaseline(cloneContinuityPlan(draft));
    } catch (saveError) {
      setError(saveError instanceof Error && saveError.message ? saveError.message : strings.saveError);
    }
  };

  return (
    <section className="storyboard-panel continuity-panel" aria-labelledby="global-settings-title">
      <div className="section-heading">
        <h1 id="global-settings-title">{strings.title}</h1>
      </div>
      <p>{strings.notice}</p>
      {error ? <p role="alert">{error}</p> : null}
      <ContinuityEditor plan={draft} onChange={setDraft} />
      <button className="primary-button" type="button" disabled={saving || !dirty} onClick={handleSave}>
        {saving ? strings.saving : strings.save}
      </button>
    </section>
  );
}
