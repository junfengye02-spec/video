# OpenMontage Frontend Architecture Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the merged authenticated and billed frontend around explicit project, media, generation, account, billing, shell, and route boundaries while preserving every accepted user workflow.

**Architecture:** The server-owned project ID and authenticated session become authoritative. Browser IndexedDB/OPFS remains a local cache and portable backup store, never an ownership source. React providers compose focused services and reducers; `AppShell` receives account/billing actions through adapters instead of importing their domain state directly.

**Tech Stack:** React 18, TypeScript 5.6, React Router 6, Vitest, Testing Library, IndexedDB, OPFS, FastAPI JSON APIs, Vite 5.

## Global Constraints

- Do not start this plan until auth Task 7, billing Task 12, and the frontend acceptance-closure plan are merged and green.
- Browser code never receives NewAPI tokens, provider keys, merchant secrets, quote IDs, or provider result URLs.
- Auth uses server sessions, `credentials: "include"`, CSRF headers for mutations, and no localStorage/IndexedDB session storage.
- Every new or imported server project belongs to the current user; legacy backup IDs are never trusted as ownership claims.
- PostgreSQL/server project state is canonical. IndexedDB/OPFS caches media and portable snapshots for the same canonical project ID.
- Login, wallet, and administrator routes remain independent from project workbench routes.
- No big-bang rewrite: each task adds a compatibility boundary and leaves the application runnable.
- No new state-management or schema-validation dependency unless a separate approved design changes this constraint.
- Every migration has characterization tests before extraction and full frontend gates afterward.

## Start Gate

Run:

```powershell
rg -n "RequireAuth|useAuth|/login|/register" web/src
rg -n "WalletPage|/wallet|余额|订单" web/src
rg -n "ProviderDrawer|KeyGate|text_key|image_key|video_key" web/src
npm.cmd test -- --run
npm.cmd run build
```

Expected: auth and wallet runtime code exists, provider-key runtime code does not, tests/build pass. If this is not true, do not begin the refactor.

## Target File Structure

```text
web/src/
  app/
    AppComposition.tsx
    AppRoutes.tsx
    routeModules/
      accountRoutes.tsx
      billingRoutes.tsx
      workbenchRoutes.tsx
  platform/
    http/HttpClient.ts
    storage/BrowserProjectCache.ts
    storage/MediaRepository.ts
  features/
    account/AccountShellAction.tsx
    billing/BillingShellAction.tsx
    projects/ProjectRepository.ts
    generation/GenerationService.ts
    workbench/WorkbenchSessionProvider.tsx
    workbench/reducer.ts
  components/shell/AppShell.tsx
```

`AppComposition` is the only place that composes account, billing, and workbench providers. Feature adapters are the only files allowed to import merged account/billing components into the shell.

---

### Task 1: Freeze Characterization Contracts

**Files:**
- Create: `web/src/app/AppComposition.test.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/app/AppRoutes.test.tsx`
- Modify: `web/src/localdb/exportProject.test.ts`

**Interfaces:**
- Produces: executable behavior contract for the existing merged application before extraction.

- [ ] **Step 1: Add route and provider characterization tests**

Cover this exact route matrix:

```ts
const routeMatrix = [
  ["/login", "登录"],
  ["/register", "注册"],
  ["/projects", "项目"],
  ["/projects/p1/storyboard", "分镜列表"],
  ["/projects/p1/settings", "全局设定"],
  ["/projects/p1/resources", "资源库"],
  ["/projects/p1/production", "制作进度"],
  ["/wallet", "钱包"],
  ["/orders", "订单"],
] as const;
```

Assert anonymous users reach public routes and are redirected from private routes; authenticated users keep the requested deep link.

- [ ] **Step 2: Characterize cross-domain shell behavior**

Assert the shell contains project breadcrumb, account menu/logout, balance/wallet action, and no provider-key UI. Assert logout redirects to `/login` and clears project UI without clearing portable local backups.

- [ ] **Step 3: Run tests and commit the characterization layer**

```powershell
npm.cmd test -- --run src/app/AppComposition.test.tsx src/App.test.tsx src/app/AppRoutes.test.tsx src/localdb/exportProject.test.ts
git add web/src/app/AppComposition.test.tsx web/src/App.test.tsx web/src/app/AppRoutes.test.tsx web/src/localdb/exportProject.test.ts
git commit -m "test(web): freeze merged frontend contracts"
```

