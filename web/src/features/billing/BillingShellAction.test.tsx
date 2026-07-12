import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BillingShellAction } from "./BillingShellAction";

const billingMocks = vi.hoisted(() => ({
  value: {
    wallet: { balance_units: 1500, held_units: 0, available_units: 1234 },
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
    wallet: { balance_units: 1500, held_units: 0, available_units: 1234 },
    loading: false,
    error: null,
    refreshWallet: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
});

describe("BillingShellAction", () => {
  it("links to wallet and orders with the available balance", () => {
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <BillingShellAction />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "钱包 1,234" })).toHaveAttribute("href", "/wallet");
    expect(screen.getByRole("link", { name: "订单" })).toHaveAttribute("href", "/orders");
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
