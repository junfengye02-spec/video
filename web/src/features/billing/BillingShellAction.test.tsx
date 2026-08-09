import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingShellAction } from "./BillingShellAction";

const billingMocks = vi.hoisted(() => ({
  value: {
    wallet: { balance_units: 1_500_000_000, held_units: 0, available_units: 1_234_000_000 },
    loading: false,
    error: null,
    refreshWallet: vi.fn(),
  },
}));

vi.mock("../../billing/BillingProvider", () => ({
  useBilling: () => billingMocks.value,
}));

beforeEach(() => {
  vi.clearAllMocks();
  billingMocks.value = {
    wallet: { balance_units: 1_500_000_000, held_units: 0, available_units: 1_234_000_000 },
    loading: false,
    error: null,
    refreshWallet: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
});

describe("BillingShellAction", () => {
  it("links to the wallet with the available balance", () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <BillingShellAction />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "钱包 ¥1,234.00" })).toHaveAttribute("href", "/wallet");
    expect(screen.queryByRole("link", { name: "订单" })).not.toBeInTheDocument();
  });

  it("uses the guard for billing navigation and hides the balance while loading", () => {
    const onBeforeNavigate = vi.fn(() => false);
    billingMocks.value = {
      ...billingMocks.value,
      loading: true,
    };

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <BillingShellAction onBeforeNavigate={onBeforeNavigate} />
      </MemoryRouter>,
    );

    const walletLink = screen.getByRole("link", { name: "钱包" });
    fireEvent.click(walletLink);

    expect(onBeforeNavigate).toHaveBeenCalledTimes(1);
  });
});
