import {
  AsyncInflate,
  strToU8,
  Unzip,
  UnzipInflate,
  Zip,
  ZipPassThrough,
  type AsyncFlateStreamHandler,
  type UnzipDecoder,
  type UnzipFile,
} from "fflate/browser";
import type { ShortDramaProjectResponse } from "../domain/types";
import {
  BackupValidationError,
  MANIFEST_NAME,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  MEDIA_MANIFEST_NAME,
  archiveEntryByteLimit,
  archiveEntryLimitError,
  collectLocalMediaRefs,
  isSafeArchiveEntryName,
  mediaIdFromRef,
  normalizeAndValidateSnapshot,
  parseBackupJson,
  rewriteLocalMediaRefs,
  shouldRetainArchiveEntry,
  validateBackupManifests,
  type MediaBackupManifest,
  type ProjectBackupEnvelope,
} from "./backupFormat";
import { renewMediaOperationLease } from "./mediaJournal";
import { beginMediaWrite, loadMediaBlob, runMediaRecovery } from "./mediaStore";
import {
  abortProjectImport,
  beginProjectImport,
  commitImportedProject,
  loadProjectSnapshot,
  ProjectImportConflictError,
} from "./projectStore";
import type { LocalMediaRef } from "./types";

export { ProjectImportConflictError } from "./projectStore";

const MIB = 1024 * 1024;
const FALLBACK_READ_CHUNK_BYTES = 64 * 1024;
const FFLATE_ASYNC_INFLATE_THRESHOLD_BYTES = 320_000;
const MAX_ACTIVE_INFLATE_WORKERS = 2;
const IMPORT_MEDIA_CHUNK_BYTES = MIB;

async function renewImportSessionLease(sessionId: string): Promise<void> {
  const renewed = await renewMediaOperationLease(sessionId, sessionId);
  if (!renewed || renewed.kind !== "import_session" || renewed.state !== "importing") {
    throw new Error(`Import session ${sessionId} lost its owner lease`);
  }
}
const WORKER_PROBE_TIMEOUT_MS = 2_000;
const DECODER_IDLE_TIMEOUT_MS = 15_000;

type ImportProjectBackupOptions = {
  overwrite?: boolean;
};

type BackupBlobEntry = {
  name: string;
  blob: Blob;
};

type ExtractedBackupArchive = {
  files: Record<string, Uint8Array>;
  entryPaths: string[];
};

function shouldUseAsyncInflate(size?: number, originalSize?: number): boolean {
  return (
    size === undefined ||
    originalSize === undefined ||
    size >= FFLATE_ASYNC_INFLATE_THRESHOLD_BYTES ||
    originalSize >= FFLATE_ASYNC_INFLATE_THRESHOLD_BYTES
  );
}

class ResilientUnzipInflate implements UnzipDecoder {
  static readonly compression = 8;
  ondata!: AsyncFlateStreamHandler;
  private readonly inflate: UnzipDecoder;

  constructor(_name: string, size?: number, originalSize?: number) {
    try {
      if (!shouldUseAsyncInflate(size, originalSize)) {
        this.inflate = new UnzipInflate();
      } else {
        const inflate = new AsyncInflate((error, data, final) => {
          this.ondata(error, data, final);
        });
        this.inflate = {
          ondata: this.ondata,
          push: (chunk, final) => inflate.push(chunk.slice(), final),
          terminate: () => inflate.terminate(),
        };
      }
    } catch {
      this.inflate = new UnzipInflate();
    }
    if (this.inflate instanceof UnzipInflate) {
      this.inflate.ondata = (error, data, final) => this.ondata(error, data, final);
    }
  }

  push(chunk: Uint8Array, final: boolean): void {
    this.inflate.push(chunk, final);
  }

  terminate(): void {
    this.inflate.terminate?.();
  }
}

let workerProbeCache: {
  workerConstructor: typeof Worker;
  result: Promise<boolean>;
} | null = null;

