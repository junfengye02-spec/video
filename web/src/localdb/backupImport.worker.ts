import { Inflate } from "fflate";
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
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_CENTRAL_FILE_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_END_MIN_BYTES = 22;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const ZIP_SUPPORTED_FLAGS = ZIP_DATA_DESCRIPTOR_FLAG | ZIP_UTF8_FLAG;

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
};

type IndexedEntry = {
  name: string;
  rawName: Uint8Array;
  flags: number;
  method: 0 | 8;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  payloadOffset: number;
  endOffset: number;
};

type ArchiveIndex = {
  entries: IndexedEntry[];
  byName: Map<string, IndexedEntry>;
  account: BackupByteAccount;
};

type PreflightResult = ArchiveIndex & {
  projectManifest: Uint8Array;
  mediaManifest: Uint8Array | null;
  media: MediaBackupManifest;
};

class RequestCancelledError extends Error {}
class WorkerRequestProtocolError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
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

async function readExact(
  file: File,
  start: number,
  length: number,
  label: string,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(start) || start < 0 ||
    !Number.isSafeInteger(length) || length < 0 ||
    start + length > file.size
  ) {
    throw new BackupValidationError(`Backup ${label} is outside the archive bounds`);
  }
  const bytes = new Uint8Array(await blobToArrayBuffer(file.slice(start, start + length)));
  if (bytes.byteLength !== length) {
    throw new BackupValidationError(`Backup ${label} is truncated`);
  }
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function validateExtra(extra: Uint8Array, label: string): void {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset < extra.byteLength) {
    if (offset + 4 > extra.byteLength) {
      throw new BackupValidationError(`Backup ${label} extra fields are malformed`);
    }
    const id = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    offset += 4;
    if (offset + size > extra.byteLength) {
      throw new BackupValidationError(`Backup ${label} extra fields are truncated`);
    }
    if (id === ZIP64_EXTRA_ID) {
      throw new BackupValidationError("ZIP64 backup entries are unsupported");
    }
    offset += size;
  }
}

function validateFlags(flags: number, name: string): void {
  if ((flags & ZIP_ENCRYPTED_FLAG) !== 0) {
    throw new BackupValidationError(`Encrypted backup entry ${name} is unsupported`);
  }
  if ((flags & ~ZIP_SUPPORTED_FLAGS) !== 0) {
    throw new BackupValidationError(`Backup entry ${name} uses unsupported ZIP flags`);
  }
}

function decodeEntryName(rawName: Uint8Array, flags: number): string {
  if ((flags & ZIP_UTF8_FLAG) === 0 && rawName.some((value) => value > 0x7f)) {
    throw new BackupValidationError("Backup entry names must be ASCII or explicitly UTF-8");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawName);
  } catch (error) {
    throw new BackupValidationError("Backup contains an invalid UTF-8 entry name", { cause: error });
  }
}

async function readEndRecord(file: File): Promise<{
  entryCount: number;
  centralOffset: number;
  centralBytes: number;
  endOffset: number;
}> {
  const endOffset = file.size - ZIP_END_MIN_BYTES;
  const end = await readExact(file, endOffset, ZIP_END_MIN_BYTES, "ZIP end record");
  const view = new DataView(end.buffer, end.byteOffset, end.byteLength);
  if (view.getUint32(0, true) !== ZIP_END_SIGNATURE || view.getUint16(20, true) !== 0) {
    throw new BackupValidationError("Backup ZIP end record or archive comment is unsupported");
  }
  const diskNumber = view.getUint16(4, true);
  const centralDisk = view.getUint16(6, true);
  const entriesOnDisk = view.getUint16(8, true);
  const entryCount = view.getUint16(10, true);
  const centralBytes = view.getUint32(12, true);
  const centralOffset = view.getUint32(16, true);
  if (
    diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount ||
    entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff
  ) {
    throw new BackupValidationError("Multi-disk and ZIP64 backups are unsupported");
  }
  if (entryCount > BACKUP_LIMITS.maxEntries) {
    throw new BackupValidationError("Backup entry count exceeds the archive entry limit");
  }
  if (centralOffset + centralBytes !== endOffset) {
    throw new BackupValidationError("Backup central directory bounds are inconsistent");
  }
  return { entryCount, centralOffset, centralBytes, endOffset };
}

