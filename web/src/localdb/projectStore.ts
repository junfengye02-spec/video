import type { ShortDramaProjectResponse } from "../domain/types";
import { LOCAL_STORES, openLocalDb } from "./indexedDb";
import { deleteMediaBlob } from "./mediaStore";
import type {
  LocalMediaRecord,
  LocalMediaRef,
  LocalProjectSnapshot,
  LocalProjectSummary,
  LocalSettingsRecord,
} from "./types";

const LOCAL_MEDIA_PREFIX = "local://media/";

function cleanupError(message: string, causes: unknown[]): Error {
  const error = new Error(message) as Error & { causes: unknown[] };
  error.causes = causes;
  return error;
}

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

function isLocalMediaRef(value: unknown): value is LocalMediaRef {
  return (
    typeof value === "string" &&
    /^local:\/\/media\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  );
}

function collectLocalMediaRefs(value: unknown, refs = new Set<LocalMediaRef>()): Set<LocalMediaRef> {
  if (isLocalMediaRef(value)) {
    refs.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectLocalMediaRefs(item, refs);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectLocalMediaRefs(item, refs);
  }
  return refs;
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
  const db = await openLocalDb();
  const tx = db.transaction(
    [LOCAL_STORES.projects, LOCAL_STORES.settings, LOCAL_STORES.media],
    "readwrite",
  );
  const done = transactionDone(tx);
  const projectStore = tx.objectStore(LOCAL_STORES.projects);
  const settingsStore = tx.objectStore(LOCAL_STORES.settings);
  const mediaStore = tx.objectStore(LOCAL_STORES.media);
  const [recentSetting, projects, projectMedia] = await Promise.all([
    requestToPromise<LocalSettingsRecord | undefined>(settingsStore.get("recentProjectId")),
    requestToPromise<LocalProjectSnapshot[]>(projectStore.getAll()),
    requestToPromise<LocalMediaRecord[]>(
      mediaStore.index("projectId").getAll(IDBKeyRange.only(projectId)),
    ),
  ]);

  const sharedRefs = new Set<LocalMediaRef>();
  for (const project of projects) {
    if (project.id !== projectId) {
      collectLocalMediaRefs(project.snapshot, sharedRefs);
    }
  }
  const removableMedia = projectMedia.filter(
    (record) => !sharedRefs.has(`${LOCAL_MEDIA_PREFIX}${record.id}` as LocalMediaRef),
  );

  projectStore.delete(projectId);
  const recentProjectId = recentSetting?.value ?? null;
  if (recentProjectId === projectId) {
    settingsStore.put({
      key: "recentProjectId",
      value: null,
    } satisfies LocalSettingsRecord);
  }
  for (const media of removableMedia) {
    if (media.storage === "indexeddb") {
      mediaStore.delete(media.id);
    }
  }
  await done;

  const cleanupResults = await Promise.allSettled(
    removableMedia
      .filter((media) => media.storage === "opfs")
      .map((media) => deleteMediaBlob(`${LOCAL_MEDIA_PREFIX}${media.id}` as LocalMediaRef)),
  );
  const cleanupErrors = cleanupResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (cleanupErrors.length > 0) {
    throw cleanupError(
      "Project was deleted, but OPFS media cleanup was incomplete",
      cleanupErrors,
    );
  }
}
