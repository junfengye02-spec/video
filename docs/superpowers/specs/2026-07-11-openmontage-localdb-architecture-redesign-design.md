# OpenMontage LocalDB Architecture Redesign

**Date:** 2026-07-11

**Status:** Approved for implementation planning

## 1. Context

The frontend optimization is implemented on `main`, including browser-local projects, media caching, project backup import/export, and routed workbench pages. The final LocalDB review still blocks completion on two architectural issues:

1. ZIP metadata is attacker-controlled, so compressed or declared uncompressed sizes cannot decide whether deflate is allowed on the browser main thread.
2. OPFS and IndexedDB writes span two storage systems. Timers and best-effort scans do not guarantee that every interrupted write or delete remains durably reachable for retry.

The redesign must close those issues without changing backend protocols or making users wait for local caching before they can see generated media.

## 2. Goals

- Never parse or inflate an untrusted `.omproj` ZIP on the browser main thread.
- Preserve single-file `.omproj` import when a module Worker is available.
- Fall back to importing a user-selected, already-extracted backup directory when Worker execution is unavailable or blocked by CSP.
- Make OPFS create, write, commit, delete, project deletion, startup recovery, and retry expiry part of one durable state machine.
- Show generated or rendered media immediately from its remote URL while local persistence runs in the background.
- Keep `local://media/...` as an internal persistence reference; never display it to the user.
- Preserve legacy v0 backups, version 1 backups, browser-local projects, media caches, final-video downloads, and existing backend request/response contracts.

## 3. Non-Goals

- No server-side ZIP upload or extraction.
- No new backend fields, endpoints, or storage requirements.
- No cloud synchronization, account media library, or cross-device recovery.
- No new wallet, billing, template, publishing, or collaboration behavior.
- No arbitrary archive formats beyond the existing OpenMontage backup format.

## 4. Architecture Overview

The redesign has two independent units:

1. **Backup input isolation**: a dedicated module Worker owns ZIP parsing and inflation. A directory adapter supplies the same validated entry stream without ZIP processing.
2. **Durable media operations**: an IndexedDB operation journal owns every OPFS lifecycle transition and drives cross-tab recovery.

Both units feed the existing project schema validator and atomic project import commit. They share progress and cancellation contracts but do not share implementation state.

## 5. Backup Input Isolation

### 5.1 Files and Responsibilities

- `web/src/localdb/backupImport.worker.ts`
  - Receives a `.omproj` `File` through structured clone.
  - Parses ZIP headers and inflates every deflated entry inside the Worker.
  - Applies entry-name, compressed-size, entry-count, per-entry actual-output, manifest, and total-output limits.
  - Streams retained entry chunks to the main thread with one-chunk acknowledgement backpressure.
- `web/src/localdb/backupArchiveClient.ts`
  - Creates the Vite module Worker using a same-origin module URL.
  - Maps Worker lifecycle, progress, cancellation, timeout, and protocol errors to typed frontend errors.
  - Never imports an inflate implementation and never falls back to main-thread ZIP parsing.
- `web/src/localdb/backupDirectoryImport.ts`
  - Normalizes a directory selection or a multiple-file selection into backup-relative paths.
  - Streams selected JSON and media files through the same import entry contract as the Worker.
- `web/src/localdb/backupFormat.ts`
  - Owns backup path rules, version envelopes, media manifest validation, limits, and the common validated-entry contract.
- `web/src/localdb/exportProject.ts`
  - Keeps the public export/import facade and project commit orchestration.
  - Delegates archive extraction, directory input, schema validation, and media writes to the focused modules above.

### 5.2 Worker Protocol

The protocol is request-scoped and uses monotonically increasing chunk sequence numbers.

```ts
type BackupWorkerRequest =
  | { type: "start"; requestId: string; file: File }
  | { type: "ack"; requestId: string; sequence: number }
  | { type: "cancel"; requestId: string };

type BackupWorkerResponse =
  | { type: "progress"; requestId: string; compressedBytes: number; entries: number }
  | { type: "entry-start"; requestId: string; name: string; contentLength: number | null }
  | { type: "entry-chunk"; requestId: string; name: string; sequence: number; chunk: ArrayBuffer }
  | { type: "entry-end"; requestId: string; name: string; actualBytes: number }
  | { type: "complete"; requestId: string }
  | { type: "failure"; requestId: string; code: string; message: string };
```

- Each `entry-chunk` transfers its `ArrayBuffer`; the Worker sends the next retained chunk only after the matching `ack`.
- Manifest entries are retained in memory only up to the existing 8 MiB manifest limit.
- Media chunks flow directly into a journal-backed media write session; the main thread does not assemble an unbounded archive or decompressed media collection.
- Cancellation terminates the Worker and aborts all media write sessions before any project becomes visible.

### 5.3 Security Boundary

