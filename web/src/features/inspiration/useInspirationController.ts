import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  commandErrorFrom,
  type CommandError,
} from "../../components/feedback/DomainErrorBoundary";
import type {
  CreativeBrief,
  CreativeWorkflow,
  InspirationMessage,
} from "../../domain/types";

type ErrorOrigin = "develop" | "plan";

const DRAFT_STORAGE_PREFIX = "openmontage.inspirationDraft:";
const MODEL_STORAGE_PREFIX = "openmontage.inspirationTextModel:";

function readSessionDraft(sessionKey: string): string {
  try {
    return window.sessionStorage.getItem(`${DRAFT_STORAGE_PREFIX}${sessionKey}`) ?? "";
  } catch {
    return "";
  }
}

function writeSessionDraft(sessionKey: string, value: string) {
  try {
    const key = `${DRAFT_STORAGE_PREFIX}${sessionKey}`;
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Draft persistence is best-effort when browser storage is unavailable.
  }
}

function readSessionModel(sessionKey: string, fallback: string): string {
  try {
    return window.sessionStorage.getItem(`${MODEL_STORAGE_PREFIX}${sessionKey}`)?.trim() || fallback;
  } catch {
    return fallback;
  }
}

function writeSessionModel(sessionKey: string, value: string) {
  try {
    window.sessionStorage.setItem(`${MODEL_STORAGE_PREFIX}${sessionKey}`, value);
  } catch {
    // Model persistence is best-effort when browser storage is unavailable.
  }
}

export interface InspirationControllerOptions {
  workflow: CreativeWorkflow;
  initialMessage: string;
  initialTextModel: string;
  sessionKey: string;
  developing: boolean;
  planning: boolean;
  onDevelop: (messages: InspirationMessage[], textModel: string) => Promise<void>;
  onInitialMessageConsumed?: () => void;
  onPlan: (brief: CreativeBrief, controlEndFrames: boolean, textModel: string) => Promise<void>;
  onUpdateEndFrameIntent: (enabled: boolean) => Promise<void>;
  onSessionExpired?: () => void;
  walletAvailableUnits?: number | null;
}

