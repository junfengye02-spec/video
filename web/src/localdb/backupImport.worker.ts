import { Unzip, UnzipInflate, type UnzipFile } from "fflate";
import {
  BACKUP_LIMITS,
  BACKUP_MEDIA_MANIFEST_NAME,
  BACKUP_PROJECT_MANIFEST_NAME,
  BackupByteAccount,
  BackupValidationError,
  parseBackupJson,
  validateBackupManifests,
  type MediaBackupManifest,
} from "./backupFormat";
import type { BackupWorkerRequest, BackupWorkerResponse } from "./backupArchiveClient";

const ARCHIVE_READ_CHUNK_BYTES = 64 * 1024;

export type BackupImportWorkerScope = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<BackupWorkerRequest>) => void,
  ): void;
  postMessage(message: BackupWorkerResponse, transfer?: Transferable[]): void;
};

type PendingAck = {
  sequence: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type RequestState = {
  requestId: string;
  cancelled: boolean;
  sequence: number;
  pendingAck: PendingAck | null;
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "cancel"> | null;
  activeFiles: Set<UnzipFile>;
};

type InventoryEntry = {
  name: string;
  contentLength: number | null;
};

type PreflightResult = {
  projectManifest: Uint8Array;
  mediaManifest: Uint8Array | null;
  media: MediaBackupManifest;
  inventory: InventoryEntry[];
};

type OutputEvent =
  | { type: "start"; name: string; contentLength: number | null }
  | { type: "chunk"; name: string; chunk: Uint8Array }
  | { type: "end"; name: string; actualBytes: number };

class RequestCancelledError extends Error {}
class WorkerRequestProtocolError extends Error {}

const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_END_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFile(value: unknown): value is File {
  return isRecord(value) && typeof value.size === "number" &&
    typeof (value as unknown as Blob).slice === "function";
}

function asValidationError(error: unknown): BackupValidationError {
  if (error instanceof BackupValidationError) return error;
  const message = error instanceof Error ? error.message : "Backup archive is invalid";
  return new BackupValidationError(message || "Backup archive is invalid", { cause: error });
}

function throwIfCancelled(state: RequestState): void {
  if (state.cancelled) throw new RequestCancelledError();
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read backup archive"));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("Could not read backup archive"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blobToArrayBuffer(blob));
}

async function readCentralDirectory(file: File): Promise<Map<string, number>> {
  const tailStart = Math.max(0, file.size - ZIP_END_MIN_BYTES - ZIP_MAX_COMMENT_BYTES);
  const tail = await readBlobBytes(file.slice(tailStart));
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let endOffset = -1;
  for (let offset = tail.byteLength - ZIP_END_MIN_BYTES; offset >= 0; offset -= 1) {
    if (tailView.getUint32(offset, true) === ZIP_END_SIGNATURE) {
      const commentLength = tailView.getUint16(offset + 20, true);
      if (offset + ZIP_END_MIN_BYTES + commentLength === tail.byteLength) {
        endOffset = offset;
        break;
      }
    }
  }
  if (endOffset < 0) throw new BackupValidationError("Backup ZIP end record is missing");
  const diskNumber = tailView.getUint16(endOffset + 4, true);
  const centralDisk = tailView.getUint16(endOffset + 6, true);
  const entriesOnDisk = tailView.getUint16(endOffset + 8, true);
  const entryCount = tailView.getUint16(endOffset + 10, true);
  const centralBytes = tailView.getUint32(endOffset + 12, true);
  const centralOffset = tailView.getUint32(endOffset + 16, true);
  if (
    diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount ||
    entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff
  ) {
    throw new BackupValidationError("Multi-disk and ZIP64 backups are unsupported");
  }
  if (
    entryCount > BACKUP_LIMITS.maxEntries ||
    centralOffset + centralBytes > tailStart + endOffset
  ) {
    throw new BackupValidationError("Backup central directory is outside the archive limits");
  }

  const central = await readBlobBytes(file.slice(centralOffset, centralOffset + centralBytes));
  if (central.byteLength !== centralBytes) {
    throw new BackupValidationError("Backup central directory is truncated");
  }
  const view = new DataView(central.buffer, central.byteOffset, central.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const sizes = new Map<string, number>();
  let offset = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > central.byteLength || view.getUint32(offset, true) !== ZIP_CENTRAL_FILE_SIGNATURE) {
      throw new BackupValidationError("Backup central directory entry is malformed");
    }
    const sizeBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (sizeBytes === 0xffffffff || nextOffset > central.byteLength) {
      throw new BackupValidationError("ZIP64 or truncated backup entries are unsupported");
    }
    let name: string;
    try {
      name = decoder.decode(central.subarray(offset + 46, offset + 46 + nameLength));
    } catch (error) {
      throw new BackupValidationError("Backup central directory contains an invalid entry name", {
        cause: error,
      });
    }
    if (sizes.has(name)) throw new BackupValidationError(`Backup contains duplicate entry ${name}`);
    sizes.set(name, sizeBytes);
    offset = nextOffset;
  }
  if (offset !== central.byteLength) {
    throw new BackupValidationError("Backup central directory has trailing records");
  }
  return sizes;
}

