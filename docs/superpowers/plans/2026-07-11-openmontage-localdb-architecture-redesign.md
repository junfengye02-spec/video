# OpenMontage LocalDB Architecture Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate all untrusted backup decompression in a module Worker and replace best-effort OPFS cleanup with a durable IndexedDB v4 media-operation state machine while keeping generated media immediately visible from remote URLs.

**Architecture:** A shared backup-format layer validates archive and directory entries, while a request-scoped Worker performs the only production ZIP parsing/inflation and streams acknowledged chunks into journal-backed media sessions. IndexedDB v4 stores media write/import operations before OPFS mutation, commits media and projects transactionally, and recovers cleanup work through leased, persisted retries triggered by mount, visibility, and durable due times.

**Tech Stack:** React 18, TypeScript 5.6, Vite 5 module Workers, fflate 0.8 in the Worker only, IndexedDB, OPFS, Vitest 2, Testing Library, fake-indexeddb.

## Global Constraints

- Work directly on the existing `main` branch as explicitly authorized by the user; preserve every pre-existing staged, unstaged, and untracked change.
- No backend field, endpoint, protocol, or storage change.
- No production main-thread module may import or execute `Unzip`, `UnzipInflate`, `AsyncInflate`, or another ZIP decoder.
- Every untrusted deflated entry is processed in `backupImport.worker.ts`; ZIP metadata is only an early rejection hint and actual emitted bytes are authoritative.
- Preserve single-file `.omproj` import when a module Worker is available and provide local extracted-directory import when it is unavailable or blocked.
- Preserve legacy v0 backups, version 1 backups, the existing export contract, browser-local projects, media caches, final-video downloads, and conflict confirmation.
- Existing limits remain exact: 512 MiB compressed archive, 512 entries, 256 MiB per entry, 8 MiB per manifest, and 1 GiB actual total output.
- ZIP uses a Worker-internal two-pass read so manifests may appear anywhere without buffering media on the main thread; ZIP and directory inputs both reject unsafe, duplicate, missing, and undeclared retained files.
- `LocalMediaRecord.state` is `"staged" | "committed"`; v1/v2/v3 records migrate as committed. `[projectId, sourcePath]` is non-unique and hydration selects the newest committed record by `createdAt`.
- A writer holds and renews a bounded lease while streaming; recovery can claim only due records whose lease is absent or expired.
- Retry backoff starts at 5 seconds, caps at 1 hour, and has no retry-count cutoff. Compatibility orphan cleanup waits 24 hours and rechecks both media and operation stores immediately before deletion.
- Generation/render success and busy completion do not wait for local caching. Cache failure retains the remote result and is reported only as non-blocking local-backup status.
- Raw `local://media/...` values never appear in visible text or media attributes.
- Use TDD for every behavior change: record the focused RED command/output, implement minimally, then record GREEN and full-suite evidence.
- Baseline on 2026-07-11: focused LocalDB/project tests 74/74 pass, full frontend 299/299 pass, and `npm.cmd run build` exits 0 with only inherited React Router future warnings.

---

### Task 1: IndexedDB v4 Schema And Journal Primitives

**Files:**
- Modify: `web/src/localdb/types.ts`
- Modify: `web/src/localdb/indexedDb.ts`
- Create: `web/src/localdb/mediaJournal.ts`
- Create: `web/src/localdb/mediaJournal.test.ts`
- Modify: `web/src/localdb/projectStore.test.ts`

**Interfaces:**
- Produces: `MediaJournalRecord`, `MediaOperationRecord`, `MediaImportSessionRecord`, `MediaDurabilityError`, `MediaRecoveryError`, journal CRUD/lease helpers, and IndexedDB v4 stores/indexes.
- Produces: `media` indexes `projectId` and `projectSource`; `mediaOperations` indexes `projectId`, `nextAttemptAt`, and `leaseExpiresAt`.

- [ ] **Step 1: Write failing schema and journal tests**

