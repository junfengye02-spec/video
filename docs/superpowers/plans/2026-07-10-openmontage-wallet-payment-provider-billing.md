# OpenMontage Wallet Payment And Provider Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenMontage-owned wallet and Alipay recharge flow, size every pre-call wallet hold from NewAPI's authoritative same-route quote, route paid calls through three server-held NewAPI tokens, and charge only from token-scoped final receipts using an administrator-controlled global multiplier.

**Architecture:** OpenMontage owns products, orders, wallet balances, holds, immutable entries, billing jobs, multiplier snapshots, and reconciliation in PostgreSQL. NewAPI owns every model/channel/adapter pricing rule: a quote-only request traverses the real relay path and stops before NewAPI pre-consume or upstream I/O, then the real request reuses that one-time quote. Every upstream call is one billable child with a quote-sized hold, but final settlement ignores the quote and charges only from its token-scoped receipt; a multi-shot render is a non-billable parent batch.

**Tech Stack:** Python 3.10+, FastAPI, SQLAlchemy 2, PostgreSQL 16, Redis 7, psycopg 3, httpx, React 18, TypeScript 5.6, pytest; NewAPI Go 1.22+, Gin, GORM v2, testify, SQLite/MySQL/PostgreSQL-compatible queries.

## Global Constraints

- OpenMontage wallets, payment orders, and users are independent from NewAPI; an OpenMontage recharge never changes NewAPI user quota.
- Reuse the proven 易支付/Alipay protocol and merchant settings, but create and settle OpenMontage orders in OpenMontage PostgreSQL.
- The browser never receives or stores NewAPI tokens, upstream keys, 易支付 merchant secrets, or NewAPI admin access tokens.
- Use three ordinary tokens under the current NewAPI admin account: `openmontage-text-prod`, `openmontage-image-prod`, and `openmontage-video-prod`, each fixed to its intended group and model allowlist.
- Address tokens through server-only stable aliases. Every child snapshots `token_alias`; current and retired alias-to-`SecretStr` keyrings keep the original token available for token-scoped quote/task-result/receipt recovery during rotation without storing keys in PostgreSQL.
- OpenMontage charges `ceil(provider_cost_micro * multiplier_bps / 10_000)`; `multiplier_bps=15000` means `1.5x`.
- Store one global `multiplier_bps`; copy it into every billable child job when the job is created. Later changes affect only new jobs.
- Payment amounts are integer CNY fen; wallet, hold, and charge values are integer `credit_units`; no floating-point money is stored.
- NewAPI quote and receipt snapshots store integer quota, canonical decimal `quota_per_unit`, integer micro-USD, and `pricing_version`; holds and charges use only integer micro-USD, never a floating-point provider cost.
- OpenMontage never stores or evaluates model prices, model ratios, duration factors, resolution factors, tiered expressions, channel mappings, or adapter `OtherRatios` rules.
- Every paid model call freezes `ceil(quote.estimated_cost_amount_micro * multiplier_bps / 10_000)` before the real NewAPI request. Quote failure creates neither child job nor hold nor upstream call.
- Quote-only requests send the real method, route, and logical body with `X-OneAPI-Quote-Only: 1`; real requests send `X-OneAPI-Usage-Quote: <quote_id>`.
- NewAPI quote execution lifetime is 120 seconds. `USAGE_QUOTE_RETENTION_SECONDS=604800` by default and must exceed OpenMontage's configured request/task reference recovery deadline.
- `quote_stale` is returned as HTTP 409 before NewAPI pre-consume or upstream I/O. OpenMontage obtains a fresh quote and transactionally replaces the snapshot/resizes the active hold.
- If fresh quote hold growth cannot be funded, keep the original hold active, set `payment_required_quote`, and make no real NewAPI call until retry or the hold deadline.
- Paid OpenMontage endpoints reject a zero/free or incomplete quote before job/hold/upstream rather than inventing a non-zero price.
- Set `BILLING_REFERENCE_RECOVERY_SECONDS=86400`, `BILLING_RECEIPT_DEADLINE_SECONDS=86400`, `BILLING_HOLD_TIMEOUT_SECONDS=86400`, `BILLING_QUOTE_STALE_RETRIES=2`, and `BILLING_MAX_VIDEO_BYTES=536870912`; mirror reference recovery to NewAPI `USAGE_QUOTE_REFERENCE_RECOVERY_SECONDS`.
- A `generation_job` represents exactly one NewAPI call. Multi-shot render batches are non-billable parents; each generated shot is a billable child with a separate hold and receipt.
- A successful child settles from its own final receipt. A failed child creates no consumption entry and releases only its own hold.
- A settled receipt is stored but cannot debit the wallet or set `result_visible=True` until the corresponding text/image/video result is verified and staged behind the existing backend media/data boundary.
- A synchronous text/image call whose execution reference is missing, malformed, or unavailable after an ambiguous response is not safely deliverable: query quote status to prevent replay, bind any recovered reference for operator accounting, release the hold, charge the user zero, and never expose the response. An asynchronous video call may continue from a recovered public task ID.
- NewAPI video `FAILURE` with a refund log is `refunded`; `FAILURE` without a refund log is `refund_pending`. Both charge the OpenMontage user zero and release the hold immediately.
- NewAPI `tasks.quota` is never treated as a failed-video charge because production data proves refunded failed tasks can retain the original quota.
- Payment callbacks verify signature, merchant order number, provider, Alipay type, trade status, and exact amount before one atomic order-plus-wallet transaction.
- Browser return URLs display status only; only the verified asynchronous notify endpoint credits a wallet.
- All payment, wallet, quote consumption, hold/resize, receipt, callback, polling, and retry operations are idempotent under concurrency and process restart.
- NewAPI changes must use `common.Marshal`/`common.Unmarshal`, support SQLite, MySQL, and PostgreSQL, obey `pkg/billingexpr/expr.md`, and use testify `require`/`assert` in new Go tests.
- NewAPI consume logging must remain enabled and retained longer than the OpenMontage receipt deadline; if it is disabled or unavailable, synchronous receipts cannot settle and OpenMontage releases the hold at timeout rather than charging from an estimate.
- Billing migrations use revisions `010-019` and consume only `CurrentUser`, `require_user`, `require_admin`, `require_csrf`, `UserProvisioner`, and `get_db` from the auth plan.
- Implement directly on each repository's `main` branch as requested. Before every commit, stage only the task's listed paths and preserve all unrelated dirty-worktree changes.
- Execute remaining Tasks 3-13 with `superpowers:subagent-driven-development`: dispatch a fresh subagent on the latest available model for each task, then run independent spec-compliance and code-quality reviews before advancing.
- Wait for both the auth plan and frontend optimization plan before shared integration edits to `server/app/main.py`, `web/src/App.tsx`, shared routes, and shell navigation.

## Cross-Plan Interfaces

```python
from server.app.auth.dependencies import CurrentUser, require_admin, require_csrf, require_user
from server.app.auth.provisioning import UserProvisioner
from server.app.db.session import get_db

class WalletProvisioner(UserProvisioner):
    def provision(self, db: Session, user_id: str) -> None:
        db.add(WalletAccount(id=uuid.uuid4().hex, user_id=user_id, balance_units=0, held_units=0, version=0))
```

The payment branch does not modify password, verification, session, role, or project-ownership internals. Domain work and tests may run in parallel; API wiring and frontend shell changes wait until the auth/frontend branches are merged.

## Current State

- Task 1 is complete on NewAPI `main` through commit `7a4d880d`; its final receipt snapshot fixes were independently reviewed and approved.
- Task 2 is complete on NewAPI `main` at commit `02acd55a`; its token-scoped HTTP/auth contracts were independently reviewed and approved.
- The Task 2 pricing endpoint remains available for NewAPI compatibility/diagnostics, but OpenMontage never calls it for holds or final charges.
- Tasks 3-13 are not implemented by this plan update. Begin execution at Task 3 and do not rewrite or revert Tasks 1-2.

## NewAPI Authoritative Quote And Final Receipt Contracts

Quote the exact request on its real relay route:

```http
POST /v1/videos
Authorization: Bearer <ordinary fixed-group token>
X-OneAPI-Quote-Only: 1
Content-Type: application/json

<the exact logical provider request body>
```

```json
{
  "quote_id": "uq_01J...",
  "status": "quoted",
  "model": "provider-model",
  "fixed_group": "openmontage-video",
  "relay_format": "task",
  "estimated_quota": 1449000,
  "quota_per_unit": 500000,
  "cost_currency": "USD",
  "estimated_cost_amount_micro": 2898000,
  "pricing_version": "sha256:...",
  "other_ratios": {"seconds": 10, "resolution": 1},
  "billing_fingerprint": "sha256:...",
  "expires_at": 1783390000
}
```

Execute with the same logical request and the one-time quote:

```http
POST /v1/videos
Authorization: Bearer <the same ordinary token>
X-OneAPI-Usage-Quote: uq_01J...
Content-Type: application/json

<the same logical provider request body>
```

Any expiry, prior use, token/group/method/route/relay/model/channel mismatch, pricing change, fingerprint change, or quota change returns HTTP 409 with code `quote_stale` before NewAPI pre-consume and before upstream I/O.

Historical quote/reference recovery and final receipts use the same retained-token read-only authentication:

```text
GET /api/usage/quote/{quote_id}
GET /api/usage/receipt/request/{request_id}
GET /api/usage/receipt/task/{task_id}
Authorization: Bearer <the same ordinary token that owns the quote/call>
```

```json
{
  "reference_type": "task",
  "reference_id": "task_xxx",
  "status": "settled",
  "model": "omni_flash-10s",
  "quota": 1449000,
  "refunded_quota": 0,
  "quota_per_unit": 500000,
  "pricing_version": "sha256:...",
  "cost_currency": "USD",
  "cost_amount_micro": 2898000,
  "settled_at": 1783389175
}
```

Allowed receipt statuses are `pending`, `settled`, `refunded`, `refund_pending`, and `not_chargeable`. A reference belonging to another token returns 404 rather than revealing its existence.

Quote status returns only `quote_id`, `status` (`quoted|consuming|accepted|failed|expired`), optional reference type/ID, and `created_at`, `expires_at`, optional `consumed_at`, and `updated_at` Unix timestamps. It never exposes channel identity, token/user identity, request content, pricing expressions, or credentials; a quote owned by another token returns 404.

## File Structure

### NewAPI Repository: `C:\Users\zhuba\Desktop\api\new-api-source-0229dc2`

Create:

- `dto/usage_receipt.go` - token pricing and receipt response structs/status constants.
- `model/usage_receipt.go` - token-scoped log/task/refund lookups.
- `dto/usage_quote.go` - public quote and quote-status response structs.
- `model/usage_quote.go` - persisted quote row plus token-scoped atomic state transitions.
- `model/usage_quote_test.go` - expiry, ownership, one-time consumption, and portable GORM query tests.
- `model/usage_quote_dialect_test.go` - opt-in MySQL/PostgreSQL migration and atomic-transition matrix.
- `service/usage_quote.go` - canonical pricing/fingerprint snapshots and quote validation.
- `service/usage_quote_cleanup.go` - retention-ordered terminal quote cleanup.
- `service/usage_quote_cleanup_test.go` - retention boundary and non-terminal preservation.
- `controller/usage_receipt.go` - read-only pricing/request/task handlers.
- `controller/usage_quote.go` - quote response/status helpers.
- `controller/usage_receipt_test.go` - authorization and residual-quota refund tests.
- `controller/usage_quote_test.go` - quote-only, stale, recovery, and no-upstream tests.
- `relay/usage_quote_test.go` - shared sync/task preparation and adapter fingerprint parity.
- `middleware/usage_quote_rate_limit.go` - apply the existing model-request limiter only when a quote header is present.
- `middleware/usage_quote_rate_limit_test.go` - quote creation/consumption limits without changing unquoted traffic.
- `common/usage_quote_config_test.go` - execution/recovery/retention ordering validation.
- `model/usage_receipt_test.go` - cross-database-safe query behavior on SQLite.

Modify:

- `model/log.go` - indexed `task_id` field and task billing log population.
- `model/main.go` - GORM/ClickHouse log schema migration for `task_id` plus normal/fast `UsageQuote` AutoMigrate.
- `service/task_billing.go` - pass task ID into consume/refund logs.
- `middleware/auth.go` - historical receipt-only authentication for disabled-but-retained tokens.
- `middleware/distributor.go` - token-scoped quoted-channel binding before relay preparation.
- `middleware/distributor_test.go` - quoted-channel binding before selection and no fallback.
- `middleware/auth_test.go` - active-user and disabled-token historical read coverage.
- `controller/relay.go` - synchronous quote preparation/validation and quote state/reference transitions.
- `relay/relay_task.go` - shared task preparation before quote or real submission.
- `relay/image_handler.go` - prevent image count from being charged twice after moving it into pre-consume preparation.
- `relay/helper/price.go` - canonical request multipliers and pricing snapshot data.
- `common/constants.go`, `common/init.go`, and `constant/env.go` - quote header names plus 120-second execution lifetime and validated 7-day retention configuration.
- `main.go` - start terminal quote cleanup on the master node.
- `router/api-router.go` - mount historical quote and receipt endpoints under the correct read-only middleware.
- `router/relay-router.go` and `router/video-router.go` - install conditional quote limiting before distribution on supported relay routes.
- `model/clickhouse_log_test.go` - task ID schema/order compatibility.

### OpenMontage Repository: `C:\Users\zhuba\Desktop\OpenMontage\videro`

Create:

- `server/alembic/versions/010_wallet_payment_tables.py` - wallet, products, orders, entries, and holds.
- `server/alembic/versions/011_billing_job_tables.py` - settings, parent/child jobs, receipts, and reconciliations.
- `server/alembic/versions/012_billing_constraints.py` - partial unique indexes and final billing constraints.
- `server/app/wallet/models.py` - wallet account, entry, and hold ORM models.
- `server/app/wallet/service.py` - atomic credit, hold, release, and charge operations.
- `server/app/wallet/router.py` - user wallet and entry endpoints.
- `server/app/wallet/provisioning.py` - auth registration hook.
- `server/app/payments/models.py` - recharge product/order models.
- `server/app/payments/epay.py` - 易支付 signing, verification, and purchase form builder.
- `server/app/payments/service.py` - order creation and atomic notification settlement.
- `server/app/payments/router.py` - products, orders, notify, and return endpoints.
- `server/app/billing/models.py` - settings, jobs, receipts, and reconciliation models.
- `server/app/billing/bootstrap.py` - first-deployment singleton multiplier initialization from validated settings.
- `server/app/billing/money.py` - integer cost conversion.
- `server/app/billing/service.py` - parent/child job lifecycle and receipt settlement.
- `server/app/billing/reconciliation.py` - retry/timeout/refund reconciliation.
- `server/billing_worker.py` - PostgreSQL-backed reconciliation worker loop.
- `server/app/provider/newapi.py` - current/retired token-alias routing, same-route quote/execute, quote recovery, and receipt client.
- `server/app/provider/image_generation.py` - concrete `/v1/images/generations` request/response adapter with no pricing logic.
- `server/app/admin/billing_router.py` - multiplier, products, orders, entries, and reconciliation admin APIs.
- `server/tests/test_wallet_service.py` - concurrency and idempotency.
- `server/tests/test_epay.py` - signatures, exact amount, callback concurrency, and return behavior.
- `server/tests/test_billing_service.py` - holds, multipliers, parent/child jobs, and settlement.
- `server/tests/test_billing_refunds.py` - failed video, residual quota, delayed refund, and missing receipt.
- `server/tests/test_newapi_client.py` - token routing, quote contracts, stale errors, recovery, and secret redaction.
- `server/tests/test_image_generation.py` - image alias, quote/hold/execute/receipt, and response parsing.
- `server/tests/test_billing_e2e.py` - recharge-to-generation flow.
- `web/src/billing/types.ts` - wallet/order/admin response types.
- `web/src/billing/api.ts` - wallet, order, and admin API client.
- `web/src/pages/WalletPage.tsx` - balance, products, recharge, and entries.
- `web/src/pages/OrdersPage.tsx` - order status history.
- `web/src/pages/admin/BillingAdminPage.tsx` - multiplier/products/reconciliation administration.
- `web/src/pages/WalletPage.test.tsx` - purchase redirect and history UI.
- `web/src/pages/admin/BillingAdminPage.test.tsx` - multiplier audit and retry UI.

Modify after dependency branches merge:

- `requirements.txt` - `httpx` and payment dependencies.
- `.env.example` - NewAPI tokens, 易支付 secrets, multiplier seed, and worker policy names only.
- `server/app/core/config.py` - `SecretStr` provider/payment configuration.
- `server/app/main.py` - install wallet/payment/admin routers and `WalletProvisioner`.
- `server/app/models.py` - remove browser-provided key fields from paid requests.
- `server/app/storyboard_generator.py` - injected text provider call context.
- `server/app/prompt_optimizer.py` - injected text provider call context.
- `server/app/openmontage_runner.py` - one billed child per shot and non-billable render parent.
- `tools/video/syapi_video.py` - preserve task ID on success/failure and accept internal request context without logging secrets.
- `server/tests/test_api.py` - wallet-required paid endpoints and no-key request contracts.
- `server/tests/test_openmontage_runner.py` - multi-shot parent/child behavior.
- `web/src/domain/types.ts` - remove provider credentials from paid requests.
- `web/src/api/client.ts` - add wallet/admin calls and remove key payloads.
- `web/src/app/routes.ts` - wallet/order/admin routes.
- `web/src/App.tsx` - mount pages after frontend optimization merge.
- `web/src/components/shell/AppShell.tsx` - real wallet balance/recharge link; remove provider settings.
- `web/src/components/shell/ProviderDrawer.tsx` - delete after provider settings are server-only.
- `web/src/components/KeyGate.tsx` - delete after provider settings are server-only.
- `web/src/i18n.ts` - wallet, order, billing, and error copy.
- `README.md` - NewAPI token creation, 易支付, worker, rotation, and reconciliation runbook.

---

### Task 1: NewAPI Token-Scoped Receipt Query Model

**Repository:** `C:\Users\zhuba\Desktop\api\new-api-source-0229dc2` on `main`.

**Status:** Complete through `7a4d880d`; do not re-execute.

**Files:**
- Create: `dto/usage_receipt.go`
- Create: `model/usage_receipt.go`
- Create: `model/usage_receipt_test.go`
- Modify: `model/log.go`
- Modify: `model/main.go`
- Modify: `service/task_billing.go`
- Modify: `model/clickhouse_log_test.go`

**Interfaces:**
- Produces: `model.GetRequestUsageReceipt(tokenID int, requestID string)` and `model.GetTaskUsageReceipt(tokenID int, taskID string)`.
- Consumes: existing `Task`, `Log`, `LOG_DB`, `DB`, `common.QuotaPerUnit`, and `common.Unmarshal`.

- [x] **Step 1: Confirm the NewAPI main-branch baseline**

The task was implemented directly on NewAPI `main`. Preserve unrelated dirty-worktree files and verify the receipt commits are ancestors of HEAD.

Expected: `git merge-base --is-ancestor 7a4d880d HEAD` exits 0.

- [x] **Step 2: Write failing residual-quota and token-isolation model tests**

```go
// model/usage_receipt_test.go
func TestTaskReceiptFailureWithRefundIgnoresResidualTaskQuota(t *testing.T) {
	db := setupUsageReceiptTestDB(t)
	task := Task{TaskID: "task_failed", UserId: 10, Quota: 15834000, Status: TaskStatusFailure,
		PrivateData: TaskPrivateData{TokenId: 77}, Properties: Properties{OriginModelName: "omni_flash-10s"}}
	require.NoError(t, db.Create(&task).Error)
	require.NoError(t, LOG_DB.Create(&Log{Type: LogTypeRefund, TokenId: 77, TaskId: task.TaskID, Quota: 15834000}).Error)

	receipt, found, err := GetTaskUsageReceipt(77, task.TaskID)
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, "refunded", receipt.Status)
	assert.Equal(t, 0, receipt.Quota)
	assert.Equal(t, 15834000, receipt.RefundedQuota)
}

func TestTaskReceiptDoesNotRevealAnotherToken(t *testing.T) {
	setupUsageReceiptTestDB(t).Create(&Task{TaskID: "task_private", Status: TaskStatusSuccess,
		PrivateData: TaskPrivateData{TokenId: 77}})
	_, found, err := GetTaskUsageReceipt(88, "task_private")
	require.NoError(t, err)
	assert.False(t, found)
}
```

