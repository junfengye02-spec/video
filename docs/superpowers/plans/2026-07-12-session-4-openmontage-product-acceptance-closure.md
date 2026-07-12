# Session 4: OpenMontage Product Acceptance Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the ordered acceptance batches, browser:control-in-app-browser for human-click verification, superpowers:systematic-debugging for any failure, and superpowers:verification-before-completion before reporting success. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close automated, database, LocalDB, billing E2E, browser, responsive, security-scan, and operations gates on the completed product behavior before architecture refactoring.

**Architecture:** This session is an acceptance owner, not a feature owner. It runs the real system through focused-to-broad gates, fixes only demonstrated regressions in their owning modules, records unavailable consequential external checks honestly, and freezes a green behavior baseline for Sessions 5-6.

**Tech Stack:** Pytest, Alembic, PostgreSQL, React/Vitest/Vite, Chromium browser control, IndexedDB, OPFS, Vite module Workers, Docker.

## Global Constraints

- Repository: `C:\Users\zhuba\Desktop\OpenMontage\videro` on `main`.
- Read `AGENTS.md`, `AGENT_GUIDE.md`, and `PROJECT_CONTEXT.md` before action.
- Sessions 1, 2, and 3 must be complete. Verify code and tests; do not trust plan checkboxes.
- Preserve unrelated dirty files and never reset/stash the user's worktree.
- Use mock/test providers for safe browser workflows. Do not spend money or call production providers without dedicated test credentials and explicit scope.
- Do not count skipped PostgreSQL, browser, Worker, or Alipay checks as passing.
- If Alipay sandbox credentials alone are unavailable, finish every other gate and record that one external blocker. Sessions 5-6 may proceed only under that exact exception.
- A regression fix must include a failing test and a focused commit before rerunning broad gates.

## Start Gate

- [ ] **Step 1: Verify merged deliverables**

```powershell
git status --short --branch
git log -20 --oneline
Test-Path server/app/admin/billing_router.py
Test-Path web/src/pages/WalletPage.tsx
Test-Path web/src/pages/admin/BillingAdminPage.tsx
Test-Path web/src/components/accessibility/useModalFocus.ts
rg -n 'ProviderDrawer|KeyGate|text_key|image_key|video_key' web/src
```

Expected: all new files exist and provider-key runtime scan has no production matches. Stop if prerequisites are absent.

- [ ] **Step 2: Verify Session 1 contract in NewAPI read-only**

Working directory: `C:\Users\zhuba\Desktop\api\new-api-source-0229dc2`.

```powershell
go test ./controller -run '^TestQuotedSyncForcedChannelFailureDoesNotFallback$' -count=20
```

Expected: PASS. Do not edit NewAPI in this session; send failures back to Session 1.

### Task 1: Static And Automated Frontend Gates

**Files:**
- Modify only if required: `docs/superpowers/plans/2026-06-30-short-drama-workbench-web.md`
- Verify: `web/src`

- [ ] **Step 1: Remove secret-shaped documentation fixtures without weakening scans**

Replace fake key samples in the named legacy plan with `test-key-redacted` and update only corresponding masked assertions. Do not add scanner exceptions.

- [ ] **Step 2: Run exact static scans**

```powershell
rg -n 'sk-[A-Za-z0-9_-]{12,}' web/src docs/superpowers
rg -n 'shot_count' web/src
rg -n 'ProviderDrawer|KeyGate|text_key|image_key|video_key' web/src
rg -n 'wallet|/login|/wallet|/orders|/admin/billing' web/src/app web/src/App.tsx
```

Expected: no secret or provider-key runtime match; `shot_count` only in compatibility/omission tests; account/billing routes are the approved real routes.

- [ ] **Step 3: Run LocalDB and complete frontend suites**

```powershell
Set-Location web
npm.cmd test -- --run src/localdb/backupImport.worker.test.ts src/localdb/backupArchiveClient.test.ts src/localdb/backupDirectoryImport.test.ts src/localdb/exportProject.test.ts src/localdb/projectStore.test.ts src/localdb/mediaStore.test.ts src/localdb/mediaJournal.test.ts src/localdb/mediaUrls.test.ts
npm.cmd test -- --run
npm.cmd run build
```

