import type { PromptOptimizeResponse, Shot, ShotLanguage, ShotSaveRequest } from "../../domain/types";

export interface ShotDraftFields {
  prompt: string;
  characters: string[];
  location: string;
  props: string;
  assetIds: string[];
  shotIntent: string;
  shotLanguage: ShotLanguage;
}

export interface PromptOptimizationUndo {
  prompt: string;
  shotIntent: string;
  shotLanguage: ShotLanguage;
}

export interface ShotDraftState {
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
    prompt: shot?.prompt ?? "",
    characters: [...(shot?.characters ?? [])],
    location: shot?.location ?? "",
    props: (shot?.props ?? []).join(", "),
    assetIds: [...(shot?.asset_ids ?? [])],
    shotIntent: shot?.shot_intent ?? "",
    shotLanguage: { ...(shot?.shot_language ?? {}) },
  };
}

export function createShotDraftState(shot: Shot | null): ShotDraftState {
  const baseline = fieldsFromShot(shot);
  return { shotId: shot?.id ?? null, baseline, draft: cloneFields(baseline), undoOptimization: null };
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
  };
}
