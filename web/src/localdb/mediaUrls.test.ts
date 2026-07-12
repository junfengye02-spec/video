import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLocalMediaUrl, revokeLocalMediaUrls } from "./mediaUrls";
import type { LocalMediaRef } from "./types";

const mediaRepositoryMocks = vi.hoisted(() => ({
  mediaRepository: {
    resolve: vi.fn(),
    revokeAll: vi.fn(),
  },
}));

vi.mock("../platform/storage/MediaRepository", () => mediaRepositoryMocks);

beforeEach(() => {
  mediaRepositoryMocks.mediaRepository.resolve.mockReset();
  mediaRepositoryMocks.mediaRepository.revokeAll.mockReset();
});

describe("mediaUrls", () => {
  it("resolves local media URLs through the media repository singleton", async () => {
    mediaRepositoryMocks.mediaRepository.resolve.mockResolvedValue("blob:local");
    const ref = "local://media/p1" as LocalMediaRef;

    await expect(resolveLocalMediaUrl(ref)).resolves.toBe("blob:local");

    expect(mediaRepositoryMocks.mediaRepository.resolve).toHaveBeenCalledWith(ref);
  });

  it("revokes local media URLs through the media repository singleton", () => {
    revokeLocalMediaUrls();

    expect(mediaRepositoryMocks.mediaRepository.revokeAll).toHaveBeenCalledTimes(1);
  });
});