async function readCentralEntries(
  file: File,
  end: Awaited<ReturnType<typeof readEndRecord>>,
): Promise<IndexedEntry[]> {
  const entries: IndexedEntry[] = [];
  const seenNames = new Set<string>();
  let offset = end.centralOffset;
  for (let index = 0; index < end.entryCount; index += 1) {
    const header = await readExact(file, offset, 46, "central directory header");
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint32(0, true) !== ZIP_CENTRAL_FILE_SIGNATURE) {
      throw new BackupValidationError("Backup central directory entry is malformed");
    }
    const flags = view.getUint16(8, true);
    const rawMethod = view.getUint16(10, true);
    const crc32 = view.getUint32(16, true);
    const compressedSize = view.getUint32(20, true);
    const uncompressedSize = view.getUint32(24, true);
    const nameLength = view.getUint16(28, true);
    const extraLength = view.getUint16(30, true);
    const commentLength = view.getUint16(32, true);
    const diskStart = view.getUint16(34, true);
    const localHeaderOffset = view.getUint32(42, true);
    if (
      compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
      diskStart === 0xffff || localHeaderOffset === 0xffffffff
    ) {
      throw new BackupValidationError("ZIP64 backup entries are unsupported");
    }
    if (diskStart !== 0) throw new BackupValidationError("Multi-disk backup entries are unsupported");
    const variableLength = nameLength + extraLength;
    const variable = await readExact(file, offset + 46, variableLength, "central entry metadata");
    const rawName = variable.slice(0, nameLength);
    const extra = variable.subarray(nameLength);
    const name = decodeEntryName(rawName, flags);
    validateFlags(flags, name);
    validateExtra(extra, `central entry ${name}`);
    if (rawMethod !== 0 && rawMethod !== 8) {
      throw new BackupValidationError(`Backup entry ${name} uses unsupported compression method`);
    }
    if (rawMethod === 0 && compressedSize !== uncompressedSize) {
      throw new BackupValidationError(`Stored backup entry ${name} has inconsistent sizes`);
    }
    if (seenNames.has(name)) throw new BackupValidationError(`Backup contains duplicate entry ${name}`);
    seenNames.add(name);
    entries.push({
      name,
      rawName,
      flags,
      method: rawMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      payloadOffset: 0,
      endOffset: 0,
    });
    offset += 46 + variableLength + commentLength;
    if (offset > end.endOffset) {
      throw new BackupValidationError("Backup central directory entry exceeds its bounds");
    }
  }
  if (offset !== end.endOffset || offset - end.centralOffset !== end.centralBytes) {
    throw new BackupValidationError("Backup central directory inventory is incomplete");
  }
  return entries;
}

function isZeroOr(value: number, expected: number): boolean {
  return value === 0 || value === expected;
}

async function validateLocalEntry(file: File, entry: IndexedEntry): Promise<void> {
  const header = await readExact(file, entry.localHeaderOffset, 30, `local header ${entry.name}`);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== ZIP_LOCAL_FILE_SIGNATURE) {
    throw new BackupValidationError(`Backup local header for ${entry.name} is malformed`);
  }
  const flags = view.getUint16(6, true);
  const method = view.getUint16(8, true);
  const crc32 = view.getUint32(14, true);
  const compressedSize = view.getUint32(18, true);
  const uncompressedSize = view.getUint32(22, true);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  if (flags !== entry.flags || method !== entry.method) {
    throw new BackupValidationError(`Backup local header for ${entry.name} disagrees with central metadata`);
  }
  validateFlags(flags, entry.name);
  const variable = await readExact(
    file,
    entry.localHeaderOffset + 30,
    nameLength + extraLength,
    `local entry metadata ${entry.name}`,
  );
  const rawName = variable.slice(0, nameLength);
  if (!bytesEqual(rawName, entry.rawName)) {
    throw new BackupValidationError(`Backup local filename for ${entry.name} disagrees with central metadata`);
  }
  validateExtra(variable.subarray(nameLength), `local entry ${entry.name}`);
  entry.payloadOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const payloadEnd = entry.payloadOffset + entry.compressedSize;
  if (!Number.isSafeInteger(payloadEnd) || payloadEnd > file.size) {
    throw new BackupValidationError(`Backup payload for ${entry.name} is outside the archive bounds`);
  }
  if ((entry.flags & ZIP_DATA_DESCRIPTOR_FLAG) === 0) {
    if (
      crc32 !== entry.crc32 || compressedSize !== entry.compressedSize ||
      uncompressedSize !== entry.uncompressedSize
    ) {
      throw new BackupValidationError(`Backup local sizes or CRC for ${entry.name} disagree with central metadata`);
    }
    entry.endOffset = payloadEnd;
    return;
  }
  if (
    !isZeroOr(crc32, entry.crc32) ||
    !isZeroOr(compressedSize, entry.compressedSize) ||
    !isZeroOr(uncompressedSize, entry.uncompressedSize)
  ) {
    throw new BackupValidationError(`Backup descriptor placeholders for ${entry.name} are inconsistent`);
  }
  const first = await readExact(file, payloadEnd, 4, `data descriptor ${entry.name}`);
  const firstValue = new DataView(first.buffer, first.byteOffset, first.byteLength).getUint32(0, true);
  const hasSignature = firstValue === ZIP_DATA_DESCRIPTOR_SIGNATURE;
  const remainder = await readExact(
    file,
    payloadEnd + 4,
    hasSignature ? 12 : 8,
    `data descriptor ${entry.name}`,
  );
  const descriptor = new DataView(remainder.buffer, remainder.byteOffset, remainder.byteLength);
  const descriptorCrc = hasSignature ? descriptor.getUint32(0, true) : firstValue;
  const descriptorCompressed = descriptor.getUint32(hasSignature ? 4 : 0, true);
  const descriptorUncompressed = descriptor.getUint32(hasSignature ? 8 : 4, true);
  if (
    descriptorCrc !== entry.crc32 || descriptorCompressed !== entry.compressedSize ||
    descriptorUncompressed !== entry.uncompressedSize
  ) {
    throw new BackupValidationError(`Backup data descriptor for ${entry.name} disagrees with central metadata`);
  }
  entry.endOffset = payloadEnd + (hasSignature ? 16 : 12);
}

