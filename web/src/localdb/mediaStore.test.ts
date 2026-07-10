import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLocalDbForTests } from "./indexedDb";
import { cacheRemoteMedia, loadMediaBlob, saveMediaBlob } from "./mediaStore";
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

async function deleteLocalDb() {
  resetLocalDbForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
  });
}

function installOpfs(options: { removeError: Error | null }) {
  const files = new Map<string, Blob>();
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
            },
            async close() {},
          };
        },
      };
    },
    async removeEntry(name: string) {
      if (options.removeError) throw options.removeError;
      if (!files.delete(name)) throw new DOMException("File not found", "NotFoundError");
    },
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
        return {
          async getDirectoryHandle() {
            return mediaDirectory;
          },
        };
      },
    },
  });
  return { files };
}

afterEach(async () => {
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
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw idbError;
    });

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
    const putSpy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
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
});
