# Session 3: OpenMontage Billing Frontend Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans task-by-task. Use superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before reporting success. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver authenticated wallet, orders, and administrator billing pages; integrate account/balance actions, breadcrumbs, modal focus, and payment-required recovery into the existing shell; remove browser provider-key configuration.

**Architecture:** A typed `billing` client consumes Session 2 APIs through the existing authenticated/CSRF transport. Route pages own billing presentation and commands; the shell receives account and balance actions without provider credentials. Payment gateway submission uses a transient HTTPS form containing only server-signed fields, and payment return pages poll server state rather than crediting locally.

**Tech Stack:** React 18, TypeScript 5.6, React Router 6, Vitest, Testing Library, Vite 5, Lucide React.

## Global Constraints

- Repository: `C:\Users\zhuba\Desktop\OpenMontage\videro` on `main`.
- Read `AGENTS.md`, `AGENT_GUIDE.md`, and `PROJECT_CONTEXT.md` before editing.
- Session 2 must be complete: admin billing endpoints exist and backend tests are green. If not, stop without changing shared frontend files.
- Preserve pre-existing dirty files and stage only files named by each task.
- Use the existing design tokens, shell patterns, i18n structure, React Router, and Lucide icons.
- Do not add a state-management, request, form, or validation dependency.
- Browser runtime must never receive or display provider tokens, merchant secrets, quote IDs, billing fingerprints, provider references, or result locators/hashes.
- Do not locally credit a wallet from payment return data. Only a verified server notification may credit it.
- Keep project creation, import/export, storyboard, resources, production, and LocalDB behavior unchanged.

## Start Gate

- [ ] **Step 1: Verify backend and merged auth prerequisites**

```powershell
Test-Path server/app/admin/billing_router.py
Test-Path server/tests/test_billing_admin.py
rg -n 'require_admin|/api/admin/billing/settings|/api/admin/topup-products|/api/admin/billing-reconciliations' server/app/admin server/app/main.py
rg -n 'RequireAuth|useAuth|/login|/register' web/src
$env:AUTH_HMAC_SECRET='test-auth-hmac-secret-at-least-32-bytes'
python -m pytest server/tests/test_billing_admin.py -q
```

Expected: files and routes exist, auth runtime exists, and tests PASS. Otherwise stop and report the failed prerequisite.

- [ ] **Step 2: Record current frontend baseline**

```powershell
git status --short --branch
Set-Location web
npm.cmd test -- --run
npm.cmd run build
```

Expected: existing frontend tests and build pass before shared-file edits. Record exact totals.

### Task 1: Typed Billing Client

**Files:**
- Create: `web/src/billing/types.ts`
- Create: `web/src/billing/api.ts`
- Create: `web/src/billing/api.test.ts`
- Create: `web/src/billing/BillingProvider.tsx`
- Create: `web/src/billing/BillingProvider.test.tsx`
- Modify: `web/src/api/client.ts`

**Interfaces:**
- Produces: `getWallet`, `listWalletEntries`, `listTopupProducts`, `createPaymentOrder`, `getPaymentOrder`, `getBillingAdmin`, `updateMultiplier`, `createTopupProduct`, `updateTopupProduct`, `deleteTopupProduct`, `retryReconciliation`, `BillingProvider`, and `useBilling`.
- Consumes: existing credentialed API/CSRF behavior; Session 2 response fields only.

- [ ] **Step 1: Define exact browser-safe DTOs**

```ts
export interface WalletSummary {
  balance_units: number;
  held_units: number;
  available_units: number;
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
  status: "pending" | "paid" | "expired" | "failed";
  created_at: string;
}

export interface PaymentGatewayAction {
  order: PaymentOrderView;
  action_url: string;
  form_fields: Record<string, string>;
}
```

Admin DTOs contain display state only. Do not define sensitive internal fields even as optional properties.

- [ ] **Step 2: Write failing transport tests**

