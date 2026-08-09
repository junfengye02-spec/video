import { describe, expect, it } from "vitest";
import { createProjectResponse } from "../../test/fixtures";
import { creativeWorkflowFor, workflowAllowsProduction } from "./workflowModel";

describe("workflow route model", () => {
  it("keeps legacy planned projects available while enforcing explicit section approvals", () => {
    const snapshot = createProjectResponse();
    const legacy = creativeWorkflowFor(snapshot);
    expect(legacy.phase).toBe("approved");
    expect(workflowAllowsProduction(legacy)).toBe(true);

    snapshot.creative_workflow = {
      ...legacy,
      plan_sections: {
        worldview: { status: "approved", revision: 1, feedback: null, updated_at: null },
        characters: { status: "approved", revision: 1, feedback: null, updated_at: null },
        scenes: { status: "approved", revision: 1, feedback: null, updated_at: null },
        props: { status: "approved", revision: 1, feedback: null, updated_at: null },
        sound: { status: "changes_requested", revision: 1, feedback: "调整", updated_at: null },
        storyboard: { status: "approved", revision: 1, feedback: null, updated_at: null },
      },
    };
    expect(workflowAllowsProduction(creativeWorkflowFor(snapshot))).toBe(false);
  });
});
