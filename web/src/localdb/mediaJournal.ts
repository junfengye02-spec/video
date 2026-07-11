import { LOCAL_STORES, openLocalDb } from "./indexedDb";
import type {
  MediaImportSessionRecord,
  MediaJournalRecord,
  MediaOperationRecord,
} from "./types";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;

export interface MediaJournalOptions {
  db?: IDBDatabase;
  now?: () => Date;
  leaseDurationMs?: number;
}

export type CreateMediaOperationInput = Pick<
  MediaOperationRecord,
  | "id"
  | "mediaId"
  | "projectId"
  | "projectIncarnation"
  | "importSessionId"
  | "sourcePath"
  | "contentType"
  | "sizeBytes"
  | "opfsPath"
  | "leaseOwner"
>;

export type ValidatedMediaOperationInput = Omit<
  CreateMediaOperationInput,
  "projectId"
> & {
  projectId: string | null;
};

export type CreateMediaImportSessionInput = Pick<
  MediaImportSessionRecord,
  "id" | "projectId" | "mediaIds" | "leaseOwner"
  | "projectIncarnation"
>;

export class MediaDurabilityError extends Error {
  readonly operationId: string;
  readonly cause: unknown;

  constructor(operationId: string, cause: unknown) {
    super(`Could not establish durable media operation ${operationId}`);
    this.name = "MediaDurabilityError";
    this.operationId = operationId;
    this.cause = cause;
  }
}

export class MediaRecoveryError extends Error {
  readonly operationId: string;
  readonly cause: unknown;

