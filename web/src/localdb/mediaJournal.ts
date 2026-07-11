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
  | "importSessionId"
  | "sourcePath"
  | "contentType"
  | "sizeBytes"
  | "opfsPath"
  | "leaseOwner"
>;

export type CreateMediaImportSessionInput = Pick<
  MediaImportSessionRecord,
  "id" | "projectId" | "mediaIds" | "leaseOwner"
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

export async function createMediaOperation(
  input: CreateMediaOperationInput,
  options: MediaJournalOptions = {},
): Promise<MediaOperationRecord> {
  const now = currentTime(options);
  const timestamp = now.toISOString();
  const record: MediaOperationRecord = {
    ...input,
    kind: "media_write",
    state: "writing",
    createdAt: timestamp,
    updatedAt: timestamp,
    attempts: 0,
    nextAttemptAt: timestamp,
    leaseExpiresAt: input.leaseOwner ? leaseExpiry(now, options) : null,
  };

  let completion: Promise<void> | null = null;
  try {
    const db = await database(options);
    const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
    completion = transactionDone(tx);
    await requestToPromise(tx.objectStore(LOCAL_STORES.mediaOperations).add(record));
    await completion;
    return record;
  } catch (error) {
    await completion?.catch(() => undefined);
    throw new MediaDurabilityError(record.id, error);
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

  let completion: Promise<void> | null = null;
  try {
    const db = await database(options);
    const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
    completion = transactionDone(tx);
    await requestToPromise(tx.objectStore(LOCAL_STORES.mediaOperations).add(record));
    await completion;
    return record;
  } catch (error) {
    await completion?.catch(() => undefined);
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
  const done = transactionDone(tx);
  const store = tx.objectStore(LOCAL_STORES.mediaOperations);
  const record = await readRecord(store, id);
  if (
    !record ||
    record.id !== id ||
    !isActiveRecord(record) ||
    record.leaseOwner !== leaseOwner ||
    !hasActiveLease(record, now)
  ) {
    await done;
    return null;
  }

  const updated: MediaJournalRecord = {
    ...record,
    updatedAt: now.toISOString(),
    leaseExpiresAt: leaseExpiry(now, options),
  };
  await requestToPromise(store.put(updated));
  await done;
  return updated;
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
  const done = transactionDone(tx);
  const store = tx.objectStore(LOCAL_STORES.mediaOperations);
  const record = await readRecord(store, id);
  if (
    !record ||
    record.id !== id ||
    !isActiveRecord(record) ||
    record.leaseOwner !== leaseOwner
  ) {
    await done;
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
  await done;
  return updated;
}

export async function claimNextDueMediaOperation(
  leaseOwner: string,
  options: MediaJournalOptions = {},
): Promise<MediaJournalRecord | null> {
  const db = await database(options);
  const now = currentTime(options);
  const timestamp = now.toISOString();
  const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
  const done = transactionDone(tx);
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
    await done;
    return updated;
  }

  await done;
  return null;
}

export async function recordMediaOperationFailure(
  id: string,
  leaseOwner: string,
  options: MediaJournalOptions = {},
): Promise<MediaJournalRecord | null> {
  const db = await database(options);
  const now = currentTime(options);
  const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
  const done = transactionDone(tx);
  const store = tx.objectStore(LOCAL_STORES.mediaOperations);
  const record = await readRecord(store, id);
  if (
    !record ||
    record.id !== id ||
    record.state !== "cleanup_due" ||
    record.leaseOwner !== leaseOwner ||
    !hasActiveLease(record, now)
  ) {
    await done;
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
  await done;
  return updated;
}

export async function completeMediaJournalRecord(
  id: string,
  leaseOwner: string,
  options: MediaJournalOptions = {},
): Promise<boolean> {
  const db = await database(options);
  const now = currentTime(options);
  const tx = db.transaction(LOCAL_STORES.mediaOperations, "readwrite");
  const done = transactionDone(tx);
  const store = tx.objectStore(LOCAL_STORES.mediaOperations);
  const record = await readRecord(store, id);
  if (
    !record ||
    record.id !== id ||
    record.state !== "cleanup_due" ||
    record.leaseOwner !== leaseOwner ||
    !hasActiveLease(record, now)
  ) {
    await done;
    return false;
  }

  await requestToPromise(store.delete(id));
  await done;
  return true;
}
