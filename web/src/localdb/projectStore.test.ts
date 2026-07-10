import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShortDramaProjectResponse, Shot } from "../domain/types";
import { openLocalDb, resetLocalDbForTests } from "./indexedDb";
import { loadMediaBlob, saveMediaBlob } from "./mediaStore";
import {
  deleteProject,
  listProjectSummaries,
  loadProjectSnapshot,
  loadRecentProjectSnapshot,
  saveProjectSnapshot,
  setRecentProjectId,
} from "./projectStore";
import { LOCAL_DB_NAME } from "./types";

const originalStorage = Object.getOwnPropertyDescriptor(Navigator.prototype, "storage");

function blobToText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") {
    return blob.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}

function installOpfs(options: { removeError?: Error } = {}) {
  const files = new Map<string, Blob>();
  const removeEntry = vi.fn(async (name: string) => {
    if (options.removeError) {
      throw options.removeError;
    }
    if (!files.delete(name)) {
      throw new DOMException("File not found", "NotFoundError");
    }
  });
  const mediaDirectory = {
    async getFileHandle(name: string, handleOptions?: { create?: boolean }) {
      if (!files.has(name) && !handleOptions?.create) {
        throw new DOMException("File not found", "NotFoundError");
      }
      return {
        async createWritable() {
          return {
            async write(blob: Blob) {
              files.set(name, blob);
            },
            async close() {},
          };
        },
        async getFile() {
          const blob = files.get(name);
          if (!blob) throw new DOMException("File not found", "NotFoundError");
          return blob;
        },
      };
    },
    removeEntry,
  };
  const root = {
    async getDirectoryHandle() {
      return mediaDirectory;
    },
  };
  Object.defineProperty(Navigator.prototype, "storage", {
    configurable: true,
    value: { getDirectory: vi.fn(async () => root) },
  });
  return { files, removeEntry };
}

async function mediaBlob(text: string): Promise<Blob> {
  return new Response(text, { headers: { "content-type": "video/mp4" } }).blob();
}

function shot(id: string): Shot {
  return {
    id,
    scene_id: "scene-1",
    index: 1,
    beat: "A reveal",
    prompt: "A neon hallway",
    characters: [],
    location: null,
    props: [],
    status: "complete",
    consistency_score: 98,
    output_url: null,
    output_path: null,
    asset_ids: [],
    version: 1,
    history: [],
  };
}

function snapshot(
  id: string,
  title: string,
  options: { finalPath?: string | null; shots?: Shot[] } = {},
): ShortDramaProjectResponse {
  return {
    project: { id, title, mode: "short_drama", project_type: "single_video" },
    series_bible: { characters: [], assets: [] },
    storyboard: { shots: options.shots ?? [] },
    consistency_report: { score: 100, issues: [] },
    workflow_artifacts: [],
    final_path: options.finalPath ?? null,
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
  vi.restoreAllMocks();
  if (originalStorage) {
    Object.defineProperty(Navigator.prototype, "storage", originalStorage);
  } else {
    delete (Navigator.prototype as { storage?: StorageManager }).storage;
  }
  await deleteLocalDb();
});