- [x] **Step 3: Run focused Go tests and confirm missing symbols**

Run: `go test ./model -run 'Test(Task|Request)Receipt' -count=1`

Expected: FAIL because `GetTaskUsageReceipt`, `Log.TaskId`, and receipt types do not exist.

- [x] **Step 4: Implement receipt DTOs, indexed task IDs, and GORM queries**

```go
// dto/usage_receipt.go
package dto

const (
	UsagePending = "pending"
	UsageSettled = "settled"
	UsageRefunded = "refunded"
	UsageRefundPending = "refund_pending"
	UsageNotChargeable = "not_chargeable"
)

type UsageReceipt struct {
	ReferenceType  string  `json:"reference_type"`
	ReferenceID    string  `json:"reference_id"`
	Status         string  `json:"status"`
	Model          string  `json:"model"`
	Quota          int     `json:"quota"`
	RefundedQuota  int     `json:"refunded_quota"`
	QuotaPerUnit   float64 `json:"quota_per_unit"`
	CostCurrency   string  `json:"cost_currency"`
	CostAmountMicro int64  `json:"cost_amount_micro"`
	SettledAt      int64   `json:"settled_at,omitempty"`
}
```

Add `TaskId string` to `model.Log` with `gorm:"type:varchar(191);index:idx_logs_task_id;default:''"`. Set it directly in `RecordTaskBillingLogParams` and every task consume/refund log. Update GORM migration and ClickHouse `logs` DDL with `task_id String DEFAULT ''` and the existing migration style.

`GetTaskUsageReceipt` first queries `Task` by `task_id`, then requires `task.PrivateData.TokenId == tokenID`. It returns:

- non-terminal task: `pending`;
- `SUCCESS`: `settled` with `task.Quota`;
- `FAILURE` and `task.Quota == 0`: `not_chargeable`;
- `FAILURE` and matching refund log: `refunded`, chargeable quota zero;
- `FAILURE` without matching refund log: `refund_pending`, chargeable quota zero.

For pre-column historical logs, query same-token refund rows in the task time window and use `common.Unmarshal` on `Log.Other` to match exact `task_id`; never use raw JSON operators. New logs use the indexed column. `GetRequestUsageReceipt` filters every log by both `token_id` and exact `request_id`: consume is `settled`, full refund is `refunded`, error-only is `not_chargeable`, and no terminal log is `pending`.

- [x] **Step 5: Run model tests and commit**

Run: `go test ./model ./service -run 'Test(Task|Request|ClickHouse).*Receipt|TestClickHouse' -count=1`

Expected: PASS.

```bash
git add dto/usage_receipt.go model/usage_receipt.go model/usage_receipt_test.go model/log.go model/main.go service/task_billing.go model/clickhouse_log_test.go
git commit -m "feat(usage): add token scoped receipt queries"
```

### Task 2: NewAPI Pricing And Receipt HTTP Endpoints

**Repository:** NewAPI `main`.

**Status:** Complete at `02acd55a`; do not re-execute.

**Files:**
- Create: `controller/usage_receipt.go`
- Create: `controller/usage_receipt_test.go`
- Modify: `dto/usage_receipt.go`
- Modify: `middleware/auth.go`
- Modify: `middleware/auth_test.go`
- Modify: `router/api-router.go`

**Interfaces:**
- Consumes: Task 1 query functions, `middleware.TokenAuth`, new `middleware.TokenAuthHistoricalReadOnly`, token ID from Gin context, existing pricing settings.
- Produces: the three `/api/usage/*` contracts used by OpenMontage.

- [x] **Step 1: Write failing handler tests for ownership, refunded failures, and fixed-group pricing**

```go
// controller/usage_receipt_test.go
func TestGetTaskUsageReceiptReturnsZeroForRefundedFailure(t *testing.T) {
	router, token := setupUsageReceiptRouter(t)
	seedFailedRefundedTask(t, token.Id, "task_refunded", 15834000)
	req := httptest.NewRequest(http.MethodGet, "/api/usage/receipt/task/task_refunded", nil)
	req.Header.Set("Authorization", "Bearer sk-"+token.Key)
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	require.Equal(t, http.StatusOK, resp.Code)
	assert.Contains(t, resp.Body.String(), `"status":"refunded"`)
	assert.Contains(t, resp.Body.String(), `"cost_amount_micro":0`)
}

func TestGetReceiptReturns404ForAnotherToken(t *testing.T) {
	router, token := setupUsageReceiptRouter(t)
	seedSuccessfulTask(t, 999, "task_hidden", 100)
	req := httptest.NewRequest(http.MethodGet, "/api/usage/receipt/task/task_hidden", nil)
	req.Header.Set("Authorization", "Bearer sk-"+token.Key)
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	assert.Equal(t, http.StatusNotFound, resp.Code)
}

func TestHistoricalReceiptAllowsDisabledRetainedToken(t *testing.T) {
	router, token := setupUsageReceiptRouter(t)
	token.Status = common.TokenStatusDisabled
	require.NoError(t, model.DB.Save(token).Error)
	seedSuccessfulTask(t, token.Id, "task_history", 500000)
	req := httptest.NewRequest(http.MethodGet, "/api/usage/receipt/task/task_history", nil)
	req.Header.Set("Authorization", "Bearer sk-"+token.Key)
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	assert.Equal(t, http.StatusOK, resp.Code)

	pricingReq := httptest.NewRequest(http.MethodGet, "/api/usage/pricing/model/omni_flash-10s", nil)
	pricingReq.Header.Set("Authorization", "Bearer sk-"+token.Key)
	pricingResp := httptest.NewRecorder()
	router.ServeHTTP(pricingResp, pricingReq)
	assert.Equal(t, http.StatusUnauthorized, pricingResp.Code)
}
```

- [x] **Step 2: Run handler tests and confirm 404/unregistered routes**

Run: `go test ./controller -run 'TestGet.*UsageReceipt|TestGetTokenModelPricing' -count=1`

Expected: FAIL because handlers/routes are absent.

- [x] **Step 3: Implement handlers and integer micro-USD conversion**

```go
// controller/usage_receipt.go
func GetTaskUsageReceipt(c *gin.Context) {
	tokenID := c.GetInt("token_id")
	receipt, found, err := model.GetTaskUsageReceipt(tokenID, c.Param("task_id"))
	if err != nil { common.ApiError(c, err); return }
	if !found { c.Status(http.StatusNotFound); return }
	receipt.QuotaPerUnit = common.QuotaPerUnit
	receipt.CostCurrency = "USD"
	receipt.CostAmountMicro = quotaToMicroUSD(receipt.Quota, common.QuotaPerUnit)
	c.JSON(http.StatusOK, receipt)
}

func quotaToMicroUSD(quota int, quotaPerUnit float64) int64 {
	if quota <= 0 || quotaPerUnit <= 0 { return 0 }
	return decimal.NewFromInt(int64(quota)).Mul(decimal.NewFromInt(1_000_000)).
		Div(decimal.NewFromFloat(quotaPerUnit)).Ceil().IntPart()
}
```

`GetTokenModelPricing` loads the authenticated token by context token ID, requires a non-empty fixed group other than `auto`, verifies the path model is included when `ModelLimitsEnabled` is true, finds the exact model in `model.GetPricing()`, computes that token group's ratio using existing ratio settings, and returns `estimable=false` for missing pricing or unsupported `tiered_expr`. It returns only model, fixed group, quota type, model ratio/price, completion ratio, group ratio, `quota_per_unit`, and `pricing_version`; it never returns user, key, channel, or other tokens.

Add `TokenAuthHistoricalReadOnly()` by extracting the existing read-only token loader with an `allowDisabled` option. It still requires the token row to exist and its owner to be active, but permits disabled, expired, or exhausted retained tokens only on the two historical receipt routes. The pricing endpoint uses standard `TokenAuth()` and therefore requires a currently usable fixed-group token. A deleted token cannot query anything.

- [x] **Step 4: Mount routes under existing read-only token middleware and verify**

```go
// router/api-router.go inside usageRoute
pricingRoute := usageRoute.Group("")
pricingRoute.Use(middleware.TokenAuth())
pricingRoute.GET("/pricing/model/:model", controller.GetTokenModelPricing)
receiptRoute := usageRoute.Group("")
receiptRoute.Use(middleware.TokenAuthHistoricalReadOnly())
receiptRoute.GET("/receipt/request/:request_id", controller.GetRequestUsageReceipt)
receiptRoute.GET("/receipt/task/:task_id", controller.GetTaskUsageReceipt)
```

Run: `go test ./controller ./router ./model ./service -count=1`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add controller/usage_receipt.go controller/usage_receipt_test.go dto/usage_receipt.go middleware/auth.go middleware/auth_test.go router/api-router.go
git commit -m "feat(usage): expose token scoped cost receipts"
```

### Task 3: NewAPI Same-Route Usage Quote Lifecycle

**Repository:** `C:\Users\zhuba\Desktop\api\new-api-source-0229dc2` on `main`.

**Files:**
- Create: `dto/usage_quote.go`
- Create: `model/usage_quote.go`
- Create: `model/usage_quote_test.go`
- Create: `model/usage_quote_dialect_test.go`
- Create: `service/usage_quote.go`
- Create: `service/usage_quote_cleanup.go`
- Create: `service/usage_quote_cleanup_test.go`
- Create: `controller/usage_quote.go`
- Create: `controller/usage_quote_test.go`
- Create: `relay/usage_quote_test.go`
- Create: `middleware/usage_quote_rate_limit.go`
- Create: `middleware/usage_quote_rate_limit_test.go`
- Create: `common/usage_quote_config_test.go`
- Modify: `common/constants.go`
- Modify: `common/init.go`
- Modify: `constant/env.go`
- Modify: `model/main.go`
- Modify: `middleware/distributor.go`
- Modify: `middleware/distributor_test.go`
- Modify: `controller/relay.go`
- Modify: `relay/relay_task.go`
- Modify: `relay/image_handler.go`
- Modify: `relay/helper/price.go`
- Modify: `router/api-router.go`
- Modify: `router/relay-router.go`
- Modify: `router/video-router.go`
- Modify: `main.go`

**Interfaces:**
- Consumes: Task 2 `TokenAuthHistoricalReadOnly`, existing `TokenAuth`/`Distribute`, `GetAndValidateRequest`, `GenRelayInfo`, `ModelPriceHelper`, `ModelPriceHelperPerCall`, task adapter `EstimateBilling`, `PreConsumeBilling`, and the request ID middleware.
- Produces: headers `X-OneAPI-Quote-Only` and `X-OneAPI-Usage-Quote`; `dto.UsageQuoteResponse`; `dto.UsageQuoteStatusResponse`; `common.ValidateUsageQuoteConfig`; `model.GetUsageQuoteForToken`; `model.TryConsumeUsageQuote`; `service.IssueUsageQuote`; `service.ValidateAndConsumeUsageQuote`; and `GET /api/usage/quote/:quote_id`.

**Execution rule:** Task 3 is a protocol umbrella, not one subagent assignment. Checkpoints 3A-3D each get a fresh latest-model subagent, focused RED/GREEN command, separate commit, and independent spec/quality review before the next checkpoint.

#### Checkpoint 3A: Persistence And Atomic State

- [ ] **Step 1: Write failing persisted-state, ownership, expiry, and one-time-consumption tests**

```go
// model/usage_quote_test.go
func TestUsageQuoteCanBeConsumedExactlyOnce(t *testing.T) {
	db := setupUsageQuoteDB(t)
	quote := seedUsageQuote(t, db, 77, "uq_once", time.Now().Add(120*time.Second).Unix())

	var succeeded atomic.Int32
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			consumed, err := TryConsumeUsageQuote(quote.QuoteID, 77, time.Now().Unix(), "req_once", "request", "req_once")
			if err != nil {
				errs <- err
				return
			}
			if consumed {
				succeeded.Add(1)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	assert.Equal(t, int32(1), succeeded.Load())
}

func TestUsageQuoteLookupHidesAnotherTokenAndExpiresOldQuote(t *testing.T) {
	db := setupUsageQuoteDB(t)
	seedUsageQuote(t, db, 77, "uq_private", time.Now().Add(-time.Second).Unix())
	_, found, err := GetUsageQuoteForToken(88, "uq_private", time.Now().Unix())
	require.NoError(t, err)
	assert.False(t, found)
	quote, found, err := GetUsageQuoteForToken(77, "uq_private", time.Now().Unix())
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, UsageQuoteExpired, quote.State)
}

func TestUsageQuotePersistsAcrossDatabaseReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "quotes.db")
	first := openUsageQuoteSQLite(t, path)
	seedUsageQuote(t, first, 77, "uq_restart", time.Now().Add(120*time.Second).Unix())
	closeUsageQuoteDB(t, first)
	second := openUsageQuoteSQLite(t, path)
	setUsageQuoteTestDB(t, second)
	quote, found, err := GetUsageQuoteForToken(77, "uq_restart", time.Now().Unix())
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, UsageQuoteQuoted, quote.State)
}

func TestUsageQuoteTwoDatabaseHandlesConsumeOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "multi-instance.db")
	first, second := openUsageQuoteSQLite(t, path), openUsageQuoteSQLite(t, path)
	seedUsageQuote(t, first, 77, "uq_multi", time.Now().Add(120*time.Second).Unix())
	results := runConcurrentQuoteConsume(
		func() (bool, error) { return tryConsumeUsageQuote(first, "uq_multi", 77, time.Now().Unix(), "req_1", "request", "req_1") },
		func() (bool, error) { return tryConsumeUsageQuote(second, "uq_multi", 77, time.Now().Unix(), "req_2", "request", "req_2") },
	)
	assert.Equal(t, []bool{false, true}, sortedBools(results))
}

// model/usage_quote_dialect_test.go
func TestUsageQuoteDialectIntegration(t *testing.T) {
	dialect, dsn := os.Getenv("USAGE_QUOTE_TEST_DIALECT"), os.Getenv("USAGE_QUOTE_TEST_DSN")
	if dialect == "" || dsn == "" {
		t.Skip("set usage quote dialect test environment")
	}
	db := openUsageQuoteDialect(t, dialect, dsn)
	require.NoError(t, db.AutoMigrate(&UsageQuote{}))
	runUsageQuoteAtomicOwnershipExpirySuite(t, db)
}
```

- [ ] **Step 2: Run the quote model tests and confirm the model/API do not exist**

Run: `go test ./model -run TestUsageQuote -count=1`

Expected: FAIL because `UsageQuote`, `TryConsumeUsageQuote`, and `GetUsageQuoteForToken` do not exist.

- [ ] **Step 3: Add the portable quote model, DTOs, migration, and exact lifetime configuration**

```go
// model/usage_quote.go
const (
	UsageQuoteQuoted    = "quoted"
	UsageQuoteConsuming = "consuming"
	UsageQuoteAccepted  = "accepted"
	UsageQuoteFailed    = "failed"
	UsageQuoteExpired   = "expired"
)

type UsageQuote struct {
	QuoteID                 string `gorm:"type:varchar(64);primaryKey"`
	TokenID                 int    `gorm:"index;not null"`
	FixedGroup              string `gorm:"type:varchar(64);not null"`
	Method                  string `gorm:"type:varchar(16);not null"`
	RouteFamily             string `gorm:"type:varchar(128);not null"`
	RelayFormat             string `gorm:"type:varchar(32);not null"`
	Model                   string `gorm:"type:varchar(191);not null"`
	ChannelID               int    `gorm:"not null"`
	EstimatedQuota          int64  `gorm:"not null"`
	QuotaPerUnit            string `gorm:"type:varchar(64);not null"`
	EstimatedCostAmountMicro int64 `gorm:"not null"`
	PricingVersion          string `gorm:"type:varchar(80);not null"`
	OtherRatiosJSON         string `gorm:"type:text;not null"`
	BillingFingerprint      string `gorm:"type:varchar(80);not null"`
	State                   string `gorm:"type:varchar(16);index;not null"`
	RequestID               string `gorm:"type:varchar(191);index"`
	ReferenceType           string `gorm:"type:varchar(16)"`
	ReferenceID             string `gorm:"type:varchar(191);index"`
	CreatedAt               int64  `gorm:"not null"`
	ExpiresAt               int64  `gorm:"index;not null"`
	ConsumedAt              int64
	UpdatedAt               int64  `gorm:"index;not null"`
}

// common/usage_quote_config_test.go
func TestUsageQuoteRetentionMustExceedRecovery(t *testing.T) {
	assert.Error(t, ValidateUsageQuoteConfig(120, 86400, 86400))
	assert.NoError(t, ValidateUsageQuoteConfig(120, 86400, 604800))
}
```

`TryConsumeUsageQuote` wraps an internal `tryConsumeUsageQuote(db *gorm.DB, ...)` so file-backed two-handle and external-dialect tests exercise the same query. It requires a non-empty local request reference for synchronous relays or pre-generated public task reference for task relays, then performs one conditional `UPDATE ... WHERE quote_id=? AND token_id=? AND state='quoted' AND expires_at>?` and sets `consuming`, request/reference data, `consumed_at`, and `updated_at`; affected rows must equal one. `GetUsageQuoteForToken` always filters both IDs, maps an expired `quoted` row to persisted `expired`, and never falls back to an unscoped query. `MarkUsageQuoteAccepted` and `MarkUsageQuoteFailed` require `state='consuming'`. Quote issuance rejects an empty or `auto` token group; the persisted `fixed_group` is the authenticated token's effective fixed group, never a body-provided override. Use only GORM expressions that work on SQLite, MySQL, and PostgreSQL.

Add `&UsageQuote{}` to both normal and fast `model/main.go` migrations. Persist quota-per-unit as `strconv.FormatFloat(common.QuotaPerUnit, 'f', -1, 64)` so the database snapshot is canonical and portable; `dto.UsageQuoteResponse` remains `float64` on the wire to match the already-shipped receipt DTO, and OpenMontage parses it as `Decimal` for audit only. Set `constant.UsageQuoteExecutionSeconds=120`, `constant.UsageQuoteRetentionSeconds=common.GetEnvOrDefault("USAGE_QUOTE_RETENTION_SECONDS", 604800)`, and `constant.UsageQuoteReferenceRecoverySeconds=common.GetEnvOrDefault("USAGE_QUOTE_REFERENCE_RECOVERY_SECONDS", 86400)`; call `common.ValidateUsageQuoteConfig(execution, recovery, retention)` from startup and fail unless retention is greater than both execution lifetime and reference recovery. Deployment sets `USAGE_QUOTE_REFERENCE_RECOVERY_SECONDS` equal to OpenMontage `BILLING_REFERENCE_RECOVERY_SECONDS`.

Run: `go test ./model ./common -run 'TestUsageQuote|TestInit.*UsageQuote' -count=1`

Expected: PASS, including the conditional-update concurrency test and invalid-retention startup test.

```bash
git add common/init.go common/usage_quote_config_test.go constant/env.go dto/usage_quote.go model/main.go model/usage_quote.go model/usage_quote_test.go model/usage_quote_dialect_test.go
git commit -m "feat(usage): persist one-time usage quotes"
```

#### Checkpoints 3B-3D: Focused Relay Contract RED Passes

Execute Step 4 as three reviewed RED passes rather than one batch: 3B writes/runs only canonical snapshot plus synchronous/image tests; 3C writes/runs only task-adapter, channel-binding, stale, and concurrency tests; 3D writes/runs only recovery/status, redaction, rate-limit, and cleanup tests. Do not begin a GREEN checkpoint while an earlier focused RED command fails for an unexpected reason.

- [ ] **Step 4: Write failing same-route quote, stale, image-count, task-adapter, and recovery tests**

```go
// relay/usage_quote_test.go
func TestQuotePricingSnapshotCoversAllPriceDataDeterminants(t *testing.T) {
	price := types.PriceData{
		FreeModel: true, UsePrice: true, ModelPrice: 1.2, ModelRatio: 2.3,
		CompletionRatio: 3.4, CacheRatio: 0.5, CacheCreationRatio: 1.6,
		CacheCreation5mRatio: 1.7, CacheCreation1hRatio: 1.8,
		ImageRatio: 1.9, AudioRatio: 2.0, AudioCompletionRatio: 2.1,
		GroupRatioInfo: types.GroupRatioInfo{
			GroupRatio: 2.2, GroupSpecialRatio: 2.3, HasSpecialRatio: true,
		},
	}
	snapshot := service.NewQuotePricingSnapshot(price, "v1", "sha256:tier", "500000.5")
	assert.True(t, snapshot.FreeModel)
	assert.Equal(t, 1.7, snapshot.CacheCreation5mRatio)
	assert.Equal(t, 1.8, snapshot.CacheCreation1hRatio)
	assert.Equal(t, 2.3, snapshot.GroupSpecialRatio)
	assert.True(t, snapshot.HasSpecialGroupRatio)
}

