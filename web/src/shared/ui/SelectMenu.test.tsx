import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelectMenu } from "./SelectMenu";

function rect({
  bottom,
  height,
  left,
  right,
  top,
  width,
}: Pick<DOMRect, "bottom" | "height" | "left" | "right" | "top" | "width">): DOMRect {
  return {
    bottom,
    height,
    left,
    right,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SelectMenu", () => {
  it("selects an option through the accessible menu", () => {
    const onValueChange = vi.fn();
    render(
      <SelectMenu
        label="Model"
        value="model-a"
        onValueChange={onValueChange}
        options={[
          { value: "model-a", label: "Model A" },
          { value: "model-b", label: "Model B" },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Model B" }));

    expect(onValueChange).toHaveBeenCalledWith("model-b");
  });

  it("opens inward when a trigger is close to the viewport top-left edge", async () => {
    render(
      <SelectMenu
        label="Model"
        value="model-a"
        onValueChange={vi.fn()}
        options={[
          { value: "model-a", label: "Model A" },
          { value: "model-b", label: "A much longer model identifier" },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Model" });
    const menuRoot = trigger.parentElement!;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === menuRoot) {
        return rect({ top: 72, bottom: 110, left: 8, right: 228, width: 220, height: 38 });
      }
      if (this.getAttribute("role") === "menu") {
        return rect({ top: 118, bottom: 298, left: -92, right: 228, width: 320, height: 180 });
      }
      return rect({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
    });
    vi.stubGlobal("innerWidth", 800);
    vi.stubGlobal("innerHeight", 600);

    fireEvent.click(trigger);

    await waitFor(() => {
      expect(menuRoot).toHaveAttribute("data-placement", "bottom");
      expect(menuRoot).toHaveAttribute("data-align", "left");
    });
  });
});
