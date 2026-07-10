import {
  AsyncInflate,
  AsyncUnzipInflate,
  strFromU8,
  strToU8,
  Unzip,
  Zip,
  ZipPassThrough,
  type AsyncFlateStreamHandler,
  type UnzipDecoder,
  type UnzipFile,
} from "fflate";
import type { ShortDramaProjectResponse } from "../domain/types";
import { deleteMediaBlob, loadMediaBlob, saveMediaBlob } from "./mediaStore";
import { loadProjectSnapshot, saveProjectSnapshot } from "./projectStore";
import type { LocalMediaRef } from "./types";

const MANIFEST_NAME = "openmontage-project.json";
const MEDIA_MANIFEST_NAME = "openmontage-media.json";
const LOCAL_MEDIA_PREFIX = "local://media/";
const MIB = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * MIB;
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_ENTRY_BYTES = 256 * MIB;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 1024 * MIB;
const FALLBACK_READ_CHUNK_BYTES = 64 * 1024;

type MediaBackupEntry = {
  ref: LocalMediaRef;
  file: string;
  contentType: string;
  sourcePath: string;
};

type MediaBackupManifest = {
  version: 1;
  media: MediaBackupEntry[];
};

type ProjectBackupEnvelope = {
  version: 1;
  project: ShortDramaProjectResponse;
};

type ImportProjectBackupOptions = {
  overwrite?: boolean;
};

type BackupBlobEntry = {
  name: string;
  blob: Blob;
};

class WorkerUnzipInflate implements UnzipDecoder {
  static readonly compression = 8;
  ondata!: AsyncFlateStreamHandler;
  private readonly inflate: AsyncInflate;

  constructor() {
    this.inflate = new AsyncInflate((error, data, final) => this.ondata(error, data, final));
  }

  push(chunk: Uint8Array, final: boolean): void {
    this.inflate.push(chunk.slice(), final);
  }

  terminate(): void {
    this.inflate.terminate();
  }
}

export class ProjectImportConflictError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`Project ${projectId} already exists; explicit overwrite permission is required`);
    this.name = "ProjectImportConflictError";
    this.projectId = projectId;
  }
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

function isSafeArchiveEntryName(name: string): boolean {
  if (!name || name.length > 256 || name.startsWith("/") || name.includes("\\")) {
    return false;
  }
  return name.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function shouldRetainArchiveEntry(name: string): boolean {
  return name === MANIFEST_NAME || name === MEDIA_MANIFEST_NAME || name.startsWith("media/");
}

async function createBackupArchive(entries: BackupBlobEntry[]): Promise<Blob> {
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("Backup entry count exceeds the archive entry limit");
  }
  let totalInputBytes = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.blob.size) || entry.blob.size > MAX_ENTRY_BYTES) {
      throw new Error(`Backup entry ${entry.name} exceeds the per-entry size limit`);
    }
    totalInputBytes += entry.blob.size;
    if (totalInputBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error("Backup total uncompressed size exceeds the limit");
    }
  }
  if (totalInputBytes > MAX_ARCHIVE_BYTES) {
    throw new Error("Backup archive would exceed the compressed size limit");
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
      rejectArchive(new Error("Backup archive exceeds the compressed size limit"));
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

async function extractBackupArchive(file: File): Promise<Record<string, Uint8Array>> {
  if (!Number.isSafeInteger(file.size) || file.size > MAX_ARCHIVE_BYTES) {
    throw new Error("Backup archive exceeds the compressed size limit");
  }

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
    let inputDone = false;
    let settled = false;

    const maybeResolve = () => {
      if (!settled && inputDone && pendingEntries === 0) {
        settled = true;
        resolve(files);
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      void reader.cancel(error);
      for (const activeFile of activeFiles) {
        activeFile.terminate();
      }
      reject(error);
    };

    const unzip = new Unzip((archiveEntry) => {
      if (settled) return;
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_ENTRIES) {
        fail(new Error("Backup archive has too many entries for the entry limit"));
        return;
      }
      if (!isSafeArchiveEntryName(archiveEntry.name)) {
        fail(new Error(`Backup archive entry ${archiveEntry.name} is malformed`));
        return;
      }
      if (seenNames.has(archiveEntry.name)) {
        fail(new Error(`Backup archive contains duplicate entry ${archiveEntry.name}`));
        return;
      }
      seenNames.add(archiveEntry.name);

      if (archiveEntry.originalSize !== undefined) {
        if (
          !Number.isSafeInteger(archiveEntry.originalSize) ||
          archiveEntry.originalSize < 0 ||
          archiveEntry.originalSize > MAX_ENTRY_BYTES
        ) {
          fail(new Error(`Backup entry ${archiveEntry.name} exceeds the per-entry size limit`));
          return;
        }
        declaredTotal += archiveEntry.originalSize;
        if (declaredTotal > MAX_TOTAL_UNCOMPRESSED_BYTES) {
          fail(new Error("Backup total uncompressed size exceeds the limit"));
          return;
        }
      }

      const chunks: Uint8Array[] = [];
      let entryBytes = 0;
      pendingEntries += 1;
      activeFiles.add(archiveEntry);
      archiveEntry.ondata = (error, data, final) => {
        if (settled) return;
        if (error) {
          fail(error);
          return;
        }
        const nextEntryBytes = entryBytes + data.length;
        const nextActualTotal = actualTotal + data.length;
        if (nextEntryBytes > MAX_ENTRY_BYTES) {
          fail(new Error(`Backup entry ${archiveEntry.name} exceeds the per-entry size limit`));
          return;
        }
        if (nextActualTotal > MAX_TOTAL_UNCOMPRESSED_BYTES) {
          fail(new Error("Backup total uncompressed size exceeds the limit"));
          return;
        }
        entryBytes = nextEntryBytes;
        actualTotal = nextActualTotal;
        if (shouldRetainArchiveEntry(archiveEntry.name) && data.length > 0) {
          chunks.push(data);
        }
        if (final) {
          if (shouldRetainArchiveEntry(archiveEntry.name)) {
            files[archiveEntry.name] = concatChunks(chunks, entryBytes);
          }
          activeFiles.delete(archiveEntry);
          pendingEntries -= 1;
          maybeResolve();
        }
      };
      try {
        archiveEntry.start();
      } catch (error) {
        fail(error);
      }
    });
    unzip.register(typeof Worker === "function" ? WorkerUnzipInflate : AsyncUnzipInflate);

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
          archivedBytesRead += value.length;
          if (archivedBytesRead > MAX_ARCHIVE_BYTES) {
            fail(new Error("Backup archive exceeds the compressed size limit"));
            break;
          }
          unzip.push(value, false);
        }
      } catch (error) {
        fail(error);
      }
    })();
  });
}