// controller/usage_quote_test.go
func TestQuoteOnlyUsesRelayBillingWithoutPreConsumeOrUpstream(t *testing.T) {
	router, token, upstream := setupQuotedRelayRouter(t)
	beforeQuota := token.RemainQuota
	req := newJSONRequest(http.MethodPost, "/v1/videos", `{"model":"video-model","seconds":10,"size":"1080p"}`)
	req.Header.Set("Authorization", "Bearer sk-"+token.Key)
	req.Header.Set("X-OneAPI-Quote-Only", "1")
	resp := httptest.NewRecorder()
	router.ServeHTTP(resp, req)
	require.Equal(t, http.StatusOK, resp.Code)
	var quote dto.UsageQuoteResponse
	require.NoError(t, common.Unmarshal(resp.Body.Bytes(), &quote))
	assert.Equal(t, beforeQuota, reloadToken(t, token.Id).RemainQuota)
	assert.Equal(t, int32(0), upstream.Calls.Load())
	assert.Equal(t, int64(1), countUsageQuotes(t, token.Id))
	assert.Equal(t, int64(0), countConsumeLogs(t, token.Id))
}

func TestQuotedRequestRejectsPricingChangeBeforeBillingOrUpstream(t *testing.T) {
	router, token, upstream := setupQuotedRelayRouter(t)
	quote := createQuote(t, router, token, "/v1/chat/completions", chatBody("priced-model"))
	setModelRatio(t, "priced-model", 2.0)
	resp := executeQuote(t, router, token, quote.QuoteID, "/v1/chat/completions", chatBody("priced-model"))
	assert.Equal(t, http.StatusConflict, resp.Code)
	assert.Contains(t, resp.Body.String(), `"code":"quote_stale"`)
	assert.Equal(t, int32(0), upstream.Calls.Load())
	assert.Equal(t, int64(0), countConsumeLogs(t, token.Id))
}

func TestImageQuoteIncludesNExactlyOnce(t *testing.T) {
	quote := quoteImage(t, `{"model":"image-model","prompt":"x","n":3}`)
	assert.Equal(t, int64(3*baseImageQuota(t)), quote.EstimatedQuota)
	result := executeImageQuote(t, quote)
	assert.Equal(t, quote.EstimatedQuota, result.PreConsumedQuota)
}

func TestAcceptedTaskReferenceIsRecoverableByOwningToken(t *testing.T) {
	quote, taskID := executeAcceptedTaskAndDropClientResponse(t)
	status := getQuoteStatus(t, quote.TokenKey, quote.QuoteID)
	assert.Equal(t, "accepted", status.Status)
	assert.Equal(t, "task", status.ReferenceType)
	assert.Equal(t, taskID, status.ReferenceID)
	assert.Equal(t, http.StatusNotFound, getQuoteStatusCode(t, anotherTokenKey(t), quote.QuoteID))
}

func TestAcceptedSyncReferenceSurvivesDroppedResponse(t *testing.T) {
	quote, requestID := executeAcceptedSyncAndDropClientResponse(t)
	status := getQuoteStatus(t, quote.TokenKey, quote.QuoteID)
	assert.Equal(t, "accepted", status.Status)
	assert.Equal(t, "request", status.ReferenceType)
	assert.Equal(t, requestID, status.ReferenceID)
}

func TestCrossTokenCannotConsumeQuote(t *testing.T) {
	router, owner, attacker, upstream := setupTwoTokenQuotedRelayRouter(t)
	quote := createQuote(t, router, owner, "/v1/chat/completions", chatBody("priced-model"))
	resp := executeQuote(t, router, attacker, quote.QuoteID,
		"/v1/chat/completions", chatBody("priced-model"))
	assert.Equal(t, http.StatusConflict, resp.Code)
	assert.Contains(t, resp.Body.String(), `"code":"quote_stale"`)
	assert.Equal(t, UsageQuoteQuoted, loadUsageQuote(t, quote.QuoteID).State)
	assert.Equal(t, int32(0), upstream.Calls.Load())
}

func TestQuotePersistenceResponseAndAuditContainNoSecrets(t *testing.T) {
	quote, row, responseBody, auditText := createQuoteWithKnownSecrets(t)
	rowJSON, err := common.Marshal(row)
	require.NoError(t, err)
	for _, secret := range []string{"owner-token-fixture", "upstream-secret", "raw prompt"} {
		assert.NotContains(t, string(rowJSON), secret)
		assert.NotContains(t, string(responseBody), secret)
		assert.NotContains(t, auditText, secret)
	}
	assert.NotContains(t, string(responseBody), "channel_id")
	assert.NotContains(t, auditText, quote.QuoteID)
}
```

Add explicitly named tests `TestTaskQuoteAdapterParity`, `TestQuotedChannelNoFallback`, `TestUsageQuoteConcurrentConsume`, `TestUsageQuoteStatusExactKeys`, `TestUsageQuoteRateLimit`, `TestUsageQuoteCleanupBoundaries`, and `TestQuoteHeadersValidation`. Table-drive fixed group, method, route family, relay format, model, channel, tiered inputs, token bounds, count/size/quality/duration/resolution, every registered adapter `EstimateBilling`, quota-per-unit, and normalized determinant changes. Every stale case asserts zero upstream/log/pre-consume; eight real requests yield one consumer/upstream. Dual/invalid headers are 400. Quote create/consume each hit existing limits while unquoted task traffic is unchanged. Decode responses to exact key allowlists and inspect persisted rows/audits for absence of keys, user identity, channel identity, prompt/body/media, expressions, and header values.

Run 3B RED: `go test ./controller ./relay -run 'Test(QuotePricingSnapshot|QuoteOnly|QuotedRequest|ImageQuote|AcceptedSync)' -count=1`

Run 3C RED: `go test ./controller ./relay ./middleware -run 'Test(TaskQuote|AcceptedTask|CrossToken|QuotedChannel|UsageQuoteConcurrent)' -count=1`

Run 3D RED: `go test ./controller ./service ./middleware -run 'Test(UsageQuoteStatus|QuotePersistence|UsageQuoteRate|UsageQuoteCleanup|QuoteHeaders)' -count=1`

Expected: each focused command FAIL only for its missing checkpoint behavior; unrelated existing tests remain green.

#### Checkpoint 3B: Canonical Snapshots And Synchronous/Image Relay GREEN

- [ ] **Step 5: Implement canonical billing snapshots**

```go
// service/usage_quote.go
type QuotePricingSnapshot struct {
	EngineVersion        string
	FreeModel            bool
	UsePrice             bool
	ModelPrice           float64
	ModelRatio           float64
	CompletionRatio      float64
	CacheRatio           float64
	CacheCreationRatio   float64
	CacheCreation5mRatio float64
	CacheCreation1hRatio float64
	ImageRatio           float64
	AudioRatio           float64
	AudioCompletionRatio float64
	GroupRatio           float64
	GroupSpecialRatio    float64
	HasSpecialGroupRatio bool
	TieredExprHash       string
	QuotaPerUnit         string
}

type QuoteFactor struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type QuoteRatio struct {
	Name  string  `json:"name"`
	Value float64 `json:"value"`
}

type QuoteBillingDeterminants struct {
	PromptTokens    int
	MaxOutputTokens int
	RequestFactors  []QuoteFactor
	OtherRatios     []QuoteRatio
}

type QuoteBillingInput struct {
	TokenID            int
	FixedGroup         string
	Method             string
	RouteFamily        string
	RelayFormat        string
	Model              string
	ChannelID          int
	EstimatedQuota     int64
	QuotaPerUnit       string
	PricingSnapshot    QuotePricingSnapshot
	BillingDeterminants QuoteBillingDeterminants
}

func IssueUsageQuote(input QuoteBillingInput, now time.Time) (*dto.UsageQuoteResponse, error)
func ValidateAndConsumeUsageQuote(quoteID string, input QuoteBillingInput, requestID, referenceType, referenceID string, now time.Time) error

func NewQuotePricingSnapshot(price types.PriceData, engineVersion, tieredExprHash, quotaPerUnit string) QuotePricingSnapshot {
	return QuotePricingSnapshot{
		EngineVersion: engineVersion, FreeModel: price.FreeModel, UsePrice: price.UsePrice,
		ModelPrice: price.ModelPrice, ModelRatio: price.ModelRatio,
		CompletionRatio: price.CompletionRatio, CacheRatio: price.CacheRatio,
		CacheCreationRatio: price.CacheCreationRatio,
		CacheCreation5mRatio: price.CacheCreation5mRatio,
		CacheCreation1hRatio: price.CacheCreation1hRatio,
		ImageRatio: price.ImageRatio, AudioRatio: price.AudioRatio,
		AudioCompletionRatio: price.AudioCompletionRatio,
		GroupRatio: price.GroupRatioInfo.GroupRatio,
		GroupSpecialRatio: price.GroupRatioInfo.GroupSpecialRatio,
		HasSpecialGroupRatio: price.GroupRatioInfo.HasSpecialRatio,
		TieredExprHash: tieredExprHash, QuotaPerUnit: quotaPerUnit,
	}
}
```

Build every snapshot through `NewQuotePricingSnapshot`; its explicit field mapping must stay in parity with every billing-relevant exported field of `types.PriceData`, and `relay/usage_quote_test.go` fails if `FreeModel`, either cache-creation duration ratio, special group ratio, or any other mapped field changes between quote and real preparation. Canonicalize `PricingSnapshot` and `BillingDeterminants` with structs; convert factor/ratio maps to name-sorted `[]QuoteFactor`/`[]QuoteRatio` before `common.Marshal`, use that one ratio list for both fingerprint/storage and the response map, and never concatenate strings. `pricing_version` is `sha256:` plus the SHA-256 of NewAPI engine version, the complete pricing snapshot, tiered-expression hash, `quota_per_unit`, and all adapter pricing output used by the existing engine. This quote version is a live snapshot hash and is not the static `model.PricingVersion` schema marker already present on historical receipts. `billing_fingerprint` hashes token/group, method, normalized route family, relay format, model, channel, prompt/max-output token bounds, validated request count/size/quality/duration/resolution, canonical `OtherRatios`, the pricing version, and final pre-consume quota. Compute `estimated_cost_amount_micro` inside NewAPI as `ceil(estimated_quota * 1_000_000 / quota_per_unit)` with `shopspring/decimal`, matching the receipt conversion; OpenMontage never repeats this conversion. Persist only hashes and normalized non-secret metadata, never raw prompt/body/media, token/channel keys, user identity, or an expression body.

Run: `go test ./relay ./service -run 'Test(QuotePricingSnapshot|QuoteBillingFingerprint|QuoteCostAmount)' -count=1`

Expected: PASS.

- [ ] **Step 6: Implement synchronous and image quote preparation**

Add `helper.ApplyPreConsumeRequestRatios(request dto.Request, priceData *types.PriceData) error`; for a validated image request it applies `n` before both quote issuance and `PreConsumeBilling` with `common.QuotaFromFloatChecked`. Keep `relay/image_handler.go`'s `HasOtherRatio("n")` guard so response handling cannot apply it twice. The synchronous controller runs existing request validation, token estimation, `ModelPriceHelper`, and request-ratio application before either issuing a quote or validating/consuming one; sync consumption stores request ID as `request_id`, `reference_type=request`, and `reference_id` before upstream.

Run: `go test ./controller ./relay -run 'Test(QuoteOnly|QuotedRequest|ImageQuote|AcceptedSync)' -count=1`

Expected: PASS with identical quote/real fingerprint/quota, one image count multiplier, and zero quote-only billing/upstream effects.

```bash
git add common/constants.go controller/relay.go controller/usage_quote.go controller/usage_quote_test.go relay/helper/price.go relay/image_handler.go relay/usage_quote_test.go service/usage_quote.go
git commit -m "feat(usage): quote synchronous relay billing"
```

#### Checkpoint 3C: Task Preparation And Quoted Channel GREEN

- [ ] **Step 7: Refactor task submission without duplicating adapter rules**

Refactor task submission without duplicating adapter rules:

```go
type TaskSubmitPreparation struct {
	Adaptor channel.TaskAdaptor
	Platform constant.TaskPlatform
	QuoteInput service.QuoteBillingInput
}

func PrepareTaskSubmit(c *gin.Context, info *relaycommon.RelayInfo) (*TaskSubmitPreparation, *dto.TaskError)
func SubmitPreparedTask(c *gin.Context, info *relaycommon.RelayInfo, prepared *TaskSubmitPreparation) (*TaskSubmitResult, *dto.TaskError)
```

`PrepareTaskSubmit` performs channel/adaptor initialization, validation/normalization, model mapping, `ModelPriceHelperPerCall`, adapter `EstimateBilling`, validated `OtherRatios`, and saturation-safe quota conversion. It performs no pre-consume, upstream request-body construction, or upstream I/O. Quote-only returns immediately after `IssueUsageQuote`. Real requests call `ValidateAndConsumeUsageQuote` before `PreConsumeBilling`; only `SubmitPreparedTask` calls `BuildRequestBody` and upstream methods. The synchronous controller uses the same ordering after `GetAndValidateRequest`, token estimation, `ModelPriceHelper`, and request-ratio application.

Run: `go test ./relay -run 'Test(TaskQuote|TaskAdapterQuote|AcceptedTask)' -count=1`

Expected: PASS for every registered task adapter with no quote-only upstream body/I/O.

- [ ] **Step 8: Bind the quoted channel and enforce one-time no-fallback execution**

At the start of `middleware.Distribute`, before affinity or random channel selection, if `X-OneAPI-Usage-Quote` is present, load it by authenticated token ID, verify its method/normalized route family is eligible, and force its stored channel through the existing `SetupContextForSelectedChannel` path. Store the quote on Gin context for later full validation; never put channel ID in a public response. A quoted real request disables cross-channel retry/fallback in both synchronous and task retry loops; an upstream/channel failure is returned against that one consumed quote. Quote-only uses ordinary channel selection. A missing/cross-token/expired/used quote on a real request returns the uniform HTTP 409 `quote_stale` response.

For a real synchronous request, record `X-Oneapi-Request-Id` in the atomic `quoted -> consuming` update as all three of `request_id`, `reference_type=request`, and `reference_id=<the same request ID>` before NewAPI pre-consume/upstream. For a real task request, generate `PublicTaskID` during preparation and atomically store it as `reference_type=task` before pre-consume/upstream. Mark `accepted` after upstream acceptance (and task insertion for tasks). Mark `failed` only for a definitive local failure before any upstream request bytes are sent; a timeout/disconnect after send begins remains `consuming` so callers recover the reference and never replay blindly. Quote-only never creates a billing session, consume log, request/task row, or upstream call.

Run: `go test ./middleware ./relay ./controller -run 'Test(QuotedChannel|CrossToken|UsageQuoteConcurrent|AcceptedTask)' -count=1`

Expected: PASS with quoted channel selection before affinity/random choice, no cross-channel fallback, and exactly one consumer/upstream call.

```bash
git add controller/relay.go middleware/distributor.go middleware/distributor_test.go relay/relay_task.go relay/usage_quote_test.go service/usage_quote.go
git commit -m "feat(usage): quote task relay billing"
```

#### Checkpoint 3D: Status, Security, Rate Limits, And Cleanup GREEN

- [ ] **Step 9: Implement historical status, secret-safe auditing, rate limits, and retention cleanup**

```go
func GetUsageQuoteStatus(c *gin.Context)
func UsageQuoteRateLimit() gin.HandlerFunc
func CleanupUsageQuotes(now int64, retentionSeconds int64) (expired int64, deletedTerminal int64, deletedIndeterminate int64, err error)
```

Mount `GET /api/usage/quote/:quote_id` under `TokenAuthHistoricalReadOnly` and the usage route's existing critical limiter. Return only `dto.UsageQuoteStatusResponse`; another token gets 404. Relay groups already using `ModelRequestRateLimit` need no new middleware because quote and real calls traverse it. Add `UsageQuoteRateLimit` before `Distribute` only to quote-capable task/video groups that lack that limiter; it delegates to the existing model-request limiter when either quote header is present, so both creation and consumption are bounded without double-counting existing `/v1` relay traffic or changing unquoted task traffic.

Start master-node cleanup with three ordered, portable GORM operations: persist every `quoted` row whose `expires_at <= now` as `expired`; delete `failed`, `accepted`, or `expired` rows whose `updated_at <= now-retention`; delete an indeterminate `consuming` row only when `consumed_at <= now-retention`, without first changing it to replay-permitting `failed`. `service/usage_quote_cleanup_test.go` freezes time on both sides of each exact boundary and proves fresh quoted/terminal/consuming rows remain, expired quoted rows transition, old terminal rows disappear, and old consuming rows disappear only after retention. Audit header mode/state/error code without logging either header value.

Run: `go test ./controller ./service ./middleware ./router -run 'Test(UsageQuoteStatus|QuotePersistence|UsageQuoteRate|UsageQuoteCleanup|QuoteHeaders)' -count=1`

Expected: PASS with exact response allowlists, no secret-bearing storage/logs, bounded quote traffic, and no unbounded quote rows.

```bash
git add controller/usage_quote.go controller/usage_quote_test.go main.go middleware/usage_quote_rate_limit.go middleware/usage_quote_rate_limit_test.go router/api-router.go router/relay-router.go router/video-router.go service/usage_quote_cleanup.go service/usage_quote_cleanup_test.go
git commit -m "feat(usage): recover and retain usage quotes"
```

- [ ] **Step 10: Run the complete NewAPI suite**

Run: `go test ./controller ./model ./service ./middleware ./relay ./router -count=1`

Run: `go test ./... -count=1`

Expected: all tests PASS with no SQLite-specific SQL and no changes to existing unquoted relay behavior.

### Task 4: OpenMontage Wallet, Payment, And Billing Schema

**Repository:** OpenMontage `main`; begin only after the auth plan's project ownership schema is present.

**Files:**
- Create: `server/app/wallet/models.py`
- Create: `server/app/wallet/provisioning.py`
- Create: `server/app/payments/models.py`
- Create: `server/app/billing/models.py`
- Create: `server/app/billing/bootstrap.py`
- Create: `server/alembic/versions/010_wallet_payment_tables.py`
- Create: `server/alembic/versions/011_billing_job_tables.py`
- Create: `server/alembic/versions/012_billing_constraints.py`
- Test: `server/tests/test_billing_models.py`

**Interfaces:**
- Consumes: auth `Base`, `UserProvisioner`, users/projects foreign keys.
- Produces: all wallet/payment/billing ORM models, migration revisions `010-012`, and `WalletProvisioner`.

- [ ] **Step 1: Write model constraint tests**

```python
# server/tests/test_billing_models.py
def test_wallet_and_provider_references_are_unique(db_session, user):
    db_session.add(WalletAccount(id="w1", user_id=user.id, balance_units=0, held_units=0, version=0))
    db_session.commit()
    db_session.add(WalletAccount(id="w2", user_id=user.id, balance_units=0, held_units=0, version=0))
    with pytest.raises(IntegrityError):
        db_session.commit()


def test_parent_job_has_no_hold_or_provider_reference(db_session, project, user):
    parent = GenerationJob.parent(id="p1", user_id=user.id, project_id=project.id, operation="render")
    db_session.add(parent)
    db_session.commit()
    assert parent.chargeable is False
    assert parent.parent_job_id is None
    assert parent.provider_reference_id is None
    assert parent.quote_id is None
    parent.status = "partial_failure"
    db_session.commit()
    assert parent.status == "partial_failure"


