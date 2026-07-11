import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalDb, resetLocalDbForTests } from "./indexedDb";
import {
  claimNextDueMediaOperation,
  completeMediaJournalRecord,
  createMediaImportSession,
  createMediaOperation,
  markMediaOperationCleanupDue,
  MediaDurabilityError,
  MediaRecoveryError,
  recordMediaOperationFailure,
  renewMediaOperationLease,
} from "./mediaJournal";
import type { MediaJournalRecord } from "./types";
import { LOCAL_DB_NAME, LOCAL_DB_VERSION } from "./types";

const BASE_TIME = "2026-07-11T00:00:00.000Z";
const extraConnections: IDBDatabase[] = [];

function at(offsetMs = 0): () => Date {
  return () => new Date(Date.parse(BASE_TIME) + offsetMs);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.oncomplete = () => resolve();
  });
}

async function openExtraConnection(): Promise<IDBDatabase> {
  const db = await requestToPromise(indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION));
  extraConnections.push(db);
  return db;
}

async function openMutationFailureDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore("mediaOperations", { keyPath: "id" });
    store.createIndex("nextAttemptAt", "nextAttemptAt", { unique: false });
    store.createIndex("leaseOwner", "leaseOwner", { unique: true });
    store.add({
      ...operationInput("a-blocker"),
      kind: "media_write",
      state: "cleanup_due",
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
      attempts: 0,
      nextAttemptAt: BASE_TIME,
      leaseOwner: "tab-a",
      leaseExpiresAt: "2026-07-11T00:00:10.000Z",
    });
    store.add({
      ...operationInput("b-target"),
      kind: "media_write",
      state: "cleanup_due",
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
      attempts: 0,
      nextAttemptAt: BASE_TIME,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  };
  const db = await requestToPromise(request);
  extraConnections.push(db);
  return db;
}

async function loadJournalRecord(id: string): Promise<MediaJournalRecord | null> {
  const db = await openLocalDb();
  const record = await requestToPromise<MediaJournalRecord | undefined>(
    db.transaction("mediaOperations", "readonly").objectStore("mediaOperations").get(id),
  );
  return record ?? null;
}

async function putJournalRecord(record: MediaJournalRecord): Promise<void> {
  const db = await openLocalDb();
  const tx = db.transaction("mediaOperations", "readwrite");
  const done = transactionDone(tx);
  tx.objectStore("mediaOperations").put(record);
  await done;
}

async function deleteLocalDb(): Promise<void> {
  for (const db of extraConnections.splice(0)) db.close();
  resetLocalDbForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
  });
}

function operationInput(id = "operation-1") {
  return {
    id,
    mediaId: `media-${id}`,
    projectId: "project-1",
    importSessionId: null,
    sourcePath: "assets/scene.mp4",
    contentType: "video/mp4",
    sizeBytes: 42,
    opfsPath: `openmontage-media/media-${id}`,
    leaseOwner: "writer-1",
  };
}

afterEach(deleteLocalDb);

describe("media journal creation", () => {
  it("creates a protected media write operation before external storage work", async () => {
    const operation = await createMediaOperation(operationInput(), {
      now: at(),
      leaseDurationMs: 2_000,
    });

    expect(operation).toEqual({
      ...operationInput(),
      kind: "media_write",
      state: "writing",
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
      attempts: 0,
      nextAttemptAt: BASE_TIME,
      leaseExpiresAt: "2026-07-11T00:00:02.000Z",
    });
    expect(await loadJournalRecord(operation.id)).toEqual(operation);
  });

  it("creates an import session with the exact durable journal fields", async () => {
    const session = await createMediaImportSession(
      {
        id: "import-1",
        projectId: "project-1",
        mediaIds: ["media-1", "media-2"],
        leaseOwner: "importer-1",
      },
      { now: at(), leaseDurationMs: 3_000 },
    );

    expect(session).toEqual({
      id: "import-1",
      kind: "import_session",
      projectId: "project-1",
      mediaIds: ["media-1", "media-2"],
      state: "importing",
      createdAt: BASE_TIME,
      updatedAt: BASE_TIME,
      attempts: 0,
      nextAttemptAt: BASE_TIME,
      leaseOwner: "importer-1",
      leaseExpiresAt: "2026-07-11T00:00:03.000Z",
    });
  });

  it("wraps an initial journal write failure as MediaDurabilityError", async () => {
    await createMediaOperation(operationInput(), { now: at() });

    const duplicate = createMediaOperation(operationInput(), { now: at(1) });

    await expect(duplicate).rejects.toMatchObject({
      name: "MediaDurabilityError",
      operationId: "operation-1",
    });
    await expect(duplicate).rejects.toBeInstanceOf(MediaDurabilityError);

    const cause = new Error("cleanup failed");
    expect(new MediaRecoveryError("operation-1", cause)).toMatchObject({
      name: "MediaRecoveryError",
      operationId: "operation-1",
      cause,
    });
  });
});