```ts
it("creates an order from a product id with authenticated CSRF transport", async () => {
  mockJson({ order: orderFixture, action_url: "https://pay.example/submit.php", form_fields: { pid: "1", sign: "signed" } });
  await createPaymentOrder("prod10");
  expect(authRequest).toHaveBeenCalledWith("/api/payment-orders", {
    method: "POST",
    body: { product_id: "prod10" },
  });
});

it("does not accept internal billing fields in browser DTO fixtures", () => {
  expect(JSON.stringify(adminFixture)).not.toMatch(/quote_id|billing_fingerprint|provider_reference|result_locator|token_key/i);
});
```

- [ ] **Step 3: Verify RED and implement minimal client**

```powershell
npm.cmd test -- --run src/billing/api.test.ts
```

Expected before implementation: FAIL because module exports are absent. Implement using the existing `authRequest` helper, `credentials: "include"`, and CSRF behavior; do not create a second fetch stack. `BillingProvider` loads the wallet only for an authenticated user, exposes `{ wallet, loading, error, refreshWallet }`, clears state on logout, and coalesces concurrent refresh calls.

- [ ] **Step 4: Verify and commit**

```powershell
npm.cmd test -- --run src/billing/api.test.ts src/billing/BillingProvider.test.tsx src/api/client.test.ts src/auth/AuthProvider.test.tsx
Set-Location ..
git add web/src/billing web/src/api/client.ts
git commit -m "feat(web): add typed billing client"
```

### Task 2: Wallet And Orders Pages

**Files:**
- Create: `web/src/pages/WalletPage.tsx`
- Create: `web/src/pages/WalletPage.test.tsx`
- Create: `web/src/pages/OrdersPage.tsx`
- Create: `web/src/pages/OrdersPage.test.tsx`
- Modify: `web/src/i18n.ts`

**Interfaces:**
- Produces: user wallet summary, products, order history, HTTPS payment form submission, and server-authoritative return polling.

- [ ] **Step 1: Write failing wallet interaction tests**

```tsx
it("creates an order and submits only the returned signed form", async () => {
  mockWalletApi({ balance_units: 1000, held_units: 200, available_units: 800 });
  mockProducts([{ id: "prod10", title: "10元额度", price_cny_fen: 1000, credit_units: 10_000_000, active: true }]);
  mockCreateOrder({ order: orderFixture, action_url: "https://pay.example/submit.php", form_fields: { pid: "1", sign: "signed" } });
  renderWallet();
  await userEvent.click(await screen.findByRole("button", { name: "支付宝充值 10元额度" }));
  expect(createPaymentOrder).toHaveBeenCalledWith("prod10");
  expect(submitGatewayForm).toHaveBeenCalledWith("https://pay.example/submit.php", { pid: "1", sign: "signed" });
});

it("renders holds separately and never credits from return query", async () => {
  renderWallet("/wallet?payment=success&order_id=o1");
  expect(await screen.findByText("预计最多消耗")).toBeVisible();
  expect(getPaymentOrder).toHaveBeenCalledWith("o1");
  expect(screen.getByText("余额以服务器订单状态为准")).toBeVisible();
});
```

- [ ] **Step 2: Implement secure gateway submission**

```ts
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
```

Do not log `fields`. Disable repeat submission while order creation is pending.

- [ ] **Step 3: Implement pages and verify**

Wallet displays balance, active holds as `预计最多消耗`, available balance, products, recharge status, and links to orders. Orders display status, product snapshot, amount, masked merchant order, and timestamp.