async function buildArchiveIndex(file: File): Promise<ArchiveIndex> {
  const end = await readEndRecord(file);
  const entries = await readCentralEntries(file, end);
  for (const entry of entries) await validateLocalEntry(file, entry);
  const byOffset = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  if (byOffset.length > 0 && byOffset[0].localHeaderOffset !== 0) {
    throw new BackupValidationError("Backup local entries do not start at the archive boundary");
  }
  for (let index = 0; index < byOffset.length; index += 1) {
    const entry = byOffset[index];
    const nextOffset = byOffset[index + 1]?.localHeaderOffset ?? end.centralOffset;
    if (entry.localHeaderOffset >= end.centralOffset || entry.endOffset !== nextOffset) {
      throw new BackupValidationError(`Backup entry ${entry.name} does not exactly cover its ZIP span`);
    }
  }
  const account = new BackupByteAccount();
  for (const entry of entries) account.registerEntry(entry.name, entry.uncompressedSize);
  return { entries, byName: new Map(entries.map((entry) => [entry.name, entry])), account };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

async function streamEntry(
  file: File,
  entry: IndexedEntry,
  state: RequestState,
  account: BackupByteAccount,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
): Promise<number> {
  let crc = 0xffffffff;
  let actualBytes = 0;
  const outputQueue: Uint8Array[] = [];
  let decoderFinal = entry.method === 0;
  const acceptOutput = (data: Uint8Array) => {
    if (data.byteLength === 0) return;
    account.addActualBytes(entry.name, data.byteLength);
    actualBytes += data.byteLength;
    crc = updateCrc32(crc, data);
    outputQueue.push(data.slice());
  };
  const inflate = entry.method === 8
    ? new Inflate((data, final) => {
      acceptOutput(data);
      if (final) decoderFinal = true;
    })
    : null;
  const drainOutput = async () => {
    while (outputQueue.length > 0) {
      throwIfCancelled(state);
      await onChunk(outputQueue.shift()!);
    }
  };
  let compressedRead = 0;
  while (compressedRead < entry.compressedSize) {
    throwIfCancelled(state);
    const length = Math.min(ARCHIVE_READ_CHUNK_BYTES, entry.compressedSize - compressedRead);
    const chunk = await readExact(
      file,
      entry.payloadOffset + compressedRead,
      length,
      `payload ${entry.name}`,
    );
    compressedRead += length;
    if (entry.method === 0) acceptOutput(chunk);
    else inflate!.push(chunk, compressedRead === entry.compressedSize);
    await drainOutput();
  }
  if (entry.method === 8 && entry.compressedSize === 0) {
    inflate!.push(new Uint8Array(0), true);
    await drainOutput();
  }
  if (!decoderFinal) throw new BackupValidationError(`Backup entry ${entry.name} did not finish inflating`);
  const finishedBytes = account.finishEntry(entry.name, true);
  if (finishedBytes !== actualBytes || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) {
    throw new BackupValidationError(`Backup entry ${entry.name} failed its CRC32 integrity check`);
  }
  return actualBytes;
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

async function readManifest(
  file: File,
  entry: IndexedEntry,
  state: RequestState,
  account: BackupByteAccount,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  await streamEntry(file, entry, state, account, (chunk) => {
    chunks.push(chunk);
    total += chunk.byteLength;
  });
  return concatChunks(chunks, total);
}

async function preflightArchive(file: File, state: RequestState): Promise<PreflightResult> {
  const index = await buildArchiveIndex(file);
  const projectEntry = index.byName.get(BACKUP_PROJECT_MANIFEST_NAME);
  if (!projectEntry) {
    throw new BackupValidationError(`Backup is missing ${BACKUP_PROJECT_MANIFEST_NAME}`);
  }
  const projectManifest = await readManifest(file, projectEntry, state, index.account);
  const mediaEntry = index.byName.get(BACKUP_MEDIA_MANIFEST_NAME);
  const mediaManifest = mediaEntry
    ? await readManifest(file, mediaEntry, state, index.account)
    : null;
  const validated = validateBackupManifests(
    parseBackupJson(projectManifest, BACKUP_PROJECT_MANIFEST_NAME),
    mediaManifest ? parseBackupJson(mediaManifest, BACKUP_MEDIA_MANIFEST_NAME) : undefined,
    index.entries.map((entry) => entry.name),
  );
  return { ...index, projectManifest, mediaManifest, media: validated.mediaManifest };
}

function terminateState(state: RequestState, reason?: unknown): void {
  if (state.cancelled) return;
  state.cancelled = true;
  state.pendingAck?.reject(reason ?? new RequestCancelledError());
  state.pendingAck = null;
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
  scope.postMessage({ type: "entry-chunk", requestId: state.requestId, name, sequence, chunk }, [chunk]);
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
  scope.postMessage({ type: "entry-end", requestId: state.requestId, name, actualBytes: bytes.byteLength });
}

async function streamMediaPass(
  scope: BackupImportWorkerScope,
  file: File,
  preflight: PreflightResult,
  state: RequestState,
): Promise<void> {
  for (const media of preflight.media.media) {
    throwIfCancelled(state);
    const entry = preflight.byName.get(media.file);
    if (!entry) throw new BackupValidationError(`Backup is missing required media file ${media.file}`);
    scope.postMessage({
      type: "entry-start",
      requestId: state.requestId,
      name: entry.name,
      contentLength: entry.uncompressedSize,
    });
    const actualBytes = await streamEntry(
      file,
      entry,
      state,
      preflight.account,
      (chunk) => sendChunk(scope, state, entry.name, chunk),
    );
    scope.postMessage({ type: "entry-end", requestId: state.requestId, name: entry.name, actualBytes });
  }
}

async function runRequest(
  scope: BackupImportWorkerScope,
  file: File,
  state: RequestState,
): Promise<void> {
  if (
    !Number.isSafeInteger(file.size) || file.size < 0 ||
    file.size > BACKUP_LIMITS.maxArchiveBytes
  ) {
    throw new BackupValidationError("Backup archive exceeds the compressed size limit");
  }
  scope.postMessage({ type: "progress", requestId: state.requestId, compressedBytes: 0, entries: 0 });
  const preflight = await preflightArchive(file, state);
  scope.postMessage({
    type: "progress",
    requestId: state.requestId,
    compressedBytes: file.size,
    entries: preflight.entries.length,
  });
  throwIfCancelled(state);
  await sendBufferedEntry(scope, state, BACKUP_PROJECT_MANIFEST_NAME, preflight.projectManifest);
  if (preflight.mediaManifest) {
    await sendBufferedEntry(scope, state, BACKUP_MEDIA_MANIFEST_NAME, preflight.mediaManifest);
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
      if (!state) return;
      if (
        !hasOnlyKeys(message, ["type", "requestId", "sequence"]) ||
        !Number.isSafeInteger(message.sequence) || (message.sequence as number) < 0
      ) {
        terminateState(state, new WorkerRequestProtocolError("Backup chunk ACK was malformed"));
        return;
      }
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