describe("media journal guarded mutations", () => {
  it("checks state and lease ownership before renew, cleanup, and completion", async () => {
    await createMediaOperation(operationInput(), {
      now: at(),
      leaseDurationMs: 2_000,
    });

    expect(
      await renewMediaOperationLease("operation-1", "other-writer", { now: at(1_000) }),
    ).toBeNull();
    expect(
      await renewMediaOperationLease("operation-1", "writer-1", {
        now: at(1_000),
        leaseDurationMs: 2_000,
      }),
    ).toMatchObject({ leaseExpiresAt: "2026-07-11T00:00:03.000Z" });
    expect(
      await markMediaOperationCleanupDue("operation-1", "other-writer", { now: at(1_000) }),
    ).toBeNull();
    expect(
      await markMediaOperationCleanupDue("operation-1", "writer-1", { now: at(1_000) }),
    ).toMatchObject({
      state: "cleanup_due",
      nextAttemptAt: "2026-07-11T00:00:01.000Z",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(
      await renewMediaOperationLease("operation-1", "writer-1", { now: at(1_000) }),
    ).toBeNull();

    const claimed = await claimNextDueMediaOperation("recovery-1", {
      now: at(1_000),
      leaseDurationMs: 2_000,
    });
    expect(claimed).toMatchObject({ id: "operation-1", leaseOwner: "recovery-1" });
    expect(
      await completeMediaJournalRecord("operation-1", "other-recovery", { now: at(1_000) }),
    ).toBe(false);
    expect(
      await completeMediaJournalRecord("operation-1", "recovery-1", { now: at(1_000) }),
    ).toBe(true);
    expect(await loadJournalRecord("operation-1")).toBeNull();
  });

  it("drains an aborted mutation transaction without replacing the request error", async () => {
    const db = await openMutationFailureDatabase();

    await expect(
      claimNextDueMediaOperation("tab-a", {
        db,
        now: at(),
        leaseDurationMs: 1_000,
      }),
    ).rejects.toMatchObject({ name: "ConstraintError" });

    const target = await requestToPromise<MediaJournalRecord>(
      db.transaction("mediaOperations", "readonly")
        .objectStore("mediaOperations")
        .get("b-target"),
    );
    expect(target.leaseOwner).toBeNull();
  });
});

describe("media journal recovery leasing", () => {
  it("atomically grants a due record to only one of two database connections", async () => {
    const firstDb = await openLocalDb();
    const secondDb = await openExtraConnection();
    await createMediaOperation(operationInput(), { db: firstDb, now: at() });
    await markMediaOperationCleanupDue("operation-1", "writer-1", { db: firstDb, now: at() });

    const claims = await Promise.all([
      claimNextDueMediaOperation("tab-a", {
        db: firstDb,
        now: at(),
        leaseDurationMs: 1_000,
      }),
      claimNextDueMediaOperation("tab-b", {
        db: secondDb,
        now: at(),
        leaseDurationMs: 1_000,
      }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await loadJournalRecord("operation-1"))?.leaseOwner).toBe(
      claims.find(Boolean)?.leaseOwner,
    );
  });

  it("claims an expired writer and does not reclaim its recovery lease before expiry", async () => {
    await createMediaOperation(operationInput(), { now: at(), leaseDurationMs: 1_000 });

    expect(await claimNextDueMediaOperation("tab-a", { now: at(999) })).toBeNull();
    expect(
      await claimNextDueMediaOperation("tab-a", { now: at(1_000), leaseDurationMs: 1_000 }),
    ).toMatchObject({ state: "cleanup_due", leaseOwner: "tab-a" });

    expect(await claimNextDueMediaOperation("tab-b", { now: at(1_999) })).toBeNull();
    expect(
      await claimNextDueMediaOperation("tab-b", {
        now: at(2_000),
        leaseDurationMs: 1_000,
      }),
    ).toMatchObject({ leaseOwner: "tab-b" });
  });

  it("uses 5-second exponential backoff capped at 1 hour without discarding attempts", async () => {
    await createMediaOperation(operationInput(), { now: at() });
    await markMediaOperationCleanupDue("operation-1", "writer-1", { now: at() });
    await claimNextDueMediaOperation("tab-a", { now: at(), leaseDurationMs: 1_000 });

    const firstFailure = await recordMediaOperationFailure("operation-1", "tab-a", {
      now: at(),
    });
    expect(firstFailure).toMatchObject({
      attempts: 1,
      nextAttemptAt: "2026-07-11T00:00:05.000Z",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(await claimNextDueMediaOperation("tab-b", { now: at(4_999) })).toBeNull();

    const claimedAgain = await claimNextDueMediaOperation("tab-b", {
      now: at(5_000),
      leaseDurationMs: 2_000,
    });
    expect(claimedAgain).not.toBeNull();
    const secondFailure = await recordMediaOperationFailure("operation-1", "tab-b", {
      now: at(5_000),
    });
    expect(secondFailure).toMatchObject({
      attempts: 2,
      nextAttemptAt: "2026-07-11T00:00:15.000Z",
    });

    const claimedForCap = await claimNextDueMediaOperation("tab-b", {
      now: at(15_000),
      leaseDurationMs: 2_000,
    });
    expect(claimedForCap).not.toBeNull();
    await putJournalRecord({ ...claimedForCap!, attempts: 999 });

    const cappedFailure = await recordMediaOperationFailure("operation-1", "tab-b", {
      now: at(15_000),
    });
    expect(cappedFailure).toMatchObject({
      attempts: 1_000,
      nextAttemptAt: "2026-07-11T01:00:15.000Z",
      leaseOwner: null,
    });
    expect(await loadJournalRecord("operation-1")).not.toBeNull();
    expect(await claimNextDueMediaOperation("tab-c", { now: at(3_614_999) })).toBeNull();
    expect(await claimNextDueMediaOperation("tab-c", { now: at(3_615_000) })).toMatchObject({
      id: "operation-1",
      attempts: 1_000,
    });
  });
});