- All deflated entries, including entries that claim small compressed and uncompressed sizes, execute inside the dedicated Worker.
- ZIP-provided sizes are used only for early rejection. Actual emitted bytes remain authoritative for limits.
- The main thread does not register `UnzipInflate`, `AsyncInflate`, or any other ZIP decoder.
- Worker unavailability, construction failure, CSP rejection, protocol corruption, and Worker death produce `BackupWorkerUnavailableError` or `BackupWorkerProtocolError`.
- Those errors expose the extracted-directory fallback. They never trigger synchronous decompression.

### 5.4 Extracted-Directory Fallback

The fallback is local browser file selection, not a backend upload.

- The UI always exposes `选择已解压备份` as a secondary import option. When ZIP Worker import is unavailable, the directory option becomes the primary import action.
- A directory selection uses `webkitRelativePath` when available.
- A multiple-file selection without relative paths matches manifest paths by unique basename only.
- Duplicate basenames, missing manifests, missing media, undeclared files, unsafe paths, version errors, or size-limit violations fail before any project commit.
- ZIP and directory inputs share the same schema validation, conflict confirmation, staged media import, progress, cancellation, and atomic project commit.

## 6. Durable Media Operation Journal

### 6.1 IndexedDB Version 4

Database version 4 adds `mediaOperations` with indexes on `projectId`, `nextAttemptAt`, and `leaseExpiresAt`. Existing `projects`, `settings`, and `media` stores remain compatible.

```ts
interface MediaOperationRecord {
  id: string;
  kind: "media_write";
  mediaId: string;
  projectId: string | null;
  importSessionId: string | null;
  sourcePath: string;
  contentType: string;
  sizeBytes: number;
  opfsPath: string;
  state: "writing" | "cleanup_due";
  createdAt: string;
  updatedAt: string;
  attempts: number;
  nextAttemptAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

interface MediaImportSessionRecord {
  id: string;
  kind: "import_session";
  projectId: string;
  mediaIds: string[];
  state: "importing" | "cleanup_due";
  createdAt: string;
  updatedAt: string;
  attempts: number;
  nextAttemptAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

type MediaJournalRecord = MediaOperationRecord | MediaImportSessionRecord;
```

`mediaOperations` stores the `MediaJournalRecord` union. The import-session variant groups staged media for one project import. Media records created for an import remain staged and are not resolvable until the final project transaction commits the session.

Version 1 and 2 media records are treated as committed. Version 3 `mediaPending` records are migrated idempotently during the first recovery run. Legacy pending records without a project ID become cleanup operations after their original protection window; the old store is retained only as a migration source and cleared after successful conversion.

### 6.2 Write State Machine

`beginMediaWrite()` returns a session with `write`, `commit`, and `abort` methods.

```ts
interface MediaWriteSession {
  readonly operationId: string;
  readonly mediaRef: LocalMediaRef;
  write(chunk: Uint8Array): Promise<void>;
  commit(): Promise<LocalMediaRef>;
  abort(cause?: unknown): Promise<void>;
}
```

Normal cache writes follow this order:

1. In IndexedDB, validate the owning project and persist a `writing` operation before touching OPFS.
2. Create and stream the OPFS file.
3. Close the file and verify the actual byte count.
4. In one IndexedDB transaction, re-read the operation token, require `state === "writing"`, write the committed media record, and delete the operation.
5. Return the internal local media reference only after step 4 completes.

The user-facing generation or render workflow does not wait for step 5. It displays the remote result immediately and runs this state machine as a background cache task.

If OPFS create, write, close, verification, or final IndexedDB commit fails:

- The operation transitions to `cleanup_due` with durable retry metadata.
- If that transition also fails, the original `writing` record remains durable and becomes recoverable when its lease/protection window expires.
- A local reference is never returned before the committed media record exists.
- If even the initial operation record cannot be stored, the code throws `MediaDurabilityError` before OPFS is touched.

### 6.3 Import Sessions

- Project import creates a durable import-session record before staging media.
- Each staged media operation links to `importSessionId` and produces a non-resolvable staged media record.
- The final readwrite transaction performs the project conflict check, writes the project snapshot, marks all session media committed, updates the recent-project setting, and deletes the session operations.
- Cancellation or failure changes the session to cleanup work. Recovery deletes every staged OPFS/IndexedDB media item before removing the session record.
- A crashed import can never expose a partial project or a resolvable partial media set.

### 6.4 Recovery and Cross-Tab Leasing

Recovery starts in three places:

- Workbench provider mount.
- `visibilitychange` when the document becomes visible.
- A timer scheduled for the earliest durable `nextAttemptAt`.

For each due operation:

1. A readwrite transaction claims a lease with a random tab owner ID and bounded expiry.
2. IndexedDB serialization ensures only one tab owns the operation.
3. The owner re-reads the operation and committed media immediately before destructive OPFS work.
4. Successful cleanup deletes the OPFS file, staged/committed metadata as appropriate, and the operation record.
5. Failure increments `attempts`, computes exponential backoff from 5 seconds up to 1 hour, clears the lease, and persists the next attempt.

There is no retry-count cutoff that discards the operation. Startup, visibility, and the persisted due time guarantee that retries do not depend on one in-memory timer surviving.