def test_chargeable_child_requires_complete_quote_snapshot(db_session, project, user):
    child = GenerationJob(
        id="c1", user_id=user.id, project_id=project.id, chargeable=True,
        token_kind="video", token_alias="video-v1", model="video-model", multiplier_bps=15_000,
        quote_id="uq_1", quote_expires_at=utcnow() + timedelta(seconds=120),
        quote_estimated_quota=1_449_000, quote_estimated_provider_cost_micro=2_898_000,
        quote_quota_per_unit=Decimal("500000"), quote_pricing_version="sha256:p",
        quote_other_ratios_json='{"seconds":10}', quote_billing_fingerprint="sha256:f",
        status="reserved", result_visible=False,
    )
    db_session.add(child)
    db_session.commit()
    assert child.quote_billing_fingerprint == "sha256:f"
```

- [ ] **Step 2: Run model tests and confirm models are missing**

Run: `python -m pytest server/tests/test_billing_models.py -v`

Expected: FAIL with missing wallet/payment/billing modules.

- [ ] **Step 3: Implement exact integer models and constraints**

`WalletAccount` has unique `user_id`, `balance_units >= 0`, `held_units >= 0`, `held_units <= balance_units`, and optimistic `version`. `WalletEntry` has signed `amount_units`, balance-after snapshot, kind, source type/ID, unique `idempotency_key`, and no update path. `WalletHold` has unique `job_id`, positive amount, state `active|released|captured`, timestamps, and reason.

`PaymentOrder` snapshots product ID/title, `price_cny_fen`, `credit_units`, unique merchant order number, provider `epay`, method `alipay`, state, unique non-null provider trade number, and timestamps. `TopupProduct` stores integer price/credits and enabled/sort fields.

`GenerationJob` includes `parent_job_id`, `chargeable`, user/project, operation/capability, token kind, stable server-side `token_alias`, model, `multiplier_bps`, provider method/route, provider reference type/ID, `reference_deadline`, `receipt_deadline`, status, backend-only `result_locator`, `result_sha256`, `result_staged`, result visibility, and timestamps. A chargeable child also stores `quote_id`, `quote_expires_at`, `quote_estimated_quota`, `quote_estimated_provider_cost_micro`, exact-decimal `quote_quota_per_unit`, `quote_pricing_version`, canonical `quote_other_ratios_json`, and `quote_billing_fingerprint`. It stores no model price, duration/resolution factor, tiered expression, channel ID, prompt/body/media, or token key. The status constraint includes child states `reserved`, `submitted_ambiguous`, `reference_recovery_pending`, `payment_required_quote`, `provider_pricing_unstable_no_charge`, `provider_quote_rate_limited_no_charge`, `provider_pricing_unavailable_no_charge`, `provider_not_submitted_no_charge`, `provider_rejected_no_charge`, `provider_reference_missing_no_charge`, `provider_result_missing_no_charge`, `result_pending`, `receipt_pending`, `receipt_missing_no_charge`, `payment_required`, `failed_no_charge`, and `billed`, plus parent-only `running`, `complete`, `partial_failure`, and `failed`. A check constraint prevents chargeable children from using parent-only states and parents from using child-only states; another requires `result_visible` to imply `result_staged`, non-null result metadata, and `status='billed'`. Enforce PostgreSQL partial unique indexes on non-null `(provider_reference_type, provider_reference_id, token_alias)` and `(quote_id, token_alias)`. `CostReceipt` stores the full normalized receipt plus raw canonical JSON/hash. `BillingSetting` is singleton ID 1. `BillingReconciliation` stores reason, status, job ID, attempts, next retry, and last error.

- [ ] **Step 4: Add migrations and verify against PostgreSQL**

Revision `010` creates wallet/payment tables. Revision `011` creates billing tables, the parent/child FK, and quote snapshot columns. Revision `012` adds PostgreSQL partial unique indexes and check constraints: parent jobs have all quote/hold/reference fields null, while chargeable children require a complete positive quote snapshot before hold creation. Migrations never read deployment environment variables and contain no merchant/token secret. `ensure_billing_settings(db, settings)` requires `BILLING_DEFAULT_MULTIPLIER_BPS` on first deployment, inserts singleton row ID 1 once, and never overwrites an administrator-updated row; the deployment example uses `15000`. Products are created explicitly through the administrator API, so migrations do not invent prices or credits.

Run: `python -m alembic upgrade 012`

Run: `python -m pytest server/tests/test_billing_models.py -v`

Expected: migrations succeed and tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app/wallet/models.py server/app/wallet/provisioning.py server/app/payments/models.py server/app/billing/models.py server/app/billing/bootstrap.py server/alembic/versions/010_wallet_payment_tables.py server/alembic/versions/011_billing_job_tables.py server/alembic/versions/012_billing_constraints.py server/tests/test_billing_models.py
git commit -m "feat(billing): add wallet and billing schema"
```

### Task 5: Atomic Wallet Credits, Holds, Releases, And Charges

**Files:**
- Create: `server/app/wallet/service.py`
- Create: `server/tests/test_wallet_service.py`
- Modify: `server/app/wallet/provisioning.py`

**Interfaces:**
- Consumes: Task 4 models and a caller-owned SQLAlchemy transaction.
- Produces: `credit`, `create_hold`, `resize_active_hold`, `release_hold`, `capture_hold`, `available_units`, and `WalletProvisioner.provision`.

- [ ] **Step 1: Write wallet idempotency and concurrency tests**

```python
# server/tests/test_wallet_service.py
def test_duplicate_credit_is_applied_once(db_session, wallet):
    credit(db_session, wallet.user_id, 100_000, kind="topup", source_id="o1", idempotency_key="topup:o1")
    credit(db_session, wallet.user_id, 100_000, kind="topup", source_id="o1", idempotency_key="topup:o1")
    db_session.commit()
    db_session.refresh(wallet)
    assert wallet.balance_units == 100_000
    assert count_entries(db_session, "topup:o1") == 1


def test_two_holds_cannot_overbook_one_balance(postgres_sessions, funded_wallet):
    results = run_concurrently(postgres_sessions, lambda db, job: try_create_hold(db, funded_wallet.user_id, job, 80_000))
    assert sorted(results) == [False, True]
    assert load_wallet(postgres_sessions[0], funded_wallet.user_id).held_units == 80_000


def test_duplicate_same_job_hold_returns_existing_without_rechecking_its_own_funds(db_session, funded_wallet, child_job):
    first = create_hold(db_session, user_id=funded_wallet.user_id, job_id=child_job.id,
                        amount_units=80_000, expires_at=utcnow() + timedelta(hours=1))
    second = create_hold(db_session, user_id=funded_wallet.user_id, job_id=child_job.id,
                         amount_units=80_000, expires_at=utcnow() + timedelta(hours=1))
    assert second.id == first.id
    assert load_wallet(db_session, funded_wallet.user_id).held_units == 80_000


def test_concurrent_same_job_creates_one_hold(postgres_sessions, funded_wallet, child_job):
    holds = run_concurrently(
        postgres_sessions,
        lambda db: create_hold(db, user_id=funded_wallet.user_id, job_id=child_job.id,
                               amount_units=80_000, expires_at=utcnow() + timedelta(hours=1)),
        count=8,
    )
    assert len({hold.id for hold in holds}) == 1
    assert load_wallet(postgres_sessions[0], funded_wallet.user_id).held_units == 80_000


def test_failed_job_release_is_idempotent(db_session, active_hold):
    release_hold(db_session, active_hold.job_id, reason="provider_failed")
    release_hold(db_session, active_hold.job_id, reason="provider_failed")
    db_session.commit()
    assert load_wallet(db_session, active_hold.user_id).held_units == 0


def test_resize_hold_changes_only_the_locked_delta(db_session, active_hold):
    assert resize_active_hold(db_session, job_id=active_hold.job_id, amount_units=120_000) == "resized"
    assert load_wallet(db_session, active_hold.user_id).held_units == 120_000
    assert resize_active_hold(db_session, job_id=active_hold.job_id, amount_units=90_000) == "resized"
    assert load_wallet(db_session, active_hold.user_id).held_units == 90_000


def test_resize_hold_insufficient_keeps_original_hold(db_session, active_hold):
    original = active_hold.amount_units
    assert resize_active_hold(db_session, job_id=active_hold.job_id, amount_units=10_000_000) == "insufficient_funds"
    db_session.refresh(active_hold)
    assert active_hold.status == "active"
    assert active_hold.amount_units == original
```

- [ ] **Step 2: Run wallet tests and confirm service imports fail**

Run: `python -m pytest server/tests/test_wallet_service.py -v`

Expected: FAIL because wallet service functions do not exist.

- [ ] **Step 3: Implement row-locked integer wallet operations**

```python
# server/app/wallet/service.py
def create_hold(db: Session, *, user_id: str, job_id: str, amount_units: int, expires_at: datetime) -> WalletHold:
    if amount_units <= 0:
        raise ValueError("hold must be positive")
    job = db.scalar(select(GenerationJob).where(GenerationJob.id == job_id).with_for_update())
    if job is None or job.user_id != user_id:
        raise InvalidHoldOwner
    existing = db.scalar(select(WalletHold).where(WalletHold.job_id == job_id).with_for_update())
    if existing is not None:
        if (existing.user_id == user_id and existing.status == "active"
                and existing.amount_units == amount_units):
            return existing
        raise HoldConflict
    wallet = db.scalar(select(WalletAccount).where(WalletAccount.user_id == user_id).with_for_update())
    if wallet is None or wallet.balance_units - wallet.held_units < amount_units:
        raise InsufficientBalance
    wallet.held_units += amount_units
    wallet.version += 1
    hold = WalletHold(id=uuid.uuid4().hex, user_id=user_id, job_id=job_id,
                      amount_units=amount_units, status="active", expires_at=expires_at)
    db.add(hold)
    db.flush()
    return hold


def resize_active_hold(db: Session, *, job_id: str, amount_units: int) -> Literal["resized", "insufficient_funds"]:
    job = db.scalar(select(GenerationJob).where(GenerationJob.id == job_id).with_for_update())
    hold = db.scalar(select(WalletHold).where(WalletHold.job_id == job_id).with_for_update())
    wallet = db.scalar(select(WalletAccount).where(WalletAccount.user_id == job.user_id).with_for_update())
    if hold.status != "active" or amount_units <= 0:
        raise InvalidHoldState
    delta = amount_units - hold.amount_units
    if delta > wallet.balance_units - wallet.held_units:
        return "insufficient_funds"
    hold.amount_units = amount_units
    wallet.held_units += delta
    wallet.version += 1
    db.flush()
    return "resized"
```

`credit` catches the unique idempotency entry inside the same transaction and returns the existing entry without applying balance again. Every mutator uses the global lock order job, hold, wallet. Concurrent resizes serialize; only the locked delta changes `held_units`. `capture_hold` releases held units, deducts the final charge, inserts `consume:{job_id}`, and never allows negative balance. When a final receipt charge exceeds the hold and available funds are insufficient, it leaves the original hold active and returns `payment_required` without creating a consumption entry.

- [ ] **Step 4: Run SQLite unit tests and PostgreSQL concurrency tests**

Run: `python -m pytest server/tests/test_wallet_service.py -v`

Expected: PASS; exactly one concurrent overbooking attempt succeeds.

- [ ] **Step 5: Commit**

```bash
git add server/app/wallet/service.py server/app/wallet/provisioning.py server/tests/test_wallet_service.py
git commit -m "feat(wallet): add atomic holds and entries"
```

### Task 6: 易支付 Alipay Orders And Idempotent Notify Settlement

**Files:**
- Create: `server/app/payments/epay.py`
- Create: `server/app/payments/service.py`
- Create: `server/app/payments/router.py`
- Create: `server/app/wallet/router.py`
- Create: `server/tests/test_epay.py`
- Modify: `server/app/core/config.py`
- Modify: `.env.example`

**Interfaces:**
- Consumes: auth dependencies, wallet `credit`, payment models, and the proven local NewAPI EPay protocol in `C:\Users\zhuba\Desktop\api\new-api-source-0229dc2\controller\topup.go`, `model\topup.go`, and `setting\operation_setting\payment_setting_old.go`.
- Produces: product/order/wallet APIs and verified `/api/payments/epay/notify` GET/POST.

- [ ] **Step 1: Write signature, tamper, return-only, and duplicate notify tests**

```python
# server/tests/test_epay.py
def test_epay_signature_matches_sorted_nonempty_fields():
    fields = {"pid": "1001", "type": "alipay", "out_trade_no": "OM123", "money": "10.00", "name": "Credits"}
    assert sign_epay(fields, "merchant-secret") == "e4c7381e349055c6089e2fd57942886a"


def test_notify_rejects_amount_tampering(client, pending_order, epay_signed_params):
    params = epay_signed_params(pending_order, money="0.01")
    response = client.post("/api/payments/epay/notify", data=params)
    assert response.text == "fail"
    assert wallet_balance(pending_order.user_id) == 0


def test_browser_return_never_credits_wallet(client, pending_order, epay_signed_params):
    response = client.get("/api/payments/epay/return", params=epay_signed_params(pending_order), follow_redirects=False)
    assert response.status_code == 302
    assert wallet_balance(pending_order.user_id) == 0


def test_duplicate_concurrent_notify_credits_once(postgres_client, pending_order, epay_signed_params):
    responses = post_concurrently(postgres_client, "/api/payments/epay/notify", epay_signed_params(pending_order), count=8)
    assert {response.text for response in responses} == {"success"}
    assert wallet_balance(pending_order.user_id) == pending_order.credit_units
    assert count_wallet_entries(f"topup:{pending_order.id}") == 1


def test_provider_trade_number_cannot_credit_two_orders(client, two_pending_orders, epay_signed_params):
    first, second = two_pending_orders
    assert client.post("/api/payments/epay/notify", data=epay_signed_params(first, trade_no="EPAY-1")).text == "success"
    assert client.post("/api/payments/epay/notify", data=epay_signed_params(second, trade_no="EPAY-1")).text == "fail"
    assert wallet_entry_for(first.id) is not None
    assert wallet_entry_for(second.id) is None


def test_user_cannot_read_another_users_order(user_client, another_users_order):
    response = user_client.get(f"/api/payment-orders/{another_users_order.id}")
    assert response.status_code == 404


def test_wallet_and_entry_routes_are_always_current_user_scoped(user_client, user, another_user):
    credit_wallet(another_user.id, 999_000)
    assert user_client.get("/api/wallet").json()["user_id"] == user.id
    assert all(entry["user_id"] == user.id for entry in user_client.get("/api/wallet/entries").json())
```

- [ ] **Step 2: Run payment tests and confirm missing payment modules**

Run: `python -m pytest server/tests/test_epay.py -v`

Expected: FAIL with missing `payments.epay`.

- [ ] **Step 3: Implement standard 易支付 signing and server-owned order snapshots**

```python
# server/app/payments/epay.py
def canonical_epay_string(fields: Mapping[str, str]) -> str:
    return "&".join(
        f"{key}={value}" for key, value in sorted(fields.items())
        if key not in {"sign", "sign_type"} and value != ""
    )


def sign_epay(fields: Mapping[str, str], merchant_key: str) -> str:
    payload = (canonical_epay_string(fields) + merchant_key).encode("utf-8")
    return hashlib.md5(payload, usedforsecurity=False).hexdigest()


def verify_epay(fields: Mapping[str, str], merchant_key: str) -> bool:
    provided = fields.get("sign", "")
    return bool(provided) and secrets.compare_digest(provided.lower(), sign_epay(fields, merchant_key))
```

Keep the fixed hash above as a regression vector for the exact canonical fixture. Match NewAPI's `GetEpayClient`/`Purchase`/`EpayNotify`, top-up provider/order semantics, and `EpayId`/`EpayKey`/`PayAddress` field protocol, including go-epay canonical fields, signature rules, and `TRADE_SUCCESS`. Reuse only the wire protocol and merchant configuration shape: `create_order` accepts only `product_id`, locks/loads the enabled product, snapshots integer price/credits in OpenMontage PostgreSQL, generates an unpredictable merchant order number, and returns action URL plus form fields. It never calls a NewAPI top-up endpoint, creates a NewAPI order, or changes NewAPI user quota; the browser never submits amount or credits.

- [ ] **Step 4: Implement atomic callback settlement and routers**

`settle_epay_notify` parses only bounded form/query fields, verifies signature first, then requires `trade_status=TRADE_SUCCESS`, `type=alipay`, exact merchant order number, `payment_provider=epay`, unique provider trade number, and exact two-decimal money equal to `price_cny_fen`. It locks the order row, returns success immediately if already paid, otherwise calls `credit(..., idempotency_key=f"topup:{order.id}")`, marks paid, stores provider trade number, and commits once. It writes `success` only after commit; any verification/transaction failure writes `fail`. The browser return route verifies its signature/order for display routing but never calls `credit`; invalid returns redirect to a neutral failure state. The order service marks still-pending orders expired after 30 minutes, while a valid paid notify remains authoritative if it acquired the row lock before expiration.

Mount:

```text
GET  /api/wallet
GET  /api/wallet/entries
GET  /api/topup-products
POST /api/payment-orders
GET  /api/payment-orders
GET  /api/payment-orders/{order_id}
GET|POST /api/payments/epay/notify
GET  /api/payments/epay/return
```

Run: `python -m pytest server/tests/test_epay.py server/tests/test_wallet_service.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .env.example server/app/core/config.py server/app/payments server/app/wallet/router.py server/tests/test_epay.py
git commit -m "feat(payments): add epay alipay recharge"
```

### Task 7: Capability-Token Keyring, NewAPI Quote, Recovery, And Receipt Client

**Files:**
- Create: `server/app/provider/newapi.py`
- Create: `server/app/billing/money.py`
- Create: `server/tests/test_newapi_client.py`
- Modify: `server/app/core/config.py`
- Modify: `.env.example`
- Modify: `requirements.txt`

**Interfaces:**
- Consumes: NewAPI Task 3 same-route quote/status contracts and Task 2 final receipt contracts.
- Produces: `PreparedNewApiRequest`, `UsageQuote`, `TokenScopedQuote`, `QuotedExecutionResult`, `UsageQuoteStatus`, `UsageReceipt`, `VideoTaskStatus`, `NewApiClient.quote`, `NewApiClient.execute_quoted`, `NewApiClient.get_quote_status`, `get_request_receipt`, `get_task_receipt`, `get_video_task`, `download_video_content`, `NewApiError`, `InvalidNewApiResponse`, `AmbiguousNewApiResult`, `QuoteStale`, `QuoteNotFound`, `ReceiptNotFound`, `ProviderTaskNotFound`, `NewApiRateLimited`, `NewApiCallError`, and `provider_micro_to_charge_units`.

- [ ] **Step 1: Write token routing, exact-request reuse, quote parsing, stale, recovery, redaction, and integer conversion tests**

