import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  commandErrorFrom,
  type CommandError,
} from "../../../components/feedback/DomainErrorBoundary";
import { orderedShots } from "../../../domain/storyboard";
import type {
  PromptOptimizeResponse,
  Shot,
  ShotContinuity,
  ShotLanguage,
  ShotSaveRequest,
} from "../../../domain/types";
import { getStrings } from "../../../i18n";
import {
  applyPromptOptimization,
  createShotDraftState,
  shotDraftIsDirty,
  toShotSaveRequest,
  undoPromptOptimization,
  type ShotDraftFields,
} from "./shotDraft";

export type StoryboardCommand = "optimize" | "save" | "regenerate";
export type CommandPhase = "idle" | "pending" | "success" | "error";

export interface CommandFeedbackState {
  phase: CommandPhase;
  error: CommandError | null;
}

export interface StoryboardControllerInput {
  projectId: string;
  shots: Shot[];
  selectedShotId: string | null;
  optimizingShotId: string | null;
  regeneratingShotId: string | null;
  savingShotId: string | null;
  onSelectShot: (shotId: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOptimizePrompt: (shot: Shot, sourceText: string) => Promise<PromptOptimizeResponse>;
  onSaveShot: (shotId: string, payload: ShotSaveRequest) => Promise<Shot>;
  onRegenerateShot: (shot: Shot, videoModel?: string) => Promise<void>;
  onSessionExpired?: () => void;
  walletAvailableUnits?: number | null;
}

const idleFeedback = (): CommandFeedbackState => ({ phase: "idle", error: null });

export function useStoryboardController({
  projectId,
  shots,
  selectedShotId,
  optimizingShotId,
  regeneratingShotId,
  savingShotId,
  onSelectShot,
  onDirtyChange,
  onOptimizePrompt,
  onSaveShot,
  onRegenerateShot,
  onSessionExpired,
  walletAvailableUnits = null,
}: StoryboardControllerInput) {
  const strings = getStrings("zh");
  const ordered = useMemo(() => orderedShots(shots), [shots]);
  const selectedShot = ordered.find((shot) => shot.id === selectedShotId) ?? ordered[0] ?? null;
  const optimizing = optimizingShotId === selectedShot?.id;
  const regenerating = regeneratingShotId === selectedShot?.id
    || selectedShot?.status === "generating";
  const saving = savingShotId === selectedShot?.id;
  const [draftState, setDraftState] = useState(() => createShotDraftState(projectId, selectedShot));
  const [optimizeFeedback, setOptimizeFeedback] = useState<CommandFeedbackState>(idleFeedback);
  const [saveFeedback, setSaveFeedback] = useState<CommandFeedbackState>(idleFeedback);
  const [regenerateFeedback, setRegenerateFeedback] = useState<CommandFeedbackState>(idleFeedback);
  const [regenerationDialogOpen, setRegenerationDialogOpen] = useState(false);
  const projectIdRef = useRef(projectId);
  const authoritativeVersionRef = useRef<number | null>(selectedShot?.version ?? null);
  const selectionRevisionRef = useRef(0);
  const optimizationRevisionRef = useRef(0);
  const commandLockRef = useRef<StoryboardCommand | null>(null);

  projectIdRef.current = projectId;

  useLayoutEffect(() => {
    selectionRevisionRef.current += 1;
    optimizationRevisionRef.current = 0;
    commandLockRef.current = null;
    authoritativeVersionRef.current = selectedShot?.version ?? null;
    setDraftState(createShotDraftState(projectId, selectedShot));
    setOptimizeFeedback(idleFeedback());
    setSaveFeedback(idleFeedback());
    setRegenerateFeedback(idleFeedback());
    setRegenerationDialogOpen(false);
  }, [projectId, selectedShot?.id]);

  useLayoutEffect(() => {
    if (!selectedShot || authoritativeVersionRef.current === selectedShot.version) return;
    authoritativeVersionRef.current = selectedShot.version;
    const authoritative = createShotDraftState(projectId, selectedShot);
    setDraftState((current) => {
      if (current.projectId !== projectId || current.shotId !== selectedShot.id) {
        return current;
      }
      const previousBaseline = current.baseline.continuity;
      const nextBaseline = authoritative.baseline.continuity;
      if (JSON.stringify(previousBaseline) === JSON.stringify(nextBaseline)) return current;
      const nextDraft = { ...current.draft.continuity };
      for (const key of Object.keys(nextBaseline) as Array<keyof ShotContinuity>) {
        if (JSON.stringify(previousBaseline[key]) === JSON.stringify(nextBaseline[key])) {
          continue;
        }
        if (JSON.stringify(current.draft.continuity[key]) === JSON.stringify(previousBaseline[key])) {
          Object.assign(nextDraft, { [key]: nextBaseline[key] });
        }
      }
      return {
        ...current,
        baseline: { ...current.baseline, continuity: nextBaseline },
        draft: { ...current.draft, continuity: nextDraft },
      };
    });
  }, [projectId, selectedShot?.id, selectedShot?.version]);

  const dirty = shotDraftIsDirty(draftState);
  useLayoutEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const anyCommandPending = optimizing
    || saving
    || regenerating
    || optimizeFeedback.phase === "pending"
    || saveFeedback.phase === "pending"
    || regenerateFeedback.phase === "pending";

  const updateDraft = useCallback((update: (draft: ShotDraftFields) => ShotDraftFields) => {
    setDraftState((current) => ({ ...current, draft: update(current.draft) }));
    setSaveFeedback((current) => current.phase === "pending" ? current : idleFeedback());
  }, []);

  const updateShotLanguage = useCallback(<Key extends keyof ShotLanguage>(
    key: Key,
    value: ShotLanguage[Key],
  ) => {
    updateDraft((draft) => ({
      ...draft,
      shotLanguage: { ...draft.shotLanguage, [key]: value ?? null },
    }));
  }, [updateDraft]);

  const selectShot = useCallback((shotId: string) => {
    if (shotId === selectedShot?.id) return false;
    if (dirty && !window.confirm(strings.storyboardPage.discardChangesConfirm)) return false;
    onSelectShot(shotId);
    return true;
  }, [dirty, onSelectShot, selectedShot?.id, strings.storyboardPage.discardChangesConfirm]);

  const optimize = useCallback(async () => {
    if (!selectedShot || commandLockRef.current || anyCommandPending) return;
    commandLockRef.current = "optimize";
    const capturedProjectId = projectId;
    const capturedRevision = selectionRevisionRef.current;
    setOptimizeFeedback({ phase: "pending", error: null });
    try {
      const optimized = await onOptimizePrompt(selectedShot, draftState.draft.prompt);
      if (
        projectIdRef.current !== capturedProjectId
        || selectionRevisionRef.current !== capturedRevision
      ) return;
      optimizationRevisionRef.current += 1;
      setDraftState((current) => (
        current.projectId === capturedProjectId && current.shotId === selectedShot.id
          ? applyPromptOptimization(current, optimized)
          : current
      ));
      setOptimizeFeedback({ phase: "success", error: null });
    } catch (error) {
      if (
        projectIdRef.current === capturedProjectId
        && selectionRevisionRef.current === capturedRevision
      ) {
        setOptimizeFeedback({
          phase: "error",
          error: commandErrorFrom(error, {
            fallback: strings.errors.optimizeShotFallback,
            onSessionExpired,
            walletAvailableUnits,
          }),
        });
      }
    } finally {
      if (commandLockRef.current === "optimize") commandLockRef.current = null;
    }
  }, [
    anyCommandPending,
    draftState.draft.prompt,
    onOptimizePrompt,
    onSessionExpired,
    projectId,
    selectedShot,
    strings.errors.optimizeShotFallback,
    walletAvailableUnits,
  ]);

  const undoOptimization = useCallback(() => {
    if (anyCommandPending) return;
    optimizationRevisionRef.current += 1;
    setDraftState((current) => undoPromptOptimization(current));
    setOptimizeFeedback(idleFeedback());
  }, [anyCommandPending]);

  const save = useCallback(async () => {
    if (!selectedShot || !dirty || commandLockRef.current || anyCommandPending) return;
    commandLockRef.current = "save";
    const capturedProjectId = projectId;
    const capturedRevision = selectionRevisionRef.current;
    const submittedDraft = draftState.draft;
    const payload = toShotSaveRequest(submittedDraft);
    const optimizationRevision = optimizationRevisionRef.current;
    setSaveFeedback({ phase: "pending", error: null });
    try {
      const savedShot = await onSaveShot(selectedShot.id, payload);
      if (
        projectIdRef.current !== capturedProjectId
        || selectionRevisionRef.current !== capturedRevision
      ) return;
      const savedState = createShotDraftState(capturedProjectId, savedShot);
      setDraftState((current) => {
        if (current.projectId !== capturedProjectId || current.shotId !== selectedShot.id) {
          return current;
        }
        const changedWhileSaving = shotDraftIsDirty({ ...current, baseline: submittedDraft });
        const optimizationChanged = optimizationRevisionRef.current !== optimizationRevision;
        return changedWhileSaving
          ? {
              ...savedState,
              draft: current.draft,
              undoOptimization: optimizationChanged ? current.undoOptimization : null,
            }
          : savedState;
      });
      setSaveFeedback({ phase: "success", error: null });
    } catch (error) {
      if (
        projectIdRef.current === capturedProjectId
        && selectionRevisionRef.current === capturedRevision
      ) {
        setSaveFeedback({
          phase: "error",
          error: commandErrorFrom(error, {
            fallback: strings.errors.saveShotFallback,
            onSessionExpired,
            walletAvailableUnits,
          }),
        });
      }
    } finally {
      if (commandLockRef.current === "save") commandLockRef.current = null;
    }
  }, [
    anyCommandPending,
    dirty,
    draftState.draft,
    onSaveShot,
    onSessionExpired,
    projectId,
    selectedShot,
    strings.errors.saveShotFallback,
    walletAvailableUnits,
  ]);

  const openRegenerationDialog = useCallback(() => {
    if (!selectedShot || anyCommandPending) return;
    setRegenerateFeedback(idleFeedback());
    setRegenerationDialogOpen(true);
  }, [anyCommandPending, selectedShot]);

  const closeRegenerationDialog = useCallback(() => {
    if (regenerating || regenerateFeedback.phase === "pending") return;
    setRegenerationDialogOpen(false);
  }, [regenerateFeedback.phase, regenerating]);

  const regenerate = useCallback(async (videoModel?: string) => {
    if (!selectedShot || commandLockRef.current || anyCommandPending) return;
    commandLockRef.current = "regenerate";
    const capturedProjectId = projectId;
    const capturedRevision = selectionRevisionRef.current;
    setRegenerateFeedback({ phase: "pending", error: null });
    try {
      await onRegenerateShot(selectedShot, videoModel);
      if (
        projectIdRef.current !== capturedProjectId
        || selectionRevisionRef.current !== capturedRevision
      ) return;
      setRegenerateFeedback({ phase: "success", error: null });
      setRegenerationDialogOpen(false);
    } catch (error) {
      if (
        projectIdRef.current === capturedProjectId
        && selectionRevisionRef.current === capturedRevision
      ) {
        if (error instanceof Error && error.message === strings.errors.regenerateShotTimeout) {
          setRegenerationDialogOpen(false);
        }
        setRegenerateFeedback({
          phase: "error",
          error: commandErrorFrom(error, {
            fallback: strings.errors.regenerateShotFallback(selectedShot.id),
            onSessionExpired,
            walletAvailableUnits,
          }),
        });
      }
    } finally {
      if (commandLockRef.current === "regenerate") commandLockRef.current = null;
    }
  }, [
    anyCommandPending,
    onRegenerateShot,
    onSessionExpired,
    projectId,
    regenerateFeedback.phase,
    selectedShot,
    strings.errors,
    walletAvailableUnits,
  ]);

  return {
    anyCommandPending,
    dirty,
    draftState,
    optimizing,
    optimizeFeedback,
    regenerating,
    regenerateFeedback,
    regenerationDialogOpen,
    saveFeedback,
    saving,
    selectedShot,
    shots: ordered,
    closeRegenerationDialog,
    openRegenerationDialog,
    optimize,
    regenerate,
    save,
    selectShot,
    undoOptimization,
    updateDraft,
    updateShotLanguage,
  };
}

export type StoryboardController = ReturnType<typeof useStoryboardController>;
