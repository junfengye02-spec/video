import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPaymentOrder,
  getPaymentOrder,
  listPaymentOrders,
  listTopupProducts,
  listWalletEntries,
} from "../billing/api";
import { notifyBillingChanged, useBilling } from "../billing/BillingProvider";
import type { PaymentGatewayAction, PaymentOrderView, WalletSummary } from "../billing/types";
import { WalletPage } from "./WalletPage";

vi.mock("../billing/api", () => ({
  createPaymentOrder: vi.fn(),
  getPaymentOrder: vi.fn(),
  listPaymentOrders: vi.fn(),
  listTopupProducts: vi.fn(),
  listWalletEntries: vi.fn(),
}));

vi.mock("../billing/BillingProvider", () => ({
  notifyBillingChanged: vi.fn(),
  useBilling: vi.fn(),
}));

const createPaymentOrderMock = vi.mocked(createPaymentOrder);
const getPaymentOrderMock = vi.mocked(getPaymentOrder);
const listPaymentOrdersMock = vi.mocked(listPaymentOrders);
const listTopupProductsMock = vi.mocked(listTopupProducts);
const listWalletEntriesMock = vi.mocked(listWalletEntries);
const notifyBillingChangedMock = vi.mocked(notifyBillingChanged);
const useBillingMock = vi.mocked(useBilling);

const wallet: WalletSummary = {
  balance_units: 10_000_000,
  held_units: 2_000_000,
  available_units: 8_000_000,
};
const orderFixture: PaymentOrderView = {
  id: "order-1",
  merchant_order_masked: "****1001",
  product_title: "余额充值",
  amount_cny_fen: 1234,
  credit_units: 12_340_000,
  status: "pending",
  expires_at: "2026-07-12T08:30:00Z",
  paid_at: null,
  created_at: "2026-07-12T08:00:00Z",
  updated_at: "2026-07-12T08:00:00Z",
};

function actionFixture(): PaymentGatewayAction {
  return {
    order: orderFixture,
    action_url: "https://pay.example/submit.php",
    form_fields: { pid: "1", sign: "signed" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function renderWallet(path = "/wallet", submitGatewayForm = vi.fn()) {
  const refreshWallet = vi.fn(async () => wallet);
  useBillingMock.mockReturnValue({ wallet, loading: false, error: null, refreshWallet });
  return {
    refreshWallet,
    submitGatewayForm,
    ...render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }} initialEntries={[path]}>
        <WalletPage submitGatewayForm={submitGatewayForm} />
      </MemoryRouter>,
    ),
  };
}

