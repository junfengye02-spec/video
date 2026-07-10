import { useLayoutEffect, useRef, useState } from "react";
import {
  ContinuityEditor,
  type ContinuityEditorStrings,
} from "../components/continuity/ContinuityEditor";
import type { ContinuityPlan } from "../domain/types";
import { getStrings } from "../i18n";

export interface GlobalSettingsPageProps {
  plan: ContinuityPlan;
  saving: boolean;
  strings?: ContinuityEditorStrings;
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

export function GlobalSettingsPage({
  plan,
  saving,
  strings = getStrings("zh"),
  onSave,
}: GlobalSettingsPageProps) {
  const pageStrings = strings.globalSettings;
  const [draft, setDraft] = useState(() => cloneContinuityPlan(plan));
  const [baseline, setBaseline] = useState(() => cloneContinuityPlan(plan));
  const [error, setError] = useState<string | null>(null);
  const planGenerationRef = useRef(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  useLayoutEffect(() => {
    planGenerationRef.current += 1;
    setDraft(cloneContinuityPlan(plan));
    setBaseline(cloneContinuityPlan(plan));
    setError(null);
  }, [plan]);

  const handleSave = async () => {
    if (saving || !dirty) {
      return;
    }
    const submissionGeneration = planGenerationRef.current;
    setError(null);
    try {
      await onSave(draft);
      if (submissionGeneration !== planGenerationRef.current) {
        return;
      }
      setBaseline(cloneContinuityPlan(draft));
    } catch (saveError) {
      if (submissionGeneration !== planGenerationRef.current) {
        return;
      }
      setError(saveError instanceof Error && saveError.message ? saveError.message : pageStrings.saveError);
    }
  };

  return (
    <section className="storyboard-panel continuity-panel" aria-labelledby="global-settings-title">
      <div className="section-heading">
        <h1 id="global-settings-title">{pageStrings.title}</h1>
      </div>
      <p>{pageStrings.notice}</p>
      {error ? <p role="alert">{error}</p> : null}
      <ContinuityEditor
        plan={draft}
        resetVersion={planGenerationRef.current}
        strings={strings}
        onChange={setDraft}
      />
      <button className="primary-button" type="button" disabled={saving || !dirty} onClick={handleSave}>
        {saving ? pageStrings.saving : pageStrings.save}
      </button>
    </section>
  );
}
