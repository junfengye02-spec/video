import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../../../shared/motion";
import type { GenerationUnitPreviewItem } from "../model/generationUnitPreview";
import { revealSelectedItem } from "../model/storyboardScroll";
import styles from "./GenerationUnitFilmstrip.module.css";

export function GenerationUnitFilmstrip({
  items,
  selectedKey,
  onSelect,
}: {
  items: GenerationUnitPreviewItem[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const reducedMotion = useReducedMotion();
  const listRef = useRef<HTMLOListElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    const list = listRef.current;
    const item = selectedKey ? itemRefs.current.get(selectedKey) : null;
    if (!list || !item) return;
    return revealSelectedItem(list, item, "horizontal", reducedMotion);
  }, [reducedMotion, selectedKey]);

  return (
    <nav className={styles.root} aria-label="视频生成单元">
      <ol ref={listRef} className={styles.list} data-testid="generation-unit-filmstrip">
        {items.map((item, index) => {
          const ordinal = index + 1;
          const shotIndexes = item.sourceShots.map((shot) => shot.index);
          const sourceLabel = shotIndexes.length
            ? `分镜 ${shotIndexes.map((value) => String(value).padStart(2, "0")).join("、")}`
            : "来源分镜未知";
          return (
            <li key={item.key}>
              <button
                ref={(node) => {
                  if (node) itemRefs.current.set(item.key, node);
                  else itemRefs.current.delete(item.key);
                }}
                type="button"
                aria-label={`选择视频单元 ${ordinal}，${sourceLabel}`}
                aria-pressed={selectedKey === item.key}
                onClick={() => onSelect(item.key)}
              >
                <UnitFilmstripMedia mediaUrl={item.mediaUrl} unitKey={item.key} />
                <span className={styles.unitLabel}>U{String(ordinal).padStart(2, "0")}</span>
                <span className={styles.shotLabel}>{sourceLabel}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function UnitFilmstripMedia({ mediaUrl, unitKey }: { mediaUrl: string | null; unitKey: string }) {
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => setFailed(false), [mediaUrl, unitKey]);
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (video && !video.paused) video.pause();
    };
  }, []);
  if (!mediaUrl || failed) return <span className={styles.placeholder} aria-hidden="true" />;
  return (
    <video
      ref={videoRef}
      src={mediaUrl}
      aria-hidden="true"
      muted
      playsInline
      preload="metadata"
      onError={() => setFailed(true)}
    />
  );
}