beforeEach(() => {
  createPaymentOrderMock.mockReset();
  getPaymentOrderMock.mockReset();
  listPaymentOrdersMock.mockReset();
  listTopupProductsMock.mockReset();
  listWalletEntriesMock.mockReset();
  notifyBillingChangedMock.mockReset();
  useBillingMock.mockReset();
  listTopupProductsMock.mockResolvedValue([]);
  listWalletEntriesMock.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("WalletPage", () => {
  it("renders server-provided available, held, and total balances without deriving them", async () => {
    renderWallet();
    expect(screen.getByText("¥8.00")).toBeVisible();
    expect(screen.getByText("¥2.00")).toBeVisible();
    expect(screen.getByText("¥10.00")).toBeVisible();
    expect(screen.getByText("服务端钱包总额，不由前端推算")).toBeVisible();
    expect(listWalletEntriesMock).toHaveBeenCalledWith(9, 0);
  });

  it("creates a custom order once and submits only the returned signed gateway form", async () => {
    const pending = deferred<PaymentGatewayAction>();
    createPaymentOrderMock.mockReturnValue(pending.promise);
    const { submitGatewayForm } = renderWallet();

    fireEvent.change(screen.getByRole("spinbutton", { name: "充值金额（元）" }), { target: { value: "12.34" } });
    const submit = screen.getByRole("button", { name: "按金额充值" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(createPaymentOrderMock).toHaveBeenCalledTimes(1);
    expect(createPaymentOrderMock).toHaveBeenCalledWith({ amount_cny_fen: 1234 });
    await act(async () => { pending.resolve(actionFixture()); await pending.promise; });
    expect(submitGatewayForm).toHaveBeenCalledWith(
      "https://pay.example/submit.php",
      { pid: "1", sign: "signed" },
    );
  });

  it("loads real packages and creates the selected server package order", async () => {
    listTopupProductsMock.mockResolvedValue([
      { id: "starter", title: "入门套餐", price_cny_fen: 1000, credit_units: 10_000_000 },
      { id: "pro", title: "专业套餐", price_cny_fen: 5000, credit_units: 60_000_000 },
    ]);
    createPaymentOrderMock.mockResolvedValue(actionFixture());
    const { submitGatewayForm } = renderWallet();

    fireEvent.click(await screen.findByRole("radio", { name: /专业套餐/ }));
    fireEvent.click(screen.getByRole("button", { name: "支付 ¥50.00" }));

    await waitFor(() => expect(createPaymentOrderMock).toHaveBeenCalledWith({ product_id: "pro" }));
    expect(submitGatewayForm).toHaveBeenCalledTimes(1);
  });

  it("polls sequentially, refreshes wallet on authoritative paid status, and then stops", async () => {
    vi.useFakeTimers();
    getPaymentOrderMock
      .mockResolvedValueOnce(orderFixture)
      .mockResolvedValueOnce({ ...orderFixture, status: "paid", paid_at: "2026-07-12T08:05:00Z" });
    const { refreshWallet } = renderWallet("/wallet?payment=pending&order_id=order-1");

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("等待支付确认")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByText("充值已到账")).toBeVisible();
    expect(refreshWallet).toHaveBeenCalledTimes(1);
    expect(notifyBillingChangedMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(getPaymentOrderMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces the initial return check when StrictMode restarts the polling effect", async () => {
    getPaymentOrderMock.mockResolvedValue(orderFixture);
    const refreshWallet = vi.fn(async () => wallet);
    useBillingMock.mockReturnValue({ wallet, loading: false, error: null, refreshWallet });

    render(
      <StrictMode>
        <MemoryRouter
          future={{ v7_relativeSplatPath: true, v7_startTransition: true }}
          initialEntries={["/wallet?payment=pending&order_id=order-1"]}
        >
          <WalletPage submitGatewayForm={vi.fn()} />
        </MemoryRouter>
      </StrictMode>,
    );

    expect(await screen.findByText("等待支付确认")).toBeVisible();
    expect(getPaymentOrderMock).toHaveBeenCalledTimes(1);
  });

  it("shows a recoverable interruption after bounded polling failures", async () => {
    vi.useFakeTimers();
    getPaymentOrderMock.mockRejectedValue(new Error("offline"));
    renderWallet("/wallet?payment=pending&order_id=order-1");

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText("状态检查已暂停")).toBeVisible();
    expect(getPaymentOrderMock).toHaveBeenCalledTimes(3);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getPaymentOrderMock).toHaveBeenCalledTimes(4);
  });

  it("treats cancelled return as informational and never polls without an order id", () => {
    renderWallet("/wallet?payment=cancelled");
    expect(screen.getByText("支付已取消")).toBeVisible();
    expect(getPaymentOrderMock).not.toHaveBeenCalled();
  });

  it("recovers a missing return order id from the most recent order", async () => {
    const recentPaidOrder = {
      ...orderFixture,
      status: "paid" as const,
      created_at: new Date().toISOString(),
      paid_at: new Date().toISOString(),
    };
    listPaymentOrdersMock.mockResolvedValue([recentPaidOrder]);
    getPaymentOrderMock.mockResolvedValue(recentPaidOrder);

    renderWallet("/wallet?payment=failed");

    expect(await screen.findByText("充值已到账")).toBeVisible();
    expect(getPaymentOrderMock).toHaveBeenCalledWith(recentPaidOrder.id);
    expect(notifyBillingChangedMock).toHaveBeenCalledTimes(1);
  });

  it("rejects non-HTTPS gateway actions before building a form", () => {
    expect(() => WalletPage.submitGatewayFormForTest("http://pay.example/submit.php", { sign: "signed" }))
      .toThrow("Payment gateway must use HTTPS");
  });
});
