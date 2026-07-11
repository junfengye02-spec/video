import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShortDramaProjectResponse, Shot } from "../domain/types";
import { openLocalDb, resetLocalDbForTests } from "./indexedDb";
import {
  beginMediaWrite,
  findCommittedMedia,
  loadMediaBlob,
  runMediaRecovery,
  saveMediaBlob,
} from "./mediaStore";
import * as task3ProjectStore from "./projectStore";
import {
  deleteProject,
  listProjectSummaries,
  loadProjectSnapshot,
  loadRecentProjectSnapshot,
  saveImportedProjectSnapshot,
  saveProjectSnapshot,
  saveProjectSnapshotIfVersion,
  setRecentProjectId,
} from "./projectStore";
import type { LocalMediaRecord, LocalMediaRef, MediaJournalRecord } from "./types";
import { LOCAL_DB_NAME } from "./types";

type ProjectImportApi = {
  beginProjectImport(projectId: string): Promise<string>;
  commitImportedProject(
    snapshot: ShortDramaProjectResponse,
    sessionId: string,
    options: { overwrite: boolean; leaseOwner: string },
  ): Promise<void>;
  abortProjectImport(sessionId: string, cause?: unknown): Promise<void>;
};

const projectImportApi = task3ProjectStore as typeof task3ProjectStore & ProjectImportApi;

const originalStorage = Object.getOwnPropertyDescriptor(Navigator.prototype, "storage");

function blobToText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") {
    return blob.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}

function installOpfs(options: { removeError?: Error } = {}) {
  const files = new Map<string, Blob>();
  const removeEntry = vi.fn(async (name: string) => {
    if (options.removeError) {
      throw options.removeError;
    }
    if (!files.delete(name)) {
      throw new DOMException("File not found", "NotFoundError");
    }
  });
  const mediaDirectory = {
    async getFileHandle(name: string, handleOptions?: { create?: boolean }) {
      if (!files.has(name) && !handleOptions?.create) {
        throw new DOMException("File not found", "NotFoundError");
      }
      return {
        async createWritable() {
          return {
            async write(blob: Blob) {
              files.set(name, blob);
            },
            async close() {},
          };
        },
        async getFile() {
          const blob = files.get(name);
          if (!blob) throw new DOMException("File not found", "NotFoundError");
          return blob;
        },
      };
    },
    removeEntry,
  };
  const root = {
    async getDirectoryHandle() {
      return mediaDirectory;
    },
  };
  Object.defineProperty(Navigator.prototype, "storage", {
    configurable: true,
    value: { getDirectory: vi.fn(async () => root) },
  });
  return { files, removeEntry };
}

async function mediaBlob(text: string): Promise<Blob> {
  return new Response(text, { headers: { "content-type": "video/mp4" } }).blob();
}

function shot(id: string): Shot {
  return {
    id,
    scene_id: "scene-1",
    index: 1,
    beat: "A reveal",
    prompt: "A neon hallway",
    characters: [],
    location: null,
    props: [],
    status: "complete",
    consistency_score: 98,
    output_url: null,
    output_path: null,
    asset_ids: [],
    version: 1,
    history: [],
  };
}

function snapshot(
  id: string,
  title: string,
  options: { finalPath?: string | null; shots?: Shot[] } = {},
): ShortDramaProjectResponse {
  return {
    project: { id, title, mode: "short_drama", project_type: "single_video" },
    series_bible: { characters: [], assets: [] },
    storyboard: { shots: options.shots ?? [] },
    consistency_report: { score: 100, issues: [] },
    workflow_artifacts: [],
    final_path: options.finalPath ?? null,
  };
}

