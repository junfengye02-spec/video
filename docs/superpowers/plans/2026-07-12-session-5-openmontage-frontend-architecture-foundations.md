# Session 5: OpenMontage Frontend Architecture Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans task-by-task. Use superpowers:test-driven-development for every migration and superpowers:verification-before-completion before reporting success. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish authenticated HTTP, server-authoritative project, browser-cache, media-lifecycle, and generation-service boundaries without changing accepted product behavior.

**Architecture:** PostgreSQL/server project ownership is canonical. IndexedDB and OPFS are portable snapshot/media caches, not authorization sources. One credentialed HTTP client owns cookies, CSRF, and structured errors; focused repositories own projects and media; generation calls leave React state while the existing workbench facade remains compatible for Session 6.

**Tech Stack:** FastAPI, SQLAlchemy, React 18, TypeScript 5.6, React Router 6, Vitest, IndexedDB, OPFS.

## Global Constraints

- Repository: `C:\Users\zhuba\Desktop\OpenMontage\videro` on `main`.
- Read `AGENTS.md`, `AGENT_GUIDE.md`, and `PROJECT_CONTEXT.md` before editing.
- Session 4 code, database, automated, and browser gates must be green. An explicitly unavailable Alipay sandbox credential is the only permitted open external item.
- Preserve all pre-existing dirty files and stage only the current task's files.
- No new state-management, HTTP, storage, or schema-validation dependency.
- Browser code never receives provider tokens, merchant secrets, quote IDs, billing fingerprints, provider references, or result locators/hashes.
- No big-bang rewrite: every task leaves the application runnable and tests green.
- Keep `useWorkbench()` and existing page-facing contracts compatible for Session 6.
- Server deletion is authoritative. A failed server delete leaves local state intact; a successful server delete logically removes browser state immediately and journals physical OPFS cleanup until success.

## Start Gate

- [ ] **Step 1: Verify accepted merged behavior**

```powershell
git status --short --branch
git log -15 --oneline
rg -n 'RequireAuth|useAuth|/login|/register|/wallet|/orders' web/src
rg -n 'ProviderDrawer|KeyGate|text_key|image_key|video_key' web/src
Set-Location web
npm.cmd test -- --run
npm.cmd run build
```

Expected: auth/billing runtime exists, provider-key runtime does not, tests/build pass. Stop on failure rather than refactoring a red baseline.

### Task 1: Freeze Cross-Domain Characterization

**Files:**
- Create: `web/src/app/AppComposition.test.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/app/AppRoutes.test.tsx`
- Modify: `web/src/localdb/exportProject.test.ts`

**Interfaces:**
- Produces: executable route, shell, auth, billing, project import/export, and logout contracts.

- [ ] **Step 1: Add the exact route matrix**

```ts
const routeMatrix = [
  ["/login", "登录", "public"],
  ["/register", "注册", "public"],
  ["/projects", "项目", "authenticated"],
  ["/projects/p1/storyboard", "分镜列表", "authenticated"],
  ["/projects/p1/settings", "全局设定", "authenticated"],
  ["/projects/p1/resources", "资源库", "authenticated"],
  ["/projects/p1/production", "制作进度", "authenticated"],
  ["/wallet", "钱包", "authenticated"],
  ["/orders", "订单", "authenticated"],
] as const;
```

Assert public pages do not bootstrap workbench, protected deep links preserve return URL, and project load failure cannot blank login/wallet.

- [ ] **Step 2: Characterize shell and portable backup behavior**

Assert breadcrumb, account/logout, balance/wallet action, and no provider-key UI. Logout clears active workbench state but does not delete portable browser backups. Import receives a new canonical server ID while retaining validated content/media.

- [ ] **Step 3: Verify and commit**

```powershell
npm.cmd test -- --run src/app/AppComposition.test.tsx src/App.test.tsx src/app/AppRoutes.test.tsx src/localdb/exportProject.test.ts
Set-Location ..
git add web/src/app/AppComposition.test.tsx web/src/App.test.tsx web/src/app/AppRoutes.test.tsx web/src/localdb/exportProject.test.ts
git commit -m "test(web): freeze merged frontend contracts"
```

### Task 2: Credentialed HTTP Boundary

**Files:**
- Create: `web/src/platform/http/HttpClient.ts`
- Create: `web/src/platform/http/HttpClient.test.ts`
- Modify: `web/src/auth/api.ts`
- Modify: `web/src/billing/api.ts`
- Modify: `web/src/api/client.ts`

**Interfaces:**
- Produces: `HttpClient`, `ApiError`, `setCsrfToken`, `onUnauthorized`.

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