Add tests that open v1, v2, and v3 databases and assert v4 creates `mediaOperations`, all required indexes, and the non-unique `[projectId, sourcePath]` index while preserving old stores. Add focused tests for operation creation, token/state checked updates, import-session creation, atomic lease contention between two database connections, lease expiry, and 5-second-to-1-hour backoff without an attempt cutoff.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm.cmd test -- src/localdb/mediaJournal.test.ts src/localdb/projectStore.test.ts
```

Expected: FAIL because v4 records, stores, indexes, and journal helpers do not exist.

- [ ] **Step 3: Add exact v4 types and schema**

Define the design-document `MediaOperationRecord` and `MediaImportSessionRecord` fields verbatim. Extend `LocalMediaRecord` with `state: "staged" | "committed"` and `importSessionId: string | null`; treat absent legacy values as committed at read/migration boundaries. Set `LOCAL_DB_VERSION = 4`, retain `mediaPending` as a migration source, and create all required indexes idempotently in `onupgradeneeded`.

- [ ] **Step 4: Implement transaction-scoped journal helpers**

Expose focused functions for creating a write operation before OPFS access, creating an import session, renewing a writer lease, transitioning to `cleanup_due`, claiming one due record atomically, recording retry failure, and completing a claimed record. Every mutation re-reads the record and checks its ID/state/lease owner; initial journal failure throws `MediaDurabilityError`.

- [ ] **Step 5: Verify GREEN and commit**

```powershell
npm.cmd test -- src/localdb/mediaJournal.test.ts src/localdb/projectStore.test.ts
npm.cmd test
git add web/src/localdb/types.ts web/src/localdb/indexedDb.ts web/src/localdb/mediaJournal.ts web/src/localdb/mediaJournal.test.ts web/src/localdb/projectStore.test.ts
git commit -m "feat(web): add durable media journal schema"
```

Expected: focused and full frontend tests PASS.

---

### Task 2: Streaming Media Writes And Durable Recovery

**Files:**
- Modify: `web/src/localdb/mediaStore.ts`
- Modify: `web/src/localdb/mediaStore.test.ts`
- Create: `web/src/localdb/testStorage.ts`
- Modify: `web/src/localdb/mediaJournal.ts`
- Modify: `web/src/localdb/mediaJournal.test.ts`

**Interfaces:**
- Produces: `beginMediaWrite(input): Promise<MediaWriteSession>` where `MediaWriteSession` has `operationId`, `mediaRef`, `write(chunk)`, `commit()`, and `abort(cause?)`.
- Produces: `runMediaRecovery(options?)`, `startMediaRecoveryController()`, `findCommittedMedia(projectId, sourcePath)`, and compatible `saveMediaBlob`, `cacheRemoteMedia`, `loadMediaBlob`, `deleteMediaBlob` facades.

- [ ] **Step 1: Write crash-point and recovery tests**

Use a controllable OPFS harness to stop before journal commit, after journal commit/before file creation, during write, during close, after close/before media commit, and during cleanup. Recreate the recovery controller for every crash case. Assert no OPFS access when initial journaling fails, actual byte verification, no local ref before media commit, durable `cleanup_due` on failure, expired-writer recovery, lease contention, retry persistence, and 24-hour compatibility orphan protection with immediate recheck.

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd test -- src/localdb/mediaStore.test.ts src/localdb/mediaJournal.test.ts
```

Expected: FAIL because the streaming session and durable recovery controller are absent.

- [ ] **Step 3: Implement the write state machine**

`beginMediaWrite()` validates either an existing owning project or an active import session, persists a `writing` operation with a writer lease, then opens OPFS. `write()` streams `Uint8Array` chunks, counts actual bytes, and renews the lease. `commit()` closes, verifies byte count, and in one IndexedDB transaction rechecks the operation token, writes a staged or committed media record, and removes the operation only when appropriate. `abort()` closes best-effort and leaves durable cleanup metadata.

When OPFS is unavailable, keep IndexedDB blob compatibility, but perform its metadata/blob write transactionally without inventing an OPFS operation. When OPFS is available, never silently fall back after an OPFS mutation has begun.

- [ ] **Step 4: Implement leased recovery and compatibility migration**

Convert v3 `mediaPending` records idempotently on first recovery and clear each source record only after conversion. Process due journal records through atomic leases, re-read media/operation state before removal, persist exponential backoff on failure, schedule the earliest durable due time, and expose mount/visibility lifecycle hooks without relying on a single timer. Keep `saveMediaBlob()` as a chunking wrapper over `beginMediaWrite()`.

