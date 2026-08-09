import { authRequest } from "../api/client";
import type {
  AdminUserWalletView,
  AdjustUserBalanceRequest,
  BillingAdminSummary,
  BillingAdminSnapshot,
  BillingReconciliationView,
  BillingSettingsView,
  PaymentGatewayAction,
  PaymentOrderListQuery,
  PaymentOrderAdminView,
  PaymentOrderStatus,
  PaymentOrderView,
  ReconciliationRetryResponse,
  TopupProductView,
  UpdateMultiplierRequest,
  UserBalanceAdjustmentView,
  WalletEntryAdminView,
  WalletEntryView,
  WalletSummary,
} from "./types";

type ObjectRecord = Record<string, unknown>;

function postBody(value: unknown): string {
  return JSON.stringify(value);
}

function asObject(value: unknown): ObjectRecord {
  return value && typeof value === "object" ? value as ObjectRecord : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringField(record: ObjectRecord, field: string): string {
  const value = record[field];
  return typeof value === "string" ? value : "";
}

function nullableStringField(record: ObjectRecord, field: string): string | null {
  const value = record[field];
  return value === null || value === undefined ? null : stringField(record, field);
}

function numberField(record: ObjectRecord, field: string): number {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function statusField(record: ObjectRecord): PaymentOrderStatus {
  const value = stringField(record, "status");
  return value === "paid" || value === "expired" || value === "failed" ? value : "pending";
}

function recordOfStrings(value: unknown): Record<string, string> {
  const record = asObject(value);
  return Object.fromEntries(
    Object.entries(record)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function maskedOrder(record: ObjectRecord): string {
  const explicit = stringField(record, "merchant_order_masked")
    || stringField(record, "merchant_order_no_masked");
  if (explicit) return explicit;
  const id = stringField(record, "id");
  return id ? `****${id.slice(-4)}` : "****";
}

function paymentOrderView(value: unknown): PaymentOrderView {
  const record = asObject(value);
  return {
    id: stringField(record, "id"),
    merchant_order_masked: maskedOrder(record),
    product_title: stringField(record, "product_title"),
    amount_cny_fen: numberField(record, "amount_cny_fen") || numberField(record, "price_cny_fen"),
    credit_units: numberField(record, "credit_units"),
    status: statusField(record),
    expires_at: stringField(record, "expires_at"),
    paid_at: nullableStringField(record, "paid_at"),
    created_at: stringField(record, "created_at"),
    updated_at: stringField(record, "updated_at"),
  };
}

function topupProduct(value: unknown): TopupProductView {
  const record = asObject(value);
  return {
    id: stringField(record, "id"),
    title: stringField(record, "title"),
    price_cny_fen: numberField(record, "price_cny_fen"),
    credit_units: numberField(record, "credit_units"),
  };
}

function adminSummary(value: unknown): BillingAdminSummary {
  const record = asObject(value);
  return {
    gross_paid_cny_fen: numberField(record, "gross_paid_cny_fen"),
    total_orders: numberField(record, "total_orders"),
    pending_orders: numberField(record, "pending_orders"),
    paid_orders: numberField(record, "paid_orders"),
    failed_orders: numberField(record, "failed_orders"),
    expired_orders: numberField(record, "expired_orders"),
    wallet_balance_units: numberField(record, "wallet_balance_units"),
    wallet_held_units: numberField(record, "wallet_held_units"),
    wallet_available_units: numberField(record, "wallet_available_units"),
  };
}

function walletSummary(value: unknown): WalletSummary {
  const record = asObject(value);
  return {
    balance_units: numberField(record, "balance_units"),
    held_units: numberField(record, "held_units"),
    available_units: numberField(record, "available_units"),
  };
}

function walletEntryView(value: unknown): WalletEntryView {
  const record = asObject(value);
  return {
    id: stringField(record, "id"),
    amount_units: numberField(record, "amount_units"),
    balance_after_units: numberField(record, "balance_after_units"),
    kind: stringField(record, "kind"),
    source_type: stringField(record, "source_type"),
    source_id: stringField(record, "source_id"),
    created_at: stringField(record, "created_at"),
  };
}

function adminSettings(value: unknown): BillingSettingsView {
  const record = asObject(value);
  return {
    multiplier_bps: numberField(record, "multiplier_bps"),
    version: numberField(record, "version"),
    created_at: stringField(record, "created_at"),
    updated_at: stringField(record, "updated_at"),
  };
}

function adminOrder(value: unknown): PaymentOrderAdminView {
  const record = asObject(value);
  return {
    id: stringField(record, "id"),
    user_id: stringField(record, "user_id"),
    product_id: stringField(record, "product_id"),
    product_title: stringField(record, "product_title"),
    price_cny_fen: numberField(record, "price_cny_fen"),
    credit_units: numberField(record, "credit_units"),
    merchant_order_no_masked: stringField(record, "merchant_order_no_masked"),
    status: statusField(record),
    expires_at: stringField(record, "expires_at"),
    paid_at: nullableStringField(record, "paid_at"),
    created_at: stringField(record, "created_at"),
    updated_at: stringField(record, "updated_at"),
  };
}

function adminWalletEntry(value: unknown): WalletEntryAdminView {
  const record = asObject(value);
  return {
    id: stringField(record, "id"),
    wallet_id: stringField(record, "wallet_id"),
    user_id: stringField(record, "user_id"),
    amount_units: numberField(record, "amount_units"),
    balance_after_units: numberField(record, "balance_after_units"),
    kind: stringField(record, "kind"),
    source_type: stringField(record, "source_type"),
    source_id: stringField(record, "source_id"),
    created_at: stringField(record, "created_at"),
  };
}

function adminUserWallet(value: unknown): AdminUserWalletView {
  const record = asObject(value);
  return {
    id: stringField(record, "id"),
    email: stringField(record, "email"),
    role: stringField(record, "role"),
    status: stringField(record, "status"),
    wallet_id: nullableStringField(record, "wallet_id"),
    balance_units: numberField(record, "balance_units"),
    held_units: numberField(record, "held_units"),
    available_units: numberField(record, "available_units"),
    created_at: stringField(record, "created_at"),
  };
}

function adminReconciliation(value: unknown): BillingReconciliationView {
  const record = asObject(value);
  return {
    id: stringField(record, "id"),
    job_id: stringField(record, "job_id"),
    kind: stringField(record, "kind"),
    status: stringField(record, "status") === "resolved" ? "resolved" : "open",
    attempts: numberField(record, "attempts"),
    last_error_code: nullableStringField(record, "last_error_code"),
    next_retry_at: nullableStringField(record, "next_retry_at"),
    created_at: stringField(record, "created_at"),
    updated_at: stringField(record, "updated_at"),
  };
}

export async function getWallet(): Promise<WalletSummary> {
  return walletSummary(await authRequest("/api/wallet"));
}

export async function listWalletEntries(limit = 50, offset = 0): Promise<WalletEntryView[]> {
  return asArray(await authRequest(`/api/wallet/entries?limit=${limit}&offset=${offset}`))
    .map(walletEntryView);
}

export async function listTopupProducts(): Promise<TopupProductView[]> {
  return asArray(await authRequest("/api/topup-products")).map(topupProduct);
}

export async function createPaymentOrder(
  source: { amount_cny_fen: number } | { product_id: string },
): Promise<PaymentGatewayAction> {
  const response = asObject(await authRequest("/api/payment-orders", {
    method: "POST",
    body: postBody(source),
  }));
  const orderSource = response.order ?? response;
  return {
    order: paymentOrderView(orderSource),
    action_url: stringField(response, "action_url"),
    form_fields: recordOfStrings(response.form_fields ?? response.form),
  };
}

export async function listPaymentOrders(
  query: PaymentOrderListQuery = {},
): Promise<PaymentOrderView[]> {
  const params = new URLSearchParams({
    limit: String(query.limit ?? 20),
    offset: String(query.offset ?? 0),
  });
  const search = query.search?.trim();
  if (search) params.set("search", search);
  if (query.status && query.status !== "all") params.set("status", query.status);
  return asArray(await authRequest(`/api/payment-orders?${params.toString()}`))
    .map(paymentOrderView);
}

export async function getPaymentOrder(orderId: string): Promise<PaymentOrderView> {
  return paymentOrderView(
    await authRequest(`/api/payment-orders/${encodeURIComponent(orderId)}`),
  );
}

export async function getBillingAdmin(): Promise<BillingAdminSnapshot> {
  const [
    summary,
    settings,
    users,
    orders,
    walletEntries,
    reconciliations,
  ] = await Promise.all([
    authRequest("/api/admin/billing/summary"),
    authRequest("/api/admin/billing/settings"),
    authRequest("/api/admin/users?limit=100"),
    authRequest("/api/admin/payment-orders?limit=50"),
    authRequest("/api/admin/wallet-entries?limit=50"),
    authRequest("/api/admin/billing-reconciliations?limit=50"),
  ]);

  return {
    summary: adminSummary(summary),
    settings: adminSettings(settings),
    users: asArray(users).map(adminUserWallet),
    orders: asArray(orders).map(adminOrder),
    wallet_entries: asArray(walletEntries).map(adminWalletEntry),
    reconciliations: asArray(reconciliations).map(adminReconciliation),
  };
}

export async function listAdminOrders(
  query: PaymentOrderListQuery = {},
): Promise<PaymentOrderAdminView[]> {
  const params = new URLSearchParams({
    limit: String(query.limit ?? 50),
    offset: String(query.offset ?? 0),
  });
  const search = query.search?.trim();
  if (search) params.set("search", search);
  if (query.status && query.status !== "all") params.set("status", query.status);
  return asArray(await authRequest(`/api/admin/payment-orders?${params.toString()}`))
    .map(adminOrder);
}

export async function listAdminUsers(search = ""): Promise<AdminUserWalletView[]> {
  const params = new URLSearchParams({ limit: "100" });
  const normalizedSearch = search.trim();
  if (normalizedSearch) params.set("search", normalizedSearch);
  return asArray(await authRequest(`/api/admin/users?${params.toString()}`))
    .map(adminUserWallet);
}

export async function adjustUserBalance(
  userId: string,
  payload: AdjustUserBalanceRequest,
): Promise<UserBalanceAdjustmentView> {
  const response = asObject(await authRequest(
    `/api/admin/users/${encodeURIComponent(userId)}/balance-adjustments`,
    {
      method: "POST",
      body: postBody(payload),
    },
  ));
  return {
    ...adminUserWallet(response),
    entry_id: stringField(response, "entry_id"),
    adjustment_amount_units: numberField(response, "adjustment_amount_units"),
  };
}

export async function updateMultiplier(
  payload: UpdateMultiplierRequest,
): Promise<BillingSettingsView> {
  return adminSettings(await authRequest("/api/admin/billing/settings", {
    method: "PUT",
    body: postBody(payload),
  }));
}

export async function retryReconciliation(
  reconciliationId: string,
  reason: string,
): Promise<ReconciliationRetryResponse> {
  return asObject(await authRequest(
    `/api/admin/billing-reconciliations/${encodeURIComponent(reconciliationId)}/retry`,
    { method: "POST", body: postBody({ reason }) },
  )) as unknown as ReconciliationRetryResponse;
}
