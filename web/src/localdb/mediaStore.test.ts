import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openLocalDb, resetLocalDbForTests } from "./indexedDb";
import * as mediaStoreModule from "./mediaStore";
import {
  cacheRemoteMedia,
  cleanupOrphanedOpfsMedia,
  loadMediaBlob,
  saveMediaBlob,
} from "./mediaStore";
import {
  claimNextDueMediaOperation,
  completeMediaJournalRecord,
} from "./mediaJournal";
import {
  installTestStorage,
  type TestStorageController,
  type TestStorageOptions,
} from "./testStorage";
import type {
  LocalMediaRecord,
  LocalMediaRef,
  MediaJournalRecord,
  MediaOperationRecord,
} from "./types";
import { LOCAL_DB_NAME } from "./types";

type BeginMediaWriteInput = {
  projectId: string | null;
  importSessionId?: string | null;
  sourcePath: string;
  contentType: string;
  sizeBytes: number;
};

type MediaWriteSession = {
  readonly operationId: string;
  readonly mediaRef: LocalMediaRef;
  write(chunk: Uint8Array): Promise<void>;
  commit(): Promise<LocalMediaRef>;
  abort(cause?: unknown): Promise<void>;
};

type RecoveryOptions = {
  now?: () => Date;
  leaseOwner?: string;
  leaseDurationMs?: number;
};

type Task2MediaStore = typeof mediaStoreModule & {
  beginMediaWrite(input: BeginMediaWriteInput): Promise<MediaWriteSession>;
  runMediaRecovery(options?: RecoveryOptions): Promise<number>;
  startMediaRecoveryController(options?: RecoveryOptions): {
    run(): Promise<number>;
    dispose(): void;
  };
  findCommittedMedia(projectId: string, sourcePath: string): Promise<LocalMediaRecord | null>;
};

const task2MediaStore = mediaStoreModule as Task2MediaStore;

const originalStorage = Object.getOwnPropertyDescriptor(Navigator.prototype, "storage");
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

async function blobFromText(text: string, contentType: string): Promise<Blob> {
  return new Response(text, { headers: { "content-type": contentType } }).blob();
}

function blobToText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") {
    return blob.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function deleteLocalDb() {
  resetLocalDbForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.oncomplete = () => resolve();
  });
}

async function put(storeName: string, value: unknown): Promise<void> {
  const db = await openLocalDb();
  const tx = db.transaction(storeName, "readwrite");
  const done = transactionDone(tx);
  tx.objectStore(storeName).put(value);
  await done;
}

async function seedProject(id = "p1"): Promise<void> {
  await put("projects", {
    id,
    title: id,
    updatedAt: new Date().toISOString(),
    snapshot: {},
  });
}

async function getAll<T>(storeName: string): Promise<T[]> {
  const db = await openLocalDb();
  return requestToPromise<T[]>(
    db.transaction(storeName, "readonly").objectStore(storeName).getAll(),
  );
}

async function getRecord<T>(storeName: string, id: string): Promise<T | null> {
  const db = await openLocalDb();
  const value = await requestToPromise<T | undefined>(
    db.transaction(storeName, "readonly").objectStore(storeName).get(id),
  );
  return value ?? null;
}

async function letRecoveryCompleteOperation(operationId: string): Promise<void> {
  const operation = await getRecord<MediaJournalRecord>("mediaOperations", operationId);
  await put("mediaOperations", {
    ...operation,
    nextAttemptAt: "2000-01-01T00:00:00.000Z",
    leaseExpiresAt: "2000-01-01T00:00:00.000Z",
  });
  const now = new Date();
  await expect(claimNextDueMediaOperation("race-recovery", {
    now: () => now,
    leaseDurationMs: 60_000,
  })).resolves.toMatchObject({ id: operationId });
  await expect(completeMediaJournalRecord(operationId, "race-recovery", {
    now: () => now,
  })).resolves.toBe(true);
}

async function seedCleanupOperation(
  id: string,
  mediaId: string,
  nextAttemptAt: string,
): Promise<void> {
  await put("mediaOperations", {
    id,
    kind: "media_write",
    mediaId,
    projectId: "p1",
    importSessionId: null,
    sourcePath: `assets/${mediaId}.mp4`,
    contentType: "video/mp4",
    sizeBytes: 1,
    opfsPath: `openmontage-media/${mediaId}`,
    state: "cleanup_due",
    createdAt: nextAttemptAt,
    updatedAt: nextAttemptAt,
    attempts: 0,
    nextAttemptAt,
    leaseOwner: null,
    leaseExpiresAt: null,
  });
}

async function waitForStorageState(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for storage state");
}

