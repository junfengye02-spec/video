import type { ShortDramaProjectResponse } from "../domain/types";
import { LOCAL_STORES, openLocalDb } from "./indexedDb";
import {
  createMediaImportSession,
  markMediaOperationCleanupDue,
} from "./mediaJournal";
import { runMediaRecovery } from "./mediaStore";
import type {
  LocalMediaRecord,
  LocalMediaRef,
  LocalProjectSnapshot,
  LocalProjectSummary,
  LocalProjectVersion,
  LocalSettingsRecord,
  MediaImportSessionRecord,
  MediaJournalRecord,
  MediaOperationRecord,
} from "./types";

const LOCAL_MEDIA_PREFIX = "local://media/";

type VersionedLocalProjectSnapshot = LocalProjectSnapshot & LocalProjectVersion;

export class ProjectImportConflictError extends Error {
  readonly projectId: string;

  constructor(projectId: string) {
    super(`Project ${projectId} already exists; explicit overwrite permission is required`);
    this.name = "ProjectImportConflictError";
    this.projectId = projectId;
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function runTransaction<T>(tx: IDBTransaction, work: () => Promise<T>): Promise<T> {
  const done = transactionDone(tx);
  try {
    const result = await work();
    await done;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already have completed or aborted.
    }
    await done.catch(() => undefined);
    throw error;
  }
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanupDue<T extends MediaJournalRecord>(record: T, timestamp: string): T {
  if (record.state === "cleanup_due") return record;
  return {
    ...record,
    state: "cleanup_due",
    updatedAt: timestamp,
    nextAttemptAt: timestamp,
    leaseOwner: null,
    leaseExpiresAt: null,
  } as T;
}

function hasActiveLease(
  record: MediaJournalRecord,
  expectedOwner: string,
  now: Date,
): boolean {
  if (record.leaseOwner !== expectedOwner || !record.leaseExpiresAt) return false;
  const expiresAt = Date.parse(record.leaseExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.oncomplete = () => resolve();
  });
}

function normalizeProjectRevision(record: LocalProjectSnapshot): number {
  return Number.isSafeInteger(record.revision) && (record.revision ?? -1) >= 0
    ? record.revision as number
    : 0;
}

function normalizeProjectIncarnation(record: LocalProjectSnapshot): string {
  const incarnation = record.incarnation?.trim();
  return incarnation || `legacy:${record.id}`;
}

function normalizeProjectVersion(record: LocalProjectSnapshot): LocalProjectVersion {
  return {
    incarnation: normalizeProjectIncarnation(record),
    revision: normalizeProjectRevision(record),
  };
}

function normalizeProjectSnapshot(record: LocalProjectSnapshot): VersionedLocalProjectSnapshot {
  return { ...record, ...normalizeProjectVersion(record) };
}

function toLocalProjectSnapshot(
  snapshot: ShortDramaProjectResponse,
  version: LocalProjectVersion,
): VersionedLocalProjectSnapshot {
  return {
    id: snapshot.project.id,
    title: snapshot.project.title,
    updatedAt: new Date().toISOString(),
    ...version,
    snapshot,
  };
}

function freshProjectVersion(): LocalProjectVersion {
  return { incarnation: createId(), revision: 1 };
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

async function retirePriorProjectState(
  tx: IDBTransaction,
  projectId: string,
  acceptedSessionId: string | null,
  acceptedMediaIds: Set<string>,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const projectStore = tx.objectStore(LOCAL_STORES.projects);
  const mediaStore = tx.objectStore(LOCAL_STORES.media);
  const operationStore = tx.objectStore(LOCAL_STORES.mediaOperations);
  const [projects, projectMedia, projectOperations] = await Promise.all([
    requestToPromise<LocalProjectSnapshot[]>(projectStore.getAll()),
    requestToPromise<LocalMediaRecord[]>(
      mediaStore.index("projectId").getAll(IDBKeyRange.only(projectId)),
    ),
    requestToPromise<MediaJournalRecord[]>(
      operationStore.index("projectId").getAll(IDBKeyRange.only(projectId)),
    ),
  ]);

  const sharedOwners = new Map<LocalMediaRef, VersionedLocalProjectSnapshot>();
  for (const project of projects) {
    if (project.id === projectId) continue;
    const normalized = normalizeProjectSnapshot(project);
    for (const ref of collectLocalMediaRefs(project.snapshot)) {
      if (!sharedOwners.has(ref)) sharedOwners.set(ref, normalized);
    }
  }

  const mediaOperations = new Map(
    projectOperations
      .filter((record): record is MediaOperationRecord => record.kind === "media_write")
      .map((record) => [record.mediaId, record]),
  );
  const importSessions = new Set(projectOperations
    .filter((record): record is MediaImportSessionRecord => record.kind === "import_session")
    .map((record) => record.id));

  for (const operation of projectOperations) {
    if (operation.id !== acceptedSessionId) {
      operationStore.put(cleanupDue(operation, timestamp));
    }
  }

  for (const media of projectMedia) {
    if (
      acceptedSessionId
      && acceptedMediaIds.has(media.id)
      && media.importSessionId === acceptedSessionId
    ) {
      continue;
    }

    const ref = `${LOCAL_MEDIA_PREFIX}${media.id}` as LocalMediaRef;
    const sharedOwner = media.state !== "staged" ? sharedOwners.get(ref) : undefined;
    if (sharedOwner) {
      mediaStore.put({
        ...media,
        projectId: sharedOwner.id,
        projectIncarnation: sharedOwner.incarnation,
      });
      continue;
    }

    if (
      media.state === "staged"
      && media.importSessionId
      && importSessions.has(media.importSessionId)
    ) {
      continue;
    }

    mediaStore.delete(media.id);
    if (media.storage !== "opfs" || !media.opfsPath) continue;
    const existingOperation = mediaOperations.get(media.id);
    if (existingOperation) {
      operationStore.put(cleanupDue(existingOperation, timestamp));
      continue;
    }
    operationStore.add({
      id: createId(),
      kind: "media_write",
      mediaId: media.id,
      projectId,
      projectIncarnation: media.projectIncarnation ?? null,
      importSessionId: media.importSessionId ?? null,
      sourcePath: media.sourcePath,
      contentType: media.contentType,
      sizeBytes: media.sizeBytes,
      opfsPath: media.opfsPath,
      state: "cleanup_due",
      createdAt: timestamp,
      updatedAt: timestamp,
      attempts: 0,
      nextAttemptAt: timestamp,
      leaseOwner: null,
      leaseExpiresAt: null,
    } satisfies MediaOperationRecord);
  }
}

async function loadRecentProjectId(): Promise<string | null> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.settings, "readonly");
  const setting = await requestToPromise<LocalSettingsRecord | undefined>(
    tx.objectStore(LOCAL_STORES.settings).get("recentProjectId"),
  );
  return setting?.value ?? null;
}

