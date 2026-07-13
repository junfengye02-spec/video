import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPaymentOrder,
  getPaymentOrder,
  listWalletEntries,
} from "../billing/api";
import { useBilling } from "../billing/BillingProvider";
import type {
  PaymentGatewayAction,
  PaymentOrderView,
  WalletSummary,
} from "../billing/types";
import { WalletPage } from "./WalletPage";

vi.mock("../billing/api", () => ({
  createPaymentOrder: vi.fn(),
  getPaymentOrder: vi.fn(),
  listWalletEntries: vi.fn(),
}));

vi.mock("../billing/BillingProvider", () => ({
  useBilling: vi.fn(),
}));

const createPaymentOrderMock = vi.mocked(createPaymentOrder);
const getPaymentOrderMock = vi.mocked(getPaymentOrder);
const listWalletEntriesMock = vi.mocked(listWalletEntries);
const useBillingMock = vi.mocked(useBilling);

const wallet: WalletSummary = {
  balance_units: 1000,
  held_units: 200,
  available_units: 800,
};

const orderFixture: PaymentOrderView = {
  id: "order-1",
  merchant_order_masked: "****1001",
  product_title: "\u4f59\u989d\u5145\u503c",
  amount_cny_fen: 1234,
  credit_units: 12_340_000,
  status: "pending",
  created_at: "2026-07-12T08:00:00Z",
};

function actionFixture(): PaymentGatewayAction {
  return {
    order: orderFixture,
    action_url: "https://pay.example/submit.php",
    form_fields: { pid: "1", sign: "signed" },
  };
}

function renderWallet(
  path = "/wallet",
  submitGatewayForm = vi.fn(),
) {
  useBillingMock.mockReturnValue({
    wallet,
    loading: false,
    error: null,
    refreshWallet: vi.fn(),
  });
  listWalletEntriesMock.mockResolvedValue([]);
  return {
    submitGatewayForm,
    ...render(
      <MemoryRouter
        future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
        initialEntries={[path]}
      >
        <WalletPage submitGatewayForm={submitGatewayForm} />
      </MemoryRouter>,
    ),
  };
}

beforeEach(() => {
  createPaymentOrderMock.mockReset();
  getPaymentOrderMock.mockReset();
  listWalletEntriesMock.mockReset();
  useBillingMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("WalletPage", () => {
  it("creates an order and submits only the returned signed form", async () => {
    createPaymentOrderMock.mockResolvedValue(actionFixture());
    const { submitGatewayForm } = renderWallet();

    fireEvent.change(await screen.findByRole("spinbutton", {
      name: "\u5145\u503c\u91d1\u989d\uff08\u5143\uff09",
    }), { target: { value: "12.34" } });
    fireEvent.click(screen.getByRole("button", {
      name: "\u652f\u4ed8\u5b9d\u5145\u503c",
    }));

    expect(createPaymentOrderMock).toHaveBeenCalledWith(1234);
    await waitFor(() => expect(submitGatewayForm).toHaveBeenCalledWith(
      "https://pay.example/submit.php",
      { pid: "1", sign: "signed" },
    ));
  });

  it("renders holds separately and never credits from return query", async () => {
    getPaymentOrderMock.mockResolvedValue({
      ...orderFixture,
      id: "o1",
      status: "paid",
    });

    renderWallet("/wallet?payment=success&order_id=o1");

    expect(await screen.findByText("\u9884\u8ba1\u6700\u591a\u6d88\u8017")).toBeVisible();
    expect(getPaymentOrderMock).toHaveBeenCalledWith("o1");
    expect(screen.getByText("\u4f59\u989d\u4ee5\u670d\u52a1\u5668\u8ba2\u5355\u72b6\u6001\u4e3a\u51c6")).toBeVisible();
    expect(screen.getByText("800")).toBeVisible();
  });

  it("rejects non-HTTPS gateway actions before building a form", () => {
    expect(() => {
      WalletPage.submitGatewayFormForTest("http://pay.example/submit.php", { sign: "signed" });
    }).toThrow("Payment gateway must use HTTPS");
  });
});