function canUseInflateWorker(): Promise<boolean> {
  const workerConstructor = globalThis.Worker;
  if (typeof workerConstructor !== "function") {
    return Promise.resolve(false);
  }
  if (workerProbeCache?.workerConstructor === workerConstructor) {
    return workerProbeCache.result;
  }

  const result = new Promise<boolean>((resolve) => {
    let settled = false;
    let inflate: AsyncInflate | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const finish = (supported: boolean) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      inflate?.terminate();
      resolve(supported);
    };

    timeoutId = setTimeout(() => finish(false), WORKER_PROBE_TIMEOUT_MS);
    try {
      inflate = new AsyncInflate((error, _data, final) => {
        if (error) {
          finish(false);
        } else if (final) {
          finish(true);
        }
      });
      inflate.push(new Uint8Array([0x03, 0x00]), true);
    } catch {
      finish(false);
    }
  });
  workerProbeCache = { workerConstructor, result };
  return result;
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read backup file"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

function createBlobReader(blob: Blob): Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel"> {
  if (typeof blob.stream === "function") {
    return blob.stream().getReader();
  }

  let bytes: Uint8Array | null = null;
  let offset = 0;
  return {
    async read() {
      bytes ??= new Uint8Array(await blobToArrayBuffer(blob));
      if (offset >= bytes.length) {
        return { done: true, value: undefined };
      }
      const value = bytes.subarray(offset, offset + FALLBACK_READ_CHUNK_BYTES);
      offset += value.length;
      return { done: false, value };
    },
    async cancel() {
      offset = bytes?.length ?? 0;
    },
  };
}

function concatChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function errorWithCauses(message: string, causes: unknown[]): Error {
  const error = new Error(message) as Error & { causes: unknown[] };
  error.causes = causes;
  return error;
}

async function createBackupArchive(entries: BackupBlobEntry[]): Promise<Blob> {
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new BackupValidationError("Backup entry count exceeds the archive entry limit");
  }
  let totalInputBytes = 0;
  for (const entry of entries) {
    if (
      !Number.isSafeInteger(entry.blob.size) ||
      entry.blob.size > archiveEntryByteLimit(entry.name)
    ) {
      throw archiveEntryLimitError(entry.name);
    }
    totalInputBytes += entry.blob.size;
    if (totalInputBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new BackupValidationError("Backup total uncompressed size exceeds the limit");
    }
  }
  if (totalInputBytes > MAX_ARCHIVE_BYTES) {
    throw new BackupValidationError("Backup archive would exceed the compressed size limit");
  }

  const chunks: Uint8Array[] = [];
  let outputBytes = 0;
  let resolveArchive!: (blob: Blob) => void;
  let rejectArchive!: (error: unknown) => void;
  let settled = false;
  const completion = new Promise<Blob>((resolve, reject) => {
    resolveArchive = resolve;
    rejectArchive = reject;
  });
  const zip = new Zip((error, data, final) => {
    if (settled) return;
    if (error) {
      settled = true;
      rejectArchive(error);
      return;
    }
    outputBytes += data.length;
    if (outputBytes > MAX_ARCHIVE_BYTES) {
      settled = true;
      zip.terminate();
      rejectArchive(new BackupValidationError("Backup archive exceeds the compressed size limit"));
      return;
    }
    chunks.push(data);
    if (final) {
      settled = true;
      resolveArchive(new Blob(chunks.map(bytesToArrayBuffer), { type: "application/zip" }));
    }
  });

  try {
    for (const { name, blob } of entries) {
      if (settled) break;
      const zipEntry = new ZipPassThrough(name);
      zip.add(zipEntry);
      const reader = createBlobReader(blob);
      while (!settled) {
        const { done, value } = await reader.read();
        if (done) {
          zipEntry.push(new Uint8Array(0), true);
          break;
        }
        zipEntry.push(value, false);
      }
    }
    if (!settled) {
      zip.end();
    }
  } catch (error) {
    if (!settled) {
      settled = true;
      zip.terminate();
      rejectArchive(error);
    }
  }
  return completion;
}

