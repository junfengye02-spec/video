import type { Shot, ShotLanguage } from "../../../domain/types";
import type { UIStrings } from "../../../i18n";
import {
  CAMERA_MOVEMENTS,
  COLOR_TEMPERATURES,
  DEPTH_VALUES,
  LENS_VALUES,
  LIGHTING_KEYS,
  SHOT_SIZES,
} from "../model/cameraOptions";
import type { ShotDraftFields } from "../model/shotDraft";
import { SelectMenu } from "../../../shared/ui";
import styles from "./ShotInspector.module.css";

export function CameraControls({
  draft,
  shot,
  strings,
  updateShotLanguage,
}: {
  draft: ShotDraftFields;
  shot: Shot | null;
  strings: UIStrings["shotEditor"];
  updateShotLanguage: <Key extends keyof ShotLanguage>(key: Key, value: ShotLanguage[Key]) => void;
}) {
  return (
    <section className={styles.section} aria-labelledby="shot-language-fields">
      <h3 id="shot-language-fields">{strings.shotLanguageSectionTitle}</h3>
      <div className={styles.cameraGrid}>
        <SelectMenu disabled={!shot} label={strings.shotSizeLabel} value={draft.shotLanguage.shot_size ?? ""} onValueChange={(value) => updateShotLanguage("shot_size", (value as (typeof SHOT_SIZES)[number] | "") || null)} options={[{ value: "", label: strings.unspecifiedOption }, ...SHOT_SIZES.map((value) => ({ value, label: strings.shotSizeOptions[value] }))]} />
        <SelectMenu disabled={!shot} label={strings.cameraMovementLabel} value={draft.shotLanguage.camera_movement ?? ""} onValueChange={(value) => updateShotLanguage("camera_movement", (value as (typeof CAMERA_MOVEMENTS)[number] | "") || null)} options={[{ value: "", label: strings.unspecifiedOption }, ...CAMERA_MOVEMENTS.map((value) => ({ value, label: strings.cameraMovementOptions[value] }))]} />
        <SelectMenu disabled={!shot} label={strings.lensLabel} value={String(draft.shotLanguage.lens_mm ?? "")} onValueChange={(value) => updateShotLanguage("lens_mm", value ? Number(value) as ShotLanguage["lens_mm"] : null)} options={[{ value: "", label: strings.unspecifiedOption }, ...LENS_VALUES.map((value) => ({ value: String(value), label: strings.lensOptions[String(value) as keyof typeof strings.lensOptions] }))]} />
        <SelectMenu disabled={!shot} label={strings.lightingLabel} value={draft.shotLanguage.lighting_key ?? ""} onValueChange={(value) => updateShotLanguage("lighting_key", (value as (typeof LIGHTING_KEYS)[number] | "") || null)} options={[{ value: "", label: strings.unspecifiedOption }, ...LIGHTING_KEYS.map((value) => ({ value, label: strings.lightingOptions[value] }))]} />
        <SelectMenu disabled={!shot} label={strings.depthOfFieldLabel} value={draft.shotLanguage.depth_of_field ?? ""} onValueChange={(value) => updateShotLanguage("depth_of_field", (value as (typeof DEPTH_VALUES)[number] | "") || null)} options={[{ value: "", label: strings.unspecifiedOption }, ...DEPTH_VALUES.map((value) => ({ value, label: strings.depthOfFieldOptions[value] }))]} />
        <SelectMenu disabled={!shot} label={strings.colorTemperatureLabel} value={draft.shotLanguage.color_temperature ?? ""} onValueChange={(value) => updateShotLanguage("color_temperature", (value as (typeof COLOR_TEMPERATURES)[number] | "") || null)} options={[{ value: "", label: strings.unspecifiedOption }, ...COLOR_TEMPERATURES.map((value) => ({ value, label: strings.colorTemperatureOptions[value] }))]} />
      </div>
    </section>
  );
}
