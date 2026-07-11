# OpenMontage Frontend Acceptance Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining frontend-optimization acceptance gaps without redesigning the workbench or conflicting with the parallel auth and billing frontend work.

**Architecture:** Keep the current routed workbench, `WorkbenchProvider`, and browser-local repositories. Apply narrow behavior fixes behind existing interfaces, then integrate the shared shell only after the auth and billing frontend commits land. Browser-local storage hardening already merged in commits `0941e40`, `c7e8cec`, `41fed6b`; verify it, do not reimplement it.

**Tech Stack:** React 18, TypeScript 5.6, React Router 6, Vitest, Testing Library, IndexedDB, OPFS, Vite 5.

## Global Constraints

- Do not revert or rewrite unrelated user changes in `server/`, billing plans, auth code, or `web/src/components/StoryboardWaterfall.tsx`.
- Do not modify login, registration, wallet, order, payment, or administrator business behavior in this plan.
- Do not reintroduce browser provider keys after billing removes `ProviderDrawer`, `KeyGate`, or key-bearing request fields.
- `>= 1180px`, `768px - 1179px`, and `< 768px` remain the exact responsive ranges.
- AI optimization changes only the prompt, shot intent, and shot-language fields; save and regenerate remain explicit separate commands.
- Existing data remains visible while asynchronous work runs; a failed operation must not erase the last successful result.
- All behavior changes use red-green TDD. Run the named failing test before production edits.
- Paid model calls, payment submission, and account mutations are not part of browser smoke unless dedicated test credentials and fixtures are explicitly available.
- Before editing a shared file, compare its current content with the auth and billing integration commits. Stop rather than overwriting an active parallel edit.

## Execution Preflight

Run from the repository root:

```powershell
git status --short --branch
git log --oneline -12
npm.cmd test -- --run
npm.cmd run build
```

Working directory for the npm commands: `web`.

Expected baseline: all frontend tests and the production build pass. Record the exact commit containing auth Task 7 and billing Task 12 when they appear. Tasks 1-4 may proceed before those frontend integrations; Task 5 must wait for both.

## File Ownership Map

- `web/src/components/storyboard/shotDraft.ts` owns field-level AI optimization undo state.
- `web/src/components/storyboard/ShotList.tsx` owns shot-list presentation, including thumbnails.
- `web/src/pages/StoryboardPage.tsx` adapts media resolution into the list and current preview.
- `web/src/app/workbench/WorkbenchProvider.tsx` owns render operation state and snapshot replacement.
- `web/src/pages/ProjectsPage.tsx` owns visible project render status.
- `web/src/pages/NewProjectPage.tsx` owns form validation only; request errors belong to the shared error surface.
- `web/src/components/accessibility/useModalFocus.ts` owns modal Tab/Escape/return-focus behavior.
- `web/src/components/shell/AppShell.tsx` owns breadcrumb layout only after auth/billing shell integration.
- `web/src/localdb/*` remains the browser cache/backup boundary already hardened by the current baseline.

---

### Task 1: Make AI Optimization Undo Field-Scoped

**Files:**
- Modify: `web/src/components/storyboard/shotDraft.ts`
- Modify: `web/src/components/storyboard/shotDraft.test.ts`

**Interfaces:**
- Consumes: `ShotDraftFields`, `PromptOptimizeResponse`.
- Produces: `PromptOptimizationUndo` and field-preserving `undoPromptOptimization(state)`.

- [ ] **Step 1: Write the failing field-preservation test**

Add this case to `shotDraft.test.ts`:

```ts
it("undoes only AI-owned fields and preserves later manual edits", () => {
  const initial = createShotDraftState(createShot({
    prompt: "before prompt",
    props: ["old prop"],
    asset_ids: ["asset-1"],
    shot_intent: "before intent",
    shot_language: { shot_size: "wide" },
  }));
  const optimized = applyPromptOptimization(initial, {
    project_id: "p1",
    model: "text-model",
    optimized_text: "optimized prompt",
    notes: [],
    shot_intent: "optimized intent",
    shot_language: { shot_size: "close_up" },
  });
  const edited = {
    ...optimized,
    draft: {
      ...optimized.draft,
      props: ["new prop"],
      assetIds: ["asset-1", "asset-2"],
      location: "new location",
    },
  };

  const undone = undoPromptOptimization(edited);

  expect(undone.draft).toMatchObject({
    prompt: "before prompt",
    shotIntent: "before intent",
    shotLanguage: { shot_size: "wide" },
    props: ["new prop"],
    assetIds: ["asset-1", "asset-2"],
    location: "new location",
  });
  expect(undone.undoOptimization).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npm.cmd test -- --run src/components/storyboard/shotDraft.test.ts
```