async function extractBackupArchive(file: File): Promise<ExtractedBackupArchive> {
  if (!Number.isSafeInteger(file.size) || file.size > MAX_ARCHIVE_BYTES) {
    throw new BackupValidationError("Backup archive exceeds the compressed size limit");
  }
  const workerSupported = await canUseInflateWorker();

  return new Promise((resolve, reject) => {
    const files: Record<string, Uint8Array> = {};
    const seenNames = new Set<string>();
    const activeFiles = new Set<UnzipFile>();
    const reader = createBlobReader(file);
    let archivedBytesRead = 0;
    let entryCount = 0;
    let declaredTotal = 0;
    let actualTotal = 0;
    let pendingEntries = 0;
    let activeInflateWorkers = 0;
    let inputDone = false;
    let settled = false;
    const queuedWorkerStarts: Array<(release: () => void) => void> = [];
    const inputGateResolvers: Array<() => void> = [];
    const controls = new Set<{
      file: UnzipFile;
      done: boolean;
      releaseWorkerSlot: (() => void) | null;
      watchdog: ReturnType<typeof setTimeout> | null;
    }>();

    const releaseInputGate = () => {
      if (!settled && queuedWorkerStarts.length > 0) return;
      for (const release of inputGateResolvers.splice(0)) release();
    };
    const drainWorkerStarts = () => {
      while (!settled && activeInflateWorkers < MAX_ACTIVE_INFLATE_WORKERS) {
        const start = queuedWorkerStarts.shift();
        if (!start) break;
        activeInflateWorkers += 1;
        let released = false;
        start(() => {
          if (released) return;
          released = true;
          activeInflateWorkers -= 1;
          drainWorkerStarts();
        });
      }
      releaseInputGate();
    };
    const waitForInputGate = (): Promise<void> | null => (
      queuedWorkerStarts.length > 0
        ? new Promise((resolveGate) => inputGateResolvers.push(resolveGate))
        : null
    );

    const maybeResolve = () => {
      if (!settled && inputDone && pendingEntries === 0) {
        settled = true;
        resolve({ files, entryPaths: [...seenNames] });
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      queuedWorkerStarts.splice(0);
      for (const control of controls) {
        control.done = true;
        if (control.watchdog !== null) clearTimeout(control.watchdog);
        try {
          control.file.terminate();
        } catch {
          // The original decoder failure remains authoritative.
        }
        control.releaseWorkerSlot?.();
      }
      controls.clear();
      activeFiles.clear();
      pendingEntries = 0;
      releaseInputGate();
      void reader.cancel(error).catch(() => undefined);
      reject(error);
    };

    const unzip = new Unzip((archiveEntry) => {
      if (settled) return;
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_ENTRIES) {
        fail(new BackupValidationError("Backup archive has too many entries for the entry limit"));
        return;
      }
      if (!isSafeArchiveEntryName(archiveEntry.name)) {
        fail(new BackupValidationError(`Backup archive entry ${archiveEntry.name} is malformed`));
        return;
      }
      if (seenNames.has(archiveEntry.name)) {
        fail(new BackupValidationError(`Backup archive contains duplicate entry ${archiveEntry.name}`));
        return;
      }
      seenNames.add(archiveEntry.name);

      if (archiveEntry.originalSize !== undefined) {
        if (
          !Number.isSafeInteger(archiveEntry.originalSize) ||
          archiveEntry.originalSize < 0 ||
          archiveEntry.originalSize > archiveEntryByteLimit(archiveEntry.name)
        ) {
          fail(archiveEntryLimitError(archiveEntry.name));
          return;
        }
        declaredTotal += archiveEntry.originalSize;
        if (declaredTotal > MAX_TOTAL_UNCOMPRESSED_BYTES) {
          fail(new BackupValidationError("Backup total uncompressed size exceeds the limit"));
          return;
        }
      }

      const chunks: Uint8Array[] = [];
      let entryBytes = 0;
      const needsWorkerSlot = (
        workerSupported &&
        archiveEntry.compression === 8 &&
        shouldUseAsyncInflate(archiveEntry.size, archiveEntry.originalSize)
      );
      const control = {
        file: archiveEntry,
        done: false,
        releaseWorkerSlot: null as (() => void) | null,
        watchdog: null as ReturnType<typeof setTimeout> | null,
      };
      const clearWatchdog = () => {
        if (control.watchdog === null) return;
        clearTimeout(control.watchdog);
        control.watchdog = null;
      };
      const armWatchdog = () => {
        if (!needsWorkerSlot || settled || control.done) return;
        clearWatchdog();
        control.watchdog = setTimeout(() => {
          if (settled || control.done) return;
          fail(new Error(`Backup decoder timed out for ${archiveEntry.name}`));
        }, DECODER_IDLE_TIMEOUT_MS);
      };
      pendingEntries += 1;
      activeFiles.add(archiveEntry);
      controls.add(control);
      archiveEntry.ondata = (error, data, final) => {
        if (settled || control.done) return;
        if (error) {
          fail(error);
          return;
        }
        const nextEntryBytes = entryBytes + data.length;
        const nextActualTotal = actualTotal + data.length;
        if (nextEntryBytes > archiveEntryByteLimit(archiveEntry.name)) {
          fail(archiveEntryLimitError(archiveEntry.name));
          return;
        }
        if (nextActualTotal > MAX_TOTAL_UNCOMPRESSED_BYTES) {
          fail(new BackupValidationError("Backup total uncompressed size exceeds the limit"));
          return;
        }
        entryBytes = nextEntryBytes;
        actualTotal = nextActualTotal;
        if (!final) armWatchdog();
        if (shouldRetainArchiveEntry(archiveEntry.name) && data.length > 0) {
          chunks.push(data);
        }
        if (final) {
          control.done = true;
          clearWatchdog();
          if (shouldRetainArchiveEntry(archiveEntry.name)) {
            files[archiveEntry.name] = concatChunks(chunks, entryBytes);
          }
          activeFiles.delete(archiveEntry);
          controls.delete(control);
          pendingEntries -= 1;
          control.releaseWorkerSlot?.();
          maybeResolve();
        }
      };
      const startEntry = (release?: () => void) => {
        control.releaseWorkerSlot = release ?? null;
        armWatchdog();
        try {
          archiveEntry.start();
        } catch (error) {
          fail(error);
        }
      };
      if (needsWorkerSlot) {
        queuedWorkerStarts.push(startEntry);
        drainWorkerStarts();
      } else {
        startEntry();
      }
    });
    unzip.register(workerSupported ? ResilientUnzipInflate : UnzipInflate);

    void (async () => {
      try {
        while (!settled) {
          const { done, value } = await reader.read();
          if (done) {
            unzip.push(new Uint8Array(0), true);
            inputDone = true;
            maybeResolve();
            break;
          }
          for (let offset = 0; offset < value.length && !settled; offset += FALLBACK_READ_CHUNK_BYTES) {
            const inputGate = waitForInputGate();
            if (inputGate) await inputGate;
            if (settled) break;
            const chunk = value.subarray(offset, offset + FALLBACK_READ_CHUNK_BYTES);
            archivedBytesRead += chunk.length;
            if (archivedBytesRead > MAX_ARCHIVE_BYTES) {
              fail(new BackupValidationError("Backup archive exceeds the compressed size limit"));
              break;
            }
            unzip.push(chunk, false);
          }
        }
      } catch (error) {
        fail(error);
      }
    })();
  });
}

