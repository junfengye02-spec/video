import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listPaymentOrders } from "../billing/api";
import type { PaymentOrderView } from "../billing/types";
import { OrdersPage } from "./OrdersPage";

vi.mock("../billing/api", () => ({
  listPaymentOrders: vi.fn(),
}));

const listPaymentOrdersMock = vi.mocked(listPaymentOrders);

const orders: PaymentOrderView[] = [{
  id: "order-1",
  merchant_order_masked: "****1001",
  product_title: "10\u5143\u989d\u5ea6",
  amount_cny_fen: 1000,
  credit_units: 10_000_000,
  status: "paid",
  created_at: "2026-07-12T08:00:00Z",
}];

beforeEach(() => {
  listPaymentOrdersMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OrdersPage", () => {
  it("renders order status, product snapshot, amount, masked order, and timestamp", async () => {
    listPaymentOrdersMock.mockResolvedValue(orders);

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <OrdersPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "\u5145\u503c\u8ba2\u5355" })).toBeInTheDocument();
    expect(screen.getByText("10\u5143\u989d\u5ea6")).toBeVisible();
    expect(screen.getByText("\u5df2\u652f\u4ed8")).toBeVisible();
    expect(screen.getByText("\u00a510.00")).toBeVisible();
    expect(screen.getByText("****1001")).toBeVisible();
    expect(screen.getByText(/2026/)).toBeVisible();
  });
});