Expected: FAIL because current undo replaces the complete draft and restores the old prop, asset, and location values.

- [ ] **Step 3: Narrow the undo snapshot to AI-owned fields**

Use this shape in `shotDraft.ts`:

```ts
export interface PromptOptimizationUndo {
  prompt: string;
  shotIntent: string;
  shotLanguage: ShotLanguage;
}

export interface ShotDraftState {
  shotId: string | null;
  baseline: ShotDraftFields;
  draft: ShotDraftFields;
  undoOptimization: PromptOptimizationUndo | null;
}

function optimizationFields(value: ShotDraftFields): PromptOptimizationUndo {
  return {
    prompt: value.prompt,
    shotIntent: value.shotIntent,
    shotLanguage: { ...value.shotLanguage },
  };
}
```

In `applyPromptOptimization`, set `undoOptimization: optimizationFields(state.draft)`. Implement undo as a merge:

```ts
export function undoPromptOptimization(state: ShotDraftState): ShotDraftState {
  if (!state.undoOptimization) return state;
  return {
    ...state,
    draft: {
      ...state.draft,
      prompt: state.undoOptimization.prompt,
      shotIntent: state.undoOptimization.shotIntent,
      shotLanguage: { ...state.undoOptimization.shotLanguage },
    },
    undoOptimization: null,
  };
}
```

- [ ] **Step 4: Verify GREEN and regressions**

```powershell
npm.cmd test -- --run src/components/storyboard/shotDraft.test.ts src/components/ShotEditor.test.tsx
```

Expected: both suites PASS.

- [ ] **Step 5: Commit**

```powershell
git add web/src/components/storyboard/shotDraft.ts web/src/components/storyboard/shotDraft.test.ts
git commit -m "fix(web): scope prompt optimization undo"
```

---

### Task 2: Add Stable Shot-List Thumbnails

**Files:**
- Modify: `web/src/components/storyboard/ShotList.tsx`
- Modify: `web/src/pages/StoryboardPage.tsx`
- Modify: `web/src/pages/StoryboardPage.test.tsx`
- Modify: `web/src/styles/pages.css`

**Interfaces:**
- Consumes: existing `resolveShotMedia(shot) -> string | null`.
- Produces: `ShotListProps.resolveShotMedia` and fixed-size thumbnail media for every visible shot.

- [ ] **Step 1: Write the failing page test**

In `StoryboardPage.test.tsx`, render two shots and use a deterministic resolver:

```tsx
it("shows a stable thumbnail for every shot with resolved media", () => {
  renderPage({
    shots: [createShot({ id: "s1", index: 1 }), createShot({ id: "s2", index: 2 })],
    resolveShotMedia: (shot) => `blob:${shot.id}`,
  });

  expect(screen.getByLabelText("分镜 1 缩略预览")).toHaveAttribute("src", "blob:s1");
  expect(screen.getByLabelText("分镜 2 缩略预览")).toHaveAttribute("src", "blob:s2");
});
```

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd test -- --run src/pages/StoryboardPage.test.tsx
```

Expected: FAIL because `ShotList` does not receive or render media.

- [ ] **Step 3: Add the resolver contract and thumbnail markup**

Extend `ShotListProps`:

```ts
resolveShotMedia: (shot: Shot) => string | null;
```

Resolve once inside the map and render a video thumbnail or a stable placeholder:

```tsx
const mediaUrl = resolveShotMedia(shot);

<span className="shot-list-thumbnail" aria-hidden={mediaUrl ? undefined : "true"}>
  {mediaUrl ? (
    <video
      aria-label={`${strings.storyboardPage.shotTitle(shot.index)} 缩略预览`}
      src={mediaUrl}
      muted
      playsInline
      preload="metadata"
    />
  ) : (
    <span className="shot-list-thumbnail-placeholder" />
  )}
</span>
```

Pass `resolveShotMedia` from both desktop/mobile `ShotList` usage in `StoryboardPage`.

- [ ] **Step 4: Add fixed dimensions without resizing list rows**

Add to `pages.css`:

```css
.shot-list-thumbnail {
  display: block;
  width: 72px;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--om-border);
  border-radius: 4px;
  background: #111827;
  flex: 0 0 auto;
}

