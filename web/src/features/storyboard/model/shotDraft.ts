import type {
  PromptOptimizeResponse,
  Shot,
  ShotContinuity,
  ShotLanguage,
  ShotSaveRequest,
} from "../../../domain/types";

export interface ShotDraftFields {
  episodeNumber: number | null;
  prompt: string;
  characters: string[];
  location: string;
  props: string;
  assetIds: string[];
  shotIntent: string;
  shotLanguage: ShotLanguage;
  continuity: ShotContinuity;
}

export interface PromptOptimizationUndo {
  prompt: string;
  shotIntent: string;
  shotLanguage: ShotLanguage;
}

export interface ShotDraftState {
  projectId: string;
  shotId: string | null;
  baseline: ShotDraftFields;
  draft: ShotDraftFields;
  undoOptimization: PromptOptimizationUndo | null;
}

function cloneFields(value: ShotDraftFields): ShotDraftFields {
  return {
    ...value,
    characters: [...value.characters],
    assetIds: [...value.assetIds],
    shotLanguage: { ...value.shotLanguage },
    continuity: {
      ...value.continuity,
      first_frame: value.continuity.first_frame
        ? { ...value.continuity.first_frame }
        : null,
      last_frame: value.continuity.last_frame
        ? { ...value.continuity.last_frame }
        : null,
    },
  };
}

function optimizationFields(value: ShotDraftFields): PromptOptimizationUndo {
  return {
    prompt: value.prompt,
    shotIntent: value.shotIntent,
    shotLanguage: { ...value.shotLanguage },
  };
}

export function fieldsFromShot(shot: Shot | null): ShotDraftFields {
  return {
    episodeNumber: shot?.episode_number ?? null,
    prompt: shot?.prompt ?? "",
    characters: [...(shot?.characters ?? [])],
    location: shot?.location ?? "",
    props: (shot?.props ?? []).join(", "),
    assetIds: [...(shot?.asset_ids ?? [])],
    shotIntent: shot?.shot_intent ?? "",
    shotLanguage: { ...(shot?.shot_language ?? {}) },
    continuity: {
      mode: shot?.continuity?.mode ?? "cut",
      inherit_previous_tail: shot?.continuity?.inherit_previous_tail ?? false,
      explicit_user_first_frame_asset_id:
        shot?.continuity?.explicit_user_first_frame_asset_id ?? null,
      inherited_first_frame_asset_id:
        shot?.continuity?.inherited_first_frame_asset_id ?? null,
      last_frame_asset_id: shot?.continuity?.last_frame_asset_id ?? null,
      first_frame: shot?.continuity?.first_frame
        ? { ...shot.continuity.first_frame }
        : null,
      last_frame: shot?.continuity?.last_frame
        ? { ...shot.continuity.last_frame }
        : null,
      stale: shot?.continuity?.stale ?? false,
      composition: shot?.continuity?.composition ?? "",
      subject_pose: shot?.continuity?.subject_pose ?? "",
      gaze: shot?.continuity?.gaze ?? "",
      motion_direction: shot?.continuity?.motion_direction ?? "",
      lighting: shot?.continuity?.lighting ?? "",
      scene_state: shot?.continuity?.scene_state ?? "",
    },
  };
}

export function createShotDraftState(projectId: string, shot: Shot | null): ShotDraftState {
  const baseline = fieldsFromShot(shot);
  return {
    projectId,
    shotId: shot?.id ?? null,
    baseline,
    draft: cloneFields(baseline),
    undoOptimization: null,
  };
}

export function applyPromptOptimization(
  state: ShotDraftState,
  response: PromptOptimizeResponse,
): ShotDraftState {
  return {
    ...state,
    undoOptimization: optimizationFields(state.draft),
    draft: {
      ...state.draft,
      prompt: response.optimized_text,
      shotIntent: response.shot_intent ?? state.draft.shotIntent,
      shotLanguage: response.shot_language
        ? { ...state.draft.shotLanguage, ...response.shot_language }
        : state.draft.shotLanguage,
    },
  };
}

export function undoPromptOptimization(state: ShotDraftState): ShotDraftState {
  if (!state.undoOptimization) return state;
  return {
    ...state,
    draft: {
      ...state.draft,
      prompt: state.undoOptimization.prompt,
      shotIntent: state.undoOptimization.shotIntent,
      shotLanguage: { ...state.undoOptimization.shotLanguage },
    },
    undoOptimization: null,
  };
}

export function shotDraftIsDirty(state: ShotDraftState): boolean {
  return JSON.stringify(state.draft) !== JSON.stringify(state.baseline);
}

export function toShotSaveRequest(draft: ShotDraftFields): ShotSaveRequest {
  return {
    episode_number: draft.episodeNumber,
    prompt: draft.prompt,
    characters: draft.characters,
    location: draft.location.trim() || null,
    props: draft.props
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    asset_ids: draft.assetIds,
    shot_intent: draft.shotIntent.trim() || null,
    shot_language: draft.shotLanguage,
    continuity: draft.continuity,
  };
}
