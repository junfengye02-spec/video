import type { ShortDramaProjectResponse } from "../domain/types";

export const LOCAL_DB_NAME = "openmontage-local";
export const LOCAL_DB_VERSION = 3;

export type LocalMediaRef = `local://media/${string}`;
export type LocalMediaStorage = "opfs" | "indexeddb";

export interface LocalProjectSnapshot {
  id: string;
  title: string;
  updatedAt: string;
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

export interface StorageEstimate {
  usageBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
}