export async function saveProjectSnapshot(
  snapshot: ShortDramaProjectResponse,
): Promise<VersionedLocalProjectSnapshot> {
  const db = await openLocalDb();
  const tx = db.transaction([LOCAL_STORES.projects, LOCAL_STORES.settings], "readwrite");
  return runTransaction(tx, async () => {
    const projectStore = tx.objectStore(LOCAL_STORES.projects);
    const existing = await requestToPromise<LocalProjectSnapshot | undefined>(
      projectStore.get(snapshot.project.id),
    );
    const existingVersion = existing ? normalizeProjectVersion(existing) : null;
    const nextVersion = existingVersion
      ? { ...existingVersion, revision: existingVersion.revision + 1 }
      : freshProjectVersion();
    const record = toLocalProjectSnapshot(snapshot, nextVersion);
    projectStore.put(record);
    tx.objectStore(LOCAL_STORES.settings).put({
      key: "recentProjectId",
      value: snapshot.project.id,
    } satisfies LocalSettingsRecord);
    return record;
  });
}

export async function saveProjectSnapshotIfVersion(
  snapshot: ShortDramaProjectResponse,
  expectedVersion: LocalProjectVersion,
): Promise<VersionedLocalProjectSnapshot | null> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.projects, "readwrite");
  return runTransaction(tx, async () => {
    const projectStore = tx.objectStore(LOCAL_STORES.projects);
    const existing = await requestToPromise<LocalProjectSnapshot | undefined>(
      projectStore.get(snapshot.project.id),
    );
    if (!existing) return null;
    const existingVersion = normalizeProjectVersion(existing);
    if (
      existingVersion.incarnation !== expectedVersion.incarnation
      || existingVersion.revision !== expectedVersion.revision
    ) return null;
    const record = toLocalProjectSnapshot(snapshot, {
      incarnation: existingVersion.incarnation,
      revision: existingVersion.revision + 1,
    });
    projectStore.put(record);
    return record;
  });
}

