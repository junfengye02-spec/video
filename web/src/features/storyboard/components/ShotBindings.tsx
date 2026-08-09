import { Images } from "lucide-react";
import { Children, useMemo, type ReactNode } from "react";
import type { AssetRecord, Character, Shot } from "../../../domain/types";
import type { UIStrings } from "../../../i18n";
import type { ShotDraftFields } from "../model/shotDraft";
import styles from "./ShotInspector.module.css";

export function ShotBindings({
  assets,
  characters,
  draft,
  shot,
  strings,
  updateDraft,
}: {
  assets: AssetRecord[];
  characters: Character[];
  draft: ShotDraftFields;
  shot: Shot | null;
  strings: UIStrings["shotEditor"];
  updateDraft: (update: (draft: ShotDraftFields) => ShotDraftFields) => void;
}) {
  const knownCharacterIds = useMemo(() => new Set(characters.map((item) => item.id)), [characters]);
  const knownAssetIds = useMemo(() => new Set(assets.map((item) => item.id)), [assets]);
  const characterOptions = [
    ...characters.map((character) => ({
      id: character.id,
      label: character.name,
      detail: character.role || character.id,
    })),
    ...draft.characters
      .filter((id) => !knownCharacterIds.has(id))
      .map((id) => ({ id, label: id, detail: strings.missingBindingLabel })),
  ];
  const assetOptions = [
    ...assets
      .slice()
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((asset) => ({ id: asset.id, kind: asset.kind, label: asset.label })),
    ...draft.assetIds
      .filter((id) => !knownAssetIds.has(id))
      .map((id) => ({ id, kind: null, label: id })),
  ];
  const referenceCount = Math.min(
    draft.assetIds.reduce((count, assetId) => (
      count + (assets.find((item) => item.id === assetId)?.reference_images.length ?? 0)
    ), 0),
    3,
  );

  return (
    <>
      <BindingSection
        id="shot-character-bindings"
        label={strings.charactersLabel}
        count={`${draft.characters.length} / ${characterOptions.length}`}
        disabled={!shot}
        empty={strings.noCharactersYet}
      >
        {characterOptions.map((character) => (
          <label key={character.id}>
            <input
              type="checkbox"
              checked={draft.characters.includes(character.id)}
              onChange={(event) => updateDraft((current) => ({
                ...current,
                characters: event.target.checked
                  ? [...current.characters, character.id]
                  : current.characters.filter((id) => id !== character.id),
              }))}
            />
            <span>{character.label}<small>{character.detail}</small></span>
          </label>
        ))}
      </BindingSection>

      <BindingSection
        id="shot-asset-bindings"
        label={strings.referenceAssetsLabel}
        count={`${draft.assetIds.length} / ${assetOptions.length}`}
        disabled={!shot}
        empty={strings.noSavedReferenceAssetsYet}
      >
        {assetOptions.map((asset) => (
          <label key={asset.id}>
            <input
              type="checkbox"
              checked={draft.assetIds.includes(asset.id)}
              onChange={(event) => updateDraft((current) => ({
                ...current,
                assetIds: event.target.checked
                  ? [...current.assetIds, asset.id]
                  : current.assetIds.filter((id) => id !== asset.id),
              }))}
            />
            <span>
              {asset.label}
              <small>{asset.kind ? strings.assetKindLabels[asset.kind] : strings.missingBindingLabel}</small>
            </span>
          </label>
        ))}
      </BindingSection>

      <div className={styles.generationMode} role="status" aria-live="polite">
        <Images aria-hidden="true" size={15} />
        <span>{referenceCount > 0 ? strings.imageToVideoMode(referenceCount) : strings.textToVideoMode}</span>
      </div>
    </>
  );
}

function BindingSection({
  children,
  count,
  disabled,
  empty,
  id,
  label,
}: {
  children: ReactNode;
  count: string;
  disabled: boolean;
  empty: string;
  id: string;
  label: string;
}) {
  const hasChildren = Children.count(children) > 0;
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHeading}>
        <h3 id={id}>{label}</h3>
        <span>{count}</span>
      </div>
      <fieldset className={styles.bindingGroup} disabled={disabled}>
        <legend className="sr-only">{label}</legend>
        {hasChildren ? <div className={styles.bindingOptions}>{children}</div> : <span className={styles.empty}>{empty}</span>}
      </fieldset>
    </section>
  );
}
