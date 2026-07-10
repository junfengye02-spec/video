import { LOCAL_STORES, openLocalDb } from "./indexedDb";
import type { LocalMediaRecord, LocalMediaRef } from "./types";

type SaveMediaInput = {
  projectId: string;
  sourcePath: string;
  contentType: string;
  blob: Blob;
};

type StorageWithOpfs = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
};

const LOCAL_MEDIA_PREFIX = "local://media/";
const OPFS_MEDIA_DIR = "openmontage-media";

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

function mediaIdFromRef(ref: LocalMediaRef): string {
  return ref.slice(LOCAL_MEDIA_PREFIX.length);
}

function createMediaId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeBlob(blob: Blob, contentType: string): Blob {
  if (!contentType || blob.type === contentType || typeof blob.slice !== "function") {
    return blob;
  }
  return blob.slice(0, blob.size, contentType);
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
      reject(new Error("Could not read media blob"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

async function compatibilityBlobBytes(blob: Blob): Promise<ArrayBuffer | undefined> {
  if (typeof blob.arrayBuffer === "function") {
    return undefined;
  }
  try {
    return await blobToArrayBuffer(blob);
  } catch {
    return undefined;
  }
}

function isUsableBlob(value: unknown): value is Blob {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Blob).size === "number" &&
    typeof (value as Blob).slice === "function"
  );
}

async function saveRecord(record: LocalMediaRecord): Promise<void> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.media, "readwrite");
  tx.objectStore(LOCAL_STORES.media).put(record);
  await transactionDone(tx);
}

async function deleteRecord(id: string): Promise<void> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.media, "readwrite");
  tx.objectStore(LOCAL_STORES.media).delete(id);
  await transactionDone(tx);
}

async function loadRecord(id: string): Promise<LocalMediaRecord | null> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.media, "readonly");
  const record = await requestToPromise<LocalMediaRecord | undefined>(
    tx.objectStore(LOCAL_STORES.media).get(id),
  );
  return record ?? null;
}

async function writeBlobToOpfs(id: string, blob: Blob): Promise<string | null> {
  const storage = navigator.storage as StorageWithOpfs | undefined;
  if (!storage?.getDirectory) {
    return null;
  }

  try {
    const root = await storage.getDirectory();
    const mediaDir = await root.getDirectoryHandle(OPFS_MEDIA_DIR, { create: true });
    const fileHandle = await mediaDir.getFileHandle(id, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    return `${OPFS_MEDIA_DIR}/${id}`;
  } catch {
    return null;
  }
}

async function readBlobFromOpfs(record: LocalMediaRecord): Promise<Blob | null> {
  if (!record.opfsPath) {
    return null;
  }
  const storage = navigator.storage as StorageWithOpfs | undefined;
  if (!storage?.getDirectory) {
    return null;
  }

  try {
    const [, fileName] = record.opfsPath.split("/");
    if (!fileName) {
      return null;
    }
    const root = await storage.getDirectory();
    const mediaDir = await root.getDirectoryHandle(OPFS_MEDIA_DIR);
    const fileHandle = await mediaDir.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return normalizeBlob(file, record.contentType);
  } catch {
    return null;
  }
}

async function deleteBlobFromOpfs(record: LocalMediaRecord): Promise<void> {
  if (!record.opfsPath) {
    return;
  }
  const storage = navigator.storage as StorageWithOpfs | undefined;
  if (!storage?.getDirectory) {
    throw new Error("OPFS is unavailable for media cleanup");
  }

  const [directory, fileName, ...extraSegments] = record.opfsPath.split("/");
  if (directory !== OPFS_MEDIA_DIR || !fileName || extraSegments.length > 0) {
    throw new Error("Stored OPFS media path is invalid");
  }
  const root = await storage.getDirectory();
  const mediaDir = await root.getDirectoryHandle(OPFS_MEDIA_DIR);
  try {
    await mediaDir.removeEntry(fileName);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return;
    }
    throw error;
  }
}

export async function saveMediaBlob(input: SaveMediaInput): Promise<LocalMediaRef> {
  const id = createMediaId();
  const blob = normalizeBlob(input.blob, input.contentType);
  const createdAt = new Date().toISOString();
  const opfsPath = await writeBlobToOpfs(id, blob);
  const blobBytes = opfsPath ? undefined : await compatibilityBlobBytes(blob);

  const record: LocalMediaRecord = opfsPath
    ? {
        id,
        projectId: input.projectId,
        sourcePath: input.sourcePath,
        contentType: blob.type || input.contentType || "application/octet-stream",
        sizeBytes: blob.size,
        createdAt,
        storage: "opfs",
        opfsPath,
      }
    : {
        id,
        projectId: input.projectId,
        sourcePath: input.sourcePath,
        contentType: blob.type || input.contentType || "application/octet-stream",
        sizeBytes: blob.size,
        createdAt,
        storage: "indexeddb",
        blob,
        blobBytes,
      };

  try {
    await saveRecord(record);
  } catch (error) {
    if (opfsPath) {
      try {
        await deleteBlobFromOpfs(record);
      } catch {
        // Preserve the original persistence error; the unindexed OPFS file is not addressable.
      }
    }
    throw error;
  }
  return `${LOCAL_MEDIA_PREFIX}${id}`;
}

export async function loadMediaBlob(ref: LocalMediaRef): Promise<Blob | null> {
  const record = await loadRecord(mediaIdFromRef(ref));
  if (!record) {
    return null;
  }
  if (record.storage === "opfs") {
    return readBlobFromOpfs(record);
  }
  if (isUsableBlob(record.blob)) {
    return normalizeBlob(record.blob, record.contentType);
  }
  if (record.blobBytes) {
    return new Blob([record.blobBytes], { type: record.contentType });
  }
  return null;
}

export async function deleteMediaBlob(ref: LocalMediaRef): Promise<void> {
  const id = mediaIdFromRef(ref);
  const record = await loadRecord(id);
  if (!record) {
    return;
  }
  if (record.storage === "opfs") {
    await deleteBlobFromOpfs(record);
  }
  await deleteRecord(id);
}

export async function cacheRemoteMedia(
  url: string,
  metadata: { projectId: string; sourcePath: string },
): Promise<LocalMediaRef | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    return await saveMediaBlob({
      projectId: metadata.projectId,
      sourcePath: metadata.sourcePath,
      contentType: blob.type || response.headers.get("content-type") || "application/octet-stream",
      blob,
    });
  } catch {
    return null;
  }
}
