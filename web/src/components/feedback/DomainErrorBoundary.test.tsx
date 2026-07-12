import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandErrorNotice,
  DomainErrorBoundary,
  commandErrorFrom,
} from "./DomainErrorBoundary";

function BrokenContent({ broken }: { broken: boolean }) {
  if (broken) throw new Error("malformed project cache");
  return <p>Recovered project content</p>;
}

function suppressReactErrorLogs() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DomainErrorBoundary", () => {
  it("contains render exceptions without blanking account or billing chrome", () => {
    const consoleError = suppressReactErrorLogs();

    function Harness() {
      const [broken, setBroken] = useState(true);
      return (
        <MemoryRouter>
          <nav aria-label="Account">user@example.com</nav>
          <DomainErrorBoundary resetKeys={[broken]} onRetry={() => setBroken(false)}>
            <BrokenContent broken={broken} />
          </DomainErrorBoundary>
          <a href="/wallet">{"\u94b1\u5305 800"}</a>
        </MemoryRouter>
      );
    }

    render(<Harness />);

    expect(screen.getByRole("navigation", { name: "Account" })).toHaveTextContent("user@example.com");
    expect(screen.getByRole("link", { name: "\u94b1\u5305 800" })).toHaveAttribute("href", "/wallet");
    expect(screen.getByRole("alert")).toHaveTextContent("\u5f53\u524d\u533a\u57df\u9047\u5230\u9519\u8bef");

    fireEvent.click(screen.getByRole("button", { name: "\u91cd\u8bd5" }));

    expect(screen.getByText("Recovered project content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalled();
  });

  it("resets when malformed cached data is replaced", () => {
    suppressReactErrorLogs();
    const { rerender } = render(
      <DomainErrorBoundary resetKeys={["p1", 1]}>
        <BrokenContent broken />
      </DomainErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("\u6b64\u533a\u57df\u6682\u65f6\u65e0\u6cd5\u663e\u793a");

    rerender(
      <DomainErrorBoundary resetKeys={["p1", 2]}>
        <BrokenContent broken={false} />
      </DomainErrorBoundary>,
    );

    expect(screen.getByText("Recovered project content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("formats payment-required command errors without exposing provider details", () => {
    const error = commandErrorFrom(
      { status: 402, code: "payment_required_quote", required_units: 1200 },
      { fallback: "fallback", walletAvailableUnits: 800 },
    );

    render(
      <MemoryRouter>
        <CommandErrorNotice error={error} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("\u4f59\u989d\u4e0d\u8db3");
    expect(screen.getByRole("alert")).toHaveTextContent("\u53ef\u7528\u4f59\u989d 800");
    expect(screen.getByRole("alert")).toHaveTextContent("\u672c\u6b21\u6700\u591a\u9700\u8981 1,200");
    expect(screen.queryByText(/provider/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "\u524d\u5f80\u94b1\u5305" })).toHaveAttribute("href", "/wallet");
  });

  it("hands 401 command errors to session recovery instead of rendering an alert", () => {
    const onSessionExpired = vi.fn();

    const error = commandErrorFrom(
      { status: 401, code: "unauthorized" },
      { fallback: "fallback", onSessionExpired },
    );

    expect(error).toBeNull();
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });
});