async function deleteLocalDb() {
  resetLocalDbForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function getRecord<T>(storeName: string, id: string): Promise<T | null> {
  const db = await openLocalDb();
  const value = await requestToPromise<T | undefined>(
    db.transaction(storeName, "readonly").objectStore(storeName).get(id),
  );
  return value ?? null;
}

async function getAllRecords<T>(storeName: string): Promise<T[]> {
  const db = await openLocalDb();
  return requestToPromise<T[]>(
    db.transaction(storeName, "readonly").objectStore(storeName).getAll(),
  );
}

async function putRecord(storeName: string, value: unknown): Promise<void> {
  const db = await openLocalDb();
  const tx = db.transaction(storeName, "readwrite");
  const done = new Promise<void>((resolve, reject) => {
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    tx.oncomplete = () => resolve();
  });
  tx.objectStore(storeName).put(value);
  await done;
}

async function createLegacyDatabase(version: 1 | 2 | 3): Promise<void> {
  const request = indexedDB.open(LOCAL_DB_NAME, version);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore("projects", { keyPath: "id" });
    db.createObjectStore("settings", { keyPath: "key" });
    const mediaStore = db.createObjectStore("media", { keyPath: "id" });
    if (version >= 2) {
      mediaStore.createIndex("projectId", "projectId", { unique: false });
    }
    if (version >= 3) {
      db.createObjectStore("mediaPending", { keyPath: "id" });
    }
    mediaStore.put({
      id: `legacy-media-v${version}`,
      projectId: "legacy-project",
      sourcePath: "assets/legacy.mp4",
      contentType: "video/mp4",
      sizeBytes: 6,
      createdAt: "2026-01-01T00:00:00.000Z",
      storage: "indexeddb",
      blob: new Blob(["legacy"], { type: "video/mp4" }),
    });
  };
  const db = await requestToPromise(request);
  db.close();
  resetLocalDbForTests();
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalStorage) {
    Object.defineProperty(Navigator.prototype, "storage", originalStorage);
  } else {
    delete (Navigator.prototype as { storage?: StorageManager }).storage;
  }
  await deleteLocalDb();
});

