import { RefreshCcw, Save, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getBillingAdmin,
  retryReconciliation,
  updateMultiplier,
} from "../../billing/api";
import type {
  BillingAdminSnapshot,
  BillingReconciliationView,
} from "../../billing/types";

export function multiplierTextToBps(value: string): number | null {
  const match = /^(\d{1,2})(?:\.(\d{1,4}))?$/.exec(value.trim());
  if (!match) return null;
  const bps = Number(match[1]) * 10_000 + Number((match[2] ?? "").padEnd(4, "0"));
  return bps >= 10_000 && bps <= 100_000 ? bps : null;
}

function multiplierBpsToText(value: number): string {
  const whole = Math.floor(value / 10_000);
  const fraction = String(value % 10_000).padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}.000`;
}

function formatFen(value: number): string {
  return `¥${(value / 100).toFixed(2)}`;
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function BillingAdminPage() {
  const [snapshot, setSnapshot] = useState<BillingAdminSnapshot | null>(null);
  const [multiplierText, setMultiplierText] = useState("1.000");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    const next = await getBillingAdmin();
    setSnapshot(next);
    setMultiplierText(multiplierBpsToText(next.settings.multiplier_bps));
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void getBillingAdmin()
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setMultiplierText(multiplierBpsToText(next.settings.multiplier_bps));
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError, "无法加载计费管理数据。"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleSaveMultiplier = async () => {
    const multiplier_bps = multiplierTextToBps(multiplierText);
    if (multiplier_bps === null) {
      setError("请输入 1.000 到 10.000 之间的倍率");
      return;
    }
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setError("请填写调整原因");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const settings = await updateMultiplier({ multiplier_bps, reason: trimmedReason });
      setSnapshot((current) => current ? { ...current, settings } : current);
      setReason("");
    } catch (saveError) {
      setError(errorMessage(saveError, "无法保存计费倍率。"));
    } finally {
      setSaving(false);
    }
  };

  const handleRetry = async (reconciliation: BillingReconciliationView) => {
    setRetryingId(reconciliation.id);
    setError(null);
    try {
      await retryReconciliation(reconciliation.id);
      await reload();
    } catch (retryError) {
      setError(errorMessage(retryError, "无法重试对账任务。"));
    } finally {
      setRetryingId(null);
    }
  };

  if (loading && !snapshot) {
    return <p role="status">正在加载计费管理数据...</p>;
  }

  return (
    <section className="billing-admin-page" aria-labelledby="billing-admin-title">
      <div className="page-heading">
        <div>
          <h1 id="billing-admin-title">计费管理</h1>
          <p>倍率、订单和对账任务均来自管理员 API。</p>
        </div>
      </div>

      {error ? <p role="alert">{error}</p> : null}

      <section className="review-section" aria-labelledby="billing-settings-title">
        <div className="section-heading">
          <Settings aria-hidden="true" size={18} />
          <h2 id="billing-settings-title">倍率设置</h2>
        </div>
        <div className="prompt-grid">
          <label>
            计费倍率
            <input
              inputMode="decimal"
              value={multiplierText}
              onChange={(event) => setMultiplierText(event.target.value)}
            />
          </label>
          <label>
            调整原因
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            className="primary-button async-action"
            type="button"
            disabled={saving}
            onClick={() => void handleSaveMultiplier()}
          >
            <Save aria-hidden="true" size={16} />
            保存倍率
          </button>
        </div>
      </section>

      <section className="review-section" aria-labelledby="admin-orders-title">
        <h2 id="admin-orders-title">支付订单</h2>
        <ul className="billing-list">
          {(snapshot?.orders ?? []).map((order) => (
            <li key={order.id}>
              <strong>{order.product_title}</strong>
              <span>{order.status} / {formatFen(order.price_cny_fen)} / {order.merchant_order_no_masked}</span>
              <small>{formatDate(order.created_at)}</small>
            </li>
          ))}
        </ul>
      </section>

      <section className="review-section" aria-labelledby="admin-reconciliations-title">
        <h2 id="admin-reconciliations-title">对账任务</h2>
        <ul className="billing-list">
          {(snapshot?.reconciliations ?? []).map((reconciliation) => (
            <li key={reconciliation.id}>
              <strong>{reconciliation.kind}</strong>
              <span>{reconciliation.status} / {reconciliation.last_error_code ?? "-"}</span>
              <small>{formatDate(reconciliation.next_retry_at)}</small>
              <button
                type="button"
                disabled={reconciliation.status !== "open" || retryingId === reconciliation.id}
                aria-label={`重试对账 ${reconciliation.id}`}
                onClick={() => void handleRetry(reconciliation)}
              >
                <RefreshCcw aria-hidden="true" size={16} />
                重试
              </button>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