function installOpfs(options: {
  removeError: Error | null;
  delayClose?: boolean;
  pauseFirstDirectory?: boolean;
}) {
  const files = new Map<string, Blob>();
  const writeStarted = deferred<void>();
  const closeGate = deferred<void>();
  const firstDirectoryStarted = deferred<void>();
  const firstDirectoryGate = deferred<void>();
  let directoryCalls = 0;
  const mediaDirectory = {
    async getFileHandle(name: string, handleOptions?: { create?: boolean }) {
      if (!files.has(name) && !handleOptions?.create) {
        throw new DOMException("File not found", "NotFoundError");
      }
      return {
        async createWritable() {
          return {
            async write(blob: Blob | Uint8Array) {
              files.set(name, blob instanceof Blob ? blob : new Blob([blob.slice().buffer]));
              writeStarted.resolve();
            },
            async close() {
              if (options.delayClose) await closeGate.promise;
            },
          };
        },
        async getFile() {
          const blob = files.get(name);
          if (!blob) throw new DOMException("File not found", "NotFoundError");
          return blob;
        },
      };
    },
    removeEntry: vi.fn(async (name: string) => {
      if (options.removeError) throw options.removeError;
      if (!files.delete(name)) throw new DOMException("File not found", "NotFoundError");
    }),
    async *entries() {
      for (const name of files.keys()) {
        yield [name, { kind: "file", name }];
      }
    },
  };
  Object.defineProperty(Navigator.prototype, "storage", {
    configurable: true,
    value: {
      async getDirectory() {
        directoryCalls += 1;
        if (options.pauseFirstDirectory && directoryCalls === 1) {
          firstDirectoryStarted.resolve();
          await firstDirectoryGate.promise;
        }
        return {
          async getDirectoryHandle() {
            return mediaDirectory;
          },
        };
      },
    },
  });
  return {
    files,
    removeEntry: mediaDirectory.removeEntry,
    writeStarted: writeStarted.promise,
    releaseClose: () => closeGate.resolve(),
    firstDirectoryStarted: firstDirectoryStarted.promise,
    releaseFirstDirectory: () => firstDirectoryGate.resolve(),
  };
}

function failMediaRecordWrites(error: Error) {
  const originalPut = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey,
  ) {
    if (this.name === "media") throw error;
    return key === undefined
      ? originalPut.call(this, value)
      : originalPut.call(this, value, key);
  });
}

beforeEach(async () => {
  await seedProject();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalStorage) {
    Object.defineProperty(Navigator.prototype, "storage", originalStorage);
  } else {
    delete (Navigator.prototype as { storage?: StorageManager }).storage;
  }
  if (originalVisibilityState) {
    Object.defineProperty(document, "visibilityState", originalVisibilityState);
  } else {
    delete (document as unknown as Record<string, unknown>).visibilityState;
  }
  await deleteLocalDb();
});

