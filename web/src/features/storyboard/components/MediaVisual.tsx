import { useEffect, useRef, type MutableRefObject } from "react";
import type { Shot } from "../../../domain/types";
import { getStrings } from "../../../i18n";
import type { ShotMediaKind } from "./shotMedia";
import styles from "./MediaStage.module.css";

export interface MediaDescriptor {
  key: string;
  kind: ShotMediaKind | null;
  mediaUrl: string | null;
  shot: Shot | null;
}

export function MediaVisual({
  active,
  descriptor,
  videoRef,
  onReady,
  onError,
  onPlay,
  onPause,
  onTimeUpdate,
  onEnded,
  muted,
}: {
  active: boolean;
  descriptor: MediaDescriptor;
  videoRef?: MutableRefObject<HTMLVideoElement | null>;
  onReady: (key: string, video?: HTMLVideoElement) => void;
  onError: (key: string) => void;
  onPlay: () => void;
  onPause: () => void;
  onTimeUpdate: (video: HTMLVideoElement) => void;
  onEnded: (key: string) => void;
  muted: boolean;
}) {
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const { kind, mediaUrl, shot } = descriptor;

  useEffect(() => {
    const video = localVideoRef.current;
    if (video && !active && !video.paused) video.pause();
  }, [active]);

  useEffect(() => {
    const video = localVideoRef.current;
    return () => {
      if (!video) return;
      if (!video.paused) video.pause();
      // React owns the source lifecycle; StrictMode replays this cleanup while the node stays mounted.
    };
  }, []);

  if (!shot || !mediaUrl || !kind) return null;
  const strings = getStrings("zh").storyboardPage;
  const className = `${styles.mediaLayer} ${active ? styles.currentLayer : styles.previousLayer}`;
  if (kind === "image") {
    return (
      <img
        className={className}
        src={mediaUrl}
        alt={active ? strings.previewMediaLabel(shot.index) : ""}
        aria-hidden={active ? undefined : "true"}
        onLoad={() => onReady(descriptor.key)}
        onError={() => onError(descriptor.key)}
      />
    );
  }
  return (
    <video
      ref={(node) => {
        localVideoRef.current = node;
        if (videoRef) videoRef.current = node;
      }}
      className={className}
      src={mediaUrl}
      playsInline
      preload="metadata"
      muted={muted}
      aria-label={active ? strings.previewMediaLabel(shot.index) : undefined}
      aria-hidden={active ? undefined : "true"}
      onLoadedData={(event) => onReady(descriptor.key, event.currentTarget)}
      onLoadedMetadata={(event) => onReady(descriptor.key, event.currentTarget)}
      onError={() => onError(descriptor.key)}
      onPlay={onPlay}
      onPause={onPause}
      onTimeUpdate={(event) => onTimeUpdate(event.currentTarget)}
      onEnded={() => onEnded(descriptor.key)}
    />
  );
}