```python
# server/tests/test_newapi_client.py
def test_quote_and_execute_use_the_same_body_and_capability_token(httpx_mock, settings):
    httpx_mock.add_response(method="POST", url=f"{settings.newapi_base_url}/v1/videos", json=QUOTE)
    httpx_mock.add_response(method="POST", url=f"{settings.newapi_base_url}/v1/videos", json={"id": "task_1"})
    client = NewApiClient(settings)
    request = PreparedNewApiRequest.json("POST", "/v1/videos", {"model": "video-model", "seconds": 10})
    scoped_quote = client.quote("video", request)
    client.execute_quoted("video", scoped_quote.token_alias, request, scoped_quote.quote.quote_id)
    quoted, executed = httpx_mock.get_requests()
    assert quoted.content == executed.content == request.content
    assert quoted.headers["X-OneAPI-Quote-Only"] == "1"
    assert executed.headers["X-OneAPI-Usage-Quote"] == scoped_quote.quote.quote_id
    assert quoted.headers["Authorization"] == executed.headers["Authorization"]
    alias = settings.newapi_video_current_token_alias
    assert settings.newapi_video_token_keys[alias].get_secret_value() in quoted.headers["Authorization"]


@pytest.mark.parametrize(
    ("kind", "response_json", "response_headers", "reference_type", "reference_id"),
    [
        ("text", {"choices": []}, {"X-Oneapi-Request-Id": "req_text"}, "request", "req_text"),
        ("image", {"data": []}, {"X-Oneapi-Request-Id": "req_image"}, "request", "req_image"),
        ("video", {"id": "task_video"}, {}, "task", "task_video"),
    ],
)
def test_quoted_execution_returns_typed_reference(
        httpx_mock, settings, kind, response_json, response_headers, reference_type, reference_id):
    httpx_mock.add_response(json=response_json, headers=response_headers)
    alias = getattr(settings, f"newapi_{kind}_current_token_alias")
    result = NewApiClient(settings).execute_quoted(
        kind, alias, prepared_request_for(kind), "uq_1")
    assert result.reference_type == reference_type
    assert result.reference_id == reference_id
    assert isinstance(result.response, httpx.Response)


@pytest.mark.parametrize(
    ("kind", "response_json", "response_headers"),
    [
        ("text", {"choices": []}, {}),
        ("image", {"data": []}, {"X-Oneapi-Request-Id": " "}),
        ("video", {"id": 123}, {}),
    ],
)
def test_successful_execution_without_valid_reference_is_ambiguous(
        httpx_mock, settings, kind, response_json, response_headers):
    httpx_mock.add_response(
        status_code=200, json=response_json, headers=response_headers)
    client = NewApiClient(settings)
    with pytest.raises(AmbiguousNewApiResult):
        client.execute_quoted(
            kind, getattr(settings, f"newapi_{kind}_current_token_alias"),
            prepared_request_for(kind), "uq_1")
    assert len(httpx_mock.get_requests()) == 1


@pytest.mark.parametrize(
    ("kind", "status_patch"),
    [
        ("video", {"status": "accepted", "reference_type": None, "reference_id": "task_1"}),
        ("video", {"status": "consuming", "reference_type": "task", "reference_id": None}),
        ("video", {"status": "accepted", "reference_type": "request", "reference_id": "req_1"}),
        ("text", {"status": "accepted", "reference_type": "task", "reference_id": "task_1"}),
        ("image", {"status": "accepted", "reference_type": "task", "reference_id": "task_1"}),
        ("video", {"status": "quoted", "reference_type": "task", "reference_id": "task_1"}),
        ("text", {"status": "expired", "reference_type": "request", "reference_id": "req_1"}),
    ],
)
def test_quote_status_rejects_incomplete_or_wrong_capability_reference(
        httpx_mock, settings, kind, status_patch):
    httpx_mock.add_response(json={
        "quote_id": "uq_1", "status": "quoted", "reference_type": None,
        "reference_id": None, "created_at": 1, "expires_at": 121,
        "consumed_at": None, "updated_at": 2, **status_patch,
    })
    client = NewApiClient(settings)
    with pytest.raises(InvalidNewApiResponse):
        client.get_quote_status(
            kind, getattr(settings, f"newapi_{kind}_current_token_alias"), "uq_1")
    assert len(httpx_mock.get_requests()) == 1


def test_quote_cost_is_authoritative_integer_micro_and_qpu_is_audit_decimal(httpx_mock, settings):
    httpx_mock.add_response(json={**QUOTE, "estimated_cost_amount_micro": 2_898_001, "quota_per_unit": 500000.5})
    quote = NewApiClient(settings).quote("video", prepared_video_request()).quote
    assert quote.estimated_cost_amount_micro == 2_898_001
    assert quote.quota_per_unit == Decimal("500000.5")
    assert provider_micro_to_charge_units(quote.estimated_cost_amount_micro, 15_000) == 4_347_002


def test_execute_maps_409_and_status_recovers_reference(httpx_mock, settings):
    httpx_mock.add_response(status_code=409, json={"error": {"code": "quote_stale"}})
    httpx_mock.add_response(json={
        "quote_id": "uq_1", "status": "accepted", "reference_type": "task",
        "reference_id": "task_1", "created_at": 1, "expires_at": 121,
        "consumed_at": 2, "updated_at": 3,
    })
    client = NewApiClient(settings)
    with pytest.raises(QuoteStale):
        client.execute_quoted("video", "video-v1", prepared_video_request(), "uq_1")
    assert client.get_quote_status("video", "video-v1", "uq_1").reference_id == "task_1"


def test_retired_alias_reads_old_job_after_current_token_rotates(httpx_mock, rotated_settings):
    client = NewApiClient(rotated_settings)
    status = client.get_quote_status("video", "video-v1", "uq_old")
    receipt = client.get_task_receipt("video", "video-v1", "task_old")
    old_key = rotated_settings.newapi_video_token_keys["video-v1"].get_secret_value()
    assert all(request.headers["Authorization"] == f"Bearer {old_key}" for request in httpx_mock.get_requests())
    assert rotated_settings.newapi_video_current_token_alias == "video-v2"
    assert status.reference_id == receipt.reference_id == "task_old"


def test_video_task_recovery_uses_original_alias_and_relative_content_route(
        httpx_mock, rotated_settings, tmp_path):
    httpx_mock.add_response(json={"id": "task_old", "status": "completed"})
    httpx_mock.add_response(content=b"video-bytes")
    client = NewApiClient(rotated_settings)
    status = client.get_video_task("video-v1", "task_old")
    destination = tmp_path / "recovered.mp4"
    client.download_video_content("video-v1", "task_old", destination)
    old_key = rotated_settings.newapi_video_token_keys["video-v1"].get_secret_value()
    status_request, content_request = httpx_mock.get_requests()
    assert status.status == "completed" and destination.read_bytes() == b"video-bytes"
    assert status_request.url.path == "/v1/videos/task_old"
    assert content_request.url.path == "/v1/videos/task_old/content"
    assert all(r.headers["Authorization"] == f"Bearer {old_key}"
               for r in (status_request, content_request))


def test_client_error_and_repr_do_not_expose_tokens(settings, httpx_mock):
    httpx_mock.add_response(status_code=500, text="gateway failed")
    with pytest.raises(NewApiError) as error:
        NewApiClient(settings).quote("video", prepared_video_request())
    alias = settings.newapi_video_current_token_alias
    assert settings.newapi_video_token_keys[alias].get_secret_value() not in repr(error.value)
    assert settings.newapi_video_token_keys[alias].get_secret_value() not in repr(NewApiClient(settings))
```

- [ ] **Step 2: Run client tests and confirm modules are absent**

Run: `python -m pytest server/tests/test_newapi_client.py -v`

Expected: FAIL because the provider client, quote DTOs, and quote errors do not exist.

- [ ] **Step 3: Implement immutable prepared requests, strict quote/status/receipt DTOs, and secret-safe token routing**

```python
# server/app/provider/newapi.py
TokenKind = Literal["text", "image", "video"]


class NewApiError(RuntimeError):
    pass


class InvalidNewApiResponse(NewApiError):
    pass


class AmbiguousNewApiResult(InvalidNewApiResponse):
    pass


class QuoteStale(NewApiError):
    pass


class QuoteNotFound(NewApiError):
    pass


class ReceiptNotFound(NewApiError):
    pass


class ProviderTaskNotFound(NewApiError):
    pass


class NewApiRateLimited(NewApiError):
    pass


class NewApiCallError(NewApiError):
    pass


@dataclass(frozen=True, slots=True)
class PreparedNewApiRequest:
    method: Literal["POST"]
    path: str
    content: bytes
    content_type: str

    @classmethod
    def json(cls, method: Literal["POST"], path: str, body: Mapping[str, object]) -> "PreparedNewApiRequest":
        return cls(method=method, path=validate_relay_path(path),
                   content=json.dumps(body, sort_keys=True, separators=(",", ":"),
                                      ensure_ascii=False).encode("utf-8"),
                   content_type="application/json")


class UsageQuote(BaseModel):
    quote_id: str
    status: Literal["quoted"]
    model: str
    fixed_group: str
    relay_format: str
    estimated_quota: int = Field(ge=0)
    quota_per_unit: Decimal = Field(gt=0)
    cost_currency: Literal["USD"]
    estimated_cost_amount_micro: int = Field(ge=0)
    pricing_version: str
    other_ratios: dict[str, Decimal]
    billing_fingerprint: str
    expires_at: int


class UsageQuoteStatus(BaseModel):
    quote_id: str
    status: Literal["quoted", "consuming", "accepted", "failed", "expired"]
    reference_type: Literal["request", "task"] | None = None
    reference_id: str | None = None
    created_at: int
    expires_at: int
    consumed_at: int | None = None
    updated_at: int

    @model_validator(mode="after")
    def validate_reference_pair(self) -> "UsageQuoteStatus":
        if (self.reference_type is None) != (self.reference_id is None):
            raise ValueError("quote reference must be complete")
        if self.status in {"consuming", "accepted"} and self.reference_id is None:
            raise ValueError("consumed quote must expose its reference")
        if self.status in {"quoted", "expired"} and self.reference_id is not None:
            raise ValueError("unconsumed quote cannot expose a reference")
        return self


class VideoTaskStatus(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    status: Literal["queued", "in_progress", "completed", "failed"]
    error: str | None = Field(default=None, max_length=500)


@dataclass(frozen=True, slots=True)
class TokenScopedQuote:
    token_alias: str
    quote: UsageQuote


@dataclass(frozen=True, slots=True)
class QuotedExecutionResult:
    reference_type: Literal["request", "task"]
    reference_id: str
    response: httpx.Response


class NewApiClient:
    def __init__(self, settings: AppSettings, transport: httpx.BaseTransport | None = None):
        self._settings = settings
        self._base_url = settings.newapi_base_url.rstrip("/")
        self._keyrings = {
            "text": settings.newapi_text_token_keys,
            "image": settings.newapi_image_token_keys,
            "video": settings.newapi_video_token_keys,
        }
        self._current_aliases = {
            "text": settings.newapi_text_current_token_alias,
            "image": settings.newapi_image_current_token_alias,
            "video": settings.newapi_video_current_token_alias,
        }
        self._client = httpx.Client(timeout=30, transport=transport)

    def quote(self, kind: TokenKind, request: PreparedNewApiRequest,
              token_alias: str | None = None) -> TokenScopedQuote:
        alias = token_alias or self._current_aliases[kind]
        payload = self._send(kind, alias, request, {"X-OneAPI-Quote-Only": "1"}, UsageQuote)
        return TokenScopedQuote(token_alias=alias, quote=payload)

    def execute_quoted(self, kind: TokenKind, token_alias: str,
                       request: PreparedNewApiRequest, quote_id: str) -> QuotedExecutionResult:
        response = self._send_raw(kind, token_alias, request,
                                  {"X-OneAPI-Usage-Quote": validate_quote_id(quote_id)})
        if kind == "video":
            reference_type, reference_id = "task", parse_public_task_id(response)
        else:
            reference_type = "request"
            reference_id = require_request_id(response.headers.get("X-Oneapi-Request-Id"))
        return QuotedExecutionResult(reference_type, reference_id, response)

    def get_quote_status(self, kind: TokenKind, token_alias: str, quote_id: str) -> UsageQuoteStatus:
        status = self._get(kind, token_alias,
                           f"/api/usage/quote/{quote(validate_quote_id(quote_id), safe='')}", UsageQuoteStatus)
        expected_type = "task" if kind == "video" else "request"
        if status.reference_type is not None and status.reference_type != expected_type:
            raise InvalidNewApiResponse("quote reference capability mismatch")
        return status

    def get_task_receipt(self, kind: TokenKind, token_alias: str, task_id: str) -> UsageReceipt:
        return self._get(kind, token_alias,
                         f"/api/usage/receipt/task/{quote(task_id, safe='')}", UsageReceipt)

    def get_video_task(self, token_alias: str, task_id: str) -> VideoTaskStatus:
        return self._get(
            "video", token_alias,
            f"/v1/videos/{quote(validate_task_id(task_id), safe='')}",
            VideoTaskStatus, not_found=ProviderTaskNotFound)

    def download_video_content(self, token_alias: str, task_id: str,
                               destination: Path) -> None:
        self._download_relative_atomic(
            "video", token_alias,
            f"/v1/videos/{quote(validate_task_id(task_id), safe='')}/content",
            destination, max_bytes=self._settings.billing_max_video_bytes)

    def get_request_receipt(self, kind: TokenKind, token_alias: str, request_id: str) -> UsageReceipt:
        return self._get(kind, token_alias,
                         f"/api/usage/receipt/request/{quote(request_id, safe='')}", UsageReceipt)
```

Parse `NEWAPI_{TEXT,IMAGE,VIDEO}_TOKEN_KEYS_JSON` into alias-to-`SecretStr` maps and require each `NEWAPI_*_CURRENT_TOKEN_ALIAS` to exist in its map; `.env.example` uses non-secret aliases such as `text-v1` and literal `<set-in-secret-store>` placeholders, never a live key. Unknown/removed aliases fail closed and never fall back to the current token. Validate positive integer configuration for `BILLING_REFERENCE_RECOVERY_SECONDS=86400`, `BILLING_RECEIPT_DEADLINE_SECONDS=86400`, `BILLING_HOLD_TIMEOUT_SECONDS=86400`, `BILLING_QUOTE_STALE_RETRIES=2`, and `BILLING_MAX_VIDEO_BYTES=536870912`. Allowlist relative relay paths; never accept a caller-supplied host or absolute URL. Build the provider request once, retain the immutable serialized bytes through quote and execution, and never serialize a second body from mutable state. `_send_raw` maps only a validated NewAPI HTTP 409 `quote_stale` to `QuoteStale`, maps 429 to `NewApiRateLimited`, maps other explicit non-success responses to sanitized `NewApiCallError`, and treats timeouts/disconnects after send as `AmbiguousNewApiResult`. `execute_quoted` returns a typed `QuotedExecutionResult`: text/image require `X-Oneapi-Request-Id`, video parses the public NewAPI task ID, and a missing or malformed reference raises `AmbiguousNewApiResult` so the caller must resolve quote status before any replay. `UsageQuoteStatus` rejects a half-present reference, requires `consuming|accepted` to carry a complete reference, and rejects `quoted|expired` with any reference; `failed` may retain its preallocated local reference. `get_quote_status` additionally requires `task` for video and `request` for text/image. `_get` maps quote 404 to `QuoteNotFound`, receipt 404 to `ReceiptNotFound`, and task 404 to `ProviderTaskNotFound`; contract failures raise `InvalidNewApiResponse`. Video recovery always uses the original alias and relative NewAPI paths: poll `GET /v1/videos/{task_id}`, then stream `GET /v1/videos/{task_id}/content` to a same-directory temporary file, enforce `BILLING_MAX_VIDEO_BYTES`, fsync, atomically replace the destination, and delete partial files on failure. It never follows an arbitrary result URL. All responses are size-bounded and Pydantic-validated. No exception, `repr`, metric, or log includes alias keys, token/header values, prompt/body/media, quote ID, or provider result URL.

- [ ] **Step 4: Implement integer money conversion and prove there is no local pricing engine**

```python
# server/app/billing/money.py
def ceil_div(numerator: int, denominator: int) -> int:
    if numerator < 0 or denominator <= 0:
        raise ValueError("invalid integer ratio")
    return (numerator + denominator - 1) // denominator


def provider_micro_to_charge_units(provider_cost_micro: int, multiplier_bps: int) -> int:
    return ceil_div(provider_cost_micro * multiplier_bps, 10_000)
```

`quote.estimated_cost_amount_micro` is the only input to hold conversion. `quota_per_unit`, estimated quota, pricing version, other ratios, and fingerprint are stored for audit/stale comparison but OpenMontage never recalculates provider cost from them. There is no `estimator.py`, pricing cache, model switch, duration/resolution multiplier, adapter table, or call to `/api/usage/pricing/model/*`.

Run: `python -m pytest server/tests/test_newapi_client.py -v`

Expected: PASS.

Run: `rg -n "get_pricing|estimate_hold|model_price|model_ratio|tiered_expr|duration_factor|resolution_factor" server/app`

Expected: no billing-estimator match; provider request builders may contain validated request fields but no price/factor table.

- [ ] **Step 5: Commit**

```bash
git add requirements.txt .env.example server/app/core/config.py server/app/provider/newapi.py server/app/billing/money.py server/tests/test_newapi_client.py
git commit -m "feat(provider): add quoted newapi client"
```

### Task 8: Parent/Child Billing Jobs, Quote Holds, And Final Receipt Settlement

**Files:**
- Create: `server/app/billing/service.py`
- Create: `server/tests/test_billing_service.py`
- Modify: `server/app/billing/models.py`

**Interfaces:**
- Consumes: wallet service, `UsageQuote`, integer money conversion, final `UsageReceipt`, and billing models.
- Produces: `ProviderPricingUnavailable`, `InvalidBillingState`, `load_job`, `load_owned_payment_required_quote`, `create_parent_job`, `reserve_provider_call`, `replace_job_quote`, `bind_provider_reference`, `stage_result`, `mark_reference_recovery_pending`, `mark_receipt_pending`, `fail_unsubmitted`, `fail_missing_result`, `fail_undeliverable_sync_call`, `settle_job`, `fail_job`, and `retry_payment_required`.

- [ ] **Step 1: Write quote-sized hold, immutable multiplier, stale resize, child isolation, and receipt-only settlement tests**

```python
# server/tests/test_billing_service.py
def stage_fixture_result(billing_service, job, kind: str) -> None:
    artifact = seed_hidden_artifact(
        kind=kind, source_reference=job.provider_reference_id)
    billing_service.stage_result(job.id, artifact.locator, artifact.sha256)


def test_multiplier_change_does_not_change_existing_child(db_session, billing_service, funded_wallet):
    parent = billing_service.create_parent_job(user_id=funded_wallet.user_id, project_id="p1", operation="render")
    child = billing_service.reserve_provider_call(user_id=funded_wallet.user_id, project_id="p1",
        parent_job_id=parent.id, capability="video", operation="shot:s1",
        provider_method="POST", provider_route="/v1/videos", quote=usage_quote(cost_micro=2_898_000))
    set_global_multiplier(db_session, 20_000)
    assert hold_for(child.id).amount_units == 4_347_000
    assert billing_service.replace_job_quote(child.id, usage_quote(id="uq_2", cost_micro=3_000_000)) == "ready"
    assert load_job(child.id).multiplier_bps == 15_000
    assert hold_for(child.id).amount_units == 4_500_000


def test_fresh_quote_growth_without_funds_keeps_hold_and_blocks_provider(db_session, billing_service, funded_wallet):
    child = reserve_child_with_quote(billing_service, cost_micro=2_000_000)
    original_hold = hold_for(child.id).amount_units
    outcome = billing_service.replace_job_quote(child.id, usage_quote(id="uq_larger", cost_micro=20_000_000))
    assert outcome == "payment_required_quote"
    assert load_job(child.id).quote_id == "uq_larger"
    assert load_job(child.id).status == "payment_required_quote"
    assert hold_for(child.id).amount_units == original_hold


def test_final_receipt_ignores_quote_amount(db_session, billing_service, child_job):
    assert child_job.quote_estimated_provider_cost_micro == 2_898_000
    stage_fixture_result(billing_service, child_job, "video")
    billing_service.settle_job(child_job.id, settled_receipt(cost_amount_micro=3_100_000))
    assert consumption_for(child_job.id).amount_units == -4_650_000


def test_zero_fresh_quote_releases_existing_hold_without_provider_call(db_session, billing_service, child_job):
    outcome = billing_service.replace_job_quote(child_job.id, usage_quote(id="uq_free", cost_micro=0))
    assert outcome == "provider_pricing_unavailable_no_charge"
    assert hold_for(child_job.id).status == "released"
    assert consumption_for(child_job.id) is None


def test_one_failed_shot_releases_only_its_hold(db_session, billing_service, funded_wallet):
    parent = billing_service.create_parent_job(user_id=funded_wallet.user_id, project_id="p1", operation="render")
    first = reserve_video_child(billing_service, parent.id, shot_id="s1")
    second = reserve_video_child(billing_service, parent.id, shot_id="s2")
    stage_fixture_result(billing_service, first, "video")
    billing_service.settle_job(first.id, settled_receipt(cost_amount_micro=1_000_000))
    billing_service.fail_job(second.id, refund_pending_receipt())
    assert consumption_for(first.id).amount_units < 0
    assert consumption_for(second.id) is None
    assert hold_for(second.id).status == "released"


def test_duplicate_receipt_settles_once(db_session, billing_service, child_job):
    receipt = settled_receipt(cost_amount_micro=1_000_000)
    stage_fixture_result(billing_service, child_job, "text")
    billing_service.settle_job(child_job.id, receipt)
    billing_service.settle_job(child_job.id, receipt)
    assert count_consumptions(child_job.id) == 1


def test_undeliverable_sync_call_releases_hold_and_never_charges(
        db_session, billing_service, sync_child_job):
    billing_service.fail_undeliverable_sync_call(
        sync_child_job.id, reference_type="request", reference_id="req_lost")
    billing_service.settle_job(
        sync_child_job.id, settled_receipt(
            reference_type="request", reference_id="req_lost", cost_amount_micro=1_000_000))
    assert load_job(sync_child_job.id).status == "provider_result_missing_no_charge"
    assert hold_for(sync_child_job.id).status == "released"
    assert consumption_for(sync_child_job.id) is None
    assert reconciliation_for(sync_child_job.id).reason == "provider_result_missing"


def test_settled_receipt_waits_for_staged_result_before_charge_or_visibility(
        db_session, billing_service, child_job):
    receipt = settled_receipt(cost_amount_micro=1_000_000)
    billing_service.settle_job(child_job.id, receipt)
    waiting = load_job(child_job.id)
    assert waiting.status == "result_pending"
    assert waiting.result_visible is False
    assert consumption_for(child_job.id) is None
    stage_fixture_result(billing_service, child_job, "image")
    billed = load_job(child_job.id)
    assert billed.status == "billed" and billed.result_visible is True
    assert count_consumptions(child_job.id) == 1


def test_payment_required_retries_stored_receipt_after_topup_without_provider_call(
        db_session, billing_service, child_job, provider_spy):
    stage_fixture_result(billing_service, child_job, "video")
    billing_service.settle_job(
        child_job.id, settled_receipt(cost_amount_micro=20_000_000))
    assert load_job(child_job.id).status == "payment_required"
    credit_wallet(child_job.user_id, 30_000_000, idempotency_key="topup:test")
    billing_service.retry_payment_required(child_job.id)
    job = load_job(child_job.id)
    assert job.status == "billed" and job.result_visible is True
    assert count_consumptions(child_job.id) == 1
    assert provider_spy.call_count == 0
```

