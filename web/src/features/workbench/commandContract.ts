import type { LocalProjectVersion } from "../../localdb/types";
import type { OperationToken } from "./reducer";

export interface WorkbenchCommandContract {
  begin(projectId: string, kind: OperationToken["kind"]): OperationToken;
  invalidate(): void;
  invalidateKind(kind: OperationToken["kind"]): void;
  isCurrent(token: OperationToken): boolean;
}

export function createWorkbenchCommandContract(
  isMounted: () => boolean = () => true,
): WorkbenchCommandContract {
  let generation = 0;
  let sequences: Partial<Record<OperationToken["kind"], number>> = {};

  return {
    begin(projectId, kind) {
      generation += 1;
      sequences[kind] = generation;
      return { projectId, kind, generation };
    },
    invalidate() {
      generation += 1;
      sequences = {};
    },
    invalidateKind(kind) {
      generation += 1;
      delete sequences[kind];
    },
    isCurrent(token) {
      return isMounted() && sequences[token.kind] === token.generation;
    },
  };
}

export async function runLatestCommand<Result>({
  contract,
  execute,
  onFailure,
  onSuccess,
  token,
}: {
  contract: WorkbenchCommandContract;
  execute: () => Promise<Result>;
  onFailure?: (error: unknown) => void | Promise<void>;
  onSuccess?: (result: Result) => void | Promise<void>;
  token: OperationToken;
}): Promise<Result> {
  try {
    const result = await execute();
    if (contract.isCurrent(token)) await onSuccess?.(result);
    return result;
  } catch (error) {
    if (contract.isCurrent(token)) await onFailure?.(error);
    throw error;
  }
}

export type VersionedSaveResult =
  | { status: "committed"; version: LocalProjectVersion }
  | { status: "conflict" }
  | { status: "stale" };

export async function saveSnapshotIfVersionCurrent<Snapshot>({
  expectedVersion,
  isCurrent,
  saveIfVersion,
  snapshot,
}: {
  expectedVersion: LocalProjectVersion;
  isCurrent: () => boolean;
  saveIfVersion: (
    snapshot: Snapshot,
    expectedVersion: LocalProjectVersion,
  ) => Promise<LocalProjectVersion | null>;
  snapshot: Snapshot;
}): Promise<VersionedSaveResult> {
  if (!isCurrent()) return { status: "stale" };
  const version = await saveIfVersion(snapshot, expectedVersion);
  if (!version) return { status: "conflict" };
  if (!isCurrent()) return { status: "stale" };
  return { status: "committed", version };
}
