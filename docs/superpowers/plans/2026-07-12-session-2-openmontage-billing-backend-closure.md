# Session 2: OpenMontage Billing Backend Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans task-by-task. Use superpowers:systematic-debugging for any unexpected failure, superpowers:test-driven-development for every fix, and superpowers:verification-before-completion before reporting success. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove wall-clock-sensitive billing tests and implement authenticated administrator billing APIs required by the frontend.

**Architecture:** Production billing continues to use injected clocks at service boundaries; high-level provider adapters expose optional `now` only for deterministic tests. A focused admin router uses existing auth, payment, wallet, billing, reconciliation, and audit models; mutations require both administrator role and CSRF and commit business state with its audit record atomically.

**Tech Stack:** Python 3.10+, FastAPI, Pydantic v2, SQLAlchemy 2, Alembic, Pytest, SQLite, PostgreSQL.

## Global Constraints

- Repository: `C:\Users\zhuba\Desktop\OpenMontage\videro` on `main`.
- Read `AGENTS.md`, `AGENT_GUIDE.md`, and `PROJECT_CONTEXT.md` before editing.
- Preserve every pre-existing dirty file. Stage only files named by the current task.
- Session 1 may run concurrently in the separate NewAPI repository; do not edit that repository.
- Never expose provider tokens, quote IDs, billing fingerprints, provider references, result locators/hashes, merchant keys, raw callback fields, or internal errors in browser-facing admin DTOs.
- All admin mutations require `require_admin` and `require_csrf` semantics.
- Multiplier bounds are exact integers: `10000 <= multiplier_bps <= 100000`.
- No migration is added unless the existing models cannot satisfy an explicit API contract; run `alembic check` either way.

## Start Gate

- [ ] **Step 1: Record the protected worktree**

```powershell
git status --short --branch
git log -8 --oneline
```

Expected: `main` is ahead of origin and contains existing user changes. Record them; do not stash, reset, amend, or stage them.

- [ ] **Step 2: Confirm Task 11 is absent and reproduce time sensitivity**

```powershell
Test-Path server/app/admin/billing_router.py
Test-Path server/tests/test_billing_admin.py
$env:AUTH_HMAC_SECRET='test-auth-hmac-secret-at-least-32-bytes'
python -m pytest server/tests/test_image_generation.py server/tests/test_billing_service.py -q
```

Expected before implementation: admin files are absent. Time-sensitive tests may fail because fixed `2026-07-12` quote expirations are compared with the real clock.

### Task 1: Inject Time Through High-Level Billing Paths

**Files:**
- Modify: `server/app/provider/image_generation.py`
- Modify only if another failing high-level path requires it: `server/app/openmontage_runner.py`
- Modify: `server/tests/test_image_generation.py`
- Modify: `server/tests/test_billing_service.py`

**Interfaces:**
- Produces: optional `now: datetime | None = None` test seam; production callers remain source-compatible.
- Consumes: existing `execute_billed_provider_call`, `retry_payment_required_quote`, and `finalize_billed_sync_result` `now` parameters.

- [ ] **Step 1: Add a failing high-level deterministic-clock test**

Call the public image generation adapter with `now=NOW` and assert a quote expiring at `NOW + 120 seconds` is accepted even when the machine clock is later.

```python
result = generate_billed_project_image(
    db=db,
    newapi=client,
    settings=settings,
    media_store=store,
    user_id=USER_ID,
    project_id=PROJECT_ID,
    prompt="frame",
    model="gpt-image-2",
    count=1,
    size="1024x1024",
    quality="standard",
    now=NOW,
)
assert result.job_id
```

- [ ] **Step 2: Verify RED**

```powershell
python -m pytest server/tests/test_image_generation.py -k 'deterministic_clock' -v
```

Expected: FAIL because `generate_billed_project_image` does not accept `now`.

- [ ] **Step 3: Thread the optional clock without changing production defaults**

Add to the function signature:

```python
now: datetime | None = None,
```

Pass `now=now` to `execute_billed_provider_call` or `retry_payment_required_quote`, and to `finalize_billed_sync_result`. Import `datetime` for typing. Do the same only for another public adapter proven by a failing test to bypass the injected clock.

