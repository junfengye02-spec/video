# Session 6: OpenMontage Frontend Architecture Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans task-by-task. Use superpowers:test-driven-development for every migration, browser:control-in-app-browser for final human-click verification, and superpowers:verification-before-completion before reporting success. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete reducer/session, route composition, slot-driven shell, domain recovery, and compatibility-layer removal while preserving every accepted account, billing, project, LocalDB, and generation workflow.

**Architecture:** A deterministic reducer owns workbench state and ignores stale operation tokens. `AppComposition` composes auth, billing, and workbench services once; independent route modules own their domains. Shell adapters provide account and billing actions, error boundaries recover locally, and compatibility layers are deleted only after every caller migrates.

**Tech Stack:** React 18, TypeScript 5.6, React Router 6, Vitest, Testing Library, Vite 5.

## Global Constraints

- Repository: `C:\Users\zhuba\Desktop\OpenMontage\videro` on `main`.
- Read `AGENTS.md`, `AGENT_GUIDE.md`, and `PROJECT_CONTEXT.md` before editing.
- Session 5 must be complete and its exported interfaces must match this plan's start gate.
- Preserve pre-existing dirty files and stage only current task files.
- No new state-management or error-boundary dependency.
- Route modules never import each other's pages.
- `AppShell` owns layout, responsive behavior, breadcrumb placement, and focus only; it does not import auth, wallet, payment, or provider state.
- Keep `useWorkbench()` as the stable page facade through the migration.
- Delete compatibility files only after zero runtime imports remain.

## Start Gate

- [ ] **Step 1: Verify Session 5 interfaces and green baseline**

```powershell
Test-Path web/src/platform/http/HttpClient.ts
Test-Path web/src/features/projects/ProjectRepository.ts
Test-Path web/src/platform/storage/MediaRepository.ts
Test-Path web/src/features/generation/GenerationService.ts
rg -n 'export (class HttpClient|interface ProjectRepository|interface MediaRepository|interface GenerationService)' web/src/platform web/src/features
Set-Location web
npm.cmd test -- --run
npm.cmd run build
```

Expected: interfaces exist and tests/build pass. Stop if the baseline is red.

### Task 1: Reducer Workbench Session

**Files:**
- Create: `web/src/features/workbench/reducer.ts`
- Create: `web/src/features/workbench/reducer.test.ts`
- Create: `web/src/features/workbench/WorkbenchSessionProvider.tsx`
- Create: `web/src/features/workbench/WorkbenchSessionProvider.test.tsx`
- Modify: `web/src/app/workbench/types.ts`
- Modify: `web/src/app/workbench/useWorkbench.ts`
- Retain until Task 5: `web/src/app/workbench/WorkbenchProvider.tsx`

**Interfaces:**

```ts
export interface OperationToken {
  projectId: string;
  kind: "open" | "create" | "save-shot" | "optimize" | "regenerate" | "save-continuity" | "upload" | "render";
  generation: number;
}

export interface WorkbenchState {
  snapshot: ShortDramaProjectResponse | null;
  selectedShotId: string | null;
  events: JobEvent[];
  error: string | null;
  load: "idle" | "loading" | "ready" | "missing" | "stale";
  operations: Partial<Record<OperationToken["kind"], OperationToken>>;
}
```

- [ ] **Step 1: Write reducer transition tests**

Cover open success/missing/stale, selected shot, operation start/success/failure, stale token ignored, concurrent shot save merged during render, project switch cleanup, logout reset, and preserved last successful snapshot after failure.

```ts
const stale = reduce(stateFor("p2", 2), {
  type: "operationSucceeded",
  token: { projectId: "p1", kind: "render", generation: 1 },
  snapshot: p1Snapshot,
});
expect(stale.snapshot?.project.id).toBe("p2");
```

- [ ] **Step 2: Implement reducer-first orchestration**

Effects call only `ProjectRepository`, `MediaRepository`, and `GenerationService`; every result dispatch carries its token. The provider exposes the existing `WorkbenchContextValue`, cancels subscriptions/revokes project URLs on switch/logout, and never publishes stale results.

- [ ] **Step 3: Verify and commit**

```powershell
npm.cmd test -- --run src/features/workbench/reducer.test.ts src/features/workbench/WorkbenchSessionProvider.test.tsx src/App.test.tsx src/app/AppRoutes.test.tsx
Set-Location ..
git add web/src/features/workbench web/src/app/workbench/types.ts web/src/app/workbench/useWorkbench.ts
git commit -m "refactor(web): introduce workbench session reducer"
```

