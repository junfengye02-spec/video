import {
  ChevronLeft,
  ChevronRight,
  ReceiptText,
  RefreshCw,
  Search,
  WalletCards,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listPaymentOrders } from "../billing/api";
import { formatCnyUnits } from "../billing/money";
import type { PaymentOrderStatus, PaymentOrderView } from "../billing/types";
import { getStrings } from "../i18n";
import { SelectMenu } from "../shared/ui";

const ORDER_PAGE_SIZE = 10;
const ORDER_STATUSES: Array<PaymentOrderStatus | "all"> = [
  "all",
  "pending",
  "paid",
  "failed",
  "expired",
];

function formatFen(value: number): string {
  return `¥${(value / 100).toFixed(2)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function statusFromParam(value: string | null): PaymentOrderStatus | "all" {
  return ORDER_STATUSES.includes(value as PaymentOrderStatus | "all")
    ? value as PaymentOrderStatus | "all"
    : "all";
}

export function OrdersPage() {
  const strings = getStrings("zh").billing;
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q")?.trim() ?? "";
  const status = statusFromParam(searchParams.get("status"));
  const pageValue = Number(searchParams.get("page") ?? "1");
  const page = Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1;
  const [searchInput, setSearchInput] = useState(query);
  const [orders, setOrders] = useState<PaymentOrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [haveNext, setHaveNext] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => setSearchInput(query), [query]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void listPaymentOrders({
      limit: ORDER_PAGE_SIZE + 1,
      offset: (page - 1) * ORDER_PAGE_SIZE,
      search: query,
      status,
    })
      .then((nextOrders) => {
        if (!active) return;
        setOrders(nextOrders.slice(0, ORDER_PAGE_SIZE));
        setHaveNext(nextOrders.length > ORDER_PAGE_SIZE);
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError, strings.loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [page, query, reloadKey, status, strings.loadError]);

  const updateFilters = (next: { page?: number; query?: string; status?: PaymentOrderStatus | "all" }) => {
    const params = new URLSearchParams(searchParams);
    const nextQuery = next.query ?? query;
    const nextStatus = next.status ?? status;
    const nextPage = next.page ?? page;
    if (nextQuery) params.set("q", nextQuery); else params.delete("q");
    if (nextStatus !== "all") params.set("status", nextStatus); else params.delete("status");
    if (nextPage > 1) params.set("page", String(nextPage)); else params.delete("page");
    setSearchParams(params, { replace: true });
  };

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    updateFilters({ page: 1, query: searchInput.trim() });
  };

  return (
    <section className="orders-page billing-workspace" aria-labelledby="orders-title">
      <div className="page-heading billing-page-heading">
        <div>
          <span className="page-eyebrow">支付记录</span>
          <h1 id="orders-title">{strings.ordersTitle}</h1>
          <p>{strings.ordersNote}</p>
        </div>
        <div className="page-actions">
          <Link className="secondary-button" to="/wallet">
            <WalletCards aria-hidden="true" size={16} />
            返回钱包
          </Link>
        </div>
      </div>

      <form className="orders-toolbar" role="search" onSubmit={handleSearch}>
        <label className="orders-search" htmlFor="orders-search-input">
          <span>搜索订单</span>
          <div>
            <Search aria-hidden="true" size={16} />
            <input
              id="orders-search-input"
              type="search"
              value={searchInput}
              placeholder="套餐名称或订单号"
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
        </label>
        <SelectMenu
          label="状态"
          value={status}
          onValueChange={(nextStatus) => updateFilters({ page: 1, status: nextStatus })}
          options={[
            { value: "all", label: "全部状态" },
            { value: "pending", label: strings.orderStatusLabels.pending },
            { value: "paid", label: strings.orderStatusLabels.paid },
            { value: "failed", label: strings.orderStatusLabels.failed },
            { value: "expired", label: strings.orderStatusLabels.expired },
          ]}
        />
        <button className="primary-button" type="submit">
          <Search aria-hidden="true" size={16} />
          搜索
        </button>
        <button
          className="icon-button"
          type="button"
          title="刷新订单"
          aria-label="刷新订单"
          disabled={loading}
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <RefreshCw aria-hidden="true" size={16} />
        </button>
      </form>

      {error ? (
        <div className="billing-inline-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>重试</button>
        </div>
      ) : null}
      {loading ? <p className="billing-loading" role="status">正在加载订单...</p> : null}
      {!loading && !error && orders.length === 0 ? (
        <div className="billing-empty orders-empty">
          <ReceiptText aria-hidden="true" size={22} />
          <strong>{query || status !== "all" ? "没有符合筛选条件的订单" : strings.emptyOrders}</strong>
          <span>订单状态只以服务端支付确认结果为准。</span>
        </div>
      ) : null}

      {orders.length > 0 ? (
        <>
          <div className="orders-table-wrap">
            <table className="orders-table">
              <thead>
                <tr>
                  <th scope="col">套餐</th>
                  <th scope="col">状态</th>
                  <th scope="col">金额</th>
                  <th scope="col">订单</th>
                  <th scope="col">创建时间</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <strong>{order.product_title}</strong>
                      <small>到账 {formatCnyUnits(order.credit_units)}</small>
                    </td>
                    <td><span className={`status-pill status-${order.status}`}>{strings.orderStatusLabels[order.status]}</span></td>
                    <td>{formatFen(order.amount_cny_fen)}</td>
                    <td className="order-reference"><span>{order.merchant_order_masked}</span><small title={order.id}>{order.id}</small></td>
                    <td><time dateTime={order.created_at}>{formatDate(order.created_at)}</time></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="orders-mobile-list" aria-label="订单列表">
            {orders.map((order) => (
              <li key={order.id}>
                <header>
                  <div><ReceiptText aria-hidden="true" size={17} /><strong>{order.product_title}</strong></div>
                  <span className={`status-pill status-${order.status}`}>{strings.orderStatusLabels[order.status]}</span>
                </header>
                <dl>
                  <div><dt>金额</dt><dd>{formatFen(order.amount_cny_fen)}</dd></div>
                  <div><dt>到账金额</dt><dd>{formatCnyUnits(order.credit_units)}</dd></div>
                  <div><dt>订单</dt><dd>{order.merchant_order_masked}</dd></div>
                  <div><dt>创建时间</dt><dd>{formatDate(order.created_at)}</dd></div>
                </dl>
                <small className="order-mobile-id" title={order.id}>{order.id}</small>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <nav className="billing-pagination" aria-label="订单分页">
        <button type="button" disabled={page === 1 || loading} onClick={() => updateFilters({ page: page - 1 })}>
          <ChevronLeft aria-hidden="true" size={16} /> 上一页
        </button>
        <span>第 {page} 页</span>
        <button type="button" disabled={!haveNext || loading} onClick={() => updateFilters({ page: page + 1 })}>
          下一页 <ChevronRight aria-hidden="true" size={16} />
        </button>
      </nav>
    </section>
  );
}
