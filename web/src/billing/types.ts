export type PaymentOrderStatus = "pending" | "paid" | "expired" | "failed";

export interface WalletSummary {
  balance_units: number;
  held_units: number;
  available_units: number;
}

export interface WalletEntryView {
  id: string;
  amount_units: number;
  balance_after_units: number;
  kind: string;
  source_type: string;
  source_id: string;
  created_at: string;
}

export interface TopupProductView {
  id: string;
  title: string;
  price_cny_fen: number;
  credit_units: number;
  active: boolean;
}

export interface PaymentOrderView {
  id: string;
  merchant_order_masked: string;
  product_title: string;
  amount_cny_fen: number;
  credit_units: number;
  status: PaymentOrderStatus;
  created_at: string;
}

export interface PaymentGatewayAction {
  order: PaymentOrderView;
  action_url: string;
  form_fields: Record<string, string>;
}

export interface BillingSettingsView {
  multiplier_bps: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface TopupProductAdminView {
  id: string;
  title: string;
  price_cny_fen: number;
  credit_units: number;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface PaymentOrderAdminView {
  id: string;
  user_id: string;
  product_id: string;
  product_title: string;
  price_cny_fen: number;
  credit_units: number;
  merchant_order_no_masked: string;
  status: PaymentOrderStatus;
  expires_at: string;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WalletEntryAdminView {
  id: string;
  wallet_id: string;
  user_id: string;
  amount_units: number;
  balance_after_units: number;
  kind: string;
  source_type: string;
  source_id: string;
  created_at: string;
}

export interface BillingReconciliationView {
  id: string;
  job_id: string;
  kind: string;
  status: "open" | "resolved";
  attempts: number;
  last_error_code: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingAdminSnapshot {
  settings: BillingSettingsView;
  products: TopupProductAdminView[];
  orders: PaymentOrderAdminView[];
  wallet_entries: WalletEntryAdminView[];
  reconciliations: BillingReconciliationView[];
}

export interface UpdateMultiplierRequest {
  multiplier_bps: number;
  reason: string;
}

export interface CreateTopupProductRequest {
  id: string;
  title: string;
  price_cny_fen: number;
  credit_units: number;
  enabled: boolean;
  sort_order: number;
  reason: string;
}

export interface UpdateTopupProductRequest {
  title?: string;
  price_cny_fen?: number;
  credit_units?: number;
  enabled?: boolean;
  sort_order?: number;
  reason: string;
}

export interface DeleteTopupProductResponse {
  id: string;
  deleted: boolean;
  enabled: boolean;
}

export interface ReconciliationRetryResponse {
  id: string;
  status: "open";
  next_retry_at: string;
}