Expected: tests PASS before production refactoring begins.

---

### Task 2: Extract A Credentialed HTTP Boundary

**Files:**
- Create: `web/src/platform/http/HttpClient.ts`
- Create: `web/src/platform/http/HttpClient.test.ts`
- Modify: `web/src/auth/api.ts`
- Modify: `web/src/billing/api.ts`
- Modify: `web/src/api/client.ts`

**Interfaces:**
- Produces: `HttpClient`, `ApiError`, `setCsrfToken`, and one credentialed request implementation.

- [ ] **Step 1: Write failing HTTP contract tests**

```ts
it("includes credentials and CSRF only for mutations", async () => {
  const client = new HttpClient({ getCsrfToken: () => "csrf" });
  await client.json("/api/projects", { method: "POST", body: { title: "Rain" } });
  expect(fetch).toHaveBeenCalledWith("/api/projects", expect.objectContaining({
    credentials: "include",
    headers: expect.objectContaining({ "X-CSRF-Token": "csrf" }),
  }));
});

it("publishes one unauthorized event for a later 401", async () => {
  const onUnauthorized = vi.fn();
  const client = new HttpClient({ getCsrfToken: () => "csrf", onUnauthorized });
  await expect(client.json("/api/projects", { method: "GET" })).rejects.toBeInstanceOf(ApiError);
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd test -- --run src/platform/http/HttpClient.test.ts
```

- [ ] **Step 3: Implement the boundary**

```ts
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface HttpClientOptions {
  getCsrfToken: () => string | null;
  onUnauthorized?: () => void;
}

export class HttpClient {
  constructor(private readonly options: HttpClientOptions) {}
  async json<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const csrf = this.options.getCsrfToken();
    const response = await fetch(path, {
      method,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(method !== "GET" && method !== "HEAD" && csrf ? { "X-CSRF-Token": csrf } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (response.status === 401) this.options.onUnauthorized?.();
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { detail?: string; code?: string };
      throw new ApiError(response.status, body.detail ?? `Request failed with status ${response.status}`, body.code);
    }
    return response.status === 204 ? undefined as T : await response.json() as T;
  }
}
```

Adapt existing API functions without changing their exported domain signatures.

- [ ] **Step 4: Verify and commit**

```powershell
npm.cmd test -- --run src/platform/http/HttpClient.test.ts src/api/client.test.ts src/auth/AuthProvider.test.tsx
git add web/src/platform/http web/src/auth/api.ts web/src/billing/api.ts web/src/api/client.ts
git commit -m "refactor(web): centralize credentialed http"
```

---

### Task 3: Separate Server Projects From Browser Cache

**Files:**
- Create: `web/src/features/projects/ProjectRepository.ts`
- Create: `web/src/features/projects/ProjectRepository.test.ts`
- Create: `web/src/platform/storage/BrowserProjectCache.ts`
- Modify: `web/src/localdb/projectStore.ts`
- Modify: `web/src/localdb/exportProject.ts`

**Interfaces:**
- Produces: `ProjectRepository` with server-authoritative operations and `BrowserProjectCache` with cache-only operations.

- [ ] **Step 1: Write failing repository tests**

Assert that import uses the parsed backup as content but accepts the server-returned ID, then caches under the new ID. Assert opening checks the server before treating a local record as owned. Assert an offline cache hit is labeled stale/read-only rather than authoritative.

- [ ] **Step 2: Define the repository contracts**

```ts
export interface CachedProject {
  snapshot: ShortDramaProjectResponse;
  freshness: "fresh" | "stale";
  writable: boolean;
}

export interface BrowserProjectCache {
  get(projectId: string): Promise<ShortDramaProjectResponse | null>;
  put(snapshot: ShortDramaProjectResponse): Promise<void>;
  remove(projectId: string): Promise<void>;
}

export interface ProjectRepository {
  list(): Promise<LocalProjectSummary[]>;
  open(projectId: string): Promise<CachedProject | null>;
  create(input: CreateProjectInput): Promise<ShortDramaProjectResponse>;
  importBackup(file: File): Promise<ShortDramaProjectResponse>;
  exportBackup(projectId: string): Promise<Blob>;
  delete(projectId: string): Promise<void>;
}
```