### Task 2: App Composition And Route Modules

**Files:**
- Create: `web/src/app/AppComposition.tsx`
- Create: `web/src/app/AppComposition.test.tsx`
- Create: `web/src/app/routeModules/accountRoutes.tsx`
- Create: `web/src/app/routeModules/billingRoutes.tsx`
- Create: `web/src/app/routeModules/workbenchRoutes.tsx`
- Modify: `web/src/app/AppRoutes.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Produces: independently composed public account, authenticated billing, and authenticated workbench routes.

- [ ] **Step 1: Write failing composition tests**

Assert public routes render without project bootstrap, private routes require auth, project load failure cannot blank account/billing, protected return URL survives login, and logout cancels workbench subscriptions.

- [ ] **Step 2: Implement composition order**

```tsx
export function AppComposition() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <BillingProvider>
          <WorkbenchSessionProvider>
            <AppRoutes />
          </WorkbenchSessionProvider>
        </BillingProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
```

If public account routes would still bootstrap workbench under this literal nesting, move `WorkbenchSessionProvider` into the authenticated workbench route element while preserving the single-composition rule. Let the characterization test decide placement.

- [ ] **Step 3: Verify module isolation and commit**

```powershell
npm.cmd test -- --run src/app/AppComposition.test.tsx src/app/AppRoutes.test.tsx
rg -n 'pages/(Wallet|Orders|BillingAdmin)' src/app/routeModules/workbenchRoutes.tsx
rg -n 'pages/(Storyboard|Production|Projects)' src/app/routeModules/accountRoutes.tsx src/app/routeModules/billingRoutes.tsx
```

Expected: tests pass and cross-domain scans have no matches.

```powershell
Set-Location ..
git add web/src/app web/src/App.tsx
git commit -m "refactor(web): compose domain route modules"
```

### Task 3: Slot-Driven Shell

**Files:**
- Create: `web/src/features/account/AccountShellAction.tsx`
- Create: `web/src/features/account/AccountShellAction.test.tsx`
- Create: `web/src/features/billing/BillingShellAction.tsx`
- Create: `web/src/features/billing/BillingShellAction.test.tsx`
- Modify: `web/src/components/shell/AppShell.tsx`
- Modify: `web/src/components/shell/AppShell.test.tsx`
- Modify: `web/src/app/routeModules/workbenchRoutes.tsx`

**Interfaces:**

```ts
export interface AppShellProps {
  project: { id: string; title: string } | null;
  breadcrumb: ReactNode;
  projectNavigation?: ReactNode;
  accountAction: ReactNode;
  billingAction: ReactNode;
  onBeforeNavigate?: () => boolean;
  children: ReactNode;
}
```

- [ ] **Step 1: Write failing isolation tests**

Assert arbitrary action nodes render and `AppShell.tsx` contains no `useAuth`, wallet/payment API, billing provider, or provider-key import. Adapter tests own logout, balance, wallet navigation, and role behavior.

- [ ] **Step 2: Implement adapters and shell contract**

`AccountShellAction` is the sole shell adapter importing `useAuth`; `BillingShellAction` is the sole adapter importing wallet/billing state. Preserve responsive placement, accessible names, breadcrumb, navigation guard, and modal focus.

- [ ] **Step 3: Verify and commit**

```powershell
npm.cmd test -- --run src/features/account/AccountShellAction.test.tsx src/features/billing/BillingShellAction.test.tsx src/components/shell/AppShell.test.tsx src/app/AppComposition.test.tsx
Set-Location ..
git add web/src/features/account web/src/features/billing web/src/components/shell/AppShell.tsx web/src/components/shell/AppShell.test.tsx web/src/app/routeModules/workbenchRoutes.tsx
git commit -m "refactor(web): isolate shell domain actions"
```

### Task 4: Domain Error Boundaries And Billing-Aware Commands

**Files:**
- Create: `web/src/components/feedback/DomainErrorBoundary.tsx`
- Create: `web/src/components/feedback/DomainErrorBoundary.test.tsx`
- Modify: `web/src/pages/NewProjectPage.tsx`
- Modify: `web/src/pages/NewProjectPage.test.tsx`
- Modify: `web/src/components/ShotEditor.tsx`
- Modify: `web/src/components/ShotEditor.test.tsx`
- Modify: `web/src/pages/ProductionPage.tsx`
- Modify: `web/src/pages/ProductionPage.test.tsx`
- Modify: `web/src/app/routeModules/workbenchRoutes.tsx`

**Interfaces:**
- Produces: route-local render recovery, session-expired navigation, and typed payment-required UI.

- [ ] **Step 1: Write failing recovery tests**

Cover render exception without blanking account/billing, 401 preserving return URL, 402 showing available/required balance plus wallet link, malformed cache eviction/recovery, transient retry, and one visible error owner per command.

```tsx
expect(await screen.findByRole("alert")).toHaveTextContent("余额不足");
expect(screen.getByText("可用余额 800")).toBeVisible();
expect(screen.getByText("本次最多需要 1200")).toBeVisible();
expect(screen.getByRole("link", { name: "前往钱包" })).toHaveAttribute("href", "/wallet");
```

- [ ] **Step 2: Implement error ownership**

Error boundaries catch render/data-shape failures only. API/session errors stay structured state. Forms own validation messages only. Payment UI consumes typed units and never displays quote/provider internals.

- [ ] **Step 3: Verify and commit**

```powershell
npm.cmd test -- --run src/components/feedback/DomainErrorBoundary.test.tsx src/pages/NewProjectPage.test.tsx src/components/ShotEditor.test.tsx src/pages/ProductionPage.test.tsx
Set-Location ..
git add web/src/components/feedback web/src/pages/NewProjectPage.tsx web/src/pages/NewProjectPage.test.tsx web/src/components/ShotEditor.tsx web/src/components/ShotEditor.test.tsx web/src/pages/ProductionPage.tsx web/src/pages/ProductionPage.test.tsx web/src/app/routeModules/workbenchRoutes.tsx
git commit -m "refactor(web): add domain recovery boundaries"
```

### Task 5: Remove Compatibility Layers

**Files:**
- Delete: `web/src/app/workbench/WorkbenchProvider.tsx`
- Delete if still present: `web/src/components/shell/ProviderDrawer.tsx`
- Delete if still present: `web/src/components/KeyGate.tsx`
- Modify: `web/src/app/workbench/useWorkbench.ts`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/app/AppRoutes.test.tsx`

