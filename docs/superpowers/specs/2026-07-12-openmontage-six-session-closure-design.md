# OpenMontage Six-Session Closure Design

**Status:** Approved in conversation; awaiting written-spec review

## 1. Objective

Close the remaining NewAPI quote correctness, OpenMontage billing, frontend acceptance, LocalDB browser acceptance, and frontend architecture work through six sequential Codex sessions. Each session receives one self-contained implementation plan, produces independently reviewable commits, and leaves the repositories runnable for the next session.

## 2. Why Six Sessions

The remaining work crosses two repositories and several ownership boundaries:

- `C:\Users\zhuba\Desktop\api\new-api-source-0229dc2`: usage-quote reservation and refund correctness.
- `C:\Users\zhuba\Desktop\OpenMontage\videro`: FastAPI billing administration, React billing UI, browser acceptance, LocalDB durability, and frontend architecture.
- External Alipay sandbox notification delivery may be required for the final operations gate.

One session would mix unrelated repositories and exceed a reliable review context. Three sessions would still combine backend correctness, shared frontend integration, and a ten-task architecture migration. Six sessions preserve dependency order and provide a meaningful test and review gate after every unit.

## 3. Sequencing Rules

The sessions run strictly in order. A later session must inspect the current repository state and verify its start gate instead of trusting plan checkboxes or earlier conversation summaries.

1. Session 1 repairs NewAPI usage-quote refund correctness.
2. Session 2 closes OpenMontage billing administration backend work.
3. Session 3 delivers the authenticated wallet, orders, and billing administration frontend.
4. Session 4 closes frontend, LocalDB, billing E2E, browser, and operations acceptance.
5. Session 5 builds frontend architecture foundations after all product behavior is green.
6. Session 6 completes frontend composition migration and final architecture acceptance.

Sessions 2 and 3 must not begin with a red Session 1 integration contract. Sessions 5 and 6 must not begin until Sessions 1-4 are green. The sessions are not parallelizable.

## 4. Session Designs

### 4.1 Session 1: NewAPI Quote Refund Correctness

**Repository:** `C:\Users\zhuba\Desktop\api\new-api-source-0229dc2`

**Purpose:** Fix the reproducible failed-request refund defect where reserved quota can be restored only partially, while preserving idempotency under retry and concurrency.

**Scope:** Reproduce the controller failure, trace reservation/refund ownership, add deterministic unit and concurrency tests, implement the minimal correction, run focused controller/service tests, run PostgreSQL and MySQL quote matrices, and run the feasible full Go suite. Existing unrelated playground worktree changes are protected and separately reported.

**Completion gate:** The previously failing refund assertion restores the full original quota on repeated runs; duplicate callbacks or retries do not over-refund; dialect tests pass; any unrelated router/build failure is documented with evidence.

### 4.2 Session 2: OpenMontage Billing Backend Closure

**Repository:** `C:\Users\zhuba\Desktop\OpenMontage\videro`

**Purpose:** Make the OpenMontage billing backend stable and expose the administrator APIs required by the frontend.

**Scope:** Replace fixed expired quote fixtures with clock-relative or injected-time fixtures, implement Billing Task 11 administrator multiplier/product/order/reconciliation APIs, enforce admin authorization and secret redaction, add focused tests, run Alembic/schema checks, and run SQLite plus configured PostgreSQL billing tests.

**Completion gate:** No time-sensitive quote fixture expires with wall-clock passage; admin billing tests pass; unauthorized and non-admin access is denied; secrets are absent from API responses and logs; migrations and backend test gates are green apart from explicitly unavailable external services.

### 4.3 Session 3: Billing Frontend And Shared Shell Integration

**Repository:** `C:\Users\zhuba\Desktop\OpenMontage\videro`

**Purpose:** Deliver Billing Task 12 and the shared frontend integration that was previously blocked on it.

**Scope:** Add typed billing API contracts, wallet and order pages, administrator billing pages, protected routes, balance/account shell actions, payment-required recovery, breadcrumbs, modal focus handling, and removal of browser provider-key UI. Preserve existing project, backup, and workbench behavior through characterization tests.

**Completion gate:** Login, wallet, orders, administrator access, recharge initiation, 402 recovery, logout, breadcrumbs, and modal focus pass component tests; provider keys and merchant secrets are absent from browser runtime; full frontend tests and production build pass.

### 4.4 Session 4: Product Acceptance And Operations Closure

**Repository:** `C:\Users\zhuba\Desktop\OpenMontage\videro`

**Purpose:** Close all remaining product-level automated, browser, LocalDB, billing E2E, and operations gates before architecture-only refactoring begins.