- [ ] **Step 3: Implement server-authoritative behavior**

`open()` fetches the owned project. On success it updates the cache. A 404 returns `null`; a network failure may return `{ freshness: "stale", writable: false }` from cache. Mutation methods never use the stale path. `importBackup()` parses and validates locally, posts import content to `/api/projects/import`, rewrites project/media references to the server-returned ID, then caches.

- [ ] **Step 4: Verify and commit**

```powershell
npm.cmd test -- --run src/features/projects/ProjectRepository.test.ts src/localdb/exportProject.test.ts src/localdb/projectStore.test.ts
git add web/src/features/projects web/src/platform/storage/BrowserProjectCache.ts web/src/localdb/projectStore.ts web/src/localdb/exportProject.ts
git commit -m "refactor(web): separate projects from browser cache"
```

---

### Task 4: Centralize Media Ownership And Blob URL Lifecycles

**Files:**
- Create: `web/src/platform/storage/MediaRepository.ts`
- Create: `web/src/platform/storage/MediaRepository.test.ts`
- Modify: `web/src/localdb/mediaStore.ts`
- Modify: `web/src/localdb/mediaUrls.ts`

**Interfaces:**
- Produces: one service for cache, resolve, revoke, delete-project, and storage-estimate behavior.

- [ ] **Step 1: Write failing lifecycle tests**

Cover deduplicated resolution, project-switch revocation, delete-after-OPFS success, retryable metadata after OPFS failure, and storage-estimate refresh.

- [ ] **Step 2: Define the interface**

```ts
export interface MediaRepository {
  cacheRemote(url: string, metadata: { projectId: string; sourcePath: string }): Promise<LocalMediaRef | null>;
  resolve(ref: LocalMediaRef): Promise<string | null>;
  revokeProject(projectId: string): void;
  deleteProject(projectId: string): Promise<void>;
  estimate(): Promise<StorageEstimate>;
}
```

- [ ] **Step 3: Move URL maps behind the repository**

No React provider owns raw `URL.createObjectURL`/`revokeObjectURL` calls after this task. Delete OPFS bytes before deleting retry metadata. Keep `deleteProject` fail-closed: the project record remains when media cleanup is incomplete.

- [ ] **Step 4: Verify and commit**

```powershell
npm.cmd test -- --run src/platform/storage/MediaRepository.test.ts src/localdb/mediaStore.test.ts src/localdb/mediaUrls.test.ts src/localdb/projectStore.test.ts
git add web/src/platform/storage web/src/localdb/mediaStore.ts web/src/localdb/mediaUrls.ts
git commit -m "refactor(web): centralize media lifecycle"
```

---

### Task 5: Extract Generation Operations From React State

