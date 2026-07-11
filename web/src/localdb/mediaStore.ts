import { LOCAL_STORES, openLocalDb } from "./indexedDb";
import {
  claimNextDueMediaOperation,
  createValidatedMediaOperation,
  ensureMediaOperationCleanupDue,
  getNextMediaRecoveryAt,
  MediaRecoveryError,
  recordMediaOperationFailure,
  renewMediaOperationLease,
  renewMediaRecoveryLease,
  type MediaJournalOptions,
} from "./mediaJournal";
import type {
  LocalMediaPendingRecord,
  LocalMediaRecord,
  LocalMediaRef,
  MediaImportSessionRecord,
  MediaJournalRecord,
  MediaOperationRecord,
} from "./types";

export interface BeginMediaWriteInput {
  projectId: string | null;
  importSessionId?: string | null;
  sourcePath: string;
  contentType: string;
  sizeBytes: number;
}

export interface MediaWriteSession {
  readonly operationId: string;
  readonly mediaRef: LocalMediaRef;
  write(chunk: Uint8Array): Promise<void>;
  commit(): Promise<LocalMediaRef>;
  abort(cause?: unknown): Promise<void>;
}

export interface MediaRecoveryOptions extends MediaJournalOptions {
  leaseOwner?: string;
}

export interface MediaRecoveryController {
  run(): Promise<number>;
  dispose(): void;
}

type SaveMediaInput = {
  projectId: string;
  sourcePath: string;
  contentType: string;
  blob: Blob;
};

type StorageWithOpfs = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
};

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

const LOCAL_MEDIA_PREFIX = "local://media/";
const OPFS_MEDIA_DIR = "openmontage-media";
const PENDING_WRITE_EXPIRY_MS = 10 * 60 * 1000;
const COMPATIBILITY_ORPHAN_EXPIRY_MS = 24 * 60 * 60 * 1000;
const SAVE_CHUNK_BYTES = 1024 * 1024;

export class MediaCleanupIncompleteError extends Error {
  readonly causes: unknown[];
  readonly pendingMediaIds: string[];