  constructor(operationId: string, cause: unknown) {
    super(`Media recovery attempt failed for operation ${operationId}`);
    this.name = "MediaRecoveryError";
    this.operationId = operationId;
    this.cause = cause;
  }
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

async function runTransaction<T>(tx: IDBTransaction, work: () => Promise<T>): Promise<T> {
  const completion = transactionDone(tx);
  try {
    const result = await work();
    await completion;
    return result;
  } catch (error) {
    await completion.catch(() => undefined);
    throw error;
  }
}

async function database(options: MediaJournalOptions): Promise<IDBDatabase> {
  return options.db ?? openLocalDb();
}

function currentTime(options: MediaJournalOptions): Date {
  return options.now?.() ?? new Date();
}

function leaseExpiry(now: Date, options: MediaJournalOptions): string {
  return new Date(
    now.getTime() + (options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS),
  ).toISOString();
}

function isActiveRecord(record: MediaJournalRecord): boolean {
  return (
    (record.kind === "media_write" && record.state === "writing") ||
    (record.kind === "import_session" && record.state === "importing")
  );
}

function hasActiveLease(record: MediaJournalRecord, now: Date): boolean {
  if (!record.leaseOwner || !record.leaseExpiresAt) return false;
  const expiresAt = Date.parse(record.leaseExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function retryDelay(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 10);
  return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** exponent, MAX_RETRY_DELAY_MS);
}

async function readRecord(
  store: IDBObjectStore,
  id: string,
): Promise<MediaJournalRecord | null> {
  const record = await requestToPromise<MediaJournalRecord | undefined>(store.get(id));
  return record ?? null;
}

function mediaOperationRecord(
  input: CreateMediaOperationInput,
  options: MediaJournalOptions,
): MediaOperationRecord {
  const now = currentTime(options);
  const timestamp = now.toISOString();
  return {
    ...input,
    kind: "media_write",
    state: "writing",
    createdAt: timestamp,
    updatedAt: timestamp,
    attempts: 0,
    nextAttemptAt: timestamp,
    leaseExpiresAt: input.leaseOwner ? leaseExpiry(now, options) : null,
  };
}

function normalizedProjectIncarnation(record: { id: string; incarnation?: string }): string {
  return record.incarnation?.trim() || `legacy:${record.id}`;
}

function normalizedSessionIncarnation(record: MediaImportSessionRecord): string {
  return record.projectIncarnation?.trim() || `legacy:${record.projectId}`;
}

export async function createMediaOperation(
  input: CreateMediaOperationInput,
  options: MediaJournalOptions = {},
): Promise<MediaOperationRecord> {
  const record = mediaOperationRecord(input, options);

  try {
    const db = await database(options);
    const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
    await runTransaction(tx, async () => {
      await requestToPromise(tx.objectStore(LOCAL_STORES.mediaOperations).add(record));
    });
    return record;
  } catch (error) {
    throw new MediaDurabilityError(record.id, error);
  }
}

export async function createValidatedMediaOperation(
  input: ValidatedMediaOperationInput,
  options: MediaJournalOptions = {},
): Promise<MediaOperationRecord> {
  const db = await database(options);
  const stores = input.importSessionId
    ? [LOCAL_STORES.mediaOperations]
    : [LOCAL_STORES.projects, LOCAL_STORES.mediaOperations];
  const tx = db.transaction(stores, "readwrite");
  try {
    return await runTransaction(tx, async () => {
      const operationStore = tx.objectStore(LOCAL_STORES.mediaOperations);
      let projectId = input.projectId;
      if (input.importSessionId) {
        const session = await readRecord(operationStore, input.importSessionId);
        if (!session || session.kind !== "import_session" || session.state !== "importing") {
          throw new Error(`Active import session ${input.importSessionId} was not found`);
        }
        if (projectId !== null && projectId !== session.projectId) {
          throw new Error(`Import session ${input.importSessionId} belongs to another project`);
        }
        projectId = session.projectId;
        const projectIncarnation = normalizedSessionIncarnation(session);
        if (
          input.projectIncarnation
          && input.projectIncarnation !== projectIncarnation
        ) {
          throw new Error(`Import session ${input.importSessionId} belongs to another incarnation`);
        }
        input = { ...input, projectIncarnation };
      } else {
        if (!projectId) throw new Error("A project is required for media writes");
        const project = await requestToPromise<{ id: string; incarnation?: string } | undefined>(
          tx.objectStore(LOCAL_STORES.projects).get(projectId),
        );
        if (!project) throw new Error(`Project ${projectId} was not found`);
        const projectIncarnation = normalizedProjectIncarnation(project);
        if (
          input.projectIncarnation
          && input.projectIncarnation !== projectIncarnation
        ) {
          throw new Error(`Project ${projectId} belongs to another incarnation`);
        }
        input = { ...input, projectIncarnation };
      }

      const record = mediaOperationRecord({ ...input, projectId }, options);
      await requestToPromise(operationStore.add(record));
      return record;
    });
  } catch (error) {
    if (error instanceof Error && /project|import session/i.test(error.message)) throw error;
    throw new MediaDurabilityError(input.id, error);
  }
}

export async function createMediaImportSession(
  input: CreateMediaImportSessionInput,
  options: MediaJournalOptions = {},
): Promise<MediaImportSessionRecord> {
  const now = currentTime(options);
  const timestamp = now.toISOString();
  const record: MediaImportSessionRecord = {
    ...input,
    mediaIds: [...input.mediaIds],
    kind: "import_session",
    state: "importing",
    createdAt: timestamp,
    updatedAt: timestamp,
    attempts: 0,
    nextAttemptAt: timestamp,
    leaseExpiresAt: input.leaseOwner ? leaseExpiry(now, options) : null,
  };

  try {
    const db = await database(options);
    const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
    await runTransaction(tx, async () => {
      await requestToPromise(tx.objectStore(LOCAL_STORES.mediaOperations).add(record));
    });
    return record;
  } catch (error) {
    throw new MediaDurabilityError(record.id, error);
  }
}

export async function renewMediaOperationLease(
  id: string,
  leaseOwner: string,
  options: MediaJournalOptions = {},
): Promise<MediaJournalRecord | null> {
  const db = await database(options);
  const now = currentTime(options);
  const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
  return runTransaction(tx, async () => {
    const store = tx.objectStore(LOCAL_STORES.mediaOperations);
    const record = await readRecord(store, id);
    if (
      !record ||
      record.id !== id ||
      !isActiveRecord(record) ||
      record.leaseOwner !== leaseOwner ||
      !hasActiveLease(record, now)
    ) {
      return null;
    }

    const updated: MediaJournalRecord = {
      ...record,
      updatedAt: now.toISOString(),
      leaseExpiresAt: leaseExpiry(now, options),
    };
    await requestToPromise(store.put(updated));
    return updated;
  });
}

export async function renewMediaRecoveryLease(
  id: string,
  leaseOwner: string,
  options: MediaJournalOptions = {},
): Promise<MediaJournalRecord | null> {
  const db = await database(options);
  const now = currentTime(options);
  const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
  return runTransaction(tx, async () => {
    const store = tx.objectStore(LOCAL_STORES.mediaOperations);
    const record = await readRecord(store, id);
    if (
      !record || record.state !== "cleanup_due" || record.leaseOwner !== leaseOwner ||
      !hasActiveLease(record, now)
    ) {
      return null;
    }
    const updated: MediaJournalRecord = {
      ...record,
      updatedAt: now.toISOString(),
      leaseExpiresAt: leaseExpiry(now, options),
    };
    await requestToPromise(store.put(updated));
    return updated;
  });
}

function isSameMediaOperation(
  existing: MediaJournalRecord,
  expected: MediaOperationRecord,
): existing is MediaOperationRecord {
  return existing.kind === "media_write" &&
    existing.id === expected.id &&
    existing.mediaId === expected.mediaId &&
    existing.projectId === expected.projectId &&
    (existing.projectIncarnation ?? null) === (expected.projectIncarnation ?? null) &&
    existing.importSessionId === expected.importSessionId &&
    existing.sourcePath === expected.sourcePath &&
    existing.contentType === expected.contentType &&
    existing.sizeBytes === expected.sizeBytes &&
    existing.opfsPath === expected.opfsPath;
}

export async function ensureMediaOperationCleanupDue(
  expected: MediaOperationRecord,
  options: MediaJournalOptions = {},
): Promise<MediaOperationRecord> {
  const db = await database(options);
  const now = currentTime(options);
  const timestamp = now.toISOString();
  const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
  try {
    return await runTransaction(tx, async () => {
      const store = tx.objectStore(LOCAL_STORES.mediaOperations);
      const existing = await readRecord(store, expected.id);
      if (existing) {
        if (!isSameMediaOperation(existing, expected)) {
          throw new Error(`Media cleanup operation ${expected.id} conflicts with another record`);
        }
        if (existing.state === "cleanup_due") return existing;
        const updated: MediaOperationRecord = {
          ...existing,
          state: "cleanup_due",
          updatedAt: timestamp,
          nextAttemptAt: timestamp,
          leaseOwner: null,
          leaseExpiresAt: null,
        };
        await requestToPromise(store.put(updated));
        return updated;
      }

      const recreated: MediaOperationRecord = {
        ...expected,
        state: "cleanup_due",
        updatedAt: timestamp,
        nextAttemptAt: timestamp,
        leaseOwner: null,
        leaseExpiresAt: null,
      };
      await requestToPromise(store.add(recreated));
      return recreated;
    });
  } catch (error) {
    throw new MediaDurabilityError(expected.id, error);
  }
}

export async function markMediaOperationCleanupDue(
  id: string,
  leaseOwner: string,
  options: MediaJournalOptions = {},
): Promise<MediaJournalRecord | null> {
  const db = await database(options);
  const now = currentTime(options);
  const timestamp = now.toISOString();
  const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
  return runTransaction(tx, async () => {
    const store = tx.objectStore(LOCAL_STORES.mediaOperations);
    const record = await readRecord(store, id);
    if (
      !record ||
      record.id !== id ||
      !isActiveRecord(record) ||
      record.leaseOwner !== leaseOwner
    ) {
      return null;
    }

    const updated: MediaJournalRecord = {
      ...record,
      state: "cleanup_due",
      updatedAt: timestamp,
      nextAttemptAt: timestamp,
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    await requestToPromise(store.put(updated));
    return updated;
  });
}

export async function claimNextDueMediaOperation(
  leaseOwner: string,
  options: MediaJournalOptions = {},
): Promise<MediaJournalRecord | null> {
  const db = await database(options);
  const now = currentTime(options);
  const timestamp = now.toISOString();
  const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
  return runTransaction(tx, async () => {
    const store = tx.objectStore(LOCAL_STORES.mediaOperations);
    const dueRecords = await requestToPromise<MediaJournalRecord[]>(
      store.index("nextAttemptAt").getAll(IDBKeyRange.upperBound(timestamp)),
    );

    for (const candidate of dueRecords) {
      const record = await readRecord(store, candidate.id);
      if (
        !record ||
        record.id !== candidate.id ||
        record.nextAttemptAt > timestamp ||
        hasActiveLease(record, now)
      ) {
        continue;
      }

      const updated: MediaJournalRecord = {
        ...record,
        state: "cleanup_due",
        updatedAt: timestamp,
        leaseOwner,
        leaseExpiresAt: leaseExpiry(now, options),
      };
      await requestToPromise(store.put(updated));
      return updated;
    }

    return null;
  });
}

export async function recordMediaOperationFailure(
  id: string,
  leaseOwner: string,
  options: MediaJournalOptions = {},
): Promise<MediaJournalRecord | null> {
  const db = await database(options);
  const now = currentTime(options);
  const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
  return runTransaction(tx, async () => {
    const store = tx.objectStore(LOCAL_STORES.mediaOperations);
    const record = await readRecord(store, id);
    if (
      !record ||
      record.id !== id ||
      record.state !== "cleanup_due" ||
      record.leaseOwner !== leaseOwner ||
      !hasActiveLease(record, now)
    ) {
      return null;
    }

    const attempts = record.attempts + 1;
    const updated: MediaJournalRecord = {
      ...record,
      attempts,
      updatedAt: now.toISOString(),
      nextAttemptAt: new Date(now.getTime() + retryDelay(attempts)).toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
    };
    await requestToPromise(store.put(updated));
    return updated;
  });
}

export async function completeMediaJournalRecord(
  id: string,
  leaseOwner: string,
  options: MediaJournalOptions = {},
): Promise<boolean> {
  const db = await database(options);
  const now = currentTime(options);
  const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
  return runTransaction(tx, async () => {
    const store = tx.objectStore(LOCAL_STORES.mediaOperations);
    const record = await readRecord(store, id);
    if (
      !record ||
      record.id !== id ||
      record.state !== "cleanup_due" ||
      record.leaseOwner !== leaseOwner ||
      !hasActiveLease(record, now)
    ) {
      return false;
    }

    await requestToPromise(store.delete(id));
    return true;
  });
}

export async function getNextMediaRecoveryAt(
  options: MediaJournalOptions = {},
): Promise<Date | null> {
  const db = await database(options);
  const tx = db.transaction(LOCAL_STORES.mediaOperations, "readonly");
  const records = await requestToPromise<MediaJournalRecord[]>(
    tx.objectStore(LOCAL_STORES.mediaOperations).getAll(),
  );
  let earliest = Number.POSITIVE_INFINITY;
  for (const record of records) {
    const nextAttemptAt = Date.parse(record.nextAttemptAt);
    const leaseExpiresAt = record.leaseExpiresAt ? Date.parse(record.leaseExpiresAt) : NaN;
    const eligibleAt = Number.isFinite(leaseExpiresAt)
      ? Math.max(nextAttemptAt, leaseExpiresAt)
      : nextAttemptAt;
    if (Number.isFinite(eligibleAt)) earliest = Math.min(earliest, eligibleAt);
  }
  return Number.isFinite(earliest) ? new Date(earliest) : null;
}
