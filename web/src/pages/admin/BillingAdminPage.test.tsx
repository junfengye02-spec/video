import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adjustUserBalance,
  getBillingAdmin,
  listAdminOrders,
  listAdminUsers,
  retryReconciliation,
  updateMultiplier,
} from "../../billing/api";
import { notifyBillingChanged } from "../../billing/BillingProvider";
import type { BillingAdminSnapshot } from "../../billing/types";
import { chooseSelectMenuOption } from "../../test/selectMenu";
import { balanceAdjustmentTextToUnits, BillingAdminPage, multiplierTextToBps } from "./BillingAdminPage";

vi.mock("../../billing/api", () => ({
  adjustUserBalance: vi.fn(),
  getBillingAdmin: vi.fn(),
  listAdminOrders: vi.fn(),
  listAdminUsers: vi.fn(),
  retryReconciliation: vi.fn(),
  updateMultiplier: vi.fn(),
}));
vi.mock("../../billing/BillingProvider", () => ({ notifyBillingChanged: vi.fn() }));

const adjustUserBalanceMock = vi.mocked(adjustUserBalance);
const getBillingAdminMock = vi.mocked(getBillingAdmin);
const listAdminOrdersMock = vi.mocked(listAdminOrders);
const listAdminUsersMock = vi.mocked(listAdminUsers);
const retryReconciliationMock = vi.mocked(retryReconciliation);
const updateMultiplierMock = vi.mocked(updateMultiplier);
const notifyBillingChangedMock = vi.mocked(notifyBillingChanged);

const snapshot: BillingAdminSnapshot = {
  summary: {
    gross_paid_cny_fen: 1200,
    total_orders: 2,
    pending_orders: 1,
    paid_orders: 1,
    failed_orders: 0,
    expired_orders: 0,
    wallet_balance_units: 10_000_000,
    wallet_held_units: 1_000,
    wallet_available_units: 9_999_000,
  },
  settings: { multiplier_bps: 15_000, version: 1, created_at: "2026-07-12T08:00:00Z", updated_at: "2026-07-12T08:00:00Z" },
  users: [{
    id: "user-1", email: "user@example.com", role: "user", status: "active", wallet_id: "wallet-1",
    balance_units: 10_000_000, held_units: 1_000, available_units: 9_999_000, created_at: "2026-07-12T08:00:00Z",
  }],
  orders: [{
    id: "order-1", user_id: "user-1", product_id: "prod10", product_title: "10元额度", price_cny_fen: 1000,
    credit_units: 10_000_000, merchant_order_no_masked: "****1001", status: "paid", expires_at: "2026-07-12T08:30:00Z",
    paid_at: "2026-07-12T08:10:00Z", created_at: "2026-07-12T08:00:00Z", updated_at: "2026-07-12T08:10:00Z",
  }],
  wallet_entries: [],
  reconciliations: [{
    id: "recon-1", job_id: "job-1", kind: "provider_completion", status: "open", attempts: 1,
    last_error_code: "RuntimeError", next_retry_at: "2026-07-12T09:00:00Z", created_at: "2026-07-12T08:00:00Z", updated_at: "2026-07-12T08:10:00Z",
  }],
};