- [ ] **Step 4: Replace wall-clock-dependent fixture calls**

Keep deterministic `NOW` for expected timestamps. Ensure every high-level call that consumes its fixed quote passes `now=NOW`. Do not replace `NOW` with `datetime.now()` and do not move the fixture to another hard-coded future date.

- [ ] **Step 5: Verify and commit**

```powershell
python -m pytest server/tests/test_image_generation.py server/tests/test_billing_service.py -q
git add server/app/provider/image_generation.py server/app/openmontage_runner.py server/tests/test_image_generation.py server/tests/test_billing_service.py
git commit -m "test(billing): inject deterministic provider clock"
```

Expected: focused tests PASS. Stage `openmontage_runner.py` only if changed for a demonstrated clock path.

### Task 2: Administrator Billing Read APIs

**Files:**
- Create: `server/app/admin/__init__.py`
- Create: `server/app/admin/billing_router.py`
- Create: `server/tests/test_billing_admin.py`
- Modify: `server/app/main.py`

**Interfaces:**
- Produces: `GET /api/admin/billing/settings`, `GET /api/admin/topup-products`, `GET /api/admin/payment-orders`, `GET /api/admin/wallet-entries`, and `GET /api/admin/billing-reconciliations`.
- Consumes: `require_admin`, `get_db`, `BillingSettings`, `BillingReconciliation`, `TopupProduct`, `PaymentOrder`, and wallet entry models.

- [ ] **Step 1: Write failing authorization and redaction tests**

```python
@pytest.mark.parametrize("path", [
    "/api/admin/billing/settings",
    "/api/admin/topup-products",
    "/api/admin/payment-orders",
    "/api/admin/wallet-entries",
    "/api/admin/billing-reconciliations",
])
def test_admin_billing_reads_require_admin(user_client, path):
    assert user_client.get(path).status_code == 403


def test_admin_order_and_reconciliation_payloads_are_redacted(admin_client, seeded_billing):
    payload = admin_client.get("/api/admin/billing-reconciliations").json()
    rendered = json.dumps(payload)
    assert "quote_id" not in rendered
    assert "billing_fingerprint" not in rendered
    assert "provider_reference" not in rendered
    assert "result_locator" not in rendered
    assert seeded_billing.secret not in rendered
```

- [ ] **Step 2: Verify RED**

```powershell
python -m pytest server/tests/test_billing_admin.py -k 'reads' -v
```

Expected: FAIL with 404.

- [ ] **Step 3: Implement typed response models and bounded lists**

Use Pydantic response models with only display fields. Every list endpoint accepts `limit: int = Query(50, ge=1, le=200)` and an optional status filter validated against the corresponding model states. Order lists expose masked merchant order numbers, amount, product title snapshot, status, and timestamps. Reconciliation lists expose ID, job ID, kind, status, attempts, sanitized error code, next retry time, and timestamps.

- [ ] **Step 4: Mount the router and verify**

```python
from server.app.admin.billing_router import router as admin_billing_router

app.include_router(admin_billing_router)
```

Run:

```powershell
python -m pytest server/tests/test_billing_admin.py -k 'reads' -v
```

Expected: PASS.

### Task 3: Multiplier And Product Mutations With Atomic Audit

**Files:**
- Modify: `server/app/admin/billing_router.py`
- Modify: `server/tests/test_billing_admin.py`

**Interfaces:**
- Produces: `PUT /api/admin/billing/settings` and `POST|PUT|DELETE /api/admin/topup-products`.
- Consumes: `AdminAuditLog` and existing singleton billing settings/product models.

- [ ] **Step 1: Write failing mutation tests**

