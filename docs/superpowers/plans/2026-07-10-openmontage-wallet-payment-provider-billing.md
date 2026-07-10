# OpenMontage Wallet Payment And Provider Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenMontage-owned wallet and Alipay recharge flow, route all paid model calls through three server-held NewAPI tokens, charge from token-scoped final cost receipts using an administrator-controlled global multiplier, and release users from every failed or refunded asynchronous video charge.

**Architecture:** OpenMontage owns products, orders, wallet balances, holds, immutable entries, billing jobs, multiplier snapshots, and reconciliation in its PostgreSQL database. NewAPI remains the model gateway and source of actual provider cost; three ordinary fixed-group tokens gain only token-scoped pricing and receipt reads. Every upstream call is one billable child job with its own hold and provider reference, while a multi-shot render is a non-billable parent batch.

**Tech Stack:** Python 3.10+, FastAPI, SQLAlchemy 2, PostgreSQL 16, Redis 7, psycopg 3, httpx, React 18, TypeScript 5.6, pytest; NewAPI Go 1.22+, Gin, GORM v2, testify, SQLite/MySQL/PostgreSQL-compatible queries.

## Global Constraints

- OpenMontage wallets, payment orders, and users are independent from NewAPI; an OpenMontage recharge never changes NewAPI user quota.
- Reuse the proven 易支付/Alipay protocol and merchant settings, but create and settle OpenMontage orders in OpenMontage PostgreSQL.
- The browser never receives or stores NewAPI tokens, upstream keys, 易支付 merchant secrets, or NewAPI admin access tokens.
- Use three ordinary tokens under the current NewAPI admin account: `openmontage-text-prod`, `openmontage-image-prod`, and `openmontage-video-prod`, each fixed to its intended group and model allowlist.
- OpenMontage charges `ceil(provider_cost_micro * multiplier_bps / 10_000)`; `multiplier_bps=15000` means `1.5x`.
- Store one global `multiplier_bps`; copy it into every billable child job when the job is created. Later changes affect only new jobs.
- Payment amounts are integer CNY fen; wallet, hold, and charge values are integer `credit_units`; no floating-point money is stored.
- NewAPI cost snapshots store integer quota, `quota_per_unit`, integer micro-USD, and pricing version.
- Model calls freeze an explainable non-zero upper bound before calling NewAPI; missing, `auto`-group, or unsupported dynamic pricing rejects the call.
- A `generation_job` represents exactly one NewAPI call. Multi-shot render batches are non-billable parents; each generated shot is a billable child with a separate hold and receipt.
- A successful child settles from its own final receipt. A failed child creates no consumption entry and releases only its own hold.
- NewAPI video `FAILURE` with a refund log is `refunded`; `FAILURE` without a refund log is `refund_pending`. Both charge the OpenMontage user zero and release the hold immediately.
- NewAPI `tasks.quota` is never treated as a failed-video charge because production data proves refunded failed tasks can retain the original quota.
- Payment callbacks verify signature, merchant order number, provider, Alipay type, trade status, and exact amount before one atomic order-plus-wallet transaction.
- Browser return URLs display status only; only the verified asynchronous notify endpoint credits a wallet.
- All payment, wallet, hold, receipt, callback, polling, and retry operations are idempotent under concurrency and process restart.
- NewAPI changes must use `common.Marshal`/`common.Unmarshal`, support SQLite, MySQL, and PostgreSQL, obey `pkg/billingexpr/expr.md`, and use testify `require`/`assert` in new Go tests.
- NewAPI consume logging must remain enabled and retained longer than the OpenMontage receipt deadline; if it is disabled or unavailable, synchronous receipts cannot settle and OpenMontage releases the hold at timeout rather than charging from an estimate.
- Billing migrations use revisions `010-019` and consume only `CurrentUser`, `require_user`, `require_admin`, `require_csrf`, `UserProvisioner`, and `get_db` from the auth plan.
- Implement NewAPI changes in an isolated worktree created with `superpowers:using-git-worktrees`; do not use the existing wallet worktree with uncommitted session changes.
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

## NewAPI Read-Only Contracts

```text
GET /api/usage/pricing/model/{model}
GET /api/usage/receipt/request/{request_id}
GET /api/usage/receipt/task/{task_id}
Authorization: Bearer <the same ordinary token that made the model call>
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
  "cost_currency": "USD",
  "cost_amount_micro": 2898000,
  "settled_at": 1783389175
}
```

