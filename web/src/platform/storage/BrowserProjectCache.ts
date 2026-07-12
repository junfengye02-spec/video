import type { ShortDramaProjectResponse } from "../../domain/types";
import {
  deleteProject,
  loadProjectSnapshot,
  saveProjectSnapshot,
} from "../../localdb/projectStore";

export interface BrowserProjectCache {
  get(projectId: string): Promise<ShortDramaProjectResponse | null>;
  put(snapshot: ShortDramaProjectResponse): Promise<void>;
  remove(projectId: string): Promise<void>;
}

export class IndexedDbBrowserProjectCache implements BrowserProjectCache {
  async get(projectId: string): Promise<ShortDramaProjectResponse | null> {
    return (await loadProjectSnapshot(projectId))?.snapshot ?? null;
  }

  async put(snapshot: ShortDramaProjectResponse): Promise<void> {
    await saveProjectSnapshot(snapshot);
  }

  async remove(projectId: string): Promise<void> {
    await deleteProject(projectId);
  }
}

export const browserProjectCache: BrowserProjectCache = new IndexedDbBrowserProjectCache();
