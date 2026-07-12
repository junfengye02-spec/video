# Session 1: NewAPI Quote Refund Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:systematic-debugging first, then superpowers:test-driven-development, and use superpowers:verification-before-completion before reporting success. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and close the quoted synchronous relay refund failure without changing the public usage-quote contract or hiding a real lost-refund defect behind timing tolerance.

**Architecture:** The quoted relay keeps its existing asynchronous `BillingSession.Refund` contract. Tests observe durable eventual state instead of assuming the goroutine pool completes before the HTTP handler returns; an integration replay proves the restored quota cannot be over-refunded. Production code changes are allowed only if the root-cause evidence shows quota remains wrong after the bounded eventual window.

**Tech Stack:** Go 1.25, Gin, GORM, Testify, SQLite, PostgreSQL 16, MySQL 8.4, Docker.

## Global Constraints

- Repository: `C:\Users\zhuba\Desktop\api\new-api-source-0229dc2`.
- Read the repository `AGENTS.md` before editing.
- Preserve the existing dirty `web/default/public/image2-playground` files; this plan does not stage, delete, regenerate, or reformat them.
- Keep usage-quote support compatible with SQLite, MySQL, and PostgreSQL.
- Do not make refund synchronous merely to satisfy an immediate test assertion.
- Do not weaken exact quota, one-upstream-call, one-pre-consume, quote-state, or no-consume-log assertions.
- Use `common` JSON wrappers and Testify `require`/`assert` per repository policy.

## Start Gate

- [ ] **Step 1: Confirm repository and protect unrelated changes**

Run:

```powershell
git status --short --branch
git log -5 --oneline
```

Expected: branch is `main`; only the pre-existing image2 playground files are dirty. Record any additional changes and do not touch them.

- [ ] **Step 2: Reproduce the observed race**

Run:

```powershell
go test ./controller -run '^TestQuotedSyncForcedChannelFailureDoesNotFallback$' -count=20
```

Expected before the fix: at least one run may fail at `controller/usage_quote_test.go` where stored user quota is read immediately after `ServeHTTP`.

### Task 1: Characterize Eventual Refund And Idempotency

**Files:**
- Modify: `controller/usage_quote_test.go`
- Inspect only: `controller/relay.go`
- Inspect only: `service/billing_session.go`

**Interfaces:**
- Consumes: `(*BillingSession).Refund(*gin.Context)` asynchronous, idempotent refund behavior.
- Produces: regression evidence that failed quoted execution restores the complete user quota and does so once.

- [ ] **Step 1: Replace only the immediate quota observation with a bounded eventual assertion**

Keep all assertions through quote state and consume-log count unchanged. Replace the final immediate user read with:

```go
require.Eventually(t, func() bool {
    var storedUser model.User
    if err := model.DB.First(&storedUser, fixture.user.Id).Error; err != nil {
        return false
    }
    return storedUser.Quota == fixture.user.Quota
}, 2*time.Second, 10*time.Millisecond, "failed quoted relay must restore the complete reserved quota")
```

Add `time` to imports if it is not already imported. Do not increase the window beyond two seconds.

- [ ] **Step 2: Extend the integration test with replay/no-over-refund proof**

After the eventual restoration succeeds, execute the same consumed quote a second time. It must be rejected before upstream and must not change the restored balance.

Core assertions in `controller/usage_quote_test.go`:

```go
replayResponse := httptest.NewRecorder()
engine.ServeHTTP(replayResponse, newRequest("req_sync_replay", quote.QuoteID, ""))
assert.NotEqual(t, http.StatusOK, replayResponse.Code)
assert.Equal(t, int32(1), forcedCalls.Load())
time.Sleep(100 * time.Millisecond)
require.NoError(t, model.DB.First(&storedUser, fixture.user.Id).Error)
assert.Equal(t, fixture.user.Quota, storedUser.Quota)
```

This tests the observable idempotency contract without reaching into private `BillingSession` fields.

- [ ] **Step 3: Run RED/GREEN focused tests**

Run before completing the test edit to confirm the immediate assertion can fail, then run after the edit:

```powershell
go test ./controller -run '^TestQuotedSyncForcedChannelFailureDoesNotFallback$' -count=50
```