Allowed receipt statuses are `pending`, `settled`, `refunded`, `refund_pending`, and `not_chargeable`. A reference belonging to another token returns 404 rather than revealing its existence.

## File Structure

### NewAPI Repository: `C:\Users\zhuba\Desktop\api\new-api-source-0229dc2`

Create:

- `dto/usage_receipt.go` - token pricing and receipt response structs/status constants.
- `model/usage_receipt.go` - token-scoped log/task/refund lookups.
- `controller/usage_receipt.go` - read-only pricing/request/task handlers.
- `controller/usage_receipt_test.go` - authorization and residual-quota refund tests.
- `model/usage_receipt_test.go` - cross-database-safe query behavior on SQLite.

Modify:

- `model/log.go` - indexed `task_id` field and task billing log population.
- `model/main.go` - GORM/ClickHouse log schema migration for `task_id`.
- `service/task_billing.go` - pass task ID into consume/refund logs.
- `middleware/auth.go` - historical receipt-only authentication for disabled-but-retained tokens.
- `middleware/auth_test.go` - active-user and disabled-token historical read coverage.
- `router/api-router.go` - mount pricing and historical receipt endpoints under the correct read-only middleware.
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
- `server/app/billing/estimator.py` - explainable hold upper bounds.
- `server/app/billing/service.py` - parent/child job lifecycle and receipt settlement.
- `server/app/billing/reconciliation.py` - retry/timeout/refund reconciliation.
- `server/billing_worker.py` - PostgreSQL-backed reconciliation worker loop.
- `server/app/provider/newapi.py` - three-token routing, pricing, invocation, and receipt client.
- `server/app/admin/billing_router.py` - multiplier, products, orders, entries, and reconciliation admin APIs.
- `server/tests/test_wallet_service.py` - concurrency and idempotency.
- `server/tests/test_epay.py` - signatures, exact amount, callback concurrency, and return behavior.
- `server/tests/test_billing_service.py` - holds, multipliers, parent/child jobs, and settlement.
- `server/tests/test_billing_refunds.py` - failed video, residual quota, delayed refund, and missing receipt.
- `server/tests/test_newapi_client.py` - token routing and secret redaction.
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

**Repository:** `C:\Users\zhuba\Desktop\api\new-api-source-0229dc2` isolated worktree.

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

- [ ] **Step 1: Create an isolated NewAPI worktree**

Use `superpowers:using-git-worktrees`, verify `git status --short` is empty in the new worktree, and base it on the production source commit. Do not reuse a worktree containing wallet/session edits.

Expected: `git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`, and the worktree status is clean.

- [ ] **Step 2: Write failing residual-quota and token-isolation model tests**

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

- [ ] **Step 3: Run focused Go tests and confirm missing symbols**

Run: `go test ./model -run 'Test(Task|Request)Receipt' -count=1`

Expected: FAIL because `GetTaskUsageReceipt`, `Log.TaskId`, and receipt types do not exist.

- [ ] **Step 4: Implement receipt DTOs, indexed task IDs, and GORM queries**

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

- [ ] **Step 5: Run model tests and commit**

Run: `go test ./model ./service -run 'Test(Task|Request|ClickHouse).*Receipt|TestClickHouse' -count=1`

Expected: PASS.

```bash
git add dto/usage_receipt.go model/usage_receipt.go model/usage_receipt_test.go model/log.go model/main.go service/task_billing.go model/clickhouse_log_test.go
git commit -m "feat(usage): add token scoped receipt queries"
```

### Task 2: NewAPI Pricing And Receipt HTTP Endpoints

**Repository:** NewAPI isolated worktree.

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

- [ ] **Step 1: Write failing handler tests for ownership, refunded failures, and fixed-group pricing**

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

- [ ] **Step 2: Run handler tests and confirm 404/unregistered routes**

Run: `go test ./controller -run 'TestGet.*UsageReceipt|TestGetTokenModelPricing' -count=1`

Expected: FAIL because handlers/routes are absent.

- [ ] **Step 3: Implement handlers and integer micro-USD conversion**

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

- [ ] **Step 4: Mount routes under existing read-only token middleware and verify**

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

- [ ] **Step 5: Commit**

