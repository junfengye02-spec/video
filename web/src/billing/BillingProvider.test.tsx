import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../auth/AuthProvider";
import type { AuthContextValue } from "../auth/AuthProvider";
import { getWallet } from "./api";
import { BillingProvider, notifyBillingChanged, useBilling } from "./BillingProvider";
import type { WalletSummary } from "./types";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: vi.fn(),
}));

vi.mock("./api", () => ({
  getWallet: vi.fn(),
}));

const useAuthMock = vi.mocked(useAuth);
const getWalletMock = vi.mocked(getWallet);

const user = { id: "user-1", email: "user@example.com", role: "user" as const };
const wallet: WalletSummary = {
  balance_units: 1000,
  held_units: 200,
  available_units: 800,
};

function authValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user,
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    sendVerification: vi.fn(),
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function BillingProbe() {
  const billing = useBilling();
  return (
    <div>
      <output data-testid="balance">{billing.wallet?.balance_units ?? "none"}</output>
      <output data-testid="loading">{String(billing.loading)}</output>
      <output data-testid="error">{billing.error ?? ""}</output>
      <button type="button" onClick={() => void billing.refreshWallet()}>refresh</button>
    </div>
  );
}

beforeEach(() => {
  useAuthMock.mockReset();
  getWalletMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BillingProvider", () => {
  it("loads the wallet only for an authenticated user", async () => {
    useAuthMock.mockReturnValue(authValue());
    getWalletMock.mockResolvedValue(wallet);

    render(<BillingProvider><BillingProbe /></BillingProvider>);

    expect(await screen.findByTestId("balance")).toHaveTextContent("1000");
    expect(getWalletMock).toHaveBeenCalledTimes(1);
  });

  it("does not load a wallet for anonymous visitors", () => {
    useAuthMock.mockReturnValue(authValue({ user: null }));

    render(<BillingProvider><BillingProbe /></BillingProvider>);

    expect(screen.getByTestId("balance")).toHaveTextContent("none");
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
    expect(getWalletMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent refresh calls", async () => {
    const pending = deferred<WalletSummary>();
    useAuthMock.mockReturnValue(authValue());
    getWalletMock.mockReturnValue(pending.promise);

    render(<BillingProvider><BillingProbe /></BillingProvider>);

    await waitFor(() => expect(getWalletMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "refresh" }));

    expect(getWalletMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(wallet);
      await pending.promise;
    });

    expect(screen.getByTestId("balance")).toHaveTextContent("1000");
  });

  it("clears wallet state on logout", async () => {
    useAuthMock.mockReturnValue(authValue());
    getWalletMock.mockResolvedValue(wallet);
    const rendered = render(<BillingProvider><BillingProbe /></BillingProvider>);
    expect(await screen.findByTestId("balance")).toHaveTextContent("1000");

    useAuthMock.mockReturnValue(authValue({ user: null }));
    rendered.rerender(<BillingProvider><BillingProbe /></BillingProvider>);

    expect(screen.getByTestId("balance")).toHaveTextContent("none");
    expect(screen.getByTestId("loading")).toHaveTextContent("false");
  });

  it("refreshes authoritative wallet facts after a billing invalidation", async () => {
    useAuthMock.mockReturnValue(authValue());
    getWalletMock
      .mockResolvedValueOnce(wallet)
      .mockResolvedValueOnce({ ...wallet, balance_units: 1400, available_units: 1200 });

    render(<BillingProvider><BillingProbe /></BillingProvider>);
    expect(await screen.findByTestId("balance")).toHaveTextContent("1000");

    act(() => notifyBillingChanged());

    expect(await screen.findByTestId("balance")).toHaveTextContent("1400");
    expect(getWalletMock).toHaveBeenCalledTimes(2);
  });
});