Expected after the edit: the command PASS on every repetition.

- [ ] **Step 4: Escalate only if eventual state remains wrong**

If the two-second eventual assertion fails, do not extend the timeout. Capture user quota, token quota, `BillingSession` fields, and funding source after the timeout. Add a failing test that demonstrates the missing leg, then make the smallest production correction in `service/billing_session.go` so `funding.Refund()` and token restoration each occur once. Re-run Step 3.

- [ ] **Step 5: Commit the regression closure**

```powershell
git add controller/usage_quote_test.go service/billing_session.go
git commit -m "test(usage): await quoted refund completion"
```

Stage `service/billing_session.go` only if Task 1 Step 4 proved and fixed a production defect.

### Task 2: Verify Quote Lifecycle Packages

**Files:**
- Verify only: `controller/usage_quote_test.go`
- Verify only: `model/usage_quote_test.go`
- Verify only: `model/usage_quote_dialect_test.go`
- Verify only: `service/usage_quote_cleanup_test.go`
- Verify only: `middleware/usage_quote_rate_limit_test.go`
- Verify only: `relay/usage_quote_test.go`

- [ ] **Step 1: Run the quote-focused package gate**

```powershell
go test ./controller ./model ./service ./middleware ./relay -run 'UsageQuote|Quoted' -count=1
```

Expected: PASS with no lost-refund, duplicate-refund, replay, limiter, or quote-state failure.

- [ ] **Step 2: Run PostgreSQL quote integration**

```powershell
docker run --rm -d --name newapi-session1-pg -e POSTGRES_USER=quote -e POSTGRES_PASSWORD=quote -e POSTGRES_DB=quote -p 55432:5432 postgres:16-alpine
docker exec newapi-session1-pg pg_isready -U quote -d quote
$env:USAGE_QUOTE_TEST_DIALECT='postgres'
$env:USAGE_QUOTE_TEST_DSN='host=127.0.0.1 port=55432 user=quote password=quote dbname=quote sslmode=disable'
go test ./model -run '^TestUsageQuoteDialectIntegration$' -count=1
docker rm -f newapi-session1-pg
```

Expected: readiness succeeds and the dialect test passes. Always remove the container, including after failure.

- [ ] **Step 3: Run MySQL quote integration**

```powershell
docker run --rm -d --name newapi-session1-mysql -e MYSQL_ROOT_PASSWORD=quote -e MYSQL_DATABASE=quote -p 53306:3306 mysql:8.4
docker exec newapi-session1-mysql mysqladmin ping -h 127.0.0.1 -pquote
$env:USAGE_QUOTE_TEST_DIALECT='mysql'
$env:USAGE_QUOTE_TEST_DSN='root:quote@tcp(127.0.0.1:53306)/quote?charset=utf8mb4&parseTime=True&loc=Local'
go test ./model -run '^TestUsageQuoteDialectIntegration$' -count=1
docker rm -f newapi-session1-mysql
Remove-Item Env:USAGE_QUOTE_TEST_DIALECT, Env:USAGE_QUOTE_TEST_DSN -ErrorAction SilentlyContinue
```

Expected: MySQL is alive and the dialect test passes. Always clear environment variables and remove the container.

### Task 3: Full Verification And Handoff

- [ ] **Step 1: Run full backend verification**

```powershell
go test ./controller ./model ./service ./middleware ./relay ./router -count=1
go test ./... -count=1
```

Expected: tests PASS. If router fails only because the protected dirty playground assets do not match embedded-asset expectations, report the exact failing test and keep those user files untouched; do not mark that unrelated failure as fixed.

- [ ] **Step 2: Verify scoped diff**

```powershell
git status --short --branch
git diff --check HEAD^..HEAD
git show --stat --oneline HEAD
```

Expected: the session commit contains only quote/refund tests and, only if proven necessary, the minimal billing-session implementation fix.

- [ ] **Step 3: Report the contract for Session 4**

The final response must state whether the root cause was an observation race or a lost refund, the commit hash, repetition counts, package results, PostgreSQL/MySQL results, full-suite result, and preserved unrelated dirty files. Session 4 may rely on this result only when eventual full refund and idempotency are green.
