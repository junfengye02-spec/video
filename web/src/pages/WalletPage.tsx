import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CreditCard,
  History,
  LoaderCircle,
  RefreshCw,
  WalletCards,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  createPaymentOrder,
  getPaymentOrder,
  listPaymentOrders,
  listTopupProducts,
  listWalletEntries,
} from "../billing/api";
import { notifyBillingChanged, useBilling } from "../billing/BillingProvider";
import { formatCnyUnits } from "../billing/money";
import type {
  PaymentOrderStatus,
  PaymentOrderView,
  TopupProductView,
  WalletEntryView,
} from "../billing/types";
import { getStrings } from "../i18n";

type SubmitGatewayForm = (actionUrl: string, fields: Record<string, string>) => void;
type ReturnPhase = "checking" | PaymentOrderStatus | "cancelled" | "interrupted";

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
const ENTRY_PAGE_SIZE = 8;
const PAYMENT_POLL_DELAY_MS = 2500;
const PAYMENT_POLL_LIMIT = 24;
const PAYMENT_POLL_ERROR_LIMIT = 3;
const RETURN_ORDER_MATCH_WINDOW_MS = 30 * 60 * 1000;

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

function formatFen(value: number): string {
  return `¥${(value / 100).toFixed(2)}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function entryKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    admin_credit: "管理员增加",
    admin_debit: "管理员扣减",
    consume: "制作消耗",
    refund: "费用退回",
    topup: "充值到账",
  };
  return labels[kind] ?? kind;
}

function returnStatusCopy(phase: ReturnPhase): { title: string; body: string } {
  if (phase === "paid") return { title: "充值已到账", body: "订单已由服务端确认，钱包余额已刷新。" };
  if (phase === "pending") return { title: "等待支付确认", body: "支付结果尚未由服务端确认，本页会继续检查。" };
  if (phase === "expired") return { title: "订单已过期", body: "该订单已超过支付有效期，不会记入钱包。" };
  if (phase === "failed") return { title: "支付未完成", body: "服务端未确认该订单成功，可以重新发起充值。" };
  if (phase === "cancelled") return { title: "支付已取消", body: "没有创建新的余额变更，可以返回套餐重新选择。" };
  if (phase === "interrupted") return { title: "状态检查已暂停", body: "网络不稳定或等待时间过长。订单事实仍保存在服务端，可手动重试。" };
  return { title: "正在核对支付结果", body: "只读取服务端订单状态，不根据返回参数增加余额。" };
}

function WalletPageView({
  submitGatewayForm: submitForm = submitGatewayForm,
}: WalletPageProps) {
  const strings = getStrings("zh").billing;
  const location = useLocation();
  const billing = useBilling();
  const refreshWallet = billing.refreshWallet;
  const [products, setProducts] = useState<TopupProductView[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [entries, setEntries] = useState<WalletEntryView[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(true);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [entryPage, setEntryPage] = useState(0);
  const [entriesHaveNext, setEntriesHaveNext] = useState(false);
  const [entriesReloadKey, setEntriesReloadKey] = useState(0);
  const [amountYuan, setAmountYuan] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creatingOrder, setCreatingOrder] = useState(false);
  const [returnOrder, setReturnOrder] = useState<PaymentOrderView | null>(null);
  const [returnPhase, setReturnPhase] = useState<ReturnPhase | null>(null);
  const [returnError, setReturnError] = useState<string | null>(null);
  const [resolvedReturnOrderId, setResolvedReturnOrderId] = useState<string | null>(null);
  const [pollRetryKey, setPollRetryKey] = useState(0);
  const createInFlightRef = useRef(false);
  const pollRequestRef = useRef<{
    key: string;
    promise: Promise<PaymentOrderView>;
    expiresAt: number;
  } | null>(null);
  const returnParams = new URLSearchParams(location.search);
  const returnOrderId = returnParams.get("order_id");
  const returnState = returnParams.get("payment");
  const effectiveReturnOrderId = returnState === "failed"
    ? returnOrderId ?? resolvedReturnOrderId
    : returnOrderId;

  const loadProducts = useCallback(async () => {
    setProductsLoading(true);
    setProductsError(null);
    try {
      const nextProducts = await listTopupProducts();
      setProducts(nextProducts);
      setSelectedProductId((current) => (
        current && nextProducts.some((product) => product.id === current)
          ? current
          : nextProducts[0]?.id ?? null
      ));
    } catch (loadError) {
      setProductsError(errorMessage(loadError, "无法加载充值套餐。"));
    } finally {
      setProductsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  useEffect(() => {
    let active = true;
    setEntriesLoading(true);
    setEntriesError(null);
    void listWalletEntries(ENTRY_PAGE_SIZE + 1, entryPage * ENTRY_PAGE_SIZE)
      .then((nextEntries) => {
        if (!active) return;
        setEntries(nextEntries.slice(0, ENTRY_PAGE_SIZE));
        setEntriesHaveNext(nextEntries.length > ENTRY_PAGE_SIZE);
      })
      .catch((loadError) => {
        if (active) setEntriesError(errorMessage(loadError, strings.loadError));
      })
      .finally(() => {
        if (active) setEntriesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [entryPage, entriesReloadKey, strings.loadError]);

  useEffect(() => {
    if (!returnState) {
      setReturnPhase(null);
      setReturnOrder(null);
      setReturnError(null);
      setResolvedReturnOrderId(null);
      return undefined;
    }
    if (returnState === "failed" && !returnOrderId && !resolvedReturnOrderId) {
      let active = true;
      setReturnPhase("checking");
      setReturnError(null);
      void listPaymentOrders({ limit: 1 })
        .then(([latestOrder]) => {
          if (!active) return;
          const createdAt = Date.parse(latestOrder?.created_at ?? "");
          const recent = Number.isFinite(createdAt)
            && Math.abs(Date.now() - createdAt) <= RETURN_ORDER_MATCH_WINDOW_MS;
          if (latestOrder && recent) {
            setResolvedReturnOrderId(latestOrder.id);
            return;
          }
          setReturnPhase("failed");
        })
        .catch((error) => {
          if (!active) return;
          setReturnError(errorMessage(error, "暂时无法核对最近订单。"));
          setReturnPhase("failed");
        });
      return () => {
        active = false;
      };
    }
    if (!effectiveReturnOrderId) {
      setReturnPhase(returnState === "cancelled" ? "cancelled" : "failed");
      setReturnOrder(null);
      setReturnError(null);
      return undefined;
    }

    let active = true;
    let timer: number | null = null;
    let attempts = 0;
    let consecutiveErrors = 0;
    let walletRefreshed = false;
    setReturnPhase("checking");
    setReturnError(null);
    const pollRequestKey = `${effectiveReturnOrderId}:${pollRetryKey}`;

    const readOrder = () => {
      const now = Date.now();
      const cached = pollRequestRef.current;
      if (cached?.key === pollRequestKey && cached.expiresAt > now) {
        return cached.promise;
      }
      const promise = getPaymentOrder(effectiveReturnOrderId);
      pollRequestRef.current = {
        key: pollRequestKey,
        promise,
        expiresAt: now + PAYMENT_POLL_DELAY_MS,
      };
      return promise;
    };

    const schedule = () => {
      timer = window.setTimeout(() => void poll(), PAYMENT_POLL_DELAY_MS);
    };
    const poll = async () => {
      if (!active) return;
      attempts += 1;
      try {
        const order = await readOrder();
        if (!active) return;
        consecutiveErrors = 0;
        setReturnOrder(order);
        setReturnPhase(order.status);
        if (order.status === "paid") {
          if (!walletRefreshed) {
            walletRefreshed = true;
            notifyBillingChanged();
            await refreshWallet();
            if (active) {
              setEntryPage(0);
              setEntriesReloadKey((value) => value + 1);
            }
          }
          return;
        }
        if (order.status !== "pending") return;
        if (attempts >= PAYMENT_POLL_LIMIT) {
          setReturnPhase("interrupted");
          return;
        }
        schedule();
      } catch (pollError) {
        if (!active) return;
        consecutiveErrors += 1;
        setReturnError(errorMessage(pollError, "暂时无法核对支付状态。"));
        if (consecutiveErrors >= PAYMENT_POLL_ERROR_LIMIT) {
          setReturnPhase("interrupted");
          return;
        }
        schedule();
      }
    };

    void poll();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [effectiveReturnOrderId, listPaymentOrders, pollRetryKey, refreshWallet, returnOrderId, resolvedReturnOrderId, returnState]);

  const createOrder = async (source: { amount_cny_fen: number } | { product_id: string }) => {
    if (createInFlightRef.current) return;
    createInFlightRef.current = true;
    setCreatingOrder(true);
    setCreateError(null);
    try {
      const action = await createPaymentOrder(source);
      submitForm(action.action_url, action.form_fields);
    } catch (error) {
      setCreateError(errorMessage(error, strings.createOrderError));
    } finally {
      createInFlightRef.current = false;
      setCreatingOrder(false);
    }
  };

  const handleCustomTopup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amountCnyFen = parseYuanAmountToFen(amountYuan);
    if (amountCnyFen === null) {
      setCreateError(strings.invalidTopupAmount);
      return;
    }
    await createOrder({ amount_cny_fen: amountCnyFen });
  };

  const selectedProduct = products.find((product) => product.id === selectedProductId) ?? null;
  const returnCopy = returnPhase ? returnStatusCopy(returnPhase) : null;

  return (
    <section className="wallet-page billing-workspace" aria-labelledby="wallet-title">
      <div className="page-heading billing-page-heading">
        <div>
          <span className="page-eyebrow">人民币余额</span>
          <h1 id="wallet-title">{strings.walletTitle}</h1>
          <p>{strings.walletNote}</p>
        </div>
        <div className="page-actions">
          <Link className="secondary-button" to="/orders">
            <History aria-hidden="true" size={16} />
            {strings.ordersLink}
          </Link>
        </div>
      </div>

      {billing.error ? <p className="billing-notice is-error" role="alert">{billing.error}</p> : null}

      <section className="wallet-balance-band" aria-label="钱包人民币余额">
        <div className="wallet-primary-balance">
          <span>{strings.availableLabel}</span>
          <strong>{billing.loading ? "--" : formatCnyUnits(billing.wallet?.available_units ?? 0)}</strong>
          <small>可用于新的制作报价与生成任务</small>
        </div>
        <dl className="wallet-balance-details">
          <div>
            <dt>{strings.heldLabel}</dt>
            <dd>{billing.loading ? "--" : formatCnyUnits(billing.wallet?.held_units ?? 0)}</dd>
            <small>服务端为进行中的制作报价冻结</small>
          </div>
          <div>
            <dt>总余额</dt>
            <dd>{billing.loading ? "--" : formatCnyUnits(billing.wallet?.balance_units ?? 0)}</dd>
            <small>服务端钱包总额，不由前端推算</small>
          </div>
        </dl>
      </section>

      {returnCopy ? (
        <section className={`payment-return-panel is-${returnPhase}`} aria-live="polite">
          {returnPhase === "paid" ? <CheckCircle2 aria-hidden="true" size={20} /> : returnPhase === "checking" || returnPhase === "pending" ? <LoaderCircle className="spin" aria-hidden="true" size={20} /> : <CircleAlert aria-hidden="true" size={20} />}
          <div>
            <strong>{returnCopy.title}</strong>
            <p>{returnCopy.body}</p>
            {returnOrder ? <small>{returnOrder.product_title} · {returnOrder.merchant_order_masked}</small> : null}
            {returnError ? <small className="payment-return-error">{returnError}</small> : null}
          </div>
          {returnPhase === "interrupted" ? (
            <button className="secondary-button" type="button" onClick={() => setPollRetryKey((value) => value + 1)}>
              <RefreshCw aria-hidden="true" size={16} />
              重新检查
            </button>
          ) : null}
        </section>
      ) : null}

      <section className="billing-section wallet-topup-section" aria-labelledby="topup-title">
        <div className="section-heading">
          <div>
            <WalletCards aria-hidden="true" size={18} />
            <h2 id="topup-title">{strings.topupTitle}</h2>
          </div>
          <p>套餐金额和到账人民币余额均来自服务端配置。</p>
        </div>

        {productsError ? (
          <div className="billing-inline-error" role="alert">
            <span>{productsError}</span>
            <button type="button" onClick={() => void loadProducts()}>重试</button>
          </div>
        ) : null}
        {productsLoading ? <p className="billing-loading" role="status">正在加载充值套餐...</p> : null}
        {!productsLoading && !productsError && products.length === 0 ? (
          <p className="billing-empty">当前没有可用固定套餐，可使用自定义金额充值。</p>
        ) : null}
        {products.length > 0 ? (
          <div className="topup-package-list" role="radiogroup" aria-label="充值套餐">
            {products.map((product) => (
              <button
                key={product.id}
                type="button"
                role="radio"
                aria-checked={selectedProductId === product.id}
                className="topup-package"
                disabled={creatingOrder}
                onClick={() => setSelectedProductId(product.id)}
              >
                <span>{product.title}</span>
                <strong>{formatFen(product.price_cny_fen)}</strong>
                <small>到账 {formatCnyUnits(product.credit_units)}</small>
              </button>
            ))}
          </div>
        ) : null}
        {selectedProduct ? (
          <button
            className="primary-button async-action topup-package-submit"
            type="button"
            disabled={creatingOrder}
            onClick={() => void createOrder({ product_id: selectedProduct.id })}
          >
            <CreditCard aria-hidden="true" size={16} />
            {creatingOrder ? strings.creatingOrder : `支付 ${formatFen(selectedProduct.price_cny_fen)}`}
          </button>
        ) : null}

        <div className="custom-topup-divider"><span>或自定义金额</span></div>
        <form className="billing-topup-form" onSubmit={(event) => void handleCustomTopup(event)}>
          <label className="field-label" htmlFor="topup-amount">{strings.topupAmountLabel}</label>
          <div className="billing-topup-row">
            <div className="billing-amount-input">
              <span aria-hidden="true">¥</span>
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
            <button className="secondary-button async-action" type="submit" disabled={creatingOrder}>
              <CreditCard aria-hidden="true" size={16} />
              {creatingOrder ? strings.creatingOrder : "按金额充值"}
            </button>
          </div>
        </form>
        {createError ? <p className="billing-notice is-error" role="alert">{createError}</p> : null}
      </section>

      <section className="billing-section" aria-labelledby="wallet-entries-title">
        <div className="section-heading">
          <div>
            <History aria-hidden="true" size={18} />
            <h2 id="wallet-entries-title">{strings.walletEntriesTitle}</h2>
          </div>
          <button className="icon-button" type="button" title="刷新流水" aria-label="刷新钱包流水" disabled={entriesLoading} onClick={() => setEntriesReloadKey((value) => value + 1)}>
            <RefreshCw aria-hidden="true" size={16} />
          </button>
        </div>
        {entriesError ? (
          <div className="billing-inline-error" role="alert">
            <span>{entriesError}</span>
            <button type="button" onClick={() => setEntriesReloadKey((value) => value + 1)}>重试</button>
          </div>
        ) : null}
        {entriesLoading ? <p className="billing-loading" role="status">正在加载钱包流水...</p> : null}
        {!entriesLoading && !entriesError && entries.length === 0 ? <p className="billing-empty">{strings.noWalletEntries}</p> : null}
        {entries.length > 0 ? (
          <ul className="wallet-entry-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <div>
                  <strong>{entryKindLabel(entry.kind)}</strong>
                  <small>{formatDate(entry.created_at)}</small>
                </div>
                <span className={entry.amount_units < 0 ? "is-negative" : "is-positive"}>
                  {entry.amount_units > 0 ? "+" : ""}{formatCnyUnits(entry.amount_units)}
                </span>
                <small>余额 {formatCnyUnits(entry.balance_after_units)}</small>
              </li>
            ))}
          </ul>
        ) : null}
        <nav className="billing-pagination" aria-label="钱包流水分页">
          <button type="button" disabled={entryPage === 0 || entriesLoading} onClick={() => setEntryPage((page) => Math.max(0, page - 1))}>
            <ChevronLeft aria-hidden="true" size={16} /> 上一页
          </button>
          <span>第 {entryPage + 1} 页</span>
          <button type="button" disabled={!entriesHaveNext || entriesLoading} onClick={() => setEntryPage((page) => page + 1)}>
            下一页 <ChevronRight aria-hidden="true" size={16} />
          </button>
        </nav>
      </section>
    </section>
  );
}

export const WalletPage = Object.assign(WalletPageView, {
  submitGatewayFormForTest: submitGatewayForm,
});