async function visitArchiveChunks(
  file: File,
  state: RequestState,
  onChunk: (chunk: Uint8Array, final: boolean, bytesRead: number) => void | Promise<void>,
): Promise<void> {
  let offset = 0;
  while (offset < file.size) {
    throwIfCancelled(state);
    const blob = file.slice(offset, offset + ARCHIVE_READ_CHUNK_BYTES);
    const chunk = new Uint8Array(await blobToArrayBuffer(blob));
    throwIfCancelled(state);
    if (chunk.byteLength === 0) {
      throw new BackupValidationError("Backup archive ended before its declared compressed size");
    }
    offset += chunk.byteLength;
    await onChunk(chunk, offset === file.size, offset);
  }
  if (file.size === 0) await onChunk(new Uint8Array(0), true, 0);
}

function terminateState(state: RequestState, reason?: unknown): void {
  if (state.cancelled) return;
  state.cancelled = true;
  void state.reader?.cancel(reason).catch(() => undefined);
  state.reader = null;
  for (const file of state.activeFiles) {
    try {
      file.terminate();
    } catch {
      // Preserve the original cancellation or decoder failure.
    }
  }
  state.activeFiles.clear();
  state.pendingAck?.reject(reason ?? new RequestCancelledError());
  state.pendingAck = null;
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function preflightArchive(
  scope: BackupImportWorkerScope,
  file: File,
  state: RequestState,
): Promise<PreflightResult> {
  const account = new BackupByteAccount();
  const inventory: InventoryEntry[] = [];
  const manifestChunks = new Map<string, Uint8Array[]>();
  const manifestSizes = new Map<string, number>();
  let decoderFailure: unknown;
  let pendingManifests = 0;
  const unzip = new Unzip((entry) => {
    if (decoderFailure || state.cancelled) return;
    try {
      const declared = entry.originalSize === undefined ? null : entry.originalSize;
      account.registerEntry(entry.name, declared);
      inventory.push({ name: entry.name, contentLength: declared });
      if (
        entry.name !== BACKUP_PROJECT_MANIFEST_NAME &&
        entry.name !== BACKUP_MEDIA_MANIFEST_NAME
      ) return;

      const chunks: Uint8Array[] = [];
      let size = 0;
      manifestChunks.set(entry.name, chunks);
      pendingManifests += 1;
      state.activeFiles.add(entry);
      entry.ondata = (error, data, final) => {
        if (decoderFailure || state.cancelled) return;
        try {
          if (error) throw error;
          account.addActualBytes(entry.name, data.byteLength);
          if (data.byteLength > 0) {
            const stable = data.slice();
            chunks.push(stable);
            size += stable.byteLength;
          }
          if (final) {
            account.finishEntry(entry.name);
            manifestSizes.set(entry.name, size);
            pendingManifests -= 1;
            state.activeFiles.delete(entry);
          }
        } catch (error_) {
          decoderFailure = error_;
          try { entry.terminate(); } catch { /* preserve decoder failure */ }
          state.activeFiles.delete(entry);
        }
      };
      entry.start();
    } catch (error) {
      decoderFailure = error;
    }
  });
  unzip.register(UnzipInflate);

  try {
    await visitArchiveChunks(file, state, (chunk, final, bytesRead) => {
      if (decoderFailure) throw decoderFailure;
      unzip.push(chunk, final);
      if (decoderFailure) throw decoderFailure;
      scope.postMessage({
        type: "progress",
        requestId: state.requestId,
        compressedBytes: bytesRead,
        entries: inventory.length,
      });
    });
  } catch (error) {
    for (const entry of state.activeFiles) {
      try { entry.terminate(); } catch { /* preserve read failure */ }
    }
    state.activeFiles.clear();
    throw asValidationError(error);
  }
  if (decoderFailure) throw asValidationError(decoderFailure);
  if (pendingManifests !== 0) {
    throw new BackupValidationError("Backup archive ended before a manifest completed");
  }

  const projectChunks = manifestChunks.get(BACKUP_PROJECT_MANIFEST_NAME);
  const projectSize = manifestSizes.get(BACKUP_PROJECT_MANIFEST_NAME);
  if (!projectChunks || projectSize === undefined) {
    throw new BackupValidationError(`Backup is missing ${BACKUP_PROJECT_MANIFEST_NAME}`);
  }
  const projectManifest = concatChunks(projectChunks, projectSize);
  const mediaChunks = manifestChunks.get(BACKUP_MEDIA_MANIFEST_NAME);
  const mediaSize = manifestSizes.get(BACKUP_MEDIA_MANIFEST_NAME);
  const mediaManifest = mediaChunks && mediaSize !== undefined
    ? concatChunks(mediaChunks, mediaSize)
    : null;
  const centralSizes = await readCentralDirectory(file);
  if (
    centralSizes.size !== inventory.length ||
    inventory.some((entry) => !centralSizes.has(entry.name))
  ) {
    throw new BackupValidationError("Backup local headers and central directory do not match");
  }
  const declaredAccount = new BackupByteAccount();
  for (const entry of inventory) {
    entry.contentLength = centralSizes.get(entry.name)!;
    declaredAccount.registerEntry(entry.name, entry.contentLength);
  }
  declaredAccount.addActualBytes(BACKUP_PROJECT_MANIFEST_NAME, projectManifest.byteLength);
  declaredAccount.finishEntry(BACKUP_PROJECT_MANIFEST_NAME, true);
  if (mediaManifest) {
    declaredAccount.addActualBytes(BACKUP_MEDIA_MANIFEST_NAME, mediaManifest.byteLength);
    declaredAccount.finishEntry(BACKUP_MEDIA_MANIFEST_NAME, true);
  }
  const validated = validateBackupManifests(
    parseBackupJson(projectManifest, BACKUP_PROJECT_MANIFEST_NAME),
    mediaManifest ? parseBackupJson(mediaManifest, BACKUP_MEDIA_MANIFEST_NAME) : undefined,
    inventory.map((entry) => entry.name),
  );
  return {
    projectManifest,
    mediaManifest,
    media: validated.mediaManifest,
    inventory,
  };
}

async function sendChunk(
  scope: BackupImportWorkerScope,
  state: RequestState,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  throwIfCancelled(state);
  const sequence = state.sequence;
  const chunk = bytes.slice().buffer as ArrayBuffer;
  const acknowledged = new Promise<void>((resolve, reject) => {
    state.pendingAck = { sequence, resolve, reject };
  });
  scope.postMessage({
    type: "entry-chunk",
    requestId: state.requestId,
    name,
    sequence,
    chunk,
  }, [chunk]);
  await acknowledged;
  throwIfCancelled(state);
  state.sequence += 1;
}

async function sendBufferedEntry(
  scope: BackupImportWorkerScope,
  state: RequestState,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  scope.postMessage({
    type: "entry-start",
    requestId: state.requestId,
    name,
    contentLength: bytes.byteLength,
  });
  if (bytes.byteLength > 0) await sendChunk(scope, state, name, bytes);
  scope.postMessage({
    type: "entry-end",
    requestId: state.requestId,
    name,
    actualBytes: bytes.byteLength,
  });
}

async function streamMediaPass(
  scope: BackupImportWorkerScope,
  file: File,
  preflight: PreflightResult,
  state: RequestState,
): Promise<void> {
  const declaredMedia = new Map(preflight.media.media.map((entry) => [entry.file, entry]));
  const inventoryByName = new Map(preflight.inventory.map((entry) => [entry.name, entry]));
  const seen = new Set<string>();
  const account = new BackupByteAccount();
  for (const entry of preflight.inventory) account.registerEntry(entry.name, entry.contentLength);
  account.addActualBytes(BACKUP_PROJECT_MANIFEST_NAME, preflight.projectManifest.byteLength);
  account.finishEntry(BACKUP_PROJECT_MANIFEST_NAME);
  if (preflight.mediaManifest) {
    account.addActualBytes(BACKUP_MEDIA_MANIFEST_NAME, preflight.mediaManifest.byteLength);
    account.finishEntry(BACKUP_MEDIA_MANIFEST_NAME);
  }

  const outputQueue: OutputEvent[] = [];
  let decoderFailure: unknown;
  let pendingMedia = 0;
  const unzip = new Unzip((entry) => {
    if (decoderFailure || state.cancelled || !declaredMedia.has(entry.name)) return;
    try {
      if (seen.has(entry.name)) throw new BackupValidationError(`Backup contains duplicate entry ${entry.name}`);
      seen.add(entry.name);
      const inventoryEntry = inventoryByName.get(entry.name);
      const contentLength = inventoryEntry?.contentLength ?? null;
      if (contentLength === null) {
        throw new BackupValidationError(`Backup media entry ${entry.name} has no declared size`);
      }
      outputQueue.push({ type: "start", name: entry.name, contentLength });
      pendingMedia += 1;
      state.activeFiles.add(entry);
      entry.ondata = (error, data, final) => {
        if (decoderFailure || state.cancelled) return;
        try {
          if (error) throw error;
          account.addActualBytes(entry.name, data.byteLength);
          if (data.byteLength > 0) {
            outputQueue.push({ type: "chunk", name: entry.name, chunk: data.slice() });
          }
          if (final) {
            const actualBytes = account.finishEntry(entry.name, true);
            outputQueue.push({ type: "end", name: entry.name, actualBytes });
            pendingMedia -= 1;
            state.activeFiles.delete(entry);
          }
        } catch (error_) {
          decoderFailure = error_;
          try { entry.terminate(); } catch { /* preserve decoder failure */ }
          state.activeFiles.delete(entry);
        }
      };
      entry.start();
    } catch (error) {
      decoderFailure = error;
    }
  });
  unzip.register(UnzipInflate);

  const drainOutput = async () => {
    while (outputQueue.length > 0) {
      throwIfCancelled(state);
      const output = outputQueue.shift()!;
      if (output.type === "start") {
        scope.postMessage({
          type: "entry-start",
          requestId: state.requestId,
          name: output.name,
          contentLength: output.contentLength,
        });
      } else if (output.type === "chunk") {
        await sendChunk(scope, state, output.name, output.chunk);
      } else {
        scope.postMessage({
          type: "entry-end",
          requestId: state.requestId,
          name: output.name,
          actualBytes: output.actualBytes,
        });
      }
    }
  };

  try {
    await visitArchiveChunks(file, state, async (chunk, final) => {
      if (decoderFailure) throw decoderFailure;
      unzip.push(chunk, final);
      if (decoderFailure) throw decoderFailure;
      await drainOutput();
    });
    await drainOutput();
  } catch (error) {
    for (const entry of state.activeFiles) {
      try { entry.terminate(); } catch { /* preserve decoder failure */ }
    }
    state.activeFiles.clear();
    throw asValidationError(error);
  }
  if (decoderFailure) throw asValidationError(decoderFailure);
  if (pendingMedia !== 0 || seen.size !== declaredMedia.size) {
    const missing = [...declaredMedia.keys()].find((name) => !seen.has(name));
    throw new BackupValidationError(
      missing ? `Backup is missing required media file ${missing}` : "Backup media did not complete",
    );
  }
}

async function runRequest(
  scope: BackupImportWorkerScope,
  file: File,
  state: RequestState,
): Promise<void> {
  if (!Number.isSafeInteger(file.size) || file.size > BACKUP_LIMITS.maxArchiveBytes) {
    throw new BackupValidationError("Backup archive exceeds the compressed size limit");
  }
  scope.postMessage({
    type: "progress",
    requestId: state.requestId,
    compressedBytes: 0,
    entries: 0,
  });
  const preflight = await preflightArchive(scope, file, state);
  throwIfCancelled(state);
  await sendBufferedEntry(
    scope,
    state,
    BACKUP_PROJECT_MANIFEST_NAME,
    preflight.projectManifest,
  );
  if (preflight.mediaManifest) {
    await sendBufferedEntry(
      scope,
      state,
      BACKUP_MEDIA_MANIFEST_NAME,
      preflight.mediaManifest,
    );
  }
  await streamMediaPass(scope, file, preflight, state);
  throwIfCancelled(state);
  scope.postMessage({ type: "complete", requestId: state.requestId });
}

export function installBackupImportWorker(scope: BackupImportWorkerScope): void {
  const requests = new Map<string, RequestState>();
  scope.addEventListener("message", (event) => {
    const message = event.data;
    if (!isRecord(message) || typeof message.type !== "string" || typeof message.requestId !== "string") {
      return;
    }
    if (message.type === "ack") {
      const state = requests.get(message.requestId);
      if (!state || !Number.isSafeInteger(message.sequence)) return;
      const pending = state.pendingAck;
      if (!pending || pending.sequence !== message.sequence) {
        terminateState(state, new WorkerRequestProtocolError("Backup chunk ACK was out of order"));
        return;
      }
      state.pendingAck = null;
      pending.resolve();
      return;
    }
    if (message.type === "cancel") {
      const state = requests.get(message.requestId);
      if (state) terminateState(state, new RequestCancelledError());
      return;
    }
    if (message.type !== "start" || !isFile(message.file) || requests.has(message.requestId)) return;

    const state: RequestState = {
      requestId: message.requestId,
      cancelled: false,
      sequence: 0,
      pendingAck: null,
      reader: null,
      activeFiles: new Set(),
    };
    requests.set(message.requestId, state);
    void runRequest(scope, message.file, state).catch((error: unknown) => {
      if (error instanceof RequestCancelledError) return;
      const normalized = error instanceof WorkerRequestProtocolError ? error : asValidationError(error);
      scope.postMessage({
        type: "failure",
        requestId: state.requestId,
        code: normalized instanceof BackupValidationError ? "validation" : "protocol",
        message: normalized.message,
      });
    }).finally(() => {
      terminateState(state);
      requests.delete(state.requestId);
    });
  });
}

const workerScope = globalThis as unknown as BackupImportWorkerScope & { document?: unknown };
if (typeof workerScope.postMessage === "function" && typeof workerScope.document === "undefined") {
  installBackupImportWorker(workerScope);
}
