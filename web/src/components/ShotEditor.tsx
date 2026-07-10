import { Check, Images, RefreshCw, Sparkles, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetRecord, Character, PromptOptimizeResponse, Shot, ShotLanguage, ShotSaveRequest } from "../domain/types";
import type { UIStrings } from "../i18n";
import {
  applyPromptOptimization,
  createShotDraftState,
  shotDraftIsDirty,
  toShotSaveRequest,
  undoPromptOptimization,
  type ShotDraftFields,
} from "./storyboard/shotDraft";

export interface ShotEditorProps {
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
  onDirtyChange?: (dirty: boolean) => void;
}

const SHOT_SIZES = [
  "extreme_wide",
  "wide",
  "medium_wide",
  "medium",
  "medium_close",
  "close_up",
  "extreme_close_up",
  "over_shoulder",
  "insert",
  "establishing",
] as const;
const CAMERA_MOVEMENTS = [
  "static",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "dolly_in",
  "dolly_out",
  "tracking_left",
  "tracking_right",
  "crane_up",
  "crane_down",
  "handheld",
  "steadicam",
  "whip_pan",
  "orbital",
  "zoom_in",
  "zoom_out",
  "rack_focus",
] as const;
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
  onDirtyChange,
  onOptimizePrompt,
  onRegenerateShot,
  onSaveShot,
}: ShotEditorProps) {
  const [draftState, setDraftState] = useState(() => createShotDraftState(shot));
  const optimizationRevisionRef = useRef(0);
  const selectionRevisionRef = useRef(0);

  useEffect(() => {
    selectionRevisionRef.current += 1;
    setDraftState(createShotDraftState(shot));
  }, [shot?.id]);

  function updateDraft(update: (draft: ShotDraftFields) => ShotDraftFields) {
    setDraftState((current) => ({ ...current, draft: update(current.draft) }));
  }

  function updateShotLanguage<Key extends keyof ShotLanguage>(key: Key, value: ShotLanguage[Key]) {
    updateDraft((draft) => ({
      ...draft,
      shotLanguage: {
        ...draft.shotLanguage,
        [key]: value ?? null,
      },
    }));
  }

  const groupedAssets = useMemo(
    () => assets.slice().sort((left, right) => left.label.localeCompare(right.label)),
    [assets],
  );
  const selectedReferenceCount = useMemo(
    () =>
      Math.min(
        draftState.draft.assetIds.reduce((count, assetId) => {
          const asset = assets.find((item) => item.id === assetId);
          return count + (asset?.reference_images.length ?? 0);
        }, 0),
        3,
      ),
    [draftState.draft.assetIds, assets],
  );
  const generationModeLabel =
    selectedReferenceCount > 0 ? strings.imageToVideoMode(selectedReferenceCount) : strings.textToVideoMode;
  const draftIsDirty = shotDraftIsDirty(draftState);

  useEffect(() => {
    onDirtyChange?.(draftIsDirty);
  }, [draftIsDirty, onDirtyChange]);

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
          <textarea
            value={draftState.draft.prompt}
            disabled={!shot}
            rows={4}
            onChange={(event) => updateDraft((draft) => ({ ...draft, prompt: event.target.value }))}
          />
        </label>
        <label>
          <span>{strings.locationLabel}</span>
          <input
            value={draftState.draft.location}
            disabled={!shot}
            onChange={(event) => updateDraft((draft) => ({ ...draft, location: event.target.value }))}
          />
        </label>
        <fieldset className="character-binding-group" disabled={!shot}>
          <legend className="sr-only">{strings.charactersLabel}</legend>
          <span className="field-label">{strings.charactersLabel}</span>
          <div className="character-binding-options">
            {characters.map((character) => (
              <label key={character.id}>
                <input
                  type="checkbox"
                  checked={draftState.draft.characters.includes(character.id)}
                  onChange={(event) => {
                    updateDraft((draft) => ({
                      ...draft,
                      characters: event.target.checked
                        ? [...draft.characters, character.id]
                        : draft.characters.filter((id) => id !== character.id),
                    }));
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
          <input
            value={draftState.draft.props.join(", ")}
            disabled={!shot}
            onChange={(event) => updateDraft((draft) => ({ ...draft, props: splitList(event.target.value) }))}
          />
        </label>
        <label className="prompt-field">
          <span>{strings.intentLabel}</span>
          <textarea
            value={draftState.draft.shotIntent}
            disabled={!shot}
            rows={2}
            onChange={(event) => updateDraft((draft) => ({ ...draft, shotIntent: event.target.value }))}
          />
        </label>
        <fieldset className="asset-binding-group" disabled={!shot || groupedAssets.length === 0}>
          <legend>{strings.referenceAssetsLabel}</legend>
          <div className="asset-grid">
            {groupedAssets.length > 0 ? (
              groupedAssets.map((asset) => (
                <label key={asset.id}>
                  <input
                    type="checkbox"
                    checked={draftState.draft.assetIds.includes(asset.id)}
                    onChange={(event) => {
                      updateDraft((draft) => ({
                        ...draft,
                        assetIds: event.target.checked
                          ? [...draft.assetIds, asset.id]
                          : draft.assetIds.filter((id) => id !== asset.id),
                      }));
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
            value={draftState.draft.shotLanguage.shot_size ?? ""}
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
            value={draftState.draft.shotLanguage.camera_movement ?? ""}
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
            value={draftState.draft.shotLanguage.lens_mm ?? ""}
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
            value={draftState.draft.shotLanguage.lighting_key ?? ""}
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
            value={draftState.draft.shotLanguage.depth_of_field ?? ""}
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
            value={draftState.draft.shotLanguage.color_temperature ?? ""}
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
            const selectionRevision = selectionRevisionRef.current;
            try {
              const optimized = await onOptimizePrompt(shot, draftState.draft.prompt);
              if (selectionRevisionRef.current !== selectionRevision) {
                return;
              }
              optimizationRevisionRef.current += 1;
              setDraftState((current) => (
                current.shotId === shot.id ? applyPromptOptimization(current, optimized) : current
              ));
            } catch {
              // App owns the error banner.
            }
          }}
        >
          <Sparkles aria-hidden="true" size={16} />
          {optimizing ? strings.optimizingAction : strings.optimizeAction}
        </button>
        {draftState.undoOptimization ? (
          <button
            className="primary-button"
            type="button"
            disabled={!shot || saving || optimizing}
            onClick={() => {
              optimizationRevisionRef.current += 1;
              setDraftState((current) => undoPromptOptimization(current));
            }}
          >
            <Undo2 aria-hidden="true" size={16} />
            {strings.undoOptimizationAction}
          </button>
        ) : null}
        <button
          className="primary-button"
          type="button"
          disabled={!shot || saving}
          onClick={async () => {
            if (!shot) {
              return;
            }
            const submittedDraft = draftState.draft;
            const payload = toShotSaveRequest(draftState.draft);
            const optimizationRevision = optimizationRevisionRef.current;
            const selectionRevision = selectionRevisionRef.current;
            try {
              await onSaveShot(shot.id, payload);
              const savedShot: Shot = {
                ...shot,
                prompt: payload.prompt ?? "",
                characters: payload.characters ?? [],
                location: payload.location ?? null,
                props: payload.props ?? [],
                asset_ids: payload.asset_ids ?? [],
                shot_intent: payload.shot_intent ?? null,
                shot_language: payload.shot_language ?? {},
              };
              const savedState = createShotDraftState(savedShot);
              setDraftState((current) => {
                if (current.shotId !== shot.id || selectionRevisionRef.current !== selectionRevision) {
                  return current;
                }
                const changedWhileSaving = shotDraftIsDirty({ ...current, baseline: submittedDraft });
                const optimizationChangedWhileSaving = optimizationRevisionRef.current !== optimizationRevision;
                return changedWhileSaving
                  ? {
                      ...savedState,
                      draft: current.draft,
                      undoOptimization: optimizationChangedWhileSaving ? current.undoOptimization : null,
                    }
                  : savedState;
              });
            } catch {
              // App owns the error banner; the unsaved draft stays intact.
            }
          }}
        >
          <Check aria-hidden="true" size={16} />
          {saving ? strings.savingAction : strings.saveAction}
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={!shot || saving || regenerating || draftIsDirty}
          onClick={() => {
            if (shot) {
              void onRegenerateShot(shot).catch(() => undefined);
            }
          }}
        >
          <RefreshCw aria-hidden="true" size={16} />
          {regenerating ? strings.regeneratingAction : strings.regenerateAction}
        </button>
        {draftIsDirty ? <span className="empty-state">{strings.saveBeforeRegenerateHint}</span> : null}
      </div>
    </section>
  );
}
