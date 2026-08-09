import { describe, expect, it, vi } from "vitest";
import type { LocalProjectVersion } from "../../localdb/types";
import {
  createWorkbenchCommandContract,
  runLatestCommand,
  saveSnapshotIfVersionCurrent,
} from "./commandContract";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("Workbench command contract", () => {
  it("commits a successful current command", async () => {
    const contract = createWorkbenchCommandContract();
    const token = contract.begin("p1", "inspiration");
    const onSuccess = vi.fn();

    await expect(runLatestCommand({
      contract,
      token,
      execute: async () => "updated",
      onSuccess,
    })).resolves.toBe("updated");

    expect(onSuccess).toHaveBeenCalledWith("updated");
  });

  it("reports a current command failure without swallowing it", async () => {
    const contract = createWorkbenchCommandContract();
    const token = contract.begin("p1", "revise-plan");
    const failure = new Error("revision failed");
    const onFailure = vi.fn();

    await expect(runLatestCommand({
      contract,
      token,
      execute: async () => { throw failure; },
      onFailure,
    })).rejects.toBe(failure);

    expect(onFailure).toHaveBeenCalledWith(failure);
  });

  it("ignores a response superseded by a newer command of the same kind", async () => {
    const contract = createWorkbenchCommandContract();
    const first = deferred<string>();
    const firstToken = contract.begin("p1", "inspiration");
    const onSuccess = vi.fn();
    const pending = runLatestCommand({
      contract,
      token: firstToken,
      execute: () => first.promise,
      onSuccess,
    });

    contract.begin("p1", "inspiration");
    first.resolve("stale");

    await expect(pending).resolves.toBe("stale");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("invalidates old project commands when the session switches projects", async () => {
    const contract = createWorkbenchCommandContract();
    const request = deferred<string>();
    const token = contract.begin("p1", "approve-plan");
    const onSuccess = vi.fn();
    const pending = runLatestCommand({
      contract,
      token,
      execute: () => request.promise,
      onSuccess,
    });

    contract.invalidate();
    contract.begin("p2", "open");
    request.resolve("p1 approval");

    await expect(pending).resolves.toBe("p1 approval");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("uses the expected CAS version and exposes conflicts", async () => {
    const expectedVersion = { incarnation: "test:p1", revision: 4 };
    const nextVersion = { incarnation: "test:p1", revision: 5 };
    const saveIfVersion = vi.fn(async (): Promise<LocalProjectVersion | null> => nextVersion);

    await expect(saveSnapshotIfVersionCurrent({
      snapshot: { projectId: "p1" },
      expectedVersion,
      isCurrent: () => true,
      saveIfVersion,
    })).resolves.toEqual({ status: "committed", version: nextVersion });
    expect(saveIfVersion).toHaveBeenCalledWith({ projectId: "p1" }, expectedVersion);

    saveIfVersion.mockResolvedValueOnce(null);
    await expect(saveSnapshotIfVersionCurrent({
      snapshot: { projectId: "p1" },
      expectedVersion,
      isCurrent: () => true,
      saveIfVersion,
    })).resolves.toEqual({ status: "conflict" });
  });

  it("does not attempt a CAS save after the project snapshot becomes stale", async () => {
    const saveIfVersion = vi.fn();

    await expect(saveSnapshotIfVersionCurrent({
      snapshot: { projectId: "p1" },
      expectedVersion: { incarnation: "test:p1", revision: 2 },
      isCurrent: () => false,
      saveIfVersion,
    })).resolves.toEqual({ status: "stale" });

    expect(saveIfVersion).not.toHaveBeenCalled();
  });
});