export async function saveImportedProjectSnapshot(
  snapshot: ShortDramaProjectResponse,
  options: { overwrite: boolean },
): Promise<void> {
  const db = await openLocalDb();
  const tx = db.transaction([
    LOCAL_STORES.projects,
    LOCAL_STORES.settings,
    LOCAL_STORES.media,
    LOCAL_STORES.mediaOperations,
  ], "readwrite");
  await runTransaction(tx, async () => {
    const projectStore = tx.objectStore(LOCAL_STORES.projects);
    const existing = await requestToPromise<LocalProjectSnapshot | undefined>(
      projectStore.get(snapshot.project.id),
    );
    if (existing && !options.overwrite) {
      throw new ProjectImportConflictError(snapshot.project.id);
    }

    const version = freshProjectVersion();
    await retirePriorProjectState(
      tx,
      snapshot.project.id,
      null,
      new Set(),
    );
    projectStore.put(toLocalProjectSnapshot(snapshot, version));
    tx.objectStore(LOCAL_STORES.settings).put({
      key: "recentProjectId",
      value: snapshot.project.id,
    } satisfies LocalSettingsRecord);
  });
  await runMediaRecovery().catch(() => undefined);
}

export async function beginProjectImport(projectId: string): Promise<string> {
  const sessionId = createId();
  const projectIncarnation = createId();
  await createMediaImportSession({
    id: sessionId,
    projectId,
    projectIncarnation,
    mediaIds: [],
    leaseOwner: sessionId,
  });
  return sessionId;
}

export async function abortProjectImport(sessionId: string, _cause?: unknown): Promise<void> {
  await markMediaOperationCleanupDue(sessionId, sessionId);
}

