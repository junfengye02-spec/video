import { beforeEach, describe, expect, it, vi } from "vitest";
import { authRequest } from "../api/client";
import {
  createPaymentOrder,
  getBillingAdmin,
  updateMultiplier,
} from "./api";
import type {
  BillingAdminSnapshot,
  PaymentOrderView,
} from "./types";

vi.mock("../api/client", () => ({
  authRequest: vi.fn(),
}));

const authRequestMock = vi.mocked(authRequest);

const orderFixture: PaymentOrderView = {
  id: "order-1",
  merchant_order_masked: "****1001",
  product_title: "10 yuan credits",
  amount_cny_fen: 1000,
  credit_units: 10_000_000,
  status: "pending",
  created_at: "2026-07-12T08:00:00Z",
};

const adminFixture: BillingAdminSnapshot = {
  settings: {
    multiplier_bps: 15_000,
    version: 1,
    created_at: "2026-07-12T08:00:00Z",
    updated_at: "2026-07-12T08:00:00Z",
  },
  orders: [{
    id: "order-1",
    user_id: "user-1",
    product_id: "prod10",
    product_title: "10 yuan credits",
    price_cny_fen: 1000,
    credit_units: 10_000_000,
    merchant_order_no_masked: "****1001",
    status: "paid",
    expires_at: "2026-07-12T08:30:00Z",
    paid_at: "2026-07-12T08:10:00Z",
    created_at: "2026-07-12T08:00:00Z",
    updated_at: "2026-07-12T08:10:00Z",
  }],
  wallet_entries: [{
    id: "entry-1",
    wallet_id: "wallet-1",
    user_id: "user-1",
    amount_units: 10_000_000,
    balance_after_units: 10_000_000,
    kind: "topup",
    source_type: "payment_order",
    source_id: "order-1",
    created_at: "2026-07-12T08:10:00Z",
  }],
  reconciliations: [{
    id: "recon-1",
    job_id: "job-1",
    kind: "provider_completion",
    status: "open",
    attempts: 1,
    last_error_code: "RuntimeError",
    next_retry_at: "2026-07-12T09:00:00Z",
    created_at: "2026-07-12T08:00:00Z",
    updated_at: "2026-07-12T08:10:00Z",
  }],
};

beforeEach(() => {
  authRequestMock.mockReset();
});

describe("billing API transport", () => {
  it("creates an order from an amount with authenticated CSRF transport", async () => {
    authRequestMock.mockResolvedValue({
      order: orderFixture,
      action_url: "https://pay.example/submit.php",
      form_fields: { pid: "1", sign: "signed" },
    });

    await expect(createPaymentOrder(1234)).resolves.toEqual({
      order: orderFixture,
      action_url: "https://pay.example/submit.php",
      form_fields: { pid: "1", sign: "signed" },
    });

    expect(authRequestMock).toHaveBeenCalledWith("/api/payment-orders", {
      method: "POST",
      body: JSON.stringify({ amount_cny_fen: 1234 }),
    });
  });

  it("does not accept internal billing fields in browser DTO fixtures", () => {
    expect(JSON.stringify(adminFixture)).not.toMatch(
      /quote_id|billing_fingerprint|provider_reference|result_locator|token_key/i,
    );
  });

  it("loads the administrator billing dashboard from redacted admin endpoints", async () => {
    authRequestMock
      .mockResolvedValueOnce(adminFixture.settings)
      .mockResolvedValueOnce(adminFixture.orders)
      .mockResolvedValueOnce(adminFixture.wallet_entries)
      .mockResolvedValueOnce(adminFixture.reconciliations);

    await expect(getBillingAdmin()).resolves.toEqual(adminFixture);

    expect(authRequestMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/admin/billing/settings",
      "/api/admin/payment-orders?limit=50",
      "/api/admin/wallet-entries?limit=50",
      "/api/admin/billing-reconciliations?limit=50",
    ]);
  });

  it("updates the multiplier with a required audit reason", async () => {
    authRequestMock.mockResolvedValue({
      ...adminFixture.settings,
      multiplier_bps: 18_000,
      version: 2,
    });

    await updateMultiplier({ multiplier_bps: 18_000, reason: "cost review" });

    expect(authRequestMock).toHaveBeenCalledWith("/api/admin/billing/settings", {
      method: "PUT",
      body: JSON.stringify({ multiplier_bps: 18_000, reason: "cost review" }),
    });
  });
});
