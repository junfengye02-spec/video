import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLocalDbForTests } from "./indexedDb";
import { cacheRemoteMedia, loadMediaBlob, saveMediaBlob } from "./mediaStore";
import { LOCAL_DB_NAME } from "./types";

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

afterEach(async () => {
  vi.unstubAllGlobals();
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
});
