# Browser-Local Video MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public-safe early OpenMontage web MVP where each user's project state and generated media are kept in that browser, while the backend performs only temporary generation work and never auto-restores the server's global latest project.

**Architecture:** The frontend becomes local-first: project metadata lives in IndexedDB, media blobs live in OPFS when available with an IndexedDB Blob fallback, and the selected recent project ID lives in the same local database. The existing FastAPI backend remains available for text/storyboard, shot regeneration, uploads, and final render as temporary workers, but public UI no longer calls `/api/projects/latest` or treats server storage as durable user history.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, FastAPI, pytest, browser IndexedDB, browser OPFS, local backend filesystem cleanup.

## Global Constraints

- Do not expose another user's or the server operator's project through global latest-project behavior.
- Do not store video, image, or audio payloads in `localStorage`.
- Store project JSON, recent project IDs, and indexes in IndexedDB.
- Store large media in OPFS when `navigator.storage.getDirectory` exists; otherwise store `Blob` values in IndexedDB.
- Treat browser-local storage as a draft workspace: users must be able to export a project backup.
- Keep backend-generated media temporary and delete backend files after 3 days.
- Do not deep-integrate NewAPI in this MVP; leave explicit provider/session boundaries for a later NewAPI module plan.
- Respect the existing dirty worktree. Do not revert unrelated changes.

---

## Scope Check

This plan intentionally splits the product into two projects:

- **This plan:** public-safe browser-local MVP, local media cache, project export/import, temporary backend cleanup.
- **Future plan:** NewAPI account/module integration, model group discovery, balance-aware billing, and no-key user flow.

The MVP can be used by early users without reading the server operator's local project. If NewAPI login is required before launch, create a second plan after this one for a lightweight NewAPI session bridge.

## File Structure

- `web/src/localdb/types.ts`
  Defines local project snapshot, local media metadata, storage status, and logical `local://` media references.

- `web/src/localdb/indexedDb.ts`
  Opens and migrates the `openmontage-local` IndexedDB database. Owns object store names and schema version.

- `web/src/localdb/projectStore.ts`
  Saves, loads, lists, and deletes local project snapshots. Also stores the recent project ID.

- `web/src/localdb/mediaStore.ts`
  Saves and loads media blobs. Uses OPFS when supported and IndexedDB Blob fallback otherwise.

- `web/src/localdb/mediaUrls.ts`
  Converts local media references into revocable object URLs for React rendering.

- `web/src/localdb/exportProject.ts`
  Exports a local project backup and imports a backup into the local database.

- `web/src/localdb/*.test.ts`
  Vitest coverage for local database behavior. Tests use `fake-indexeddb`.

- `web/src/api/client.ts`
  Stops exposing `loadLatestProject` as app boot behavior. Adds helper calls needed by temporary backend workflows.

- `web/src/App.tsx`
  Loads the recent browser-local project on mount, saves snapshots after project-changing actions, and resolves local media URLs.

- `web/src/App.test.tsx`
  Replaces server-latest boot assertions with browser-local restore assertions.

- `server/app/settings.py`
  Adds `MEDIA_RETENTION_DAYS = 3`.

- `server/app/media_retention.py`
  Identifies expired backend media files and deletes only files under project media directories.

- `server/app/main.py`
  Keeps `/api/projects/latest` available only for local/dev compatibility or returns 404 in public mode. Exposes a cleanup function for startup or admin use.

- `server/tests/test_media_retention.py`
  Tests 3-day deletion rules and path safety.

- `README.md`
  Documents the browser-local MVP constraints and "download/export before clearing browser data" warning.

---

### Task 1: Add Browser Local Database Foundation

**Files:**
- Create: `web/src/localdb/types.ts`
- Create: `web/src/localdb/indexedDb.ts`
- Create: `web/src/localdb/projectStore.ts`
- Create: `web/src/localdb/projectStore.test.ts`
- Modify: `web/package.json`
- Modify: `web/package-lock.json`

**Interfaces:**
- Produces: `LocalProjectSnapshot`, `saveProjectSnapshot(snapshot)`, `loadProjectSnapshot(projectId)`, `loadRecentProjectSnapshot()`, `setRecentProjectId(projectId)`, `listProjectSummaries()`, `deleteProject(projectId)`.
- Consumes: Existing `ShortDramaProjectResponse` type from `web/src/domain/types.ts`.

