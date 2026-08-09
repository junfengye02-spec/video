import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  Character,
  ConsistencyReport,
  ContinuityPlan,
  CreativeWorkflow,
} from "../../../domain/types";
import { getStrings, type UIStrings } from "../../../i18n";
import type { ContinuityEditorStrings } from "../../../components/continuity/ContinuityEditor";
import { cloneContinuityPlan, sameContinuityPlan } from "./continuityPlan";

export interface ContinuityControllerProps {
  plan: ContinuityPlan;
  saving: boolean;
  characters?: Character[];
  consistencyReport?: ConsistencyReport | null;
  workflow?: CreativeWorkflow | null;
  strings?: ContinuityEditorStrings;
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (plan: ContinuityPlan) => Promise<void>;
}

export interface ContinuitySection {
  id: string;
  label: string;
}

export function useContinuityController({
  plan,
  saving,
  characters = [],
  consistencyReport = null,
  workflow = null,
  strings = getStrings("zh"),
  onDirtyChange,
  onSave,
}: ContinuityControllerProps) {
  const pageStrings = (strings as UIStrings).globalSettings;
  const [draft, setDraft] = useState(() => cloneContinuityPlan(plan));
  const [baseline, setBaseline] = useState(() => cloneContinuityPlan(plan));
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [submitting, setSubmitting] = useState(false);
  const planGenerationRef = useRef(0);
  const submittingRef = useRef(false);
  const pendingSubmissionRef = useRef<ContinuityPlan | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirty = !sameContinuityPlan(draft, baseline);
  const savePending = saving || submitting;

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useLayoutEffect(() => {
    const incoming = cloneContinuityPlan(plan);
    const pending = pendingSubmissionRef.current;
    const hasNewerDraft = Boolean(pending && !sameContinuityPlan(draftRef.current, pending));
    planGenerationRef.current += 1;
    setBaseline(incoming);
    if (!hasNewerDraft) setDraft(incoming);
    setError(null);
  }, [plan]);

  const save = async () => {
    if (savePending || submittingRef.current || !dirty) return;
    const submitted = cloneContinuityPlan(draftRef.current);
    const submissionGeneration = planGenerationRef.current;
    submittingRef.current = true;
    pendingSubmissionRef.current = submitted;
    setSubmitting(true);
    setSaveState("saving");
    setError(null);
    try {
      await onSave(submitted);
      if (submissionGeneration === planGenerationRef.current) setBaseline(submitted);
      setSaveState("saved");
    } catch (saveError) {
      if (submissionGeneration === planGenerationRef.current) {
        setError(saveError instanceof Error && saveError.message ? saveError.message : pageStrings.saveError);
      }
      setSaveState("idle");
    } finally {
      pendingSubmissionRef.current = null;
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const sections: ContinuitySection[] = [
    { id: "settings-worldview", label: pageStrings.worldviewTitle },
    { id: "settings-characters", label: pageStrings.charactersTitle },
    { id: "settings-visual", label: pageStrings.visualRulesTitle },
    { id: "settings-sound", label: pageStrings.soundTitle },
    { id: "settings-generation", label: pageStrings.generationPreferencesTitle },
    ...(draft.project_type === "single_video"
      ? []
      : [{ id: "settings-episodes", label: pageStrings.episodePlanningTitle }]),
  ];

  const goToSection = (id: string) => {
    const section = document.getElementById(id);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    section?.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    document.getElementById(`${id}-title`)?.focus();
  };

  const updateDraft = (next: ContinuityPlan) => {
    setDraft(next);
    if (saveState === "saved") setSaveState("idle");
  };
  const statusMessage = savePending
    ? pageStrings.saving
    : saveState === "saved" && !dirty
      ? pageStrings.saved
      : dirty ? pageStrings.unsaved : null;

  return {
    pageStrings,
    draft,
    resetVersion: planGenerationRef.current,
    error,
    dirty,
    savePending,
    statusMessage,
    sections,
    characters,
    consistencyReport,
    workflow,
    strings,
    goToSection,
    updateDraft,
    save,
  };
}