- [ ] **Step 1: Prove no runtime dependencies remain**

```powershell
rg -n 'WorkbenchProvider|ProviderDrawer|KeyGate|text_key|image_key|video_key|base_url' web/src
```

Expected before deletion: `WorkbenchProvider` matches only compatibility imports; provider-key symbols have no runtime matches.

- [ ] **Step 2: Migrate final imports and delete files**

Keep `useWorkbench()` as facade backed by `WorkbenchSessionProvider`. Delete only after tests compile with zero imports.

- [ ] **Step 3: Verify and commit**

```powershell
Set-Location web
npm.cmd test -- --run src/App.test.tsx src/app/AppRoutes.test.tsx src/app/AppComposition.test.tsx
Set-Location ..
git add web/src/app/workbench/useWorkbench.ts web/src/App.test.tsx web/src/app/AppRoutes.test.tsx
git add -u web/src/app/workbench/WorkbenchProvider.tsx web/src/components/shell/ProviderDrawer.tsx web/src/components/KeyGate.tsx
git commit -m "refactor(web): remove workbench compatibility layers"
```

### Task 6: Full Automated And Browser Architecture Acceptance

- [ ] **Step 1: Run all automated gates**

```powershell
$env:AUTH_HMAC_SECRET='test-auth-hmac-secret-at-least-32-bytes'
python -m pytest server/tests -q
python -m alembic check
Set-Location web
npm.cmd test -- --run
npm.cmd run build
rg -n 'WorkbenchProvider|ProviderDrawer|KeyGate|text_key|image_key|video_key|base_url' src
```

Expected: all tests/build pass and no legacy runtime matches remain.

- [ ] **Step 2: Run browser migration verification**

Using `browser:control-in-app-browser` at `1440x900`, `1024x768`, and `390x844`, verify login/logout, protected deep links, account and wallet pages independent from project load, project import with new server ID, stale offline cache read-only behavior, editing, media recovery, wallet navigation, 402 recovery, render progress, final download, server-first project deletion, account/wallet shell actions, and zero console errors/duplicate mutations.

- [ ] **Step 3: Review architecture ownership**

Confirm account, billing, project, media, generation, workbench, shell, and route modules have explicit dependencies; route modules do not import each other; shell imports no domain hooks; browser cache cannot grant ownership or mutate stale projects.

- [ ] **Step 4: Final handoff**

```powershell
Set-Location ..
git diff --check
git status --short --branch
git log -15 --oneline
```

Report all commits, automated totals, build result, three-viewport workflows, architecture scans, remaining Alipay-only external gate if any, and preserved unrelated changes. Do not claim completion without fresh evidence from this final tree.