- [ ] **Step 1: Add the test dependency**

Run:

```powershell
npm install --save-dev fake-indexeddb
```

Expected: `web/package.json` and `web/package-lock.json` include `fake-indexeddb`.

- [ ] **Step 2: Write the local project types**

Create `web/src/localdb/types.ts`:

```ts
import type { ShortDramaProjectResponse } from "../domain/types";

export const LOCAL_DB_NAME = "openmontage-local";
export const LOCAL_DB_VERSION = 1;

export type LocalMediaRef = `local://media/${string}`;

export interface LocalProjectSnapshot {
  id: string;
  title: string;
  updatedAt: string;
  snapshot: ShortDramaProjectResponse;
}

export interface LocalProjectSummary {
  id: string;
  title: string;
  updatedAt: string;
  shotCount: number;
  hasFinalRender: boolean;
}

export interface LocalSettingsRecord {
  key: "recentProjectId";
  value: string | null;
}
```

- [ ] **Step 3: Write the IndexedDB opener**

Create `web/src/localdb/indexedDb.ts`:

```ts
import { LOCAL_DB_NAME, LOCAL_DB_VERSION } from "./types";

export const LOCAL_STORES = {
  projects: "projects",
  settings: "settings",
  media: "media",
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openLocalDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_STORES.projects)) {
        db.createObjectStore(LOCAL_STORES.projects, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(LOCAL_STORES.settings)) {
        db.createObjectStore(LOCAL_STORES.settings, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(LOCAL_STORES.media)) {
        db.createObjectStore(LOCAL_STORES.media, { keyPath: "id" });
      }
    };

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });

  return dbPromise;
}

export function resetLocalDbForTests(): void {
  dbPromise = null;
}
```

- [ ] **Step 4: Write failing project store tests**

Create `web/src/localdb/projectStore.test.ts`:

```ts
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { ShortDramaProjectResponse } from "../domain/types";
import { LOCAL_DB_NAME } from "./types";
import { resetLocalDbForTests } from "./indexedDb";
import {
  deleteProject,
  listProjectSummaries,
  loadProjectSnapshot,
  loadRecentProjectSnapshot,
  saveProjectSnapshot,
} from "./projectStore";

function snapshot(id: string, title: string): ShortDramaProjectResponse {
  return {
    project: { id, title, mode: "short_drama", project_type: "single_video" },
    series_bible: { characters: [], assets: [] },
    storyboard: { shots: [] },
    consistency_report: { score: 100, issues: [] },
    workflow_artifacts: [],
    final_path: null,
  };
}

afterEach(async () => {
  resetLocalDbForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
  });
});

describe("projectStore", () => {
  it("saves and restores the recent project snapshot", async () => {
    await saveProjectSnapshot(snapshot("p1", "Rain Alley"));

    const recent = await loadRecentProjectSnapshot();
    expect(recent?.snapshot.project.id).toBe("p1");
    expect(recent?.title).toBe("Rain Alley");
  });

  it("lists project summaries without loading full media", async () => {
    await saveProjectSnapshot(snapshot("p1", "Rain Alley"));
    await saveProjectSnapshot(snapshot("p2", "Office Secret"));

    const summaries = await listProjectSummaries();
    expect(summaries.map((item) => item.title)).toEqual(["Office Secret", "Rain Alley"]);
  });

  it("deletes a local project and clears recent pointer when needed", async () => {
    await saveProjectSnapshot(snapshot("p1", "Rain Alley"));
    await deleteProject("p1");

    expect(await loadProjectSnapshot("p1")).toBeNull();
    expect(await loadRecentProjectSnapshot()).toBeNull();
  });
});
```

- [ ] **Step 5: Run the test and verify it fails**

Run:

```powershell
npm test -- projectStore.test.ts
```

Expected: FAIL because `web/src/localdb/projectStore.ts` does not exist.

- [ ] **Step 6: Implement the project store**

Create `web/src/localdb/projectStore.ts`:

```ts
import type { ShortDramaProjectResponse } from "../domain/types";
import { openLocalDb, LOCAL_STORES } from "./indexedDb";
import type { LocalProjectSnapshot, LocalProjectSummary, LocalSettingsRecord } from "./types";

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => resolve();
  });
}

