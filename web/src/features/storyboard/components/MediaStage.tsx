import {
  Film,
  LoaderCircle,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Shot } from "../../../domain/types";
import { getStrings } from "../../../i18n";
import { useFittedMediaCanvas } from "../model/useFittedMediaCanvas";
import { MediaVisual, type MediaDescriptor } from "./MediaVisual";
import { shotMediaKind, stableAspectRatio } from "./shotMedia";
import { VideoControls } from "./VideoControls";
import styles from "./MediaStage.module.css";

type MediaState = "empty" | "loading" | "ready" | "error";
const CACHE_FALLBACK_DELAY_MS = 1_200;

interface MediaLayer {
  descriptor: MediaDescriptor;
  role: "current" | "previous";
}

function descriptorFor(
  shot: Shot | null,
  mediaUrl: string | null,
  mediaIdentity?: string,
): MediaDescriptor {
  return {
    key: `${mediaIdentity ?? shot?.id ?? "none"}:${mediaUrl ?? "empty"}`,
    kind: shot && mediaUrl ? shotMediaKind(shot, mediaUrl) : null,
    mediaUrl,
    shot,
  };
}

export function MediaStage({
  shot,
  mediaUrl,
  mediaUrls,
  fallbackMediaUrl = null,
  aspectRatio,
  generating = false,
  eyebrow,
  title,
  description,
  mediaIdentity,
}: {
  shot: Shot | null;
  mediaUrl: string | null;
  mediaUrls?: string[];
  fallbackMediaUrl?: string | null;
  aspectRatio?: string | null;
  generating?: boolean;
  eyebrow?: string;
  title?: string;
  description?: string | null;
  mediaIdentity?: string;
}) {
  const strings = getStrings("zh").storyboardPage;
  const playlist = useMemo(() => Array.from(new Set(
    (mediaUrls?.length ? mediaUrls : mediaUrl ? [mediaUrl] : [])
      .map((url) => url.trim())
      .filter(Boolean),
  )), [mediaUrl, mediaUrls]);
  const identity = mediaIdentity ?? shot?.id ?? "none";
  const playlistKey = `${identity}:${playlist.join("|")}`;
  const [playlistCursor, setPlaylistCursor] = useState({ key: playlistKey, index: 0 });
  const playlistIndex = playlistCursor.key === playlistKey
    ? Math.min(playlistCursor.index, Math.max(0, playlist.length - 1))
    : 0;
  const primaryMediaUrl = playlist[playlistIndex] ?? null;
  const sourceKey = `${identity}:${primaryMediaUrl ?? "empty"}:${fallbackMediaUrl ?? "empty"}`;
  const canFallback = Boolean(
    playlist.length <= 1 && fallbackMediaUrl && fallbackMediaUrl !== primaryMediaUrl,
  );
  const [failedPrimaryKey, setFailedPrimaryKey] = useState<string | null>(null);
  const effectiveMediaUrl = (!primaryMediaUrl || (canFallback && failedPrimaryKey === sourceKey))
    ? fallbackMediaUrl ?? primaryMediaUrl
    : primaryMediaUrl;
  const descriptor = useMemo(
    () => descriptorFor(shot, effectiveMediaUrl, identity),
    [effectiveMediaUrl, identity, shot],
  );
  const [layers, setLayers] = useState<MediaLayer[]>([
    { descriptor, role: "current" },
  ]);
  const [mediaState, setMediaState] = useState<MediaState>(
    effectiveMediaUrl ? "loading" : "empty",
  );
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const currentVideoRef = useRef<HTMLVideoElement | null>(null);
  const continuePlaybackRef = useRef(false);
  const descriptorKeyRef = useRef(descriptor.key);
  const currentDescriptor = layers.find((layer) => layer.role === "current")?.descriptor ?? descriptor;
  const previousDescriptor = layers.find((layer) => layer.role === "previous")?.descriptor ?? null;
  const currentReady = mediaState === "ready" || mediaState === "error" || mediaState === "empty";
  const stableRatio = stableAspectRatio(aspectRatio ?? shot?.aspect_ratio);
  const { style: canvasStyle, viewportRef } = useFittedMediaCanvas(stableRatio);

  useEffect(() => {
    if (playlistCursor.key === playlistKey) return;
    continuePlaybackRef.current = false;
    setPlaylistCursor({ key: playlistKey, index: 0 });
  }, [playlistCursor.key, playlistKey]);

  useEffect(() => {
    const keyChanged = descriptorKeyRef.current !== descriptor.key;
    descriptorKeyRef.current = descriptor.key;
    setLayers((current) => {
      const active = current.find((layer) => layer.role === "current")?.descriptor;
      if (active?.key === descriptor.key) {
        return current.map((layer) => layer.role === "current" ? { ...layer, descriptor } : layer);
      }
      return [
        ...(active ? [{ descriptor: active, role: "previous" as const }] : []),
        { descriptor, role: "current" as const },
      ];
    });
    if (keyChanged) {
      setMediaState(descriptor.mediaUrl ? "loading" : "empty");
      setPlaying(false);
      setCurrentTime(0);
      setDuration(0);
    }
  }, [descriptor]);

  useEffect(() => {
    if (!previousDescriptor || !currentReady) return;
    const timer = window.setTimeout(() => {
      setLayers((current) => current.filter((layer) => layer.role === "current"));
    }, 210);
    return () => window.clearTimeout(timer);
  }, [currentDescriptor.key, currentReady, previousDescriptor?.key]);

  useEffect(() => {
    if (
      mediaState !== "loading"
      || !canFallback
      || effectiveMediaUrl !== primaryMediaUrl
    ) return;
    const timer = window.setTimeout(() => {
      setFailedPrimaryKey(sourceKey);
    }, CACHE_FALLBACK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [canFallback, effectiveMediaUrl, mediaState, primaryMediaUrl, sourceKey]);

  function handleReady(key: string, video?: HTMLVideoElement) {
    if (key !== currentDescriptor.key) return;
    setMediaState("ready");
    if (video) {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setCurrentTime(video.currentTime || 0);
      video.muted = muted;
      if (continuePlaybackRef.current) {
        continuePlaybackRef.current = false;
        void video.play().catch(() => setPlaying(false));
      }
    }
  }

  function handleError(key: string) {
    if (key !== currentDescriptor.key) return;
    if (canFallback && effectiveMediaUrl === primaryMediaUrl) {
      setFailedPrimaryKey(sourceKey);
      return;
    }
    setMediaState("error");
  }

  async function togglePlayback() {
    const video = currentVideoRef.current;
    if (!video) return;
    if (video.paused) {
      try {
        await video.play();
      } catch {
        setPlaying(false);
      }
    } else {
      video.pause();
    }
  }

  function handleEnded(key: string) {
    if (key !== currentDescriptor.key) return;
    if (playlistIndex >= playlist.length - 1) {
      setPlaying(false);
      return;
    }
    continuePlaybackRef.current = true;
    setPlaylistCursor({ key: playlistKey, index: playlistIndex + 1 });
  }

  const showVideoControls = currentDescriptor.kind === "video"
    && mediaState === "ready"
    && Boolean(currentDescriptor.mediaUrl);

  return (
    <section className={styles.root} aria-label={strings.previewLabel}>
      <header className={styles.heading}>
        <div>
          <span>{eyebrow ?? (shot ? String(shot.index).padStart(2, "0") : "--")}</span>
          <h2>{title ?? (shot ? strings.shotTitle(shot.index) : strings.previewLabel)}</h2>
        </div>
        {description !== undefined
          ? description ? <p>{description}</p> : null
          : shot ? <p>{shot.beat}</p> : null}
      </header>
      <div ref={viewportRef} className={styles.viewport}>
        <div
          className={styles.canvas}
          data-media-state={mediaState}
          data-has-previous={previousDescriptor ? "true" : undefined}
          data-current-ready={currentReady ? "true" : "false"}
          data-playlist-index={playlist.length ? String(playlistIndex) : undefined}
          data-playlist-size={playlist.length ? String(playlist.length) : undefined}
          aria-busy={mediaState === "loading" || generating ? "true" : undefined}
          style={canvasStyle}
        >
          {layers.map((layer) => (
            <MediaVisual
              key={layer.descriptor.key}
              active={layer.role === "current"}
              descriptor={layer.descriptor}
              videoRef={layer.role === "current" ? currentVideoRef : undefined}
              onReady={handleReady}
              onError={handleError}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(video) => setCurrentTime(video.currentTime)}
              onEnded={handleEnded}
              muted={muted}
            />
          ))}

          {!shot ? (
            <div className={styles.emptyState}>
              <Film aria-hidden="true" size={25} />
              <p>{strings.noSelectedShot}</p>
            </div>
          ) : null}
          {shot && !effectiveMediaUrl ? (
            <div className={styles.emptyState}>
              <Film aria-hidden="true" size={25} />
              <p>{strings.noPreviewMedia}</p>
            </div>
          ) : null}
          {mediaState === "loading" ? (
            <p className={styles.loadingState} role="status">
              <LoaderCircle aria-hidden="true" size={15} />
              {strings.previewLoading}
            </p>
          ) : null}
          {mediaState === "error" ? (
            <p className={styles.errorState} role="alert">{strings.previewError}</p>
          ) : null}
          {generating ? (
            <div className={styles.generationOverlay} role="status">
              <LoaderCircle aria-hidden="true" size={22} />
              <span>{strings.previewGenerating}</span>
            </div>
          ) : null}
          {showVideoControls ? (
            <VideoControls
              currentTime={currentTime}
              duration={duration}
              muted={muted}
              playing={playing}
              onTogglePlayback={() => void togglePlayback()}
              onSeek={(next) => {
                if (currentVideoRef.current) currentVideoRef.current.currentTime = next;
                setCurrentTime(next);
              }}
              onToggleMuted={() => {
                const next = !muted;
                setMuted(next);
                if (currentVideoRef.current) currentVideoRef.current.muted = next;
              }}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
