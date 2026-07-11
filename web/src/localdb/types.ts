import type { ShortDramaProjectResponse } from "../domain/types";

export const LOCAL_DB_NAME = "openmontage-local";
export const LOCAL_DB_VERSION = 4;

export type LocalMediaRef = `local://media/${string}`;
export type LocalMediaStorage = "opfs" | "indexeddb";

export interface LocalProjectSnapshot {
  id: string;
  title: string;
  updatedAt: string;
  revision?: number;
  snapshot: ShortDramaProjectResponse;
}

export interface LocalProjectSummary {
  id: string;
  title: string;
  updatedAt: string;
  shotCount: number;
  hasFinalRender: boolean;
}

export interface LocalSettingsRecord {
  key: "recentProjectId";
  value: string | null;
}

export interface LocalMediaRecord {
  id: string;
  projectId: string;
  sourcePath: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  state?: "staged" | "committed";
  importSessionId?: string | null;
  storage: LocalMediaStorage;
  opfsPath?: string;
  blob?: Blob;
  blobBytes?: ArrayBuffer;
}

export interface LocalMediaPendingRecord {
  id: string;
  opfsPath: string;
  createdAt: string;
  state: "writing" | "retryable";
}

export interface MediaOperationRecord {
  id: string;
  kind: "media_write";
  mediaId: string;
  projectId: string | null;
  importSessionId: string | null;
  sourcePath: string;
  contentType: string;
  sizeBytes: number;
  opfsPath: string;
  state: "writing" | "cleanup_due";
  createdAt: string;
  updatedAt: string;
  attempts: number;
  nextAttemptAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

export interface MediaImportSessionRecord {
  id: string;
  kind: "import_session";
  projectId: string;
  mediaIds: string[];
  state: "importing" | "cleanup_due";
  createdAt: string;
  updatedAt: string;
  attempts: number;
  nextAttemptAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

export type MediaJournalRecord = MediaOperationRecord | MediaImportSessionRecord;

export interface StorageEstimate {
  usageBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
}