- [ ] **Step 2: Run billing tests and confirm service is missing**

Run: `python -m pytest server/tests/test_billing_service.py -v`

Expected: FAIL with missing `billing.service`.

- [ ] **Step 3: Implement parent creation, child reservation, and immutable snapshots**

```python
# server/app/billing/service.py
class ProviderPricingUnavailable(RuntimeError):
    pass


class InvalidBillingState(RuntimeError):
    pass


def reserve_provider_call(self, *, user_id: str, project_id: str, parent_job_id: str | None,
                          capability: TokenKind, operation: str, provider_method: str,
                          provider_route: str, quote: TokenScopedQuote) -> GenerationJob:
    if quote.quote.estimated_cost_amount_micro <= 0:
        raise ProviderPricingUnavailable("paid calls require a positive NewAPI quote")
    setting = self.db.get(BillingSetting, 1, with_for_update=True)
    hold_units = provider_micro_to_charge_units(
        quote.quote.estimated_cost_amount_micro, setting.multiplier_bps)
    job = GenerationJob(id=uuid.uuid4().hex, parent_job_id=parent_job_id, chargeable=True,
        user_id=user_id, project_id=project_id, capability=capability, token_kind=capability,
        token_alias=quote.token_alias, operation=operation, model=quote.quote.model,
        provider_method=provider_method,
        provider_route=provider_route,
        multiplier_bps=setting.multiplier_bps,
        reference_deadline=utcnow() + timedelta(seconds=self.settings.billing_reference_recovery_seconds),
        receipt_deadline=utcnow() + timedelta(seconds=self.settings.billing_receipt_deadline_seconds),
        status="reserved", result_visible=False)
    apply_quote_snapshot(job, quote.quote)
    self.db.add(job)
    self.db.flush()
    create_hold(self.db, user_id=user_id, job_id=job.id, amount_units=hold_units,
                expires_at=utcnow() + timedelta(seconds=self.settings.billing_hold_timeout_seconds))
    self.db.commit()
    return job


def stage_result(self, job_id: str, result_locator: str, result_sha256: str) -> None:
    job = lock_chargeable_job(self.db, job_id)
    validate_backend_result_locator(result_locator)
    validate_sha256(result_sha256)
    artifact = load_hidden_artifact(result_locator)
    if artifact.sha256 != result_sha256 or artifact.source_reference != job.provider_reference_id:
        raise ValueError("staged result does not belong to provider reference")
    job.result_locator = result_locator
    job.result_sha256 = result_sha256
    job.result_staged = True
    stored_receipt = load_cost_receipt_for_update(self.db, job_id)
    if stored_receipt is not None and stored_receipt.status == "settled":
        self._capture_settled_receipt_locked(job, stored_receipt)
    self.db.commit()


def retry_payment_required(self, job_id: str) -> None:
    job, hold, wallet, receipt = lock_payment_required_graph(self.db, job_id)
    if not job.result_staged or receipt.status != "settled":
        raise InvalidBillingState("payment retry requires staged result and settled receipt")
    self._capture_settled_receipt_locked(job, receipt)
    self.db.commit()
```

`apply_quote_snapshot` copies exactly the Task 4 quote fields and canonicalizes `other_ratios` without interpreting them. The `TokenScopedQuote.token_alias` is copied separately and never returned by public APIs. Parent jobs start at `running`, set `chargeable=False`, have no token alias/quote/hold/provider reference/multiplier charge, and aggregate child statuses only. A zero/free or structurally incomplete quote is rejected before job/hold/upstream because paid OpenMontage endpoints require a positive authoritative hold. Bind provider reference in a transaction; a uniqueness conflict loads the existing job and refuses cross-user/project reuse.

`replace_job_quote(job_id, fresh_quote)` requires `fresh_quote.token_alias == job.token_alias`, locks job, active hold, and wallet, computes a new hold from the job's existing `multiplier_bps` (never the current global setting), stores the fresh snapshot, and calls `resize_active_hold`. It never silently changes to the current alias. On success it sets `reserved`. On insufficient growth funds it keeps the original hold, commits the fresh snapshot with `payment_required_quote`, and returns that result. A zero/free or incomplete fresh quote releases the hold as `provider_pricing_unavailable_no_charge`. A retry after the 120-second quote expiry must obtain another quote using the snapshotted alias before attempting resize or provider execution.

- [ ] **Step 4: Implement receipt hashing and idempotent settlement states**

`mark_reference_recovery_pending` and `mark_receipt_pending` lock the job, accept only their documented predecessor states, and commit before the caller yields to a worker. `fail_unsubmitted` locks job/hold/wallet, releases the hold and writes the terminal no-charge state in one transaction. `fail_missing_result` performs the same atomic release for an already-submitted job, sets `provider_result_missing_no_charge`, keeps any staged/partial artifact hidden, and opens operator reconciliation. All four operations are idempotent for the same target state and reject transitions out of any billed/no-charge terminal state.

`load_owned_payment_required_quote(job_id, user_id, project_id)` returns 404 unless all ownership fields match and the child is in `payment_required_quote`; it returns a detached server-side snapshot so no database lock survives the fresh quote network call. `load_job` is a server-internal refresh used only after a transactional service operation and is never exposed as an ownership bypass.

For `settled`, lock job, hold, and wallet and insert/update `CostReceipt` by provider reference. If no result is staged, set `result_pending`, keep the hold active and result hidden, and do not create a consumption entry. Once `stage_result` has persisted a backend-only locator/hash, compute charge exclusively from receipt `cost_amount_micro` and the job multiplier snapshot; capture once; set `billed` and `result_visible=True` in the same transaction. Never substitute quote cost when receipt cost is missing or different. `fail_undeliverable_sync_call` binds the recovered request reference for operator accounting, releases once, creates no consumption entry, sets `provider_result_missing_no_charge`, keeps the result hidden, and opens `provider_result_missing` reconciliation; any later receipt is audit-only and cannot charge that job. For `refunded`, `refund_pending`, or `not_chargeable`, release once, create no consumption entry, set `failed_no_charge`, keep result hidden, and open reconciliation only for `refund_pending`. For `pending`, do not mutate funds. If actual receipt charge exceeds held plus available funds, leave the hold active, set `payment_required`, hide result, and retry after top-up.

`retry_payment_required` never contacts NewAPI. It locks the `payment_required` job, stored settled receipt, active hold, and wallet; recomputes the charge from that receipt plus the job's immutable multiplier; and either remains `payment_required` with no mutation on insufficient funds or captures once and makes the staged result visible. Duplicate retries are idempotent and cannot create a second consumption entry.

Run: `python -m pytest server/tests/test_billing_service.py server/tests/test_wallet_service.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app/billing/service.py server/app/billing/models.py server/tests/test_billing_service.py
git commit -m "feat(billing): settle provider calls from receipts"
```

### Task 9: Failed Video Refund, Quote Recovery, And Missing Receipt Reconciliation Worker

**Files:**
- Create: `server/app/billing/reconciliation.py`
- Create: `server/app/provider/video_recovery.py`
- Create: `server/billing_worker.py`
- Create: `server/tests/test_billing_refunds.py`
- Modify: `server/app/storage.py`
- Modify: `server/tests/test_storage.py`
- Modify: `server/manage.py`

**Interfaces:**
- Consumes: billing service plus NewAPI quote-status and final-receipt clients.
- Produces: `recover_provider_reference`, `resume_billed_video_job`, `reconcile_job_now(db, client, job_id, now)`, `reconcile_due_jobs(db, client, now, limit)`, `python -m server.billing_worker`, and `python -m server.manage reconcile-billing --once`.

- [ ] **Step 1: Write refund-pending, accepted-reference recovery, and missing receipt tests**

```python
# server/tests/test_billing_refunds.py
def test_failure_with_residual_quota_never_charges_user(billing_service, video_child):
    receipt = UsageReceipt(reference_type="task", reference_id="task_x", status="refund_pending",
        model="omni_flash-10s", quota=15_834_000, refunded_quota=0,
        quota_per_unit=Decimal("500000"), pricing_version="sha256:p",
        cost_currency="USD", cost_amount_micro=0)
    billing_service.settle_job(video_child.id, receipt)
    assert hold_for(video_child.id).status == "released"
    assert consumption_for(video_child.id) is None
    assert reconciliation_for(video_child.id).reason == "upstream_refund_pending"


def test_delayed_refund_closes_reconciliation_without_wallet_entry(worker, refund_pending_job, newapi_mock):
    newapi_mock.task_receipt.return_value = refunded_receipt(refunded_quota=15_834_000)
    worker.run_once(now=utcnow())
    assert reconciliation_for(refund_pending_job.id).status == "resolved"
    assert consumption_for(refund_pending_job.id) is None


def test_receipt_timeout_releases_hold_and_operator_bears_late_cost(worker, pending_job, newapi_mock):
    newapi_mock.task_receipt.side_effect = ReceiptNotFound
    worker.run_once(now=pending_job.receipt_deadline + timedelta(seconds=1))
    assert hold_for(pending_job.id).status == "released"
    assert load_job(pending_job.id).status == "receipt_missing_no_charge"
    assert reconciliation_for(pending_job.id).status == "open"


def test_upstream_accept_crash_recovers_quote_reference_without_resubmit(worker, unbound_submitted_job, newapi_mock):
    newapi_mock.get_quote_status.return_value = quote_status(
        status="accepted", reference_type="task", reference_id="task_recovered")
    newapi_mock.get_task_receipt.return_value = settled_receipt(reference_id="task_recovered")
    newapi_mock.get_video_task.return_value = VideoTaskStatus(
        id="task_recovered", status="completed")
    newapi_mock.download_video_content.side_effect = write_valid_test_video
    worker.run_once(now=utcnow())
    job = load_job(unbound_submitted_job.id)
    assert job.provider_reference_id == "task_recovered"
    assert job.status == "billed"
    assert job.result_staged is True and job.result_visible is True
    assert artifact_store.exists(job.result_locator, sha256=job.result_sha256)
    newapi_mock.get_quote_status.assert_called_once_with(
        unbound_submitted_job.token_kind, unbound_submitted_job.token_alias,
        unbound_submitted_job.quote_id)
    assert newapi_mock.quote.call_count == 0
    assert newapi_mock.execute_quoted.call_count == 0


@pytest.mark.parametrize("quote_status_name", ["consuming", "accepted"])
def test_sync_crash_with_reference_never_requotes_or_charges(
        worker, unbound_submitted_sync_job, newapi_mock, quote_status_name):
    newapi_mock.get_quote_status.return_value = quote_status(
        status=quote_status_name, reference_type="request", reference_id="req_1")
    worker.run_once(now=utcnow())
    job = load_job(unbound_submitted_sync_job.id)
    assert job.provider_reference_id == "req_1"
    assert job.status == "provider_result_missing_no_charge"
    assert hold_for(job.id).status == "released"
    assert consumption_for(job.id) is None
    assert reconciliation_for(job.id).reason == "provider_result_missing"
    assert newapi_mock.quote.call_count == 0
    assert newapi_mock.execute_quoted.call_count == 0


def test_video_result_download_deadline_releases_without_charge(
        worker, receipt_pending_video_job, newapi_mock):
    newapi_mock.get_video_task.return_value = VideoTaskStatus(
        id=receipt_pending_video_job.provider_reference_id, status="completed")
    newapi_mock.download_video_content.side_effect = NewApiCallError("download failed")
    worker.run_once(now=receipt_pending_video_job.receipt_deadline + timedelta(seconds=1))
    job = load_job(receipt_pending_video_job.id)
    assert job.status == "provider_result_missing_no_charge"
    assert job.result_visible is False
    assert hold_for(job.id).status == "released"
    assert consumption_for(job.id) is None
    assert reconciliation_for(job.id).reason == "provider_result_missing"


def test_reference_deadline_releases_only_after_quote_recovery_exhausted(worker, unbound_submitted_job, newapi_mock):
    newapi_mock.get_quote_status.side_effect = QuoteNotFound
    worker.run_once(now=unbound_submitted_job.reference_deadline + timedelta(seconds=1))
    assert hold_for(unbound_submitted_job.id).status == "released"
    assert load_job(unbound_submitted_job.id).status == "provider_reference_missing_no_charge"
    assert reconciliation_for(unbound_submitted_job.id).reason == "provider_reference_missing"


def test_abandoned_payment_required_quote_releases_at_hold_deadline(worker, payment_required_quote_job, newapi_mock):
    worker.run_once(now=hold_for(payment_required_quote_job.id).expires_at + timedelta(seconds=1))
    assert hold_for(payment_required_quote_job.id).status == "released"
    assert load_job(payment_required_quote_job.id).status == "provider_not_submitted_no_charge"
    assert newapi_mock.execute_quoted.call_count == 0


# server/tests/test_storage.py
def test_hidden_video_destination_commits_atomically_with_source_reference(media_store):
    with media_store.hidden_video_destination("project_1", "shot:s1") as destination:
        destination.temporary_path.write_bytes(valid_test_video_bytes())
        artifact = destination.commit(
            sha256=sha256_file(destination.temporary_path),
            source_reference="task_1")
    assert artifact.source_reference == "task_1"
    assert artifact.hidden is True
    assert media_store.exists(artifact.locator, sha256=artifact.sha256)
    assert not list(artifact.path.parent.glob("*.partial"))
```

- [ ] **Step 2: Run refund tests and confirm worker is missing**

Run: `python -m pytest server/tests/test_billing_refunds.py -v`

Expected: FAIL with missing reconciliation module.

- [ ] **Step 3: Implement PostgreSQL-backed polling with bounded retries**

`reconcile_due_jobs` selects due rows `FOR UPDATE SKIP LOCKED`, up to 100, and commits each item independently. Retry schedule is 5s, 15s, 30s, 60s, then every 5 minutes until deadline. It stores attempts, next retry, status, and sanitized error. `refund_pending` immediately releases the user's hold and stays open until `refunded`/`not_chargeable` or administrator resolution.

For any `submitted_ambiguous` or `reference_recovery_pending` child without a bound reference, `recover_provider_reference` first calls `GET /api/usage/quote/{quote_id}` with the child's snapshotted `token_alias`; task/result/receipt reads use that same alias. An absent retired alias is an operator configuration error and must never fall back to the current token. The API path sets one of those states and commits before yielding recovery to the worker, so the worker never races a still-running `reserved` call. `consuming` or `accepted` with a task reference binds that reference and calls `resume_billed_video_job`; it never re-quotes or submits upstream. A recovered synchronous request reference after the original response was lost is not enough to reconstruct text/image output, so the worker calls `fail_undeliverable_sync_call`: release the hold, charge zero, keep the result hidden, and retain the receipt/reconciliation only for operator cost accounting. `failed` releases the hold as `provider_rejected_no_charge`. `quoted` or `expired` proves no upstream acceptance only because Task 7 rejects either state if it carries a reference; then release as `provider_not_submitted_no_charge`. A missing/malformed status retries until `BILLING_REFERENCE_RECOVERY_SECONDS=86400`, then releases, becomes `provider_reference_missing_no_charge`, and opens operator reconciliation. Expired active holds on `payment_required_quote` release as `provider_not_submitted_no_charge` without any NewAPI call. The worker itself never replays a provider request because it intentionally does not persist prompt/body/media. Each pass also expires eligible 30-minute pending payment orders. Missing/invalid receipts never become a user charge, and quote cost is never used as fallback.

`resume_billed_video_job` snapshots a video child's original `token_alias`, task reference, project, and operation in a short transaction, then performs no network or file I/O while holding database locks. It derives a hidden destination from the existing project/media storage boundary and calls `get_video_task(alias, task_id)`. `queued|in_progress` schedules the next retry without touching funds. `completed` calls `download_video_content(alias, task_id, temporary_path)`, verifies the media with `probe_output`, registers it as a hidden project artifact with the source task reference, and calls `stage_result(job_id, artifact_locator, sha256)`; that transaction rejects a terminal job or an artifact whose source reference/hash no longer matches. `failed` proceeds to the final receipt so refund/not-chargeable rules decide the zero-charge state. `ProviderTaskNotFound`, invalid media, size overflow, or download failure keeps the result hidden and retries until the receipt/result deadline; at the deadline it calls `fail_missing_result`, releases the hold as `provider_result_missing_no_charge`, and opens reconciliation. `reconcile_due_jobs` includes `result_pending` and `receipt_pending` rows. `reconcile_job_now` runs this result step first for task jobs, then fetches the final receipt and calls `settle_job`; a settled receipt can never debit an unstaged result. The same function is used by the request path and the worker, so restart recovery and immediate execution share one state machine.

```python
# server/app/provider/video_recovery.py
def resume_billed_video_job(db: Session, client: NewApiClient, job_id: str,
                            media_store: MediaStore) -> Literal["pending", "completed", "failed"]:
    job = load_video_job_snapshot(db, job_id)
    status = client.get_video_task(job.token_alias, job.provider_reference_id)
    if status.status in {"queued", "in_progress"}:
        schedule_next_retry(job)
        db.commit()
        return "pending"
    if status.status == "failed":
        return "failed"
    with media_store.hidden_video_destination(job.project_id, job.operation) as destination:
        client.download_video_content(
            job.token_alias, job.provider_reference_id, destination.temporary_path)
        probe_output(destination.temporary_path)
        artifact = destination.commit(
            sha256=sha256_file(destination.temporary_path),
            source_reference=job.provider_reference_id)
    billing_service(db).stage_result(job.id, artifact.locator, artifact.sha256)
    return "completed"


# server/app/billing/reconciliation.py
def reconcile_job_now(db: Session, client: NewApiClient, job_id: str,
                      now: datetime) -> None:
    job = load_job(db, job_id)
    if job.provider_reference_type == "task" and not job.result_staged:
        if resume_billed_video_job(db, client, job.id, get_media_store()) == "pending":
            return
    receipt = get_final_receipt(client, job)
    billing_service(db).settle_job(job.id, receipt)


# server/billing_worker.py
def main() -> int:
    stop = threading.Event()
    install_signal_handlers(stop)
    while not stop.is_set():
        with SessionFactory() as db:
            reconcile_due_jobs(db, get_newapi_client(), now=utcnow(), limit=100)
        stop.wait(5)
    return 0
```

- [ ] **Step 4: Run refund and worker tests**

Run: `python -m pytest server/tests/test_billing_refunds.py server/tests/test_billing_service.py server/tests/test_storage.py -v`

Expected: PASS with recovered accepted references charged only from receipts, zero provider resubmits, and zero user charge in every failed/refunded/missing-receipt case.

- [ ] **Step 5: Commit**

```bash
git add server/app/billing/reconciliation.py server/app/provider/video_recovery.py server/app/storage.py server/billing_worker.py server/manage.py server/tests/test_billing_refunds.py server/tests/test_storage.py
git commit -m "feat(billing): recover quotes and reconcile receipts"
```