**Files:**
- Create: `web/src/features/generation/GenerationService.ts`
- Create: `web/src/features/generation/GenerationService.test.ts`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/app/workbench/WorkbenchProvider.tsx`

**Interfaces:**
- Produces: `GenerationService`; consumes only project IDs and domain payloads, never client provider keys.

- [ ] **Step 1: Write failing service tests**

Test optimize, save, regenerate, render, event subscription, 402 payment-required mapping, 401 session expiration, and failure preserving the last successful snapshot.

- [ ] **Step 2: Define the service**

```ts
export interface GenerationService {
  optimize(projectId: string, shotId: string, sourceText: string): Promise<PromptOptimizeResponse>;
  saveShot(projectId: string, shotId: string, payload: ShotSaveRequest): Promise<ShotSaveResponse>;
  regenerate(projectId: string, shotId: string): Promise<RegenerateShotResponse>;
  render(projectId: string): Promise<RenderProjectResponse>;
  subscribe(projectId: string, onEvent: (event: JobEvent) => void): () => void;
}
```

Requests contain no `text_key`, `image_key`, `video_key`, `base_url`, or provider model credentials. HTTP 402 becomes a typed billing-required result consumed by UI, not a generic provider error.

- [ ] **Step 3: Adapt `WorkbenchProvider` to call the service**

Keep operation tokens and stale-result rejection in the provider for now. Remove direct imports of generation API functions and all provider credential state.

- [ ] **Step 4: Verify and commit**

```powershell
npm.cmd test -- --run src/features/generation/GenerationService.test.ts src/App.test.tsx
git add web/src/features/generation web/src/api/client.ts web/src/app/workbench/WorkbenchProvider.tsx
git commit -m "refactor(web): extract generation service"
```

---

### Task 6: Replace Workbench State With A Reducer Session

**Files:**
- Create: `web/src/features/workbench/reducer.ts`
- Create: `web/src/features/workbench/reducer.test.ts`
- Create: `web/src/features/workbench/WorkbenchSessionProvider.tsx`
- Modify: `web/src/app/workbench/types.ts`
- Modify: `web/src/app/workbench/useWorkbench.ts`
- Delete after migration: `web/src/app/workbench/WorkbenchProvider.tsx`

**Interfaces:**
- Produces: deterministic `WorkbenchState`, `WorkbenchAction`, and compatible `useWorkbench()` facade.

- [ ] **Step 1: Write reducer transition tests**

Cover open success/missing/stale, select shot, operation start/success/failure, stale operation ignored, concurrent shot save merged during render, project switch cleanup, and logout reset.

- [ ] **Step 2: Define state and operation identity**

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

- [ ] **Step 3: Implement reducer-first session orchestration**

Effects call `ProjectRepository`, `MediaRepository`, and `GenerationService`; every result dispatch includes its token. The reducer ignores a token whose project or generation no longer matches. The provider exposes the existing `WorkbenchContextValue` during migration so pages do not change in this task.

- [ ] **Step 4: Verify and commit**

```powershell
npm.cmd test -- --run src/features/workbench/reducer.test.ts src/App.test.tsx src/app/AppRoutes.test.tsx
git add web/src/features/workbench web/src/app/workbench/types.ts web/src/app/workbench/useWorkbench.ts web/src/app/workbench/WorkbenchProvider.tsx
git commit -m "refactor(web): introduce workbench session reducer"
```

---

### Task 7: Split Route Modules And Composition

**Files:**
- Create: `web/src/app/AppComposition.tsx`
- Create: `web/src/app/routeModules/accountRoutes.tsx`
- Create: `web/src/app/routeModules/billingRoutes.tsx`
- Create: `web/src/app/routeModules/workbenchRoutes.tsx`
- Modify: `web/src/app/AppRoutes.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/app/AppComposition.test.tsx`

**Interfaces:**
- Produces: independent route arrays/elements composed under auth and domain providers.

- [ ] **Step 1: Write failing composition tests**

Assert public account routes render without workbench bootstrap; wallet/workbench routes require auth; project load failure does not blank account or billing pages; logout cancels workbench subscriptions.

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

`AppRoutes` composes public account routes, authenticated billing routes, and authenticated workbench routes. Route modules do not import each other's pages.

- [ ] **Step 3: Verify and commit**

```powershell
npm.cmd test -- --run src/app/AppComposition.test.tsx src/app/AppRoutes.test.tsx
git add web/src/app web/src/App.tsx
git commit -m "refactor(web): compose domain route modules"
```

---

### Task 8: Make The Shell Slot-Driven

**Files:**
- Create: `web/src/features/account/AccountShellAction.tsx`
- Create: `web/src/features/billing/BillingShellAction.tsx`
- Modify: `web/src/components/shell/AppShell.tsx`
- Modify: `web/src/components/shell/AppShell.test.tsx`
- Modify: `web/src/app/routeModules/workbenchRoutes.tsx`

**Interfaces:**
- Produces: shell layout independent of auth and billing domain implementations.

- [ ] **Step 1: Write failing shell-isolation tests**

Assert `AppShell` renders arbitrary `accountAction` and `billingAction` nodes and contains no `useAuth`, `useWallet`, payment API, or provider-key import.

- [ ] **Step 2: Define the shell contract**

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

`AccountShellAction` is the only shell adapter importing `useAuth`; `BillingShellAction` is the only shell adapter importing wallet/billing state. The shell owns placement, responsive behavior, and focus management only.

- [ ] **Step 3: Verify and commit**

```powershell
npm.cmd test -- --run src/components/shell/AppShell.test.tsx src/app/AppComposition.test.tsx
git add web/src/features/account web/src/features/billing web/src/components/shell/AppShell.tsx web/src/components/shell/AppShell.test.tsx web/src/app/routeModules/workbenchRoutes.tsx
git commit -m "refactor(web): isolate shell domain actions"
```

---

### Task 9: Add Domain Error Boundaries And Billing-Aware Commands

**Files:**
- Create: `web/src/components/feedback/DomainErrorBoundary.tsx`
- Create: `web/src/components/feedback/DomainErrorBoundary.test.tsx`
- Modify: `web/src/pages/NewProjectPage.tsx`
- Modify: `web/src/components/ShotEditor.tsx`
- Modify: `web/src/pages/ProductionPage.tsx`
- Modify: `web/src/app/routeModules/workbenchRoutes.tsx`

**Interfaces:**
- Produces: route-local recovery, typed `payment_required` UI, and one error owner per operation.

- [ ] **Step 1: Write failing tests**

Cover render errors without blanking the project, 401 redirect preserving return URL, 402 showing available/required balance with wallet link, malformed cached project recovery, and retry after transient server error.

- [ ] **Step 2: Implement error ownership**

Route boundaries catch rendering/data-shape failures. Session/API errors remain structured state, not thrown into render. Forms own validation messages only. Payment-required UI links to `/wallet` and never exposes quote/provider internals.

- [ ] **Step 3: Verify and commit**

```powershell
npm.cmd test -- --run src/components/feedback/DomainErrorBoundary.test.tsx src/pages/NewProjectPage.test.tsx src/components/ShotEditor.test.tsx src/pages/ProductionPage.test.tsx
git add web/src/components/feedback web/src/pages/NewProjectPage.tsx web/src/components/ShotEditor.tsx web/src/pages/ProductionPage.tsx web/src/app/routeModules/workbenchRoutes.tsx
git commit -m "refactor(web): add domain recovery boundaries"
```

---

### Task 10: Remove Compatibility Layers And Verify Migration

**Files:**
- Delete after all imports migrate: `web/src/app/workbench/WorkbenchProvider.tsx`
- Delete after billing migration: `web/src/components/shell/ProviderDrawer.tsx`
- Delete after billing migration: `web/src/components/KeyGate.tsx`
- Modify: `web/src/app/workbench/useWorkbench.ts`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/app/AppRoutes.test.tsx`

