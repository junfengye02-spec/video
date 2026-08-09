import { PLAN_SECTION_IDS } from "../../components/blueprint/blueprintModel";
import type { CreativeWorkflow, ShortDramaProjectResponse } from "../../domain/types";

export function creativeWorkflowFor(snapshot: ShortDramaProjectResponse): CreativeWorkflow {
  return snapshot.creative_workflow ?? {
    phase: snapshot.storyboard.shots.length ? "approved" : "inspiration",
    messages: [],
    brief: null,
    ready_to_confirm: false,
    planned_asset_ids: [],
    approved_at: null,
  };
}

export function workflowAllowsProduction(workflow: CreativeWorkflow): boolean {
  if (workflow.phase !== "approved") return false;
  if (!workflow.plan_sections) return true;
  return PLAN_SECTION_IDS.every((section) => workflow.plan_sections?.[section]?.status === "approved");
}

export function workflowHasActiveStoryboardRevision(workflow: CreativeWorkflow): boolean {
  return workflow.phase === "plan_review"
    && workflow.revision_session?.section === "storyboard";
}
