import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModalFocus } from "./useModalFocus";

function FocusHarness({ withoutControls = false }: { withoutControls?: boolean }) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const { panelRef, onKeyDown } = useModalFocus<HTMLDivElement>({
    open,
    onEscape: () => setOpen(false),
    returnFocusRef: openerRef,
  });

  return (
    <div>
      <button ref={openerRef} type="button" onClick={() => setOpen(true)}>Open modal</button>
      {open ? (
        <div ref={panelRef} role="dialog" aria-label="Focus test" tabIndex={-1} onKeyDown={onKeyDown}>
          {withoutControls ? (
            <p>No controls</p>
          ) : (
            <>
              <button type="button">First action</button>
              <button type="button" disabled>Disabled action</button>
              <button type="button" hidden>Hidden action</button>
              <a href="/next">Last action</a>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

afterEach(() => {
  cleanup();
});

describe("useModalFocus", () => {
  it("focuses the first visible control, wraps Tab, closes on Escape and restores the opener", async () => {
    render(<FocusHarness />);

    const opener = screen.getByRole("button", { name: "Open modal" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Focus test" });
    const first = within(dialog).getByRole("button", { name: "First action" });
    const last = within(dialog).getByRole("link", { name: "Last action" });
    await waitFor(() => expect(first).toHaveFocus());

    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(first).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Focus test" })).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("focuses the panel when no enabled visible control exists", async () => {
    render(<FocusHarness withoutControls />);

    fireEvent.click(screen.getByRole("button", { name: "Open modal" }));

    const dialog = screen.getByRole("dialog", { name: "Focus test" });
    await waitFor(() => expect(dialog).toHaveFocus());
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog).toHaveFocus();
  });

  it("uses the latest Escape handler", async () => {
    const onEscape = vi.fn();

    function CustomHarness() {
      const openerRef = useRef<HTMLButtonElement | null>(null);
      const { panelRef, onKeyDown } = useModalFocus<HTMLDivElement>({
        open: true,
        onEscape,
        returnFocusRef: openerRef,
      });
      return (
        <>
          <button ref={openerRef} type="button">Opener</button>
          <div ref={panelRef} role="dialog" aria-label="Always open" tabIndex={-1} onKeyDown={onKeyDown}>
            <button type="button">Inside</button>
          </div>
        </>
      );
    }

    render(<CustomHarness />);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Always open" }), { key: "Escape" });

    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});