Expected: all tests and build PASS.

- [ ] **Step 4: Commit documentation-only scan cleanup if changed**

```powershell
Set-Location ..
git add docs/superpowers/plans/2026-06-30-short-drama-workbench-web.md
git commit -m "docs: remove secret-shaped test examples"
```

Skip commit if no file changed.

### Task 2: Billing End-To-End Regression Suite

**Files:**
- Create: `server/tests/test_billing_e2e.py`
- Modify only for demonstrated regression: owning files under `server/app/billing`, `server/app/wallet`, `server/app/payments`, or `server/app/provider`

**Interfaces:**
- Produces: cross-module proof for recharge, quote, hold, receipt, refund, ambiguous recovery, image billing, and token alias rotation.

- [ ] **Step 1: Add deterministic E2E fixtures and tests**

Use in-process FastAPI clients and fake Epay/NewAPI implementations. Cover:

```python
def test_recharge_then_successful_video_charge(e2e):
    order = e2e.create_and_notify_topup(product_id="prod10")
    before = e2e.wallet()
    result = e2e.generate_video(status="SUCCESS", quota=1_449_000)
    after = e2e.wallet()
    assert order.status == "paid"
    assert before.balance_units - after.balance_units == 4_347_000
    assert e2e.count_entries(f"consume:{result.job_id}") == 1
    assert e2e.newapi.upstream_accept_count == 1


def test_failed_refunded_video_keeps_full_balance(e2e):
    before = e2e.wallet()
    result = e2e.generate_video(status="FAILURE", task_quota=15_834_000, refund_log_quota=15_834_000)
    after = e2e.wallet()
    assert after.balance_units == before.balance_units
    assert after.held_units == 0
    assert e2e.consumption_for(result.job_id) is None
```

Also cover accepted response loss without replay, receipt cost overriding quote estimate, image request receipts, duplicate payment notify, and old token alias recovery after rotation.

- [ ] **Step 2: Run RED then GREEN**

```powershell
$env:AUTH_HMAC_SECRET='test-auth-hmac-secret-at-least-32-bytes'
python -m pytest server/tests/test_billing_e2e.py -v
```

Expected: new tests expose any remaining wiring gap; fix only proven regressions with focused tests.

- [ ] **Step 3: Commit E2E coverage and scoped fixes**

```powershell
git add server/tests/test_billing_e2e.py server/app/billing server/app/wallet server/app/payments server/app/provider
git commit -m "test(billing): verify payment and refund workflows"
```

Stage only files actually changed.

### Task 3: PostgreSQL And Full Backend Gates

- [ ] **Step 1: Start an isolated PostgreSQL test database**

```powershell
docker run --rm -d --name openmontage-session4-pg -e POSTGRES_USER=openmontage -e POSTGRES_PASSWORD=openmontage -e POSTGRES_DB=openmontage_test -p 55433:5432 postgres:16-alpine
docker exec openmontage-session4-pg pg_isready -U openmontage -d openmontage_test
$env:OPENMONTAGE_TEST_POSTGRES_URL='postgresql+psycopg://openmontage:openmontage@127.0.0.1:55433/openmontage_test'
$env:OPENMONTAGE_TEST_POSTGRES_ACK='openmontage_test'
```

- [ ] **Step 2: Run migration/schema and PostgreSQL concurrency gates**

```powershell
python -m alembic upgrade head
python -m alembic check
python -m pytest server/tests/test_auth_postgres.py server/tests/test_wallet_service.py server/tests/test_billing_service.py server/tests/test_billing_refunds.py -q
```

Expected: no migration diff and PostgreSQL tests PASS without skip.

- [ ] **Step 3: Run full backend and clean infrastructure**

```powershell
python -m pytest server/tests -q
docker rm -f openmontage-session4-pg
Remove-Item Env:OPENMONTAGE_TEST_POSTGRES_URL, Env:OPENMONTAGE_TEST_POSTGRES_ACK -ErrorAction SilentlyContinue
```

Expected: all runnable tests pass. Always remove the container and environment variables.

### Task 4: Real Browser And LocalDB Acceptance

**Files:**
- Modify only after a reproduced failure: the owning frontend test and implementation module.

