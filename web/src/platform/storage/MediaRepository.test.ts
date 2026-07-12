import { describe, expect, it, vi } from "vitest";
import type { LocalMediaRecord, LocalMediaRef, StorageEstimate } from "../../localdb/types";
import { LocalMediaRepository } from "./MediaRepository";

function mediaRef(id: string): LocalMediaRef {
  return `local://media/${id}`;
}

function mediaRecord(id: string, projectId: string): LocalMediaRecord {
  return {
    id,
    projectId,
    sourcePath: `assets/${id}.mp4`,
    contentType: "video/mp4",
    sizeBytes: 5,
    createdAt: "2026-07-12T00:00:00.000Z",
    state: "committed",
    importSessionId: null,
    storage: "indexeddb",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function repository(options: {
  cacheRemoteMedia?: ReturnType<typeof vi.fn>;
  loadMediaBlob?: ReturnType<typeof vi.fn>;
  loadMediaRecord?: ReturnType<typeof vi.fn>;
  deleteProject?: ReturnType<typeof vi.fn>;
  getStorageEstimate?: ReturnType<typeof vi.fn>;
  createObjectURL?: ReturnType<typeof vi.fn>;
  revokeObjectURL?: ReturnType<typeof vi.fn>;
  now?: () => number;
} = {}) {
  return new LocalMediaRepository({
    cacheRemoteMedia: options.cacheRemoteMedia ?? vi.fn(),
    loadMediaBlob: options.loadMediaBlob ?? vi.fn(async () => null),
    loadMediaRecord: options.loadMediaRecord ?? vi.fn(async () => null),
    deleteProject: options.deleteProject ?? vi.fn(),
    getStorageEstimate: options.getStorageEstimate ?? vi.fn(async () => ({
      usageBytes: null,
      quotaBytes: null,
      persisted: null,
    })),
    createObjectURL: options.createObjectURL ?? vi.fn(() => "blob:media"),
    revokeObjectURL: options.revokeObjectURL ?? vi.fn(),
    now: options.now,
  });
}

describe("MediaRepository", () => {
  it("downloads remote media through the durable media store", async () => {
    const cacheRemoteMedia = vi.fn(async () => mediaRef("remote"));
    const repo = repository({ cacheRemoteMedia });

    await expect(repo.cacheRemote("https://example.test/shot.png", {
      projectId: "p1",
      sourcePath: "assets/shot.png",
    })).resolves.toBe("local://media/remote");

    expect(cacheRemoteMedia).toHaveBeenCalledWith("https://example.test/shot.png", {
      projectId: "p1",
      sourcePath: "assets/shot.png",
    });
  });

  it("deduplicates object URL resolution for the same local ref", async () => {
    const ref = mediaRef("dedupe");
    const blob = new Blob(["video"], { type: "video/mp4" });
    const load = deferred<Blob | null>();
    const loadMediaBlob = vi.fn(() => load.promise);
    const loadMediaRecord = vi.fn(async () => mediaRecord("dedupe", "p1"));
    const createObjectURL = vi.fn(() => "blob:dedupe");
    const repo = repository({ loadMediaBlob, loadMediaRecord, createObjectURL });

    const first = repo.resolve(ref);
    const second = repo.resolve(ref);
    load.resolve(blob);

    await expect(Promise.all([first, second])).resolves.toEqual(["blob:dedupe", "blob:dedupe"]);
    expect(loadMediaBlob).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("revokes only object URLs owned by a switched project", async () => {
    const loadMediaBlob = vi.fn(async () => new Blob(["video"]));
    const loadMediaRecord = vi.fn(async (ref: LocalMediaRef) => (
      ref.endsWith("p1") ? mediaRecord("p1", "p1") : mediaRecord("p2", "p2")
    ));
    const createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}:${createObjectURL.mock.calls.length}`);
    const revokeObjectURL = vi.fn();
    const repo = repository({ loadMediaBlob, loadMediaRecord, createObjectURL, revokeObjectURL });

    const p1Url = await repo.resolve(mediaRef("p1"));
    const p2Url = await repo.resolve(mediaRef("p2"));
    repo.revokeProject("p1");

    expect(revokeObjectURL).toHaveBeenCalledWith(p1Url);
    expect(revokeObjectURL).not.toHaveBeenCalledWith(p2Url);
    await expect(repo.resolve(mediaRef("p2"))).resolves.toBe(p2Url);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
  });

  it("logically deletes a project through localdb and revokes its object URLs first", async () => {
    const calls: string[] = [];
    const deleteProject = vi.fn(async () => { calls.push("delete"); });
    const revokeObjectURL = vi.fn(() => { calls.push("revoke"); });
    const repo = repository({
      deleteProject,
      revokeObjectURL,
      createObjectURL: vi.fn(() => "blob:p1"),
      loadMediaBlob: vi.fn(async () => new Blob(["video"])),
      loadMediaRecord: vi.fn(async () => mediaRecord("p1", "p1")),
    });
    await repo.resolve(mediaRef("p1"));

    await repo.deleteProject("p1");

    expect(calls).toEqual(["revoke", "delete"]);
    expect(deleteProject).toHaveBeenCalledWith("p1");
  });

  it("does not swallow durable cleanup failures from project delete", async () => {
    const cleanupFailure = new Error("OPFS retry is still queued");
    const repo = repository({ deleteProject: vi.fn(async () => { throw cleanupFailure; }) });

    await expect(repo.deleteProject("p1")).rejects.toBe(cleanupFailure);
  });

  it("refreshes storage estimates on every call", async () => {
    const estimates: StorageEstimate[] = [
      { usageBytes: 10, quotaBytes: 100, persisted: false },
      { usageBytes: 20, quotaBytes: 100, persisted: true },
    ];
    const getStorageEstimate = vi.fn(async () => estimates.shift()!);
    const repo = repository({ getStorageEstimate });

    await expect(repo.estimate()).resolves.toEqual({ usageBytes: 10, quotaBytes: 100, persisted: false });
    await expect(repo.estimate()).resolves.toEqual({ usageBytes: 20, quotaBytes: 100, persisted: true });
    expect(getStorageEstimate).toHaveBeenCalledTimes(2);
  });

  it("backs off storage errors and retries after the delay", async () => {
    let now = 0;
    const storageError = new Error("IndexedDB unavailable");
    const loadMediaBlob = vi.fn(async () => { throw storageError; });
    const repo = repository({ loadMediaBlob, now: () => now });

    await expect(repo.resolve(mediaRef("failure"))).rejects.toBe(storageError);
    await expect(repo.resolve(mediaRef("failure"))).rejects.toBe(storageError);
    expect(loadMediaBlob).toHaveBeenCalledTimes(1);

    now = 1_000;
    await expect(repo.resolve(mediaRef("failure"))).rejects.toBe(storageError);
    expect(loadMediaBlob).toHaveBeenCalledTimes(2);
  });
});