function isLocalMediaRef(value: unknown): value is LocalMediaRef {
  return (
    typeof value === "string" &&
    /^local:\/\/media\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  );
}

function collectLocalMediaRefs(value: unknown, refs = new Set<LocalMediaRef>()): Set<LocalMediaRef> {
  if (isLocalMediaRef(value)) {
    refs.add(value);
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLocalMediaRefs(item, refs);
    }
    return refs;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectLocalMediaRefs(item, refs);
    }
  }
  return refs;
}

function rewriteLocalMediaRefs(value: unknown, refMap: Map<LocalMediaRef, LocalMediaRef>): unknown {
  if (isLocalMediaRef(value)) {
    return refMap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteLocalMediaRefs(item, refMap));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewriteLocalMediaRefs(item, refMap)]),
    );
  }
  return value;
}

function mediaIdFromRef(ref: LocalMediaRef): string {
  return ref.slice(LOCAL_MEDIA_PREFIX.length);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isValidShot(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.scene_id === "string" &&
    Number.isSafeInteger(value.index) &&
    typeof value.beat === "string" &&
    typeof value.prompt === "string" &&
    isStringArray(value.characters) &&
    isNullableString(value.location) &&
    isStringArray(value.props) &&
    ["draft", "ready", "generating", "complete", "failed"].includes(String(value.status)) &&
    typeof value.consistency_score === "number" &&
    isNullableString(value.output_url) &&
    isNullableString(value.output_path) &&
    isStringArray(value.asset_ids) &&
    Number.isSafeInteger(value.version) &&
    Array.isArray(value.history)
  );
}

function validateLocalMediaRefs(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (value.startsWith(LOCAL_MEDIA_PREFIX) && !isLocalMediaRef(value)) {
      throw new Error(`Local media reference ${value} is malformed`);
    }
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validateLocalMediaRefs(item, seen);
  } else {
    for (const item of Object.values(value)) validateLocalMediaRefs(item, seen);
  }
}

function validateSnapshot(value: unknown): asserts value is ShortDramaProjectResponse {
  if (
    !isRecord(value) ||
    !isRecord(value.project) ||
    typeof value.project.id !== "string" ||
    value.project.id.length === 0 ||
    typeof value.project.title !== "string" ||
    value.project.title.length === 0 ||
    value.project.mode !== "short_drama" ||
    !["single_video", "mini_series", "long_series"].includes(String(value.project.project_type)) ||
    !isRecord(value.series_bible) ||
    !Array.isArray(value.series_bible.characters) ||
    (value.series_bible.assets !== undefined && !Array.isArray(value.series_bible.assets)) ||
    !isRecord(value.storyboard) ||
    !Array.isArray(value.storyboard.shots) ||
    !value.storyboard.shots.every(isValidShot) ||
    !isRecord(value.consistency_report) ||
    typeof value.consistency_report.score !== "number" ||
    !Array.isArray(value.consistency_report.issues)
  ) {
    throw new Error("Backup project metadata is invalid");
  }
  validateLocalMediaRefs(value);
}

function validateProjectEnvelope(value: unknown): ShortDramaProjectResponse {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Backup format version is unsupported");
  }
  validateSnapshot(value.project);
  return value.project;
}