- [ ] **Step 5: Verify GREEN and commit**

```powershell
npm.cmd test -- src/localdb/mediaStore.test.ts src/localdb/mediaJournal.test.ts src/localdb/projectStore.test.ts
npm.cmd test
git add web/src/localdb/mediaStore.ts web/src/localdb/mediaStore.test.ts web/src/localdb/mediaJournal.ts web/src/localdb/mediaJournal.test.ts web/src/localdb/testStorage.ts
git commit -m "feat(web): make media writes durably recoverable"
```

---

### Task 3: Atomic Import Sessions And Project Deletion

**Files:**
- Modify: `web/src/localdb/projectStore.ts`
- Modify: `web/src/localdb/projectStore.test.ts`
- Modify: `web/src/localdb/mediaJournal.ts`
- Modify: `web/src/localdb/mediaJournal.test.ts`

**Interfaces:**
- Produces: `beginProjectImport(projectId)`, `commitImportedProject(snapshot, sessionId, options)`, and `abortProjectImport(sessionId, cause?)`.
- Produces: project deletion that transactionally removes the project and converts owned committed/staged media plus active writes into durable cleanup work.

- [ ] **Step 1: Write failing atomicity/concurrency tests**

Cover staged media being unresolvable before import commit, conflict rejection leaving the project list unchanged and session cleanup queued, one transaction committing project/settings/all session media, crash recovery deleting every staged item, overwrite behavior, shared media reassignment, project deletion with active cache/import writers, and a deleted operation being unable to publish media afterward.

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd test -- src/localdb/projectStore.test.ts src/localdb/mediaJournal.test.ts
```

Expected: FAIL because import-session commit and journaled project deletion do not exist.

- [ ] **Step 3: Implement import-session transactions**

Create the durable session before any staged media write. The final readwrite transaction includes `projects`, `settings`, `media`, and `mediaOperations`; it repeats the overwrite conflict check, writes the project, marks exactly the session's media committed, updates recent project, and deletes session/write records. Cancellation/failure changes the session and its staged media to cleanup work without exposing a project.

- [ ] **Step 4: Implement deletion concurrency**

In one transaction remove the project, clear recent-project state when needed, reassign genuinely shared refs, delete IndexedDB-only media, and transition OPFS media plus active project operations to cleanup. Preserve operation metadata until physical deletion succeeds; writer commit must fail its token/state check after deletion.

- [ ] **Step 5: Verify GREEN and commit**

```powershell
npm.cmd test -- src/localdb/projectStore.test.ts src/localdb/mediaStore.test.ts src/localdb/mediaJournal.test.ts
npm.cmd test
git add web/src/localdb/projectStore.ts web/src/localdb/projectStore.test.ts web/src/localdb/mediaJournal.ts web/src/localdb/mediaJournal.test.ts
git commit -m "feat(web): make imports and deletion atomic"
```

---

### Task 4: Shared Backup Format And Extracted Directory Adapter

**Files:**
- Create: `web/src/localdb/backupFormat.ts`
- Create: `web/src/localdb/backupFormat.test.ts`
- Create: `web/src/localdb/backupDirectoryImport.ts`
- Create: `web/src/localdb/backupDirectoryImport.test.ts`
- Modify: `web/src/localdb/exportProject.ts`
- Modify: `web/src/localdb/exportProject.test.ts`

**Interfaces:**
- Produces: shared backup constants, typed `ValidatedBackupEntry` stream, envelope/media-manifest validators, safe-path rules, byte-limit accounting, and `BackupValidationError`.
- Produces: `readBackupDirectory(files, callbacks, signal?)` with relative-path and unique-basename modes.

- [ ] **Step 1: Write failing format/directory tests**

Cover v0/v1 envelopes, unsafe paths, duplicate paths, entry count, actual per-entry/manifest/total bytes, missing manifests/media, undeclared files, schema errors, `webkitRelativePath` common-root normalization, multiple-file basename fallback, duplicate basenames, progress, and cancellation. Assert ZIP-independent modules contain no fflate import.

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd test -- src/localdb/backupFormat.test.ts src/localdb/backupDirectoryImport.test.ts src/localdb/exportProject.test.ts
```

Expected: FAIL because the shared format and directory adapter are absent.

