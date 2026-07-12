import type { ShortDramaProjectResponse } from "../../domain/types";
import {
  deleteProject,
  loadProjectSnapshot,
  saveProjectSnapshot,
  saveProjectSnapshotIfVersion,
  setRecentProjectId,
} from "../../localdb/projectStore";
import type { LocalProjectSnapshot, LocalProjectVersion } from "../../localdb/types";

export type BrowserProjectRecord = LocalProjectSnapshot & LocalProjectVersion;

export interface BrowserProjectCache {
  get(projectId: string): Promise<ShortDramaProjectResponse | null>;
  getRecord(projectId: string): Promise<BrowserProjectRecord | null>;
  put(snapshot: ShortDramaProjectResponse): Promise<BrowserProjectRecord>;
  putIfVersion(
    snapshot: ShortDramaProjectResponse,
    expectedVersion: LocalProjectVersion,
  ): Promise<BrowserProjectRecord | null>;
  markRecent(projectId: string): Promise<void>;
  remove(projectId: string): Promise<void>;
}

export class IndexedDbBrowserProjectCache implements BrowserProjectCache {
  async get(projectId: string): Promise<ShortDramaProjectResponse | null> {
    return (await this.getRecord(projectId))?.snapshot ?? null;
  }

  getRecord(projectId: string): Promise<BrowserProjectRecord | null> {
    return loadProjectSnapshot(projectId);
  }

  put(snapshot: ShortDramaProjectResponse): Promise<BrowserProjectRecord> {
    return saveProjectSnapshot(snapshot);
  }

  putIfVersion(
    snapshot: ShortDramaProjectResponse,
    expectedVersion: LocalProjectVersion,
  ): Promise<BrowserProjectRecord | null> {
    return saveProjectSnapshotIfVersion(snapshot, expectedVersion);
  }

  markRecent(projectId: string): Promise<void> {
    return setRecentProjectId(projectId);
  }

  async remove(projectId: string): Promise<void> {
    await deleteProject(projectId);
  }
}

export const browserProjectCache: BrowserProjectCache = new IndexedDbBrowserProjectCache();