```bash
git add controller/usage_receipt.go controller/usage_receipt_test.go dto/usage_receipt.go middleware/auth.go middleware/auth_test.go router/api-router.go
git commit -m "feat(usage): expose token scoped cost receipts"
```

### Task 3: OpenMontage Wallet, Payment, And Billing Schema

**Repository:** OpenMontage auth-compatible worktree.

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
```

- [ ] **Step 2: Run model tests and confirm models are missing**

Run: `python -m pytest server/tests/test_billing_models.py -v`

Expected: FAIL with missing wallet/payment/billing modules.

- [ ] **Step 3: Implement exact integer models and constraints**

`WalletAccount` has unique `user_id`, `balance_units >= 0`, `held_units >= 0`, `held_units <= balance_units`, and optimistic `version`. `WalletEntry` has signed `amount_units`, balance-after snapshot, kind, source type/ID, unique `idempotency_key`, and no update path. `WalletHold` has unique `job_id`, positive amount, state `active|released|captured`, timestamps, and reason.

`PaymentOrder` snapshots product ID/title, `price_cny_fen`, `credit_units`, unique merchant order number, provider `epay`, method `alipay`, state, unique non-null provider trade number, and timestamps. `TopupProduct` stores integer price/credits and enabled/sort fields.

`GenerationJob` includes `parent_job_id`, `chargeable`, user/project, operation/capability, token kind, model, estimate inputs JSON, pricing version, `multiplier_bps`, provider reference type/ID, status, result visibility, and timestamps. Enforce a PostgreSQL partial unique index on non-null `(provider_reference_type, provider_reference_id, token_kind)`. `CostReceipt` stores the full normalized receipt plus raw canonical JSON/hash. `BillingSetting` is singleton ID 1. `BillingReconciliation` stores reason, status, job ID, attempts, next retry, and last error.

- [ ] **Step 4: Add migrations and verify against PostgreSQL**

Revision `010` creates wallet/payment tables. Revision `011` creates billing tables and parent/child FK. Revision `012` adds PostgreSQL partial unique indexes and final check constraints; migrations never read deployment environment variables and contain no merchant/token secret. `ensure_billing_settings(db, settings)` requires `BILLING_DEFAULT_MULTIPLIER_BPS` on first deployment, inserts singleton row ID 1 once, and never overwrites an administrator-updated row; the deployment example uses `15000`. Products are created explicitly through the administrator API, so migrations do not invent prices or credits.

Run: `python -m alembic upgrade 012`

Run: `python -m pytest server/tests/test_billing_models.py -v`

Expected: migrations succeed and tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app/wallet/models.py server/app/wallet/provisioning.py server/app/payments/models.py server/app/billing/models.py server/app/billing/bootstrap.py server/alembic/versions/010_wallet_payment_tables.py server/alembic/versions/011_billing_job_tables.py server/alembic/versions/012_billing_constraints.py server/tests/test_billing_models.py
git commit -m "feat(billing): add wallet and billing schema"
```

### Task 4: Atomic Wallet Credits, Holds, Releases, And Charges

**Files:**
- Create: `server/app/wallet/service.py`
- Create: `server/tests/test_wallet_service.py`
- Modify: `server/app/wallet/provisioning.py`

**Interfaces:**
- Consumes: Task 3 models and a caller-owned SQLAlchemy transaction.
- Produces: `credit`, `create_hold`, `release_hold`, `capture_hold`, `available_units`, and `WalletProvisioner.provision`.

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


def test_failed_job_release_is_idempotent(db_session, active_hold):
    release_hold(db_session, active_hold.job_id, reason="provider_failed")
    release_hold(db_session, active_hold.job_id, reason="provider_failed")
    db_session.commit()
    assert load_wallet(db_session, active_hold.user_id).held_units == 0
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
    wallet = db.scalar(select(WalletAccount).where(WalletAccount.user_id == user_id).with_for_update())
    if wallet is None or wallet.balance_units - wallet.held_units < amount_units:
        raise InsufficientBalance
    existing = db.scalar(select(WalletHold).where(WalletHold.job_id == job_id))
    if existing is not None:
        return existing
    wallet.held_units += amount_units
    wallet.version += 1
    hold = WalletHold(id=uuid.uuid4().hex, user_id=user_id, job_id=job_id,
                      amount_units=amount_units, status="active", expires_at=expires_at)
    db.add(hold)
    db.flush()
    return hold