### Task 10: Integrate Billing Into Text, Image, Single-Shot, And Multi-Shot Calls

**Files:**
- Modify after auth merge: `server/app/main.py`
- Modify: `server/app/models.py`
- Modify: `server/app/storyboard_generator.py`
- Modify: `server/app/prompt_optimizer.py`
- Modify: `server/app/openmontage_runner.py`
- Create: `server/app/provider/image_generation.py`
- Modify: `tools/video/syapi_video.py`
- Modify: `server/tests/test_api.py`
- Create: `server/tests/test_image_generation.py`
- Modify: `server/tests/test_openmontage_runner.py`

**Interfaces:**
- Consumes: auth `CurrentUser`, owned projects, Tasks 7-9 services.
- Produces: `ProviderCallContext`, `StagedProviderResult`, `execute_billed_provider_call`, `retry_payment_required_quote`, `finalize_billed_sync_result`, `ProviderResultPending`, `ProviderResultUnavailable`, `ProviderPricingUnstable`, `PaymentRequiredQuote`, server-token-only quote/execute/recover/receipt flows, one billed child per upstream invocation, and a non-billable parent per render.

- [ ] **Step 1: Write quote-before-hold, stale/timeout recovery, no-browser-key, and multi-shot tests**

```python
# server/tests/test_openmontage_runner.py
def test_render_creates_one_child_per_missing_shot_and_no_hold_for_parent(billed_runner, project_with_three_missing_shots):
    result = billed_runner.render(project_with_three_missing_shots)
    parent = load_job(result["job_id"])
    children = load_children(parent.id)
    assert parent.chargeable is False
    assert hold_for(parent.id) is None
    assert [child.operation for child in children] == ["shot:s1", "shot:s2", "shot:s3"]
    assert all(hold_for(child.id) is not None for child in children)


def test_each_child_quotes_then_holds_then_executes_with_quote(billed_runner, newapi):
    billed_runner.render(project_with_one_shot())
    child = latest_child()
    assert newapi.events == [
        ("quote", "/v1/videos", newapi.request_hash),
        ("execute", "/v1/videos", newapi.request_hash, child.quote_id),
        ("task_status", child.provider_reference_id),
        ("task_content", child.provider_reference_id),
        ("stage_result", child.id),
        ("receipt", "task", child.provider_reference_id),
    ]
    assert hold_for(child.id).created_at <= newapi.execute_started_at
    assert child.result_staged is True and child.result_visible is True


def test_image_generation_uses_image_alias_quote_hold_and_request_receipt(image_service, newapi):
    newapi.next_quote = usage_quote(
        token_alias="image-v1", model="gpt-image-2", cost_micro=1_000_000)
    result = image_service.generate(
        user_id="u1", project_id="p1", prompt="frame", model="gpt-image-2",
        count=2, size="1024x1024", quality="standard")
    child = load_job(result.job_id)
    assert child.token_kind == "image" and child.token_alias == "image-v1"
    assert newapi.prepared_requests[0].path == "/v1/images/generations"
    assert json.loads(newapi.prepared_requests[0].content)["n"] == 2
    assert newapi.execute_quote_ids == [child.quote_id]
    assert hold_for(child.id).amount_units == 1_500_000
    assert receipt_for(child.id).reference_type == "request"
    assert child.result_staged is True and child.result_visible is True


def test_stale_consumed_quote_recovers_reference_and_never_resubmits(billed_runner, newapi):
    newapi.execute_side_effect = QuoteStale()
    newapi.quote_status = quote_status(
        status="accepted", reference_type="task", reference_id="task_already_sent")
    billed_runner.render(project_with_one_shot())
    assert newapi.execute_call_count == 1
    assert newapi.quote_call_count == 1
    assert latest_child().provider_reference_id == "task_already_sent"


@pytest.mark.parametrize("capability", ["text", "image"])
def test_missing_sync_execution_reference_recovers_status_without_resubmit_or_charge(
        billed_sync_call, newapi, capability):
    newapi.execute_side_effect = AmbiguousNewApiResult("missing execution reference")
    newapi.quote_status = quote_status(
        status="accepted", reference_type="request", reference_id="req_already_sent")
    with pytest.raises(ProviderResultUnavailable):
        billed_sync_call(capability)
    assert newapi.execute_call_count == 1
    assert newapi.quote_call_count == 1
    assert newapi.quote_status_call_count == 1
    assert newapi.upstream_accept_count == 1
    child = latest_child()
    assert child.provider_reference_id == "req_already_sent"
    assert child.status == "provider_result_missing_no_charge"
    assert hold_for(child.id).status == "released"
    assert consumption_for(child.id) is None
    assert child.result_visible is False


def test_missing_video_execution_reference_recovers_task_without_resubmit(billed_runner, newapi):
    newapi.execute_side_effect = AmbiguousNewApiResult("missing execution reference")
    newapi.quote_status = quote_status(
        status="accepted", reference_type="task", reference_id="task_recovered")
    with pytest.raises(ProviderResultPending):
        billed_runner.render(project_with_one_shot())
    assert newapi.execute_call_count == 1
    assert newapi.quote_status_call_count == 1
    assert newapi.upstream_accept_count == 1
    assert latest_child().provider_reference_id == "task_recovered"


def test_execute_rate_limit_checks_status_before_any_retry(billed_runner, newapi):
    newapi.execute_side_effect = NewApiRateLimited()
    newapi.quote_status = quote_status(
        status="accepted", reference_type="task", reference_id="task_rate_limited")
    with pytest.raises(ProviderResultPending):
        billed_runner.render(project_with_one_shot())
    assert newapi.execute_call_count == 1
    assert newapi.quote_status_call_count == 1
    assert newapi.quote_call_count == 1
    assert latest_child().provider_reference_id == "task_rate_limited"


def test_malformed_quote_status_enters_recovery_without_resubmit(billed_runner, newapi):
    newapi.execute_side_effect = AmbiguousNewApiResult()
    newapi.get_quote_status_side_effect = InvalidNewApiResponse("malformed status")
    with pytest.raises(ProviderResultPending):
        billed_runner.render(project_with_one_shot())
    assert newapi.execute_call_count == 1
    assert newapi.quote_status_call_count == 1
    assert newapi.quote_call_count == 1
    assert latest_child().status == "reference_recovery_pending"


def test_stale_unconsumed_quote_requotes_and_resizes_before_one_upstream_call(billed_runner, newapi):
    newapi.execute_side_effects = [QuoteStale(), successful_video("task_1")]
    newapi.quote_status = quote_status(status="quoted")
    newapi.quotes = [usage_quote(id="uq_old", cost_micro=2_000_000),
                     usage_quote(id="uq_new", cost_micro=3_000_000)]
    billed_runner.render(project_with_one_shot())
    assert newapi.execute_quote_ids == ["uq_old", "uq_new"]
    assert newapi.upstream_accept_count == 1
    assert hold_for(latest_child().id).amount_units == 4_500_000


def test_larger_requote_without_balance_returns_402_without_upstream(authenticated_client, newapi):
    newapi.execute_side_effect = QuoteStale()
    newapi.quote_status = quote_status(status="quoted")
    newapi.next_quote = usage_quote(id="uq_large", cost_micro=20_000_000)
    response = authenticated_client.post("/api/projects/p1/render")
    assert response.status_code == 402
    assert response.json()["code"] == "payment_required_quote"
    assert latest_child().status == "payment_required_quote"
    assert newapi.upstream_accept_count == 0


def test_quote_payment_retry_uses_same_job_alias_multiplier_and_fresh_quote(
        billed_video_call, newapi, payment_required_quote_job):
    original = load_job(payment_required_quote_job.id)
    credit_wallet(original.user_id, 30_000_000, idempotency_key="topup:retry-quote")
    newapi.next_quote = usage_quote(id="uq_retry", cost_micro=3_000_000)
    context = retry_payment_required_quote(
        job_id=original.id, user_id=original.user_id, project_id=original.project_id,
        capability="video", operation=original.operation,
        request=prepared_video_request())
    retried = load_job(original.id)
    assert context.job_id == original.id
    assert retried.token_alias == original.token_alias
    assert retried.multiplier_bps == original.multiplier_bps
    assert retried.quote_id == "uq_retry"
    assert newapi.quote_aliases[-1] == original.token_alias
    assert newapi.upstream_accept_count == 1
    assert count_children(original.parent_job_id) == 1


def test_explicit_pre_upstream_rejection_releases_hold_without_retry(billed_runner, newapi):
    newapi.execute_side_effect = NewApiCallError("provider rejected")
    newapi.quote_status = quote_status(status="failed")
    with pytest.raises(NewApiCallError):
        billed_runner.render(project_with_one_shot())
    assert hold_for(latest_child().id).status == "released"
    assert newapi.execute_call_count == 1
    assert newapi.upstream_accept_count == 0


def test_partial_video_failure_charges_successes_only(billed_runner, project_with_two_shots, provider):
    provider.results = [successful_video("task_ok"), failed_video("task_failed")]
    result = billed_runner.render(project_with_two_shots)
    first, second = load_children(result["job_id"])
    assert consumption_for(first.id) is not None
    assert consumption_for(second.id) is None
    assert hold_for(second.id).status == "released"


def test_paid_api_rejects_and_ignores_browser_provider_keys(authenticated_client, funded_wallet):
    response = authenticated_client.post("/api/projects", json={
        "title": "No keys", "project_type": "single_video", "text_key": "attacker-key", "video_key": "attacker-key"
    })
    assert response.status_code == 200
    assert "key" not in response.text.lower()
    assert "quote_id" not in response.text


def test_user_cannot_read_another_users_job_or_generated_asset(user_client, another_users_billed_job):
    assert user_client.get(f"/api/billing/jobs/{another_users_billed_job.id}").status_code == 404
    assert user_client.get(another_users_billed_job.result_url).status_code == 404
```

- [ ] **Step 2: Run integration tests and observe old key requirements/single batch job behavior**

Run: `python -m pytest server/tests/test_api.py server/tests/test_image_generation.py server/tests/test_openmontage_runner.py -v`

Expected: FAIL because paid request schemas still require browser keys, the image adapter/route is absent, and render billing hooks do not exist.

- [ ] **Step 3: Implement the quote/hold/execute/status decision table and preserve references on failures**

Remove `text_key`, `image_key`, `video_key`, and client `base_url` from public request models. Server provider adapters build one `PreparedNewApiRequest` from validated server-side inputs and pass the same immutable bytes to quote and real execution. Quote IDs and NewAPI tokens remain backend-only. Capture `X-Oneapi-Request-Id` for synchronous text/image calls. Update `SyapiVideo` to return public `task_id` in `ToolResult.data` for completed, failed, and timed-out polls; normal and recovered billing paths call the Task 9 `resume_billed_video_job(job_id)` entry rather than submitting from `SyapiVideo` again. Do not include its API key, quote ID, request content, result URL, or backend result locator in schemas, browser results, errors, or logs.

`server/app/provider/image_generation.py` exposes `prepare_image_generation_request(model, prompt, count, size, quality) -> PreparedNewApiRequest` and `generate_billed_project_image(...) -> ImageGenerationResult`. The prepared JSON targets `/v1/images/generations` with exact `model`, `prompt`, `n`, `size`, `quality`, and `response_format`; it contains no client key and no price/factor. `generate_billed_project_image` calls `execute_billed_provider_call(capability="image", operation="image_generation", ...)`, parses the response, stores the image through the existing media boundary as hidden, and passes that `StagedProviderResult` to `finalize_billed_sync_result`; only receipt capture makes the artifact visible. Text adapters use the same hidden-stage/finalize order for optimizer/storyboard output. Mount `POST /api/projects/{project_id}/images/generate` under `require_user` plus project ownership; accept only prompt/model/count/size/quality, never credentials or cost, and return no quote/reference/result-locator metadata.

```python
@dataclass(frozen=True, slots=True)
class ProviderCallContext:
    job_id: str
    token_kind: Literal["text", "image", "video"]
    execution: QuotedExecutionResult


@dataclass(frozen=True, slots=True)
class StagedProviderResult:
    locator: str
    sha256: str
    value: object


class ProviderResultPending(RuntimeError):
    pass


class ProviderResultUnavailable(RuntimeError):
    pass


class ProviderPricingUnstable(RuntimeError):
    pass


class PaymentRequiredQuote(RuntimeError):
    pass


def recover_accepted_reference(*, child: GenerationJob, capability: TokenKind,
                               status: UsageQuoteStatus) -> None:
    if status.reference_type is None or status.reference_id is None:
        billing.mark_reference_recovery_pending(child.id)
        raise ProviderResultPending
    if capability in {"text", "image"}:
        billing.fail_undeliverable_sync_call(
            child.id, status.reference_type, status.reference_id)
        raise ProviderResultUnavailable
    billing.bind_provider_reference(child.id, status.reference_type, status.reference_id)
    billing.mark_receipt_pending(child.id)
    raise ProviderResultPending


def execute_billed_provider_call(*, user_id: str, project_id: str, parent_job_id: str | None,
                                 capability: TokenKind, operation: str,
                                 request: PreparedNewApiRequest,
                                 retry_job_id: str | None = None) -> ProviderCallContext:
    if retry_job_id is None:
        quote = newapi.quote(capability, request)
        child = billing.reserve_provider_call(
            user_id=user_id, project_id=project_id, parent_job_id=parent_job_id,
            capability=capability, operation=operation, provider_method=request.method,
            provider_route=request.path, quote=quote)
    else:
        child = billing.load_owned_payment_required_quote(
            retry_job_id, user_id=user_id, project_id=project_id)
        if (child.capability, child.operation, child.provider_method, child.provider_route) != (
                capability, operation, request.method, request.path):
            raise InvalidBillingState("quote retry does not match original operation")
        fresh = newapi.quote(capability, request, token_alias=child.token_alias)
        outcome = billing.replace_job_quote(child.id, fresh)
        if outcome == "provider_pricing_unavailable_no_charge":
            raise ProviderPricingUnavailable
        if outcome == "payment_required_quote":
            raise PaymentRequiredQuote
        child = billing.load_job(child.id)
    stale_retries = 0
    while True:
        try:
            result = newapi.execute_quoted(
                capability, child.token_alias, request, child.quote_id)
            billing.bind_provider_reference(child.id, result.reference_type, result.reference_id)
            break
        except (QuoteStale, AmbiguousNewApiResult):
            try:
                status = newapi.get_quote_status(
                    capability, child.token_alias, child.quote_id)
            except (QuoteNotFound, InvalidNewApiResponse):
                billing.mark_reference_recovery_pending(child.id)
                raise ProviderResultPending
            if status.status in {"consuming", "accepted"}:
                recover_accepted_reference(
                    child=child, capability=capability, status=status)
            if status.status not in {"quoted", "expired", "failed"}:
                billing.mark_reference_recovery_pending(child.id)
                raise ProviderResultPending
            if stale_retries >= settings.billing_quote_stale_retries:
                billing.fail_unsubmitted(child.id, "provider_pricing_unstable_no_charge")
                raise ProviderPricingUnstable
            stale_retries += 1
            try:
                fresh = newapi.quote(
                    capability, request, token_alias=child.token_alias)
            except NewApiRateLimited:
                billing.fail_unsubmitted(child.id, "provider_quote_rate_limited_no_charge")
                raise
            outcome = billing.replace_job_quote(child.id, fresh)
            if outcome == "provider_pricing_unavailable_no_charge":
                raise ProviderPricingUnavailable
            if outcome == "payment_required_quote":
                raise PaymentRequiredQuote
        except (NewApiCallError, NewApiRateLimited):
            try:
                status = newapi.get_quote_status(
                    capability, child.token_alias, child.quote_id)
            except (QuoteNotFound, InvalidNewApiResponse):
                billing.mark_reference_recovery_pending(child.id)
                raise ProviderResultPending
            if status.status in {"consuming", "accepted"}:
                recover_accepted_reference(
                    child=child, capability=capability, status=status)
            if status.status in {"quoted", "expired", "failed"}:
                billing.fail_unsubmitted(child.id, "provider_rejected_no_charge")
            else:
                billing.mark_reference_recovery_pending(child.id)
            raise
    return ProviderCallContext(
        job_id=child.id, token_kind=capability, execution=result)


def retry_payment_required_quote(*, job_id: str, user_id: str, project_id: str,
                                 capability: TokenKind, operation: str,
                                 request: PreparedNewApiRequest) -> ProviderCallContext:
    return execute_billed_provider_call(
        user_id=user_id, project_id=project_id, parent_job_id=None,
        capability=capability, operation=operation, request=request,
        retry_job_id=job_id)


def finalize_billed_sync_result(
        context: ProviderCallContext,
        persist_hidden: Callable[[str, httpx.Response], StagedProviderResult],
        *, now: datetime) -> StagedProviderResult:
    if context.token_kind not in {"text", "image"}:
        raise ValueError("sync finalization supports only text/image")
    staged = persist_hidden(context.job_id, context.execution.response)
    billing.stage_result(context.job_id, staged.locator, staged.sha256)
    reconcile_job_now(db, newapi, context.job_id, now)
    if not load_job(context.job_id).result_visible:
        raise ProviderResultPending
    return staged
```

For a normal video submission, the adapter passes `ProviderCallContext.job_id` directly to `resume_billed_video_job`; for an ambiguous/409/429 accepted task, the worker reaches the same function after quote-status recovery. That function must stage and verify the downloaded video before `reconcile_job_now` may capture its receipt. A task receipt can be stored while the task is incomplete, but `result_pending` keeps the hold active and `result_visible=False` until the video artifact exists.

Apply a bounded `BILLING_QUOTE_STALE_RETRIES=2`; after two confirmed unconsumed stale cycles, release the hold as `provider_pricing_unstable_no_charge` because no upstream call occurred. A 409, execution-time 429, explicit execution error, or ambiguous timeout never permits re-quote until status proves `quoted`, `expired`, or pre-acceptance `failed`. A valid `consuming|accepted` task reference only binds/polls; a valid synchronous request reference without its original deliverable calls `fail_undeliverable_sync_call` and charges zero. Missing/malformed/404 quote status becomes `reference_recovery_pending` and never resubmits. An initial 429 quote response returns `provider_quote_rate_limited` before child/hold creation; a 429 during safe re-quote releases the existing hold as `provider_quote_rate_limited_no_charge`. Invalid/unsupported/zero-price quotes return `provider_pricing_unavailable` before initial child/hold/upstream, or release an existing stale hold as `provider_pricing_unavailable_no_charge`. Map `ProviderResultUnavailable` to HTTP 502 code `provider_result_unavailable` without provider content or references. Map insufficient fresh-quote growth to HTTP 402 `payment_required_quote`; the retry path always refreshes an expired quote before resizing/executing.

Each paid operation's ordinary authenticated endpoint accepts an optional backend-issued `billing_job_id` only when resubmitting the full validated business payload after `payment_required_quote`; it never accepts a quote ID, token, amount, or cost. The server verifies job ownership/project/operation/method/route, rebuilds `PreparedNewApiRequest`, calls `retry_payment_required_quote`, and always quotes with the job's original token alias before atomically replacing the snapshot/hold. It reuses the same child and immutable multiplier, creates no second hold, and performs no upstream call until resize succeeds. A fresh quote 429 leaves the old hold/job retryable; another funding shortfall remains HTTP 402. Because the server intentionally stores no prompt/body/media, omitting the full business payload makes retry invalid rather than guessing or replaying stored content.

- [ ] **Step 4: Make render parent aggregation explicit and run integration tests**

`render_short_drama_project` creates no billable job itself. The API creates a parent, invokes `generate_billed_shot` only for shots without reusable output, records each child outcome, and performs local FFmpeg composition without a hold. Successful children remain billed and reusable. Failed children are zero charge. Parent status is `complete`, `partial_failure`, or `failed`; it never drives wallet entries.

Only expose/download a generated child result after its final receipt transaction sets `result_visible=True`. A parent final render is visible only after every included generated child is billed successfully and composition passes. Quote amount never unlocks a result.

At application wiring, install `WalletProvisioner` into the auth registration service so user and zero-balance wallet are inserted in the same SQLAlchemy transaction. Include wallet, payment, and billing routers only after the auth router/dependencies are present.

