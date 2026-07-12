import { describe, expect, it } from "vitest";
import type { JobEvent, ShortDramaProjectResponse } from "../../domain/types";
import { createProjectResponse } from "../../test/fixtures";
import {
  initialWorkbenchState,
  reduceWorkbench,
  type OperationToken,
  type WorkbenchState,
} from "./reducer";

function project(id: string, title = id): ShortDramaProjectResponse {
  const snapshot = createProjectResponse();
  snapshot.project = { ...snapshot.project, id, title };
  snapshot.storyboard.shots = snapshot.storyboard.shots.map((shot, index) => ({
    ...shot,
    id: `${id}-shot-${index + 1}`,
    prompt: `${title} shot ${index + 1}`,
  }));
  return snapshot;
}

function token(
  projectId: string,
  kind: OperationToken["kind"],
  generation = 1,
): OperationToken {
  return { projectId, kind, generation };
}

function event(projectId: string, id = "event-1"): JobEvent {
  return {
    id,
    job_id: id,
    project_id: projectId,
    stage: "render",
    status: "complete",
    message: "complete",
    created_at: "2026-07-12T08:00:00Z",
  };
}

function stateFor(projectId: string, generation = 1): WorkbenchState {
  const snapshot = project(projectId, projectId);
  return {
    ...initialWorkbenchState,
    snapshot,
    selectedShotId: snapshot.storyboard.shots[0].id,
    load: "ready",
    operations: {
      render: token(projectId, "render", generation),
    },
  };
}

describe("workbench reducer", () => {
  it("opens a project and selects its first shot", () => {
    const open = token("p1", "open");
    const opened = reduceWorkbench(initialWorkbenchState, { type: "openStarted", token: open });
    const snapshot = project("p1", "Rain Alley");

    const ready = reduceWorkbench(opened, {
      type: "openSucceeded",
      token: open,
      snapshot,
    });

    expect(ready.load).toBe("ready");
    expect(ready.snapshot?.project.id).toBe("p1");
    expect(ready.selectedShotId).toBe("p1-shot-1");
    expect(ready.operations.open).toBeUndefined();
  });

  it("represents missing and stale opens explicitly", () => {
    const missingToken = token("missing", "open");
    const missing = reduceWorkbench(
      reduceWorkbench(initialWorkbenchState, { type: "openStarted", token: missingToken }),
      { type: "openMissing", token: missingToken },
    );
    expect(missing.load).toBe("missing");
    expect(missing.snapshot).toBeNull();

    const staleToken = token("p1", "open", 2);
    const stale = reduceWorkbench(
      reduceWorkbench(missing, { type: "openStarted", token: staleToken }),
      {
        type: "openSucceeded",
        token: staleToken,
        snapshot: project("p1"),
        stale: true,
      },
    );
    expect(stale.load).toBe("stale");
    expect(stale.snapshot?.project.id).toBe("p1");
  });

  it("ignores stale operation tokens", () => {
    const stale = reduceWorkbench(stateFor("p2", 2), {
      type: "operationSucceeded",
      token: { projectId: "p1", kind: "render", generation: 1 },
      snapshot: project("p1"),
    });

    expect(stale.snapshot?.project.id).toBe("p2");
    expect(stale.operations.render).toEqual(token("p2", "render", 2));
  });

  it("tracks operation start, success, failure, and duplicate events", () => {
    const saveToken = token("p1", "save-shot");
    const started = reduceWorkbench(
      { ...initialWorkbenchState, snapshot: project("p1"), load: "ready" },
      { type: "operationStarted", token: saveToken },
    );
    expect(started.operations["save-shot"]).toEqual(saveToken);
    expect(started.error).toBeNull();

    const savedSnapshot = project("p1");
    savedSnapshot.storyboard.shots[0].prompt = "Saved prompt";
    const saved = reduceWorkbench(started, {
      type: "operationSucceeded",
      token: saveToken,
      snapshot: savedSnapshot,
      event: event("p1", "save-event"),
      selectedShotId: "p1-shot-1",
    });
    const deduped = reduceWorkbench(saved, {
      type: "eventReceived",
      event: event("p1", "save-event"),
    });

    expect(saved.snapshot?.storyboard.shots[0].prompt).toBe("Saved prompt");
    expect(deduped.events).toHaveLength(1);
    expect(saved.operations["save-shot"]).toBeUndefined();

    const failToken = token("p1", "optimize", 2);
    const failed = reduceWorkbench(
      reduceWorkbench(saved, { type: "operationStarted", token: failToken }),
      { type: "operationFailed", token: failToken, error: "optimization failed" },
    );
    expect(failed.error).toBe("optimization failed");
    expect(failed.snapshot?.storyboard.shots[0].prompt).toBe("Saved prompt");
  });

  it("merges a render result without overwriting a concurrent shot save", () => {
    const current = project("p1");
    const renderToken = token("p1", "render");
    const rendering = reduceWorkbench(
      { ...initialWorkbenchState, snapshot: current, load: "ready" },
      { type: "operationStarted", token: renderToken },
    );
    const saved = project("p1");
    saved.storyboard.shots[0].prompt = "Concurrent save survived";
    const afterSave = {
      ...rendering,
      snapshot: saved,
      selectedShotId: "p1-shot-1",
    };
    const renderSnapshot = project("p1");
    renderSnapshot.storyboard.shots[0].prompt = "Stale render storyboard";
    renderSnapshot.render_report = {
      version: "1.0",
      outputs: [{
        path: "renders/final.mp4",
        format: "mp4",
        resolution: "720x1280",
        duration_seconds: 25,
      }],
    };
    renderSnapshot.final_path = "renders/final.mp4";

    const rendered = reduceWorkbench(afterSave, {
      type: "operationSucceeded",
      token: renderToken,
      snapshot: renderSnapshot,
      merge: "render-result",
    });

    expect(rendered.snapshot?.storyboard.shots[0].prompt).toBe("Concurrent save survived");
    expect(rendered.snapshot?.final_path).toBe("renders/final.mp4");
  });

  it("cleans up project-scoped state on switch and resets on logout", () => {
    const current = {
      ...initialWorkbenchState,
      snapshot: project("p1"),
      selectedShotId: "p1-shot-2",
      events: [event("p1")],
      error: "old error",
      load: "ready" as const,
    };
    const switching = reduceWorkbench(current, {
      type: "openStarted",
      token: token("p2", "open", 2),
    });

    expect(switching.snapshot).toBeNull();
    expect(switching.selectedShotId).toBeNull();
    expect(switching.events).toEqual([]);
    expect(switching.error).toBeNull();
    expect(switching.load).toBe("loading");

    expect(reduceWorkbench(switching, { type: "logoutReset" })).toEqual(initialWorkbenchState);
  });

  it("keeps the previous successful snapshot after a failed command", () => {
    const current = project("p1");
    const render = token("p1", "render");
    const failed = reduceWorkbench(
      reduceWorkbench(
        { ...initialWorkbenchState, snapshot: current, selectedShotId: "p1-shot-1", load: "ready" },
        { type: "operationStarted", token: render },
      ),
      { type: "operationFailed", token: render, error: "render failed" },
    );

    expect(failed.snapshot).toBe(current);
    expect(failed.error).toBe("render failed");
    expect(failed.load).toBe("ready");
  });
});