- [ ] **Step 1: Start isolated local services**

Start FastAPI with test-safe provider settings on `127.0.0.1:8787` and Vite on an unused port such as `5173`. Record PIDs and stop them after acceptance.

- [ ] **Step 2: Verify three viewports**

Using `browser:control-in-app-browser`, inspect `1440x900`, `1024x768`, and `390x844` for login/register, projects, new project, storyboard, settings, resources, production, wallet, orders, and admin billing. Assert no horizontal overflow, clipping, incoherent overlap, hidden actions, or simultaneous modal drawers.

- [ ] **Step 3: Verify real Worker and directory import**

Through visible UI controls, import a valid `.omproj` with the Vite module Worker while a main-thread heartbeat remains responsive; reject a high-compression archive; simulate Worker construction failure and verify `选择已解压备份`; verify directory success, missing/duplicate file errors, cancellation, conflict handling, and no partial visible project.

- [ ] **Step 4: Verify durable media behavior**

Verify remote generated/rendered media appears before cache completion, `local://` never reaches visible text or media attributes, reload resolves committed media, startup/visibility recovery processes due operations once, cross-tab leases prevent duplicate cleanup, project deletion removes the project logically while failed OPFS cleanup remains journaled.

- [ ] **Step 5: Verify safe human-click workflow**

Click project open, shot selection, save/regenerate separation, deep-link reload, back/forward, settings draft guard, mutually exclusive drawers, delete cancel/confirm, account menu, logout/login return URL, wallet navigation, order display, admin role denial, and 402 recovery. Console errors must remain zero and network mutations must not duplicate.

- [ ] **Step 6: Record consequential flow status**

Run provider generation, render, upload, final download, and payment submission only with dedicated test fixtures. Otherwise record each exact item as `not executed: test credential or sandbox fixture unavailable`; never infer success.

### Task 5: Operations Runbook And Alipay Sandbox

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `deploy/docker-compose.infrastructure.yml`

- [ ] **Step 1: Document production settings and worker**

Document named text/image/video token aliases and keyrings without keys; OpenMontage recovery/receipt/hold deadlines; NewAPI quote retention; Epay base URL/partner/key environment names; public notify/return URLs; supervised billing worker; alert conditions; accepted-quote no-replay incident flow; `refund_pending`; and staged token rotation through retained aliases.

- [ ] **Step 2: Run the sandbox checklist when credentials exist**

Create one dedicated product/order; submit one valid exact-amount `TRADE_SUCCESS` notify and verify `success`, one paid transition, and one `topup:{order_id}` entry; submit the identical notify concurrently eight times and verify no extra credit; submit a signed one-fen mismatch to a fresh order and verify `fail` with zero credit; visit only a signed return URL for another pending order and verify status display with zero credit. Record masked IDs only.

- [ ] **Step 3: Scan secrets and commit operations docs**

```powershell
rg -n 'sk-[A-Za-z0-9]{20,}|EPAY_MERCHANT_KEY=[^<[:space:]]{8,}|NEWAPI_.*TOKEN_KEYS_JSON=.*sk-' .env.example README.md docs server web
git add README.md .env.example deploy/docker-compose.infrastructure.yml
git commit -m "docs(billing): add operations and rotation runbook"
```

Expected: no live secret match.

### Task 6: Freeze Acceptance Baseline And Handoff

- [ ] **Step 1: Re-run final automated gates after every browser fix**

```powershell
$env:AUTH_HMAC_SECRET='test-auth-hmac-secret-at-least-32-bytes'
python -m pytest server/tests -q
python -m alembic check
Set-Location web
npm.cmd test -- --run
npm.cmd run build
```

- [ ] **Step 2: Review worktree and commits**

```powershell
Set-Location ..
git diff --check
git status --short --branch
git log -12 --oneline
```

- [ ] **Step 3: Write the Session 5 gate report**

Report exact backend/frontend/PostgreSQL totals, build result, all three viewport results, Worker/directory/LocalDB results, console/network findings, billing E2E results, operations docs commit, and every unexecuted consequential flow. Session 5 may start only when all code/database/browser gates are green; an unavailable Alipay sandbox credential is the sole permitted external exception.
