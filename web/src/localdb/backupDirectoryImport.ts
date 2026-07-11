import {
  BACKUP_LIMITS,
  BACKUP_MEDIA_MANIFEST_NAME,
  BACKUP_PROJECT_MANIFEST_NAME,
  BackupByteAccount,
  BackupValidationError,
  assertSafeBackupPath,
  collectLocalMediaRefs,
  validateBackupManifests,
  validateMediaManifest,
  validateProjectEnvelope,
  type BackupEntryCallbacks,
  type BackupReadProgress,
  type MediaBackupManifest,
  type ValidatedBackup,
  type ValidatedBackupEntry,
} from "./backupFormat";

const DIRECTORY_READ_CHUNK_BYTES = 1024 * 1024;

type SelectedFile = {
  file: File;
  selectionPath: string;
};

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

async function checkedCallback(
  callback: (() => void | Promise<void>) | undefined,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (callback) await callback();
  throwIfAborted(signal);
}

function fileRelativePath(file: File): string {
  return typeof file.webkitRelativePath === "string" ? file.webkitRelativePath : "";
}

function normalizeSelection(files: readonly File[]): {
  mode: "relative-path" | "basename";
  selected: SelectedFile[];
} {
  const useRelativePaths = files.length > 0 && files.every((file) => fileRelativePath(file).length > 0);
  if (!useRelativePaths) {
    const seen = new Set<string>();
    const selected = files.map((file): SelectedFile => {
      assertSafeBackupPath(file.name);
      if (seen.has(file.name)) {
        throw new BackupValidationError(`Backup selection contains duplicate basename ${file.name}`);
      }
      seen.add(file.name);
      return { file, selectionPath: file.name };
    });
    return { mode: "basename", selected };
  }

  const relativePaths = files.map(fileRelativePath);
  for (const path of relativePaths) assertSafeBackupPath(path);
  const roots = relativePaths.map((path) => path.split("/")[0]);
  const commonRoot = roots[0];
  if (!commonRoot || roots.some((root) => root !== commonRoot)) {
    throw new BackupValidationError("Backup directory selection has no single common root");
  }

  const seen = new Set<string>();
  const selected = files.map((file, index): SelectedFile => {
    const segments = relativePaths[index].split("/");
    const selectionPath = segments.slice(1).join("/");
    assertSafeBackupPath(selectionPath);
    if (seen.has(selectionPath)) {
      throw new BackupValidationError(`Backup contains duplicate entry ${selectionPath}`);
    }
    seen.add(selectionPath);
    return { file, selectionPath };
  });
  return { mode: "relative-path", selected };
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("Could not read backup file"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

async function readFileChunks(
  selected: SelectedFile,
  account: BackupByteAccount,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<number> {
  let offset = 0;
  while (true) {
    throwIfAborted(signal);
    const blob = selected.file.slice(offset, offset + DIRECTORY_READ_CHUNK_BYTES);
    if (blob.size === 0) break;
    const chunk = new Uint8Array(await blobToArrayBuffer(blob));
    throwIfAborted(signal);
    if (chunk.byteLength === 0) break;
    account.addActualBytes(selected.selectionPath, chunk.byteLength);
    await checkedCallback(() => onChunk(chunk), signal);
    offset += chunk.byteLength;
  }
  return account.finishEntry(selected.selectionPath, true);
}

async function readManifest(
  selected: SelectedFile,
  account: BackupByteAccount,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  await readFileChunks(selected, account, (chunk) => {
    chunks.push(chunk);
    total += chunk.byteLength;
  }, signal);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseManifest(bytes: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new BackupValidationError(`Backup manifest ${name} contains invalid JSON`, { cause: error });
  }
}

function findRequiredFile(selected: readonly SelectedFile[], path: string): SelectedFile {
  const match = selected.find((item) => item.selectionPath === path);
  if (!match) {
    const label = path === BACKUP_PROJECT_MANIFEST_NAME ? `project manifest ${path}` : path;
    throw new BackupValidationError(`Backup is missing ${label}`);
  }
  return match;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function mediaSelection(
  mode: "relative-path" | "basename",
  selected: readonly SelectedFile[],
  manifest: MediaBackupManifest | undefined,
): { availablePaths: string[]; byPath: Map<string, SelectedFile> } {
  if (mode === "relative-path") {
    const availablePaths = selected
      .map((item) => item.selectionPath)
      .filter((path) => path.startsWith("media/"));
    return {
      availablePaths,
      byPath: new Map(
        selected
          .filter((item) => item.selectionPath.startsWith("media/"))
          .map((item) => [item.selectionPath, item]),
      ),
    };
  }

  const declarations = new Map(
    (manifest?.media ?? []).map((entry) => [basename(entry.file), entry.file]),
  );
  const byPath = new Map<string, SelectedFile>();
  const availablePaths: string[] = [];
  for (const item of selected) {
    if (
      item.selectionPath === BACKUP_PROJECT_MANIFEST_NAME ||
      item.selectionPath === BACKUP_MEDIA_MANIFEST_NAME
    ) {
      continue;
    }
    const logicalPath = declarations.get(item.selectionPath) ?? `media/${item.selectionPath}`;
    availablePaths.push(logicalPath);
    byPath.set(logicalPath, item);
  }
  return { availablePaths, byPath };
}

function rejectUndeclaredSelectionFiles(
  mode: "relative-path" | "basename",
  selected: readonly SelectedFile[],
  manifest: MediaBackupManifest | undefined,
): void {
  const expectedPaths = new Set<string>([
    BACKUP_PROJECT_MANIFEST_NAME,
    ...(selected.some((item) => item.selectionPath === BACKUP_MEDIA_MANIFEST_NAME)
      ? [BACKUP_MEDIA_MANIFEST_NAME]
      : []),
    ...(manifest?.media.map((entry) => (
      mode === "relative-path" ? entry.file : basename(entry.file)
    )) ?? []),
  ]);
  const undeclared = selected.find((item) => !expectedPaths.has(item.selectionPath));
  if (undeclared) {
    throw new BackupValidationError(
      `Backup directory contains undeclared file ${undeclared.selectionPath}`,
    );
  }
}

export async function readBackupDirectory(
  files: Iterable<File> | ArrayLike<File>,
  callbacks: BackupEntryCallbacks,
  signal?: AbortSignal,
): Promise<ValidatedBackup> {
  throwIfAborted(signal);
  const fileArray = Array.from(files);
  if (fileArray.length === 0) {
    throw new BackupValidationError("Backup directory is missing the project manifest");
  }
  if (fileArray.length > BACKUP_LIMITS.maxEntries) {
    throw new BackupValidationError("Backup entry count exceeds the archive entry limit");
  }

  const { mode, selected } = normalizeSelection(fileArray);
  const account = new BackupByteAccount();
  for (const item of selected) account.registerEntry(item.selectionPath, item.file.size);

  const projectFile = findRequiredFile(selected, BACKUP_PROJECT_MANIFEST_NAME);
  const mediaManifestFile = selected.find(
    (item) => item.selectionPath === BACKUP_MEDIA_MANIFEST_NAME,
  );
  const projectBytes = await readManifest(projectFile, account, signal);
  const projectValue = parseManifest(projectBytes, BACKUP_PROJECT_MANIFEST_NAME);
  const project = validateProjectEnvelope(projectValue);

  let mediaManifestBytes: Uint8Array | undefined;
  let mediaManifestValue: unknown | undefined;
  let preliminaryMediaManifest: MediaBackupManifest | undefined;
  if (mediaManifestFile) {
    mediaManifestBytes = await readManifest(mediaManifestFile, account, signal);
    mediaManifestValue = parseManifest(mediaManifestBytes, BACKUP_MEDIA_MANIFEST_NAME);
    preliminaryMediaManifest = validateMediaManifest(
      mediaManifestValue,
      collectLocalMediaRefs(project),
    );
  }

  rejectUndeclaredSelectionFiles(mode, selected, preliminaryMediaManifest);
  const mediaFiles = mediaSelection(mode, selected, preliminaryMediaManifest);
  const validated = validateBackupManifests(
    projectValue,
    mediaManifestValue,
    mediaFiles.availablePaths,
  );

  const entries: ValidatedBackupEntry[] = [{
    name: BACKUP_PROJECT_MANIFEST_NAME,
    kind: "project-manifest",
    sizeBytes: projectBytes.byteLength,
    projectId: validated.project.project.id,
    project: validated.project,
  }];
  if (mediaManifestBytes) {
    entries.push({
      name: BACKUP_MEDIA_MANIFEST_NAME,
      kind: "media-manifest",
      sizeBytes: mediaManifestBytes.byteLength,
      projectId: validated.project.project.id,
      mediaManifest: validated.mediaManifest,
    });
  }
  for (const media of validated.mediaManifest.media) {
    const file = mediaFiles.byPath.get(media.file);
    if (!file) throw new BackupValidationError(`Backup is missing required media file ${media.file}`);
    entries.push({
      name: media.file,
      kind: "media",
      sizeBytes: file.file.size,
      projectId: validated.project.project.id,
      media,
    });
  }

  const result: ValidatedBackup = {
    project: validated.project,
    mediaManifest: validated.mediaManifest,
    entries,
  };
  const totalBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
  let bytesRead = 0;
  let entriesRead = 0;
  const reportProgress = async () => {
    const progress: BackupReadProgress = {
      bytesRead,
      totalBytes,
      entriesRead,
      totalEntries: entries.length,
    };
    await checkedCallback(() => callbacks.onProgress?.(progress), signal);
  };

  const emitBufferedEntry = async (entry: ValidatedBackupEntry, bytes: Uint8Array) => {
    await checkedCallback(() => callbacks.onEntryStart?.(entry), signal);
    if (bytes.byteLength > 0) {
      await checkedCallback(() => callbacks.onEntryChunk?.(entry, bytes), signal);
      bytesRead += bytes.byteLength;
      await reportProgress();
    }
    await checkedCallback(() => callbacks.onEntryEnd?.(entry, bytes.byteLength), signal);
    entriesRead += 1;
    await reportProgress();
  };

  await emitBufferedEntry(entries[0], projectBytes);
  let nextEntryIndex = 1;
  if (mediaManifestBytes) {
    await emitBufferedEntry(entries[nextEntryIndex], mediaManifestBytes);
    nextEntryIndex += 1;
  }
  for (; nextEntryIndex < entries.length; nextEntryIndex += 1) {
    const entry = entries[nextEntryIndex];
    const selectedMedia = mediaFiles.byPath.get(entry.name);
    if (!selectedMedia) {
      throw new BackupValidationError(`Backup is missing required media file ${entry.name}`);
    }
    await checkedCallback(() => callbacks.onEntryStart?.(entry), signal);
    const actualBytes = await readFileChunks(selectedMedia, account, async (chunk) => {
      await checkedCallback(() => callbacks.onEntryChunk?.(entry, chunk), signal);
      bytesRead += chunk.byteLength;
      await reportProgress();
    }, signal);
    await checkedCallback(() => callbacks.onEntryEnd?.(entry, actualBytes), signal);
    entriesRead += 1;
    await reportProgress();
  }
  await checkedCallback(() => callbacks.onComplete?.(result), signal);
  return result;
}