export function useInspirationController({
  workflow,
  initialMessage,
  initialTextModel,
  sessionKey,
  developing,
  planning,
  onDevelop,
  onInitialMessageConsumed,
  onPlan,
  onUpdateEndFrameIntent,
  onSessionExpired,
  walletAvailableUnits = null,
}: InspirationControllerOptions) {
  const normalizedInitial = initialMessage.trim();
  const normalizedInitialTextModel = initialTextModel.trim() || "gpt-5.5";
  const sessionRef = useRef(sessionKey);
  const sessionGenerationRef = useRef(0);
  const initialStartedRef = useRef<string | null>(null);
  const developRequestRef = useRef<Promise<void> | null>(null);
  const planRequestRef = useRef<Promise<void> | null>(null);
  const intentRequestRef = useRef<Promise<void> | null>(null);
  const [message, setMessage] = useState(() => readSessionDraft(sessionKey));
  const [textModel, setTextModel] = useState(() => (
    readSessionModel(sessionKey, normalizedInitialTextModel)
  ));
  const [optimisticInitial, setOptimisticInitial] = useState(
    normalizedInitial && workflow.messages.length === 0 ? normalizedInitial : "",
  );
  const [optimisticMessage, setOptimisticMessage] = useState("");
  const [developingLocally, setDevelopingLocally] = useState(false);
  const [planningLocally, setPlanningLocally] = useState(false);
  const [intentSaving, setIntentSaving] = useState(false);
  const [controlEndFrames, setControlEndFramesState] = useState(
    workflow.control_end_frames === true,
  );
  const [planSubmitted, setPlanSubmitted] = useState(false);
  const [error, setError] = useState<CommandError | null>(null);
  const [errorOrigin, setErrorOrigin] = useState<ErrorOrigin | null>(null);

  useEffect(() => {
    if (sessionRef.current === sessionKey) return;
    sessionRef.current = sessionKey;
    sessionGenerationRef.current += 1;
    initialStartedRef.current = null;
    developRequestRef.current = null;
    planRequestRef.current = null;
    intentRequestRef.current = null;
    setMessage(readSessionDraft(sessionKey));
    setTextModel(readSessionModel(sessionKey, normalizedInitialTextModel));
    setOptimisticInitial(normalizedInitial && workflow.messages.length === 0 ? normalizedInitial : "");
    setOptimisticMessage("");
    setDevelopingLocally(false);
    setPlanningLocally(false);
    setIntentSaving(false);
    setControlEndFramesState(workflow.control_end_frames === true);
    setPlanSubmitted(false);
    setError(null);
    setErrorOrigin(null);
  }, [normalizedInitial, normalizedInitialTextModel, sessionKey, workflow.messages.length]);

  useEffect(() => {
    writeSessionModel(sessionKey, textModel);
  }, [sessionKey, textModel]);

  useEffect(() => {
    if (!intentRequestRef.current) {
      setControlEndFramesState(workflow.control_end_frames === true);
    }
  }, [workflow.control_end_frames]);

  function updateMessage(value: string | ((current: string) => string)) {
    setMessage((current) => {
      const next = typeof value === "function" ? value(current) : value;
      writeSessionDraft(sessionRef.current, next);
      return next;
    });
  }

  useEffect(() => {
    if (workflow.messages.length) setOptimisticInitial("");
    if (
      optimisticMessage
      && workflow.messages.some((item) => item.role === "user" && item.content === optimisticMessage)
    ) {
      setOptimisticMessage("");
    }
  }, [optimisticMessage, workflow.messages]);

  useEffect(() => {
    const content = normalizedInitial;
    const startedKey = `${sessionKey}:${content}`;
    if (!content || workflow.messages.length || initialStartedRef.current === startedKey) return;
    initialStartedRef.current = startedKey;
    const generation = sessionGenerationRef.current;
    writeSessionDraft(sessionKey, content);
    onInitialMessageConsumed?.();
    setDevelopingLocally(true);
    const request = onDevelop([{ role: "user", content }], textModel);
    developRequestRef.current = request;
    void request
      .then(() => {
        writeSessionDraft(sessionKey, "");
        if (sessionGenerationRef.current === generation) setOptimisticInitial("");
      })
      .catch((requestError) => {
        if (sessionGenerationRef.current !== generation) return;
        setOptimisticInitial("");
        updateMessage(content);
        setErrorOrigin("develop");
        setError(commandErrorFrom(requestError, {
          fallback: "无法继续灵感对话。",
          onSessionExpired,
          walletAvailableUnits,
        }));
      })
      .finally(() => {
        if (developRequestRef.current === request && sessionGenerationRef.current === generation) {
          developRequestRef.current = null;
          setDevelopingLocally(false);
        }
      });
  }, [
    normalizedInitial,
    onDevelop,
    onInitialMessageConsumed,
    onSessionExpired,
    sessionKey,
    textModel,
    walletAvailableUnits,
    workflow.messages.length,
  ]);

  const visibleMessages = useMemo<InspirationMessage[]>(() => {
    const messages = workflow.messages.length
      ? [...workflow.messages]
      : optimisticInitial
        ? [{ role: "user" as const, content: optimisticInitial }]
        : [];
    if (
      optimisticMessage
      && !messages.some((item) => item.role === "user" && item.content === optimisticMessage)
    ) {
      messages.push({ role: "user", content: optimisticMessage });
    }
    return messages;
  }, [optimisticInitial, optimisticMessage, workflow.messages]);

  const developingLocked = developing || developingLocally;
  const planningLocked = planning || planningLocally || planSubmitted;

  async function submitMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const content = message.trim();
    if (
      !content
      || developingLocked
      || planningLocked
      || intentSaving
      || developRequestRef.current
    ) return;
    const generation = sessionGenerationRef.current;
    setError(null);
    setErrorOrigin(null);
    setDevelopingLocally(true);
    setOptimisticMessage(content);
    writeSessionDraft(sessionKey, content);
    setMessage("");
    const request = onDevelop([...workflow.messages, { role: "user", content }], textModel);
    developRequestRef.current = request;
    try {
      await request;
      writeSessionDraft(sessionKey, "");
    } catch (requestError) {
      if (sessionGenerationRef.current !== generation) return;
      setOptimisticMessage("");
      updateMessage((current) => current || content);
      setErrorOrigin("develop");
      setError(commandErrorFrom(requestError, {
        fallback: "无法继续灵感对话。",
        onSessionExpired,
        walletAvailableUnits,
      }));
    } finally {
      if (developRequestRef.current === request && sessionGenerationRef.current === generation) {
        developRequestRef.current = null;
        setDevelopingLocally(false);
      }
    }
  }

  async function submitPlan() {
    if (
      !workflow.brief
      || !workflow.ready_to_confirm
      || planningLocked
      || intentSaving
      || planRequestRef.current
    ) return;
    const generation = sessionGenerationRef.current;
    setError(null);
    setErrorOrigin(null);
    setPlanningLocally(true);
    const request = onPlan(workflow.brief, controlEndFrames, textModel);
    planRequestRef.current = request;
    try {
      await request;
      if (sessionGenerationRef.current === generation) setPlanSubmitted(true);
    } catch (requestError) {
      if (sessionGenerationRef.current !== generation) return;
      setErrorOrigin("plan");
      setError(commandErrorFrom(requestError, {
        fallback: "无法生成创作方案。",
        onSessionExpired,
        walletAvailableUnits,
      }));
    } finally {
      if (planRequestRef.current === request && sessionGenerationRef.current === generation) {
        planRequestRef.current = null;
        setPlanningLocally(false);
      }
    }
  }

  async function setControlEndFrames(enabled: boolean) {
    if (intentSaving || intentRequestRef.current || enabled === controlEndFrames) return;
    const generation = sessionGenerationRef.current;
    const previous = controlEndFrames;
    setControlEndFramesState(enabled);
    setIntentSaving(true);
    setError(null);
    setErrorOrigin(null);
    const request = onUpdateEndFrameIntent(enabled);
    intentRequestRef.current = request;
    try {
      await request;
    } catch (requestError) {
      if (sessionGenerationRef.current !== generation) return;
      setControlEndFramesState(previous);
      setErrorOrigin("plan");
      setError(commandErrorFrom(requestError, {
        fallback: "无法保存首尾画面设置。",
        onSessionExpired,
        walletAvailableUnits,
      }));
    } finally {
      if (intentRequestRef.current === request && sessionGenerationRef.current === generation) {
        intentRequestRef.current = null;
        setIntentSaving(false);
      }
    }
  }

  return {
    controlEndFrames,
    developingLocked,
    error,
    errorOrigin,
    message,
    intentSaving,
    planningLocked,
    planSubmitted,
    setMessage: updateMessage,
    setControlEndFrames,
    submitMessage,
    submitPlan,
    textModel,
    visibleMessages,
    setTextModel,
  };
}
