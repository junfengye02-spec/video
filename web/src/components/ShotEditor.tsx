import { Check, Images, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AssetRecord, Character, PromptOptimizeResponse, Shot, ShotLanguage, ShotSaveRequest } from "../domain/types";
import type { UIStrings } from "../i18n";

interface ShotEditorProps {
  assets: AssetRecord[];
  characters: Character[];
  optimizing: boolean;
  regenerating: boolean;
  shot: Shot | null;
  saving: boolean;
  strings: UIStrings["shotEditor"];
  onOptimizePrompt: (shot: Shot, prompt: string) => Promise<PromptOptimizeResponse>;
  onRegenerateShot: (shot: Shot) => Promise<void>;
  onSaveShot: (shotId: string, payload: ShotSaveRequest) => Promise<void>;
}

const SHOT_SIZES = ["wide", "medium", "medium_close", "close_up", "establishing"] as const;
const CAMERA_MOVEMENTS = ["static", "dolly_in", "dolly_out", "handheld", "steadicam", "orbital"] as const;
const LENS_VALUES = [14, 24, 35, 50, 85, 135, 200] as const;
const LIGHTING_KEYS = [
  "high_key",
  "low_key",
  "natural",
  "golden_hour",
  "blue_hour",
  "tungsten_warm",
  "neon",
  "silhouette",
  "rim_lit",
  "volumetric",
  "overcast_soft",
] as const;
const DEPTH_VALUES = ["shallow", "medium", "deep"] as const;
const COLOR_TEMPERATURES = ["cool", "neutral", "warm", "mixed"] as const;

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function ShotEditor({
  assets,
  characters,
  optimizing,
  regenerating,
  shot,
  saving,
  strings,
  onOptimizePrompt,
  onRegenerateShot,
  onSaveShot,
}: ShotEditorProps) {
  const [prompt, setPrompt] = useState("");
  const [location, setLocation] = useState("");
  const [propsText, setPropsText] = useState("");
  const [characterIds, setCharacterIds] = useState<string[]>([]);
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [shotIntent, setShotIntent] = useState("");
  const [shotLanguage, setShotLanguage] = useState<ShotLanguage>({});

  useEffect(() => {
    setPrompt(shot?.prompt ?? "");
    setLocation(shot?.location ?? "");
    setPropsText((shot?.props ?? []).join(", "));
    setCharacterIds(shot?.characters ?? []);
    setAssetIds(shot?.asset_ids ?? []);
    setShotIntent(shot?.shot_intent ?? "");
    setShotLanguage(shot?.shot_language ?? {});
  }, [shot]);

  function updateShotLanguage<Key extends keyof ShotLanguage>(key: Key, value: ShotLanguage[Key]) {
    setShotLanguage((current) => ({
      ...current,
      [key]: value ?? null,
    }));
  }

  const parsedCharacters = useMemo(() => characterIds, [characterIds]);
  const parsedProps = useMemo(() => splitList(propsText), [propsText]);
  const groupedAssets = useMemo(
    () => assets.slice().sort((left, right) => left.label.localeCompare(right.label)),
    [assets],
  );
  const selectedReferenceCount = useMemo(
    () =>
      Math.min(
        assetIds.reduce((count, assetId) => {
          const asset = assets.find((item) => item.id === assetId);
          return count + (asset?.reference_images.length ?? 0);
        }, 0),
        3,
      ),
    [assetIds, assets],
  );
  const generationModeLabel =
    selectedReferenceCount > 0 ? strings.imageToVideoMode(selectedReferenceCount) : strings.textToVideoMode;

  function currentSavePayload(): ShotSaveRequest {
    return {
      prompt,
      characters: parsedCharacters,
      location: location.trim() || null,
      props: parsedProps,
      asset_ids: assetIds,
      shot_intent: shotIntent.trim() || null,
      shot_language: shotLanguage,
    };
  }

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
        <fieldset className="character-binding-group" disabled={!shot}>
          <legend className="sr-only">{strings.charactersLabel}</legend>
          <span className="field-label">{strings.charactersLabel}</span>
          <div className="character-binding-options">
            {characters.map((character) => (
              <label key={character.id}>
                <input
                  type="checkbox"
                  checked={characterIds.includes(character.id)}
                  onChange={(event) => {
                    setCharacterIds((current) =>
                      event.target.checked
                        ? [...current, character.id]
                        : current.filter((id) => id !== character.id),
                    );
                  }}
                />
                <span>
                  {character.name} <small>{character.id}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label>
          <span>{strings.propsLabel}</span>
          <input value={propsText} disabled={!shot} onChange={(event) => setPropsText(event.target.value)} />
        </label>
        <label className="prompt-field">
          <span>{strings.intentLabel}</span>
          <textarea value={shotIntent} disabled={!shot} rows={2} onChange={(event) => setShotIntent(event.target.value)} />
        </label>
        <fieldset className="asset-binding-group" disabled={!shot || groupedAssets.length === 0}>
          <legend>{strings.referenceAssetsLabel}</legend>
          <div className="asset-grid">
            {groupedAssets.length > 0 ? (
              groupedAssets.map((asset) => (
                <label key={asset.id}>
                  <input
                    type="checkbox"
                    checked={assetIds.includes(asset.id)}
                    onChange={(event) => {
                      setAssetIds((current) =>
                        event.target.checked
                          ? [...current, asset.id]
                          : current.filter((id) => id !== asset.id),
                      );
                    }}
                  />
                  <span>{asset.label}</span>
                </label>
              ))
            ) : (
              <span className="empty-state">{strings.noSavedReferenceAssetsYet}</span>
            )}
          </div>
        </fieldset>
        <label>
          <span>{strings.shotSizeLabel}</span>
          <select
            aria-label={strings.shotSizeLabel}
            value={shotLanguage.shot_size ?? ""}
            disabled={!shot}
            onChange={(event) =>
              updateShotLanguage(
                "shot_size",
                (event.target.value as (typeof SHOT_SIZES)[number] | "") || null,
              )
            }
          >
            <option value="">{strings.unspecifiedOption}</option>
            {SHOT_SIZES.map((value) => (
              <option key={value} value={value}>
                {strings.shotSizeOptions[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{strings.cameraMovementLabel}</span>
          <select
            aria-label={strings.cameraMovementLabel}
            value={shotLanguage.camera_movement ?? ""}
            disabled={!shot}
            onChange={(event) =>
              updateShotLanguage(
                "camera_movement",
                (event.target.value as (typeof CAMERA_MOVEMENTS)[number] | "") || null,
              )
            }
          >
            <option value="">{strings.unspecifiedOption}</option>
            {CAMERA_MOVEMENTS.map((value) => (
              <option key={value} value={value}>
                {strings.cameraMovementOptions[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{strings.lensLabel}</span>
          <select
            aria-label={strings.lensLabel}
            value={shotLanguage.lens_mm ?? ""}
            disabled={!shot}
            onChange={(event) =>
              updateShotLanguage("lens_mm", event.target.value ? Number(event.target.value) as ShotLanguage["lens_mm"] : null)
            }
          >
            <option value="">{strings.unspecifiedOption}</option>
            {LENS_VALUES.map((value) => (
              <option key={value} value={value}>
                {strings.lensOptions[String(value) as keyof typeof strings.lensOptions]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{strings.lightingLabel}</span>
          <select
            aria-label={strings.lightingLabel}
            value={shotLanguage.lighting_key ?? ""}
            disabled={!shot}
            onChange={(event) =>
              updateShotLanguage(
                "lighting_key",
                (event.target.value as (typeof LIGHTING_KEYS)[number] | "") || null,
              )
            }
          >
            <option value="">{strings.unspecifiedOption}</option>
            {LIGHTING_KEYS.map((value) => (
              <option key={value} value={value}>
                {strings.lightingOptions[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{strings.depthOfFieldLabel}</span>
          <select
            aria-label={strings.depthOfFieldLabel}
            value={shotLanguage.depth_of_field ?? ""}
            disabled={!shot}
            onChange={(event) =>
              updateShotLanguage(
                "depth_of_field",
                (event.target.value as (typeof DEPTH_VALUES)[number] | "") || null,
              )
            }
          >
            <option value="">{strings.unspecifiedOption}</option>
            {DEPTH_VALUES.map((value) => (
              <option key={value} value={value}>
                {strings.depthOfFieldOptions[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{strings.colorTemperatureLabel}</span>
          <select
            aria-label={strings.colorTemperatureLabel}
            value={shotLanguage.color_temperature ?? ""}
            disabled={!shot}
            onChange={(event) =>
              updateShotLanguage(
                "color_temperature",
                (event.target.value as (typeof COLOR_TEMPERATURES)[number] | "") || null,
              )
            }
          >
            <option value="">{strings.unspecifiedOption}</option>
            {COLOR_TEMPERATURES.map((value) => (
              <option key={value} value={value}>
                {strings.colorTemperatureOptions[value]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="generation-mode" role="status" aria-live="polite">
        <Images aria-hidden="true" size={16} />
        <span>{generationModeLabel}</span>
      </div>
      <div className="chat-actions">
        <button
          className="primary-button"
          type="button"
          disabled={!shot || saving || optimizing}
          onClick={async () => {
            if (!shot) {
              return;
            }
            try {
              const optimized = await onOptimizePrompt(shot, prompt);
              setPrompt(optimized.optimized_text);
              setShotIntent((current) => optimized.shot_intent ?? current);
              setShotLanguage((current) => (
                optimized.shot_language
                  ? { ...current, ...optimized.shot_language }
                  : current
              ));
            } catch {
              // App owns the error banner.
            }
          }}
        >
          <Sparkles aria-hidden="true" size={16} />
          {optimizing ? strings.optimizingAction : strings.optimizeAction}
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={!shot || saving}
          onClick={() => {
            if (shot) {
              void onSaveShot(shot.id, currentSavePayload()).catch(() => undefined);
            }
          }}
        >
          <Check aria-hidden="true" size={16} />
          {saving ? strings.savingAction : strings.saveAction}
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={!shot || saving || regenerating}
          onClick={async () => {
            if (!shot) {
              return;
            }
            const payload = currentSavePayload();
            try {
              await onSaveShot(shot.id, payload);
              await onRegenerateShot({
                ...shot,
                prompt: payload.prompt ?? shot.prompt,
                characters: payload.characters ?? shot.characters,
                location: payload.location ?? null,
                props: payload.props ?? shot.props,
                asset_ids: payload.asset_ids ?? shot.asset_ids,
                shot_intent: payload.shot_intent ?? shot.shot_intent,
                shot_language: payload.shot_language ?? shot.shot_language,
              });
            } catch {
              // Save failures are surfaced by App; stop before regenerate.
            }
          }}
        >
          <RefreshCw aria-hidden="true" size={16} />
          {regenerating ? strings.regeneratingAction : strings.regenerateAction}
        </button>
      </div>
    </section>
  );
}