**Scope:** Execute frontend acceptance Tasks 6-7 and billing Task 13; run real module-Worker ZIP import, Worker-construction fallback, extracted-directory import, cancellation, LocalDB recovery, cross-tab cleanup, project deletion, remote-first media, responsive layouts, auth/billing workflows, render/download, and console/network checks. Add the billing operations runbook and token-rotation procedures. Use Alipay sandbox notification testing when credentials and delivery are available; otherwise leave one explicit external gate with exact reproduction instructions.

**Completion gate:** Automated suites and build pass; required desktop, tablet, and mobile browser workflows pass with no new console errors or duplicate mutations; LocalDB acceptance is evidenced; the operations runbook is actionable; external sandbox limitations are isolated rather than counted as passed.

### 4.5 Session 5: Frontend Architecture Foundations

**Repository:** `C:\Users\zhuba\Desktop\OpenMontage\videro`

**Purpose:** Execute the foundation half of the frontend architecture refactor without changing accepted product behavior.

**Scope:** Freeze characterization contracts; centralize credentialed HTTP; separate server-authoritative projects from browser cache; centralize media/blob lifecycles; extract generation operations from React state. Add the missing authenticated server project deletion endpoint before exposing `ProjectRepository.delete()`.

**Deletion contract:** Server deletion is authoritative. After a successful server deletion, the browser logically removes the project and transitions OPFS/media work to the durable cleanup journal. Physical OPFS failure does not resurrect the server project and does not discard retry metadata. If the server deletion fails, no local logical deletion occurs.

**Completion gate:** Project create/open/import/export/delete honor server ownership; stale cache is read-only; every mutation uses authenticated HTTP and CSRF; media cleanup remains recoverable; no provider credentials enter generation requests; focused and full frontend/backend gates pass.

### 4.6 Session 6: Frontend Composition And Architecture Acceptance

**Repository:** `C:\Users\zhuba\Desktop\OpenMontage\videro`

**Purpose:** Complete the reducer, provider, route, shell, and recovery migration, then remove compatibility layers.

**Scope:** Replace monolithic workbench state with a reducer session; split account, billing, and workbench route modules; make the shell slot-driven; add domain error boundaries and billing-aware commands; remove the old `WorkbenchProvider`, `ProviderDrawer`, and `KeyGate` only after callers migrate; run full automated and browser architecture verification.

**Completion gate:** Account, billing, project, media, generation, workbench, shell, and routes have explicit ownership; project failure cannot blank account or billing routes; stale async results cannot cross project sessions; no legacy provider-key runtime remains; all accepted product workflows still pass at desktop, tablet, and mobile viewports.

## 5. Cross-Session Contracts

- The user sends exactly one plan file to each new Codex session.
- Each plan begins with a start gate and stops without shared-file edits when prerequisites are false.
- Each session follows TDD, commits small independently reviewable changes, and protects pre-existing dirty worktree changes.
- A session may fix regressions it introduces. Unrelated failures are investigated and reported, not silently absorbed into scope.
- No session treats skipped PostgreSQL, browser, or sandbox checks as passing evidence.
- Plans use absolute repository context in their opening instructions but repository-relative paths in file/task lists.
- Every final handoff reports commits, changed files, exact verification commands, pass/fail/skip totals, and remaining external blockers.

## 6. Plan File Set

After this design is reviewed, create these six files:

1. `docs/superpowers/plans/2026-07-12-session-1-newapi-quote-refund-correctness.md`
2. `docs/superpowers/plans/2026-07-12-session-2-openmontage-billing-backend-closure.md`
3. `docs/superpowers/plans/2026-07-12-session-3-openmontage-billing-frontend-integration.md`
4. `docs/superpowers/plans/2026-07-12-session-4-openmontage-product-acceptance-closure.md`
5. `docs/superpowers/plans/2026-07-12-session-5-openmontage-frontend-architecture-foundations.md`
6. `docs/superpowers/plans/2026-07-12-session-6-openmontage-frontend-architecture-completion.md`

The existing `2026-07-11-openmontage-frontend-architecture-refactor.md` remains historical input. Sessions 5 and 6 supersede its execution order and correct its unsupported delete endpoint and conflicting fail-closed cleanup semantics.

## 7. Success Criteria

- Six plan files can be dispatched independently and in order without relying on hidden conversation context.
- Each plan has exact prerequisites, file ownership, interfaces, tests, commands, expected results, and commit boundaries.
- No plan duplicates responsibility owned by another session.
- The NewAPI and OpenMontage repositories are never modified in the same session.
- Product acceptance is complete before architecture-only migration starts.
- The final architecture preserves authenticated server ownership while retaining durable browser-local cache and backup behavior.