describe("mediaStore", () => {
  it("saves and loads a media blob through the IndexedDB fallback", async () => {
    const blob = await blobFromText("video", "video/mp4");

    const ref = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/video/shot_001.mp4",
      contentType: "video/mp4",
      blob,
    });

    expect(ref).toMatch(/^local:\/\/media\//);
    const restored = await loadMediaBlob(ref);
    expect(restored?.type).toBe("video/mp4");
    expect(restored ? await blobToText(restored) : null).toBe("video");
  });

  it("downloads remote media into local storage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("image", { headers: { "content-type": "image/png" } })),
    );

    const ref = await cacheRemoteMedia("https://example.test/shot.png", {
      projectId: "p1",
      sourcePath: "assets/images/shot.png",
    });

    expect(ref).toMatch(/^local:\/\/media\//);
    const restored = await loadMediaBlob(ref!);
    expect(restored ? await blobToText(restored) : null).toBe("image");
  });

  it("returns null when remote media cannot be downloaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    await expect(
      cacheRemoteMedia("https://example.test/missing.png", {
        projectId: "p1",
        sourcePath: "assets/images/missing.png",
      }),
    ).resolves.toBeNull();
  });

  it("returns null when downloaded media cannot be persisted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("image", { headers: { "content-type": "image/png" } })),
    );
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    await expect(cacheRemoteMedia("https://example.test/shot.png", {
      projectId: "p1",
      sourcePath: "assets/images/shot.png",
    })).resolves.toBeNull();
  });

  it("keeps durable cleanup work when an OPFS write cannot be recorded", async () => {
    const idbError = new DOMException("Quota exceeded", "QuotaExceededError");
    const opfsError = new Error("OPFS remove failed");
    const opfsOptions = { removeError: opfsError as Error | null };
    const { files } = installOpfs(opfsOptions);
    failMediaRecordWrites(idbError);

    let failure: unknown;
    try {
      await saveMediaBlob({
        projectId: "p1",
        sourcePath: "assets/video/shot_001.mp4",
        contentType: "video/mp4",
        blob: await blobFromText("video", "video/mp4"),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBe(idbError);
    expect(files.size).toBe(1);
    expect(await getAll<MediaJournalRecord>("mediaOperations")).toEqual([
      expect.objectContaining({ state: "cleanup_due" }),
    ]);
  });

  it("deterministically removes an unindexed OPFS file on cleanup retry", async () => {
    const opfsOptions = { removeError: new Error("OPFS remove failed") as Error | null };
    const { files } = installOpfs(opfsOptions);
    const putSpy = failMediaRecordWrites(
      new DOMException("Quota exceeded", "QuotaExceededError"),
    );
    await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/video/shot_001.mp4",
      contentType: "video/mp4",
      blob: await blobFromText("video", "video/mp4"),
    }).catch(() => undefined);
    putSpy.mockRestore();
    opfsOptions.removeError = null;

    await expect(task2MediaStore.runMediaRecovery()).resolves.toBe(1);
    expect(files.size).toBe(0);
  });

  it("preserves a live OPFS write while a concurrent orphan scan runs", async () => {
    const opfsOptions = { removeError: null, delayClose: true };
    const { files, writeStarted, releaseClose } = installOpfs(opfsOptions);
    const saving = saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/video/live.mp4",
      contentType: "video/mp4",
      blob: await blobFromText("live", "video/mp4"),
    });
    await writeStarted;

    await expect(cleanupOrphanedOpfsMedia()).resolves.toBe(0);
    expect(files.size).toBe(1);

    releaseClose();
    const ref = await saving;
    const restored = await loadMediaBlob(ref);
    expect(restored ? await blobToText(restored) : null).toBe("live");
  });

  it("rechecks media committed after the orphan scan snapshot", async () => {
    const opfsOptions = { removeError: null, pauseFirstDirectory: true };
    const {
      files,
      firstDirectoryStarted,
      releaseFirstDirectory,
    } = installOpfs(opfsOptions);
    const scanning = cleanupOrphanedOpfsMedia();
    await firstDirectoryStarted;

    const ref = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/video/committed.mp4",
      contentType: "video/mp4",
      blob: await blobFromText("committed", "video/mp4"),
    });
    releaseFirstDirectory();

    await expect(scanning).resolves.toBe(0);
    expect(files.size).toBe(1);
    const restored = await loadMediaBlob(ref);
    expect(restored ? await blobToText(restored) : null).toBe("committed");
  });

  it("keeps remote cache failure non-blocking and recovers from durable state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("image", { headers: { "content-type": "image/png" } })),
    );
    const idbError = new DOMException("Quota exceeded", "QuotaExceededError");
    const opfsError = new Error("OPFS remove failed");
    const opfsOptions = { removeError: opfsError as Error | null };
    const { files, removeEntry } = installOpfs(opfsOptions);
    const putSpy = failMediaRecordWrites(idbError);

    await expect(cacheRemoteMedia("https://example.test/image.png", {
      projectId: "p1",
      sourcePath: "assets/image.png",
    })).resolves.toBeNull();
    expect(files.size).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await getAll<MediaJournalRecord>("mediaOperations")).toEqual([
      expect.objectContaining({ state: "cleanup_due" }),
    ]);

    putSpy.mockRestore();
    opfsOptions.removeError = null;
    await expect(task2MediaStore.runMediaRecovery()).resolves.toBe(1);
    expect(files.size).toBe(0);

    expect(removeEntry).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("streaming durable media writes", () => {
  it("does not create or truncate OPFS bytes after recovery takes an opening writer", async () => {
    const boundaries: Array<{
      options: TestStorageOptions;
      started(storage: TestStorageController): Promise<void>;
      release(storage: TestStorageController): void;
    }> = [
      {
        options: { pauseGetDirectory: true },
        started: (storage) => storage.directoryStarted,
        release: (storage) => storage.releaseDirectory(),
      },
      {
        options: { pauseDirectoryHandle: true },
        started: (storage) => storage.directoryHandleStarted,
        release: (storage) => storage.releaseDirectoryHandle(),
      },
      {
        options: { pauseGetFileHandle: true },
        started: (storage) => storage.fileHandleStarted,
        release: (storage) => storage.releaseFileHandle(),
      },
      {
        options: { pauseCreateWritable: true },
        started: (storage) => storage.createWritableStarted,
        release: (storage) => storage.releaseCreateWritable(),
      },
    ];

    for (const boundary of boundaries) {
      await deleteLocalDb();
      await seedProject();
      const storage = installTestStorage(boundary.options);
      const beginning = task2MediaStore.beginMediaWrite({
        projectId: "p1",
        sourcePath: "assets/open-race.mp4",
        contentType: "video/mp4",
        sizeBytes: 0,
      });
      await boundary.started(storage);
      const [operation] = await getAll<MediaOperationRecord>("mediaOperations");
      await letRecoveryCompleteOperation(operation.id);
      boundary.release(storage);

      await expect(beginning).rejects.toThrow(/lease/i);
      expect(storage.files.size).toBe(0);
      storage.restore();
    }
  });

  it("does not close an idle writer after its lease has been recovered", async () => {
    const storage = installTestStorage();
    const session = await task2MediaStore.beginMediaWrite({
      projectId: "p1",
      sourcePath: "assets/idle.mp4",
      contentType: "video/mp4",
      sizeBytes: 0,
    });
    const operation = await getRecord<MediaOperationRecord>("mediaOperations", session.operationId);
    await put("mediaOperations", {
      ...operation,
      nextAttemptAt: "2000-01-01T00:00:00.000Z",
      leaseExpiresAt: "2000-01-01T00:00:00.000Z",
    });
    await task2MediaStore.runMediaRecovery();

    await expect(session.commit()).rejects.toThrow(/lease/i);
    expect(storage.closeCalls).toBe(0);
    expect(storage.files.size).toBe(0);
  });

  it("rechecks the writer token after a paused close loses to recovery", async () => {
    const storage = installTestStorage({ pauseClose: true });
    const session = await task2MediaStore.beginMediaWrite({
      projectId: "p1",
      sourcePath: "assets/close-race.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    });
    await session.write(new Uint8Array([1]));
    const committing = session.commit();
    await storage.closeStarted;
    const operation = await getRecord<MediaOperationRecord>("mediaOperations", session.operationId);
    await put("mediaOperations", {
      ...operation,
      nextAttemptAt: "2000-01-01T00:00:00.000Z",
      leaseExpiresAt: "2000-01-01T00:00:00.000Z",
    });
    await task2MediaStore.runMediaRecovery();
    storage.releaseClose();

    await expect(committing).rejects.toBeDefined();
    expect(await task2MediaStore.loadMediaBlob(session.mediaRef)).toBeNull();
    expect(storage.files.size).toBe(0);
  });

  it.each(["indexeddb", "opfs"] as const)(
    "synchronously reserves commit against writes and duplicate commits in %s",
    async (mode) => {
      let storage: TestStorageController | null = null;
      if (mode === "indexeddb") {
        Object.defineProperty(Navigator.prototype, "storage", {
          configurable: true,
          value: {},
        });
      } else {
        storage = installTestStorage({ pauseClose: true });
      }
      const session = await task2MediaStore.beginMediaWrite({
        projectId: "p1",
        sourcePath: `assets/terminal-${mode}.mp4`,
        contentType: "video/mp4",
        sizeBytes: 1,
      });
      await session.write(new Uint8Array([1]));

      const committing = session.commit();
      const duplicate = session.commit();
      const lateWrite = session.write(new Uint8Array([2]));
      storage?.releaseClose();

      await expect(duplicate).rejects.toThrow(/not open|committing/i);
      await expect(lateWrite).rejects.toThrow(/not open|committing/i);
      await expect(committing).resolves.toBe(session.mediaRef);
      await expect(session.write(new Uint8Array([3]))).rejects.toThrow(/not open/i);
    },
  );

  it.each(["indexeddb", "opfs"] as const)(
    "does not let abort return before an in-flight %s commit settles",
    async (mode) => {
      let storage: TestStorageController | null = null;
      if (mode === "indexeddb") {
        Object.defineProperty(Navigator.prototype, "storage", {
          configurable: true,
          value: {},
        });
      } else {
        storage = installTestStorage({ pauseClose: true });
      }
      const session = await task2MediaStore.beginMediaWrite({
        projectId: "p1",
        sourcePath: `assets/abort-race-${mode}.mp4`,
        contentType: "video/mp4",
        sizeBytes: 1,
      });
      await session.write(new Uint8Array([1]));
      let commitSettled = false;
      const committing = session.commit().finally(() => {
        commitSettled = true;
      });
      const aborting = session.abort(new Error("too late"));
      storage?.releaseClose();

      await aborting;
      expect(commitSettled).toBe(true);
      await expect(committing).resolves.toBe(session.mediaRef);
      expect(await task2MediaStore.loadMediaBlob(session.mediaRef)).not.toBeNull();
      if (storage) expect(storage.closeCalls).toBe(1);
    },
  );

  it.each(["indexeddb", "opfs"] as const)(
    "lets an earlier abort prevent a later %s commit",
    async (mode) => {
      if (mode === "indexeddb") {
        Object.defineProperty(Navigator.prototype, "storage", {
          configurable: true,
          value: {},
        });
      } else {
        installTestStorage();
      }
      const session = await task2MediaStore.beginMediaWrite({
        projectId: "p1",
        sourcePath: `assets/abort-first-${mode}.mp4`,
        contentType: "video/mp4",
        sizeBytes: 0,
      });

      await session.abort();
      await expect(session.commit()).rejects.toThrow(/not open|aborted/i);
      expect(await task2MediaStore.loadMediaBlob(session.mediaRef)).toBeNull();
    },
  );

  it("journals before OPFS and never touches OPFS when journaling fails", async () => {
    const storage = installTestStorage();
    const originalAdd = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === "mediaOperations") {
        throw new DOMException("Journal full", "QuotaExceededError");
      }
      return key === undefined
        ? originalAdd.call(this, value)
        : originalAdd.call(this, value, key);
    });

    expect(task2MediaStore.beginMediaWrite).toBeTypeOf("function");
    await expect(task2MediaStore.beginMediaWrite({
      projectId: "p1",
      sourcePath: "assets/crash.mp4",
      contentType: "video/mp4",
      sizeBytes: 4,
    })).rejects.toMatchObject({ name: "MediaDurabilityError" });
    expect(storage.getDirectory).not.toHaveBeenCalled();
  });

  it("durably queues cleanup when OPFS creation, writing, closing, or media commit fails", async () => {
    const cases: Array<{ name: string; options: TestStorageOptions }> = [
      { name: "creation", options: { failGetDirectory: new Error("directory failed") } },
      { name: "write", options: { failWriteAt: 1, writeError: new Error("write failed") } },
      { name: "close", options: { failClose: new Error("close failed") } },
      { name: "commit", options: {} },
    ];

    for (const crash of cases) {
      await deleteLocalDb();
      await seedProject();
      const storage = installTestStorage(crash.options);
      const sessionPromise = task2MediaStore.beginMediaWrite({
        projectId: "p1",
        sourcePath: `assets/${crash.name}.mp4`,
        contentType: "video/mp4",
        sizeBytes: 4,
      });

      if (crash.name === "creation") {
        await expect(sessionPromise).rejects.toBeInstanceOf(Error);
      } else {
        const session = await sessionPromise;
        if (crash.name === "write") {
          await expect(session.write(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(Error);
        } else {
          await session.write(new Uint8Array([1, 2, 3, 4]));
          let putSpy: { mockRestore(): void } | undefined;
          if (crash.name === "commit") {
            const originalPut = IDBObjectStore.prototype.put;
            putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
              this: IDBObjectStore,
              value: unknown,
              key?: IDBValidKey,
            ) {
              if (this.name === "media") throw new DOMException("Media commit failed", "AbortError");
              return key === undefined
                ? originalPut.call(this, value)
                : originalPut.call(this, value, key);
            });
          }
          await expect(session.commit()).rejects.toBeDefined();
          putSpy?.mockRestore();
          expect(await task2MediaStore.loadMediaBlob(session.mediaRef)).toBeNull();
        }
      }

      expect(await getAll<MediaJournalRecord>("mediaOperations")).toEqual([
        expect.objectContaining({ kind: "media_write", state: "cleanup_due" }),
      ]);
      crash.options.failGetDirectory = undefined;
      crash.options.failWriteAt = undefined;
      crash.options.failClose = undefined;
      const controller = task2MediaStore.startMediaRecoveryController();
      expect(controller.dispose).toBeTypeOf("function");
      await expect(controller.run()).resolves.toBeGreaterThanOrEqual(1);
      controller.dispose();
      expect(await getAll("mediaOperations")).toHaveLength(0);
      storage.restore();
      vi.restoreAllMocks();
    }
  });

  it("streams chunks, renews the writer lease, verifies physical bytes, and publishes only on commit", async () => {
    const storage = installTestStorage();
    const session = await task2MediaStore.beginMediaWrite({
      projectId: "p1",
      sourcePath: "assets/chunks.mp4",
      contentType: "video/mp4",
      sizeBytes: 4,
    });
    const before = await getRecord<MediaJournalRecord>("mediaOperations", session.operationId);

    expect(session.mediaRef).toMatch(/^local:\/\/media\//);
    expect(await task2MediaStore.loadMediaBlob(session.mediaRef)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 2));
    await session.write(new Uint8Array([1, 2]));
    await session.write(new Uint8Array([3, 4]));
    const renewed = await getRecord<MediaJournalRecord>("mediaOperations", session.operationId);
    expect(renewed?.leaseExpiresAt).not.toBe(before?.leaseExpiresAt);

    await expect(session.commit()).resolves.toBe(session.mediaRef);
    expect([...storage.files.values()][0]).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await getRecord("mediaOperations", session.operationId)).toBeNull();
    expect(await task2MediaStore.loadMediaBlob(session.mediaRef)).toBeInstanceOf(Blob);
  });

  it("rejects a physical byte-count mismatch and leaves durable cleanup work", async () => {
    installTestStorage({ verifiedSizeDelta: -1 });
    const session = await task2MediaStore.beginMediaWrite({
      projectId: "p1",
      sourcePath: "assets/truncated.mp4",
      contentType: "video/mp4",
      sizeBytes: 4,
    });
    await session.write(new Uint8Array([1, 2, 3, 4]));

    await expect(session.commit()).rejects.toThrow(/byte|size/i);
    expect(await getRecord<MediaJournalRecord>("mediaOperations", session.operationId))
      .toMatchObject({ state: "cleanup_due" });
    expect(await task2MediaStore.loadMediaBlob(session.mediaRef)).toBeNull();
  });

  it("does not publish after the writer lease expires", async () => {
    installTestStorage();
    const session = await task2MediaStore.beginMediaWrite({
      projectId: "p1",
      sourcePath: "assets/expired-writer.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    });
    await session.write(new Uint8Array([1]));
    const operation = await getRecord<MediaOperationRecord>("mediaOperations", session.operationId);
    await put("mediaOperations", {
      ...operation,
      leaseExpiresAt: "2000-01-01T00:00:00.000Z",
    });

    await expect(session.commit()).rejects.toThrow(/lease/i);
    expect(await task2MediaStore.loadMediaBlob(session.mediaRef)).toBeNull();
    expect(await getRecord<MediaJournalRecord>("mediaOperations", session.operationId))
      .toMatchObject({ state: "cleanup_due" });
  });

  it("uses one transactional IndexedDB fallback without an OPFS operation", async () => {
    Object.defineProperty(Navigator.prototype, "storage", {
      configurable: true,
      value: {},
    });
    const session = await task2MediaStore.beginMediaWrite({
      projectId: "p1",
      sourcePath: "assets/fallback.mp4",
      contentType: "video/mp4",
      sizeBytes: 4,
    });
    await session.write(new Uint8Array([1, 2]));
    await session.write(new Uint8Array([3, 4]));

    await expect(session.commit()).resolves.toBe(session.mediaRef);
    expect(await getAll("mediaOperations")).toHaveLength(0);
    expect(await task2MediaStore.loadMediaBlob(session.mediaRef)).toBeInstanceOf(Blob);
  });

  it("validates ownership at begin time for the IndexedDB fallback", async () => {
    Object.defineProperty(Navigator.prototype, "storage", {
      configurable: true,
      value: {},
    });

    await expect(task2MediaStore.beginMediaWrite({
      projectId: "missing",
      sourcePath: "assets/fallback-missing.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    })).rejects.toThrow(/project/i);
    expect(await getAll("media")).toHaveLength(0);
    expect(await getAll("mediaOperations")).toHaveLength(0);
  });

  it("validates a project or active import session before storage mutation", async () => {
    const storage = installTestStorage();
    await expect(task2MediaStore.beginMediaWrite({
      projectId: "missing",
      sourcePath: "assets/missing.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    })).rejects.toThrow(/project/i);
    expect(storage.getDirectory).not.toHaveBeenCalled();

    await put("mediaOperations", {
      id: "import-1",
      kind: "import_session",
      projectId: "future-project",
      mediaIds: [],
      state: "importing",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: new Date().toISOString(),
      leaseOwner: "importer",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const session = await task2MediaStore.beginMediaWrite({
      projectId: null,
      importSessionId: "import-1",
      sourcePath: "assets/imported.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    });
    await session.write(new Uint8Array([7]));
    await session.commit();

    expect(await task2MediaStore.loadMediaBlob(session.mediaRef)).toBeNull();
    const mediaId = session.mediaRef.split("/").pop()!;
    expect(await getRecord<LocalMediaRecord>("media", mediaId))
      .toMatchObject({ projectId: "future-project", state: "staged", importSessionId: "import-1" });
    expect(await getRecord<{ mediaIds: string[] }>("mediaOperations", "import-1"))
      .toMatchObject({ mediaIds: [mediaId] });
  });

  it("finds only the newest committed record for a project source", async () => {
    const base = {
      projectId: "p1",
      sourcePath: "assets/same.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
      storage: "indexeddb" as const,
      blob: new Blob([new Uint8Array([1])]),
      importSessionId: null,
    };
    await put("media", { ...base, id: "old", state: "committed", createdAt: "2026-01-01T00:00:00Z" });
    await put("media", { ...base, id: "staged", state: "staged", createdAt: "2026-03-01T00:00:00Z" });
    await put("media", { ...base, id: "new", state: "committed", createdAt: "2026-02-01T00:00:00Z" });

    expect(task2MediaStore.findCommittedMedia).toBeTypeOf("function");
    await expect(task2MediaStore.findCommittedMedia("p1", "assets/same.mp4"))
      .resolves.toMatchObject({ id: "new" });
  });
});

describe("durable media recovery", () => {
  it("preserves media committed and reassigned during import-session cleanup", async () => {
    const storage = installTestStorage({ pauseRemove: true });
    storage.seedFile("staged-first", new Uint8Array([1]), Date.now());
    storage.seedFile("staged-second", new Uint8Array([2]), Date.now());
    const timestamp = new Date().toISOString();
    await put("mediaOperations", {
      id: "import-cleanup",
      kind: "import_session",
      projectId: "p1",
      mediaIds: ["staged-first", "staged-second"],
      state: "cleanup_due",
      createdAt: timestamp,
      updatedAt: timestamp,
      attempts: 0,
      nextAttemptAt: timestamp,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    for (const id of ["staged-first", "staged-second"]) {
      await put("media", {
        id,
        projectId: "p1",
        sourcePath: `assets/${id}.mp4`,
        contentType: "video/mp4",
        sizeBytes: 1,
        createdAt: timestamp,
        state: "staged",
        importSessionId: "import-cleanup",
        storage: "opfs",
        opfsPath: `openmontage-media/${id}`,
      });
    }

    const recovering = task2MediaStore.runMediaRecovery({ leaseOwner: "import-recovery" });
    await storage.removeStarted;
    const second = await getRecord<LocalMediaRecord>("media", "staged-second");
    await put("media", {
      ...second,
      projectId: "other-project",
      state: "committed",
      importSessionId: null,
    });
    storage.releaseRemove();

    await expect(recovering).resolves.toBe(1);
    expect(storage.files.has("staged-first")).toBe(false);
    expect(storage.files.has("staged-second")).toBe(true);
    expect(await getRecord("media", "staged-first")).toBeNull();
    expect(await getRecord<LocalMediaRecord>("media", "staged-second"))
      .toMatchObject({ projectId: "other-project", state: "committed", importSessionId: null });
    expect(await getRecord("mediaOperations", "import-cleanup")).toBeNull();
  });

  it("recovers an expired crashed writer after recreating the controller", async () => {
    const storage = installTestStorage();
    const session = await task2MediaStore.beginMediaWrite({
      projectId: "p1",
      sourcePath: "assets/crashed.mp4",
      contentType: "video/mp4",
      sizeBytes: 2,
    });
    await session.write(new Uint8Array([1, 2]));
    const operation = await getRecord<MediaOperationRecord>("mediaOperations", session.operationId);
    await put("mediaOperations", {
      ...operation,
      nextAttemptAt: "2000-01-01T00:00:00.000Z",
      leaseExpiresAt: "2000-01-01T00:00:00.000Z",
    });

    const controller = task2MediaStore.startMediaRecoveryController();
    await expect(controller.run()).resolves.toBeGreaterThanOrEqual(1);
    controller.dispose();
    expect(storage.files.size).toBe(0);
    expect(await getRecord("mediaOperations", session.operationId)).toBeNull();
  });

  it("persists cleanup retry backoff and succeeds from a fresh recovery run", async () => {
    const options = { failRemove: new Error("disk busy") as Error | undefined };
    const storage = installTestStorage(options);
    const session = await task2MediaStore.beginMediaWrite({
      projectId: "p1",
      sourcePath: "assets/retry.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    });
    await session.write(new Uint8Array([1]));
    await session.abort(new Error("cancelled"));
    const queued = await getRecord<MediaJournalRecord>("mediaOperations", session.operationId);
    const firstAttemptAt = queued!.nextAttemptAt;

    await expect(task2MediaStore.runMediaRecovery({
      leaseOwner: "recovery-a",
      now: () => new Date(firstAttemptAt),
    }))
      .rejects.toMatchObject({ name: "MediaRecoveryError", operationId: session.operationId });
    const failed = await getRecord<MediaJournalRecord>("mediaOperations", session.operationId);
    expect(failed).toMatchObject({ attempts: 1, leaseOwner: null });
    expect(Date.parse(failed!.nextAttemptAt) - Date.parse(firstAttemptAt)).toBe(5_000);

    options.failRemove = undefined;
    await expect(task2MediaStore.runMediaRecovery({
      leaseOwner: "recovery-b",
      now: () => new Date(failed!.nextAttemptAt),
    })).resolves.toBe(1);
    expect(storage.files.size).toBe(0);
    expect(await getRecord("mediaOperations", session.operationId)).toBeNull();
  });

  it("migrates legacy pending writes idempotently and keeps their ten-minute protection", async () => {
    const storage = installTestStorage();
    storage.seedFile("legacy", new Uint8Array([1]), Date.parse("2026-07-11T00:00:00.000Z"));
    await put("mediaPending", {
      id: "legacy",
      opfsPath: "openmontage-media/legacy",
      createdAt: "2026-07-11T00:00:00.000Z",
      state: "writing",
    });

    await expect(task2MediaStore.runMediaRecovery({
      leaseOwner: "first",
      now: () => new Date("2026-07-11T00:09:59.000Z"),
    })).resolves.toBe(0);
    expect(storage.files.has("legacy")).toBe(true);
    expect(await getAll("mediaPending")).toHaveLength(0);
    expect(await getRecord<MediaJournalRecord>("mediaOperations", "legacy"))
      .toMatchObject({ state: "writing" });

    await expect(task2MediaStore.runMediaRecovery({
      leaseOwner: "second",
      now: () => new Date("2026-07-11T00:10:00.000Z"),
    })).resolves.toBe(1);
    expect(storage.files.has("legacy")).toBe(false);
  });

  it("protects untracked compatibility orphans for 24 hours and rechecks exact state", async () => {
    const now = Date.now();
    const storage = installTestStorage();
    storage.seedFile("young", new Uint8Array([1]), now - 23 * 60 * 60 * 1_000);
    storage.seedFile("old", new Uint8Array([2]), now - 25 * 60 * 60 * 1_000);

    await expect(cleanupOrphanedOpfsMedia()).resolves.toBe(1);
    expect(storage.files.has("young")).toBe(true);
    expect(storage.files.has("old")).toBe(false);

    storage.restore();
    const recheckStorage = installTestStorage({ pauseGetDirectory: true });
    recheckStorage.seedFile("rechecked", new Uint8Array([2]), now - 25 * 60 * 60 * 1_000);
    const scanning = cleanupOrphanedOpfsMedia();
    await recheckStorage.directoryStarted;
    await put("mediaOperations", {
      id: "operation-rechecked",
      kind: "media_write",
      mediaId: "rechecked",
      projectId: "p1",
      importSessionId: null,
      sourcePath: "assets/rechecked.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
      opfsPath: "openmontage-media/rechecked",
      state: "writing",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: new Date().toISOString(),
      leaseOwner: "live-writer",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    recheckStorage.releaseDirectory();
    await expect(scanning).resolves.toBe(0);
    expect(recheckStorage.files.has("rechecked")).toBe(true);
  });
});

describe("media recovery controller lifecycle", () => {
  it("runs at the earliest durable due timer", async () => {
    let nowMs = Date.now();
    const dueAt = new Date(nowMs + 5_000).toISOString();
    const storage = installTestStorage();
    storage.seedFile("timer-media", new Uint8Array([1]), nowMs);
    await seedCleanupOperation("timer-operation", "timer-media", dueAt);
    let scheduledCallback: (() => void) | null = null;
    let scheduledDelay: number | undefined;
    const scheduled = deferred<void>();
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: TimerHandler, delay?: number) => {
      if (typeof callback === "function") scheduledCallback = callback as () => void;
      scheduledDelay = delay;
      scheduled.resolve();
      return 1;
    }) as typeof setTimeout);

    const controller = task2MediaStore.startMediaRecoveryController({
      now: () => new Date(nowMs),
      leaseOwner: "timer-controller",
    });
    await controller.run();
    await scheduled.promise;
    expect(scheduledDelay).toBe(5_000);

    nowMs += 5_000;
    scheduledCallback!();
    await waitForStorageState(async () =>
      (await getRecord("mediaOperations", "timer-operation")) === null);
    expect(storage.files.has("timer-media")).toBe(false);
    controller.dispose();
  });

  it("runs recovery when the document becomes visible", async () => {
    let nowMs = Date.now();
    const dueAt = new Date(nowMs + 60_000).toISOString();
    const storage = installTestStorage();
    storage.seedFile("visible-media", new Uint8Array([1]), nowMs);
    await seedCleanupOperation("visible-operation", "visible-media", dueAt);
    const controller = task2MediaStore.startMediaRecoveryController({
      now: () => new Date(nowMs),
      leaseOwner: "visible-controller",
    });
    await controller.run();

    nowMs += 60_000;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitForStorageState(async () =>
      (await getRecord("mediaOperations", "visible-operation")) === null);
    expect(storage.files.has("visible-media")).toBe(false);
    controller.dispose();
  });

  it("dispose removes the visibility listener and clears the durable timer", async () => {
    const nowMs = Date.now();
    const dueAt = new Date(nowMs + 60_000).toISOString();
    installTestStorage();
    await seedCleanupOperation("dispose-operation", "dispose-media", dueAt);
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const controller = task2MediaStore.startMediaRecoveryController({
      now: () => new Date(nowMs),
    });
    await controller.run();
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    const visibilityListener = addSpy.mock.calls.find(([type]) => type === "visibilitychange")?.[1];

    controller.dispose();

    expect(visibilityListener).toBeTypeOf("function");
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", visibilityListener);
    expect(clearSpy).toHaveBeenCalled();
  });

  it("does not schedule another timer when disposed during in-flight recovery", async () => {
    const now = new Date();
    const storage = installTestStorage({ pauseRemove: true });
    storage.seedFile("inflight-media", new Uint8Array([1]), now.getTime());
    await seedCleanupOperation("inflight-operation", "inflight-media", now.toISOString());
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const controller = task2MediaStore.startMediaRecoveryController({
      now: () => now,
      leaseOwner: "inflight-controller",
    });
    const running = controller.run();
    await storage.removeStarted;
    timerSpy.mockClear();

    controller.dispose();
    storage.releaseRemove();
    await running;
    await new Promise((resolve) => realSetTimeout(resolve, 0));

    expect(timerSpy).not.toHaveBeenCalled();
  });
});
