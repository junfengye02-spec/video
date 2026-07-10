import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLocalDbForTests } from "./indexedDb";
import {
  cacheRemoteMedia,
  cleanupOrphanedOpfsMedia,
  loadMediaBlob,
  saveMediaBlob,
} from "./mediaStore";
import { LOCAL_DB_NAME } from "./types";

const originalStorage = Object.getOwnPropertyDescriptor(Navigator.prototype, "storage");

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
            async write(blob: Blob) {
              files.set(name, blob);
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

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalStorage) {
    Object.defineProperty(Navigator.prototype, "storage", originalStorage);
  } else {
    delete (Navigator.prototype as { storage?: StorageManager }).storage;
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

  it("preserves both failures when an OPFS write cannot be recorded or rolled back", async () => {
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

    expect(failure).toMatchObject({ causes: [idbError, opfsError] });
    expect(files.size).toBe(1);
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

    const mediaStore = await import("./mediaStore") as typeof import("./mediaStore") & {
      cleanupOrphanedOpfsMedia?: () => Promise<number>;
    };
    expect(mediaStore.cleanupOrphanedOpfsMedia).toBeTypeOf("function");
    await expect(mediaStore.cleanupOrphanedOpfsMedia!()).resolves.toBe(1);
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

  it("surfaces cache cleanup failures and schedules one safe recovery scan", async () => {
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
    })).rejects.toMatchObject({
      name: "MediaCleanupIncompleteError",
      causes: [idbError, opfsError],
    });
    expect(files.size).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    putSpy.mockRestore();
    opfsOptions.removeError = null;
    await vi.waitFor(() => expect(files.size).toBe(0));

    expect(removeEntry).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