- [ ] **Step 3: Extract validation without changing export bytes**

Move path, envelope, media-manifest, local-ref, and limit rules out of `exportProject.ts`. Define one entry callback contract (`entry-start`, chunk delivery, `entry-end`, progress, complete) used by both directory and Worker clients. Retain the exact `openmontage-project.json`, `openmontage-media.json`, and `media/...` export names and v0/v1 behavior.

- [ ] **Step 4: Implement the directory adapter**

Use `webkitRelativePath` when every selected file has it and strip exactly one common selected root. Otherwise match required manifest paths by unique basename. Stream `File.slice()` chunks, enforce actual-byte totals, reject duplicates/missing/extra retained files before final commit, and honor `AbortSignal` between every read/callback.

- [ ] **Step 5: Verify GREEN and commit**

```powershell
npm.cmd test -- src/localdb/backupFormat.test.ts src/localdb/backupDirectoryImport.test.ts src/localdb/exportProject.test.ts
npm.cmd test
git add web/src/localdb/backupFormat.ts web/src/localdb/backupFormat.test.ts web/src/localdb/backupDirectoryImport.ts web/src/localdb/backupDirectoryImport.test.ts web/src/localdb/exportProject.ts web/src/localdb/exportProject.test.ts
git commit -m "refactor(web): share backup validation contracts"
```

---

### Task 5: Module Worker Archive Isolation And Client Protocol

**Files:**
- Create: `web/src/localdb/backupImport.worker.ts`
- Create: `web/src/localdb/backupImport.worker.test.ts`
- Create: `web/src/localdb/backupArchiveClient.ts`
- Create: `web/src/localdb/backupArchiveClient.test.ts`
- Modify: `web/src/fflate-browser.d.ts`

**Interfaces:**
- Produces: the exact `BackupWorkerRequest`/`BackupWorkerResponse` union from the design.
- Produces: `readBackupArchive(file, callbacks, signal?)`, `BackupWorkerUnavailableError`, and `BackupWorkerProtocolError`.

- [ ] **Step 1: Write failing Worker/client protocol tests**

Cover request ID isolation, monotonically increasing chunk sequence, one-chunk ACK backpressure, transfer lists, progress, cancellation, malformed/out-of-order messages, synchronous construction failure, CSP-style startup failure, idle timeout, unexpected death, forged ZIP sizes, high compression, actual byte limits, unsafe/duplicate/extra entries, and manifest appearing after media.

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd test -- src/localdb/backupImport.worker.test.ts src/localdb/backupArchiveClient.test.ts
```

Expected: FAIL because the Worker and client modules do not exist.

- [ ] **Step 3: Implement Worker-only ZIP processing**

Only `backupImport.worker.ts` imports fflate ZIP decode APIs. It validates compressed input/headers, performs a first Worker-internal pass to locate and validate bounded manifests regardless of archive ordering, then a second pass to inflate and stream retained media. Actual emitted bytes enforce limits. It transfers one chunk and waits for matching ACK before sending the next retained chunk; cancellation terminates all decoders and releases state.

- [ ] **Step 4: Implement strict module Worker client**

Construct with `new Worker(new URL("./backupImport.worker.ts", import.meta.url), { type: "module" })`. Validate every response field/request/sequence/name/lifecycle, ACK only after the consumer resolves, terminate on abort/failure/timeout/complete, classify only construction/startup unavailability as `BackupWorkerUnavailableError`, and classify corruption/death/timeout as `BackupWorkerProtocolError`. Never import fflate or fall back to main-thread extraction.

- [ ] **Step 5: Verify GREEN, boundary scan, and commit**

```powershell
npm.cmd test -- src/localdb/backupImport.worker.test.ts src/localdb/backupArchiveClient.test.ts
rg -n "AsyncInflate|UnzipInflate|new Unzip" src --glob "!localdb/backupImport.worker.ts" --glob "!**/*.test.ts"
npm.cmd test
npm.cmd run build
git add web/src/localdb/backupImport.worker.ts web/src/localdb/backupImport.worker.test.ts web/src/localdb/backupArchiveClient.ts web/src/localdb/backupArchiveClient.test.ts web/src/fflate-browser.d.ts
git commit -m "feat(web): isolate backup inflation in worker"
```

Expected scan: zero production matches outside `backupImport.worker.ts`.

---

### Task 6: Journal-Backed Backup Import Facade And Project UI

**Files:**
- Modify: `web/src/localdb/exportProject.ts`
- Modify: `web/src/localdb/exportProject.test.ts`
- Modify: `web/src/pages/ProjectsPage.tsx`
- Modify: `web/src/pages/ProjectsPage.test.tsx`
- Modify: `web/src/i18n.ts`
- Modify if required for layout only: `web/src/styles/pages.css`

**Interfaces:**
- Produces: `importProjectBackup(file, options)`, `importProjectBackupDirectory(files, options)`, shared progress/cancellation options, and unchanged `exportProjectBackup(projectId)`.
- Consumes: Worker/directory validated entries and Task 3 import sessions.

- [ ] **Step 1: Write failing facade and UI tests**

Cover ZIP/directory equivalence, streamed chunks entering one media write session, cancellation before final commit, staged rollback, overwrite conflict at final transaction, Worker unavailable fallback, protocol error messaging, progress, always-visible extracted-directory action, directory-primary state after Worker unavailability, and unchanged project list on invalid input.

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd test -- src/localdb/exportProject.test.ts src/pages/ProjectsPage.test.tsx
```