export async function commitImportedProject(
  snapshot: ShortDramaProjectResponse,
  sessionId: string,
  options: { overwrite: boolean; leaseOwner: string },
): Promise<void> {
  const db = await openLocalDb();
  const tx = db.transaction(
    [
      LOCAL_STORES.projects,
      LOCAL_STORES.settings,
      LOCAL_STORES.media,
      LOCAL_STORES.mediaOperations,
    ],
    "readwrite",
  );
  let rejection: Error | null = null;
  try {
    await runTransaction(tx, async () => {
      const projectStore = tx.objectStore(LOCAL_STORES.projects);
      const mediaStore = tx.objectStore(LOCAL_STORES.media);
      const operationStore = tx.objectStore(LOCAL_STORES.mediaOperations);
      const session = await requestToPromise<MediaJournalRecord | undefined>(
        operationStore.get(sessionId),
      );
      if (!session || session.kind !== "import_session") {
        throw new Error(`Active import session ${sessionId} was not found`);
      }
      if (
        session.state !== "importing" ||
        !hasActiveLease(session, options.leaseOwner, new Date())
      ) {
        throw new Error(`Import session ${sessionId} no longer holds its owner lease`);
      }

      const existing = await requestToPromise<LocalProjectSnapshot | undefined>(
        projectStore.get(snapshot.project.id),
      );
      if (!rejection && existing && !options.overwrite) {
        rejection = new ProjectImportConflictError(snapshot.project.id);
      }

      const allMedia = await requestToPromise<LocalMediaRecord[]>(mediaStore.getAll());
      const mediaById = new Map(allMedia.map((record) => [record.id, record]));
      const sessionMediaIds = new Set(session.mediaIds);
      const sessionIncarnation = session.projectIncarnation?.trim()
        || `legacy:${session.projectId}`;
      const linkedMedia = allMedia.filter((record) => record.importSessionId === sessionId);
      const hasInvalidMedia =
        sessionMediaIds.size !== session.mediaIds.length ||
        linkedMedia.length !== sessionMediaIds.size ||
        linkedMedia.some((record) => !sessionMediaIds.has(record.id)) ||
        session.mediaIds.some((id) => {
          const record = mediaById.get(id);
          return !record || record.projectId !== session.projectId || record.state !== "staged" ||
            record.importSessionId !== sessionId ||
            (record.projectIncarnation?.trim() || `legacy:${record.projectId}`) !== sessionIncarnation;
        });
      if (!rejection && hasInvalidMedia) {
        rejection = new Error(`Import session ${sessionId} contains invalid staged media`);
      }

      if (rejection) {
        operationStore.put(cleanupDue(session, new Date().toISOString()));
        return;
      }

      const projectIncarnation = session.projectIncarnation?.trim() || createId();
      await retirePriorProjectState(
        tx,
        snapshot.project.id,
        sessionId,
        sessionMediaIds,
      );
      projectStore.put(toLocalProjectSnapshot(
        snapshot,
        { incarnation: projectIncarnation, revision: 1 },
      ));
      tx.objectStore(LOCAL_STORES.settings).put({
        key: "recentProjectId",
        value: snapshot.project.id,
      } satisfies LocalSettingsRecord);
      for (const mediaId of session.mediaIds) {
        const record = mediaById.get(mediaId)!;
        mediaStore.put({
          ...record,
          projectId: snapshot.project.id,
          projectIncarnation,
          state: "committed",
          importSessionId: null,
        });
      }
      operationStore.delete(sessionId);
    });
    if (rejection) throw rejection;
  } catch (error) {
    await abortProjectImport(sessionId, error).catch(() => undefined);
    throw error;
  }
  await runMediaRecovery().catch(() => undefined);
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

export async function loadProjectSnapshot(
  projectId: string,
): Promise<VersionedLocalProjectSnapshot | null> {
  const db = await openLocalDb();
  const tx = db.transaction(LOCAL_STORES.projects, "readonly");
  const value = await requestToPromise<LocalProjectSnapshot | undefined>(
    tx.objectStore(LOCAL_STORES.projects).get(projectId),
  );
  return value ? normalizeProjectSnapshot(value) : null;
}

export async function loadRecentProjectSnapshot(): Promise<VersionedLocalProjectSnapshot | null> {
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
    [
      LOCAL_STORES.projects,
      LOCAL_STORES.settings,
      LOCAL_STORES.media,
      LOCAL_STORES.mediaOperations,
    ],
    "readwrite",
  );
  await runTransaction(tx, async () => {
    const timestamp = new Date().toISOString();
    const projectStore = tx.objectStore(LOCAL_STORES.projects);
    const settingsStore = tx.objectStore(LOCAL_STORES.settings);
    const mediaStore = tx.objectStore(LOCAL_STORES.media);
    const operationStore = tx.objectStore(LOCAL_STORES.mediaOperations);
    const [recentSetting, projects, projectMedia, projectOperations] = await Promise.all([
      requestToPromise<LocalSettingsRecord | undefined>(settingsStore.get("recentProjectId")),
      requestToPromise<LocalProjectSnapshot[]>(projectStore.getAll()),
      requestToPromise<LocalMediaRecord[]>(
        mediaStore.index("projectId").getAll(IDBKeyRange.only(projectId)),
      ),
      requestToPromise<MediaJournalRecord[]>(
        operationStore.index("projectId").getAll(IDBKeyRange.only(projectId)),
      ),
    ]);

    const sharedRefOwners = new Map<LocalMediaRef, VersionedLocalProjectSnapshot>();
    for (const project of projects) {
      if (project.id !== projectId) {
        for (const ref of collectLocalMediaRefs(project.snapshot)) {
          if (!sharedRefOwners.has(ref)) {
            sharedRefOwners.set(ref, normalizeProjectSnapshot(project));
          }
        }
      }
    }

    const mediaOperations = new Map(
      projectOperations
        .filter((record): record is MediaOperationRecord => record.kind === "media_write")
        .map((record) => [record.mediaId, record]),
    );

    projectStore.delete(projectId);
    if ((recentSetting?.value ?? null) === projectId) {
      settingsStore.put({ key: "recentProjectId", value: null } satisfies LocalSettingsRecord);
    }

    for (const media of projectMedia) {
      const ref = `${LOCAL_MEDIA_PREFIX}${media.id}` as LocalMediaRef;
      const survivingOwner = media.state !== "staged" ? sharedRefOwners.get(ref) : undefined;
      if (survivingOwner) {
        mediaStore.put({
          ...media,
          projectId: survivingOwner.id,
          projectIncarnation: survivingOwner.incarnation,
        });
        continue;
      }

      mediaStore.delete(media.id);
      if (media.storage !== "opfs" || !media.opfsPath) continue;
      const existingOperation = mediaOperations.get(media.id);
      if (existingOperation) {
        operationStore.put(cleanupDue(existingOperation, timestamp));
        continue;
      }
      const cleanupOperation: MediaOperationRecord = {
        id: createId(),
        kind: "media_write",
        mediaId: media.id,
        projectId,
        projectIncarnation: media.projectIncarnation ?? null,
        importSessionId: media.importSessionId ?? null,
        sourcePath: media.sourcePath,
        contentType: media.contentType,
        sizeBytes: media.sizeBytes,
        opfsPath: media.opfsPath,
        state: "cleanup_due",
        createdAt: timestamp,
        updatedAt: timestamp,
        attempts: 0,
        nextAttemptAt: timestamp,
        leaseOwner: null,
        leaseExpiresAt: null,
      };
      operationStore.add(cleanupOperation);
    }

    for (const operation of projectOperations) {
      operationStore.put(cleanupDue(operation, timestamp));
    }
  });

  await runMediaRecovery().catch(() => undefined);
}
