import {
  BACKUP_MEDIA_MANIFEST_NAME,
  BACKUP_PROJECT_MANIFEST_NAME,
  BackupValidationError,
  assertSafeBackupPath,
  collectLocalMediaRefs,
  parseBackupJson,
  validateBackupManifests,
  validateMediaManifest,
  validateProjectEnvelope,
  type BackupEntryCallbacks,
  type MediaBackupManifest,
  type ValidatedBackup,
  type ValidatedBackupEntry,
} from "./backupFormat";

export type BackupWorkerRequest =
  | { type: "start"; requestId: string; file: File }
  | { type: "ack"; requestId: string; sequence: number }
  | { type: "cancel"; requestId: string };

export type BackupWorkerResponse =
  | { type: "progress"; requestId: string; compressedBytes: number; entries: number }
  | { type: "entry-start"; requestId: string; name: string; contentLength: number | null }
  | {
    type: "entry-chunk";
    requestId: string;
    name: string;
    sequence: number;
    chunk: ArrayBuffer;
  }
  | { type: "entry-end"; requestId: string; name: string; actualBytes: number }
  | { type: "complete"; requestId: string }
  | { type: "failure"; requestId: string; code: string; message: string };

export class BackupWorkerUnavailableError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BackupWorkerUnavailableError";
    this.cause = options?.cause;
  }
}

export class BackupWorkerProtocolError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BackupWorkerProtocolError";
    this.cause = options?.cause;
  }
}

const WORKER_IDLE_TIMEOUT_MS = 15_000;
const MAX_QUEUED_WORKER_RESPONSES = 16;