```

`credit` catches the unique idempotency entry inside the same transaction and returns the existing entry without applying balance again. `capture_hold` locks job, hold, and wallet in that order; releases held units, deducts the final charge, inserts `consume:{job_id}`, and never allows negative balance. When charge exceeds the hold and available funds are insufficient, it leaves the original hold active and returns `payment_required` without creating a consumption entry.

- [ ] **Step 4: Run SQLite unit tests and PostgreSQL concurrency tests**

Run: `python -m pytest server/tests/test_wallet_service.py -v`

Expected: PASS; exactly one concurrent overbooking attempt succeeds.

- [ ] **Step 5: Commit**

```bash
git add server/app/wallet/service.py server/app/wallet/provisioning.py server/tests/test_wallet_service.py
git commit -m "feat(wallet): add atomic holds and entries"
```

### Task 5: 易支付 Alipay Orders And Idempotent Notify Settlement

**Files:**
- Create: `server/app/payments/epay.py`
- Create: `server/app/payments/service.py`
- Create: `server/app/payments/router.py`
- Create: `server/app/wallet/router.py`
- Create: `server/tests/test_epay.py`
- Modify: `server/app/core/config.py`
- Modify: `.env.example`

**Interfaces:**
- Consumes: auth dependencies, wallet `credit`, payment models.
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

Keep the fixed hash above as a regression vector for the exact canonical fixture. `create_order` accepts only `product_id`; it locks/loads the enabled product and snapshots its integer price and credits. It generates an unpredictable unique merchant order number and returns action URL plus form fields. The client never submits amount or credits.

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

### Task 6: Three-Token NewAPI Client And Explainable Cost Estimation

**Files:**
- Create: `server/app/provider/newapi.py`
- Create: `server/app/billing/money.py`
- Create: `server/app/billing/estimator.py`
- Create: `server/tests/test_newapi_client.py`
- Modify: `server/app/core/config.py`
- Modify: `.env.example`
- Modify: `requirements.txt`

**Interfaces:**
- Consumes: NewAPI Task 2 HTTP contracts.
- Produces: `NewApiClient.for_capability`, `get_pricing`, `get_request_receipt`, `get_task_receipt`, and `estimate_hold_units`.

- [ ] **Step 1: Write token routing, redaction, and integer conversion tests**

```python
# server/tests/test_newapi_client.py
def test_capability_uses_only_its_server_token(httpx_mock, settings):
    httpx_mock.add_response(url=f"{settings.newapi_base_url}/api/usage/pricing/model/gpt-image-2", json=PRICING)
    client = NewApiClient(settings)
    client.get_pricing("image", "gpt-image-2")
    request = httpx_mock.get_request()
    assert request.headers["Authorization"] == f"Bearer {settings.newapi_image_api_key.get_secret_value()}"


def test_client_error_and_repr_do_not_expose_tokens(settings, httpx_mock):
    httpx_mock.add_response(status_code=500, text="gateway failed")
    with pytest.raises(NewApiError) as error:
        NewApiClient(settings).get_pricing("video", "omni_flash-10s")
    assert settings.newapi_video_api_key.get_secret_value() not in repr(error.value)
    assert settings.newapi_video_api_key.get_secret_value() not in repr(NewApiClient(settings))


def test_charge_uses_integer_ceiling():
    assert provider_micro_to_charge_units(2_898_001, 15_000) == 4_347_002
```

- [ ] **Step 2: Run client tests and confirm modules are absent**

Run: `python -m pytest server/tests/test_newapi_client.py -v`

Expected: FAIL with missing provider/billing modules.

- [ ] **Step 3: Implement secret-safe token routing and receipt parsing**

```python
# server/app/provider/newapi.py
TokenKind = Literal["text", "image", "video"]

class NewApiClient:
    def __init__(self, settings: AppSettings, transport: httpx.BaseTransport | None = None):
        self._base_url = settings.newapi_base_url.rstrip("/")
        self._tokens = {
            "text": settings.newapi_text_api_key,
            "image": settings.newapi_image_api_key,
            "video": settings.newapi_video_api_key,
        }
        self._client = httpx.Client(timeout=30, transport=transport)

    def _headers(self, kind: TokenKind) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._tokens[kind].get_secret_value()}"}

    def get_task_receipt(self, kind: TokenKind, task_id: str) -> UsageReceipt:
        return self._get(kind, f"/api/usage/receipt/task/{quote(task_id, safe='')}", UsageReceipt)
