import {
  strToU8,
  Zip,
  ZipPassThrough,
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
  mediaIdFromRef,
  normalizeAndValidateSnapshot,
  rewriteLocalMediaRefs,
  type BackupEntryCallbacks,
  type BackupReadProgress,
  type MediaBackupManifest,
  type ProjectBackupEnvelope,
  type ValidatedBackup,
  type ValidatedBackupEntry,
} from "./backupFormat";
import { readBackupArchive } from "./backupArchiveClient";
import { readBackupDirectory } from "./backupDirectoryImport";
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

const FALLBACK_READ_CHUNK_BYTES = 64 * 1024;

async function renewImportSessionLease(sessionId: string): Promise<void> {
  const renewed = await renewMediaOperationLease(sessionId, sessionId);
  if (!renewed || renewed.kind !== "import_session" || renewed.state !== "importing") {
    throw new Error(`Import session ${sessionId} lost its owner lease`);
  }
}
export type ImportProjectBackupOptions = {
  overwrite?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: BackupReadProgress) => void | Promise<void>;
};

type BackupReader = (
  callbacks: BackupEntryCallbacks,
  signal?: AbortSignal,
) => Promise<ValidatedBackup>;

type BackupBlobEntry = {
  name: string;
  blob: Blob;
};

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

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
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

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function throwIfImportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function importProjectBackupFromReader(
  readBackup: BackupReader,
  options: ImportProjectBackupOptions = {},
): Promise<ShortDramaProjectResponse> {
  const refMap = new Map<LocalMediaRef, LocalMediaRef>();
  let sessionId: string | null = null;
  let activeWriter: {
    entry: Extract<ValidatedBackupEntry, { kind: "media" }>;
    writer: Awaited<ReturnType<typeof beginMediaWrite>>;
  } | null = null;
  const abortActiveWriter = async (cause: unknown) => {
    const current = activeWriter;
    if (current) await current.writer.abort(cause).catch(() => undefined);
  };
  try {
    throwIfImportAborted(options.signal);
    const backup = await readBackup({
      async onEntryStart(entry) {
        if (entry.kind === "project-manifest") {
          if (sessionId) throw new Error("Backup project manifest was streamed more than once");
          const existing = await loadProjectSnapshot(entry.projectId);
          if (existing && !options.overwrite) {
            throw new ProjectImportConflictError(entry.projectId);
          }
          sessionId = await beginProjectImport(entry.projectId);
          return;
        }
        if (entry.kind !== "media") return;
        if (!sessionId) throw new Error("Backup media was streamed before its import session");
        if (activeWriter) throw new Error("Backup media entries overlapped");
        await renewImportSessionLease(sessionId);
        const writer = await beginMediaWrite({
          projectId: entry.projectId,
          importSessionId: sessionId,
          sourcePath: entry.media.sourcePath,
          contentType: entry.media.contentType,
          sizeBytes: entry.sizeBytes,
        });
        activeWriter = { entry, writer };
      },
      async onEntryChunk(entry, chunk) {
        if (entry.kind !== "media") return;
        if (!activeWriter || activeWriter.entry.name !== entry.name) {
          throw new Error(`Backup media writer for ${entry.name} is not active`);
        }
        await activeWriter.writer.write(chunk);
      },
      async onEntryEnd(entry) {
        if (entry.kind !== "media") return;
        if (!activeWriter || activeWriter.entry.name !== entry.name || !sessionId) {
          throw new Error(`Backup media writer for ${entry.name} ended out of order`);
        }
        const current = activeWriter;
        activeWriter = null;
        try {
          const restoredRef = await current.writer.commit();
          await renewImportSessionLease(sessionId);
          refMap.set(current.entry.media.ref, restoredRef);
        } catch (error) {
          await current.writer.abort(error).catch(() => undefined);
          throw error;
        }
      },
      async onProgress(progress) {
        await options.onProgress?.(progress);
      },
    }, options.signal);
    throwIfImportAborted(options.signal);
    if (!sessionId) throw new Error("Backup import session was not established");

    const restoredSnapshot =
      refMap.size > 0
        ? (rewriteLocalMediaRefs(backup.project, refMap) as ShortDramaProjectResponse)
        : backup.project;
    const validatedSnapshot = normalizeAndValidateSnapshot(restoredSnapshot);
    throwIfImportAborted(options.signal);
    await renewImportSessionLease(sessionId);
    throwIfImportAborted(options.signal);
    await commitImportedProject(validatedSnapshot, sessionId, {
      overwrite: options.overwrite ?? false,
      leaseOwner: sessionId,
    });
    return validatedSnapshot;
  } catch (error) {
    const wasAborted = options.signal?.aborted ?? false;
    await abortActiveWriter(error);
    if (sessionId) {
      await abortProjectImport(sessionId, error).catch(() => undefined);
      await runMediaRecovery().catch(() => undefined);
    }
    if (wasAborted) throw abortError();
    throw error;
  }
}

export function importProjectBackup(
  file: File,
  options: ImportProjectBackupOptions = {},
): Promise<ShortDramaProjectResponse> {
  return importProjectBackupFromReader(
    (callbacks, signal) => readBackupArchive(file, callbacks, signal),
    options,
  );
}

export function importProjectBackupDirectory(
  files: Iterable<File> | ArrayLike<File>,
  options: ImportProjectBackupOptions = {},
): Promise<ShortDramaProjectResponse> {
  return importProjectBackupFromReader(
    (callbacks, signal) => readBackupDirectory(files, callbacks, signal),
    options,
  );
}