Expected: FAIL because facade streaming, directory import, and fallback UI are absent.

- [ ] **Step 3: Implement atomic import orchestration**

Read/validate bounded manifests, create one durable import session, map each declared media entry to `beginMediaWrite({ importSessionId, ... })`, stream chunks directly, rewrite refs, revalidate the final snapshot, and call `commitImportedProject`. Abort every open session and queue cleanup on cancellation/failure. Do not assemble a decompressed media collection on the main thread.

- [ ] **Step 4: Implement accessible fallback UI and copy**

Keep the `.omproj` input and add a separate file input supporting directory/multiple selection (`webkitdirectory` assigned through React-compatible props or a ref). Always show `选择已解压备份`; when Worker use fails, make it the primary action and show one actionable plain-Chinese message. Add byte/entry progress and a cancel command while preserving overwrite confirmation and focus behavior. Work with the existing local modifications in `ProjectsPage.tsx`/test rather than reverting them.

- [ ] **Step 5: Verify GREEN and commit only task files**

```powershell
npm.cmd test -- src/localdb/exportProject.test.ts src/pages/ProjectsPage.test.tsx
npm.cmd test
npm.cmd run build
git add web/src/localdb/exportProject.ts web/src/localdb/exportProject.test.ts web/src/pages/ProjectsPage.tsx web/src/pages/ProjectsPage.test.tsx web/src/i18n.ts web/src/styles/pages.css
git commit -m "feat(web): add isolated backup import fallback"
```

Do not stage unrelated pre-existing changes if `pages.css` is unchanged.

---

### Task 7: Non-Blocking Workbench Caching And Recovery Lifecycle

**Files:**
- Modify: `web/src/app/workbench/WorkbenchProvider.tsx`
- Modify: `web/src/app/workbench/types.ts`
- Modify: `web/src/app/workbench/snapshot.ts`
- Modify: `web/src/app/workbench/snapshot.test.ts`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/app/AppRoutes.test.tsx`
- Modify: `web/src/i18n.ts`

**Interfaces:**
- Consumes: `cacheRemoteMedia`, `findCommittedMedia`, and `startMediaRecoveryController`.
- Produces: remote-first regenerate/render completion, background cache promotion guarded by operation/snapshot tokens, non-blocking cache status, mount/visibility recovery, and reload overlay hydration.

- [ ] **Step 1: Write failing integration tests**

Use deferred cache promises to prove regenerated shot and final render remote URLs render and busy state clears before caching resolves. Assert successful background completion promotes only the still-current source, stale completion cannot overwrite later edits/project switches/deletion, recoverable failure retains remote media and exposes local-backup retry status, raw local refs never render, mount/visibility trigger recovery, and hydration selects the newest committed `[projectId, sourcePath]` overlay.

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd test -- src/App.test.tsx src/app/AppRoutes.test.tsx src/app/workbench/snapshot.test.ts
```

Expected: FAIL because regenerate/render currently wait for caching and no recovery/hydration lifecycle exists.