export async function exportProjectBackup(projectId: string): Promise<Blob> {
  const record = await loadProjectSnapshot(projectId);
  if (!record) {
    throw new Error("Project not found in this browser");
  }
  const snapshot = normalizeAndValidateSnapshot(record.snapshot);

  const projectManifest = strToU8(
    JSON.stringify(
      { version: 1, project: snapshot } satisfies ProjectBackupEnvelope,
      null,
      2,
    ),
  );
  const mediaManifest: MediaBackupManifest = { version: 1, media: [] };
  const mediaEntries: BackupBlobEntry[] = [];

  for (const ref of collectLocalMediaRefs(snapshot)) {
    const blob = await loadMediaBlob(ref);
    if (!blob) {
      throw new Error(`Required local media ${ref} is missing or unreadable`);
    }
    const file = `media/${mediaIdFromRef(ref)}`;
    mediaEntries.push({ name: file, blob });
    mediaManifest.media.push({
      ref,
      file,
      contentType: blob.type || "application/octet-stream",
      sourcePath: file,
    });
  }

  const entries: BackupBlobEntry[] = [
    { name: MANIFEST_NAME, blob: new Blob([projectManifest], { type: "application/json" }) },
  ];
  if (mediaManifest.media.length > 0) {
    entries.push({
      name: MEDIA_MANIFEST_NAME,
      blob: new Blob([strToU8(JSON.stringify(mediaManifest, null, 2))], {
        type: "application/json",
      }),
    });
  }
  entries.push(...mediaEntries);
  return createBackupArchive(entries);
}