function toLocalProjectSnapshot(snapshot: ShortDramaProjectResponse): LocalProjectSnapshot {
  return {
    id: snapshot.project.id,
    title: snapshot.project.title,
    updatedAt: new Date().toISOString(),
    snapshot,
  };
}

export async function saveProjectSnapshot(snapshot: ShortDramaProjectResponse): Promise<void> {
  const db = await openLocalDb();
  const tx = db.transaction([LOCAL_STORES.projects, LOCAL_STORES.settings], "readwrite");
  tx.objectStore(LOCAL_STORES.projects).put(toLocalProjectSnapshot(snapshot));
  tx.objectStore(LOCAL_STORES.settings).put({
    key: "recentProjectId",
    value: snapshot.project.id,
  } satisfies LocalSettingsRecord);
  await transactionDone(tx);
}

export async function setRecentProjectId(projectId: string | null): Promise<void> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.settings, "readwrite");
  tx.objectStore(LOCAL_STORES.settings).put({
    key: "recentProjectId",
    value: projectId,
  } satisfies LocalSettingsRecord);
  await transactionDone(tx);
}

export async function loadProjectSnapshot(projectId: string): Promise<LocalProjectSnapshot | null> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.projects, "readonly");
  const value = await requestToPromise<LocalProjectSnapshot | undefined>(
    tx.objectStore(LOCAL_STORES.projects).get(projectId),
  );
  return value ?? null;
}

export async function loadRecentProjectSnapshot(): Promise<LocalProjectSnapshot | null> {
  const db = await openLocalDb();
  const settingsTx = db.transaction(LOCAL_STORES.settings, "readonly");
  const setting = await requestToPromise<LocalSettingsRecord | undefined>(
    settingsTx.objectStore(LOCAL_STORES.settings).get("recentProjectId"),
  );
  if (!setting?.value) {
    return null;
  }
  return loadProjectSnapshot(setting.value);
}

