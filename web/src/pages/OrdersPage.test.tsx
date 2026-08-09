import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listPaymentOrders } from "../billing/api";
import type { PaymentOrderView } from "../billing/types";
import { chooseSelectMenuOption } from "../test/selectMenu";
import { OrdersPage } from "./OrdersPage";

vi.mock("../billing/api", () => ({ listPaymentOrders: vi.fn() }));
const listPaymentOrdersMock = vi.mocked(listPaymentOrders);

const orders: PaymentOrderView[] = [{
  id: "order-very-long-000000000000000000000000000001",
  merchant_order_masked: "****1001",
  product_title: "专业创作额度套餐-这是一个用于验证长名称不会撑破布局的名称",
  amount_cny_fen: 1000,
  credit_units: 10_000_000,
  status: "paid",
  expires_at: "2026-07-12T08:30:00Z",
  paid_at: "2026-07-12T08:10:00Z",
  created_at: "2026-07-12T08:00:00Z",
  updated_at: "2026-07-12T08:10:00Z",
}];

function renderOrders(path = "/orders") {
  return render(
    <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }} initialEntries={[path]}>
      <OrdersPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listPaymentOrdersMock.mockReset();
  listPaymentOrdersMock.mockResolvedValue(orders);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OrdersPage", () => {
  it("renders a desktop table and a structured mobile list from real order fields", async () => {
    renderOrders();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("已支付")).toBeVisible();
    expect(within(table).getByText("¥10.00")).toBeVisible();
    expect(within(table).getByText("****1001")).toBeVisible();
    const mobileList = screen.getByRole("list", { name: "订单列表" });
    expect(within(mobileList).getByText("到账金额")).toBeInTheDocument();
    expect(screen.getAllByText(/专业创作额度套餐/)).toHaveLength(2);
  });

  it("applies server-side search and status filters while preserving them in the URL", async () => {
    renderOrders();
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText("搜索订单"), { target: { value: "专业" } });
    chooseSelectMenuOption("状态", "已支付");
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    await waitFor(() => expect(listPaymentOrdersMock).toHaveBeenLastCalledWith({
      limit: 11,
      offset: 0,
      search: "专业",
      status: "paid",
    }));
  });

  it("uses bounded pagination and exposes recoverable loading errors", async () => {
    listPaymentOrdersMock.mockResolvedValueOnce([
      ...orders,
      ...Array.from({ length: 10 }, (_, index) => ({ ...orders[0], id: `order-${index}` })),
    ]).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([]);
    renderOrders();

    fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(listPaymentOrdersMock).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 10 }));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("暂无充值订单。")).toBeVisible());
  });
});