```

Use `SecretStr` for all three token settings. `_get` maps 404 to `ReceiptNotFound`, validates Pydantic response models, and never embeds headers/body credentials in exception messages. Invocation methods return the NewAPI `X-Oneapi-Request-Id` response header for synchronous calls and public `task_id` for video calls.

- [ ] **Step 4: Implement explainable ceilings and rejection rules**

```python
# server/app/billing/money.py
def ceil_div(numerator: int, denominator: int) -> int:
    if numerator < 0 or denominator <= 0:
        raise ValueError("invalid integer ratio")
    return (numerator + denominator - 1) // denominator


def provider_micro_to_charge_units(provider_cost_micro: int, multiplier_bps: int) -> int:
    return ceil_div(provider_cost_micro * multiplier_bps, 10_000)
```

`estimate_hold_units` accepts a token-scoped pricing snapshot and controlled inputs. Fixed-price image/video calls calculate maximum quota from model price, fixed group ratio, bounded count/duration/resolution, and `quota_per_unit`. Text calls use server-enforced maximum input/output tokens plus completion ratio. Reject `estimable=false`, `auto` group, zero/negative factors, unknown model, out-of-range duration/count, or unsupported `tiered_expr`. Persist the exact inputs and `pricing_version` on the job.

Run: `python -m pytest server/tests/test_newapi_client.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add requirements.txt .env.example server/app/core/config.py server/app/provider/newapi.py server/app/billing/money.py server/app/billing/estimator.py server/tests/test_newapi_client.py
git commit -m "feat(provider): add token routed newapi client"
```

### Task 7: Parent/Child Billing Jobs And Final Receipt Settlement

**Files:**
- Create: `server/app/billing/service.py`
- Create: `server/tests/test_billing_service.py`
- Modify: `server/app/billing/models.py`

**Interfaces:**
- Consumes: wallet service, NewAPI client, estimator, billing models.
- Produces: `create_parent_job`, `reserve_provider_call`, `bind_provider_reference`, `settle_job`, `fail_job`, and `retry_payment_required`.

- [ ] **Step 1: Write multiplier snapshot, child isolation, and duplicate settlement tests**

```python
# server/tests/test_billing_service.py
def test_multiplier_change_does_not_change_existing_child(db_session, billing_service, funded_wallet):
    parent = billing_service.create_parent_job(user_id=funded_wallet.user_id, project_id="p1", operation="render")
    child = billing_service.reserve_provider_call(user_id=funded_wallet.user_id, project_id="p1",
        parent_job_id=parent.id, capability="video", model="omni_flash-10s",
        estimate_inputs={"duration": 10}, hold_units=6_000_000)
    set_global_multiplier(db_session, 20_000)
    billing_service.settle_job(child.id, settled_receipt(cost_amount_micro=2_898_000))
    assert load_job(child.id).multiplier_bps == 15_000
    assert consumption_for(child.id).amount_units == -4_347_000


def test_one_failed_shot_releases_only_its_hold(db_session, billing_service, funded_wallet):
    parent = billing_service.create_parent_job(user_id=funded_wallet.user_id, project_id="p1", operation="render")
    first = reserve_video_child(billing_service, parent.id, shot_id="s1")
    second = reserve_video_child(billing_service, parent.id, shot_id="s2")
    billing_service.settle_job(first.id, settled_receipt(cost_amount_micro=1_000_000))
    billing_service.fail_job(second.id, refund_pending_receipt())
    assert consumption_for(first.id).amount_units < 0
    assert consumption_for(second.id) is None
    assert hold_for(second.id).status == "released"


def test_duplicate_receipt_settles_once(db_session, billing_service, child_job):
    receipt = settled_receipt(cost_amount_micro=1_000_000)
    billing_service.settle_job(child_job.id, receipt)
    billing_service.settle_job(child_job.id, receipt)
    assert count_consumptions(child_job.id) == 1