export async function listProjectSummaries(): Promise<LocalProjectSummary[]> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.projects, "readonly");
  const records = await requestToPromise<LocalProjectSnapshot[]>(
    tx.objectStore(LOCAL_STORES.projects).getAll(),
  );
  return records
    .map((record) => ({
      id: record.id,
      title: record.title,
      updatedAt: record.updatedAt,
      shotCount: record.snapshot.storyboard.shots.length,
      hasFinalRender: Boolean(record.snapshot.final_path),
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function deleteProject(projectId: string): Promise<void> {
  const db = await openLocalDb();
  const currentRecent = await loadRecentProjectSnapshot();
  const tx = db.transaction([LOCAL_STORES.projects, LOCAL_STORES.settings], "readwrite");
  tx.objectStore(LOCAL_STORES.projects).delete(projectId);
  if (currentRecent?.id === projectId) {
    tx.objectStore(LOCAL_STORES.settings).put({
      key: "recentProjectId",
      value: null,
    } satisfies LocalSettingsRecord);
  }
  await transactionDone(tx);
}
```

- [ ] **Step 7: Run the test and verify it passes**

Run:

```powershell
npm test -- projectStore.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add web/package.json web/package-lock.json web/src/localdb
git commit -m "feat: add browser local project store"
```

---

### Task 2: Remove Server-Latest Boot and Restore Browser-Local Recent Project

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/api/client.test.ts`

**Interfaces:**
- Consumes: `saveProjectSnapshot`, `loadRecentProjectSnapshot`, `setRecentProjectId`.
- Produces: App boot behavior that never calls `/api/projects/latest`.

- [ ] **Step 1: Write failing app test for local restore**

In `web/src/App.test.tsx`, replace the existing "auto-loads the latest project on mount" test with:

```ts
it("restores the recent browser-local project on mount without calling server latest", async () => {
  apiMocks.loadLatestProject.mockRejectedValue(new Error("server latest must not be called"));
  localDbMocks.loadRecentProjectSnapshot.mockResolvedValue({
    id: "p1",
    title: "Rain Alley",
    updatedAt: "2026-07-08T00:00:00.000Z",
    snapshot: cloneProjectResponse(),
  });

  render(<App />);

  await waitFor(() => expect(localDbMocks.loadRecentProjectSnapshot).toHaveBeenCalled());
  expect(apiMocks.loadLatestProject).not.toHaveBeenCalled();
  expect(await screen.findByText("Rain Alley")).toBeInTheDocument();
});
```

Add a mock near the existing API mocks:

```ts
vi.mock("./localdb/projectStore", () => ({
  loadRecentProjectSnapshot: vi.fn(),
  saveProjectSnapshot: vi.fn(),
  setRecentProjectId: vi.fn(),
}));
```

Import the mocked module in the test:

```ts
import * as localProjectStore from "./localdb/projectStore";
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```powershell
npm test -- App.test.tsx
```

Expected: FAIL because `App.tsx` still calls `loadLatestProject`.

- [ ] **Step 3: Update app boot**

In `web/src/App.tsx`:

Remove `loadLatestProject` from the API imports.

Add:

```ts
import {
  loadRecentProjectSnapshot,
  saveProjectSnapshot,
  setRecentProjectId,
} from "./localdb/projectStore";
```

Replace the existing `resumeLatestProject` effect with:

```ts
  useEffect(() => {
    let cancelled = false;

    async function resumeRecentLocalProject() {
      try {
        const record = await loadRecentProjectSnapshot();
        if (!cancelled && record) {
          applyProjectSnapshot(record.snapshot);
        }
      } catch {
        // Browser storage can be unavailable in private mode; stay on the draft screen.
      }
    }

    void resumeRecentLocalProject();

    return () => {
      cancelled = true;
    };
  }, []);
```

Add this helper near `applyProjectSnapshot`:

```ts
  async function applyAndPersistProjectSnapshot(snapshot: Awaited<ReturnType<typeof loadProject>>) {
    applyProjectSnapshot(snapshot);
    try {
      await saveProjectSnapshot(snapshot);
    } catch {
      setError(strings.errors.localProjectSaveFallback);
    }
  }
```

Use `applyAndPersistProjectSnapshot` after project-changing server responses:

```ts
await applyAndPersistProjectSnapshot(result);
```

For `handleStartNewDraft`, add:

```ts
void setRecentProjectId(null).catch(() => undefined);
```

- [ ] **Step 4: Add user-facing copy for local save failure**

In `web/src/i18n.ts`, add to each language `errors` object:

```ts
localProjectSaveFallback: "This project is open, but the browser could not save the local draft. Export the project before closing this tab.",
```

- [ ] **Step 5: Retire loadLatestProject from client**

In `web/src/api/client.ts`, keep the function only if backend compatibility tests still need it, but do not import or call it from `App.tsx`. In `web/src/api/client.test.ts`, keep its direct client test if the endpoint remains; remove it if Task 5 removes the backend route.

- [ ] **Step 6: Run frontend tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add web/src/App.tsx web/src/App.test.tsx web/src/api/client.ts web/src/api/client.test.ts web/src/i18n.ts
git commit -m "feat: restore projects from browser local storage"
```

---

### Task 3: Add Local Media Cache for Generated Images and Videos

**Files:**
- Create: `web/src/localdb/mediaStore.ts`
- Create: `web/src/localdb/mediaStore.test.ts`
- Create: `web/src/localdb/mediaUrls.ts`
- Modify: `web/src/api/client.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/domain/types.ts`

**Interfaces:**
- Produces: `saveMediaBlob(input)`, `loadMediaBlob(mediaId)`, `cacheRemoteMedia(url, metadata)`, `resolveLocalMediaUrl(ref)`.
- Consumes: media URLs returned by existing backend endpoints.

- [ ] **Step 1: Add media types**

Append to `web/src/localdb/types.ts`:

```ts
export interface LocalMediaRecord {
  id: string;
  projectId: string;
  sourcePath: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  storage: "opfs" | "indexeddb";
  opfsPath?: string;
  blob?: Blob;
}
```

- [ ] **Step 2: Write failing media store tests**

Create `web/src/localdb/mediaStore.test.ts`:

```ts
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_DB_NAME } from "./types";
import { resetLocalDbForTests } from "./indexedDb";
import { loadMediaBlob, saveMediaBlob } from "./mediaStore";

afterEach(async () => {
  resetLocalDbForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
  });
});

describe("mediaStore", () => {
  it("saves and loads a media blob through IndexedDB fallback", async () => {
    const blob = new Blob(["video"], { type: "video/mp4" });

    const ref = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/video/shot_001.mp4",
      contentType: "video/mp4",
      blob,
    });

    expect(ref).toMatch(/^local:\/\/media\//);
    const restored = await loadMediaBlob(ref);
    expect(restored?.type).toBe("video/mp4");
    expect(await restored?.text()).toBe("video");
  });
});
```

- [ ] **Step 3: Implement media store**

Create `web/src/localdb/mediaStore.ts`:

```ts
import { openLocalDb, LOCAL_STORES } from "./indexedDb";
import type { LocalMediaRecord, LocalMediaRef } from "./types";

type SaveMediaInput = {
  projectId: string;
  sourcePath: string;
  contentType: string;
  blob: Blob;
};

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => resolve();
  });
}

function idFromRef(ref: LocalMediaRef): string {
  return ref.replace("local://media/", "");
}

export async function saveMediaBlob(input: SaveMediaInput): Promise<LocalMediaRef> {
  const id = crypto.randomUUID();
  const record: LocalMediaRecord = {
    id,
    projectId: input.projectId,
    sourcePath: input.sourcePath,
    contentType: input.contentType,
    sizeBytes: input.blob.size,
    createdAt: new Date().toISOString(),
    storage: "indexeddb",
    blob: input.blob,
  };
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.media, "readwrite");
  tx.objectStore(LOCAL_STORES.media).put(record);
  await transactionDone(tx);
  return `local://media/${id}`;
}

export async function loadMediaBlob(ref: LocalMediaRef): Promise<Blob | null> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.media, "readonly");
  const record = await requestToPromise<LocalMediaRecord | undefined>(
    tx.objectStore(LOCAL_STORES.media).get(idFromRef(ref)),
  );
  return record?.blob ?? null;
}

