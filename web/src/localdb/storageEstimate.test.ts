import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBytes, getStorageEstimate } from "./storageEstimate";

const originalStorage = Object.getOwnPropertyDescriptor(Navigator.prototype, "storage");

afterEach(() => {
  vi.restoreAllMocks();
  if (originalStorage) {
    Object.defineProperty(Navigator.prototype, "storage", originalStorage);
  } else {
    delete (Navigator.prototype as { storage?: StorageManager }).storage;
  }
});

describe("storageEstimate", () => {
  it("returns null fields when storage estimates are unavailable", async () => {
    Object.defineProperty(Navigator.prototype, "storage", {
      configurable: true,
      value: undefined,
    });

    await expect(getStorageEstimate()).resolves.toEqual({
      usageBytes: null,
      quotaBytes: null,
      persisted: null,
    });
  });

  it("reads usage, quota, and persistence from navigator storage", async () => {
    Object.defineProperty(Navigator.prototype, "storage", {
      configurable: true,
      value: {
        estimate: vi.fn(async () => ({ usage: 1536, quota: 10 * 1024 * 1024 })),
        persisted: vi.fn(async () => true),
      },
    });

    await expect(getStorageEstimate()).resolves.toEqual({
      usageBytes: 1536,
      quotaBytes: 10 * 1024 * 1024,
      persisted: true,
    });
  });

  it("formats byte counts for display", () => {
    expect(formatBytes(null)).toBe("Unknown");
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });
});