```

- [ ] **Step 2: Run billing tests and confirm service is missing**

Run: `python -m pytest server/tests/test_billing_service.py -v`

Expected: FAIL with missing `billing.service`.

- [ ] **Step 3: Implement parent creation, child reservation, and immutable snapshots**

```python
# server/app/billing/service.py
def reserve_provider_call(self, *, user_id: str, project_id: str, parent_job_id: str | None,
                          capability: TokenKind, model: str, estimate_inputs: dict,
                          hold_units: int) -> GenerationJob:
    setting = self.db.get(BillingSetting, 1, with_for_update=True)
    job = GenerationJob(id=uuid.uuid4().hex, parent_job_id=parent_job_id, chargeable=True,
        user_id=user_id, project_id=project_id, capability=capability, token_kind=capability,
        model=model, estimate_inputs_json=canonical_json(estimate_inputs),
        multiplier_bps=setting.multiplier_bps, status="reserved", result_visible=False)
    self.db.add(job)
    self.db.flush()
    create_hold(self.db, user_id=user_id, job_id=job.id, amount_units=hold_units,
                expires_at=utcnow() + self.settings.billing_hold_timeout)
    self.db.commit()
    return job
```

Parent jobs set `chargeable=False`, have no hold/provider reference/multiplier charge, and aggregate child statuses only. Bind provider reference in a transaction; a uniqueness conflict loads the existing job and refuses cross-user/project reuse.

- [ ] **Step 4: Implement receipt hashing and idempotent settlement states**

For `settled`, lock job, hold, and wallet; insert/update `CostReceipt` by provider reference; compute charge from the job multiplier snapshot; capture once; set `billed` and `result_visible=True`. For `refunded`, `refund_pending`, or `not_chargeable`, release once, create no consumption entry, set `failed_no_charge`, keep result hidden, and open reconciliation only for `refund_pending`. For `pending`, do not mutate funds. If actual charge exceeds available funds, leave the hold active, set `payment_required`, hide result, and retry after top-up.

Run: `python -m pytest server/tests/test_billing_service.py server/tests/test_wallet_service.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app/billing/service.py server/app/billing/models.py server/tests/test_billing_service.py
git commit -m "feat(billing): settle provider calls from receipts"
```

### Task 8: Failed Video Refund And Missing Receipt Reconciliation Worker

**Files:**
- Create: `server/app/billing/reconciliation.py`
- Create: `server/billing_worker.py`
- Create: `server/tests/test_billing_refunds.py`
- Modify: `server/manage.py`

**Interfaces:**
- Consumes: billing service and NewAPI receipt client.
- Produces: `reconcile_due_jobs(db, client, now, limit)`, `python -m server.billing_worker`, and `python -m server.manage reconcile-billing --once`.

- [ ] **Step 1: Write refund-pending, delayed refund, and missing receipt tests**

```python
# server/tests/test_billing_refunds.py
def test_failure_with_residual_quota_never_charges_user(billing_service, video_child):
    receipt = UsageReceipt(reference_type="task", reference_id="task_x", status="refund_pending",
        model="omni_flash-10s", quota=15_834_000, refunded_quota=0,
        quota_per_unit=500_000, cost_currency="USD", cost_amount_micro=0)
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


def test_upstream_accept_crash_without_bound_reference_becomes_no_charge(worker, unbound_submitted_job):
    worker.run_once(now=unbound_submitted_job.reference_deadline + timedelta(seconds=1))
    assert hold_for(unbound_submitted_job.id).status == "released"
    assert load_job(unbound_submitted_job.id).status == "provider_reference_missing_no_charge"
    assert reconciliation_for(unbound_submitted_job.id).reason == "provider_reference_missing"
```

- [ ] **Step 2: Run refund tests and confirm worker is missing**

Run: `python -m pytest server/tests/test_billing_refunds.py -v`

Expected: FAIL with missing reconciliation module.

- [ ] **Step 3: Implement PostgreSQL-backed polling with bounded retries**

`reconcile_due_jobs` selects due rows `FOR UPDATE SKIP LOCKED`, up to 100, and commits each item independently. Retry schedule is 5s, 15s, 30s, 60s, then every 5 minutes until deadline. It stores attempts, next retry, status, and sanitized error. `refund_pending` immediately releases the user's hold and stays open until `refunded`/`not_chargeable` or administrator resolution. If OpenMontage crashes after NewAPI accepts a request but before its response reference is bound, the persisted child reaches `reference_deadline`, releases its hold, becomes `provider_reference_missing_no_charge`, and opens an operator reconciliation; it is never charged from an estimate. Each worker pass also expires eligible 30-minute pending payment orders. Missing/invalid receipts never become a user charge.

```python
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