export async function importProjectBackup(
  file: File,
  options: ImportProjectBackupOptions = {},
): Promise<ShortDramaProjectResponse> {
  const { files, entryPaths } = await extractBackupArchive(file);
  const manifestBytes = files[MANIFEST_NAME];
  if (!manifestBytes) {
    throw new BackupValidationError("Backup is missing openmontage-project.json");
  }

  const refMap = new Map<LocalMediaRef, LocalMediaRef>();
  const mediaManifestBytes = files[MEDIA_MANIFEST_NAME];
  const { project: snapshot, mediaManifest } = validateBackupManifests(
    parseBackupJson(manifestBytes, MANIFEST_NAME),
    mediaManifestBytes ? parseBackupJson(mediaManifestBytes, MEDIA_MANIFEST_NAME) : undefined,
    entryPaths,
  );

  const existing = await loadProjectSnapshot(snapshot.project.id);
  if (existing && !options.overwrite) {
    throw new ProjectImportConflictError(snapshot.project.id);
  }

  const sessionId = await beginProjectImport(snapshot.project.id);
  try {
    for (const entry of mediaManifest.media) {
      await renewImportSessionLease(sessionId);
      const mediaBytes = files[entry.file];
      const writer = await beginMediaWrite({
        projectId: snapshot.project.id,
        importSessionId: sessionId,
        sourcePath: entry.sourcePath,
        contentType: entry.contentType,
        sizeBytes: mediaBytes.byteLength,
      });
      let restoredRef: LocalMediaRef;
      try {
        for (let offset = 0; offset < mediaBytes.byteLength; offset += IMPORT_MEDIA_CHUNK_BYTES) {
          await writer.write(mediaBytes.subarray(offset, offset + IMPORT_MEDIA_CHUNK_BYTES));
        }
        restoredRef = await writer.commit();
      } catch (error) {
        await writer.abort(error).catch(() => undefined);
        throw error;
      }
      await renewImportSessionLease(sessionId);
      refMap.set(entry.ref, restoredRef);
    }

    const restoredSnapshot =
      refMap.size > 0
        ? (rewriteLocalMediaRefs(snapshot, refMap) as ShortDramaProjectResponse)
        : snapshot;
    const validatedSnapshot = normalizeAndValidateSnapshot(restoredSnapshot);
    await renewImportSessionLease(sessionId);
    await commitImportedProject(validatedSnapshot, sessionId, {
      overwrite: options.overwrite ?? false,
      leaseOwner: sessionId,
    });
    return validatedSnapshot;
  } catch (error) {
    await abortProjectImport(sessionId, error).catch(() => undefined);
    await runMediaRecovery().catch(() => undefined);
    throw error;
  }
}
