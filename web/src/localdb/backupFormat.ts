import type { ShortDramaProjectResponse } from "../domain/types";
import { normalizeAndValidateProjectSnapshot } from "./snapshotSchema";
import type { LocalMediaRef } from "./types";

export const MANIFEST_NAME = "openmontage-project.json";
export const MEDIA_MANIFEST_NAME = "openmontage-media.json";
export const LOCAL_MEDIA_PREFIX = "local://media/";

const MIB = 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 512 * MIB;
export const MAX_ARCHIVE_ENTRIES = 512;
export const MAX_ENTRY_BYTES = 256 * MIB;
export const MAX_MANIFEST_BYTES = 8 * MIB;
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 1024 * MIB;

export const BACKUP_PROJECT_MANIFEST_NAME = MANIFEST_NAME;
export const BACKUP_MEDIA_MANIFEST_NAME = MEDIA_MANIFEST_NAME;

export type BackupLimits = {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxManifestBytes: number;
  maxTotalBytes: number;
};

export const BACKUP_LIMITS: Readonly<BackupLimits> = Object.freeze({
  maxArchiveBytes: MAX_ARCHIVE_BYTES,
  maxEntries: MAX_ARCHIVE_ENTRIES,
  maxEntryBytes: MAX_ENTRY_BYTES,
  maxManifestBytes: MAX_MANIFEST_BYTES,
  maxTotalBytes: MAX_TOTAL_UNCOMPRESSED_BYTES,
});

export class BackupValidationError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BackupValidationError";
    if (options && Object.prototype.hasOwnProperty.call(options, "cause")) {
      this.cause = options.cause;
    }
  }
}

export type MediaBackupEntry = {
  ref: LocalMediaRef;
  file: string;
  contentType: string;
  sourcePath: string;
};

export type MediaBackupManifest = {
  version: 1;
  media: MediaBackupEntry[];
};

export type ProjectBackupEnvelope = {
  version: 1;
  project: ShortDramaProjectResponse;
};

type ValidatedBackupEntryBase = {
  name: string;
  sizeBytes: number;
  projectId: string;
};

export type ValidatedBackupEntry =
  | (ValidatedBackupEntryBase & {
    kind: "project-manifest";
    project: ShortDramaProjectResponse;
  })
  | (ValidatedBackupEntryBase & {
    kind: "media-manifest";
    mediaManifest: MediaBackupManifest;
  })
  | (ValidatedBackupEntryBase & {
    kind: "media";
    media: MediaBackupEntry;
  });

export type ValidatedBackup = {
  project: ShortDramaProjectResponse;
  mediaManifest: MediaBackupManifest;
  entries: ValidatedBackupEntry[];
};

export type BackupReadProgress = {
  bytesRead: number;
  totalBytes: number;
  entriesRead: number;
  totalEntries: number;
};

type MaybePromise<T> = T | Promise<T>;