Run: `python -m pytest server/tests/test_billing_refunds.py server/tests/test_billing_service.py -v`

Expected: PASS with zero user charge in every failed/refunded/missing-receipt case.

- [ ] **Step 5: Commit**

```bash
git add server/app/billing/reconciliation.py server/billing_worker.py server/manage.py server/tests/test_billing_refunds.py
git commit -m "feat(billing): reconcile failed video refunds"
```

### Task 9: Integrate Billing Into Text, Image, Single-Shot, And Multi-Shot Calls

**Files:**
- Modify after auth merge: `server/app/main.py`
- Modify: `server/app/models.py`
- Modify: `server/app/storyboard_generator.py`
- Modify: `server/app/prompt_optimizer.py`
- Modify: `server/app/openmontage_runner.py`
- Modify: `tools/video/syapi_video.py`
- Modify: `server/tests/test_api.py`
- Modify: `server/tests/test_openmontage_runner.py`

**Interfaces:**
- Consumes: auth `CurrentUser`, owned projects, Tasks 6-8 services.
- Produces: server-token-only paid model calls, one billed child per upstream invocation, and a non-billable parent per render.

- [ ] **Step 1: Write no-browser-key and multi-shot billing tests**

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
```

- [ ] **Step 2: Run integration tests and observe old key requirements/single batch job behavior**

Run: `python -m pytest server/tests/test_api.py server/tests/test_openmontage_runner.py -v`

Expected: FAIL because paid request schemas still require browser keys and render billing hooks do not exist.

- [ ] **Step 3: Inject provider call context and preserve references on failures**

Remove `text_key`, `image_key`, `video_key`, and client `base_url` from public request models. Provider adapters receive server-side `ProviderCallContext(job_id, token_kind, model)` and obtain credentials only from `NewApiClient`. Capture `X-Oneapi-Request-Id` for synchronous text/image calls. Update `SyapiVideo` to return `task_id` in `ToolResult.data` for completed, failed, and timed-out polls; do not include its API key in schema, result, errors, or logs.

```python
@dataclass(frozen=True, slots=True)
class ProviderCallContext:
    job_id: str
    token_kind: Literal["text", "image", "video"]
    model: str


def generate_billed_shot(*, parent_job_id: str, shot: dict, user_id: str, project_id: str):
    child = billing.reserve_from_pricing(user_id=user_id, project_id=project_id,
        parent_job_id=parent_job_id, capability="video", model=video_model,
        operation=f"shot:{shot['id']}", estimate_inputs=bounded_video_inputs(shot))
    result = provider.generate_video(context=ProviderCallContext(child.id, "video", video_model), shot=shot)
    billing.bind_provider_reference(child.id, "task", result.task_id)
    billing.reconcile_now(child.id)
    return result
```

- [ ] **Step 4: Make render parent aggregation explicit and run integration tests**

`render_short_drama_project` creates no billable job itself. The API creates a parent, invokes `generate_billed_shot` only for shots without reusable output, records each child outcome, and performs local FFmpeg composition without a hold. Successful children remain billed and reusable. Failed children are zero charge. Parent status is `complete`, `partial_failure`, or `failed`; it never drives wallet entries.

Only expose/download a generated child result after its billing transaction sets `result_visible=True`. A parent final render is visible only after every included generated child is billed successfully and composition passes.

At application wiring, install `WalletProvisioner` into the auth registration service so user and zero-balance wallet are inserted in the same SQLAlchemy transaction. Include wallet, payment, and billing routers only after the auth router/dependencies are present.

Run: `python -m pytest server/tests/test_api.py server/tests/test_openmontage_runner.py server/tests/test_billing_service.py server/tests/test_billing_refunds.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app/main.py server/app/models.py server/app/storyboard_generator.py server/app/prompt_optimizer.py server/app/openmontage_runner.py tools/video/syapi_video.py server/tests/test_api.py server/tests/test_openmontage_runner.py
git commit -m "feat(billing): bill each provider call independently"
```

### Task 10: Administrator Multiplier, Products, Orders, And Reconciliation API

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

Validate multiplier against configured integer bounds `10000 <= multiplier_bps <= 100000`; require a non-empty reason; lock singleton settings; write `AdminAuditLog` in the same transaction. Product changes snapshot only future orders. Retry endpoints enqueue by changing `next_retry_at` and never directly create a wallet debit.

- [ ] **Step 4: Run admin tests**

Run: `python -m pytest server/tests/test_billing_admin.py server/tests/test_billing_service.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app/admin/billing_router.py server/app/main.py server/tests/test_billing_admin.py
git commit -m "feat(admin): manage billing and reconciliation"
```

### Task 11: Wallet, Orders, And Billing Administration Frontend

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
- Consumes: Tasks 5 and 10 APIs plus auth `useAuth`.
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
  expect(screen.queryByText(/API Key|商户密钥|NewAPI Token/i)).not.toBeInTheDocument();
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

### Task 12: End-To-End Verification, Token Rotation, And Operations Runbook

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


def test_failed_refunded_video_keeps_full_user_balance(e2e_client, epay, newapi):
    user = register_topup_and_login(e2e_client, epay)
    before = wallet_snapshot(user.id)
    result = generate_one_shot(e2e_client, newapi, task_status="FAILURE",
        task_quota=15_834_000, refund_log_quota=15_834_000)
    after = wallet_snapshot(user.id)
    assert after.balance_units == before.balance_units
    assert after.held_units == 0
    assert consumption_for(result.job_id) is None
```