```powershell
npm.cmd test -- --run src/pages/WalletPage.test.tsx src/pages/OrdersPage.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Commit**

```powershell
Set-Location ..
git add web/src/pages/WalletPage.tsx web/src/pages/WalletPage.test.tsx web/src/pages/OrdersPage.tsx web/src/pages/OrdersPage.test.tsx web/src/i18n.ts
git commit -m "feat(web): add wallet and order pages"
```

### Task 3: Administrator Billing Page

**Files:**
- Create: `web/src/pages/admin/BillingAdminPage.tsx`
- Create: `web/src/pages/admin/BillingAdminPage.test.tsx`
- Modify: `web/src/billing/api.ts`
- Modify: `web/src/billing/types.ts`

**Interfaces:**
- Produces: multiplier editor, product management, order/reconciliation views, and retry command.

- [ ] **Step 1: Write failing role and command tests**

Test that normal users cannot see admin navigation, a `1.500` input sends `15000`, reason is required, values outside `1.000` through `10.000` are rejected, and retry calls only the reconciliation retry API.

```tsx
await userEvent.clear(screen.getByLabelText("计费倍率"));
await userEvent.type(screen.getByLabelText("计费倍率"), "1.800");
await userEvent.type(screen.getByLabelText("调整原因"), "成本复核");
await userEvent.click(screen.getByRole("button", { name: "保存倍率" }));
expect(updateMultiplier).toHaveBeenCalledWith({ multiplier_bps: 18000, reason: "成本复核" });
```

- [ ] **Step 2: Implement bounded decimal conversion**

Use string parsing, not floating-point multiplication:

```ts
export function multiplierTextToBps(value: string): number | null {
  const match = /^(\d{1,2})(?:\.(\d{1,4}))?$/.exec(value.trim());
  if (!match) return null;
  const bps = Number(match[1]) * 10_000 + Number((match[2] ?? "").padEnd(4, "0"));
  return bps >= 10_000 && bps <= 100_000 ? bps : null;
}
```

- [ ] **Step 3: Verify and commit**

```powershell
npm.cmd test -- --run src/pages/admin/BillingAdminPage.test.tsx src/billing/api.test.ts
Set-Location ..
git add web/src/pages/admin web/src/billing
git commit -m "feat(web): add billing administration"
```

### Task 4: Protected Routes, Shell Actions, And Provider-Key Removal

**Files:**
- Modify: `web/src/app/routes.ts`
- Modify: `web/src/app/AppRoutes.tsx`
- Modify: `web/src/app/AppRoutes.test.tsx`
- Create: `web/src/auth/RequireAdmin.tsx`
- Create: `web/src/auth/RequireAdmin.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/components/shell/AppShell.tsx`
- Modify: `web/src/components/shell/AppShell.test.tsx`
- Delete: `web/src/components/shell/ProviderDrawer.tsx`
- Delete: `web/src/components/KeyGate.tsx`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/domain/types.ts`

**Interfaces:**
- Produces: `/wallet`, `/orders`, `/admin/billing`; application-mounted `BillingProvider`; wallet and account shell actions; no browser provider configuration.

- [ ] **Step 1: Add failing route and shell tests**

Assert anonymous wallet/order/admin deep links redirect to login with return URL, users access wallet/orders but not admin, admins access billing admin, recharge action navigates to `/wallet`, and no `接口配置` or API-key input exists.

- [ ] **Step 2: Add the administrator guard and routes**

Create `RequireAdmin` from `useAuth()`: show the existing auth loading state while loading, preserve the requested URL when anonymous, render a 403/not-authorized surface for authenticated non-admin users, and render `children` only for `user.role === "admin"`. Use `RequireAuth` for wallet/orders and `RequireAdmin` for `/admin/billing`. Do not mount workbench providers around public login/register pages if current composition already avoids it.

Mount one `BillingProvider` inside `AuthProvider` and outside authenticated billing/workbench consumers. Do not mount a second provider per page; Session 6 will move this existing provider into `AppComposition` without changing its public contract.

- [ ] **Step 3: Remove provider credentials end-to-end**

Remove `ProviderDrawer`, `KeyGate`, browser key fields, key-bearing API request properties, and local persistence. Server-selected models remain normal non-secret request inputs where supported.

- [ ] **Step 4: Verify no runtime match and commit**

```powershell
npm.cmd test -- --run src/auth/RequireAdmin.test.tsx src/app/AppRoutes.test.tsx src/App.test.tsx src/components/shell/AppShell.test.tsx
rg -n 'ProviderDrawer|KeyGate|text_key|image_key|video_key|API Key|NewAPI Token' src
```

