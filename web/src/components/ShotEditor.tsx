import { Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Shot, ShotSaveRequest } from "../domain/types";
import type { UIStrings } from "../i18n";

interface ShotEditorProps {
  shot: Shot | null;
  saving: boolean;
  strings: UIStrings["shotEditor"];
  onSaveShot: (shotId: string, payload: ShotSaveRequest) => Promise<void>;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ShotEditor({ shot, saving, strings, onSaveShot }: ShotEditorProps) {
  const [prompt, setPrompt] = useState("");
  const [location, setLocation] = useState("");
  const [propsText, setPropsText] = useState("");
  const [charactersText, setCharactersText] = useState("");
  const [shotIntent, setShotIntent] = useState("");

  useEffect(() => {
    setPrompt(shot?.prompt ?? "");
    setLocation(shot?.location ?? "");
    setPropsText((shot?.props ?? []).join(", "));
    setCharactersText((shot?.characters ?? []).join(", "));
    setShotIntent(shot?.shot_intent ?? "");
  }, [shot]);

  const payload = useMemo<ShotSaveRequest>(
    () => ({
      prompt,
      characters: splitList(charactersText),
      location: location.trim() || null,
      props: splitList(propsText),
      asset_ids: shot?.asset_ids ?? [],
      shot_intent: shotIntent.trim() || null,
      shot_language: shot?.shot_language ?? null,
    }),
    [charactersText, location, prompt, propsText, shot, shotIntent],
  );

  return (
    <section className="storyboard-panel shot-editor" aria-label={strings.regionLabel}>
      <div className="section-heading">
        <h2>{strings.title}</h2>
        {shot ? <span>{shot.id}</span> : null}
      </div>
      {!shot ? <p className="empty-state">{strings.emptyState}</p> : null}
      <div className="prompt-grid">
        <label className="prompt-field">
          <span>{strings.promptLabel}</span>
          <textarea value={prompt} disabled={!shot} rows={4} onChange={(event) => setPrompt(event.target.value)} />
        </label>
        <label>
          <span>{strings.locationLabel}</span>
          <input value={location} disabled={!shot} onChange={(event) => setLocation(event.target.value)} />
        </label>
        <label>
          <span>{strings.charactersLabel}</span>
          <input value={charactersText} disabled={!shot} onChange={(event) => setCharactersText(event.target.value)} />
        </label>
        <label>
          <span>{strings.propsLabel}</span>
          <input value={propsText} disabled={!shot} onChange={(event) => setPropsText(event.target.value)} />
        </label>
        <label className="prompt-field">
          <span>{strings.intentLabel}</span>
          <textarea value={shotIntent} disabled={!shot} rows={2} onChange={(event) => setShotIntent(event.target.value)} />
        </label>
      </div>
      <div className="chat-actions">
        <button
          className="primary-button"
          type="button"
          disabled={!shot || saving}
          onClick={() => {
            if (shot) {
              void onSaveShot(shot.id, payload);
            }
          }}
        >
          <Check aria-hidden="true" size={16} />
          {saving ? strings.savingAction : strings.saveAction}
        </button>
      </div>
    </section>
  );
}
