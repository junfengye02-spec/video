import { useEffect, useMemo, useRef, useState } from "react";
import {
  affectedSectionLabels,
  BLUEPRINT_SECTION_COPY,
  blueprintDocuments,
  PLAN_SECTION_IDS,
  planSectionsFor,
} from "../../components/blueprint/blueprintModel";
import {
  commandErrorFrom,
  type CommandError,
} from "../../components/feedback/DomainErrorBoundary";
import type {
  CreativeWorkflow,
  JobEvent,
  PlanSectionId,
  ShortDramaProjectResponse,
  TaskBatch,
  TaskListResponse,
} from "../../domain/types";
import { blueprintCopy as copy } from "./copy";

type SectionAction = { section: PlanSectionId; kind: "approve" | "revise" };
type ReviewAction = SectionAction | "final" | "cancel";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isCreativePlanConflict(error: unknown): boolean {
  if (!isRecord(error) || error.status !== 409) return false;
  const code = typeof error.code === "string" ? error.code : null;
  return code === "plan_section_revision_conflict" || code === "creative_plan_revision_conflict";
}

function workflowFor(snapshot: ShortDramaProjectResponse): CreativeWorkflow {
  return snapshot.creative_workflow ?? {
    phase: snapshot.storyboard.shots.length ? "approved" : "plan_review",
    messages: [],
    brief: null,
    ready_to_confirm: true,
    planned_asset_ids: [],
    approved_at: null,
  };
}

export interface BlueprintReviewOptions {
  snapshot: ShortDramaProjectResponse;
  approving: boolean;
  revising: boolean;
  updatingSection: PlanSectionId | null;
  onApprove: () => Promise<void>;
  onConfirmSection: (section: PlanSectionId, revision: number) => Promise<void>;
  onRequestChanges: (section: PlanSectionId, feedback: string, revision: number) => Promise<void>;
  onListTasks?: () => Promise<TaskListResponse>;
  onRetryTaskItem?: (taskId: string, itemId: string) => Promise<TaskBatch>;
  taskEvents?: JobEvent[];
  onSessionExpired?: () => void;
  walletAvailableUnits?: number | null;
  initialSection?: PlanSectionId;
  revisionMode?: boolean;
  onCancelRevision?: () => Promise<void>;
}