  constructor(message: string, causes: unknown[], pendingMediaIds: string[] = []) {
    super(message);
    this.name = "MediaCleanupIncompleteError";
    this.causes = causes;
    this.pendingMediaIds = pendingMediaIds;
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

function mediaIdFromRef(ref: LocalMediaRef): string {
  return ref.slice(LOCAL_MEDIA_PREFIX.length);
}

function mediaRef(id: string): LocalMediaRef {
  return `${LOCAL_MEDIA_PREFIX}${id}`;
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function storageManager(): StorageWithOpfs | undefined {
  return typeof navigator === "undefined"
    ? undefined
    : navigator.storage as StorageWithOpfs | undefined;
}

function normalizeBlob(blob: Blob, contentType: string): Blob {
  if (!contentType || blob.type === contentType || typeof blob.slice !== "function") return blob;
  return blob.slice(0, blob.size, contentType);
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("Could not read media blob"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

function isUsableBlob(value: unknown): value is Blob {
  return Boolean(value) && typeof value === "object" &&
    typeof (value as Blob).size === "number" && typeof (value as Blob).slice === "function";
}

function concatenateChunks(chunks: Uint8Array[], sizeBytes: number): Uint8Array {
  const bytes = new Uint8Array(sizeBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertExpectedSize(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`Media byte count mismatch: expected ${expected}, received ${actual}`);
  }
}

function hasOwnedActiveLease(
  record: MediaJournalRecord,
  leaseOwner: string,
  now: Date,
): boolean {
  if (record.leaseOwner !== leaseOwner || !record.leaseExpiresAt) return false;
  const expiresAt = Date.parse(record.leaseExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function storedFileSize(file: unknown): number {
  if (
    file && typeof file === "object" && "size" in file &&
    typeof file.size === "number"
  ) {
    return file.size;
  }
  if (ArrayBuffer.isView(file)) return file.byteLength;
  if (file instanceof ArrayBuffer) return file.byteLength;
  throw new Error("Stored media does not expose a verifiable byte count");
}

async function openMediaDirectory(create = false): Promise<FileSystemDirectoryHandle> {
  const storage = storageManager();
  if (!storage?.getDirectory) throw new Error("OPFS is unavailable for media storage");
  const root = await storage.getDirectory();
  return root.getDirectoryHandle(OPFS_MEDIA_DIR, { create });
}

async function removeOpfsPath(path: string): Promise<void> {
  const [directory, fileName, ...extra] = path.split("/");
  if (directory !== OPFS_MEDIA_DIR || !fileName || extra.length > 0) {
    throw new Error("Stored OPFS media path is invalid");
  }
  const mediaDirectory = await openMediaDirectory(false);
  try {
    await mediaDirectory.removeEntry(fileName);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
}

async function readMediaRecord(id: string): Promise<LocalMediaRecord | null> {
  const db = await openLocalDb();
  const value = await requestToPromise<LocalMediaRecord | undefined>(
    db.transaction(LOCAL_STORES.media, "readonly").objectStore(LOCAL_STORES.media).get(id),
  );
  return value ?? null;
}

async function readBlobFromOpfs(record: LocalMediaRecord): Promise<Blob | null> {
  if (!record.opfsPath || !storageManager()?.getDirectory) return null;
  try {
    const [directory, fileName, ...extra] = record.opfsPath.split("/");
    if (directory !== OPFS_MEDIA_DIR || !fileName || extra.length > 0) return null;
    const mediaDirectory = await openMediaDirectory(false);
    const fileHandle = await mediaDirectory.getFileHandle(fileName);
    const stored: unknown = await fileHandle.getFile();
    if (isUsableBlob(stored)) return normalizeBlob(stored, record.contentType);
    if (ArrayBuffer.isView(stored)) {
      const bytes = new Uint8Array(stored.buffer, stored.byteOffset, stored.byteLength);
      return new Blob([bytes.slice().buffer], { type: record.contentType });
    }
    if (stored instanceof ArrayBuffer) return new Blob([stored], { type: record.contentType });
    return null;
  } catch {
    return null;
  }
}

async function commitOpfsMedia(
  operationId: string,
  leaseOwner: string,
  createdAt: string,
): Promise<LocalMediaRecord> {
  const db = await openLocalDb();
  const tx = db.transaction(
    [LOCAL_STORES.projects, LOCAL_STORES.media, LOCAL_STORES.mediaOperations],
    "readwrite",
  );
  return runTransaction(tx, async () => {
    const operationStore = tx.objectStore(LOCAL_STORES.mediaOperations);
    const operation = await requestToPromise<MediaJournalRecord | undefined>(
      operationStore.get(operationId),
    );
    if (
      !operation || operation.kind !== "media_write" || operation.state !== "writing" ||
      !hasOwnedActiveLease(operation, leaseOwner, new Date())
    ) {
      throw new Error(`Media operation ${operationId} no longer holds an active writer lease`);
    }

    let state: "staged" | "committed" = "committed";
    if (operation.importSessionId) {
      const session = await requestToPromise<MediaJournalRecord | undefined>(
        operationStore.get(operation.importSessionId),
      );
      if (!session || session.kind !== "import_session" || session.state !== "importing") {
        throw new Error(`Active import session ${operation.importSessionId} was not found`);
      }
      state = "staged";
      if (!session.mediaIds.includes(operation.mediaId)) {
        operationStore.put({ ...session, mediaIds: [...session.mediaIds, operation.mediaId] });
      }
    } else {
      const project = await requestToPromise(
        tx.objectStore(LOCAL_STORES.projects).get(operation.projectId!),
      );
      if (!project) throw new Error(`Project ${operation.projectId} was not found`);
    }

    const record: LocalMediaRecord = {
      id: operation.mediaId,
      projectId: operation.projectId!,
      sourcePath: operation.sourcePath,
      contentType: operation.contentType,
      sizeBytes: operation.sizeBytes,
      createdAt,
      state,
      importSessionId: operation.importSessionId,
      storage: "opfs",
      opfsPath: operation.opfsPath,
    };
    tx.objectStore(LOCAL_STORES.media).put(record);
    operationStore.delete(operation.id);
    return record;
  });
}

async function commitIndexedDbMedia(
  input: BeginMediaWriteInput,
  id: string,
  createdAt: string,
  bytes: Uint8Array,
): Promise<LocalMediaRecord> {
  const db = await openLocalDb();
  const stores = input.importSessionId
    ? [LOCAL_STORES.media, LOCAL_STORES.mediaOperations]
    : [LOCAL_STORES.projects, LOCAL_STORES.media];
  const tx = db.transaction(stores, "readwrite");
  return runTransaction(tx, async () => {
    let projectId = input.projectId;
    let state: "staged" | "committed" = "committed";
    if (input.importSessionId) {
      const operationStore = tx.objectStore(LOCAL_STORES.mediaOperations);
      const session = await requestToPromise<MediaJournalRecord | undefined>(
        operationStore.get(input.importSessionId),
      );
      if (!session || session.kind !== "import_session" || session.state !== "importing") {
        throw new Error(`Active import session ${input.importSessionId} was not found`);
      }
      if (projectId !== null && projectId !== session.projectId) {
        throw new Error(`Import session ${input.importSessionId} belongs to another project`);
      }
      projectId = session.projectId;
      state = "staged";
      if (!session.mediaIds.includes(id)) {
        operationStore.put({ ...session, mediaIds: [...session.mediaIds, id] });
      }
    } else {
      if (!projectId) throw new Error("A project is required for media writes");
      const project = await requestToPromise(
        tx.objectStore(LOCAL_STORES.projects).get(projectId),
      );
      if (!project) throw new Error(`Project ${projectId} was not found`);
    }

    const stableBytes = bytes.slice().buffer;
    const record: LocalMediaRecord = {
      id,
      projectId: projectId!,
      sourcePath: input.sourcePath,
      contentType: input.contentType || "application/octet-stream",
      sizeBytes: bytes.byteLength,
      createdAt,
      state,
      importSessionId: input.importSessionId ?? null,
      storage: "indexeddb",
      blob: new Blob([stableBytes], { type: input.contentType }),
      blobBytes: stableBytes,
    };
    tx.objectStore(LOCAL_STORES.media).put(record);
    return record;
  });
}

async function validateMediaOwner(input: BeginMediaWriteInput): Promise<void> {
  const db = await openLocalDb();
  if (input.importSessionId) {
    const session = await requestToPromise<MediaJournalRecord | undefined>(
      db.transaction(LOCAL_STORES.mediaOperations, "readonly")
        .objectStore(LOCAL_STORES.mediaOperations)
        .get(input.importSessionId),
    );
    if (!session || session.kind !== "import_session" || session.state !== "importing") {
      throw new Error(`Active import session ${input.importSessionId} was not found`);
    }
    if (input.projectId !== null && input.projectId !== session.projectId) {
      throw new Error(`Import session ${input.importSessionId} belongs to another project`);
    }
    return;
  }
  if (!input.projectId) throw new Error("A project is required for media writes");
  const project = await requestToPromise(
    db.transaction(LOCAL_STORES.projects, "readonly")
      .objectStore(LOCAL_STORES.projects)
      .get(input.projectId),
  );
  if (!project) throw new Error(`Project ${input.projectId} was not found`);
}

async function renewManagedImportSession(input: BeginMediaWriteInput): Promise<void> {
  if (!input.importSessionId) return;
  const db = await openLocalDb();
  const session = await requestToPromise<MediaJournalRecord | undefined>(
    db.transaction(LOCAL_STORES.mediaOperations, "readonly")
      .objectStore(LOCAL_STORES.mediaOperations)
      .get(input.importSessionId),
  );
  if (!session || session.kind !== "import_session" || session.state !== "importing") {
    throw new Error(`Active import session ${input.importSessionId} was not found`);
  }
  if (session.leaseOwner !== session.id) return;
  const renewed = await renewMediaOperationLease(session.id, session.id);
  if (!renewed) throw new Error(`Import session ${session.id} lost its owner lease`);
}

export async function beginMediaWrite(input: BeginMediaWriteInput): Promise<MediaWriteSession> {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new Error("Media sizeBytes must be a non-negative safe integer");
  }
  const id = createId();
  const operationId = createId();
  const ref = mediaRef(id);
  const createdAt = new Date().toISOString();
  const chunks: Uint8Array[] = [];
  let bytesWritten = 0;
  let status: "open" | "committing" | "committed" | "aborting" | "aborted" | "failed" = "open";
  let writeTail: Promise<void> = Promise.resolve();
  let writeFailure: unknown;
  let terminalPromise: Promise<LocalMediaRef> | null = null;
  let abortPromise: Promise<void> | null = null;
  const storage = storageManager();

  await renewManagedImportSession(input);

  function stateError(): Error {
    return new Error(`Media write session is not open (${status})`);
  }

  function enqueueWrite(work: () => Promise<void>): Promise<void> {
    if (status !== "open") return Promise.reject(stateError());
    const task = writeTail.then(async () => {
      if (writeFailure !== undefined) throw writeFailure;
      await work();
    });
    writeTail = task.catch((error) => {
      writeFailure ??= error;
    });
    return task;
  }

  function startCommit(work: () => Promise<LocalMediaRef>): Promise<LocalMediaRef> {
    if (status !== "open") return Promise.reject(stateError());
    status = "committing";
    const task = writeTail.then(async () => {
      if (writeFailure !== undefined) throw writeFailure;
      return work();
    });
    terminalPromise = task.then(
      (result) => {
        status = "committed";
        return result;
      },
      (error) => {
        status = "failed";
        throw error;
      },
    );
    return terminalPromise;
  }

  function startAbort(work: () => Promise<void>): Promise<void> {
    if (status === "committing" || status === "committed") {
      return (terminalPromise ?? Promise.resolve(ref)).then(
        () => undefined,
        () => undefined,
      );
    }
    if (status === "aborting" || status === "aborted") {
      return abortPromise ?? Promise.resolve();
    }
    if (status === "failed") return Promise.resolve();
    status = "aborting";
    abortPromise = writeTail.then(work, work).finally(() => {
      status = "aborted";
    });
    return abortPromise;
  }

  if (!storage?.getDirectory) {
    await validateMediaOwner(input);
    return {
      operationId,
      mediaRef: ref,
      write(chunk) {
        const stableChunk = new Uint8Array(chunk);
        return enqueueWrite(async () => {
          await renewManagedImportSession(input);
          chunks.push(stableChunk);
          bytesWritten += stableChunk.byteLength;
          await renewManagedImportSession(input);
        });
      },
      commit() {
        return startCommit(async () => {
          assertExpectedSize(bytesWritten, input.sizeBytes);
          const bytes = concatenateChunks(chunks, bytesWritten);
          await commitIndexedDbMedia(input, id, createdAt, bytes);
          await renewManagedImportSession(input);
          chunks.length = 0;
          return ref;
        });
      },
      abort() {
        return startAbort(async () => {
          chunks.length = 0;
        });
      },
    };
  }

  const leaseOwner = createId();
  const operation = await createValidatedMediaOperation({
    id: operationId,
    mediaId: id,
    projectId: input.projectId,
    importSessionId: input.importSessionId ?? null,
    sourcePath: input.sourcePath,
    contentType: input.contentType || "application/octet-stream",
    sizeBytes: input.sizeBytes,
    opfsPath: `${OPFS_MEDIA_DIR}/${id}`,
    leaseOwner,
  });

  async function renewWriterLease(): Promise<void> {
    await renewManagedImportSession(input);
    const renewed = await renewMediaOperationLease(operation.id, leaseOwner);
    if (!renewed) throw new Error(`Media operation ${operation.id} lost its writer lease`);
  }

  async function establishDurableCleanup(primary: unknown): Promise<void> {
    const authoritative = primary instanceof MediaCleanupIncompleteError
      ? primary.causes[0]
      : primary;
    let journalError: unknown;
    let removalError: unknown;
    try {
      await ensureMediaOperationCleanupDue(operation);
    } catch (error) {
      journalError = error;
    }
    try {
      await removeOpfsPath(operation.opfsPath);
    } catch (error) {
      removalError = error;
    }
    if (journalError !== undefined) {
      throw new MediaCleanupIncompleteError(
        "Media cleanup could not be durably re-established",
        removalError === undefined
          ? [authoritative, journalError]
          : [authoritative, journalError, removalError],
        [operation.mediaId],
      );
    }
  }

  async function throwAfterDurableCleanup(primary: unknown): Promise<never> {
    await establishDurableCleanup(primary);
    throw primary;
  }

  async function guardWriterMutation<T>(mutation: () => Promise<T>): Promise<T> {
    try {
      await renewWriterLease();
    } catch (error) {
      return throwAfterDurableCleanup(error);
    }
    const result = await mutation();
    try {
      await renewWriterLease();
    } catch (error) {
      return throwAfterDurableCleanup(error);
    }
    return result;
  }

  let fileHandle: FileSystemFileHandle;
  let writable: FileSystemWritableFileStream;
  try {
    const root = await storage.getDirectory();
    const directory = await guardWriterMutation(
      () => root.getDirectoryHandle(OPFS_MEDIA_DIR, { create: true }),
    );
    fileHandle = await guardWriterMutation(
      () => directory.getFileHandle(id, { create: true }),
    );
    writable = await guardWriterMutation(() => fileHandle.createWritable());
  } catch (error) {
    return throwAfterDurableCleanup(error);
  }

  async function fail(error: unknown): Promise<never> {
    await guardWriterMutation(() => writable.close()).catch(() => undefined);
    await establishDurableCleanup(error);
    throw error;
  }

  return {
    operationId,
    mediaRef: ref,
    write(chunk) {
      const stableChunk = new Uint8Array(chunk);
      return enqueueWrite(async () => {
        try {
          await guardWriterMutation(() => writable.write(stableChunk));
          bytesWritten += stableChunk.byteLength;
        } catch (error) {
          return fail(error);
        }
      });
    },
    commit() {
      return startCommit(async () => {
        try {
          assertExpectedSize(bytesWritten, input.sizeBytes);
          await guardWriterMutation(() => writable.close());
          const physicalFile = await fileHandle.getFile();
          assertExpectedSize(storedFileSize(physicalFile), input.sizeBytes);
          await commitOpfsMedia(operation.id, leaseOwner, createdAt);
          await renewManagedImportSession(input);
          return ref;
        } catch (error) {
          return throwAfterDurableCleanup(error);
        }
      });
    },
    abort() {
      return startAbort(async () => {
        const abortCause = new Error(`Media operation ${operation.id} was aborted`);
        await guardWriterMutation(() => writable.close()).catch(() => undefined);
        await establishDurableCleanup(abortCause);
      });
    },
  };
}

export async function saveMediaBlob(input: SaveMediaInput): Promise<LocalMediaRef> {
  const blob = normalizeBlob(input.blob, input.contentType);
  const bytes = new Uint8Array(await blobToArrayBuffer(blob));
  const session = await beginMediaWrite({
    projectId: input.projectId,
    sourcePath: input.sourcePath,
    contentType: blob.type || input.contentType || "application/octet-stream",
    sizeBytes: bytes.byteLength,
  });
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += SAVE_CHUNK_BYTES) {
      await session.write(bytes.subarray(offset, offset + SAVE_CHUNK_BYTES));
    }
    return await session.commit();
  } catch (error) {
    await session.abort(error).catch(() => undefined);
    throw error;
  }
}

export async function loadMediaBlob(ref: LocalMediaRef): Promise<Blob | null> {
  const record = await readMediaRecord(mediaIdFromRef(ref));
  if (!record || record.state === "staged") return null;
  if (record.storage === "opfs") return readBlobFromOpfs(record);
  if (isUsableBlob(record.blob)) return normalizeBlob(record.blob, record.contentType);
  if (record.blobBytes) return new Blob([record.blobBytes], { type: record.contentType });
  return null;
}

export async function findCommittedMedia(
  projectId: string,
  sourcePath: string,
): Promise<LocalMediaRecord | null> {
  const db = await openLocalDb();
  const records = await requestToPromise<LocalMediaRecord[]>(
    db.transaction(LOCAL_STORES.media, "readonly")
      .objectStore(LOCAL_STORES.media)
      .index("projectSource")
      .getAll(IDBKeyRange.only([projectId, sourcePath])),
  );
  return records
    .filter((record) => record.state === undefined || record.state === "committed")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

export async function deleteMediaBlob(ref: LocalMediaRef): Promise<void> {
  const id = mediaIdFromRef(ref);
  const record = await readMediaRecord(id);
  if (!record) return;
  if (record.storage === "opfs" && record.opfsPath) await removeOpfsPath(record.opfsPath);
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.media, "readwrite");
  tx.objectStore(LOCAL_STORES.media).delete(id);
  await transactionDone(tx);
}

function legacyProtectionExpiry(record: LocalMediaPendingRecord, now: Date): string {
  const createdAt = Date.parse(record.createdAt);
  return new Date(
    (Number.isFinite(createdAt) ? createdAt : now.getTime()) + PENDING_WRITE_EXPIRY_MS,
  ).toISOString();
}

async function migrateLegacyPending(options: MediaRecoveryOptions): Promise<void> {
  const db = options.db ?? await openLocalDb();
  const pending = await requestToPromise<LocalMediaPendingRecord[]>(
    db.transaction(LOCAL_STORES.mediaPending, "readonly")
      .objectStore(LOCAL_STORES.mediaPending).getAll(),
  );
  for (const source of pending) {
    const now = options.now?.() ?? new Date();
    const tx = db.transaction(
      [LOCAL_STORES.mediaPending, LOCAL_STORES.mediaOperations],
      "readwrite",
    );
    await runTransaction(tx, async () => {
      const operationStore = tx.objectStore(LOCAL_STORES.mediaOperations);
      const existing = await requestToPromise<MediaJournalRecord | undefined>(
        operationStore.get(source.id),
      );
      if (!existing) {
        const cleanupDue = source.state === "retryable";
        const record: MediaOperationRecord = {
          id: source.id,
          kind: "media_write",
          mediaId: source.id,
          projectId: null,
          importSessionId: null,
          sourcePath: "",
          contentType: "application/octet-stream",
          sizeBytes: 0,
          opfsPath: source.opfsPath,
          state: cleanupDue ? "cleanup_due" : "writing",
          createdAt: source.createdAt,
          updatedAt: now.toISOString(),
          attempts: 0,
          nextAttemptAt: cleanupDue ? now.toISOString() : source.createdAt,
          leaseOwner: cleanupDue ? null : "legacy-v3-writer",
          leaseExpiresAt: cleanupDue ? null : legacyProtectionExpiry(source, now),
        };
        operationStore.put(record);
      }
      tx.objectStore(LOCAL_STORES.mediaPending).delete(source.id);
    });
  }
}

async function readOwnedRecoveryRecord(
  id: string,
  leaseOwner: string,
  options: MediaRecoveryOptions,
): Promise<{ operation: MediaJournalRecord; media: LocalMediaRecord | null } | null> {
  const db = await openLocalDb();
  const tx = db.transaction([LOCAL_STORES.mediaOperations, LOCAL_STORES.media], "readonly");
  const [operation, media] = await Promise.all([
    requestToPromise<MediaJournalRecord | undefined>(
      tx.objectStore(LOCAL_STORES.mediaOperations).get(id),
    ),
    requestToPromise<LocalMediaRecord | undefined>(
      tx.objectStore(LOCAL_STORES.media).get(id),
    ),
  ]);
  const now = options.now?.() ?? new Date();
  if (!operation || operation.state !== "cleanup_due" || !hasOwnedActiveLease(operation, leaseOwner, now)) {
    return null;
  }
  const mediaId = operation.kind === "media_write" ? operation.mediaId : "";
  const exactMedia = mediaId
    ? await requestToPromise<LocalMediaRecord | undefined>(
      db.transaction(LOCAL_STORES.media, "readonly").objectStore(LOCAL_STORES.media).get(mediaId),
    )
    : media;
  return { operation, media: exactMedia ?? null };
}

async function finalizeMediaRecovery(
  operationId: string,
  leaseOwner: string,
  mediaId: string,
  deleteMedia: boolean,
  options: MediaRecoveryOptions,
): Promise<boolean> {
  const db = await openLocalDb();
  const tx = db.transaction([LOCAL_STORES.mediaOperations, LOCAL_STORES.media], "readwrite");
  return runTransaction(tx, async () => {
    const operationStore = tx.objectStore(LOCAL_STORES.mediaOperations);
    const operation = await requestToPromise<MediaJournalRecord | undefined>(
      operationStore.get(operationId),
    );
    const now = options.now?.() ?? new Date();
    if (!operation || operation.state !== "cleanup_due" || !hasOwnedActiveLease(operation, leaseOwner, now)) {
      return false;
    }
    if (deleteMedia) tx.objectStore(LOCAL_STORES.media).delete(mediaId);
    operationStore.delete(operationId);
    return true;
  });
}

async function recoverMediaWrite(
  operation: MediaOperationRecord,
  leaseOwner: string,
  options: MediaRecoveryOptions,
): Promise<void> {
  const renewed = await renewMediaRecoveryLease(operation.id, leaseOwner, options);
  if (!renewed) throw new Error(`Media recovery lease ${operation.id} expired`);
  const current = await readOwnedRecoveryRecord(operation.id, leaseOwner, options);
  if (!current) return;
  if (current.media && current.media.state !== "staged") {
    if (!await finalizeMediaRecovery(operation.id, leaseOwner, operation.mediaId, false, options)) {
      throw new Error(`Media recovery lease ${operation.id} expired before finalization`);
    }
    return;
  }
  await removeOpfsPath(operation.opfsPath);
  if (!await finalizeMediaRecovery(operation.id, leaseOwner, operation.mediaId, true, options)) {
    throw new Error(`Media recovery lease ${operation.id} expired before finalization`);
  }
}

async function recoverImportSession(
  session: MediaImportSessionRecord,
  leaseOwner: string,
  options: MediaRecoveryOptions,
): Promise<void> {
  const db = await openLocalDb();
  for (const mediaId of session.mediaIds) {
    if (!await renewMediaRecoveryLease(session.id, leaseOwner, options)) {
      throw new Error(`Import recovery lease ${session.id} expired`);
    }
    const readTx = db.transaction(
      [LOCAL_STORES.mediaOperations, LOCAL_STORES.media],
      "readonly",
    );
    const [currentSession, currentMedia] = await Promise.all([
      requestToPromise<MediaJournalRecord | undefined>(
        readTx.objectStore(LOCAL_STORES.mediaOperations).get(session.id),
      ),
      requestToPromise<LocalMediaRecord | undefined>(
        readTx.objectStore(LOCAL_STORES.media).get(mediaId),
      ),
    ]);
    const now = options.now?.() ?? new Date();
    if (
      !currentSession || currentSession.kind !== "import_session" ||
      currentSession.state !== "cleanup_due" ||
      !hasOwnedActiveLease(currentSession, leaseOwner, now) ||
      !currentSession.mediaIds.includes(mediaId) ||
      currentMedia?.state !== "staged" || currentMedia.importSessionId !== session.id
    ) {
      continue;
    }
    if (currentMedia.opfsPath) await removeOpfsPath(currentMedia.opfsPath);
  }
  if (!await renewMediaRecoveryLease(session.id, leaseOwner, options)) {
    throw new Error(`Import recovery lease ${session.id} expired before finalization`);
  }
  const tx = db.transaction([LOCAL_STORES.mediaOperations, LOCAL_STORES.media], "readwrite");
  await runTransaction(tx, async () => {
    const operationStore = tx.objectStore(LOCAL_STORES.mediaOperations);
    const current = await requestToPromise<MediaJournalRecord | undefined>(operationStore.get(session.id));
    const now = options.now?.() ?? new Date();
    if (!current || current.state !== "cleanup_due" || !hasOwnedActiveLease(current, leaseOwner, now)) {
      throw new Error(`Import recovery lease ${session.id} expired before finalization`);
    }
    if (current.kind !== "import_session") {
      throw new Error(`Import recovery record ${session.id} changed kind`);
    }
    const mediaStore = tx.objectStore(LOCAL_STORES.media);
    for (const mediaId of current.mediaIds) {
      const record = await requestToPromise<LocalMediaRecord | undefined>(mediaStore.get(mediaId));
      if (record?.state === "staged" && record.importSessionId === current.id) {
        mediaStore.delete(mediaId);
      }
    }
    operationStore.delete(session.id);
  });
}

export async function runMediaRecovery(options: MediaRecoveryOptions = {}): Promise<number> {
  await migrateLegacyPending(options);
  const leaseOwner = options.leaseOwner ?? createId();
  let recovered = 0;
  while (true) {
    const claimed = await claimNextDueMediaOperation(leaseOwner, options);
    if (!claimed) break;
    try {
      if (claimed.kind === "media_write") await recoverMediaWrite(claimed, leaseOwner, options);
      else await recoverImportSession(claimed, leaseOwner, options);
      recovered += 1;
    } catch (error) {
      await recordMediaOperationFailure(claimed.id, leaseOwner, options);
      throw new MediaRecoveryError(claimed.id, error);
    }
  }
  if (storageManager()?.getDirectory) recovered += await cleanupOrphanedOpfsMedia();
  return recovered;
}

async function loadCleanupInventory(): Promise<{
  media: LocalMediaRecord[];
  pending: LocalMediaPendingRecord[];
  operations: MediaJournalRecord[];
}> {
  const db = await openLocalDb();
  const tx = db.transaction(
    [LOCAL_STORES.media, LOCAL_STORES.mediaPending, LOCAL_STORES.mediaOperations],
    "readonly",
  );
  const [media, pending, operations] = await Promise.all([
    requestToPromise<LocalMediaRecord[]>(tx.objectStore(LOCAL_STORES.media).getAll()),
    requestToPromise<LocalMediaPendingRecord[]>(tx.objectStore(LOCAL_STORES.mediaPending).getAll()),
    requestToPromise<MediaJournalRecord[]>(tx.objectStore(LOCAL_STORES.mediaOperations).getAll()),
  ]);
  return { media, pending, operations };
}

function isFreshLegacyWrite(record: LocalMediaPendingRecord | undefined, now: number): boolean {
  if (record?.state !== "writing") return false;
  const createdAt = Date.parse(record.createdAt);
  return Number.isFinite(createdAt) && now - createdAt < PENDING_WRITE_EXPIRY_MS;
}

async function readExactCleanupState(id: string): Promise<{
  media: LocalMediaRecord | null;
  pending: LocalMediaPendingRecord | null;
  operation: MediaJournalRecord | null;
}> {
  const db = await openLocalDb();
  const tx = db.transaction(
    [LOCAL_STORES.media, LOCAL_STORES.mediaPending, LOCAL_STORES.mediaOperations],
    "readonly",
  );
  const [media, pending, operations] = await Promise.all([
    requestToPromise<LocalMediaRecord | undefined>(tx.objectStore(LOCAL_STORES.media).get(id)),
    requestToPromise<LocalMediaPendingRecord | undefined>(
      tx.objectStore(LOCAL_STORES.mediaPending).get(id),
    ),
    requestToPromise<MediaJournalRecord[]>(tx.objectStore(LOCAL_STORES.mediaOperations).getAll()),
  ]);
  return {
    media: media ?? null,
    pending: pending ?? null,
    operation: operations.find((record) =>
      (record.kind === "media_write" && record.mediaId === id) ||
      (record.kind === "import_session" && record.mediaIds.includes(id))) ?? null,
  };
}

export async function cleanupOrphanedOpfsMedia(): Promise<number> {
  const now = Date.now();
  const inventory = await loadCleanupInventory();
  const trackedMedia = new Set(inventory.media
    .filter((record) => record.storage === "opfs")
    .map((record) => record.id));
  const trackedOperations = new Set(inventory.operations.flatMap((record) =>
    record.kind === "media_write" ? [record.mediaId] : record.mediaIds));
  const pendingById = new Map(inventory.pending.map((record) => [record.id, record]));
  const mediaDirectory = await openMediaDirectory(false).catch((error) => {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }) as IterableDirectoryHandle | null;
  if (!mediaDirectory) return 0;
  if (typeof mediaDirectory.entries !== "function") {
    throw new Error("OPFS directory enumeration is unavailable for orphan media cleanup");
  }

  let removed = 0;
  const errors: unknown[] = [];
  for await (const [name, handle] of mediaDirectory.entries()) {
    if (handle.kind !== "file" || trackedMedia.has(name) || trackedOperations.has(name)) continue;
    const pending = pendingById.get(name);
    if (isFreshLegacyWrite(pending, now)) continue;
    try {
      if (!pending) {
        const file = await (await mediaDirectory.getFileHandle(name)).getFile();
        const lastModified = typeof file.lastModified === "number" ? file.lastModified : 0;
        if (now - lastModified < COMPATIBILITY_ORPHAN_EXPIRY_MS) continue;
      }
      const current = await readExactCleanupState(name);
      if (
        current.media?.storage === "opfs" || current.operation ||
        isFreshLegacyWrite(current.pending ?? undefined, Date.now())
      ) {
        continue;
      }
      await mediaDirectory.removeEntry(name);
      if (current.pending) {
        const db = await openLocalDb();
        const tx = db.transaction(LOCAL_STORES.mediaPending, "readwrite");
        tx.objectStore(LOCAL_STORES.mediaPending).delete(name);
        await transactionDone(tx);
      }
      removed += 1;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new MediaCleanupIncompleteError("OPFS orphan media cleanup was incomplete", errors);
  }
  return removed;
}

export function startMediaRecoveryController(
  options: MediaRecoveryOptions = {},
): MediaRecoveryController {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<number> | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = async () => {
    clearTimer();
    if (disposed) return;
    const dueAt = await getNextMediaRecoveryAt(options);
    if (!dueAt || disposed) return;
    const now = options.now?.().getTime() ?? Date.now();
    timer = setTimeout(() => void run().catch(() => undefined), Math.max(0, dueAt.getTime() - now));
  };
  const run = (): Promise<number> => {
    if (disposed) return Promise.resolve(0);
    if (inFlight) return inFlight;
    clearTimer();
    inFlight = runMediaRecovery(options).finally(() => {
      inFlight = null;
      void schedule().catch(() => undefined);
    });
    return inFlight;
  };
  const onVisibilityChange = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      void run().catch(() => undefined);
    }
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  queueMicrotask(() => {
    if (!disposed) void run().catch(() => undefined);
  });

  return {
    run,
    dispose() {
      disposed = true;
      clearTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    },
  };
}

export async function cacheRemoteMedia(
  url: string,
  metadata: { projectId: string; sourcePath: string },
): Promise<LocalMediaRef | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await saveMediaBlob({
      projectId: metadata.projectId,
      sourcePath: metadata.sourcePath,
      contentType: blob.type || response.headers.get("content-type") || "application/octet-stream",
      blob,
    });
  } catch (error) {
    if (error instanceof MediaCleanupIncompleteError) throw error;
    return null;
  }
}
