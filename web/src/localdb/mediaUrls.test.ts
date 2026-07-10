import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLocalDbForTests } from "./indexedDb";
import { saveMediaBlob } from "./mediaStore";
import { resolveLocalMediaUrl, revokeLocalMediaUrls } from "./mediaUrls";
import { LOCAL_DB_NAME } from "./types";

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

async function blobFromText(text: string, contentType: string): Promise<Blob> {
  return new Response(text, { headers: { "content-type": contentType } }).blob();
}

function installObjectUrlSpies(createValue: string) {
  const createObjectURL = vi.fn(() => createValue);
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL,
  });
  return { createObjectURL, revokeObjectURL };
}

function restoreObjectUrlApi() {
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
  } else {
    delete (URL as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectURL);
  } else {
    delete (URL as { revokeObjectURL?: typeof URL.revokeObjectURL }).revokeObjectURL;
  }
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
  revokeLocalMediaUrls();
  vi.restoreAllMocks();
  restoreObjectUrlApi();
  await deleteLocalDb();
});

describe("mediaUrls", () => {
  it("resolves local media refs to cached object URLs", async () => {
    const { createObjectURL } = installObjectUrlSpies("blob:local-media");
    const ref = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/video/shot.mp4",
      contentType: "video/mp4",
      blob: await blobFromText("video", "video/mp4"),
    });

    await expect(resolveLocalMediaUrl(ref)).resolves.toBe("blob:local-media");
    await expect(resolveLocalMediaUrl(ref)).resolves.toBe("blob:local-media");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("revokes resolved object URLs", async () => {
    const { revokeObjectURL } = installObjectUrlSpies("blob:to-revoke");
    const ref = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/video/shot.mp4",
      contentType: "video/mp4",
      blob: await blobFromText("video", "video/mp4"),
    });

    await resolveLocalMediaUrl(ref);
    revokeLocalMediaUrls();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:to-revoke");
  });
});