export function useBlueprintReview(options: BlueprintReviewOptions) {
  const {
    snapshot,
    approving,
    revising,
    updatingSection,
    onApprove,
    onConfirmSection,
    onRequestChanges,
    onSessionExpired,
    walletAvailableUnits = null,
  } = options;
  const workflow = workflowFor(snapshot);
  const sections = useMemo(() => planSectionsFor(workflow), [workflow]);
  const documents = useMemo(() => blueprintDocuments(snapshot), [snapshot]);
  const [activeSection, setActiveSection] = useState<PlanSectionId>(
    options.initialSection ?? "worldview",
  );
  const [drafts, setDrafts] = useState<Partial<Record<PlanSectionId, string>>>({});
  const [action, setAction] = useState<SectionAction | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [finalConfirmOpen, setFinalConfirmOpen] = useState(false);
  const [finalSubmitting, setFinalSubmitting] = useState(false);
  const [cancelingRevision, setCancelingRevision] = useState(false);
  const projectRef = useRef(snapshot.project.id);
  const generationRef = useRef(0);
  const actionRef = useRef<ReviewAction | null>(null);

  useEffect(() => {
    if (projectRef.current === snapshot.project.id) return;
    projectRef.current = snapshot.project.id;
    generationRef.current += 1;
    actionRef.current = null;
    setActiveSection(options.initialSection ?? "worldview");
    setDrafts({});
    setAction(null);
    setError(null);
    setFeedbackError(null);
    setNotice(null);
    setFeedbackOpen(false);
    setFinalConfirmOpen(false);
    setFinalSubmitting(false);
    setCancelingRevision(false);
  }, [options.initialSection, snapshot.project.id]);

  const approval = sections[activeSection];
  const document = documents[activeSection];
  const approvedCount = PLAN_SECTION_IDS.filter((section) => sections[section].status === "approved").length;
  const missingCount = PLAN_SECTION_IDS.length - approvedCount;
  const allApproved = missingCount === 0;
  const serverPending = approving || revising || updatingSection !== null;
  const interactionPending = serverPending || action !== null || cancelingRevision;
  const soundAffectsStoryboard = snapshot.series_bible.sound_plan?.storyboard_prompt_integration === true;
  const impactLabels = affectedSectionLabels(activeSection, soundAffectsStoryboard);
  const activeDraft = drafts[activeSection] ?? "";

  function selectSection(section: PlanSectionId) {
    setActiveSection(section);
    setFeedbackError(null);
    setError(null);
    setNotice(null);
    setFeedbackOpen(false);
  }

  function setDraft(value: string) {
    setDrafts((current) => ({ ...current, [activeSection]: value }));
    if (value.trim()) setFeedbackError(null);
  }

  function setCommandError(requestError: unknown, fallback: string) {
    if (isCreativePlanConflict(requestError)) {
      setError({
        kind: "message",
        message: "检测到此蓝图已在其他窗口更新。已载入服务端最新版本，你的反馈草稿仍保留，可核对新版本后重试。",
      });
      return;
    }
    setError(commandErrorFrom(requestError, { fallback, onSessionExpired, walletAvailableUnits }));
  }

  async function confirmSection() {
    if (actionRef.current || serverPending || approval.status === "approved") return;
    const pendingAction: SectionAction = { section: activeSection, kind: "approve" };
    const generation = generationRef.current;
    actionRef.current = pendingAction;
    setAction(pendingAction);
    setError(null);
    setNotice(null);
    try {
      await onConfirmSection(activeSection, approval.revision);
      if (generationRef.current === generation) {
        setNotice(`${BLUEPRINT_SECTION_COPY[activeSection].shortLabel}已确认。`);
      }
    } catch (requestError) {
      if (generationRef.current === generation) setCommandError(requestError, "无法确认当前蓝图分类。");
    } finally {
      if (actionRef.current === pendingAction && generationRef.current === generation) actionRef.current = null;
      if (generationRef.current === generation) setAction((current) => current === pendingAction ? null : current);
    }
  }

  async function requestChanges() {
    const feedback = activeDraft.trim();
    if (!feedback) {
      setFeedbackError(copy.feedbackRequired);
      return;
    }
    if (actionRef.current || serverPending) return;
    const pendingAction: SectionAction = { section: activeSection, kind: "revise" };
    const generation = generationRef.current;
    actionRef.current = pendingAction;
    setAction(pendingAction);
    setError(null);
    setNotice(null);
    try {
      await onRequestChanges(activeSection, feedback, approval.revision);
      if (generationRef.current === generation) {
        setNotice(`${BLUEPRINT_SECTION_COPY[activeSection].shortLabel}已按反馈更新，请确认最新版本。`);
        setFeedbackOpen(false);
      }
    } catch (requestError) {
      if (generationRef.current === generation) setCommandError(requestError, "无法修改当前蓝图分类，反馈草稿已保留。");
    } finally {
      if (actionRef.current === pendingAction && generationRef.current === generation) actionRef.current = null;
      if (generationRef.current === generation) setAction((current) => current === pendingAction ? null : current);
    }
  }

  async function approveFinal() {
    if (!allApproved || actionRef.current || serverPending) return;
    const generation = generationRef.current;
    actionRef.current = "final";
    setFinalSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      await onApprove();
      if (generationRef.current === generation) setFinalConfirmOpen(false);
    } catch (requestError) {
      if (generationRef.current === generation) setCommandError(requestError, "无法锁定当前蓝图版本。");
    } finally {
      if (actionRef.current === "final" && generationRef.current === generation) actionRef.current = null;
      if (generationRef.current === generation) setFinalSubmitting(false);
    }
  }

  async function cancelRevision() {
    if (!options.onCancelRevision || actionRef.current || serverPending) return;
    const generation = generationRef.current;
    actionRef.current = "cancel";
    setCancelingRevision(true);
    setError(null);
    setNotice(null);
    try {
      await options.onCancelRevision();
    } catch (requestError) {
      if (generationRef.current === generation) {
        setCommandError(requestError, "无法取消当前分镜修订。");
      }
    } finally {
      if (actionRef.current === "cancel" && generationRef.current === generation) {
        actionRef.current = null;
      }
      if (generationRef.current === generation) setCancelingRevision(false);
    }
  }

  return {
    ...options,
    action,
    activeDraft,
    activeSection,
    allApproved,
    approval,
    approvedCount,
    approveFinal,
    cancelRevision,
    cancelingRevision,
    confirmSection,
    document,
    documents,
    error,
    feedbackError,
    feedbackOpen,
    finalConfirmOpen,
    finalSubmitting,
    impactLabels,
    interactionPending,
    missingCount,
    notice,
    requestChanges,
    sectionApproving: action?.section === activeSection && action.kind === "approve",
    sectionRevising: action?.section === activeSection && action.kind === "revise",
    sections,
    selectSection,
    setDraft,
    setFeedbackOpen,
    setFinalConfirmOpen,
  };
}
