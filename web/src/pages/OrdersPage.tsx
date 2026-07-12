import { ReceiptText } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listPaymentOrders } from "../billing/api";
import type { PaymentOrderView } from "../billing/types";
import { getStrings } from "../i18n";

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

export function OrdersPage() {
  const strings = getStrings("zh").billing;
  const [orders, setOrders] = useState<PaymentOrderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void listPaymentOrders()
      .then((nextOrders) => {
        if (active) setOrders(nextOrders);
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
  }, [strings.loadError]);

  return (
    <section className="orders-page" aria-labelledby="orders-title">
      <div className="page-heading">
        <div>
          <h1 id="orders-title">{strings.ordersTitle}</h1>
          <p>{strings.ordersNote}</p>
        </div>
        <div className="page-actions">
          <Link to="/wallet">{strings.walletTitle}</Link>
        </div>
      </div>

      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p>{strings.loading}</p> : null}
      {!loading && orders.length === 0 ? <p>{strings.emptyOrders}</p> : null}

      {orders.length > 0 ? (
        <ul className="billing-list order-list">
          {orders.map((order) => (
            <li key={order.id}>
              <ReceiptText aria-hidden="true" size={18} />
              <div>
                <strong>{order.product_title}</strong>
                <span className={`status-pill status-${order.status}`}>
                  {strings.orderStatusLabels[order.status]}
                </span>
                <dl>
                  <div>
                    <dt>{strings.amountLabel}</dt>
                    <dd>{formatFen(order.amount_cny_fen)}</dd>
                  </div>
                  <div>
                    <dt>{strings.maskedOrderLabel}</dt>
                    <dd>{order.merchant_order_masked}</dd>
                  </div>
                  <div>
                    <dt>{strings.createdLabel}</dt>
                    <dd>{formatDate(order.created_at)}</dd>
                  </div>
                </dl>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
