import { CreditCard, History, WalletCards } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  createPaymentOrder,
  getPaymentOrder,
  listWalletEntries,
} from "../billing/api";
import { useBilling } from "../billing/BillingProvider";
import type {
  PaymentOrderView,
  WalletEntryView,
} from "../billing/types";
import { getStrings } from "../i18n";

type SubmitGatewayForm = (actionUrl: string, fields: Record<string, string>) => void;

export function submitGatewayForm(actionUrl: string, fields: Record<string, string>): void {
  const url = new URL(actionUrl);
  if (url.protocol !== "https:") throw new Error("Payment gateway must use HTTPS");

  const form = document.createElement("form");
  form.method = "POST";
  form.action = url.toString();
  form.hidden = true;
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
  form.remove();
}

export interface WalletPageProps {
  submitGatewayForm?: SubmitGatewayForm;
}

const MAX_TOPUP_AMOUNT_CNY_FEN = 10_000_000;

function parseYuanAmountToFen(value: string): number | null {
  const match = /^(0|[1-9]\d{0,5})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return amount >= 1 && amount <= MAX_TOPUP_AMOUNT_CNY_FEN ? amount : null;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function WalletPageView({
  submitGatewayForm: submitForm = submitGatewayForm,
}: WalletPageProps) {
  const strings = getStrings("zh").billing;
  const location = useLocation();
  const billing = useBilling();
  const refreshWallet = billing.refreshWallet;
  const [entries, setEntries] = useState<WalletEntryView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [amountYuan, setAmountYuan] = useState("");
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [returnOrder, setReturnOrder] = useState<PaymentOrderView | null>(null);
  const pollingRef = useRef<number | null>(null);
  const returnParams = new URLSearchParams(location.search);
  const returnOrderId = returnParams.get("order_id");
  const returnState = returnParams.get("payment");

  useEffect(() => {
    let active = true;
    setError(null);
    void listWalletEntries()
      .then((nextEntries) => {
        if (!active) return;
        setEntries(nextEntries);
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError, strings.loadError));
      });
    return () => {
      active = false;
    };
  }, [strings.loadError]);

  useEffect(() => {
    if (!returnOrderId) return undefined;
    let active = true;

    const poll = async () => {
      try {
        const order = await getPaymentOrder(returnOrderId);
        if (!active) return;
        setReturnOrder(order);
        if (order.status === "paid") void refreshWallet();
        if (order.status !== "pending" && pollingRef.current !== null) {
          window.clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      } catch (pollError) {
        if (active) setError(errorMessage(pollError, strings.loadError));
      }
    };

    void poll();
    pollingRef.current = window.setInterval(() => void poll(), 2500);
    return () => {
      active = false;
      if (pollingRef.current !== null) {
        window.clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [refreshWallet, returnOrderId, strings.loadError]);

  const handleCreateOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creatingOrder) return;
    const amountCnyFen = parseYuanAmountToFen(amountYuan);
    if (amountCnyFen === null) {
      setError(strings.invalidTopupAmount);
      return;
    }
    setCreatingOrder(true);
    setError(null);
    try {
      const action = await createPaymentOrder(amountCnyFen);
      submitForm(action.action_url, action.form_fields);
    } catch (createError) {
      setError(errorMessage(createError, strings.createOrderError));
    } finally {
      setCreatingOrder(false);
    }
  };

  return (
    <section className="wallet-page" aria-labelledby="wallet-title">
      <div className="page-heading">
        <div>
          <h1 id="wallet-title">{strings.walletTitle}</h1>
          <p>{strings.walletNote}</p>
        </div>
        <div className="page-actions">
          <Link to="/orders">
            <History aria-hidden="true" size={16} />
            {strings.ordersLink}
          </Link>
        </div>
      </div>

      {billing.error ? <p role="alert">{billing.error}</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      <div className="billing-summary-grid">
        <section className="review-section" aria-label={strings.balanceLabel}>
          <h2>{strings.balanceLabel}</h2>
          <strong>{billing.loading ? strings.loading : billing.wallet?.balance_units ?? 0}</strong>
        </section>
        <section className="review-section" aria-label={strings.heldLabel}>
          <h2>{strings.heldLabel}</h2>
          <strong>{billing.loading ? strings.loading : billing.wallet?.held_units ?? 0}</strong>
        </section>
        <section className="review-section" aria-label={strings.availableLabel}>
          <h2>{strings.availableLabel}</h2>
          <strong>{billing.loading ? strings.loading : billing.wallet?.available_units ?? 0}</strong>
        </section>
      </div>

      {returnState ? (
        <p className="payment-return-status" role="status">
          <span>{strings.paymentReturnTrusted}</span>
          {returnOrder ? ` ${strings.orderStatusLabels[returnOrder.status]}` : ""}
        </p>
      ) : null}

      <section className="billing-section" aria-labelledby="topup-title">
        <div className="section-heading">
          <WalletCards aria-hidden="true" size={18} />
          <h2 id="topup-title">{strings.topupTitle}</h2>
        </div>
        <form className="billing-topup-form" onSubmit={(event) => void handleCreateOrder(event)}>
          <label className="field-label" htmlFor="topup-amount">
            {strings.topupAmountLabel}
          </label>
          <div className="billing-topup-row">
            <div className="billing-amount-input">
              <span aria-hidden="true">\u00a5</span>
              <input
                id="topup-amount"
                type="number"
                inputMode="decimal"
                min="0.01"
                max={MAX_TOPUP_AMOUNT_CNY_FEN / 100}
                step="0.01"
                value={amountYuan}
                disabled={creatingOrder}
                onChange={(event) => setAmountYuan(event.target.value)}
              />
            </div>
            <button
              className="primary-button async-action"
              type="submit"
              disabled={creatingOrder}
            >
              <CreditCard aria-hidden="true" size={16} />
              {creatingOrder ? strings.creatingOrder : strings.rechargeButton}
            </button>
          </div>
        </form>
      </section>

      <section className="billing-section" aria-labelledby="wallet-entries-title">
        <div className="section-heading">
          <History aria-hidden="true" size={18} />
          <h2 id="wallet-entries-title">{strings.walletEntriesTitle}</h2>
        </div>
        {entries.length === 0 ? <p>{strings.noWalletEntries}</p> : (
          <ul className="billing-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.kind}</strong>
                <span>{entry.amount_units}</span>
                <small>{formatDate(entry.created_at)}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

export const WalletPage = Object.assign(WalletPageView, {
  submitGatewayFormForTest: submitGatewayForm,
});