describe("projectStore", () => {
  it("saves and restores the recent project snapshot", async () => {
    await saveProjectSnapshot(snapshot("p1", "Rain Alley"));

    const recent = await loadRecentProjectSnapshot();

    expect(recent?.id).toBe("p1");
    expect(recent?.title).toBe("Rain Alley");
    expect(recent?.snapshot.project.id).toBe("p1");
  });

  it("sets the recent project pointer without rewriting the snapshot", async () => {
    await saveProjectSnapshot(snapshot("p1", "Rain Alley"));
    await saveProjectSnapshot(snapshot("p2", "Office Secret"));

    await setRecentProjectId("p1");

    expect((await loadRecentProjectSnapshot())?.snapshot.project.title).toBe("Rain Alley");
  });

  it("lists project summaries ordered by most recently updated", async () => {
    await saveProjectSnapshot(snapshot("p1", "Rain Alley"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveProjectSnapshot(
      snapshot("p2", "Office Secret", {
        finalPath: "renders/final.mp4",
        shots: [shot("s1"), shot("s2")],
      }),
    );

    const summaries = await listProjectSummaries();

    expect(summaries).toEqual([
      expect.objectContaining({
        id: "p2",
        title: "Office Secret",
        shotCount: 2,
        hasFinalRender: true,
      }),
      expect.objectContaining({
        id: "p1",
        title: "Rain Alley",
        shotCount: 0,
        hasFinalRender: false,
      }),
    ]);
  });

  it("deletes a local project and clears the recent pointer when needed", async () => {
    await saveProjectSnapshot(snapshot("p1", "Rain Alley"));

    await deleteProject("p1");

    expect(await loadProjectSnapshot("p1")).toBeNull();
    expect(await loadRecentProjectSnapshot()).toBeNull();
  });

  it("migrates a version 1 media store with a projectId index", async () => {
    await deleteLocalDb();
    const legacyRequest = indexedDB.open(LOCAL_DB_NAME, 1);
    legacyRequest.onupgradeneeded = () => {
      const db = legacyRequest.result;
      db.createObjectStore("projects", { keyPath: "id" });
      db.createObjectStore("settings", { keyPath: "key" });
      db.createObjectStore("media", { keyPath: "id" });
    };
    const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
      legacyRequest.onerror = () => reject(legacyRequest.error);
      legacyRequest.onsuccess = () => resolve(legacyRequest.result);
    });
    legacyDb.close();
    resetLocalDbForTests();

    const db = await openLocalDb();
    const mediaStore = db.transaction("media", "readonly").objectStore("media");

    expect(db.version).toBe(2);
    expect(mediaStore.indexNames.contains("projectId")).toBe(true);
  });

  it("deletes project-owned IndexedDB media without touching another project", async () => {
    const firstRef = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/p1.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("first"),
    });
    const secondRef = await saveMediaBlob({
      projectId: "p2",
      sourcePath: "assets/p2.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("second"),
    });
    const first = snapshot("p1", "First");
    first.final_path = firstRef;
    const second = snapshot("p2", "Second");
    second.final_path = secondRef;
    await saveProjectSnapshot(first);
    await saveProjectSnapshot(second);

    await deleteProject("p1");

    expect(await loadMediaBlob(firstRef)).toBeNull();
    const remaining = await loadMediaBlob(secondRef);
    expect(remaining ? await blobToText(remaining) : null).toBe("second");
  });

  it("removes project-owned OPFS media", async () => {
    const { files, removeEntry } = installOpfs();
    const ref = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/p1.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("first"),
    });
    const project = snapshot("p1", "First");
    project.final_path = ref;
    await saveProjectSnapshot(project);

    await deleteProject("p1");

    expect(removeEntry).toHaveBeenCalledTimes(1);
    expect(files.size).toBe(0);
    expect(await loadMediaBlob(ref)).toBeNull();
  });

  it("preserves media still referenced by another project", async () => {
    const sharedRef = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/shared.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("shared"),
    });
    const first = snapshot("p1", "First");
    first.final_path = sharedRef;
    const second = snapshot("p2", "Second");
    second.final_path = sharedRef;
    await saveProjectSnapshot(first);
    await saveProjectSnapshot(second);

    await deleteProject("p1");

    const shared = await loadMediaBlob(sharedRef);
    expect(shared ? await blobToText(shared) : null).toBe("shared");
  });

  it("reports OPFS cleanup failure while retaining media data for retry", async () => {
    installOpfs({ removeError: new Error("OPFS remove failed") });
    const ref = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/p1.mp4",
      contentType: "video/mp4",
      blob: await mediaBlob("first"),
    });
    const project = snapshot("p1", "First");
    project.final_path = ref;
    await saveProjectSnapshot(project);

    await expect(deleteProject("p1")).rejects.toThrow(/cleanup/i);

    expect(await loadProjectSnapshot("p1")).toBeNull();
    const retained = await loadMediaBlob(ref);
    expect(retained ? await blobToText(retained) : null).toBe("first");
  });
});