- [ ] **Step 3: Publish remote success before background cache**

Persist/apply the backend result immediately, complete the primary operation, then launch a background cache task. On cache success, recheck project ID, source path, operation token, and snapshot revision before promoting to a local ref. On failure retain the remote result and set only the local-backup status; never reject the successful generation/render command because caching failed.

- [ ] **Step 4: Add recovery and reload overlay lifecycle**

Start one recovery controller on provider mount, trigger it when the document becomes visible, and dispose timer/listener on unmount. During project hydration, resolve committed media by project/source path and merge local refs as internal overlays without replacing newer server paths. Keep all media attributes routed through the existing object-URL resolver.

- [ ] **Step 5: Verify GREEN and commit**

```powershell
npm.cmd test -- src/App.test.tsx src/app/AppRoutes.test.tsx src/app/workbench/snapshot.test.ts src/localdb/mediaStore.test.ts
npm.cmd test
npm.cmd run build
git add web/src/app/workbench/WorkbenchProvider.tsx web/src/app/workbench/types.ts web/src/app/workbench/snapshot.ts web/src/app/workbench/snapshot.test.ts web/src/App.test.tsx web/src/app/AppRoutes.test.tsx web/src/i18n.ts
git commit -m "feat(web): cache generated media in background"
```

---

### Task 8: Security, Browser, And Migration Acceptance Gate

**Files:**
- Modify tests only when a reproduced acceptance failure requires a regression test.
- Append verification evidence to `.superpowers/sdd/progress.md` (git-ignored scratch file).

**Interfaces:**
- Verifies all twelve acceptance criteria from the approved design; produces no new feature surface.

- [ ] **Step 1: Run focused security and migration gates**

```powershell
rg -n "AsyncInflate|UnzipInflate|new Unzip" web/src --glob "!localdb/backupImport.worker.ts" --glob "!**/*.test.ts"
rg -n "local://media/" web/src --glob "!**/*.test.ts"
cd web
npm.cmd test -- src/localdb/backupFormat.test.ts src/localdb/backupImport.worker.test.ts src/localdb/backupArchiveClient.test.ts src/localdb/backupDirectoryImport.test.ts src/localdb/exportProject.test.ts src/localdb/mediaJournal.test.ts src/localdb/mediaStore.test.ts src/localdb/projectStore.test.ts src/pages/ProjectsPage.test.tsx src/App.test.tsx src/app/AppRoutes.test.tsx
```

Expected: ZIP decoder boundary scan has no production match outside the Worker; local refs occur only in persistence/resolution code; all focused tests PASS.

- [ ] **Step 2: Run complete automated verification**

```powershell
npm.cmd test
npm.cmd run build
```

Expected: all tests PASS and TypeScript/Vite exit 0.

- [ ] **Step 3: Run real Chromium regression through the Vite application**

Verify a real module Worker imports `.omproj` while a main-thread heartbeat remains responsive; high-compression input is rejected in the Worker; Worker construction failure exposes directory import without main-thread inflate; directory success/errors/progress/cancel work; remote shot/final media appears before cache completion; startup/visibility recovery and two-tab lease contention do not duplicate ownership; no raw local ref reaches visible text or media attributes. Check desktop `1440x900` and mobile `390x844`, plus console/network errors.

- [ ] **Step 4: Fix only reproduced failures with TDD, then repeat affected and full gates**

For every failure, first add a focused regression test that fails for the observed reason, implement the minimal fix, rerun the focused command, then rerun `npm.cmd test` and `npm.cmd run build`.

- [ ] **Step 5: Commit any acceptance-only regression fixes**

```powershell
git add <only-files-changed-for-reproduced-fixes>
git commit -m "test(web): close localdb acceptance gaps"
```

Skip this commit when verification required no source change.

## Completion Criteria

- All twelve acceptance criteria in `docs/superpowers/specs/2026-07-11-openmontage-localdb-architecture-redesign-design.md` are individually checked.
- Every implementation task has a clean task-scoped spec/quality review and no open Critical or Important finding.
- A final independent whole-range review approves security, durability, backward compatibility, and user-visible behavior.
- Focused tests, full frontend tests, production build, and real Chromium regression have fresh passing evidence.