it("publishes one unauthorized event for a 401", async () => {
  const onUnauthorized = vi.fn();
  const client = new HttpClient({ getCsrfToken: () => "csrf", onUnauthorized });
  await expect(client.json("/api/projects")).rejects.toBeInstanceOf(ApiError);
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Implement the boundary**

```ts
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
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

- [ ] **Step 3: Adapt clients without changing domain signatures and commit**

```powershell
npm.cmd test -- --run src/platform/http/HttpClient.test.ts src/api/client.test.ts src/billing/api.test.ts src/auth/AuthProvider.test.tsx
Set-Location ..
git add web/src/platform/http web/src/auth/api.ts web/src/billing/api.ts web/src/api/client.ts
git commit -m "refactor(web): centralize credentialed http"
```

### Task 3: Authenticated Server Project Deletion

**Files:**
- Modify: `server/app/projects/repository.py`
- Modify: `server/app/main.py`
- Modify: `server/tests/test_project_ownership.py`
- Modify only if orphan cleanup is not already covered: `server/app/media_retention.py`
- Modify only if needed for the same test: `server/tests/test_media_retention.py`

**Interfaces:**
- Produces: `DELETE /api/projects/{project_id}` returning 204; `ProjectRepository.delete_owned(project_id, owner_user_id) -> ProjectRecord | None`.
- Consumes: authenticated CSRF, ownership lock, guarded workspace deletion, and orphan-workspace retention.

- [ ] **Step 1: Write failing ownership and atomicity tests**

Cover anonymous 401, missing CSRF 403, cross-user 404, owner 204, repeat 404, row removed, workspace inaccessible, billing/audit history retained, database commit failure leaves row and workspace, and post-commit workspace cleanup failure does not resurrect the deleted server project or expose filesystem details.

```python
response = alice.delete(f"/api/projects/{project_id}")
assert response.status_code == 204
assert db.get(ProjectRecord, project_id) is None
assert alice.get(f"/api/projects/{project_id}").status_code == 404
```

- [ ] **Step 2: Add repository lock/delete contract**

```python
def delete_owned(self, project_id: str, owner_user_id: str) -> ProjectRecord | None:
    project = self.get_owned_for_update(project_id, owner_user_id)
    if project is None:
        return None
    self.db.delete(project)
    self.db.flush()
    return project
```

- [ ] **Step 3: Implement the route**

The route locks and deletes the owned row, commits, then attempts guarded workspace cleanup. A cleanup exception is sanitized and queued/left for existing orphan retention; the HTTP result remains 204 because server ownership deletion already committed. If durable orphan cleanup is not currently discoverable, extend `media_retention.py` with an unowned canonical-workspace scan and test it without touching current user changes unrelated to this contract.

- [ ] **Step 4: Verify and commit**

```powershell
$env:AUTH_HMAC_SECRET='test-auth-hmac-secret-at-least-32-bytes'
python -m pytest server/tests/test_project_ownership.py server/tests/test_media_retention.py -k 'delete or orphan' -v
git add server/app/projects/repository.py server/app/main.py server/tests/test_project_ownership.py server/app/media_retention.py server/tests/test_media_retention.py
git commit -m "feat(projects): add owned project deletion"
```

Stage retention files only if this task changed them, and preserve any pre-existing user edits carefully.

### Task 4: Server-Authoritative Project Repository And Browser Cache

**Files:**
- Create: `web/src/features/projects/ProjectRepository.ts`
- Create: `web/src/features/projects/ProjectRepository.test.ts`
- Create: `web/src/platform/storage/BrowserProjectCache.ts`
- Create: `web/src/platform/storage/BrowserProjectCache.test.ts`
- Modify: `web/src/localdb/projectStore.ts`
- Modify: `web/src/localdb/exportProject.ts`
- Modify: `web/src/pages/ProjectsPage.tsx`

**Interfaces:**

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

- [ ] **Step 1: Write failing authority tests**

Assert open fetches server before treating cache as owned; 404 returns null and evicts cache; network failure may return stale read-only cache; mutations reject stale mode; import posts validated content to `/api/projects/import`, rewrites project/media references to returned ID, then caches; delete calls server first and does not alter cache on server failure.

- [ ] **Step 2: Implement import and delete ordering**

For delete:

```ts
async delete(projectId: string): Promise<void> {
  await this.http.json<void>(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
  await this.cache.remove(projectId);
}
```

`cache.remove` performs existing logical project deletion and durable journal transition; it does not wait for physical OPFS cleanup.

- [ ] **Step 3: Adapt ProjectsPage and verify**

```powershell
Set-Location web
npm.cmd test -- --run src/features/projects/ProjectRepository.test.ts src/platform/storage/BrowserProjectCache.test.ts src/localdb/exportProject.test.ts src/localdb/projectStore.test.ts src/pages/ProjectsPage.test.tsx
Set-Location ..
git add web/src/features/projects web/src/platform/storage/BrowserProjectCache.ts web/src/platform/storage/BrowserProjectCache.test.ts web/src/localdb/projectStore.ts web/src/localdb/exportProject.ts web/src/pages/ProjectsPage.tsx
git commit -m "refactor(web): separate projects from browser cache"
```

### Task 5: Media Repository And Blob URL Lifecycle

**Files:**
- Create: `web/src/platform/storage/MediaRepository.ts`
- Create: `web/src/platform/storage/MediaRepository.test.ts`
- Modify: `web/src/localdb/mediaStore.ts`
- Modify: `web/src/localdb/mediaUrls.ts`

**Interfaces:**

```ts
export interface MediaRepository {
  cacheRemote(url: string, metadata: { projectId: string; sourcePath: string }): Promise<LocalMediaRef | null>;
  resolve(ref: LocalMediaRef): Promise<string | null>;
  revokeProject(projectId: string): void;
  deleteProject(projectId: string): Promise<void>;
  estimate(): Promise<StorageEstimate>;
}
```

- [ ] **Step 1: Write failing lifecycle tests**

Cover deduplicated resolution, project-switch revocation, logical project delete, retry metadata surviving OPFS failure, storage estimate refresh, and no raw `URL.createObjectURL` ownership outside this repository.

- [ ] **Step 2: Implement ownership boundary**

Move object URL maps and revoke calls behind `MediaRepository`. `deleteProject` delegates to the durable LocalDB transition: remove visible project/media metadata transactionally, retain cleanup journal until OPFS deletion succeeds, and never return a resolvable local ref for staged/deleted media.

- [ ] **Step 3: Verify and commit**

```powershell
Set-Location web
npm.cmd test -- --run src/platform/storage/MediaRepository.test.ts src/localdb/mediaStore.test.ts src/localdb/mediaUrls.test.ts src/localdb/projectStore.test.ts
Set-Location ..
git add web/src/platform/storage web/src/localdb/mediaStore.ts web/src/localdb/mediaUrls.ts
git commit -m "refactor(web): centralize media lifecycle"
```

### Task 6: Generation Service Boundary

**Files:**
- Create: `web/src/features/generation/GenerationService.ts`
- Create: `web/src/features/generation/GenerationService.test.ts`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/app/workbench/WorkbenchProvider.tsx`

**Interfaces:**

```ts
export interface GenerationService {
  optimize(projectId: string, shotId: string, sourceText: string): Promise<PromptOptimizeResponse>;
  saveShot(projectId: string, shotId: string, payload: ShotSaveRequest): Promise<ShotSaveResponse>;
  regenerate(projectId: string, shotId: string): Promise<RegenerateShotResponse>;
  render(projectId: string): Promise<RenderProjectResponse>;
  subscribe(projectId: string, onEvent: (event: JobEvent) => void): () => void;
}
```

- [ ] **Step 1: Write failing service tests**

Cover all methods, unsubscribe, 401 unauthorized propagation, typed 402 with available/required units, failure preserving last successful snapshot, and absence of provider credential fields.

- [ ] **Step 2: Implement and adapt provider**

Service requests contain no `text_key`, `image_key`, `video_key`, `base_url`, or provider credentials. Keep operation tokens and stale-result rejection in `WorkbenchProvider` for Session 6; replace only direct API calls.

- [ ] **Step 3: Verify and commit**

```powershell
Set-Location web
npm.cmd test -- --run src/features/generation/GenerationService.test.ts src/App.test.tsx
Set-Location ..
git add web/src/features/generation web/src/api/client.ts web/src/app/workbench/WorkbenchProvider.tsx
git commit -m "refactor(web): extract generation service"
```

### Task 7: Foundation Verification And Handoff

- [ ] **Step 1: Run backend project gates**

```powershell
$env:AUTH_HMAC_SECRET='test-auth-hmac-secret-at-least-32-bytes'
python -m pytest server/tests/test_project_ownership.py server/tests/test_media_retention.py server/tests/test_api.py -q
python -m alembic check
```

- [ ] **Step 2: Run full frontend and static gates**

```powershell
Set-Location web
npm.cmd test -- --run
npm.cmd run build
rg -n 'ProviderDrawer|KeyGate|text_key|image_key|video_key|base_url' src
```

Expected: all tests/build pass; no production credential matches.

- [ ] **Step 3: Report Session 6 interfaces**

Report commits and exact exported interfaces for `HttpClient`, `ProjectRepository`, `BrowserProjectCache`, `MediaRepository`, and `GenerationService`; backend delete behavior; test totals; and preserved dirty files. Session 6 starts only after this gate is green.
