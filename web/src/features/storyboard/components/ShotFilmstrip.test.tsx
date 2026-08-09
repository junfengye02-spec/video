import { cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShot } from "../../../test/fixtures";
import { ShotFilmstrip } from "./ShotFilmstrip";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ShotFilmstrip", () => {
  it("keeps video sources through StrictMode effect restarts", () => {
    const shot = createShot({ id: "shot-1", output_path: "assets/video/shot-1.mp4" });
    const view = render(
      <StrictMode>
        <ShotFilmstrip
          shots={[shot]}
          selectedShotId={shot.id}
          resolveShotMedia={() => "/media/shot-1-v1.mp4"}
          onSelect={vi.fn()}
        />
      </StrictMode>,
    );

    const video = view.container.querySelector("video")!;
    expect(video).toHaveAttribute("src", "/media/shot-1-v1.mp4");
    expect(video.src).toContain("/media/shot-1-v1.mp4");
  });

  it("does not preload duplicate video metadata behind the main preview", () => {
    const shot = createShot({ id: "shot-1", output_path: "assets/video/shot-1.mp4" });
    const view = render(
      <ShotFilmstrip
        shots={[shot]}
        selectedShotId={shot.id}
        resolveShotMedia={() => "/media/shot-1-v1.mp4"}
        onSelect={vi.fn()}
      />,
    );

    expect(view.container.querySelector("video")).toHaveAttribute("preload", "none");
  });

  it("pauses without mutating the React-owned source when the filmstrip unmounts", () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const shot = createShot({ id: "shot-1", output_path: "assets/video/shot-1.mp4" });
    const view = render(
      <ShotFilmstrip
        shots={[shot]}
        selectedShotId={shot.id}
        resolveShotMedia={() => "/media/shot-1-v1.mp4"}
        onSelect={vi.fn()}
      />,
    );
    const video = view.container.querySelector("video");
    expect(video).not.toBeNull();
    Object.defineProperty(video!, "paused", { configurable: true, value: false });
    const removeAttribute = vi.spyOn(video!, "removeAttribute");

    view.unmount();

    expect(pause).toHaveBeenCalled();
    expect(removeAttribute).not.toHaveBeenCalledWith("src");
    expect(video).toHaveAttribute("src", "/media/shot-1-v1.mp4");
  });
});