beforeEach(() => {
  adjustUserBalanceMock.mockReset();
  getBillingAdminMock.mockReset();
  listAdminOrdersMock.mockReset();
  listAdminUsersMock.mockReset();
  retryReconciliationMock.mockReset();
  updateMultiplierMock.mockReset();
  notifyBillingChangedMock.mockReset();
  getBillingAdminMock.mockResolvedValue(snapshot);
  listAdminUsersMock.mockResolvedValue(snapshot.users);
  listAdminOrdersMock.mockResolvedValue(snapshot.orders);
  adjustUserBalanceMock.mockResolvedValue({
    ...snapshot.users[0], balance_units: 9_999_800, available_units: 9_998_800,
    entry_id: "entry-adjustment-1", adjustment_amount_units: -200,
  });
  updateMultiplierMock.mockResolvedValue({ ...snapshot.settings, multiplier_bps: 18_000 });
  retryReconciliationMock.mockResolvedValue({ id: "recon-1", status: "open", next_retry_at: "2026-07-12T08:30:00Z" });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("billing parsers", () => {
  it("parses bounded multiplier and signed balance adjustment values", () => {
    expect(multiplierTextToBps("1.500")).toBe(15_000);
    expect(multiplierTextToBps("10.0000")).toBe(100_000);
    expect(multiplierTextToBps("0.9999")).toBeNull();
    expect(balanceAdjustmentTextToUnits("250", "credit")).toBe(250_000_000);
    expect(balanceAdjustmentTextToUnits("2.50", "debit")).toBe(-2_500_000);
    expect(balanceAdjustmentTextToUnits("0", "credit")).toBeNull();
  });
});

describe("BillingAdminPage", () => {
  it("bounds long order snapshots with keyboard-accessible pagination", async () => {
    const orders = Array.from({ length: 45 }, (_, index) => ({
      ...snapshot.orders[0],
      id: `order-${index + 1}`,
      product_title: `长订单套餐 ${index + 1}`,
      merchant_order_no_masked: `****${String(index + 1).padStart(4, "0")}`,
    }));
    getBillingAdminMock.mockResolvedValue({ ...snapshot, orders });

    render(<BillingAdminPage />);

    expect(await screen.findByText("长订单套餐 1")).toBeVisible();
    expect(screen.getByText("长订单套餐 20")).toBeVisible();
    expect(screen.queryByText("长订单套餐 21")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "订单分页状态" })).toHaveTextContent("第 1 / 3 页，共 45 笔");

    fireEvent.click(screen.getByRole("button", { name: "下一页订单" }));

    expect(screen.getByText("长订单套餐 21")).toBeVisible();
    expect(screen.queryByText("长订单套餐 1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一页订单" })).toBeEnabled();
  });

  it("renders authoritative revenue, order, available, and held metrics", async () => {
    render(<BillingAdminPage />);
    expect(await screen.findByText("¥12.00")).toBeVisible();
    const metrics = screen.getByText("用户可用余额", { selector: "dt" }).parentElement;
    expect(metrics).not.toBeNull();
    expect(within(metrics as HTMLElement).getByText("¥10.00")).toBeVisible();
    const heldMetric = screen.getByText("预扣金额", { selector: "dt" }).parentElement;
    expect(heldMetric).not.toBeNull();
    expect(within(heldMetric as HTMLElement).getByText("¥0.00")).toBeVisible();
    expect(screen.queryByText("充值商品")).not.toBeInTheDocument();
  });

  it("requires a confirmation reason before updating the multiplier", async () => {
    render(<BillingAdminPage />);
    fireEvent.change(await screen.findByRole("textbox", { name: "计费倍率" }), { target: { value: "1.800" } });
    const trigger = screen.getByRole("button", { name: "保存倍率" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "确认修改计费倍率" });
    expect(within(dialog).getByRole("button", { name: "确认修改倍率" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("操作原因"), { target: { value: "成本复核" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认修改倍率" }));

    await waitFor(() => expect(updateMultiplierMock).toHaveBeenCalledWith({ multiplier_bps: 18_000, reason: "成本复核" }));
    expect(await screen.findByRole("status")).toHaveTextContent("计费倍率已由服务端更新");
  });

  it("deduplicates a balance adjustment and refreshes shared wallet facts", async () => {
    render(<BillingAdminPage />);
    fireEvent.click(await screen.findByRole("button", { name: "调整 user@example.com 的余额" }));
    const form = screen.getByRole("form", { name: "调整 user@example.com" });
    fireEvent.click(within(form).getByRole("button", { name: "扣减" }));
    fireEvent.change(within(form).getByLabelText("金额（元）"), { target: { value: "2.00" } });
    fireEvent.click(within(form).getByRole("button", { name: "继续确认" }));
    const dialog = screen.getByRole("dialog", { name: "确认扣减用户余额" });
    fireEvent.change(within(dialog).getByLabelText("操作原因"), { target: { value: "客服纠错" } });
    const confirm = within(dialog).getByRole("button", { name: "确认扣减余额" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(adjustUserBalanceMock).toHaveBeenCalledTimes(1));
    expect(adjustUserBalanceMock).toHaveBeenCalledWith("user-1", {
      amount_units: -2_000_000,
      reason: "客服纠错",
      request_id: expect.any(String),
    });
    expect(notifyBillingChangedMock).toHaveBeenCalledTimes(1);
  });

  it("requires a reason before scheduling reconciliation and reports failure without fake success", async () => {
    retryReconciliationMock.mockRejectedValue(new Error("service unavailable"));
    render(<BillingAdminPage />);
    fireEvent.click(await screen.findByRole("button", { name: "重试对账 recon-1" }));
    const dialog = screen.getByRole("dialog", { name: "确认重试对账任务" });
    fireEvent.change(within(dialog).getByLabelText("操作原因"), { target: { value: "人工复核" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "确认重新调度" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("service unavailable");
    expect(retryReconciliationMock).toHaveBeenCalledWith("recon-1", "人工复核");
    expect(screen.queryByText(/已重新调度/)).not.toBeInTheDocument();
  });

  it("searches users and filters orders through administrator APIs", async () => {
    render(<BillingAdminPage />);
    fireEvent.change(await screen.findByLabelText("搜索用户"), { target: { value: "user@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => expect(listAdminUsersMock).toHaveBeenCalledWith("user@example.com"));

    fireEvent.change(screen.getByLabelText("搜索套餐"), { target: { value: "10元" } });
    chooseSelectMenuOption("状态", "已支付");
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    await waitFor(() => expect(listAdminOrdersMock).toHaveBeenCalledWith({ limit: 20, search: "10元", status: "paid" }));
  });

  it("closes confirmation with Escape and returns focus to its trigger", async () => {
    render(<BillingAdminPage />);
    const trigger = await screen.findByRole("button", { name: "保存倍率" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
