import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShot } from "../../../test/fixtures";
import { MediaStage } from "./MediaStage";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MediaStage", () => {
  it("keeps a cached video source and playback ref through StrictMode effect restarts", () => {
    const shot = createShot({ output_path: "local://media/shot" });
    const rendered = render(
      <StrictMode>
        <MediaStage shot={shot} mediaUrl="blob:cached-shot" />
      </StrictMode>,
    );
    const video = rendered.container.querySelector<HTMLVideoElement>(
      'video[src="blob:cached-shot"]',
    )!;

    expect(video).toHaveAttribute("src", "blob:cached-shot");
    expect(video.src).toBe("blob:cached-shot");

    fireEvent.loadedMetadata(video);
    fireEvent.click(screen.getByRole("button", { name: /播放/ }));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it("keeps empty and media states inside the project aspect ratio", () => {
    const { rerender } = render(<MediaStage shot={null} mediaUrl={null} aspectRatio="9:16" />);
    expect(screen.getByText("请选择或创建分镜以进行预览。").closest("[data-media-state]"))
      .toHaveStyle({ aspectRatio: "9 / 16" });

    rerender(<MediaStage shot={createShot()} mediaUrl={null} aspectRatio="2.39:1" />);
    expect(screen.getByText("当前分镜尚无预览媒体").closest("[data-media-state]"))
      .toHaveStyle({ aspectRatio: "2.39 / 1" });
  });

  it("crossfades without removing the old medium before the new one is ready", () => {
    vi.useFakeTimers();
    const oldShot = createShot({ id: "shot-1", output_path: "assets/video/old.mp4" });
    const newShot = createShot({ id: "shot-2", index: 2, output_path: "assets/images/new.webp" });
    const rendered = render(<MediaStage shot={oldShot} mediaUrl="blob:old" aspectRatio="16:9" />);
    const oldVideo = rendered.container.querySelector<HTMLVideoElement>('video[src="blob:old"]')!;
    fireEvent.loadedData(oldVideo);

    rendered.rerender(<MediaStage shot={newShot} mediaUrl="blob:new" aspectRatio="16:9" />);
    const newImage = screen.getByRole("img", { name: "分镜 2 预览媒体" });
    expect(rendered.container.querySelector('video[src="blob:old"]')).toBe(oldVideo);
    expect(screen.getByText("正在加载预览媒体...")).toBeInTheDocument();

    fireEvent.load(newImage);
    expect(rendered.container.querySelector('video[src="blob:old"]')).toBe(oldVideo);
    act(() => vi.advanceTimersByTime(210));

    expect(rendered.container.querySelector('video[src="blob:old"]')).not.toBeInTheDocument();
    expect(oldVideo).toHaveAttribute("src", "blob:old");
  });

  it("retains old media under a regeneration overlay", () => {
    const shot = createShot({ output_path: "assets/video/shot.mp4" });
    const rendered = render(<MediaStage shot={shot} mediaUrl="blob:shot" generating />);
    const media = screen.getByLabelText("分镜 1 预览媒体");
    fireEvent.loadedData(media);

    expect(screen.getByText("视频正在生成")).toBeInTheDocument();
    expect(rendered.container.querySelector('video[src="blob:shot"]')).toBeInTheDocument();
    expect(media.closest("[data-media-state]")).toHaveAttribute("aria-busy", "true");
  });

  it("does not restart media loading when only shot metadata changes", () => {
    const shot = createShot({ output_path: "assets/video/shot.mp4" });
    const rendered = render(<MediaStage shot={shot} mediaUrl="blob:shot" />);
    const media = screen.getByLabelText("分镜 1 预览媒体");
    fireEvent.loadedData(media);
    expect(media.closest("[data-media-state]")).toHaveAttribute("data-media-state", "ready");

    rendered.rerender(<MediaStage shot={{ ...shot, status: "complete", version: 3 }} mediaUrl="blob:shot" />);

    expect(media.closest("[data-media-state]")).toHaveAttribute("data-media-state", "ready");
    expect(screen.queryByText("正在加载预览媒体...")).not.toBeInTheDocument();
  });

  it("shows stable media failure without changing the canvas", () => {
    const shot = createShot({ output_path: "assets/video/missing.mp4" });
    render(<MediaStage shot={shot} mediaUrl="/media/missing.mp4" aspectRatio="1:1" />);
    const media = screen.getByLabelText("分镜 1 预览媒体");
    const canvas = media.closest("[data-media-state]");
    fireEvent.error(media);

    expect(screen.getByRole("alert")).toHaveTextContent("预览媒体加载失败。");
    expect(canvas).toHaveStyle({ aspectRatio: "1 / 1" });
    expect(canvas).toHaveAttribute("data-media-state", "error");
  });

  it("keeps the server fallback source through StrictMode after cached media fails", () => {
    const shot = createShot({ output_path: "local://media/shot", output_url: "assets/video/shot.mp4" });
    const rendered = render(
      <StrictMode>
        <MediaStage
          shot={shot}
          mediaUrl="blob:cached-shot"
          fallbackMediaUrl="/api/projects/p1/media/assets/video/shot.mp4"
        />
      </StrictMode>,
    );
    const cached = rendered.container.querySelector<HTMLVideoElement>('video[src="blob:cached-shot"]')!;

    fireEvent.error(cached);

    const fallback = rendered.container.querySelector<HTMLVideoElement>(
      'video[src="/api/projects/p1/media/assets/video/shot.mp4"]',
    )!;
    expect(fallback).toBeInTheDocument();
    expect(fallback).toHaveAttribute("src", "/api/projects/p1/media/assets/video/shot.mp4");
    expect(fallback.src).toContain("/api/projects/p1/media/assets/video/shot.mp4");
    fireEvent.loadedMetadata(fallback);
    expect(fallback.closest("[data-media-state]")).toHaveAttribute("data-media-state", "ready");
  });

  it("uses the server source immediately when cache resolution returns no media", () => {
    const shot = createShot({ output_path: "local://media/shot", output_url: "assets/video/shot.mp4" });
    const rendered = render(
      <StrictMode>
        <MediaStage
          shot={shot}
          mediaUrl={null}
          fallbackMediaUrl="/api/projects/p1/media/assets/video/shot.mp4"
        />
      </StrictMode>,
    );
    const fallback = rendered.container.querySelector<HTMLVideoElement>(
      'video[src="/api/projects/p1/media/assets/video/shot.mp4"]',
    )!;

    expect(fallback).toBeInTheDocument();
    fireEvent.loadedMetadata(fallback);
    expect(fallback.closest("[data-media-state]")).toHaveAttribute("data-media-state", "ready");
  });

  it("falls back when cached media does not become ready promptly", () => {
    vi.useFakeTimers();
    const shot = createShot({ output_path: "local://media/shot", output_url: "assets/video/shot.mp4" });
    const rendered = render(
      <MediaStage
        shot={shot}
        mediaUrl="blob:cached-shot"
        fallbackMediaUrl="/api/projects/p1/media/assets/video/shot.mp4"
      />,
    );

    act(() => vi.advanceTimersByTime(1_200));

    expect(rendered.container.querySelector(
      'video[src="/api/projects/p1/media/assets/video/shot.mp4"]',
    )).toBeInTheDocument();
  });

  it("reloads after remount and survives switching between episode media sources", () => {
    const firstShot = createShot({ id: "episode-1-shot", output_path: "assets/video/episode-1.mp4" });
    const secondShot = createShot({ id: "episode-2-shot", index: 2, output_path: "assets/video/episode-2.mp4" });
    const firstUrl = "/api/projects/p1/media/assets/video/episode-1.mp4";
    const secondUrl = "/api/projects/p1/media/assets/video/episode-2.mp4";
    const renderStage = (shot: typeof firstShot, url: string) => (
      <StrictMode><MediaStage shot={shot} mediaUrl={url} /></StrictMode>
    );
    const rendered = render(renderStage(firstShot, firstUrl));
    const firstVideo = rendered.container.querySelector<HTMLVideoElement>(`video[src="${firstUrl}"]`)!;
    fireEvent.loadedMetadata(firstVideo);
    expect(firstVideo.closest("[data-media-state]")).toHaveAttribute("data-media-state", "ready");

    rendered.rerender(renderStage(secondShot, secondUrl));
    const secondVideo = rendered.container.querySelector<HTMLVideoElement>(`video[src="${secondUrl}"]`)!;
    fireEvent.loadedMetadata(secondVideo);
    expect(secondVideo.closest("[data-media-state]")).toHaveAttribute("data-media-state", "ready");

    rendered.rerender(renderStage(firstShot, firstUrl));
    const restoredVideo = rendered.container.querySelector<HTMLVideoElement>(`video[src="${firstUrl}"]`)!;
    fireEvent.loadedMetadata(restoredVideo);
    expect(restoredVideo.closest("[data-media-state]")).toHaveAttribute("data-media-state", "ready");

    rendered.unmount();
    const remounted = render(renderStage(firstShot, firstUrl));
    const refreshedVideo = remounted.container.querySelector<HTMLVideoElement>(`video[src="${firstUrl}"]`)!;
    expect(refreshedVideo).toBeInTheDocument();
    fireEvent.loadedMetadata(refreshedVideo);
    expect(refreshedVideo.closest("[data-media-state]")).toHaveAttribute("data-media-state", "ready");
  });

  it("places low-profile playback controls at the ready video", () => {
    const shot = createShot({ output_path: "assets/video/shot.mp4" });
    render(<MediaStage shot={shot} mediaUrl="blob:shot" />);
    const video = screen.getByLabelText("分镜 1 预览媒体");
    Object.defineProperty(video, "duration", { value: 12, configurable: true });
    fireEvent.loadedData(video);

    expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "播放进度" })).toHaveAttribute("max", "12");
    expect(screen.getByRole("button", { name: "开启声音" })).toBeInTheDocument();
  });

  it("plays ordered generation-unit media as one shot playlist", () => {
    const shot = createShot({ output_path: null, status: "ready" });
    const rendered = render(
      <MediaStage
        shot={shot}
        mediaUrl="/media/unit-1.mp4"
        mediaUrls={["/media/unit-1.mp4", "/media/unit-2.mp4"]}
      />,
    );
    const first = rendered.container.querySelector<HTMLVideoElement>(
      'video[src="/media/unit-1.mp4"]',
    )!;
    fireEvent.loadedMetadata(first);
    fireEvent.ended(first);

    const second = rendered.container.querySelector<HTMLVideoElement>(
      'video[src="/media/unit-2.mp4"]',
    )!;
    expect(second).toBeInTheDocument();
    expect(second.closest("[data-media-state]")).toHaveAttribute("data-playlist-index", "1");
    expect(second.closest("[data-media-state]")).toHaveAttribute("data-playlist-size", "2");

    fireEvent.loadedMetadata(second);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it("pauses a released video layer without mutating its React-owned source", () => {
    vi.useFakeTimers();
    const shot = createShot({ output_path: "assets/video/one.mp4" });
    const rendered = render(<MediaStage shot={shot} mediaUrl="blob:one" />);
    const video = screen.getByLabelText("分镜 1 预览媒体") as HTMLVideoElement;
    Object.defineProperty(video, "paused", { configurable: true, value: false });
    fireEvent.loadedData(video);
    rendered.rerender(<MediaStage shot={{ ...shot, output_path: "assets/images/two.png" }} mediaUrl="blob:two" />);
    fireEvent.load(screen.getByRole("img", { name: "分镜 1 预览媒体" }));
    act(() => vi.advanceTimersByTime(210));

    expect(video).not.toBeInTheDocument();
    expect(video).toHaveAttribute("src", "blob:one");
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });
});