.shot-list-thumbnail video,
.shot-list-thumbnail-placeholder {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
```

- [ ] **Step 5: Verify tests and responsive layout**

```powershell
npm.cmd test -- --run src/pages/StoryboardPage.test.tsx src/styles/responsive.test.ts
```

Expected: PASS; no row changes height when media metadata arrives.

- [ ] **Step 6: Commit**

```powershell
git add web/src/components/storyboard/ShotList.tsx web/src/pages/StoryboardPage.tsx web/src/pages/StoryboardPage.test.tsx web/src/styles/pages.css
git commit -m "fix(web): show shot list thumbnails"
```

---

### Task 3: Preserve The Last Successful Final Render On Failure

**Files:**
- Modify: `web/src/app/workbench/WorkbenchProvider.tsx`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: existing `renderProject`, snapshot revision guards, `busy.rendering`.
- Produces: render-in-progress state that leaves `snapshot.final_path` and `render_report` untouched until success.

- [ ] **Step 1: Write the failing integration test**

Add a test with a snapshot containing `final_path: "local://media/old-final"`, resolve it to `blob:old-final`, reject `renderProject`, click `生成最终成片`, and assert:

```tsx
expect(await screen.findByLabelText("最终成片预览")).toHaveAttribute("src", "blob:old-final");
fireEvent.click(screen.getByRole("button", { name: "生成最终成片" }));
expect(await screen.findByRole("alert")).toHaveTextContent("render failed");
expect(screen.getByLabelText("最终成片预览")).toHaveAttribute("src", "blob:old-final");
expect(screen.getByRole("button", { name: "下载最终成片" })).toBeEnabled();
expect(localProjectStoreMocks.saveProjectSnapshot).not.toHaveBeenCalledWith(
  expect.objectContaining({ final_path: null }),
);
```

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd test -- --run src/App.test.tsx
```

Expected: FAIL because `renderFinal()` clears `final_path` before the request.

- [ ] **Step 3: Remove destructive pre-request snapshot replacement**

In `renderFinal`, delete:

```ts
applyProjectSnapshot({ ...current, final_path: null });
```

Keep:

```ts
setBusyValue("rendering", true);
setError(null);
const responseBaseRevision = snapshotRevisionRef.current;
```

Continue replacing `render_report` and `final_path` only after a successful authoritative or POST response. The catch branch sets the error and leaves the snapshot unchanged.

- [ ] **Step 4: Verify GREEN and concurrency regressions**

```powershell
npm.cmd test -- --run src/App.test.tsx src/pages/ProductionPage.test.tsx
```

Expected: PASS, including existing concurrent-save/render-cache tests.

- [ ] **Step 5: Commit**

```powershell
git add web/src/app/workbench/WorkbenchProvider.tsx web/src/App.test.tsx
git commit -m "fix(web): retain final render during retries"
```

---

### Task 4: Complete Project Status And Error Ownership

**Precondition:** The billing frontend has removed browser provider readiness/key gating from project creation, or the billing worker has explicitly confirmed it will not modify `NewProjectPage.tsx` and `NewProjectPage.test.tsx`. The project-status steps may run earlier; the error-ownership steps must wait when these files overlap.

**Files:**
- Modify: `web/src/pages/ProjectsPage.tsx`
- Modify: `web/src/pages/ProjectsPage.test.tsx`
- Modify: `web/src/pages/NewProjectPage.tsx`
- Modify: `web/src/pages/NewProjectPage.test.tsx`
- Modify after auth/billing merge: `web/src/app/AppRoutes.test.tsx`

**Interfaces:**
- Produces: visible `已有成片` or `未生成成片` for every project; local form validation errors remain local while request errors render only in the shared error surface.

- [ ] **Step 1: Write failing project-status and single-error tests**

Add:

```tsx
expect(screen.getByText("未生成成片")).toBeInTheDocument();
```

for a summary with `hasFinalRender: false`.

For creation failure, render the routed app, reject the API, submit a valid form, and assert:

```tsx
expect(await screen.findAllByRole("alert")).toHaveLength(1);
expect(screen.getByRole("alert")).toHaveTextContent("create failed");
```

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd test -- --run src/pages/ProjectsPage.test.tsx src/pages/NewProjectPage.test.tsx src/app/AppRoutes.test.tsx
```

Expected: project-status assertion fails and the routed failure exposes duplicate alerts.

- [ ] **Step 3: Render both project states explicitly**

Use:

```tsx
<span className={`status-pill ${project.hasFinalRender ? "status-complete" : "status-pending"}`}>
  {project.hasFinalRender ? "已有成片" : "未生成成片"}
</span>
```

- [ ] **Step 4: Separate validation and request errors**

Rename `NewProjectPage` local state to `validationError`. Set it only when the prompt is empty. In the request catch, do not create another alert:

```ts
} catch {
  // WorkbenchProvider owns request-error presentation and preserves form values.
} finally {
  setCreating(false);
}
```

Keep title and prompt state untouched on failure.

- [ ] **Step 5: Verify GREEN**

```powershell
npm.cmd test -- --run src/pages/ProjectsPage.test.tsx src/pages/NewProjectPage.test.tsx src/app/AppRoutes.test.tsx
```

Expected: PASS with one request error surface.

- [ ] **Step 6: Commit**

```powershell
git add web/src/pages/ProjectsPage.tsx web/src/pages/ProjectsPage.test.tsx web/src/pages/NewProjectPage.tsx web/src/pages/NewProjectPage.test.tsx web/src/app/AppRoutes.test.tsx
git commit -m "fix(web): clarify project status and errors"
```

---

### Task 5: Integrate Breadcrumbs And Modal Focus After Auth/Billing Merge

**Precondition:** Auth Task 7 and Billing Task 12 frontend commits are merged. `AppShell` contains account/logout and wallet actions, `/login` and `/wallet` routes exist, and browser provider-key UI is absent. If any condition is false, stop this task without modifying shared files.

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
- Consumes: merged account and wallet shell actions without changing their behavior.
- Produces: route-derived breadcrumb and reusable modal focus trapping.

- [ ] **Step 1: Verify the integration precondition**

```powershell
rg -n "RequireAuth|/login|/wallet|useAuth|退出|余额" web/src
rg -n "ProviderDrawer|KeyGate|text_key|image_key|video_key" web/src
```

Expected: auth/wallet runtime matches exist; provider-key runtime matches do not.

- [ ] **Step 2: Write failing breadcrumb and Tab-cycle tests**

Breadcrumb assertion:

```tsx
expect(screen.getByRole("navigation", { name: "面包屑" })).toHaveTextContent(
  "项目列表Pending Relatives分镜编辑",
);
```

Focus assertion for each dialog class:

```tsx
await userEvent.tab();
expect(document.activeElement).toBe(firstFocusableElement);
await userEvent.tab({ shift: true });
expect(document.activeElement).toBe(lastFocusableElement);
```

- [ ] **Step 3: Implement the reusable modal focus hook**

Create a hook with this public contract:

```ts
export interface ModalFocusOptions {
  open: boolean;
  onEscape: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function useModalFocus<T extends HTMLElement>(
  options: ModalFocusOptions,
): {
  panelRef: RefObject<T | null>;
  onKeyDown: KeyboardEventHandler<T>;
}
```

The handler closes on Escape. On Tab it queries enabled, visible `a`, `button`, `input`, `select`, `textarea`, and `[tabindex]:not([tabindex="-1"])` descendants, wraps last-to-first and first-to-last, and prevents focus from leaving an empty dialog. The effect focuses the first item when opened and restores `returnFocusRef.current` when closed/unmounted.

- [ ] **Step 4: Add a compact route-derived breadcrumb without changing shell actions**

Inside `AppShell`, map the current project pathname to one of `分镜编辑`, `全局设定`, `资源库`, `制作与成片`. Render:

```tsx
<nav className="workbench-breadcrumb" aria-label="面包屑">
  <Link to={projectRoutes.list} onClick={handleNavigate}>项目列表</Link>
  {project ? <span>{project.title}</span> : null}
  {currentPageLabel ? <span aria-current="page">{currentPageLabel}</span> : null}
</nav>
```

Do not move, rename, or wrap the merged account and wallet controls.

- [ ] **Step 5: Apply focus trapping to actual modal surfaces**

Use the hook for the merged shell/account/wallet drawer if it is modal, resource detail/upload drawers, and tablet shot-list/inspector dialogs. Preserve current Esc and focus-return accessible names.

- [ ] **Step 6: Verify integration tests and build**

```powershell
npm.cmd test -- --run src/components/accessibility/useModalFocus.test.tsx src/components/shell/AppShell.test.tsx src/pages/StoryboardPage.test.tsx src/pages/ResourceLibraryPage.test.tsx
npm.cmd run build
```

Expected: PASS and no auth/wallet behavior assertions change.

- [ ] **Step 7: Commit**

```powershell
git add web/src/components/accessibility web/src/components/shell/AppShell.tsx web/src/components/shell/AppShell.test.tsx web/src/pages/StoryboardPage.tsx web/src/pages/StoryboardPage.test.tsx web/src/pages/ResourceLibraryPage.tsx web/src/pages/ResourceLibraryPage.test.tsx web/src/styles/shell.css
git commit -m "fix(web): finish shell accessibility contract"
```

---

### Task 6: Close Static Acceptance Gates

**Files:**
- Modify: `docs/superpowers/plans/2026-06-30-short-drama-workbench-web.md`
- Verify only: `web/src/localdb/exportProject.ts`
- Verify only: `web/src/localdb/projectStore.ts`
- Verify only: `web/src/localdb/mediaStore.ts`

- [ ] **Step 1: Replace fake secret-shaped samples**

Replace the fake provider-key examples in the target plan with `test-key-redacted` and update assertions to the corresponding masked result. Do not weaken the scanner and do not add a baseline exception.

- [ ] **Step 2: Run exact static gates**

```powershell
rg -n "sk-[A-Za-z0-9_-]{12,}" web/src docs/superpowers
rg -n "shot_count" web/src
rg -n "wallet|pricing|subscription|template-market|/login|/recharge" web/src/app web/src/App.tsx
```

Expected: secret scan has no matches; `shot_count` appears only in legacy domain types or omission tests; login/wallet matches are only the newly approved auth/billing routes, not legacy fake routes.

- [ ] **Step 3: Re-run hardened local-storage suites**

```powershell
npm.cmd test -- --run src/localdb/exportProject.test.ts src/localdb/projectStore.test.ts src/localdb/mediaStore.test.ts
```

Expected: malformed imports, duplicate refs, overwrite conflicts, rollback, quota limits, and project-media deletion all PASS.

- [ ] **Step 4: Commit**

```powershell
git add docs/superpowers/plans/2026-06-30-short-drama-workbench-web.md
git commit -m "docs: remove secret-shaped test examples"
```

---

### Task 7: Run Final Automated And Browser Acceptance

**Files:**
- Modify only if a regression is found: the owning test and implementation files from Tasks 1-6.

- [ ] **Step 1: Run the complete frontend gate**

```powershell
npm.cmd test -- --run
npm.cmd run build
```

Expected: all tests PASS; TypeScript and Vite exit 0.

- [ ] **Step 2: Start or reuse local services**

```powershell
uvicorn server.app.main:create_app --factory --host 127.0.0.1 --port 8787
cd web
npm.cmd run dev -- --port 5173
```

- [ ] **Step 3: Verify three viewports with browser control**

Inspect `1440x900`, `1024x768`, and `390x844`. Check project list, new project, storyboard, settings, resources, production, login, and wallet. Expected: no horizontal overflow, clipping, incoherent overlap, hidden shell actions, or simultaneous drawers.

- [ ] **Step 4: Verify the safe human-click workflow**

Click through project open, all shot selection, AI undo using mocked/test backend only, save/regenerate separation, deep-link reload, browser back/forward, settings draft guard, resource drawer exclusion, project deletion cancel, account menu, wallet navigation, and recharge-page navigation. Verify console errors remain zero.

- [ ] **Step 5: Gate consequential flows**

Only when dedicated test credentials and fixtures exist, run creation, AI optimization, regenerate, render, upload/bind, final preview/download, login mutation, and payment sandbox submission. Otherwise record each as `not executed: test credential or sandbox fixture unavailable`; never report it as passed.

- [ ] **Step 6: Review final status**

```powershell
git status --short --branch
git log --oneline -12
```

Expected: only scoped commits from this plan plus explicitly preserved unrelated user changes.

## Completion Criteria

- Tasks 1-6 have clean task reviews.
- Full frontend tests and production build pass on the final tree.
- All safe browser clicks pass at all three viewports.
- Consequential flows are either verified with explicit test infrastructure or reported as unverified, never inferred.
- Auth and billing behavior remain owned by their parallel plans.
