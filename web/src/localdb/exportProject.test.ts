import "fake-indexeddb/auto";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import type { ShortDramaProjectResponse, Shot } from "../domain/types";
import { exportProjectBackup, importProjectBackup } from "./exportProject";
import { resetLocalDbForTests } from "./indexedDb";
import { loadMediaBlob, saveMediaBlob } from "./mediaStore";
import { loadRecentProjectSnapshot, saveProjectSnapshot } from "./projectStore";
import { LOCAL_DB_NAME, type LocalMediaRef } from "./types";

async function blobFromText(text: string, contentType: string): Promise<Blob> {
  return new Response(text, { headers: { "content-type": contentType } }).blob();
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read blob"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

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

function shot(outputPath: string | null): Shot {
  return {
    id: "s1",
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
    output_path: outputPath,
    asset_ids: [],
    version: 1,
    history: [],
  };
}

function snapshot(mediaRef: LocalMediaRef | null = null): ShortDramaProjectResponse {
  return {
    project: { id: "p1", title: "Rain Alley", mode: "short_drama", project_type: "single_video" },
    series_bible: {
      characters: [],
      assets: mediaRef
        ? [
            {
              id: "asset-1",
              kind: "scene",
              label: "Alley",
              reference_images: [mediaRef],
              media_urls: [mediaRef],
            },
          ]
        : [],
    },
    storyboard: { shots: [shot(mediaRef)] },
    consistency_report: { score: 100, issues: [] },
    workflow_artifacts: [],
    final_path: mediaRef,
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

describe("exportProject", () => {
  it("exports a zip with a project JSON manifest", async () => {
    await saveProjectSnapshot(snapshot());

    const backup = await exportProjectBackup("p1");
    const archive = unzipSync(new Uint8Array(await blobToArrayBuffer(backup)));
    const manifest = JSON.parse(strFromU8(archive["openmontage-project.json"]));

    expect(backup.type).toBe("application/zip");
    expect(manifest.project.title).toBe("Rain Alley");
  });

  it("imports a project manifest and makes it the recent project", async () => {
    await saveProjectSnapshot(snapshot());
    const backup = await exportProjectBackup("p1");
    await deleteLocalDb();

    await importProjectBackup(new File([backup], "rain-alley.omproj", { type: "application/zip" }));

    const recent = await loadRecentProjectSnapshot();
    expect(recent?.snapshot.project.title).toBe("Rain Alley");
  });

  it("restores local media blobs referenced by the manifest", async () => {
    const mediaRef = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/video/shot.mp4",
      contentType: "video/mp4",
      blob: await blobFromText("video", "video/mp4"),
    });
    await saveProjectSnapshot(snapshot(mediaRef));
    const backup = await exportProjectBackup("p1");
    await deleteLocalDb();

    const imported = await importProjectBackup(
      new File([backup], "rain-alley.omproj", { type: "application/zip" }),
    );
    const restoredRef = imported.storyboard.shots[0].output_path as LocalMediaRef;

    expect(restoredRef).toMatch(/^local:\/\/media\//);
    const restoredBlob = await loadMediaBlob(restoredRef);
    expect(restoredBlob ? await blobToText(restoredBlob) : null).toBe("video");
    expect(imported.final_path).toBe(restoredRef);
    expect(imported.series_bible.assets?.[0].reference_images[0]).toBe(restoredRef);
  });

  it("rejects backups without a project manifest", async () => {
    const broken = new File([new Blob(["not a zip"])], "broken.omproj", {
      type: "application/zip",
    });

    await expect(importProjectBackup(broken)).rejects.toThrow();
  });
});
