import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLocalMediaUrl, revokeLocalMediaUrls } from "./mediaUrls";
import type { LocalMediaRef } from "./types";

const mediaStoreMocks = vi.hoisted(() => ({
  loadMediaBlob: vi.fn(),
}));

vi.mock("./mediaStore", () => mediaStoreMocks);

const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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

beforeEach(() => {
  mediaStoreMocks.loadMediaBlob.mockReset();
  revokeLocalMediaUrls();
  restoreObjectUrlApi();
});

function mediaRef(id: string): LocalMediaRef {
  return `local://media/${id}`;
}

afterEach(async () => {
  revokeLocalMediaUrls();
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreObjectUrlApi();
});

describe("mediaUrls", () => {
  it("resolves local media refs to cached object URLs", async () => {
    const { createObjectURL } = installObjectUrlSpies("blob:local-media");
    const ref = mediaRef("cached");
    mediaStoreMocks.loadMediaBlob.mockResolvedValue(new Blob(["video"], { type: "video/mp4" }));

    await expect(resolveLocalMediaUrl(ref)).resolves.toBe("blob:local-media");
    await expect(resolveLocalMediaUrl(ref)).resolves.toBe("blob:local-media");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(mediaStoreMocks.loadMediaBlob).toHaveBeenCalledTimes(1);
  });

  it("revokes resolved object URLs", async () => {
    const { revokeObjectURL } = installObjectUrlSpies("blob:to-revoke");
    const ref = mediaRef("revoke");
    mediaStoreMocks.loadMediaBlob.mockResolvedValue(new Blob(["video"], { type: "video/mp4" }));

    await resolveLocalMediaUrl(ref);
    revokeLocalMediaUrls();

    expect(revokeObjectURL).toHaveBeenCalledWith("blob:to-revoke");
  });

  it("caches missing media until the global cache is revoked", async () => {
    installObjectUrlSpies("blob:retried");
    const ref = mediaRef("missing");
    mediaStoreMocks.loadMediaBlob.mockResolvedValueOnce(null);

    await expect(resolveLocalMediaUrl(ref)).resolves.toBeNull();
    await expect(resolveLocalMediaUrl(ref)).resolves.toBeNull();

    expect(mediaStoreMocks.loadMediaBlob).toHaveBeenCalledTimes(1);

    revokeLocalMediaUrls();
    mediaStoreMocks.loadMediaBlob.mockResolvedValueOnce(new Blob(["now-present"]));
    await expect(resolveLocalMediaUrl(ref)).resolves.toBe("blob:retried");
    expect(mediaStoreMocks.loadMediaBlob).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent resolutions for the same media ref", async () => {
    const { createObjectURL } = installObjectUrlSpies("blob:shared");
    const ref = mediaRef("concurrent");
    const load = deferred<Blob | null>();
    mediaStoreMocks.loadMediaBlob.mockReturnValue(load.promise);

    const first = resolveLocalMediaUrl(ref);
    const second = resolveLocalMediaUrl(ref);
    load.resolve(new Blob(["video"]));

    await expect(Promise.all([first, second])).resolves.toEqual(["blob:shared", "blob:shared"]);
    expect(mediaStoreMocks.loadMediaBlob).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("does not create an object URL when revoked during a pending resolution", async () => {
    const { createObjectURL } = installObjectUrlSpies("blob:stale");
    const ref = mediaRef("pending");
    const load = deferred<Blob | null>();
    mediaStoreMocks.loadMediaBlob.mockReturnValueOnce(load.promise);

    const pending = resolveLocalMediaUrl(ref);
    revokeLocalMediaUrls();
    load.resolve(new Blob(["video"]));

    await expect(pending).resolves.toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();

    mediaStoreMocks.loadMediaBlob.mockResolvedValueOnce(new Blob(["fresh"]));
    await expect(resolveLocalMediaUrl(ref)).resolves.toBe("blob:stale");
    expect(mediaStoreMocks.loadMediaBlob).toHaveBeenCalledTimes(2);
  });

  it("backs off repeated storage errors until the cache is retried or revoked", async () => {
    vi.useFakeTimers();
    const ref = mediaRef("storage-error");
    const storageError = new Error("IndexedDB unavailable");
    mediaStoreMocks.loadMediaBlob.mockRejectedValue(storageError);

    await expect(resolveLocalMediaUrl(ref)).rejects.toBe(storageError);
    await expect(resolveLocalMediaUrl(ref)).rejects.toBe(storageError);
    expect(mediaStoreMocks.loadMediaBlob).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(resolveLocalMediaUrl(ref)).rejects.toBe(storageError);
    expect(mediaStoreMocks.loadMediaBlob).toHaveBeenCalledTimes(2);

    revokeLocalMediaUrls();
    await expect(resolveLocalMediaUrl(ref)).rejects.toBe(storageError);
    expect(mediaStoreMocks.loadMediaBlob).toHaveBeenCalledTimes(3);
  });
});