```python
def test_normal_user_cannot_change_multiplier(user_client):
    response = user_client.put(
        "/api/admin/billing/settings",
        json={"multiplier_bps": 18000, "reason": "pricing"},
    )
    assert response.status_code == 403


def test_admin_change_is_audited_and_only_affects_new_jobs(admin_client, db, existing_child):
    response = admin_client.put(
        "/api/admin/billing/settings",
        json={"multiplier_bps": 18000, "reason": "cost review"},
    )
    assert response.status_code == 200
    db.refresh(existing_child)
    assert existing_child.multiplier_bps == 15000
    assert current_multiplier(db) == 18000
    audit = latest_audit(db, "billing.multiplier.update")
    assert audit.before_json == '{"multiplier_bps":15000}'
    assert audit.after_json == '{"multiplier_bps":18000}'
```

Also cover missing reason, values `9999` and `100001`, duplicate product IDs, active-order product snapshots, and delete/deactivate behavior.

- [ ] **Step 2: Verify RED**

```powershell
python -m pytest server/tests/test_billing_admin.py -k 'multiplier or product' -v
```

- [ ] **Step 3: Implement locked transactional mutations**

Lock the singleton settings row with `select(...).with_for_update()`. Validate a stripped non-empty reason. Update `multiplier_bps` and increment `version`; add `AdminAuditLog` in the same transaction; commit once. Product mutations snapshot no existing orders and audit before/after JSON without gateway or secret fields.

- [ ] **Step 4: Verify GREEN**

```powershell
python -m pytest server/tests/test_billing_admin.py -k 'multiplier or product' -v
```

Expected: PASS.

### Task 4: Reconciliation Retry Command

**Files:**
- Modify: `server/app/admin/billing_router.py`
- Modify: `server/tests/test_billing_admin.py`

**Interfaces:**
- Produces: `POST /api/admin/billing-reconciliations/{reconciliation_id}/retry`.
- Behavior: schedules existing open reconciliation by setting `next_retry_at`; never debits a wallet or directly calls NewAPI.

- [ ] **Step 1: Write failing retry tests**

Assert missing reconciliation returns 404, closed reconciliation returns 409, normal user returns 403, CSRF is required, and an open reconciliation changes only scheduling/version fields plus one audit row.

```python
before_entries = count_wallet_entries(db)
response = admin_client.post(f"/api/admin/billing-reconciliations/{item.id}/retry")
assert response.status_code == 202
db.refresh(item)
assert item.next_retry_at <= utc_now()
assert count_wallet_entries(db) == before_entries
```

- [ ] **Step 2: Implement and verify**

```powershell
python -m pytest server/tests/test_billing_admin.py -k 'reconciliation' -v
```

Expected: PASS after implementation.

- [ ] **Step 3: Commit the complete admin API**

```powershell
git add server/app/admin/__init__.py server/app/admin/billing_router.py server/app/main.py server/tests/test_billing_admin.py
git commit -m "feat(admin): manage billing and reconciliation"
```

### Task 5: Backend Verification And Session 3 Contract

- [ ] **Step 1: Run focused billing/auth/payment tests**

```powershell
$env:AUTH_HMAC_SECRET='test-auth-hmac-secret-at-least-32-bytes'
python -m pytest server/tests/test_billing_admin.py server/tests/test_billing_service.py server/tests/test_image_generation.py server/tests/test_wallet_service.py server/tests/test_epay.py server/tests/test_auth_api.py -q
```

Expected: PASS; PostgreSQL-only tests may skip only when their explicit test DSN is absent.

- [ ] **Step 2: Run migrations and full backend**

```powershell
python -m alembic upgrade head
python -m alembic check
python -m pytest server/tests -q
```

Expected: no pending migration diff and all runnable tests pass. Report exact pass/skip totals.

- [ ] **Step 3: Verify browser contract and secret redaction**

```powershell
rg -n 'quote_id|billing_fingerprint|provider_reference|result_locator|result_sha256|token_key|merchant_key' server/app/admin server/tests/test_billing_admin.py
git diff --check HEAD~2..HEAD
git status --short --branch
```

Expected: sensitive names occur only in negative/redaction tests or internal selection code, never response fields. Worktree retains unrelated user changes.

- [ ] **Step 4: Handoff**

Report commit hashes, endpoint/method matrix, response model fields, focused/full test totals, migration result, and preserved dirty files. Session 3 starts only when these APIs and their tests are green.