export async function cacheRemoteMedia(
  url: string,
  metadata: { projectId: string; sourcePath: string },
): Promise<LocalMediaRef | null> {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  const blob = await response.blob();
  return saveMediaBlob({
    projectId: metadata.projectId,
    sourcePath: metadata.sourcePath,
    contentType: blob.type || "application/octet-stream",
    blob,
  });
}
```

- [ ] **Step 4: Implement object URL resolver**

Create `web/src/localdb/mediaUrls.ts`:

```ts
import { loadMediaBlob } from "./mediaStore";
import type { LocalMediaRef } from "./types";

const objectUrls = new Map<LocalMediaRef, string>();

export async function resolveLocalMediaUrl(ref: LocalMediaRef): Promise<string | null> {
  const cached = objectUrls.get(ref);
  if (cached) {
    return cached;
  }
  const blob = await loadMediaBlob(ref);
  if (!blob) {
    return null;
  }
  const url = URL.createObjectURL(blob);
  objectUrls.set(ref, url);
  return url;
}

export function revokeLocalMediaUrls(): void {
  for (const url of objectUrls.values()) {
    URL.revokeObjectURL(url);
  }
  objectUrls.clear();
}
```

- [ ] **Step 5: Cache generated shot and render media after backend responses**

In `web/src/App.tsx`, after `regenerateShot` returns, resolve the backend media URL with existing `mediaUrl(result.shot.output_path, project.id)`. If present, call `cacheRemoteMedia`, set the shot `output_path` to the returned `local://media/...`, then persist the updated snapshot.

Use this helper:

```ts
  async function cacheShotMedia(projectId: string, shot: Shot): Promise<Shot> {
    const url = mediaUrl(shot.output_path, projectId);
    if (!url || !shot.output_path) {
      return shot;
    }
    const localRef = await cacheRemoteMedia(url, {
      projectId,
      sourcePath: shot.output_path,
    });
    return localRef ? { ...shot, output_path: localRef, output_url: null } : shot;
  }
```

- [ ] **Step 6: Run tests**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add web/src/localdb web/src/App.tsx web/src/domain/types.ts web/src/api/client.ts
git commit -m "feat: cache generated media in browser storage"
```

---

### Task 4: Export and Import Browser-Local Projects

**Files:**
- Create: `web/src/localdb/exportProject.ts`
- Create: `web/src/localdb/exportProject.test.ts`
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Modify: `web/src/App.tsx`
- Modify: `web/src/i18n.ts`

**Interfaces:**
- Produces: `exportProjectBackup(projectId)`, `importProjectBackup(file)`.
- Consumes: `loadProjectSnapshot`, `saveProjectSnapshot`, `loadMediaBlob`, `saveMediaBlob`.

- [ ] **Step 1: Add zip dependency**

Run:

```powershell
npm install fflate
```

Expected: `web/package.json` includes `fflate`.

- [ ] **Step 2: Implement export/import API**

Create `web/src/localdb/exportProject.ts`:

```ts
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import type { ShortDramaProjectResponse } from "../domain/types";
import { loadProjectSnapshot, saveProjectSnapshot } from "./projectStore";