- [ ] **Step 1: Prove no legacy runtime dependencies remain**

```powershell
rg -n "WorkbenchProvider|ProviderDrawer|KeyGate|text_key|image_key|video_key|base_url" web/src
```

Expected: no runtime matches outside migration rejection tests.

- [ ] **Step 2: Delete compatibility files and update imports**

Keep `useWorkbench()` as the stable page facade, backed by `WorkbenchSessionProvider`, until a later page-by-page API cleanup plan.

- [ ] **Step 3: Run complete automated verification**

```powershell
npm.cmd test -- --run
npm.cmd run build
```

Expected: all tests PASS; TypeScript/Vite exit 0.

- [ ] **Step 4: Run browser migration verification**

At `1440x900`, `1024x768`, and `390x844`, verify login/logout, protected deep links, project import with new server ID, project editing, media recovery, wallet navigation, 402 recovery, render progress, final download, and account/wallet shell actions. Check zero new console errors and no duplicate network mutations.

- [ ] **Step 5: Commit**

```powershell
git add web/src/app/AppComposition.tsx web/src/app/AppComposition.test.tsx web/src/app/AppRoutes.tsx web/src/app/AppRoutes.test.tsx web/src/app/routeModules web/src/platform web/src/features web/src/app/workbench web/src/components/feedback/DomainErrorBoundary.tsx web/src/components/feedback/DomainErrorBoundary.test.tsx web/src/components/shell/AppShell.tsx web/src/components/shell/AppShell.test.tsx web/src/App.tsx web/src/App.test.tsx
git add -u web/src/components/shell/ProviderDrawer.tsx web/src/components/KeyGate.tsx
git commit -m "refactor(web): complete authenticated workbench architecture"
```

## Completion Criteria

- Account, billing, project, media, generation, workbench session, shell, and routes have explicit ownership boundaries.
- Server ownership is authoritative; browser cache cannot grant access or mutate stale projects.
- No provider or merchant secret reaches browser runtime, project snapshots, logs, or backups.
- Existing project workflows, account workflows, and wallet workflows pass characterization and browser tests.
- Old provider-key and monolithic workbench compatibility layers are removed only after all callers migrate.