Expected: tests PASS; no production runtime matches. Rejection/migration tests may mention legacy field names.

```powershell
Set-Location ..
git add web/src/app web/src/auth/RequireAdmin.tsx web/src/auth/RequireAdmin.test.tsx web/src/App.tsx web/src/App.test.tsx web/src/components/shell web/src/api/client.ts web/src/domain/types.ts
git add -u web/src/components/shell/ProviderDrawer.tsx web/src/components/KeyGate.tsx
git commit -m "feat(web): integrate authenticated billing routes"
```

### Task 5: Breadcrumbs And Modal Focus

**Files:**
- Create: `web/src/components/accessibility/useModalFocus.ts`
- Create: `web/src/components/accessibility/useModalFocus.test.tsx`
- Modify: `web/src/components/shell/AppShell.tsx`
- Modify: `web/src/components/shell/AppShell.test.tsx`
- Modify: `web/src/pages/StoryboardPage.tsx`
- Modify: `web/src/pages/StoryboardPage.test.tsx`
- Modify: `web/src/pages/ResourceLibraryPage.tsx`
- Modify: `web/src/pages/ResourceLibraryPage.test.tsx`
- Modify: `web/src/styles/shell.css`

**Interfaces:**
- Produces: `useModalFocus<T>()` and route-derived workbench breadcrumb.

- [ ] **Step 1: Write failing breadcrumb and focus-cycle tests**

```tsx
expect(screen.getByRole("navigation", { name: "面包屑" })).toHaveTextContent(
  "项目列表Pending Relatives分镜编辑",
);
await userEvent.tab();
expect(document.activeElement).toBe(firstFocusableElement);
await userEvent.tab({ shift: true });
expect(document.activeElement).toBe(lastFocusableElement);
```

- [ ] **Step 2: Implement the focus contract**

```ts
export interface ModalFocusOptions {
  open: boolean;
  onEscape: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function useModalFocus<T extends HTMLElement>(options: ModalFocusOptions): {
  panelRef: RefObject<T | null>;
  onKeyDown: KeyboardEventHandler<T>;
}
```

Trap enabled visible links/buttons/inputs/selects/textareas and nonnegative tab indices; wrap Tab/Shift+Tab, close on Escape, focus first on open, and restore opener on close/unmount.

- [ ] **Step 3: Add route-derived breadcrumb and apply focus hook**

Map workbench path to `分镜编辑`, `全局设定`, `资源库`, or `制作与成片`. Preserve account and wallet actions unchanged. Apply focus handling to actual modal drawers only.

- [ ] **Step 4: Verify and commit**

```powershell
npm.cmd test -- --run src/components/accessibility/useModalFocus.test.tsx src/components/shell/AppShell.test.tsx src/pages/StoryboardPage.test.tsx src/pages/ResourceLibraryPage.test.tsx
npm.cmd run build
Set-Location ..
git add web/src/components/accessibility web/src/components/shell/AppShell.tsx web/src/components/shell/AppShell.test.tsx web/src/pages/StoryboardPage.tsx web/src/pages/StoryboardPage.test.tsx web/src/pages/ResourceLibraryPage.tsx web/src/pages/ResourceLibraryPage.test.tsx web/src/styles/shell.css
git commit -m "fix(web): finish shell accessibility contract"
```

### Task 6: Full Frontend Verification And Handoff

- [ ] **Step 1: Run full gates**

```powershell
Set-Location web
npm.cmd test -- --run
npm.cmd run build
rg -n 'ProviderDrawer|KeyGate|text_key|image_key|video_key|sk-[A-Za-z0-9_-]{12,}' src
```

Expected: all tests/build pass and scans have no production secret/key UI matches.

- [ ] **Step 2: Review scoped commits**

```powershell
Set-Location ..
git diff --check HEAD~6..HEAD
git status --short --branch
git log -8 --oneline
```

- [ ] **Step 3: Handoff to Session 4**

Report commit hashes, route matrix, API DTO fields, test/build totals, scan result, and preserved unrelated changes. Session 4 starts only when this plan and Session 1 are green.
