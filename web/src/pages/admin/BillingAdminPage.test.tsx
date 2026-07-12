import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getBillingAdmin,
  retryReconciliation,
  updateMultiplier,
} from "../../billing/api";
import type { BillingAdminSnapshot } from "../../billing/types";
import { BillingAdminPage, multiplierTextToBps } from "./BillingAdminPage";

vi.mock("../../billing/api", () => ({
  createTopupProduct: vi.fn(),
  deleteTopupProduct: vi.fn(),
  getBillingAdmin: vi.fn(),
  retryReconciliation: vi.fn(),
  updateMultiplier: vi.fn(),
  updateTopupProduct: vi.fn(),
}));

const getBillingAdminMock = vi.mocked(getBillingAdmin);
const retryReconciliationMock = vi.mocked(retryReconciliation);
const updateMultiplierMock = vi.mocked(updateMultiplier);

const snapshot: BillingAdminSnapshot = {
  settings: {
    multiplier_bps: 15_000,
    version: 1,
    created_at: "2026-07-12T08:00:00Z",
    updated_at: "2026-07-12T08:00:00Z",
  },
  products: [{
    id: "prod10",
    title: "10\u5143\u989d\u5ea6",
    price_cny_fen: 1000,
    credit_units: 10_000_000,
    enabled: true,
    sort_order: 10,
    created_at: "2026-07-12T08:00:00Z",
    updated_at: "2026-07-12T08:00:00Z",
  }],
  orders: [{
    id: "order-1",
    user_id: "user-1",
    product_id: "prod10",
    product_title: "10\u5143\u989d\u5ea6",
    price_cny_fen: 1000,
    credit_units: 10_000_000,
    merchant_order_no_masked: "****1001",
    status: "paid",
    expires_at: "2026-07-12T08:30:00Z",
    paid_at: "2026-07-12T08:10:00Z",
    created_at: "2026-07-12T08:00:00Z",
    updated_at: "2026-07-12T08:10:00Z",
  }],
  wallet_entries: [],
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
  getBillingAdminMock.mockReset();
  retryReconciliationMock.mockReset();
  updateMultiplierMock.mockReset();
  getBillingAdminMock.mockResolvedValue(snapshot);
  updateMultiplierMock.mockResolvedValue({ ...snapshot.settings, multiplier_bps: 18_000 });
  retryReconciliationMock.mockResolvedValue({
    id: "recon-1",
    status: "open",
    next_retry_at: "2026-07-12T08:30:00Z",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("multiplierTextToBps", () => {
  it("converts bounded decimal text without floating point multiplication", () => {
    expect(multiplierTextToBps("1.500")).toBe(15_000);
    expect(multiplierTextToBps("10.0000")).toBe(100_000);
    expect(multiplierTextToBps("0.9999")).toBeNull();
    expect(multiplierTextToBps("10.0001")).toBeNull();
    expect(multiplierTextToBps("1.23456")).toBeNull();
  });
});

describe("BillingAdminPage", () => {
  it("saves a decimal multiplier as basis points with a reason", async () => {
    render(<BillingAdminPage />);

    await screen.findByLabelText("\u8ba1\u8d39\u500d\u7387");
    fireEvent.change(screen.getByLabelText("\u8ba1\u8d39\u500d\u7387"), {
      target: { value: "1.800" },
    });
    fireEvent.change(screen.getByLabelText("\u8c03\u6574\u539f\u56e0"), {
      target: { value: "\u6210\u672c\u590d\u6838" },
    });
    fireEvent.click(screen.getByRole("button", { name: "\u4fdd\u5b58\u500d\u7387" }));

    await waitFor(() => expect(updateMultiplierMock).toHaveBeenCalledWith({
      multiplier_bps: 18_000,
      reason: "\u6210\u672c\u590d\u6838",
    }));
  });

  it("requires a reason and rejects values outside 1.000 through 10.000", async () => {
    render(<BillingAdminPage />);

    await screen.findByLabelText("\u8ba1\u8d39\u500d\u7387");
    fireEvent.change(screen.getByLabelText("\u8ba1\u8d39\u500d\u7387"), {
      target: { value: "0.999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "\u4fdd\u5b58\u500d\u7387" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("\u8bf7\u8f93\u5165 1.000 \u5230 10.000 \u4e4b\u95f4\u7684\u500d\u7387");
    expect(updateMultiplierMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("\u8ba1\u8d39\u500d\u7387"), {
      target: { value: "1.800" },
    });
    fireEvent.click(screen.getByRole("button", { name: "\u4fdd\u5b58\u500d\u7387" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("\u8bf7\u586b\u5199\u8c03\u6574\u539f\u56e0");
    expect(updateMultiplierMock).not.toHaveBeenCalled();
  });

  it("retries only through the reconciliation retry API", async () => {
    render(<BillingAdminPage />);

    fireEvent.click(await screen.findByRole("button", {
      name: "\u91cd\u8bd5\u5bf9\u8d26 recon-1",
    }));

    await waitFor(() => expect(retryReconciliationMock).toHaveBeenCalledWith("recon-1"));
    expect(updateMultiplierMock).not.toHaveBeenCalled();
  });
});
