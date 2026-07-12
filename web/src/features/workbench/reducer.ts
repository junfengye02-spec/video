import type { JobEvent, ShortDramaProjectResponse } from "../../domain/types";

export interface OperationToken {
  projectId: string;
  kind:
    | "open"
    | "create"
    | "save-shot"
    | "optimize"
    | "regenerate"
    | "save-continuity"
    | "upload"
    | "render";
  generation: number;
}

export interface WorkbenchState {
  snapshot: ShortDramaProjectResponse | null;
  selectedShotId: string | null;
  events: JobEvent[];
  error: string | null;
  load: "idle" | "loading" | "ready" | "missing" | "stale";
  operations: Partial<Record<OperationToken["kind"], OperationToken>>;
}

type SnapshotMergeMode = "replace" | "render-result";

export type WorkbenchAction =
  | { type: "openStarted"; token: OperationToken }
  | { type: "openSucceeded"; token: OperationToken; snapshot: ShortDramaProjectResponse; stale?: boolean }
  | { type: "openMissing"; token: OperationToken }
  | { type: "operationStarted"; token: OperationToken }
  | {
      type: "operationSucceeded";
      token: OperationToken;
      snapshot?: ShortDramaProjectResponse;
      event?: JobEvent;
      selectedShotId?: string | null;
      merge?: SnapshotMergeMode;
    }
  | {
      type: "snapshotUpdated";
      projectId: string;
      snapshot: ShortDramaProjectResponse;
      selectedShotId?: string | null;
      merge?: SnapshotMergeMode;
    }
  | { type: "operationFailed"; token: OperationToken; error: string }
  | { type: "errorRaised"; error: string }
  | { type: "eventReceived"; event: JobEvent }
  | { type: "shotSelected"; shotId: string | null }
  | { type: "errorCleared" }
  | { type: "logoutReset" };

export const initialWorkbenchState: WorkbenchState = {
  snapshot: null,
  selectedShotId: null,
  events: [],
  error: null,
  load: "idle",
  operations: {},
};

function sameToken(left: OperationToken | undefined, right: OperationToken): boolean {
  return Boolean(left)
    && left?.projectId === right.projectId
    && left.kind === right.kind
    && left.generation === right.generation;
}

function withoutOperation(
  operations: WorkbenchState["operations"],
  kind: OperationToken["kind"],
): WorkbenchState["operations"] {
  const next = { ...operations };
  delete next[kind];
  return next;
}

function appendUniqueEvent(events: JobEvent[], event: JobEvent): JobEvent[] {
  return events.some((item) => item.id === event.id) ? events : [...events, event];
}

function selectedShotFor(
  snapshot: ShortDramaProjectResponse | null,
  selectedShotId: string | null,
): string | null {
  if (!snapshot) return null;
  if (selectedShotId && snapshot.storyboard.shots.some((shot) => shot.id === selectedShotId)) {
    return selectedShotId;
  }
  return snapshot.storyboard.shots[0]?.id ?? null;
}

function mergeSnapshot(
  current: ShortDramaProjectResponse | null,
  next: ShortDramaProjectResponse,
  mode: SnapshotMergeMode,
): ShortDramaProjectResponse {
  if (mode !== "render-result" || current?.project.id !== next.project.id) {
    return next;
  }
  return {
    ...current,
    render_report: next.render_report,
    final_path: next.final_path ?? null,
  };
}

export function reduceWorkbench(
  state: WorkbenchState,
  action: WorkbenchAction,
): WorkbenchState {
  switch (action.type) {
    case "openStarted":
      return {
        ...initialWorkbenchState,
        load: "loading",
        operations: { open: action.token },
      };

    case "openSucceeded": {
      if (!sameToken(state.operations.open, action.token)) return state;
      return {
        snapshot: action.snapshot,
        selectedShotId: selectedShotFor(action.snapshot, state.selectedShotId),
        events: [],
        error: null,
        load: action.stale ? "stale" : "ready",
        operations: withoutOperation(state.operations, "open"),
      };
    }

    case "openMissing":
      if (!sameToken(state.operations.open, action.token)) return state;
      return {
        ...state,
        snapshot: null,
        selectedShotId: null,
        events: [],
        error: null,
        load: "missing",
        operations: withoutOperation(state.operations, "open"),
      };

    case "operationStarted":
      return {
        ...state,
        error: null,
        operations: {
          ...state.operations,
          [action.token.kind]: action.token,
        },
      };

    case "operationSucceeded": {
      if (!sameToken(state.operations[action.token.kind], action.token)) return state;
      const snapshot = action.snapshot
        ? mergeSnapshot(state.snapshot, action.snapshot, action.merge ?? "replace")
        : state.snapshot;
      const selectedShotId = action.selectedShotId !== undefined
        ? action.selectedShotId
        : selectedShotFor(snapshot, state.selectedShotId);
      return {
        ...state,
        snapshot,
        selectedShotId,
        events: action.event ? appendUniqueEvent(state.events, action.event) : state.events,
        error: null,
        load: snapshot ? state.load === "loading" ? "ready" : state.load : state.load,
        operations: withoutOperation(state.operations, action.token.kind),
      };
    }

    case "operationFailed":
      if (!sameToken(state.operations[action.token.kind], action.token)) return state;
      return {
        ...state,
        error: action.error,
        operations: withoutOperation(state.operations, action.token.kind),
      };

    case "snapshotUpdated": {
      if (state.snapshot?.project.id !== action.projectId) return state;
      const snapshot = mergeSnapshot(state.snapshot, action.snapshot, action.merge ?? "replace");
      return {
        ...state,
        snapshot,
        selectedShotId: action.selectedShotId !== undefined
          ? action.selectedShotId
          : selectedShotFor(snapshot, state.selectedShotId),
      };
    }

    case "errorRaised":
      return {
        ...state,
        error: action.error,
      };

    case "eventReceived":
      if (state.snapshot?.project.id !== action.event.project_id) return state;
      return {
        ...state,
        events: appendUniqueEvent(state.events, action.event),
      };

    case "shotSelected":
      return {
        ...state,
        selectedShotId: selectedShotFor(state.snapshot, action.shotId),
      };

    case "errorCleared":
      return {
        ...state,
        error: null,
      };

    case "logoutReset":
      return initialWorkbenchState;

    default:
      return state;
  }
}