const MANIFEST_NAME = "openmontage-project.json";

export async function exportProjectBackup(projectId: string): Promise<Blob> {
  const record = await loadProjectSnapshot(projectId);
  if (!record) {
    throw new Error("Project not found in this browser");
  }
  const manifest = JSON.stringify(record.snapshot, null, 2);
  const archive = zipSync({
    [MANIFEST_NAME]: strToU8(manifest),
  });
  return new Blob([archive], { type: "application/zip" });
}

export async function importProjectBackup(file: File): Promise<ShortDramaProjectResponse> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const files = unzipSync(bytes);
  const manifestBytes = files[MANIFEST_NAME];
  if (!manifestBytes) {
    throw new Error("Backup is missing openmontage-project.json");
  }
  const snapshot = JSON.parse(strFromU8(manifestBytes)) as ShortDramaProjectResponse;
  if (!snapshot.project?.id || !snapshot.project?.title || !snapshot.storyboard?.shots) {
    throw new Error("Backup project metadata is invalid");
  }
  await saveProjectSnapshot(snapshot);
  return snapshot;
}
```

- [ ] **Step 3: Add export/import UI controls**

In `web/src/App.tsx`, add two buttons near the project rail actions:

```tsx
<button className="secondary-button rail-action" type="button" disabled={!project} onClick={handleExportProject}>
  {strings.appShell.exportProjectAction}
</button>
<label className="secondary-button rail-action">
  {strings.appShell.importProjectAction}
  <input className="sr-only" type="file" accept=".zip,.omproj" onChange={handleImportProject} />