function validateMediaManifest(
  value: unknown,
  requiredRefs: Set<LocalMediaRef>,
  files: Record<string, Uint8Array>,
): MediaBackupManifest {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.media)) {
    throw new Error("Backup media manifest is invalid or unsupported");
  }

  const seenRefs = new Set<LocalMediaRef>();
  const seenFiles = new Set<string>();
  const media = value.media.map((item): MediaBackupEntry => {
    if (
      !isRecord(item) ||
      !isLocalMediaRef(item.ref) ||
      typeof item.file !== "string" ||
      !/^media\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.file) ||
      typeof item.contentType !== "string" ||
      item.contentType.length === 0 ||
      typeof item.sourcePath !== "string" ||
      item.sourcePath.length === 0
    ) {
      throw new Error("Backup media manifest entry is malformed");
    }
    if (seenRefs.has(item.ref) || seenFiles.has(item.file)) {
      throw new Error("Backup media manifest contains duplicate entries");
    }
    if (!files[item.file]) {
      throw new Error(`Backup is missing required media file ${item.file}`);
    }
    seenRefs.add(item.ref);
    seenFiles.add(item.file);
    return {
      ref: item.ref,
      file: item.file,
      contentType: item.contentType,
      sourcePath: item.sourcePath,
    };
  });

  if (seenRefs.size !== requiredRefs.size || [...requiredRefs].some((ref) => !seenRefs.has(ref))) {
    throw new Error("Backup media manifest does not resolve every local media reference");
  }
  const archivedMediaFiles = Object.keys(files).filter((name) => name.startsWith("media/"));
  if (
    archivedMediaFiles.length !== seenFiles.size ||
    archivedMediaFiles.some((name) => !seenFiles.has(name))
  ) {
    throw new Error("Backup archive contains media files undeclared by the media manifest");
  }
  return { version: 1, media };
}

async function rollbackStagedMedia(refs: LocalMediaRef[], originalError: unknown): Promise<never> {
  const cleanupResults = await Promise.allSettled(refs.map((ref) => deleteMediaBlob(ref)));
  const cleanupErrors = cleanupResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (cleanupErrors.length > 0) {
    throw errorWithCauses(
      "Import failed and staged media cleanup was incomplete",
      [originalError, ...cleanupErrors],
    );
  }
  throw originalError;
}

export async function exportProjectBackup(projectId: string): Promise<Blob> {
  const record = await loadProjectSnapshot(projectId);
  if (!record) {
    throw new Error("Project not found in this browser");
  }
  validateSnapshot(record.snapshot);

  const projectManifest = strToU8(
    JSON.stringify(
      { version: 1, project: record.snapshot } satisfies ProjectBackupEnvelope,
      null,
      2,
    ),
  );
  const mediaManifest: MediaBackupManifest = { version: 1, media: [] };
  const mediaEntries: BackupBlobEntry[] = [];

  for (const ref of collectLocalMediaRefs(record.snapshot)) {
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
  const files = await extractBackupArchive(file);
  const manifestBytes = files[MANIFEST_NAME];
  if (!manifestBytes) {
    throw new Error("Backup is missing openmontage-project.json");
  }

  const snapshot = validateProjectEnvelope(JSON.parse(strFromU8(manifestBytes)));
  const requiredRefs = collectLocalMediaRefs(snapshot);

  const refMap = new Map<LocalMediaRef, LocalMediaRef>();
  const mediaManifestBytes = files[MEDIA_MANIFEST_NAME];
  if (requiredRefs.size > 0 && !mediaManifestBytes) {
    throw new Error("Backup is missing the media manifest required by local media references");
  }
  if (!mediaManifestBytes && Object.keys(files).some((name) => name.startsWith("media/"))) {
    throw new Error("Backup archive contains media files without a media manifest");
  }
  const mediaManifest = mediaManifestBytes
    ? validateMediaManifest(JSON.parse(strFromU8(mediaManifestBytes)), requiredRefs, files)
    : ({ version: 1, media: [] } satisfies MediaBackupManifest);

  const existing = await loadProjectSnapshot(snapshot.project.id);
  if (existing && !options.overwrite) {
    throw new ProjectImportConflictError(snapshot.project.id);
  }

  const stagedRefs: LocalMediaRef[] = [];
  try {
    for (const entry of mediaManifest.media) {
      const mediaBytes = files[entry.file];
      const restoredRef = await saveMediaBlob({
        projectId: snapshot.project.id,
        sourcePath: entry.sourcePath,
        contentType: entry.contentType,
        blob: new Blob([bytesToArrayBuffer(mediaBytes)], { type: entry.contentType }),
      });
      stagedRefs.push(restoredRef);
      refMap.set(entry.ref, restoredRef);
    }

    const restoredSnapshot =
      refMap.size > 0
        ? (rewriteLocalMediaRefs(snapshot, refMap) as ShortDramaProjectResponse)
        : snapshot;
    validateSnapshot(restoredSnapshot);
    await saveProjectSnapshot(restoredSnapshot);
    return restoredSnapshot;
  } catch (error) {
    return rollbackStagedMedia(stagedRefs, error);
  }
}
