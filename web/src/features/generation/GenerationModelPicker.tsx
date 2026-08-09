import { useEffect, useId, useState } from "react";
import type {
  GenerationCapability,
  GenerationModelsResponse,
  VideoModelProfile,
} from "../../domain/types";
import { generationService } from "./GenerationService";
import { SelectMenu } from "../../shared/ui";
import styles from "./GenerationModelPicker.module.css";

export interface GenerationModelPickerStrings {
  loading: string;
  loadError: string;
  empty: string;
  refresh: string;
  unconfiguredDuration: string;
  fixedDuration: (seconds: number) => string;
  supportedDurations: (seconds: number[]) => string;
  flexibleDuration: (minimum: number | null, maximum: number | null) => string;
  frameCapabilityBoth: string;
  frameCapabilityStart: string;
  frameCapabilityEnd: string;
  frameCapabilityNone: string;
}

export interface GenerationModelPickerProps {
  capability: GenerationCapability;
  compact?: boolean;
  disabled?: boolean;
  label: string;
  required?: boolean;
  strings: GenerationModelPickerStrings;
  value: string;
  loadModels?: (capability: GenerationCapability) => Promise<GenerationModelsResponse>;
  onChange: (value: string) => void;
  onAvailabilityChange?: (available: boolean | null) => void;
}

const defaultLoadModels = (capability: GenerationCapability) => (
  Promise.resolve().then(() => generationService.listModels(capability))
);

export function GenerationModelPicker({
  capability,
  compact = false,
  disabled = false,
  label,
  required = false,
  strings,
  value,
  loadModels = defaultLoadModels,
  onChange,
  onAvailabilityChange,
}: GenerationModelPickerProps) {
  const statusId = useId();
  const [models, setModels] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<VideoModelProfile[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true;
    setStatus("loading");
    void loadModels(capability).then((response) => {
      if (!active) return;
      if (response.capability !== capability || !Array.isArray(response.models)) {
        throw new Error("Invalid generation model catalog");
      }
      setModels(response.models);
      setProfiles(Array.isArray(response.profiles) ? response.profiles : []);
      setStatus("ready");
    }).catch(() => {
      if (!active) return;
      setModels([]);
      setProfiles([]);
      setStatus("error");
    });
    return () => {
      active = false;
    };
  }, [capability, loadModels]);

  const statusText = status === "loading"
    ? strings.loading
    : status === "error"
      ? strings.loadError
      : models.length
        ? null
        : strings.empty;
  const options = value && !models.includes(value)
    ? [value, ...models]
    : models;
  const selectedProfiles = profiles.filter((profile) => profile.model_id === value);
  const profileText = capability === "video" && status === "ready"
    ? profileSummary(selectedProfiles, strings)
    : null;

  useEffect(() => {
    if (!onAvailabilityChange) return;
    if (capability !== "video" || status !== "ready") {
      onAvailabilityChange(null);
      return;
    }
    onAvailabilityChange(configuredVideoProfile(value, profiles));
  }, [capability, onAvailabilityChange, profiles, status, value]);

  return (
    <div className={styles.root} data-compact={compact} data-status={status}>
      {models.length ? (
        <SelectMenu
          compact={compact}
          disabled={disabled}
          label={label}
          onValueChange={onChange}
          options={options.map((model) => ({
            disabled: capability === "video" && !configuredVideoProfile(model, profiles),
            label: capability === "video"
              ? modelOptionLabel(model, profiles, strings)
              : model,
            value: model,
          }))}
          placement="auto"
          required={required}
          value={value}
        />
      ) : (
        <label>
          <span>{label}</span>
          <input
            required={required}
            disabled={disabled}
            value={value}
            aria-describedby={statusId}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      )}
      {statusText ? (
        <small id={statusId} className={styles.status} aria-live="polite">
          {statusText}
        </small>
      ) : null}
      {profileText ? <small className={styles.status} aria-live="polite">{profileText}</small> : null}
    </div>
  );
}

function modelOptionLabel(
  model: string,
  profiles: VideoModelProfile[],
  strings: GenerationModelPickerStrings,
): string {
  const textProfile = profiles.find((profile) => (
    profile.model_id === model && profile.operation === "text_to_video"
  ));
  return `${model} · ${textProfile
    ? durationSummary(textProfile, strings)
    : strings.unconfiguredDuration}`;
}

function profileSummary(
  profiles: VideoModelProfile[],
  strings: GenerationModelPickerStrings,
): string {
  if (!profiles.length) return strings.unconfiguredDuration;
  const textProfile = profiles.find((profile) => profile.operation === "text_to_video")
    ?? profiles[0];
  const firstLast = profiles.some((profile) => (
    profile.operation === "first_last_frame_to_video"
    && profile.supports_start_frame
    && profile.supports_end_frame
  ));
  const start = profiles.some((profile) => profile.supports_start_frame);
  const end = profiles.some((profile) => profile.supports_end_frame);
  const frameCapability = firstLast
    ? strings.frameCapabilityBoth
    : start
      ? strings.frameCapabilityStart
      : end
        ? strings.frameCapabilityEnd
        : strings.frameCapabilityNone;
  return `${durationSummary(textProfile, strings)} · ${frameCapability}`;
}

function configuredVideoProfile(model: string, profiles: VideoModelProfile[]): boolean {
  const profile = profiles.find((candidate) => (
    candidate.model_id === model && candidate.operation === "text_to_video"
  )) ?? profiles.find((candidate) => candidate.model_id === model);
  return Boolean(
    profile
    && profile.duration_configuration_status !== "unconfigured"
    && profile.duration_mode !== "unknown",
  );
}

function durationSummary(
  profile: VideoModelProfile,
  strings: GenerationModelPickerStrings,
): string {
  if (
    profile.duration_configuration_status === "unconfigured"
    || profile.duration_mode === "unknown"
  ) {
    return strings.unconfiguredDuration;
  }
  if (profile.duration_mode === "fixed") {
    return profile.fixed_duration_seconds === null
      ? strings.unconfiguredDuration
      : strings.fixedDuration(profile.fixed_duration_seconds);
  }
  if (profile.duration_mode === "supported_values") {
    return strings.supportedDurations(profile.supported_duration_seconds);
  }
  if (profile.duration_mode === "flexible") {
    return strings.flexibleDuration(
      profile.min_duration_seconds,
      profile.max_duration_seconds,
    );
  }
  return strings.unconfiguredDuration;
}