describe("projectStore", () => {
  it("normalizes a legacy project record without a durable revision to zero", async () => {
    const legacy = snapshot("legacy-revision", "Legacy Revision");
    await putRecord("projects", {
      id: legacy.project.id,
      title: legacy.project.title,
      updatedAt: "2026-07-11T00:00:00.000Z",
      snapshot: legacy,
    });

    const firstLoad = await loadProjectSnapshot("legacy-revision");
    const secondLoad = await loadProjectSnapshot("legacy-revision");

    expect(firstLoad).toMatchObject({
      incarnation: "legacy:legacy-revision",
      revision: 0,
    });
    expect(secondLoad?.incarnation).toBe(firstLoad?.incarnation);
    const saved = await saveProjectSnapshot(legacy);
    expect(saved).toMatchObject({
      incarnation: "legacy:legacy-revision",
      revision: 1,
    });
  });

  it("increments and returns the durable revision for every normal save", async () => {
    const first = await saveProjectSnapshot(snapshot("revisioned", "First"));
    const second = await saveProjectSnapshot(snapshot("revisioned", "Second"));

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(second.incarnation).toBe(first.incarnation);
    expect(await loadProjectSnapshot("revisioned")).toMatchObject({
      revision: 2,
      title: "Second",
    });
  });

  it("conditionally saves and returns a new revision on an exact match", async () => {
    const initial = await saveProjectSnapshot(snapshot("cas", "Initial"));

    const saved = await saveProjectSnapshotIfVersion(
      snapshot("cas", "Conditional"),
      { incarnation: initial.incarnation, revision: initial.revision },
    );

    expect(saved).toMatchObject({ revision: 2, title: "Conditional" });
    expect(await loadProjectSnapshot("cas")).toMatchObject({
      revision: 2,
      title: "Conditional",
    });
  });

  it("rejects a stale conditional revision without writing", async () => {
    const initial = await saveProjectSnapshot(snapshot("cas-stale", "Initial"));
    await saveProjectSnapshot(snapshot("cas-stale", "Newer"));

    await expect(saveProjectSnapshotIfVersion(
      snapshot("cas-stale", "Stale"),
      { incarnation: initial.incarnation, revision: initial.revision },
    )).resolves.toBeNull();
    expect(await loadProjectSnapshot("cas-stale")).toMatchObject({
      revision: 2,
      title: "Newer",
    });
  });

  it("does not recreate a missing project through conditional save", async () => {
    await expect(saveProjectSnapshotIfVersion(
      snapshot("cas-deleted", "Deleted"),
      { incarnation: "missing", revision: 0 },
    )).resolves.toBeNull();

    expect(await loadProjectSnapshot("cas-deleted")).toBeNull();
  });

  it("rejects a pending old version after delete and same-id recreation at matching revision", async () => {
    const original = await saveProjectSnapshot(snapshot("cas-aba", "Original"));
    const pendingOldVersion = {
      incarnation: original.incarnation,
      revision: original.revision,
    };
    await deleteProject("cas-aba");
    const recreated = await saveProjectSnapshot(snapshot("cas-aba", "Recreated"));

    expect(recreated.revision).toBe(pendingOldVersion.revision);
    expect(recreated.incarnation).not.toBe(pendingOldVersion.incarnation);
    await expect(saveProjectSnapshotIfVersion(
      snapshot("cas-aba", "Stale old instance"),
      pendingOldVersion,
    )).resolves.toBeNull();
    expect(await loadProjectSnapshot("cas-aba")).toMatchObject({
      title: "Recreated",
      revision: 1,
    });
  });

  it("assigns a fresh incarnation when direct import overwrites an existing project", async () => {
    const original = await saveProjectSnapshot(snapshot("direct-import", "Original"));

    await saveImportedProjectSnapshot(
      snapshot("direct-import", "Imported replacement"),
      { overwrite: true },
    );

    expect(await loadProjectSnapshot("direct-import")).toMatchObject({
      title: "Imported replacement",
      revision: 1,
      incarnation: expect.any(String),
    });
    expect((await loadProjectSnapshot("direct-import"))?.incarnation)
      .not.toBe(original.incarnation);
  });

  it("direct overwrite fences the old incarnation and durably retires its OPFS media", async () => {
    const opfsOptions = { removeError: new Error("direct overwrite cleanup failed") as Error | undefined };
    installOpfs(opfsOptions);
    const originalSnapshot = snapshot("direct-isolation", "Original");
    const original = await saveProjectSnapshot(originalSnapshot);
    const oldRef = await saveMediaBlob({
      projectId: "direct-isolation",
      sourcePath: "assets/shared.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("old"),
    });
    originalSnapshot.final_path = oldRef;
    await saveProjectSnapshot(originalSnapshot);
    const oldWriter = await beginMediaWrite({
      projectId: "direct-isolation",
      projectIncarnation: original.incarnation,
      sourcePath: "assets/active-old.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    });
    await oldWriter.write(new Uint8Array([1]));

    await saveImportedProjectSnapshot(
      snapshot("direct-isolation", "Replacement", { finalPath: "assets/shared.mp4" }),
      { overwrite: true },
    );

    const replacement = await loadProjectSnapshot("direct-isolation");
    expect(replacement?.incarnation).not.toBe(original.incarnation);
    expect(await loadMediaBlob(oldRef)).toBeNull();
    await expect(findCommittedMedia(
      "direct-isolation",
      "assets/shared.mp4",
      replacement!.incarnation,
    )).resolves.toBeNull();
    await expect(oldWriter.commit()).rejects.toThrow(/incarnation|lease|operation/i);
    expect(await getAllRecords<MediaJournalRecord>("mediaOperations")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mediaId: oldRef.split("/").pop(),
          state: "cleanup_due",
        }),
        expect.objectContaining({
          mediaId: oldWriter.mediaRef.split("/").pop(),
          state: "cleanup_due",
        }),
      ]),
    );
  });

  it("keeps imported media staged until one transaction publishes the project and session", async () => {
    const sessionId = await projectImportApi.beginProjectImport("imported");
    const writer = await beginMediaWrite({
      projectId: "imported",
      importSessionId: sessionId,
      sourcePath: "assets/imported.mp4",
      contentType: "video/mp4",
      sizeBytes: 5,
    });
    await writer.write(new TextEncoder().encode("video"));
    await writer.commit();

    const mediaId = writer.mediaRef.split("/").pop()!;
    expect(await loadProjectSnapshot("imported")).toBeNull();
    expect(await loadMediaBlob(writer.mediaRef)).toBeNull();
    expect(await getRecord<LocalMediaRecord>("media", mediaId)).toMatchObject({
      projectId: "imported",
      state: "staged",
      importSessionId: sessionId,
    });

    await projectImportApi.commitImportedProject(
      snapshot("imported", "Imported", { finalPath: writer.mediaRef }),
      sessionId,
      { overwrite: false, leaseOwner: sessionId },
    );

    expect((await loadRecentProjectSnapshot())?.id).toBe("imported");
    expect(await loadMediaBlob(writer.mediaRef)).not.toBeNull();
    expect(await getRecord<LocalMediaRecord>("media", mediaId)).toMatchObject({
      state: "committed",
      importSessionId: null,
    });
    expect(await getRecord("mediaOperations", sessionId)).toBeNull();
  });

  it("aborts every queued final-import write when a later media put throws", async () => {
    await saveProjectSnapshot(snapshot("existing", "Existing"));
    const sessionId = await projectImportApi.beginProjectImport("atomic-failure");
    const refs: LocalMediaRef[] = [];
    for (const index of [0, 1]) {
      const writer = await beginMediaWrite({
        projectId: "atomic-failure",
        importSessionId: sessionId,
        sourcePath: `assets/${index}.mp4`,
        contentType: "video/mp4",
        sizeBytes: 1,
      });
      await writer.write(new Uint8Array([index]));
      refs.push(await writer.commit());
    }

    const originalPut = IDBObjectStore.prototype.put;
    const failure = new Error("late media commit failed");
    let committedMediaPuts = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (
        this.name === "media" &&
        (value as LocalMediaRecord).state === "committed" &&
        ++committedMediaPuts === 2
      ) {
        throw failure;
      }
      return originalPut.call(this, value, key as IDBValidKey | undefined);
    });

    await expect(projectImportApi.commitImportedProject(
      snapshot("atomic-failure", "Atomic Failure", { finalPath: refs[0] }),
      sessionId,
      { overwrite: false, leaseOwner: sessionId },
    )).rejects.toBe(failure);

    expect(await loadProjectSnapshot("atomic-failure")).toBeNull();
    expect((await loadRecentProjectSnapshot())?.id).toBe("existing");
    for (const ref of refs) {
      const mediaId = ref.split("/").pop()!;
      expect(await getRecord<LocalMediaRecord>("media", mediaId)).toMatchObject({
        state: "staged",
        importSessionId: sessionId,
      });
    }
    expect(await getRecord<MediaJournalRecord>("mediaOperations", sessionId))
      .toMatchObject({ state: "cleanup_due" });
  });

  it("queues the exact import session for cleanup when the final conflict check loses", async () => {
    const sessionId = await projectImportApi.beginProjectImport("raced");
    const writer = await beginMediaWrite({
      projectId: "raced",
      importSessionId: sessionId,
      sourcePath: "assets/imported.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    });
    await writer.write(new Uint8Array([1]));
    await writer.commit();
    await saveProjectSnapshot(snapshot("raced", "Concurrent"));

    await expect(projectImportApi.commitImportedProject(
      snapshot("raced", "Imported", { finalPath: writer.mediaRef }),
      sessionId,
      { overwrite: false, leaseOwner: sessionId },
    )).rejects.toMatchObject({ name: "ProjectImportConflictError", projectId: "raced" });

    expect(await listProjectSummaries()).toEqual([
      expect.objectContaining({ id: "raced", title: "Concurrent" }),
    ]);
    expect(await getRecord<MediaJournalRecord>("mediaOperations", sessionId)).toMatchObject({
      id: sessionId,
      projectId: "raced",
      state: "cleanup_due",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(await loadMediaBlob(writer.mediaRef)).toBeNull();
  });

  it("atomically overwrites a project and publishes its staged media when allowed", async () => {
    const original = await saveProjectSnapshot(snapshot("overwrite", "Existing"));
    const sessionId = await projectImportApi.beginProjectImport("overwrite");
    const writer = await beginMediaWrite({
      projectId: "overwrite",
      importSessionId: sessionId,
      sourcePath: "assets/replacement.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    });
    await writer.write(new Uint8Array([7]));
    await writer.commit();

    await projectImportApi.commitImportedProject(
      snapshot("overwrite", "Replacement", { finalPath: writer.mediaRef }),
      sessionId,
      { overwrite: true, leaseOwner: sessionId },
    );

    expect(await loadProjectSnapshot("overwrite")).toMatchObject({
      title: "Replacement",
      revision: 1,
      incarnation: expect.any(String),
    });
    expect((await loadProjectSnapshot("overwrite"))?.incarnation).not.toBe(original.incarnation);
    expect(await loadMediaBlob(writer.mediaRef)).not.toBeNull();
    expect(await getRecord("mediaOperations", sessionId)).toBeNull();
  });

  it("transactional overwrite publishes only new-incarnation media and fences old writers", async () => {
    const opfsOptions = { removeError: new Error("transactional cleanup failed") as Error | undefined };
    installOpfs(opfsOptions);
    const originalSnapshot = snapshot("transactional-isolation", "Original");
    const original = await saveProjectSnapshot(originalSnapshot);
    const oldRef = await saveMediaBlob({
      projectId: "transactional-isolation",
      sourcePath: "assets/shared.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("old"),
    });
    originalSnapshot.final_path = oldRef;
    await saveProjectSnapshot(originalSnapshot);
    const oldWriter = await beginMediaWrite({
      projectId: "transactional-isolation",
      projectIncarnation: original.incarnation,
      sourcePath: "assets/active-old.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    });
    await oldWriter.write(new Uint8Array([1]));

    const sessionId = await projectImportApi.beginProjectImport("transactional-isolation");
    const importedWriter = await beginMediaWrite({
      projectId: "transactional-isolation",
      importSessionId: sessionId,
      sourcePath: "assets/shared.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    });
    await importedWriter.write(new Uint8Array([9]));
    await importedWriter.commit();

    await projectImportApi.commitImportedProject(
      snapshot("transactional-isolation", "Replacement", { finalPath: importedWriter.mediaRef }),
      sessionId,
      { overwrite: true, leaseOwner: sessionId },
    );

    const replacement = await loadProjectSnapshot("transactional-isolation");
    expect(replacement).toMatchObject({ title: "Replacement", revision: 1 });
    expect(replacement?.incarnation).not.toBe(original.incarnation);
    expect(await loadMediaBlob(oldRef)).toBeNull();
    expect(await loadMediaBlob(importedWriter.mediaRef)).not.toBeNull();
    await expect(findCommittedMedia(
      "transactional-isolation",
      "assets/shared.mp4",
      replacement!.incarnation,
    )).resolves.toMatchObject({ id: importedWriter.mediaRef.split("/").pop() });
    await expect(oldWriter.commit()).rejects.toThrow(/incarnation|lease|operation/i);
    expect(await getRecord("mediaOperations", sessionId)).toBeNull();
    expect(await getAllRecords<MediaJournalRecord>("mediaOperations")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mediaId: oldRef.split("/").pop(),
          state: "cleanup_due",
        }),
        expect.objectContaining({
          mediaId: oldWriter.mediaRef.split("/").pop(),
          state: "cleanup_due",
        }),
      ]),
    );
  });

  it("rejects foreign or non-staged session media without partially publishing", async () => {
    const sessionId = await projectImportApi.beginProjectImport("invalid-import");
    const writer = await beginMediaWrite({
      projectId: "invalid-import",
      importSessionId: sessionId,
      sourcePath: "assets/invalid.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    });
    await writer.write(new Uint8Array([1]));
    await writer.commit();
    const mediaId = writer.mediaRef.split("/").pop()!;
    const staged = await getRecord<LocalMediaRecord>("media", mediaId);
    await putRecord("media", { ...staged, projectId: "foreign", state: "committed" });

    await expect(projectImportApi.commitImportedProject(
      snapshot("invalid-import", "Invalid", { finalPath: writer.mediaRef }),
      sessionId,
      { overwrite: false, leaseOwner: sessionId },
    )).rejects.toThrow(/invalid staged media/i);

    expect(await loadProjectSnapshot("invalid-import")).toBeNull();
    expect(await getRecord<MediaJournalRecord>("mediaOperations", sessionId))
      .toMatchObject({ state: "cleanup_due" });
  });

  it("recovers every staged item after an imported project is aborted", async () => {
    const sessionId = await projectImportApi.beginProjectImport("cancelled");
    for (const byte of [1, 2]) {
      const writer = await beginMediaWrite({
        projectId: "cancelled",
        importSessionId: sessionId,
        sourcePath: `assets/${byte}.mp4`,
        contentType: "video/mp4",
        sizeBytes: 1,
      });
      await writer.write(new Uint8Array([byte]));
      await writer.commit();
    }

    await projectImportApi.abortProjectImport(sessionId, new Error("cancelled"));
    expect(await getRecord<MediaJournalRecord>("mediaOperations", sessionId))
      .toMatchObject({ state: "cleanup_due" });

    await expect(runMediaRecovery()).resolves.toBe(1);
    expect(await getAllRecords("media")).toHaveLength(0);
    expect(await getRecord("mediaOperations", sessionId)).toBeNull();
    expect(await loadProjectSnapshot("cancelled")).toBeNull();
  });

  it("keeps a live multi-item import leased beyond its initial recovery window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
    const sessionId = await projectImportApi.beginProjectImport("long-import");
    const refs: LocalMediaRef[] = [];
    for (const [index, elapsedMs] of [
      [0, 0],
      [1, 25_000],
    ] as const) {
      vi.setSystemTime(new Date(Date.parse("2026-07-11T00:00:00.000Z") + elapsedMs));
      const writer = await beginMediaWrite({
        projectId: "long-import",
        importSessionId: sessionId,
        sourcePath: `assets/${index}.mp4`,
        contentType: "video/mp4",
        sizeBytes: 1,
      });
      await writer.write(new Uint8Array([index]));
      refs.push(await writer.commit());
    }

    vi.setSystemTime(new Date("2026-07-11T00:00:35.000Z"));
    await expect(runMediaRecovery({ leaseOwner: "other-tab" })).resolves.toBe(0);
    await projectImportApi.commitImportedProject(
      snapshot("long-import", "Long Import", { finalPath: refs[0] }),
      sessionId,
      { overwrite: false, leaseOwner: sessionId },
    );

    expect(await loadProjectSnapshot("long-import")).not.toBeNull();
    await expect(loadMediaBlob(refs[1])).resolves.not.toBeNull();
  });

  it("recovers every staged item after an import session lease expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
    const sessionId = await projectImportApi.beginProjectImport("crashed-import");
    const writer = await beginMediaWrite({
      projectId: "crashed-import",
      importSessionId: sessionId,
      sourcePath: "assets/crashed.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    });
    await writer.write(new Uint8Array([1]));
    await writer.commit();

    vi.setSystemTime(new Date("2026-07-11T00:00:31.000Z"));
    await expect(runMediaRecovery({ leaseOwner: "recovery-tab" })).resolves.toBe(1);

    expect(await getRecord("mediaOperations", sessionId)).toBeNull();
    expect(await getAllRecords("media")).toHaveLength(0);
    expect(await loadProjectSnapshot("crashed-import")).toBeNull();
  });

  it("renews the import session between chunks of one long media item", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-11T00:00:00.000Z"));
    const sessionId = await projectImportApi.beginProjectImport("chunked-import");
    const writer = await beginMediaWrite({
      projectId: "chunked-import",
      importSessionId: sessionId,
      sourcePath: "assets/large.mp4",
      contentType: "video/mp4",
      sizeBytes: 2,
    });
    await writer.write(new Uint8Array([1]));

    vi.setSystemTime(new Date("2026-07-11T00:00:25.000Z"));
    await writer.write(new Uint8Array([2]));
    vi.setSystemTime(new Date("2026-07-11T00:00:35.000Z"));

    await expect(runMediaRecovery({ leaseOwner: "other-tab" })).resolves.toBe(0);
    await expect(writer.commit()).resolves.toBe(writer.mediaRef);
  });

  it("saves and restores the recent project snapshot", async () => {
    await saveProjectSnapshot(snapshot("p1", "Rain Alley"));

    const recent = await loadRecentProjectSnapshot();

    expect(recent?.id).toBe("p1");
    expect(recent?.title).toBe("Rain Alley");
    expect(recent?.snapshot.project.id).toBe("p1");
  });

  it("sets the recent project pointer without rewriting the snapshot", async () => {
    await saveProjectSnapshot(snapshot("p1", "Rain Alley"));
    await saveProjectSnapshot(snapshot("p2", "Office Secret"));

    await setRecentProjectId("p1");

    expect((await loadRecentProjectSnapshot())?.snapshot.project.title).toBe("Rain Alley");
  });

  it("lists project summaries ordered by most recently updated", async () => {
    await saveProjectSnapshot(snapshot("p1", "Rain Alley"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveProjectSnapshot(
      snapshot("p2", "Office Secret", {
        finalPath: "renders/final.mp4",
        shots: [shot("s1"), shot("s2")],
      }),
    );

    const summaries = await listProjectSummaries();

    expect(summaries).toEqual([
      expect.objectContaining({
        id: "p2",
        title: "Office Secret",
        shotCount: 2,
        hasFinalRender: true,
      }),
      expect.objectContaining({
        id: "p1",
        title: "Rain Alley",
        shotCount: 0,
        hasFinalRender: false,
      }),
    ]);
  });

  it("deletes a local project and clears the recent pointer when needed", async () => {
    await saveProjectSnapshot(snapshot("p1", "Rain Alley"));

    await deleteProject("p1");

    expect(await loadProjectSnapshot("p1")).toBeNull();
    expect(await loadRecentProjectSnapshot()).toBeNull();
  });

  it.each([1, 2, 3] as const)(
    "migrates a version %i database to the complete v4 schema",
    async (version) => {
      await deleteLocalDb();
      await createLegacyDatabase(version);

      const db = await openLocalDb();
      const tx = db.transaction(["media", "mediaOperations"], "readonly");
      const mediaStore = tx.objectStore("media");
      const operationStore = tx.objectStore("mediaOperations");
      const legacyMedia = await requestToPromise<Record<string, unknown> | undefined>(
        mediaStore.get(`legacy-media-v${version}`),
      );

      expect(db.version).toBe(4);
      expect(Array.from(db.objectStoreNames)).toEqual([
        "media",
        "mediaOperations",
        "mediaPending",
        "projects",
        "settings",
      ]);
      expect(Array.from(mediaStore.indexNames)).toEqual(["projectId", "projectSource"]);
      expect(mediaStore.index("projectSource").keyPath).toEqual(["projectId", "sourcePath"]);
      expect(mediaStore.index("projectSource").unique).toBe(false);
      expect(Array.from(operationStore.indexNames)).toEqual([
        "leaseExpiresAt",
        "nextAttemptAt",
        "projectId",
      ]);
      expect(legacyMedia).toEqual(
        expect.objectContaining({ state: "committed", importSessionId: null }),
      );
    },
  );

  it("deletes project-owned IndexedDB media without touching another project", async () => {
    const first = snapshot("p1", "First");
    const second = snapshot("p2", "Second");
    await saveProjectSnapshot(first);
    await saveProjectSnapshot(second);
    const firstRef = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/p1.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("first"),
    });
    const secondRef = await saveMediaBlob({
      projectId: "p2",
      sourcePath: "assets/p2.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("second"),
    });
    first.final_path = firstRef;
    second.final_path = secondRef;
    await saveProjectSnapshot(first);
    await saveProjectSnapshot(second);

    await deleteProject("p1");

    expect(await loadMediaBlob(firstRef)).toBeNull();
    const remaining = await loadMediaBlob(secondRef);
    expect(remaining ? await blobToText(remaining) : null).toBe("second");
  });

  it("removes project-owned OPFS media", async () => {
    const { files, removeEntry } = installOpfs();
    const project = snapshot("p1", "First");
    await saveProjectSnapshot(project);
    const ref = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/p1.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("first"),
    });
    project.final_path = ref;
    await saveProjectSnapshot(project);

    await deleteProject("p1");

    expect(removeEntry).toHaveBeenCalledTimes(1);
    expect(files.size).toBe(0);
    expect(await loadMediaBlob(ref)).toBeNull();
  });

  it("preserves media still referenced by another project", async () => {
    const first = snapshot("p1", "First");
    const second = snapshot("p2", "Second");
    await saveProjectSnapshot(first);
    await saveProjectSnapshot(second);
    const sharedRef = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/shared.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("shared"),
    });
    first.final_path = sharedRef;
    second.final_path = sharedRef;
    await saveProjectSnapshot(first);
    await saveProjectSnapshot(second);

    await deleteProject("p1");

    const shared = await loadMediaBlob(sharedRef);
    expect(shared ? await blobToText(shared) : null).toBe("shared");
  });

  it("collects shared IndexedDB media after the final referencing project is deleted", async () => {
    const first = snapshot("p1", "First");
    const second = snapshot("p2", "Second");
    await saveProjectSnapshot(first);
    await saveProjectSnapshot(second);
    const sharedRef = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/shared.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("shared"),
    });
    first.final_path = sharedRef;
    second.final_path = sharedRef;
    await saveProjectSnapshot(first);
    await saveProjectSnapshot(second);

    await deleteProject("p1");
    expect(await loadMediaBlob(sharedRef)).not.toBeNull();

    await deleteProject("p2");
    expect(await loadMediaBlob(sharedRef)).toBeNull();
  });

  it("collects shared OPFS media after the final referencing project is deleted", async () => {
    const { files, removeEntry } = installOpfs();
    const first = snapshot("p1", "First");
    const second = snapshot("p2", "Second");
    await saveProjectSnapshot(first);
    await saveProjectSnapshot(second);
    const sharedRef = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/shared.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("shared"),
    });
    first.final_path = sharedRef;
    second.final_path = sharedRef;
    await saveProjectSnapshot(first);
    await saveProjectSnapshot(second);

    await deleteProject("p1");
    expect(files.size).toBe(1);
    expect(removeEntry).not.toHaveBeenCalled();

    await deleteProject("p2");
    expect(files.size).toBe(0);
    expect(removeEntry).toHaveBeenCalledTimes(1);
    expect(await loadMediaBlob(sharedRef)).toBeNull();
  });

  it("keeps OPFS cleanup durably queued without failing logical project deletion", async () => {
    installOpfs({ removeError: new Error("OPFS remove failed") });
    const project = snapshot("p1", "First");
    await saveProjectSnapshot(project);
    const ref = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/p1.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("first"),
    });
    project.final_path = ref;
    await saveProjectSnapshot(project);

    await expect(deleteProject("p1")).resolves.toBeUndefined();

    expect(await loadProjectSnapshot("p1")).toBeNull();
    expect(await loadMediaBlob(ref)).toBeNull();
    expect(await getAllRecords<MediaJournalRecord>("mediaOperations")).toEqual([
      expect.objectContaining({
        kind: "media_write",
        projectId: "p1",
        state: "cleanup_due",
        attempts: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    ]);
  });

  it("prevents an active project writer from publishing after project deletion", async () => {
    installOpfs();
    await saveProjectSnapshot(snapshot("p1", "First"));
    const writer = await beginMediaWrite({
      projectId: "p1",
      sourcePath: "assets/active.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    });
    await writer.write(new Uint8Array([1]));

    await deleteProject("p1");

    await expect(writer.commit()).rejects.toThrow(/lease|operation/i);
    expect(await loadMediaBlob(writer.mediaRef)).toBeNull();
    expect(await loadProjectSnapshot("p1")).toBeNull();
  });

  it("preserves existing cleanup retry metadata while deleting its project", async () => {
    await saveProjectSnapshot(snapshot("retrying", "Retrying"));
    const record: MediaJournalRecord = {
      id: "retry-operation",
      kind: "media_write",
      mediaId: "retry-media",
      projectId: "retrying",
      importSessionId: null,
      sourcePath: "assets/retry.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
      opfsPath: "openmontage-media/retry-media",
      state: "cleanup_due",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      attempts: 4,
      nextAttemptAt: "2999-01-01T00:00:00.000Z",
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    await putRecord("mediaOperations", record);

    await deleteProject("retrying");

    expect(await getRecord("mediaOperations", record.id)).toEqual(record);
  });

  it("cancels active import writers when their target project is deleted", async () => {
    installOpfs();
    const sessionId = await projectImportApi.beginProjectImport("future");
    const writer = await beginMediaWrite({
      projectId: "future",
      importSessionId: sessionId,
      sourcePath: "assets/active-import.mp4",
      contentType: "video/mp4",
      sizeBytes: 1,
    });
    await writer.write(new Uint8Array([1]));

    await deleteProject("future");

    await expect(writer.commit()).rejects.toThrow(/lease|operation|session/i);
    expect(await loadMediaBlob(writer.mediaRef)).toBeNull();
    expect(await loadProjectSnapshot("future")).toBeNull();
  });
});
