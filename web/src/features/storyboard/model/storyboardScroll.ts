type ScrollAxis = "horizontal" | "vertical";

function easeOut(value: number): number {
  return 1 - (1 - value) ** 3;
}

export function revealSelectedItem(
  container: HTMLElement,
  item: HTMLElement,
  axis: ScrollAxis,
  reducedMotion: boolean,
  duration = 280,
): () => void {
  const containerRect = container.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const horizontal = axis === "horizontal";
  const start = horizontal ? container.scrollLeft : container.scrollTop;
  const leading = horizontal ? itemRect.left - containerRect.left : itemRect.top - containerRect.top;
  const trailing = horizontal ? itemRect.right - containerRect.right : itemRect.bottom - containerRect.bottom;
  const target = horizontal
    ? start + leading - (containerRect.width - itemRect.width) / 2
    : leading < 0
      ? start + leading - 8
      : trailing > 0
        ? start + trailing + 8
        : start;

  const max = horizontal
    ? Math.max(0, container.scrollWidth - container.clientWidth)
    : Math.max(0, container.scrollHeight - container.clientHeight);
  const clampedTarget = Math.max(0, Math.min(max, target));
  if (Math.abs(clampedTarget - start) < 1) return () => undefined;

  if (reducedMotion || typeof requestAnimationFrame !== "function") {
    if (horizontal) container.scrollLeft = clampedTarget;
    else container.scrollTop = clampedTarget;
    return () => undefined;
  }

  let frame = 0;
  let startTime: number | null = null;
  const step = (time: number) => {
    startTime ??= time;
    const progress = Math.min(1, (time - startTime) / duration);
    const next = start + (clampedTarget - start) * easeOut(progress);
    if (horizontal) container.scrollLeft = next;
    else container.scrollTop = next;
    if (progress < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}
