import type { ShortDramaProjectResponse } from "../domain/types";
import { LOCAL_STORES, openLocalDb } from "./indexedDb";
import type { LocalProjectSnapshot, LocalProjectSummary, LocalSettingsRecord } from "./types";

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

function toLocalProjectSnapshot(snapshot: ShortDramaProjectResponse): LocalProjectSnapshot {
  return {
    id: snapshot.project.id,
    title: snapshot.project.title,
    updatedAt: new Date().toISOString(),
    snapshot,
  };
}

async function loadRecentProjectId(): Promise<string | null> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.settings, "readonly");
  const setting = await requestToPromise<LocalSettingsRecord | undefined>(
    tx.objectStore(LOCAL_STORES.settings).get("recentProjectId"),
  );
  return setting?.value ?? null;
}

export async function saveProjectSnapshot(snapshot: ShortDramaProjectResponse): Promise<void> {
  const db = await openLocalDb();
  const tx = db.transaction([LOCAL_STORES.projects, LOCAL_STORES.settings], "readwrite");
  tx.objectStore(LOCAL_STORES.projects).put(toLocalProjectSnapshot(snapshot));
  tx.objectStore(LOCAL_STORES.settings).put({
    key: "recentProjectId",
    value: snapshot.project.id,
  } satisfies LocalSettingsRecord);
  await transactionDone(tx);
}

export async function setRecentProjectId(projectId: string | null): Promise<void> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.settings, "readwrite");
  tx.objectStore(LOCAL_STORES.settings).put({
    key: "recentProjectId",
    value: projectId,
  } satisfies LocalSettingsRecord);
  await transactionDone(tx);
}

export async function loadProjectSnapshot(projectId: string): Promise<LocalProjectSnapshot | null> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.projects, "readonly");
  const value = await requestToPromise<LocalProjectSnapshot | undefined>(
    tx.objectStore(LOCAL_STORES.projects).get(projectId),
  );
  return value ?? null;
}

export async function loadRecentProjectSnapshot(): Promise<LocalProjectSnapshot | null> {
  const recentProjectId = await loadRecentProjectId();
  if (!recentProjectId) {
    return null;
  }
  return loadProjectSnapshot(recentProjectId);
}

export async function listProjectSummaries(): Promise<LocalProjectSummary[]> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.projects, "readonly");
  const records = await requestToPromise<LocalProjectSnapshot[]>(
    tx.objectStore(LOCAL_STORES.projects).getAll(),
  );

  return records
    .map((record) => ({
      id: record.id,
      title: record.title,
      updatedAt: record.updatedAt,
      shotCount: record.snapshot.storyboard.shots.length,
      hasFinalRender: Boolean(record.snapshot.final_path),
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function deleteProject(projectId: string): Promise<void> {
  const recentProjectId = await loadRecentProjectId();
  const db = await openLocalDb();
  const tx = db.transaction([LOCAL_STORES.projects, LOCAL_STORES.settings], "readwrite");
  tx.objectStore(LOCAL_STORES.projects).delete(projectId);
  if (recentProjectId === projectId) {
    tx.objectStore(LOCAL_STORES.settings).put({
      key: "recentProjectId",
      value: null,
    } satisfies LocalSettingsRecord);
  }
  await transactionDone(tx);
}