type ActiveEntry = {
  name: string;
  contentLength: number | null;
  actualBytes: number;
  entry: ValidatedBackupEntry | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer ||
    Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function validateResponse(value: unknown): BackupWorkerResponse {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.requestId !== "string") {
    throw new BackupWorkerProtocolError("Backup Worker sent a malformed response");
  }
  switch (value.type) {
    case "progress":
      if (
        !hasOnlyKeys(value, ["type", "requestId", "compressedBytes", "entries"]) ||
        !isNonNegativeSafeInteger(value.compressedBytes) ||
        !isNonNegativeSafeInteger(value.entries)
      ) break;
      return value as BackupWorkerResponse;
    case "entry-start":
      if (
        !hasOnlyKeys(value, ["type", "requestId", "name", "contentLength"]) ||
        typeof value.name !== "string" ||
        !(value.contentLength === null || isNonNegativeSafeInteger(value.contentLength))
      ) break;
      return value as BackupWorkerResponse;
    case "entry-chunk":
      if (
        !hasOnlyKeys(value, ["type", "requestId", "name", "sequence", "chunk"]) ||
        typeof value.name !== "string" ||
        !isNonNegativeSafeInteger(value.sequence) ||
        !isArrayBuffer(value.chunk)
      ) break;
      return value as BackupWorkerResponse;
    case "entry-end":
      if (
        !hasOnlyKeys(value, ["type", "requestId", "name", "actualBytes"]) ||
        typeof value.name !== "string" ||
        !isNonNegativeSafeInteger(value.actualBytes)
      ) break;
      return value as BackupWorkerResponse;
    case "complete":
      if (!hasOnlyKeys(value, ["type", "requestId"])) break;
      return value as BackupWorkerResponse;
    case "failure":
      if (
        !hasOnlyKeys(value, ["type", "requestId", "code", "message"]) ||
        typeof value.code !== "string" || value.code.length === 0 ||
        typeof value.message !== "string" || value.message.length === 0
      ) break;
      return value as BackupWorkerResponse;
  }
  const keys = isRecord(value) ? Object.keys(value).join(",") : typeof value;
  throw new BackupWorkerProtocolError(
    `Backup Worker sent a malformed ${String(isRecord(value) ? value.type : "response")} response (${keys})`,
  );
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function unavailable(message: string, cause?: unknown): BackupWorkerUnavailableError {
  return new BackupWorkerUnavailableError(message, { cause });
}

function protocol(message: string, cause?: unknown): BackupWorkerProtocolError {
  return new BackupWorkerProtocolError(message, { cause });
}

export function readBackupArchive(
  file: File,
  callbacks: BackupEntryCallbacks,
  signal?: AbortSignal,
): Promise<ValidatedBackup> {
  if (signal?.aborted) return Promise.reject(abortError());

  let worker: Worker;
  try {
    worker = new Worker(new URL("./backupImport.worker.ts", import.meta.url), { type: "module" });
  } catch (error) {
    return Promise.reject(unavailable("Backup module Worker is unavailable", error));
  }

  const requestId = createRequestId();
  return new Promise<ValidatedBackup>((resolve, reject) => {
    let settled = false;
    let started = false;
    let activeEntry: ActiveEntry | null = null;
    let nextSequence = 0;
    let lastCompressedBytes = 0;
    let lastEntryCount = 0;
    let projectValue: unknown;
    let project: ValidatedBackup["project"] | null = null;
    let mediaManifestValue: unknown | undefined;
    let mediaManifest: MediaBackupManifest | null = null;
    const entries: ValidatedBackupEntry[] = [];
    const seenEntries = new Set<string>();
    let tail = Promise.resolve();
    let queuedResponses = 0;
    let outstandingChunk: { name: string; sequence: number } | null = null;
    let timeoutId: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = (result: ValidatedBackup) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const timeoutFailure = () => fail(started
      ? protocol("Backup Worker became idle before completing")
      : unavailable("Backup module Worker did not start"));
    const armTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(timeoutFailure, WORKER_IDLE_TIMEOUT_MS);
    };
    const checkedCallback = async (callback: (() => void | Promise<void>) | undefined) => {
      if (signal?.aborted) throw abortError();
      await callback?.();
      if (signal?.aborted) throw abortError();
      if (settled) throw protocol("Backup Worker protocol ended during a consumer callback");
    };
    const makeEntry = (name: string, sizeBytes: number): ValidatedBackupEntry => {
      if (name === BACKUP_PROJECT_MANIFEST_NAME) {
        if (!project) throw protocol("Project manifest metadata is not available");
        return { name, kind: "project-manifest", sizeBytes, projectId: project.project.id, project };
      }
      if (name === BACKUP_MEDIA_MANIFEST_NAME) {
        if (!project || !mediaManifest) throw protocol("Media manifest metadata is not available");
        return {
          name,
          kind: "media-manifest",
          sizeBytes,
          projectId: project.project.id,
          mediaManifest,
        };
      }
      if (!project || !mediaManifest) {
        throw protocol("Backup Worker streamed media before validated manifests");
      }
      const media = mediaManifest.media.find((candidate) => candidate.file === name);
      if (!media) throw protocol(`Backup Worker streamed undeclared entry ${name}`);
      return { name, kind: "media", sizeBytes, projectId: project.project.id, media };
    };
    const decodeManifestEntry = (entry: ActiveEntry, bytes: Uint8Array): ValidatedBackupEntry => {
      if (entry.name === BACKUP_PROJECT_MANIFEST_NAME) {
        projectValue = parseBackupJson(bytes, entry.name);
        project = validateProjectEnvelope(projectValue);
      } else if (entry.name === BACKUP_MEDIA_MANIFEST_NAME) {
        if (!project) throw protocol("Backup Worker streamed the media manifest first");
        mediaManifestValue = parseBackupJson(bytes, entry.name);
        mediaManifest = validateMediaManifest(mediaManifestValue, collectLocalMediaRefs(project));
      } else {
        throw protocol("Backup Worker sent media without validated entry metadata");
      }
      return makeEntry(entry.name, bytes.byteLength);
    };

    const handle = async (raw: unknown) => {
      const message = validateResponse(raw);
      if (message.requestId !== requestId) {
        throw protocol("Backup Worker response has the wrong request ID");
      }
      started = true;
      switch (message.type) {
        case "progress": {
          if (
            message.compressedBytes < lastCompressedBytes ||
            message.entries < lastEntryCount ||
            message.compressedBytes > file.size
          ) {
            throw protocol("Backup Worker progress moved backwards or exceeded the archive");
          }
          lastCompressedBytes = message.compressedBytes;
          lastEntryCount = message.entries;
          await checkedCallback(() => callbacks.onProgress?.({
            bytesRead: message.compressedBytes,
            totalBytes: file.size,
            entriesRead: message.entries,
            totalEntries: message.entries,
          }));
          return;
        }
        case "entry-start": {
          if (activeEntry || seenEntries.has(message.name)) {
            throw protocol("Backup Worker started an overlapping or duplicate entry");
          }
          try {
            assertSafeBackupPath(message.name);
          } catch (error) {
            throw protocol("Backup Worker sent an unsafe entry name", error);
          }
          seenEntries.add(message.name);
          activeEntry = {
            name: message.name,
            contentLength: message.contentLength,
            actualBytes: 0,
            entry: null,
          };
          if (
            message.name !== BACKUP_PROJECT_MANIFEST_NAME &&
            message.name !== BACKUP_MEDIA_MANIFEST_NAME
          ) {
            if (message.contentLength === null) {
              throw protocol("Backup Worker omitted a media content length");
            }
            activeEntry.entry = makeEntry(message.name, message.contentLength);
            entries.push(activeEntry.entry);
            await checkedCallback(() => callbacks.onEntryStart?.(activeEntry!.entry!));
          }
          return;
        }
        case "entry-chunk": {
          const current = activeEntry;
          const pending = outstandingChunk;
          if (
            !pending || pending.name !== message.name || pending.sequence !== message.sequence ||
            !current || current.name !== message.name || message.sequence !== nextSequence
          ) {
            throw protocol("Backup Worker sent an out-of-order entry chunk");
          }
          const chunk = new Uint8Array(message.chunk);
          if (chunk.byteLength === 0) throw protocol("Backup Worker sent an empty entry chunk");
          current.actualBytes += chunk.byteLength;
          if (
            !Number.isSafeInteger(current.actualBytes) ||
            (current.contentLength !== null && current.actualBytes > current.contentLength)
          ) {
            throw protocol("Backup Worker entry bytes exceeded its content length");
          }
          if (!current.entry) {
            if (current.contentLength !== chunk.byteLength || current.actualBytes !== chunk.byteLength) {
              throw protocol("Backup Worker split a bounded manifest across chunks");
            }
            current.entry = decodeManifestEntry(current, chunk);
            entries.push(current.entry);
            await checkedCallback(() => callbacks.onEntryStart?.(current.entry!));
          }
          await checkedCallback(() => callbacks.onEntryChunk?.(current.entry!, chunk));
          try {
            worker.postMessage({ type: "ack", requestId, sequence: message.sequence });
          } catch (error) {
            throw protocol("Backup Worker chunk ACK could not be posted", error);
          }
          if (
            !outstandingChunk || outstandingChunk.name !== message.name ||
            outstandingChunk.sequence !== message.sequence
          ) {
            throw protocol("Backup Worker chunk ACK state was corrupted");
          }
          outstandingChunk = null;
          nextSequence += 1;
          return;
        }
        case "entry-end": {
          const current = activeEntry;
          if (
            !current || !current.entry || current.name !== message.name ||
            message.actualBytes !== current.actualBytes ||
            (current.contentLength !== null && message.actualBytes !== current.contentLength)
          ) {
            throw protocol("Backup Worker ended an entry with invalid byte counts");
          }
          await checkedCallback(() => callbacks.onEntryEnd?.(current.entry!, message.actualBytes));
          activeEntry = null;
          return;
        }
        case "failure":
          throw message.code === "validation"
            ? new BackupValidationError(message.message)
            : protocol(message.message);
        case "complete": {
          if (activeEntry || !project || projectValue === undefined) {
            throw protocol("Backup Worker completed before all required entries");
          }
          if (lastCompressedBytes !== file.size || lastEntryCount !== entries.length) {
            throw protocol("Backup Worker completed without final archive progress");
          }
          const validated = validateBackupManifests(
            projectValue,
            mediaManifestValue,
            entries.map((entry) => entry.name),
          );
          const result: ValidatedBackup = {
            project: validated.project,
            mediaManifest: validated.mediaManifest,
            entries,
          };
          await checkedCallback(() => callbacks.onComplete?.(result));
          finish(result);
        }
      }
    };

    const onAbort = () => {
      if (settled) return;
      try {
        worker.postMessage({ type: "cancel", requestId });
      } finally {
        fail(abortError());
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (settled) return;
      let message: BackupWorkerResponse;
      try {
        message = validateResponse(event.data);
        if (message.requestId !== requestId) {
          throw protocol("Backup Worker response has the wrong request ID");
        }
        if (outstandingChunk) {
          throw protocol("Backup Worker responded before its retained chunk was acknowledged");
        }
        if (queuedResponses >= MAX_QUEUED_WORKER_RESPONSES) {
          throw protocol("Backup Worker response queue exceeded its bound");
        }
        if (message.type === "entry-chunk") {
          outstandingChunk = { name: message.name, sequence: message.sequence };
        }
      } catch (error) {
        fail(error);
        return;
      }
      started = true;
      queuedResponses += 1;
      clearTimeout(timeoutId);
      tail = tail.then(async () => {
        queuedResponses -= 1;
        await handle(message);
        if (!settled && queuedResponses === 0) armTimeout();
      }).catch(fail);
    };
    worker.onmessageerror = (event) => fail(started
      ? protocol("Backup Worker response could not be deserialized", event)
      : unavailable("Backup module Worker could not start", event));
    worker.onerror = (event) => fail(started
      ? protocol("Backup Worker terminated unexpectedly", event)
      : unavailable("Backup module Worker could not start", event));
    armTimeout();
    try {
      worker.postMessage({ type: "start", requestId, file });
    } catch (error) {
      fail(unavailable("Backup module Worker could not start", error));
    }
  });
}
