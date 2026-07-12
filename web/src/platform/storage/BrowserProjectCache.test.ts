import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { ShortDramaProjectResponse } from "../../domain/types";
import { resetLocalDbForTests } from "../../localdb/indexedDb";
import {
  loadProjectSnapshot,
  saveProjectSnapshot,
} from "../../localdb/projectStore";
import { LOCAL_DB_NAME } from "../../localdb/types";
import { IndexedDbBrowserProjectCache } from "./BrowserProjectCache";

function snapshot(id: string, title: string): ShortDramaProjectResponse {
  return {
    project: { id, title, mode: "short_drama", project_type: "single_video" },
    series_bible: { characters: [], assets: [] },
    storyboard: { shots: [] },
    consistency_report: { score: 100, issues: [] },
    workflow_artifacts: [],
    final_path: null,
  };
}

async function deleteLocalDb() {
  resetLocalDbForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
  });
}

afterEach(async () => {
  await deleteLocalDb();
});

describe("IndexedDbBrowserProjectCache", () => {
  it("stores and loads the project snapshot only through the browser cache", async () => {
    const cache = new IndexedDbBrowserProjectCache();

    await cache.put(snapshot("p1", "Rain Alley"));

    expect(await cache.get("p1")).toMatchObject({
      project: { id: "p1", title: "Rain Alley" },
    });
  });

  it("returns null for a missing snapshot", async () => {
    await expect(new IndexedDbBrowserProjectCache().get("missing")).resolves.toBeNull();
  });

  it("delegates removal to the durable local project delete path", async () => {
    await saveProjectSnapshot(snapshot("p1", "Rain Alley"));

    await new IndexedDbBrowserProjectCache().remove("p1");

    expect(await loadProjectSnapshot("p1")).toBeNull();
  });
});
