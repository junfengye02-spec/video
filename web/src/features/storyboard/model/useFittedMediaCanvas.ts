import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";

function numericRatio(value: string): number {
  const [width, height] = value.split("/").map((part) => Number(part.trim()));
  return width > 0 && height > 0 ? width / height : 16 / 9;
}

export function useFittedMediaCanvas(aspectRatio: string, maxWidth = 1180) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setAvailable({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const style = useMemo(() => {
    if (!available) return { aspectRatio } satisfies CSSProperties;
    const ratio = numericRatio(aspectRatio);
    const width = Math.max(1, Math.min(available.width, available.height * ratio, maxWidth));
    return {
      aspectRatio,
      width: `${width}px`,
      height: `${width / ratio}px`,
    } satisfies CSSProperties;
  }, [aspectRatio, available, maxWidth]);

  return { style, viewportRef };
}