export type BackupEntryCallbacks = {
  onEntryStart?: (entry: ValidatedBackupEntry) => MaybePromise<void>;
  onEntryChunk?: (entry: ValidatedBackupEntry, chunk: Uint8Array) => MaybePromise<void>;
  onEntryEnd?: (entry: ValidatedBackupEntry, actualBytes: number) => MaybePromise<void>;
  onProgress?: (progress: BackupReadProgress) => MaybePromise<void>;
  onComplete?: (backup: ValidatedBackup) => MaybePromise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validationError(message: string, cause?: unknown): BackupValidationError {
  return cause === undefined
    ? new BackupValidationError(message)
    : new BackupValidationError(message, { cause });
}

export function isSafeBackupPath(path: string): boolean {
  if (
    !path ||
    path.length > 256 ||
    path.startsWith("/") ||
    /^[A-Za-z]:\//.test(path) ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    return false;
  }
  return path.split("/").every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

export const isSafeArchiveEntryName = isSafeBackupPath;

export function assertSafeBackupPath(path: string): void {
  if (!isSafeBackupPath(path)) {
    throw validationError(`Backup path ${path || "<empty>"} is unsafe`);
  }
}

export function shouldRetainBackupPath(path: string): boolean {
  return (
    path === BACKUP_PROJECT_MANIFEST_NAME ||
    path === BACKUP_MEDIA_MANIFEST_NAME ||
    path.startsWith("media/")
  );
}

export const shouldRetainArchiveEntry = shouldRetainBackupPath;

export function backupEntryByteLimit(
  path: string,
  limits: Readonly<BackupLimits> = BACKUP_LIMITS,
): number {
  return path === BACKUP_PROJECT_MANIFEST_NAME || path === BACKUP_MEDIA_MANIFEST_NAME
    ? limits.maxManifestBytes
    : limits.maxEntryBytes;
}

export const archiveEntryByteLimit = backupEntryByteLimit;

export function backupEntryLimitError(path: string): BackupValidationError {
  return path === BACKUP_PROJECT_MANIFEST_NAME || path === BACKUP_MEDIA_MANIFEST_NAME
    ? validationError(`Backup manifest ${path} exceeds the JSON manifest size limit`)
    : validationError(`Backup entry ${path} exceeds the per-entry size limit`);
}

export const archiveEntryLimitError = backupEntryLimitError;

type AccountedEntry = {
  declaredBytes: number | null;
  actualBytes: number;
  finished: boolean;
};

export class BackupByteAccount {
  readonly limits: Readonly<BackupLimits>;
  private readonly entries = new Map<string, AccountedEntry>();
  private declaredTotal = 0;
  private actualTotal = 0;

  constructor(limits: Partial<BackupLimits> = {}) {
    this.limits = Object.freeze({ ...BACKUP_LIMITS, ...limits });
  }

  registerEntry(path: string, declaredBytes: number | null = null): void {
    assertSafeBackupPath(path);
    if (this.entries.has(path)) {
      throw validationError(`Backup contains duplicate entry ${path}`);
    }
    if (this.entries.size >= this.limits.maxEntries) {
      throw validationError("Backup entry count exceeds the archive entry limit");
    }
    if (
      declaredBytes !== null &&
      (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)
    ) {
      throw validationError(`Backup entry ${path} has an invalid declared size`);
    }
    if (declaredBytes !== null && declaredBytes > backupEntryByteLimit(path, this.limits)) {
      throw backupEntryLimitError(path);
    }
    const nextDeclaredTotal = this.declaredTotal + (declaredBytes ?? 0);
    if (!Number.isSafeInteger(nextDeclaredTotal) || nextDeclaredTotal > this.limits.maxTotalBytes) {
      throw validationError("Backup total uncompressed size exceeds the limit");
    }
    this.declaredTotal = nextDeclaredTotal;
    this.entries.set(path, { declaredBytes, actualBytes: 0, finished: false });
  }

  addActualBytes(path: string, byteLength: number): void {
    const entry = this.entries.get(path);
    if (!entry) {
      throw validationError(`Backup entry ${path} was not registered`);
    }
    if (entry.finished) {
      throw validationError(`Backup entry ${path} is already complete`);
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw validationError(`Backup entry ${path} produced an invalid byte count`);
    }
    const nextEntryBytes = entry.actualBytes + byteLength;
    if (
      !Number.isSafeInteger(nextEntryBytes) ||
      nextEntryBytes > backupEntryByteLimit(path, this.limits)
    ) {
      throw backupEntryLimitError(path);
    }
    const nextActualTotal = this.actualTotal + byteLength;
    if (!Number.isSafeInteger(nextActualTotal) || nextActualTotal > this.limits.maxTotalBytes) {
      throw validationError("Backup total uncompressed size exceeds the limit");
    }
    entry.actualBytes = nextEntryBytes;
    this.actualTotal = nextActualTotal;
  }

  finishEntry(path: string, requireDeclaredMatch = false): number {
    const entry = this.entries.get(path);
    if (!entry) {
      throw validationError(`Backup entry ${path} was not registered`);
    }
    if (entry.finished) {
      throw validationError(`Backup entry ${path} is already complete`);
    }
    if (
      requireDeclaredMatch &&
      entry.declaredBytes !== null &&
      entry.actualBytes !== entry.declaredBytes
    ) {
      throw validationError(`Backup entry ${path} actual byte length does not match its file size`);
    }
    entry.finished = true;
    return entry.actualBytes;
  }
}

export function isLocalMediaRef(value: unknown): value is LocalMediaRef {
  return (
    typeof value === "string" &&
    /^local:\/\/media\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  );
}

export function collectLocalMediaRefs(
  value: unknown,
  refs = new Set<LocalMediaRef>(),
): Set<LocalMediaRef> {
  if (isLocalMediaRef(value)) {
    refs.add(value);
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLocalMediaRefs(item, refs);
    return refs;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectLocalMediaRefs(item, refs);
  }
  return refs;
}

export function rewriteLocalMediaRefs(
  value: unknown,
  refMap: Map<LocalMediaRef, LocalMediaRef>,
): unknown {
  if (isLocalMediaRef(value)) return refMap.get(value) ?? value;
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

export function mediaIdFromRef(ref: LocalMediaRef): string {
  return ref.slice(LOCAL_MEDIA_PREFIX.length);
}

function validateLocalMediaRefs(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (value.startsWith(LOCAL_MEDIA_PREFIX) && !isLocalMediaRef(value)) {
      throw validationError(`Local media reference ${value} is malformed`);
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

export function normalizeAndValidateBackupSnapshot(value: unknown): ShortDramaProjectResponse {
  try {
    const normalized = normalizeAndValidateProjectSnapshot(value);
    validateLocalMediaRefs(normalized);
    return normalized;
  } catch (error) {
    if (error instanceof BackupValidationError) throw error;
    const message = error instanceof Error ? error.message : "Backup project metadata is invalid";
    throw validationError(message, error);
  }
}

export const normalizeAndValidateSnapshot = normalizeAndValidateBackupSnapshot;

export function validateProjectEnvelope(value: unknown): ShortDramaProjectResponse {
  if (!isRecord(value)) {
    throw validationError("Backup format version is unsupported");
  }
  if (!Object.prototype.hasOwnProperty.call(value, "version")) {
    const isLegacySnapshot = isRecord(value.project) && typeof value.project.id === "string";
    if (!isLegacySnapshot) throw validationError("Backup format version is unsupported");
    return normalizeAndValidateBackupSnapshot(value);
  }
  if (value.version !== 1) {
    throw validationError("Backup format version is unsupported");
  }
  return normalizeAndValidateBackupSnapshot(value.project);
}

export function validateMediaManifest(
  value: unknown,
  requiredRefs: ReadonlySet<LocalMediaRef>,
  availableMediaPaths?: Iterable<string>,
): MediaBackupManifest {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.media)) {
    throw validationError("Backup media manifest is invalid or unsupported");
  }

  const seenRefs = new Set<LocalMediaRef>();
  const seenFiles = new Set<string>();
  const media = value.media.map((item): MediaBackupEntry => {
    if (
      !isRecord(item) ||
      !isLocalMediaRef(item.ref) ||
      typeof item.file !== "string" ||
      !/^media\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.file) ||
      !isSafeBackupPath(item.file) ||
      typeof item.contentType !== "string" ||
      item.contentType.length === 0 ||
      typeof item.sourcePath !== "string" ||
      item.sourcePath.length === 0
    ) {
      throw validationError("Backup media manifest entry is malformed");
    }
    if (seenRefs.has(item.ref) || seenFiles.has(item.file)) {
      throw validationError("Backup media manifest contains duplicate entries");
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
    throw validationError("Backup media manifest does not resolve every local media reference");
  }

  if (availableMediaPaths !== undefined) {
    const available = new Set<string>();
    for (const path of availableMediaPaths) {
      assertSafeBackupPath(path);
      if (!path.startsWith("media/")) continue;
      if (available.has(path)) {
        throw validationError(`Backup contains duplicate entry ${path}`);
      }
      available.add(path);
    }
    const missing = [...seenFiles].find((path) => !available.has(path));
    if (missing) throw validationError(`Backup is missing required media file ${missing}`);
    const undeclared = [...available].find((path) => !seenFiles.has(path));
    if (undeclared) {
      throw validationError("Backup contains media files undeclared by the media manifest");
    }
  }
  return { version: 1, media };
}

export function validateBackupManifests(
  projectEnvelope: unknown,
  mediaManifestValue: unknown | undefined,
  retainedPaths: Iterable<string>,
): Pick<ValidatedBackup, "project" | "mediaManifest"> {
  const project = validateProjectEnvelope(projectEnvelope);
  const requiredRefs = collectLocalMediaRefs(project);
  const mediaPaths = [...retainedPaths].filter((path) => path.startsWith("media/"));
  if (requiredRefs.size > 0 && mediaManifestValue === undefined) {
    throw validationError("Backup is missing the media manifest required by local media references");
  }
  if (mediaManifestValue === undefined && mediaPaths.length > 0) {
    throw validationError("Backup contains media files without a media manifest");
  }
  const mediaManifest = mediaManifestValue === undefined
    ? ({ version: 1, media: [] } satisfies MediaBackupManifest)
    : validateMediaManifest(mediaManifestValue, requiredRefs, mediaPaths);
  return { project, mediaManifest };
}
