import { describe, expect, it, vi } from "vitest";
import { revealSelectedItem } from "./storyboardScroll";

function rect(value: Partial<DOMRect>): DOMRect {
  return {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...value,
  };
}

describe("storyboard selected-item scrolling", () => {
  it("reveals a vertical selection immediately for reduced motion", () => {
    const container = document.createElement("div");
    const item = document.createElement("button");
    Object.defineProperties(container, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 800 },
      scrollTop: { value: 100, writable: true },
    });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect({ top: 0, bottom: 200, height: 200 }));
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(rect({ top: 260, bottom: 320, height: 60 }));

    revealSelectedItem(container, item, "vertical", true);

    expect(container.scrollTop).toBe(228);
  });

  it("centers a horizontal selection over a 280ms animation", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const container = document.createElement("div");
    const item = document.createElement("button");
    Object.defineProperties(container, {
      clientWidth: { value: 300 },
      scrollWidth: { value: 1200 },
      scrollLeft: { value: 100, writable: true },
    });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect({ left: 0, right: 300, width: 300 }));
    vi.spyOn(item, "getBoundingClientRect").mockReturnValue(rect({ left: 420, right: 520, width: 100 }));

    revealSelectedItem(container, item, "horizontal", false);
    frames.shift()?.(0);
    frames.shift()?.(280);

    expect(container.scrollLeft).toBe(420);
    vi.unstubAllGlobals();
  });
});