</label>
```

Add handlers:

```ts
  async function handleExportProject() {
    if (!project) {
      return;
    }
    try {
      const blob = await exportProjectBackup(project.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${project.title || project.id}.omproj`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : strings.errors.exportProjectFallback);
    }
  }

  async function handleImportProject(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const snapshot = await importProjectBackup(file);
      applyProjectSnapshot(snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : strings.errors.importProjectFallback);
    } finally {
      event.target.value = "";
    }
  }
```

- [ ] **Step 4: Add copy**

In `web/src/i18n.ts`, add:

```ts
exportProjectAction: "Export project",
importProjectAction: "Import project",
```

Add errors:

```ts
exportProjectFallback: "Project export failed.",
importProjectFallback: "Project import failed.",
```

- [ ] **Step 5: Run tests and build**

Run:

```powershell
npm test
npm run build
```

Expected: PASS and successful production build.

- [ ] **Step 6: Commit**

```powershell
git add web/package.json web/package-lock.json web/src/localdb/exportProject.ts web/src/App.tsx web/src/i18n.ts
git commit -m "feat: export and import browser local projects"
```

---

### Task 5: Make Backend Media Temporary and Disable Public Global Latest

**Files:**
- Create: `server/app/media_retention.py`
- Create: `server/tests/test_media_retention.py`
- Modify: `server/app/settings.py`
- Modify: `server/app/main.py`
- Modify: `server/tests/test_api.py`
- Modify: `README.md`

**Interfaces:**
- Produces: `cleanup_expired_media(projects_root: Path, now: datetime | None = None) -> list[Path]`.
- Consumes: existing project directory layout under `projects/<project-id>/assets` and `projects/<project-id>/renders`.

- [ ] **Step 1: Add retention setting**

In `server/app/settings.py`, add:

```py
MEDIA_RETENTION_DAYS = 3
PUBLIC_DISABLE_GLOBAL_LATEST = True
```

- [ ] **Step 2: Write failing retention tests**

Create `server/tests/test_media_retention.py`:

```py
from datetime import UTC, datetime, timedelta

from server.app.media_retention import cleanup_expired_media


def test_cleanup_deletes_only_old_media_under_project_media_dirs(tmp_path):
    project = tmp_path / "projects" / "p1"
    old_video = project / "assets" / "video" / "shot.mp4"
    fresh_video = project / "assets" / "video" / "fresh.mp4"
    artifact = project / "artifacts" / "episode_storyboard.json"
    old_video.parent.mkdir(parents=True)
    artifact.parent.mkdir(parents=True)
    old_video.write_bytes(b"old")
    fresh_video.write_bytes(b"fresh")
    artifact.write_text("{}", encoding="utf-8")

    old_time = datetime(2026, 7, 1, tzinfo=UTC).timestamp()
    fresh_time = datetime(2026, 7, 8, tzinfo=UTC).timestamp()
    old_video.touch()
    fresh_video.touch()
    artifact.touch()
    import os

    os.utime(old_video, (old_time, old_time))
    os.utime(fresh_video, (fresh_time, fresh_time))
    os.utime(artifact, (old_time, old_time))

    deleted = cleanup_expired_media(
      tmp_path / "projects",
      now=datetime(2026, 7, 8, tzinfo=UTC),
      retention=timedelta(days=3),
    )

    assert old_video in deleted
    assert not old_video.exists()
    assert fresh_video.exists()
    assert artifact.exists()
```

- [ ] **Step 3: Implement retention cleanup**

Create `server/app/media_retention.py`:

```py
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from server.app.settings import MEDIA_RETENTION_DAYS

MEDIA_DIR_NAMES = (
    Path("assets/images"),
    Path("assets/video"),
    Path("assets/audio"),
    Path("renders"),
)


def cleanup_expired_media(
    projects_root: Path,
    *,
    now: datetime | None = None,
    retention: timedelta | None = None,
) -> list[Path]:
    current = now or datetime.now(UTC)
    max_age = retention or timedelta(days=MEDIA_RETENTION_DAYS)
    cutoff = current.timestamp() - max_age.total_seconds()
    deleted: list[Path] = []
    root = projects_root.resolve()

    for project_dir in root.iterdir() if root.exists() else []:
        if not project_dir.is_dir():
            continue
        for media_dir_name in MEDIA_DIR_NAMES:
            media_dir = (project_dir / media_dir_name).resolve()
            try:
                media_dir.relative_to(root)
            except ValueError:
                continue
            if not media_dir.exists():
                continue
            for path in media_dir.rglob("*"):
                if not path.is_file():
                    continue
                if path.stat().st_mtime >= cutoff:
                    continue
                path.unlink()
                deleted.append(path)
    return deleted
```

- [ ] **Step 4: Disable global latest in public mode**

In `server/app/main.py`, update `/api/projects/latest`:

```py
    @app.get("/api/projects/latest")
    def get_latest_project(
        workbench: WorkbenchStore = Depends(get_store),
    ) -> dict[str, Any]:
        if PUBLIC_DISABLE_GLOBAL_LATEST:
            raise HTTPException(status_code=404, detail="Global latest project is disabled")
        project = workbench.get_latest_project()
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return _project_snapshot(workbench, project.id)
```

Add the import:

```py
from server.app.settings import DEFAULT_DB_PATH, DEFAULT_PROJECTS_ROOT, DEFAULT_SYAPI_BASE_URL, PUBLIC_DISABLE_GLOBAL_LATEST
```

- [ ] **Step 5: Update backend tests**

In `server/tests/test_api.py`, add:

```py
def test_latest_project_disabled_in_public_mode(tmp_path):
    app = create_app(db_path=tmp_path / "workbench.db", projects_root=tmp_path / "projects")
    client = TestClient(app)

    response = client.get("/api/projects/latest")

    assert response.status_code == 404
    assert response.json()["detail"] == "Global latest project is disabled"
```

- [ ] **Step 6: Run backend tests**

Run:

```powershell
pytest server/tests/test_media_retention.py server/tests/test_api.py -q
```

Expected: PASS.

- [ ] **Step 7: Document MVP storage behavior**

In `README.md`, add a "Browser-local MVP storage" note:

```md
### Browser-local MVP storage

The public MVP stores each user's project draft in that browser. Project metadata
and the recent project pointer live in IndexedDB. Generated media is cached in
browser storage when possible. The backend does not expose a global latest project
in public mode, and backend media files are treated as temporary files with a
3-day retention window. Users should export project backups and download final
videos before clearing browser data.
```

- [ ] **Step 8: Commit**

```powershell
git add server/app/settings.py server/app/media_retention.py server/app/main.py server/tests/test_media_retention.py server/tests/test_api.py README.md
git commit -m "feat: make public media temporary"
```

---

### Task 6: Add User-Facing Storage Limits and Warnings

**Files:**
- Create: `web/src/localdb/storageEstimate.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/i18n.ts`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Produces: `getStorageEstimate() -> Promise<{ usageBytes: number | null; quotaBytes: number | null; persisted: boolean | null }>`
- Consumes: browser `navigator.storage.estimate()` and `navigator.storage.persisted()`.

- [ ] **Step 1: Add storage estimate helper**

Create `web/src/localdb/storageEstimate.ts`:

```ts
export type StorageEstimate = {
  usageBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
};

export async function getStorageEstimate(): Promise<StorageEstimate> {
  if (!navigator.storage?.estimate) {
    return { usageBytes: null, quotaBytes: null, persisted: null };
  }
  const estimate = await navigator.storage.estimate();
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : null;
  return {
    usageBytes: estimate.usage ?? null,
    quotaBytes: estimate.quota ?? null,
    persisted,
  };
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return "Unknown";
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
```

- [ ] **Step 2: Add UI warning**

In `web/src/App.tsx`, render a small storage note in the left rail:

```tsx
<div className="rail-section">
  <p className="rail-label">{strings.appShell.storageLabel}</p>
  <small>{strings.appShell.browserLocalStorageHint}</small>
  {storageEstimate ? (
    <small>{strings.appShell.storageUsageLabel(formatBytes(storageEstimate.usageBytes))}</small>
  ) : null}
</div>
```

Add state:

```ts
const [storageEstimate, setStorageEstimate] = useState<StorageEstimate | null>(null);
```

Load it on mount and after media caching:

```ts
void getStorageEstimate().then(setStorageEstimate).catch(() => undefined);
```

- [ ] **Step 3: Add copy**

In `web/src/i18n.ts`, add:

```ts
storageLabel: "Local storage",
browserLocalStorageHint: "Projects are saved in this browser. Export backups before clearing browser data.",
storageUsageLabel: (usage: string) => `Browser storage used: ${usage}`,
```

- [ ] **Step 4: Run frontend tests and build**

Run:

```powershell
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add web/src/localdb/storageEstimate.ts web/src/App.tsx web/src/App.test.tsx web/src/i18n.ts
git commit -m "feat: show browser local storage warning"
```

---

## Final Verification

- [ ] Run all backend tests:

```powershell
pytest -q
```

Expected: PASS.

- [ ] Run all frontend tests:

```powershell
cd web
npm test
```

Expected: PASS.

- [ ] Build frontend:

```powershell
cd web
npm run build
```

Expected: PASS.

- [ ] Manual browser check:

1. Start backend: `uvicorn server.app.main:create_app --factory --host 127.0.0.1 --port 8787`
2. Start frontend: `cd web; npm run dev`
3. Open `http://127.0.0.1:5173`.
4. Verify the app starts on an empty draft when browser storage is empty.
5. Create a project and refresh the page.
6. Verify the project restores from browser storage without calling `/api/projects/latest`.
7. Regenerate one shot and verify the video still plays after refresh.
8. Export the project, clear browser data, import the project, and verify metadata restores.
9. Request `/api/projects/latest` directly and verify it returns 404 in public mode.

---

## Future NewAPI Module Plan Boundary

After this MVP works, create a separate plan for:

- Reading NewAPI login/session from the same domain.
- Discovering user groups and allowed models from NewAPI.
- Replacing the key gate with a model/group selector.
- Routing generation through NewAPI billing and quota.
- Embedding OpenMontage as a NewAPI sidebar module.
- Moving durable project metadata to account-scoped server storage.
- Keeping generated media under a 3-day retention policy.

## Self-Review

- Spec coverage: The plan removes server global latest from frontend boot, adds browser project persistence, adds media caching, adds project export/import, adds 3-day backend cleanup, and leaves NewAPI integration as a separate plan.
- Placeholder scan: No unfinished-marker placeholders are present.
- Type consistency: `LocalProjectSnapshot`, `LocalMediaRef`, `LocalMediaRecord`, and storage function names are defined before they are consumed.
