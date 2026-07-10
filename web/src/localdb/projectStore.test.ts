import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { ShortDramaProjectResponse, Shot } from "../domain/types";
import { resetLocalDbForTests } from "./indexedDb";
import {
  deleteProject,
  listProjectSummaries,
  loadProjectSnapshot,
  loadRecentProjectSnapshot,
  saveProjectSnapshot,
  setRecentProjectId,
} from "./projectStore";
import { LOCAL_DB_NAME } from "./types";

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
});
