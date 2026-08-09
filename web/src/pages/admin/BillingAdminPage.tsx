import {
  AlertTriangle,
  BadgeDollarSign,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Minus,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Settings,
  UsersRound,
  WalletCards,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { SelectMenu } from "../../shared/ui";
import {
  adjustUserBalance,
  getBillingAdmin,
  listAdminOrders,
  listAdminUsers,
  retryReconciliation,
  updateMultiplier,
} from "../../billing/api";
import { notifyBillingChanged } from "../../billing/BillingProvider";
import { formatCnyUnits, WALLET_UNITS_PER_CNY } from "../../billing/money";
import type {
  AdminUserWalletView,
  BillingAdminSnapshot,
  BillingReconciliationView,
  PaymentOrderStatus,
} from "../../billing/types";
import { BillingConfirmDialog } from "../../features/billing/BillingConfirmDialog";

type BalanceAdjustmentMode = "credit" | "debit";
type AdminConfirmation =
  | { kind: "multiplier"; multiplierBps: number; reason: string }
  | { kind: "balance"; user: AdminUserWalletView; amountUnits: number; requestId: string; reason: string }
  | { kind: "reconciliation"; reconciliation: BillingReconciliationView; reason: string };

const ADMIN_ORDER_LIMIT = 20;
const ADMIN_ORDER_PAGE_SIZE = 20;

export function multiplierTextToBps(value: string): number | null {
  const match = /^(\d{1,2})(?:\.(\d{1,4}))?$/.exec(value.trim());
  if (!match) return null;
  const bps = Number(match[1]) * 10_000 + Number((match[2] ?? "").padEnd(4, "0"));
  return bps >= 10_000 && bps <= 100_000 ? bps : null;
}

export function balanceAdjustmentTextToUnits(
  value: string,
  mode: BalanceAdjustmentMode,
): number | null {
  const normalized = value.trim();
  const match = /^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const units = Number(match[1]) * WALLET_UNITS_PER_CNY
    + Number((match[2] ?? "").padEnd(2, "0")) * (WALLET_UNITS_PER_CNY / 100);
  if (!Number.isSafeInteger(units) || units <= 0 || units > 9_000_000_000_000_000) return null;
  return mode === "credit" ? units : -units;
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

function formatInteger(value: number): string {
  return value.toLocaleString("zh-CN");
}

function newAdjustmentRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_balance`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function confirmationCopy(confirmation: AdminConfirmation): {
  confirmLabel: string;
  description: string;
  title: string;
} {
  if (confirmation.kind === "multiplier") {
    return {
      title: "确认修改计费倍率",
      description: `新的计费倍率为 ${multiplierBpsToText(confirmation.multiplierBps)}。它只影响后续创建的计费任务。`,
      confirmLabel: "确认修改倍率",
    };
  }
  if (confirmation.kind === "balance") {
    const verb = confirmation.amountUnits > 0 ? "增加" : "扣减";
    return {
      title: `确认${verb}用户余额`,
      description: `${confirmation.user.email} 将${verb} ${formatCnyUnits(Math.abs(confirmation.amountUnits))}。服务端会校验冻结金额并使用同一请求号去重。`,
      confirmLabel: `确认${verb}余额`,
    };
  }
  return {
    title: "确认重试对账任务",
    description: `将重新调度对账任务 ${confirmation.reconciliation.id}。此操作不会直接扣减用户额度。`,
    confirmLabel: "确认重新调度",
  };
}

export function BillingAdminPage() {
  const [snapshot, setSnapshot] = useState<BillingAdminSnapshot | null>(null);
  const [multiplierText, setMultiplierText] = useState("1.000");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [userSearch, setUserSearch] = useState("");
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [adjustmentMode, setAdjustmentMode] = useState<BalanceAdjustmentMode>("credit");
  const [adjustmentText, setAdjustmentText] = useState("");
  const [orderSearch, setOrderSearch] = useState("");
  const [orderStatus, setOrderStatus] = useState<PaymentOrderStatus | "all">("all");
  const [orderPage, setOrderPage] = useState(0);
  const [filteringOrders, setFilteringOrders] = useState(false);
  const [confirmation, setConfirmation] = useState<AdminConfirmation | null>(null);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const actionInFlightRef = useRef(false);
  const userSearchInFlightRef = useRef(false);
  const orderFilterInFlightRef = useRef(false);

  const selectedUser = snapshot?.users.find((user) => user.id === selectedUserId) ?? null;
  const orders = snapshot?.orders ?? [];
  const orderPageCount = Math.max(1, Math.ceil(orders.length / ADMIN_ORDER_PAGE_SIZE));
  const safeOrderPage = Math.min(orderPage, orderPageCount - 1);
  const visibleOrders = orders.slice(
    safeOrderPage * ADMIN_ORDER_PAGE_SIZE,
    (safeOrderPage + 1) * ADMIN_ORDER_PAGE_SIZE,
  );

  useEffect(() => {
    setOrderPage((current) => Math.min(current, orderPageCount - 1));
  }, [orderPageCount]);

  const reload = useCallback(async () => {
    const next = await getBillingAdmin();
    setSnapshot(next);
    setMultiplierText(multiplierBpsToText(next.settings.multiplier_bps));
    return next;
  }, []);

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
    return () => { active = false; };
  }, []);

  const openConfirmation = (next: AdminConfirmation, trigger: HTMLElement) => {
    returnFocusRef.current = trigger;
    setConfirmation(next);
    setConfirmationError(null);
    setNotice(null);
    setError(null);
  };

  const requestMultiplierConfirmation = (trigger: HTMLElement) => {
    const multiplierBps = multiplierTextToBps(multiplierText);
    if (multiplierBps === null) {
      setError("请输入 1.000 到 10.000 之间的倍率。");
      return;
    }
    openConfirmation({ kind: "multiplier", multiplierBps, reason: "" }, trigger);
  };

  const requestBalanceConfirmation = (trigger: HTMLElement) => {
    if (!selectedUser || !selectedUser.wallet_id) {
      setError("该用户的钱包不可用。");
      return;
    }
    const amountUnits = balanceAdjustmentTextToUnits(adjustmentText, adjustmentMode);
    if (amountUnits === null) {
      setError("请输入有效的人民币金额，最多两位小数。");
      return;
    }
    openConfirmation({
      kind: "balance",
      user: selectedUser,
      amountUnits,
      requestId: newAdjustmentRequestId(),
      reason: "",
    }, trigger);
  };

  const executeConfirmation = async () => {
    if (!confirmation || actionInFlightRef.current || !confirmation.reason.trim()) return;
    actionInFlightRef.current = true;
    setConfirmationPending(true);
    setConfirmationError(null);
    const action = confirmation;
    try {
      let successMessage = "管理员操作已完成。";
      if (action.kind === "multiplier") {
        await updateMultiplier({ multiplier_bps: action.multiplierBps, reason: action.reason.trim() });
        successMessage = "计费倍率已由服务端更新并写入审计记录。";
      } else if (action.kind === "balance") {
        await adjustUserBalance(action.user.id, {
          amount_units: action.amountUnits,
          reason: action.reason.trim(),
          request_id: action.requestId,
        });
        notifyBillingChanged();
        successMessage = `${action.user.email} 的余额调整已由服务端确认。`;
      } else {
        await retryReconciliation(action.reconciliation.id, action.reason.trim());
        successMessage = `对账任务 ${action.reconciliation.id} 已重新调度。`;
      }
      try {
        await reload();
      } catch (refreshError) {
        setError(errorMessage(refreshError, "操作已提交，但暂时无法刷新管理数据。"));
      }
      if (action.kind === "balance") {
        setAdjustmentText("");
        setSelectedUserId(null);
      }
      setConfirmation(null);
      setNotice(successMessage);
    } catch (actionError) {
      setConfirmationError(errorMessage(actionError, "管理员操作失败，服务端未确认成功。"));
    } finally {
      actionInFlightRef.current = false;
      setConfirmationPending(false);
    }
  };

  const handleUserSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (userSearchInFlightRef.current) return;
    userSearchInFlightRef.current = true;
    setSearchingUsers(true);
    setError(null);
    setNotice(null);
    try {
      const users = await listAdminUsers(userSearch);
      setSnapshot((current) => current ? { ...current, users } : current);
      if (selectedUserId && !users.some((user) => user.id === selectedUserId)) setSelectedUserId(null);
    } catch (searchError) {
      setError(errorMessage(searchError, "无法搜索用户。"));
    } finally {
      userSearchInFlightRef.current = false;
      setSearchingUsers(false);
    }
  };

  const handleOrderFilter = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (orderFilterInFlightRef.current) return;
    orderFilterInFlightRef.current = true;
    setFilteringOrders(true);
    setError(null);
    try {
      const orders = await listAdminOrders({
        limit: ADMIN_ORDER_LIMIT,
        search: orderSearch,
        status: orderStatus,
      });
      setSnapshot((current) => current ? { ...current, orders } : current);
      setOrderPage(0);
    } catch (filterError) {
      setError(errorMessage(filterError, "无法筛选支付订单。"));
    } finally {
      orderFilterInFlightRef.current = false;
      setFilteringOrders(false);
    }
  };

  if (loading && !snapshot) return <p className="billing-loading" role="status">正在加载计费管理数据...</p>;

  const copy = confirmation ? confirmationCopy(confirmation) : null;
  const summary = snapshot?.summary;

  return (
    <section className="billing-admin-page billing-workspace" aria-labelledby="billing-admin-title">
      <div className="page-heading billing-page-heading">
        <div>
          <span className="page-eyebrow">管理员工作区</span>
          <h1 id="billing-admin-title">计费管理</h1>
          <p>查看收入、订单和钱包事实；所有写操作均由服务端鉴权并进入审计记录。</p>
        </div>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => { setLoading(true); void reload().catch((loadError) => setError(errorMessage(loadError, "刷新失败。"))).finally(() => setLoading(false)); }}>
          <RefreshCcw aria-hidden="true" size={16} /> 刷新
        </button>
      </div>

      {error ? <p className="billing-notice is-error" role="alert">{error}</p> : null}
      {notice ? <p className="billing-notice is-success" role="status">{notice}</p> : null}

      {summary ? (
        <dl className="admin-metric-band" aria-label="计费指标">
          <div><BadgeDollarSign aria-hidden="true" size={18} /><dt>已支付收入</dt><dd>{formatFen(summary.gross_paid_cny_fen)}</dd><small>{summary.paid_orders} 笔已支付</small></div>
          <div><Clock3 aria-hidden="true" size={18} /><dt>全部订单</dt><dd>{formatInteger(summary.total_orders)}</dd><small>{summary.pending_orders} 笔待确认</small></div>
          <div><CircleDollarSign aria-hidden="true" size={18} /><dt>用户可用余额</dt><dd>{formatCnyUnits(summary.wallet_available_units)}</dd><small>服务端钱包汇总</small></div>
          <div><WalletCards aria-hidden="true" size={18} /><dt>预扣金额</dt><dd>{formatCnyUnits(summary.wallet_held_units)}</dd><small>制作报价和进行中任务</small></div>
        </dl>
      ) : null}

      <section className="admin-operation-section" aria-labelledby="billing-settings-title">
        <div className="section-heading">
          <div><Settings aria-hidden="true" size={18} /><h2 id="billing-settings-title">计费倍率</h2></div>
          <p>倍率只影响之后创建的任务，不回写历史报价。</p>
        </div>
        <div className="admin-setting-row">
          <label htmlFor="billing-multiplier">计费倍率
            <input id="billing-multiplier" inputMode="decimal" value={multiplierText} onChange={(event) => setMultiplierText(event.target.value)} />
          </label>
          <button className="primary-button" type="button" onClick={(event) => requestMultiplierConfirmation(event.currentTarget)}>
            <Save aria-hidden="true" size={16} /> 保存倍率
          </button>
        </div>
        <p className="admin-risk-hint"><AlertTriangle aria-hidden="true" size={15} /> 提交前需在确认对话框复核并填写原因；此提示不代表存在未实现的审批流程。</p>
      </section>

      <section className="admin-operation-section" aria-labelledby="admin-users-title">
        <div className="section-heading"><div><UsersRound aria-hidden="true" size={18} /><h2 id="admin-users-title">用户余额</h2></div></div>
        <form className="admin-user-search" role="search" onSubmit={(event) => void handleUserSearch(event)}>
          <label htmlFor="admin-user-search">搜索用户
            <input id="admin-user-search" type="search" value={userSearch} placeholder="邮箱" onChange={(event) => setUserSearch(event.target.value)} />
          </label>
          <button className="secondary-button" type="submit" disabled={searchingUsers}><Search aria-hidden="true" size={16} />{searchingUsers ? "搜索中" : "搜索"}</button>
        </form>

        {(snapshot?.users ?? []).length === 0 ? <p className="billing-empty">未找到用户。</p> : (
          <ul className="admin-user-list">
            {(snapshot?.users ?? []).map((user) => (
              <li key={user.id}>
                <div><strong>{user.email}</strong><small>{user.role === "admin" ? "管理员" : "用户"} · {user.status}</small></div>
                <dl><div><dt>总额</dt><dd>{formatCnyUnits(user.balance_units)}</dd></div><div><dt>预扣</dt><dd>{formatCnyUnits(user.held_units)}</dd></div><div><dt>可用</dt><dd>{formatCnyUnits(user.available_units)}</dd></div></dl>
                <button className="secondary-button" type="button" disabled={!user.wallet_id} aria-label={`调整 ${user.email} 的余额`} onClick={() => { setSelectedUserId(user.id); setAdjustmentMode("credit"); setAdjustmentText(""); setError(null); }}><WalletCards aria-hidden="true" size={16} /> 调整</button>
              </li>
            ))}
          </ul>
        )}

        {selectedUser ? (
          <form className="admin-balance-adjustment" aria-labelledby="admin-balance-adjustment-title" onSubmit={(event) => { event.preventDefault(); requestBalanceConfirmation(event.currentTarget.querySelector("button[type='submit']") as HTMLElement); }}>
            <div className="admin-balance-adjustment-heading"><div><h3 id="admin-balance-adjustment-title">调整 {selectedUser.email}</h3><p>当前总额 {formatCnyUnits(selectedUser.balance_units)}，预扣 {formatCnyUnits(selectedUser.held_units)}，可用 {formatCnyUnits(selectedUser.available_units)}</p></div></div>
            <div className="admin-balance-controls">
              <div className="admin-balance-mode" role="group" aria-label="调整方式">
                <button type="button" aria-pressed={adjustmentMode === "credit"} onClick={() => setAdjustmentMode("credit")}><Plus aria-hidden="true" size={15} /> 增加</button>
                <button type="button" aria-pressed={adjustmentMode === "debit"} onClick={() => setAdjustmentMode("debit")}><Minus aria-hidden="true" size={15} /> 扣减</button>
              </div>
              <label htmlFor="admin-adjustment-amount">金额（元）<input id="admin-adjustment-amount" inputMode="decimal" value={adjustmentText} onChange={(event) => setAdjustmentText(event.target.value)} /></label>
              <button className="primary-button" type="submit">{adjustmentMode === "credit" ? <Plus aria-hidden="true" size={16} /> : <Minus aria-hidden="true" size={16} />} 继续确认</button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="admin-operation-section" aria-labelledby="admin-orders-title">
        <div className="section-heading"><div><BadgeDollarSign aria-hidden="true" size={18} /><h2 id="admin-orders-title">支付订单</h2></div></div>
        <form className="admin-order-toolbar" onSubmit={(event) => void handleOrderFilter(event)}>
          <label htmlFor="admin-order-search">搜索套餐<input id="admin-order-search" type="search" value={orderSearch} onChange={(event) => setOrderSearch(event.target.value)} /></label>
          <SelectMenu label="状态" value={orderStatus} onValueChange={setOrderStatus} options={[{ value: "all", label: "全部" }, { value: "pending", label: "待支付" }, { value: "paid", label: "已支付" }, { value: "failed", label: "失败" }, { value: "expired", label: "已过期" }]} />
          <button className="secondary-button" type="submit" disabled={filteringOrders}><Search aria-hidden="true" size={16} />{filteringOrders ? "筛选中" : "筛选"}</button>
        </form>
        <div className="admin-table-wrap">
          <table className="admin-billing-table"><thead><tr><th scope="col">套餐</th><th scope="col">状态</th><th scope="col">金额</th><th scope="col">订单</th><th scope="col">时间</th></tr></thead><tbody>{visibleOrders.map((order) => <tr key={order.id}><td><strong>{order.product_title}</strong><small>到账 {formatCnyUnits(order.credit_units)}</small></td><td><span className={`status-pill status-${order.status}`}>{order.status}</span></td><td>{formatFen(order.price_cny_fen)}</td><td>{order.merchant_order_no_masked}</td><td>{formatDate(order.created_at)}</td></tr>)}</tbody></table>
        </div>
        {orders.length === 0 ? <p className="billing-empty">没有符合条件的支付订单。</p> : null}
        {orderPageCount > 1 ? (
          <nav className="billing-pagination" aria-label="支付订单分页">
            <button type="button" aria-label="上一页订单" disabled={safeOrderPage === 0} onClick={() => setOrderPage((current) => Math.max(0, current - 1))}>
              <ChevronLeft aria-hidden="true" size={14} /> 上一页
            </button>
            <span role="status" aria-live="polite" aria-label="订单分页状态">第 {safeOrderPage + 1} / {orderPageCount} 页，共 {orders.length} 笔</span>
            <button type="button" aria-label="下一页订单" disabled={safeOrderPage >= orderPageCount - 1} onClick={() => setOrderPage((current) => Math.min(orderPageCount - 1, current + 1))}>
              下一页 <ChevronRight aria-hidden="true" size={14} />
            </button>
          </nav>
        ) : null}
      </section>

      <section className="admin-operation-section" aria-labelledby="admin-reconciliations-title">
        <div className="section-heading"><div><RefreshCcw aria-hidden="true" size={18} /><h2 id="admin-reconciliations-title">对账任务</h2></div><p>失败信息仅显示脱敏错误代码。</p></div>
        <ul className="admin-reconciliation-list">
          {(snapshot?.reconciliations ?? []).map((reconciliation) => (
            <li key={reconciliation.id}><div><strong>{reconciliation.kind}</strong><small>{reconciliation.id}</small></div><span className={`status-pill ${reconciliation.status === "open" ? "status-pending" : "status-paid"}`}>{reconciliation.status === "open" ? "待处理" : "已解决"}</span><span>{reconciliation.last_error_code ?? "无错误代码"}</span><time>{formatDate(reconciliation.next_retry_at)}</time><button className="secondary-button" type="button" disabled={reconciliation.status !== "open"} aria-label={`重试对账 ${reconciliation.id}`} onClick={(event) => openConfirmation({ kind: "reconciliation", reconciliation, reason: "" }, event.currentTarget)}><RefreshCcw aria-hidden="true" size={16} /> 重试</button></li>
          ))}
        </ul>
        {(snapshot?.reconciliations ?? []).length === 0 ? <p className="billing-empty">当前没有对账任务。</p> : null}
      </section>

      {confirmation && copy ? (
        <BillingConfirmDialog
          confirmLabel={copy.confirmLabel}
          description={copy.description}
          error={confirmationError}
          pending={confirmationPending}
          reason={confirmation.reason}
          returnFocusRef={returnFocusRef}
          title={copy.title}
          onCancel={() => { if (!confirmationPending) setConfirmation(null); }}
          onConfirm={() => void executeConfirmation()}
          onReasonChange={(reason) => setConfirmation((current) => current ? { ...current, reason } : current)}
        />
      ) : null}
    </section>
  );
}