Legacy OPFS files with neither a media record nor an operation record are eligible for compatibility cleanup only after 24 hours. The scanner rechecks both stores for that exact file immediately before deletion.

### 6.5 Project Deletion Concurrency

- Project deletion logically removes the project and transitions its committed media and active operations to cleanup work in one IndexedDB transaction.
- It does not discard recovery metadata before OPFS deletion succeeds.
- An active writer's final commit re-reads its operation token. A deleted or cleanup-due operation cannot publish a media record.
- Import sessions and background cache operations carry `projectId`, so project-scoped cancellation and cleanup are index-driven.
- IndexedDB-only blobs may be deleted transactionally; OPFS bytes remain journaled until physical deletion succeeds.

## 7. User Experience

### 7.1 Generated and Rendered Media

- As soon as the backend returns, the UI renders the remote URL and marks generation/rendering complete.
- Local persistence runs in the background with a non-blocking `正在保存到本机` state.
- A successful cache commit updates the internal snapshot to `local://media/...` only if the project/operation token is still current.
- The UI resolves internal refs to object URLs and never renders raw local-ref text.
- A recoverable cache failure retains the remote URL and shows `本机备份稍后重试`; it does not turn a successful generation into a failed generation.
- If the page reloads after media commit but before snapshot promotion, a compound `[projectId, sourcePath]` media index lets hydration find the committed cache and restore the internal overlay.

### 7.2 Project Import

- Import remains intentionally transactional and shows byte/entry progress.
- The user may cancel before the final project commit.
- ZIP Worker failure switches the import control to the extracted-directory option with plain Chinese copy.
- Invalid, incomplete, conflicting, or oversized input produces one actionable error and leaves the visible project list unchanged.

## 8. Error Model

The public error classes are:

- `BackupWorkerUnavailableError`: module Worker cannot be used; directory fallback is available.
- `BackupWorkerProtocolError`: Worker messages are invalid, incomplete, or terminate unexpectedly.
- `BackupValidationError`: archive/directory structure, version, schema, path, or size validation failed.
- `ProjectImportConflictError`: the final atomic conflict check rejected overwrite.
- `MediaDurabilityError`: the operation journal could not be established before external storage work.
- `MediaRecoveryError`: recovery remains durably queued but the current attempt failed.

Errors distinguish the primary user operation from optional background caching. Only project import is blocked until local commit; generation and render keep their remote success result.

## 9. Testing Strategy

### 9.1 Pure and Component Tests

- Worker protocol request IDs, chunk acknowledgement, cancellation, progress, and malformed-message rejection.
- ZIP path traversal, duplicate entries, entry count, compressed bytes, actual entry bytes, total output, manifest limit, and forged size metadata.
- Directory relative-path normalization, basename fallback, duplicate basename rejection, missing/extra media, and shared schema behavior.
- Import conflict, cancellation, staged rollback, and no visible partial project.
- Workbench remote preview appears before local cache commit; background completion promotes the internal ref; failure retains the remote result and non-blocking retry status.

### 9.2 Storage State-Machine Tests

Tests use fake IndexedDB and controllable OPFS handles to stop at every boundary:

- Before operation journal commit.
- After journal commit but before OPFS creation.
- During write and close.
- After close but before final media transaction.
- After media commit but before UI snapshot promotion.
- During cleanup, lease expiry, retry scheduling, and cross-tab contention.
- While deleting a project with active cache and import writes.
- During v1/v2/v3 to v4 migration.

Every crash-point test recreates the recovery controller to prove recovery does not depend on retained module memory.

### 9.3 Browser Regression

Chromium browser tests verify:

- A real Vite module Worker imports `.omproj` while a main-thread heartbeat remains responsive.
- A crafted high-compression archive is rejected inside the Worker.
- Worker construction failure exposes extracted-directory import and never invokes main-thread inflate.
- Directory selection, progress, cancellation, duplicate/missing file errors, and successful import.
- Generated/rendered remote media appears immediately while local caching remains non-blocking.
- Startup and visibility recovery process durable due operations without duplicate cross-tab ownership.

## 10. Acceptance Criteria

1. No production main-thread module imports or executes ZIP inflate code for backup import.
2. Every untrusted deflated entry is processed inside the dedicated module Worker.
3. Worker unavailability offers local extracted-directory import without a backend request.
4. ZIP and directory inputs produce the same validated project and media result.
5. Every OPFS mutation is preceded by durable operation metadata.
6. Interrupted writes and deletes remain discoverable across reloads until cleanup succeeds.
7. Cross-tab recovery cannot delete an active writer or process one operation concurrently.
8. Project deletion prevents an active writer from publishing media afterward.
9. Generated and rendered remote media is visible before background local caching completes.
10. Raw `local://` values never appear in user-facing text or media attributes.
11. Legacy v0 and version 1 backups remain importable; new exports remain compatible with the existing backup contract.
12. Focused tests, the full frontend suite, production build, critical browser workflows, and independent code review pass before the frontend optimization is marked complete.