Run: `python -m pytest server/tests/test_api.py server/tests/test_image_generation.py server/tests/test_openmontage_runner.py server/tests/test_billing_service.py server/tests/test_billing_refunds.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app/main.py server/app/models.py server/app/storyboard_generator.py server/app/prompt_optimizer.py server/app/openmontage_runner.py server/app/provider/image_generation.py tools/video/syapi_video.py server/tests/test_api.py server/tests/test_image_generation.py server/tests/test_openmontage_runner.py
git commit -m "feat(billing): bill each provider call independently"
```

### Task 11: Administrator Multiplier, Products, Orders, And Reconciliation API

**Files:**
- Create: `server/app/admin/billing_router.py`
- Create: `server/tests/test_billing_admin.py`
- Modify: `server/app/main.py`

**Interfaces:**
- Consumes: auth `require_admin`/`require_csrf`, billing/payment models, reconciliation service.
- Produces: administrator APIs and audited global multiplier changes.

- [ ] **Step 1: Write admin authorization and multiplier snapshot tests**

```python
# server/tests/test_billing_admin.py
def test_normal_user_cannot_change_multiplier(user_client):
    assert user_client.put("/api/admin/billing/settings", json={"multiplier_bps": 18000, "reason": "pricing"}).status_code == 403


def test_admin_change_is_audited_and_only_affects_new_jobs(admin_client, existing_child):
    response = admin_client.put("/api/admin/billing/settings", json={"multiplier_bps": 18000, "reason": "cost review"})
    assert response.status_code == 200
    assert load_job(existing_child.id).multiplier_bps == 15000
    assert create_child_after_change().multiplier_bps == 18000
    audit = latest_admin_audit()
    assert audit.action == "billing.multiplier.update"
    assert "15000" in audit.before_json and "18000" in audit.after_json
```

- [ ] **Step 2: Run admin tests and confirm routes are absent**

Run: `python -m pytest server/tests/test_billing_admin.py -v`

Expected: FAIL with 404.

- [ ] **Step 3: Implement narrow admin routers and audit transactions**

Mount:

```text
GET /api/admin/billing/settings
PUT /api/admin/billing/settings
GET|POST|PUT|DELETE /api/admin/topup-products
GET /api/admin/payment-orders
GET /api/admin/wallet-entries
GET /api/admin/billing-reconciliations
POST /api/admin/billing-reconciliations/{id}/retry
```

Validate multiplier against configured integer bounds `10000 <= multiplier_bps <= 100000`; require a non-empty reason; lock singleton settings; write `AdminAuditLog` in the same transaction. Product changes snapshot only future orders. Retry endpoints enqueue by changing `next_retry_at` and never directly create a wallet debit. User and browser-facing admin DTOs expose job/reconciliation status and sanitized errors but omit quote IDs, billing fingerprints, `OtherRatios`, token aliases/keys, provider references, backend result locators, and result hashes unless an operator-only non-browser export explicitly requires them.

- [ ] **Step 4: Run admin tests**

Run: `python -m pytest server/tests/test_billing_admin.py server/tests/test_billing_service.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app/admin/billing_router.py server/app/main.py server/tests/test_billing_admin.py
git commit -m "feat(admin): manage billing and reconciliation"
```

### Task 12: Wallet, Orders, And Billing Administration Frontend

**Files:**
- Create: `web/src/billing/types.ts`
- Create: `web/src/billing/api.ts`
- Create: `web/src/pages/WalletPage.tsx`
- Create: `web/src/pages/OrdersPage.tsx`
- Create: `web/src/pages/admin/BillingAdminPage.tsx`
- Create: `web/src/pages/WalletPage.test.tsx`
- Create: `web/src/pages/admin/BillingAdminPage.test.tsx`
- Modify after frontend/auth merges: `web/src/domain/types.ts`
- Modify after frontend/auth merges: `web/src/api/client.ts`
- Modify after frontend/auth merges: `web/src/app/routes.ts`
- Modify after frontend/auth merges: `web/src/App.tsx`
- Modify after frontend/auth merges: `web/src/components/shell/AppShell.tsx`
- Delete after frontend/auth merges: `web/src/components/shell/ProviderDrawer.tsx`
- Delete after frontend/auth merges: `web/src/components/KeyGate.tsx`
- Modify: `web/src/i18n.ts`

**Interfaces:**
- Consumes: Tasks 6 and 11 APIs plus auth `useAuth`.
- Produces: user recharge/wallet/order pages, admin billing page, and no browser provider configuration.

- [ ] **Step 1: Wait for shared frontend merges and write page tests**

```tsx
// web/src/pages/WalletPage.test.tsx
it("creates an order from a product id and posts the returned form", async () => {
  mockWalletApi({ balance_units: 1000, held_units: 200, available_units: 800 });
  mockProducts([{ id: "prod10", title: "10元额度", price_cny_fen: 1000, credit_units: 10_000_000 }]);
  mockCreateOrder({ order_id: "o1", action_url: "https://pay.example/submit.php", form_fields: { pid: "1", sign: "signed" } });
  renderWallet();
  await userEvent.click(await screen.findByRole("button", { name: "支付宝充值 10元额度" }));
  expect(createPaymentOrder).toHaveBeenCalledWith("prod10");
  expect(submitGatewayForm).toHaveBeenCalledWith("https://pay.example/submit.php", expect.objectContaining({ sign: "signed" }));
});

it("never renders provider or merchant secrets", async () => {
  renderWallet();
  expect(screen.queryByText(/API Key|商户密钥|NewAPI Token|quote_id|Usage Quote/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run frontend tests and confirm pages are missing**

Run: `npm test -- --run src/pages/WalletPage.test.tsx src/pages/admin/BillingAdminPage.test.tsx`

Working directory: `web`

Expected: FAIL because billing pages do not exist.

- [ ] **Step 3: Implement wallet/order pages and secure gateway form submission**

Display account balance, active holds separately as “预计最多消耗”, and available balance. Render products from the server with Alipay command buttons. `submitGatewayForm` creates a transient hidden HTML form with only returned gateway fields, posts to the returned HTTPS action, then removes the form; do not log form fields. Order return query triggers polling of the OpenMontage order endpoint and never locally credits balance.

Wallet entries show top-up/consumption amount, source, status, and timestamp. Orders show pending/paid/expired with merchant order number masked for normal display.

- [ ] **Step 4: Implement admin billing page, remove key UI, and verify**

Use a bounded integer/decimal multiplier editor mapping `1.500x` to `15000`, require a reason, list products/orders/reconciliations, and expose a retry command for open items. Remove `ProviderDrawer`, `KeyGate`, all provider key fields, and all key-bearing request properties. Replace the temporary shell recharge button with wallet balance and a route to `/wallet`.

Run: `npm test -- --run`

Run: `npm run build`

Working directory: `web`

Expected: all tests PASS and no TypeScript reference to browser provider credentials remains.

Run: `rg -n "text_key|image_key|video_key|API Key|ProviderDrawer|KeyGate" web/src`

Expected: no runtime matches; test fixtures may mention rejected legacy fields only.

- [ ] **Step 5: Commit**

```bash
git add web/src/billing web/src/pages/WalletPage.tsx web/src/pages/OrdersPage.tsx web/src/pages/admin web/src/domain/types.ts web/src/api/client.ts web/src/app/routes.ts web/src/App.tsx web/src/components/shell web/src/i18n.ts
git commit -m "feat(billing): add wallet and admin ui"
```

### Task 13: End-To-End Verification, Token Rotation, And Operations Runbook

**Files:**
- Create: `server/tests/test_billing_e2e.py`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `deploy/docker-compose.infrastructure.yml`

**Interfaces:**
- Consumes: all tasks in both repositories and completed auth plan.
- Produces: deployable payment/billing workflow and incident/rotation procedures.

- [ ] **Step 1: Write end-to-end success and failure tests**

```python
# server/tests/test_billing_e2e.py
def test_recharge_then_successful_video_charge(e2e_client, epay, newapi):
    user = register_and_login(e2e_client)
    order = create_and_notify_topup(e2e_client, epay, product_id="prod10")
    before = wallet_snapshot(user.id)
    result = generate_one_shot(e2e_client, newapi, task_status="SUCCESS", quota=1_449_000)
    after = wallet_snapshot(user.id)
    assert order.status == "paid"
    assert before.balance_units - after.balance_units == 4_347_000
    assert result.result_visible is True
    assert count_entries(f"consume:{result.job_id}") == 1
    assert newapi.quote_call_count == 1
    assert newapi.execute_quote_ids == [load_job(result.job_id).quote_id]
    assert newapi.upstream_accept_count == 1


def test_failed_refunded_video_keeps_full_user_balance(e2e_client, epay, newapi):
    user = register_topup_and_login(e2e_client, epay)
    before = wallet_snapshot(user.id)
    result = generate_one_shot(e2e_client, newapi, task_status="FAILURE",
        task_quota=15_834_000, refund_log_quota=15_834_000)
    after = wallet_snapshot(user.id)
    assert after.balance_units == before.balance_units
    assert after.held_units == 0
    assert consumption_for(result.job_id) is None


def test_ambiguous_accepted_call_recovers_reference_and_calls_upstream_once(e2e_client, newapi):
    newapi.drop_response_after_accept = True
    newapi.quote_status_after_drop = quote_status(
        status="accepted", reference_type="task", reference_id="task_recovered")
    result = generate_one_shot(e2e_client, newapi, task_status="SUCCESS", quota=1_449_000)
    job = load_job(result.job_id)
    assert job.provider_reference_id == "task_recovered"
    assert job.result_staged is True and job.result_visible is True
    assert artifact_store.exists(job.result_locator, sha256=job.result_sha256)
    assert newapi.upstream_accept_count == 1
    assert newapi.task_status_ids == ["task_recovered"]
    assert newapi.task_content_ids == ["task_recovered"]
    assert count_entries(f"consume:{result.job_id}") == 1


@pytest.mark.parametrize("operation", ["prompt_optimize", "image_generation"])
def test_accepted_sync_call_without_reference_is_never_replayed_or_charged(
        e2e_client, newapi, operation):
    newapi.return_sync_success_without_request_header = True
    newapi.quote_status_after_call = quote_status(
        status="accepted", reference_type="request", reference_id="req_recovered")
    before = wallet_for(e2e_client.user_id)
    result = run_sync_operation(e2e_client, newapi, operation)
    after = wallet_for(e2e_client.user_id)
    assert result.error_code == "provider_result_unavailable"
    assert after.balance_units == before.balance_units
    assert hold_for(result.job_id).status == "released"
    assert consumption_for(result.job_id) is None
    assert load_job(result.job_id).result_visible is False
    assert newapi.upstream_accept_count == 1
    assert newapi.quote_status_call_count == 1


def test_receipt_cost_not_quote_cost_is_charged(e2e_client, newapi):
    result = generate_one_shot(
        e2e_client, newapi, quote_cost_micro=2_000_000, receipt_cost_micro=2_500_000)
    assert hold_for(result.job_id).amount_units == 3_000_000
    assert consumption_for(result.job_id).amount_units == -3_750_000


def test_successful_image_uses_image_quote_and_request_receipt(e2e_client, newapi):
    result = generate_project_image(
        e2e_client, newapi, model="gpt-image-2", count=2,
        quote_cost_micro=1_000_000, receipt_cost_micro=1_000_000)
    job = load_job(result.job_id)
    assert job.token_kind == "image" and job.token_alias == "image-v1"
    assert newapi.request_paths == ["/v1/images/generations", "/v1/images/generations"]
    assert receipt_for(job.id).reference_type == "request"
    assert result.result_visible is True


def test_token_rotation_keeps_old_job_on_its_original_alias(e2e_client, rotated_newapi):
    old_job = seed_pending_job(token_kind="video", token_alias="video-v1")
    rotated_newapi.current_aliases["video"] = "video-v2"
    reconcile_job(old_job.id, rotated_newapi)
    assert rotated_newapi.receipt_aliases == ["video-v1"]
    new_job = generate_one_shot(e2e_client, rotated_newapi)
    assert load_job(new_job.job_id).token_alias == "video-v2"
```

- [ ] **Step 2: Run complete OpenMontage verification**

Run: `python -m pytest server/tests -v`

Run: `python -m alembic check`

Run: `rg -n "get_pricing|estimate_hold|model_price|model_ratio|tiered_expr|duration_factor|resolution_factor" server/app`

Run: `npm test -- --run && npm run build`

Working directory for the last command: `web`

Expected: all tests PASS, no pending migration diff, no OpenMontage billing-estimator match, and frontend build succeeds.

- [ ] **Step 3: Run complete NewAPI verification on all supported database-safe code paths**

Run: `go test ./controller ./model ./service ./middleware ./relay ./router -count=1`

Run: `go test ./... -count=1`

Working directory: `C:\Users\zhuba\Desktop\api\new-api-source-0229dc2` on `main`.

Run the PostgreSQL quote matrix:

```powershell
docker run --rm -d --name newapi-quote-pg -e POSTGRES_USER=quote -e POSTGRES_PASSWORD=quote -e POSTGRES_DB=quote -p 55432:5432 postgres:16-alpine
docker exec newapi-quote-pg pg_isready -U quote -d quote
$env:USAGE_QUOTE_TEST_DIALECT='postgres'; $env:USAGE_QUOTE_TEST_DSN='host=127.0.0.1 port=55432 user=quote password=quote dbname=quote sslmode=disable'; go test ./model -run TestUsageQuoteDialectIntegration -count=1
docker rm -f newapi-quote-pg
```

Expected: `pg_isready` reports accepting connections and the Go test PASS. If readiness has not completed, rerun only the readiness command before the test.

Run the MySQL quote matrix:

```powershell
docker run --rm -d --name newapi-quote-mysql -e MYSQL_ROOT_PASSWORD=quote -e MYSQL_DATABASE=quote -p 53306:3306 mysql:8.4
docker exec newapi-quote-mysql mysqladmin ping -h 127.0.0.1 -pquote
$env:USAGE_QUOTE_TEST_DIALECT='mysql'; $env:USAGE_QUOTE_TEST_DSN='root:quote@tcp(127.0.0.1:53306)/quote?charset=utf8mb4&parseTime=True&loc=Local'; go test ./model -run TestUsageQuoteDialectIntegration -count=1
docker rm -f newapi-quote-mysql
Remove-Item Env:USAGE_QUOTE_TEST_DIALECT, Env:USAGE_QUOTE_TEST_DSN -ErrorAction SilentlyContinue
```

Expected: `mysqld is alive` and the Go test PASS. SQLite coverage comes from the ordinary model suite and the file-backed reopen/two-handle tests. If the machine lacks Go or Docker, run the same commands in NewAPI CI before merge and do not mark Task 3 or Task 13 complete until all three dialects are green.

- [ ] **Step 4: Document exact production setup and incident handling**

Document:

- create the three named ordinary tokens under the admin account with fixed text/image/video groups and model allowlists;
- configure `NEWAPI_BASE_URL`, `NEWAPI_{TEXT,IMAGE,VIDEO}_TOKEN_KEYS_JSON`, and `NEWAPI_{TEXT,IMAGE,VIDEO}_CURRENT_TOKEN_ALIAS` in server secrets; aliases are non-secret, keys never appear in checked-in examples;
- configure OpenMontage `BILLING_REFERENCE_RECOVERY_SECONDS=86400`, `BILLING_RECEIPT_DEADLINE_SECONDS=86400`, `BILLING_HOLD_TIMEOUT_SECONDS=86400`, `BILLING_QUOTE_STALE_RETRIES=2`, and `BILLING_MAX_VIDEO_BYTES=536870912`;
- configure NewAPI `USAGE_QUOTE_RETENTION_SECONDS=604800` and `USAGE_QUOTE_REFERENCE_RECOVERY_SECONDS=86400`, and reject startup unless retention is greater than quote execution lifetime and recovery seconds;
- configure `EPAY_BASE_URL`, `EPAY_PARTNER_ID`, `EPAY_MERCHANT_KEY`, public HTTPS notify/return URLs, and Alipay-only products;
- run `python -m server.billing_worker` as a separate supervised service;
- keep NewAPI consume logging enabled and retain logs beyond the maximum OpenMontage receipt/reconciliation deadline; keep quote rows for the configured 7-day retention;
- alert on quote-stale rate, quote-status recovery age/errors, missing retired token aliases, `payment_required_quote`, receipt overrun, open reconciliation age, callback signature failures, cleanup failures, and worker heartbeat;
- rotate a capability token by adding `*-v2` to its server keyring and making it current for new jobs; keep `*-v1` enabled while any job on that alias may still execute, poll a task, or download/stage a result, including `reserved`, `payment_required_quote`, `reference_recovery_pending`, `receipt_pending`, and `result_pending`; only after every such job is terminal or has its result staged may NewAPI disable the token while OpenMontage retains its alias/key for historical quote-status and receipt reads; remove the retired alias/key and delete the NewAPI token only after no job references the alias, all recovery/receipt deadlines have elapsed, and 7-day quote retention has elapsed;
- for an ambiguous timeout or 409, inspect token-scoped quote status first; never manually replay an accepted/consuming quote reference;
- on `refund_pending`, keep the user at zero charge and resolve the upstream cost operationally;
- rotate every credential previously pasted into chat or logs before production deployment.

Run the Alipay sandbox checklist against one dedicated product/order: create the order from `product_id` and record its zero initial credit; submit one correctly signed `TRADE_SUCCESS` notify with the exact amount and verify HTTP body `success`, one paid transition, and one `topup:{order_id}` entry; submit the identical notify concurrently eight times and verify the balance/entry count stays unchanged; submit a valid signature with a one-fen amount mismatch against a fresh order and verify `fail`, pending order, and zero credit; finally visit only the signed return URL for another pending order and verify redirect/status display with zero credit. Record masked merchant order IDs and database assertions in the deployment checklist, never signatures or keys.

Run: `rg -n "sk-[A-Za-z0-9]{20,}|EPAY_MERCHANT_KEY=[^<[:space:]]{8,}|NEWAPI_.*TOKEN_KEYS_JSON=.*sk-" .env.example README.md docs server web`

Expected: no live secret match.

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example deploy/docker-compose.infrastructure.yml server/tests/test_billing_e2e.py
git commit -m "test(billing): verify payment and refund workflows"
```

## Completion Gate

The implementation is complete only when all conditions hold:

1. A duplicate or concurrent 易支付 notify creates one paid order transition and one wallet credit.
2. Quote-only text/image/video calls use NewAPI's existing billing engine and cause no NewAPI pre-consume, consume log, task/request side effect, or upstream I/O.
3. Quote and real paths produce identical billing fingerprints and pre-consume quota for token bounds, image count, tiered expressions, and every task adapter ratio.
4. A successful child stores one quote snapshot, one immutable multiplier snapshot, one hidden verified result artifact, one token-scoped final receipt, and one consumption entry derived only from receipt cost; visibility implies both staged result and billed receipt.
5. Price/group/model/route/channel/request-factor/version change returns stale before upstream; active hold resize is atomic and cannot overbook.
6. Insufficient fresh-quote growth enters `payment_required_quote`, retains the original hold, and performs no upstream call; expired retry obtains a new quote.
7. A 409, execution-time 429, missing execution reference, or ambiguous accepted timeout queries quote status and reaches upstream exactly once; recovered video tasks poll/download a verified visible asset before charging, while an unrecoverable synchronous result releases its hold and charges zero.
8. A failed video with residual `tasks.quota` and matching refund log charges zero and releases its hold.
9. A failed video without a refund log enters `refund_pending`, charges zero, releases its hold, and opens reconciliation.
10. A multi-shot render creates one non-billable parent and one quote/hold/receipt per actual upstream shot call; partial failure never erases or double-charges successful children.
11. Changing the global multiplier affects only children created afterward and writes an administrator audit record; every re-quote retains its existing child's original multiplier snapshot.
12. Normal users cannot access admin billing APIs or another user's wallet/orders/jobs; cross-token quote/receipt lookup is 404.
13. The browser contains no quote ID, NewAPI token, provider key, merchant secret, provider settings drawer, or key-bearing paid request field.
14. Token rotation snapshots the current alias on new jobs, keeps old jobs on their original retained alias, and fails closed if that alias is removed prematurely.
15. OpenMontage contains no model/duration/resolution/adapter pricing table or provider-cost estimator.
16. OpenMontage backend/frontend tests, Alembic checks, NewAPI Go tests, and manual Alipay sandbox notification tests all pass.