- [ ] **Step 2: Run complete OpenMontage verification**

Run: `python -m pytest server/tests -v`

Run: `python -m alembic check`

Run: `npm test -- --run && npm run build`

Working directory for the last command: `web`

Expected: all tests PASS, no pending migration diff, and frontend build succeeds.

- [ ] **Step 3: Run complete NewAPI verification on all supported database-safe code paths**

Run: `go test ./controller ./model ./service ./router -count=1`

Run: `go test ./... -count=1`

Working directory: isolated NewAPI worktree.

Expected: all Go tests PASS. If the machine lacks Go, run these commands in the NewAPI CI/container before merge and do not mark the NewAPI portion complete until CI is green.

- [ ] **Step 4: Document exact production setup and incident handling**

Document:

- create the three named ordinary tokens under the admin account with fixed text/image/video groups and model allowlists;
- configure only `NEWAPI_BASE_URL`, `NEWAPI_TEXT_API_KEY`, `NEWAPI_IMAGE_API_KEY`, `NEWAPI_VIDEO_API_KEY` in server secrets;
- configure `EPAY_BASE_URL`, `EPAY_PARTNER_ID`, `EPAY_MERCHANT_KEY`, public HTTPS notify/return URLs, and Alipay-only products;
- run `python -m server.billing_worker` as a separate supervised service;
- keep NewAPI consume logging enabled and retain logs beyond the maximum OpenMontage receipt/reconciliation deadline;
- alert on open reconciliation age, receipt errors, callback signature failures, estimate-overrun jobs, and worker heartbeat;
- rotate a token by disabling the old token, retaining it for read-only historical receipts until all referenced jobs settle, then deleting it;
- on `refund_pending`, keep the user at zero charge and resolve the upstream cost operationally;
- rotate every credential previously pasted into chat or logs before production deployment.

Run: `rg -n "sk-[A-Za-z0-9]{20,}|EPAY_MERCHANT_KEY=.+|NEWAPI_.*API_KEY=.+" .env.example README.md docs server web`

Expected: no live secret match.

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example deploy/docker-compose.infrastructure.yml server/tests/test_billing_e2e.py
git commit -m "test(billing): verify payment and refund workflows"
```

## Completion Gate

The implementation is complete only when all conditions hold:

1. A duplicate or concurrent 易支付 notify creates one paid order transition and one wallet credit.
2. A successful text/image/video child stores one token-scoped final receipt, one multiplier snapshot, and one consumption entry.
3. A failed video with residual `tasks.quota` and matching refund log charges zero and releases its hold.
4. A failed video without a refund log enters `refund_pending`, charges zero, releases its hold, and opens reconciliation.
5. A multi-shot render creates one non-billable parent and one hold/receipt per actual upstream shot call; partial failure never erases or double-charges successful children.
6. Changing the global multiplier affects only children created afterward and writes an administrator audit record.
7. Normal users cannot access admin billing APIs or another user's wallet/orders/jobs.
8. The browser contains no NewAPI token, provider key, merchant secret, provider settings drawer, or key-bearing paid request field.
9. OpenMontage backend/frontend tests, Alembic checks, NewAPI Go tests, and manual Alipay sandbox notification tests all pass.
