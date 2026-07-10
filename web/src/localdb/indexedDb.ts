import { LOCAL_DB_NAME, LOCAL_DB_VERSION } from "./types";

export const LOCAL_STORES = {
  projects: "projects",
  settings: "settings",
  media: "media",
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
