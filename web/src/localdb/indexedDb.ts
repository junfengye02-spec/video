import { LOCAL_DB_NAME, LOCAL_DB_VERSION } from "./types";

export const LOCAL_STORES = {
  projects: "projects",
  settings: "settings",
  media: "media",
  mediaPending: "mediaPending",
  mediaOperations: "mediaOperations",
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;
let dbInstance: IDBDatabase | null = null;

export function openLocalDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_STORES.projects)) {
        db.createObjectStore(LOCAL_STORES.projects, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(LOCAL_STORES.settings)) {
        db.createObjectStore(LOCAL_STORES.settings, { keyPath: "key" });
      }
      const mediaStore = db.objectStoreNames.contains(LOCAL_STORES.media)
        ? request.transaction!.objectStore(LOCAL_STORES.media)
        : db.createObjectStore(LOCAL_STORES.media, { keyPath: "id" });
      if (!mediaStore.indexNames.contains("projectId")) {
        mediaStore.createIndex("projectId", "projectId", { unique: false });
      }
      if (!mediaStore.indexNames.contains("projectSource")) {
        mediaStore.createIndex("projectSource", ["projectId", "sourcePath"], { unique: false });
      }
      const legacyMediaCursor = mediaStore.openCursor();
      legacyMediaCursor.onsuccess = () => {
        const cursor = legacyMediaCursor.result;
        if (!cursor) return;
        const record = cursor.value as Record<string, unknown>;
        if (!("state" in record) || !("importSessionId" in record)) {
          cursor.update({
            ...record,
            state: record.state ?? "committed",
            importSessionId: record.importSessionId ?? null,
          });
        }
        cursor.continue();
      };
      if (!db.objectStoreNames.contains(LOCAL_STORES.mediaPending)) {
        db.createObjectStore(LOCAL_STORES.mediaPending, { keyPath: "id" });
      }
      const operationStore = db.objectStoreNames.contains(LOCAL_STORES.mediaOperations)
        ? request.transaction!.objectStore(LOCAL_STORES.mediaOperations)
        : db.createObjectStore(LOCAL_STORES.mediaOperations, { keyPath: "id" });
      if (!operationStore.indexNames.contains("projectId")) {
        operationStore.createIndex("projectId", "projectId", { unique: false });
      }
      if (!operationStore.indexNames.contains("nextAttemptAt")) {
        operationStore.createIndex("nextAttemptAt", "nextAttemptAt", { unique: false });
      }
      if (!operationStore.indexNames.contains("leaseExpiresAt")) {
        operationStore.createIndex("leaseExpiresAt", "leaseExpiresAt", { unique: false });
      }
    };

    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
    request.onsuccess = () => {
      dbInstance = request.result;
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
        dbPromise = null;
      };
      resolve(request.result);
    };
  });

  return dbPromise;
}

export function resetLocalDbForTests(): void {
  dbInstance?.close();
  dbInstance = null;
  dbPromise = null;
}
