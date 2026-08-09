import { useEffect, useRef, useState } from "react";
import type { Shot } from "../../../domain/types";
import { getStrings } from "../../../i18n";
import { useReducedMotion } from "../../../shared/motion";
import { revealSelectedItem } from "../model/storyboardScroll";
import { shotMediaKind } from "./shotMedia";
import styles from "./ShotFilmstrip.module.css";

export function ShotFilmstrip({
  shots,
  selectedShotId,
  resolveShotMedia,
  onSelect,
}: {
  shots: Shot[];
  selectedShotId: string | null;
  resolveShotMedia: (shot: Shot) => string | null;
  onSelect: (shotId: string) => void;
}) {
  const strings = getStrings("zh").storyboardPage;
  const reducedMotion = useReducedMotion();
  const listRef = useRef<HTMLOListElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    const list = listRef.current;
    const item = selectedShotId ? itemRefs.current.get(selectedShotId) : null;
    if (!list || !item) return;
    return revealSelectedItem(list, item, "horizontal", reducedMotion);
  }, [reducedMotion, selectedShotId]);

  return (
    <nav className={styles.root} aria-label={strings.orderLabel}>
      <ol ref={listRef} className={styles.list} data-testid="shot-filmstrip">
        {shots.map((shot) => (
          <li key={shot.id}>
            <button
              ref={(node) => {
                if (node) itemRefs.current.set(shot.id, node);
                else itemRefs.current.delete(shot.id);
              }}
              type="button"
              aria-label={strings.selectOrderedShotLabel(shot.index)}
              aria-pressed={selectedShotId === shot.id}
              onClick={() => onSelect(shot.id)}
            >
              <FilmstripMedia shot={shot} mediaUrl={resolveShotMedia(shot)} />
              <span>{String(shot.index).padStart(2, "0")}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function FilmstripMedia({ shot, mediaUrl }: { shot: Shot; mediaUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => setFailed(false), [mediaUrl, shot.id]);
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (!video) return;
      if (!video.paused) video.pause();
      // Keep src intact because StrictMode can replay cleanup without unmounting the DOM node.
    };
  }, []);
  if (!mediaUrl || failed) return <span className={styles.placeholder} aria-hidden="true" />;
  if (shotMediaKind(shot, mediaUrl) === "image") {
    return <img src={mediaUrl} alt="" loading="lazy" onError={() => setFailed(true)} />;
  }
  return (
    <video
      ref={videoRef}
      src={mediaUrl}
      aria-hidden="true"
      muted
      playsInline
      preload="none"
      onError={() => setFailed(true)}
    />
  );
}
