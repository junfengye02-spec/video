import "fake-indexeddb/auto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShortDramaProjectResponse, Shot } from "../domain/types";
import { exportProjectBackup, importProjectBackup } from "./exportProject";
import { resetLocalDbForTests } from "./indexedDb";
import { loadMediaBlob, saveMediaBlob } from "./mediaStore";
import {
  loadProjectSnapshot,
  loadRecentProjectSnapshot,
  saveProjectSnapshot,
} from "./projectStore";
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

function snapshot(
  mediaRef: LocalMediaRef | null = null,
  options: { id?: string; title?: string } = {},
): ShortDramaProjectResponse {
  return {
    project: {
      id: options.id ?? "p1",
      title: options.title ?? "Rain Alley",
      mode: "short_drama",
      project_type: "single_video",
    },
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

type TestMediaEntry = {
  ref: LocalMediaRef;
  file: string;
  contentType: string;
  sourcePath: string;
};

function backupFile(options: {
  project?: unknown;
  version?: number;
  mediaVersion?: number;
  media?: TestMediaEntry[];
  mediaFiles?: Record<string, Uint8Array>;
} = {}): File {
  const files: Record<string, Uint8Array> = {
    "openmontage-project.json": strToU8(JSON.stringify({
      version: options.version ?? 1,
      project: options.project ?? snapshot(),
    })),
    ...options.mediaFiles,
  };
  if (options.media) {
    files["openmontage-media.json"] = strToU8(JSON.stringify({
      version: options.mediaVersion ?? 1,
      media: options.media,
    }));
  }
  return new File([zipSync(files)], "project.omproj", { type: "application/zip" });
}

async function patchDeclaredSize(
  file: File,
  entryName: string,
  declaredSize: number,
): Promise<File> {
  const bytes = new Uint8Array(await blobToArrayBuffer(file));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let patchedHeaders = 0;
  for (let offset = 0; offset <= bytes.length - 30; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) {
      const nameLength = view.getUint16(offset + 26, true);
      const name = decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
      if (name === entryName) {
        view.setUint32(offset + 22, declaredSize, true);
        patchedHeaders += 1;
      }
    } else if (signature === 0x02014b50) {
      const nameLength = view.getUint16(offset + 28, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
      if (name === entryName) {
        view.setUint32(offset + 24, declaredSize, true);
        patchedHeaders += 1;
      }
    }
  }
  if (patchedHeaders !== 2) {
    throw new Error(`Expected to patch two ZIP headers for ${entryName}`);
  }
  return new File([bytes], file.name, { type: file.type });
}

async function mediaRecordCount(): Promise<number> {
  const request = indexedDB.open(LOCAL_DB_NAME);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  const countRequest = db.transaction("media", "readonly").objectStore("media").count();
  const count = await new Promise<number>((resolve, reject) => {
    countRequest.onerror = () => reject(countRequest.error);
    countRequest.onsuccess = () => resolve(countRequest.result);
  });
  db.close();
  return count;
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
  await deleteLocalDb();
});

describe("exportProject", () => {
  it("exports a zip with a project JSON manifest", async () => {
    await saveProjectSnapshot(snapshot());

    const backup = await exportProjectBackup("p1");
    const archive = unzipSync(new Uint8Array(await blobToArrayBuffer(backup)));
    const manifest = JSON.parse(strFromU8(archive["openmontage-project.json"]));

    expect(backup.type).toBe("application/zip");
    expect(manifest.version).toBe(1);
    expect(manifest.project.project.title).toBe("Rain Alley");
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

  it("rejects export when a referenced local media blob is missing", async () => {
    await saveProjectSnapshot(snapshot("local://media/missing"));

    await expect(exportProjectBackup("p1")).rejects.toThrow(/missing|unreadable/i);
  });

  it("rejects malformed local media references during export preflight", async () => {
    await saveProjectSnapshot(snapshot("local://media/../escape" as LocalMediaRef));

    await expect(exportProjectBackup("p1")).rejects.toThrow(/media.*malformed|invalid.*media/i);
  });

  it("rejects unsupported backup versions before changing visible project state", async () => {
    await saveProjectSnapshot(snapshot(null, { id: "existing", title: "Existing" }));

    await expect(importProjectBackup(backupFile({ version: 2 }))).rejects.toThrow(/version/i);

    expect((await loadRecentProjectSnapshot())?.snapshot.project.title).toBe("Existing");
    expect(await loadProjectSnapshot("p1")).toBeNull();
  });

  it("rejects malformed project envelopes before writing", async () => {
    await expect(importProjectBackup(backupFile({ project: { project: { id: "p1" } } })))
      .rejects.toThrow(/metadata|invalid/i);

    expect(await loadProjectSnapshot("p1")).toBeNull();
    expect(await mediaRecordCount()).toBe(0);
  });

  it("rejects project envelopes with malformed shot records", async () => {
    const malformed = snapshot(null, { id: "imported" }) as unknown as Record<string, unknown>;
    malformed.storyboard = { shots: [{ id: "s1" }] };

    await expect(importProjectBackup(backupFile({ project: malformed })))
      .rejects.toThrow(/metadata|invalid/i);

    expect(await loadProjectSnapshot("imported")).toBeNull();
  });

  it("rejects unresolved local media references before writing a project", async () => {
    await saveProjectSnapshot(snapshot(null, { id: "existing", title: "Existing" }));
    const imported = snapshot("local://media/missing", { id: "imported" });

    await expect(importProjectBackup(backupFile({ project: imported }))).rejects.toThrow(/media/i);

    expect((await loadRecentProjectSnapshot())?.id).toBe("existing");
    expect(await loadProjectSnapshot("imported")).toBeNull();
    expect(await mediaRecordCount()).toBe(0);
  });

  it("rejects duplicate media manifest refs before writing", async () => {
    const ref = "local://media/original" as LocalMediaRef;
    const imported = snapshot(ref, { id: "imported" });
    const entry: TestMediaEntry = {
      ref,
      file: "media/original",
      contentType: "video/mp4",
      sourcePath: "assets/video/shot.mp4",
    };

    await expect(importProjectBackup(backupFile({
      project: imported,
      media: [entry, { ...entry, file: "media/duplicate" }],
      mediaFiles: {
        "media/original": strToU8("first"),
        "media/duplicate": strToU8("second"),
      },
    }))).rejects.toThrow(/duplicate/i);

    expect(await loadProjectSnapshot("imported")).toBeNull();
    expect(await mediaRecordCount()).toBe(0);
  });

  it("rejects duplicate media manifest file paths before writing", async () => {
    const refs = ["local://media/first", "local://media/second"] as LocalMediaRef[];
    const imported = snapshot(refs[0], { id: "imported" });
    imported.storyboard.shots.push({ ...shot(refs[1]), id: "s2", index: 2 });

    await expect(importProjectBackup(backupFile({
      project: imported,
      media: refs.map((ref, index) => ({
        ref,
        file: "media/shared",
        contentType: "video/mp4",
        sourcePath: `assets/video/${index}.mp4`,
      })),
      mediaFiles: { "media/shared": strToU8("media") },
    }))).rejects.toThrow(/duplicate/i);

    expect(await loadProjectSnapshot("imported")).toBeNull();
  });

  it("rejects unsupported media manifest versions", async () => {
    const ref = "local://media/original" as LocalMediaRef;

    await expect(importProjectBackup(backupFile({
      project: snapshot(ref, { id: "imported" }),
      mediaVersion: 2,
      media: [{
        ref,
        file: "media/original",
        contentType: "video/mp4",
        sourcePath: "assets/video/shot.mp4",
      }],
      mediaFiles: { "media/original": strToU8("media") },
    }))).rejects.toThrow(/manifest.*unsupported|version/i);

    expect(await loadProjectSnapshot("imported")).toBeNull();
  });

  it("rejects archive media files not declared by the manifest", async () => {
    await expect(importProjectBackup(backupFile({
      project: snapshot(null, { id: "imported" }),
      media: [],
      mediaFiles: { "media/undeclared": strToU8("media") },
    }))).rejects.toThrow(/undeclared|manifest/i);

    expect(await loadProjectSnapshot("imported")).toBeNull();
  });

  it("rejects media manifest entries whose archive file is missing", async () => {
    const ref = "local://media/original" as LocalMediaRef;
    const imported = snapshot(ref, { id: "imported" });

    await expect(importProjectBackup(backupFile({
      project: imported,
      media: [{
        ref,
        file: "media/original",
        contentType: "video/mp4",
        sourcePath: "assets/video/shot.mp4",
      }],
    }))).rejects.toThrow(/missing/i);

    expect(await loadProjectSnapshot("imported")).toBeNull();
  });

  it("does not overwrite an existing project or write media without explicit permission", async () => {
    const existingRef = await saveMediaBlob({
      projectId: "p1",
      sourcePath: "assets/video/existing.mp4",
      contentType: "video/mp4",
      blob: await blobFromText("existing", "video/mp4"),
    });
    await saveProjectSnapshot(snapshot(existingRef, { title: "Existing" }));
    const importedRef = "local://media/imported" as LocalMediaRef;

    await expect(importProjectBackup(backupFile({
      project: snapshot(importedRef, { title: "Imported" }),
      media: [{
        ref: importedRef,
        file: "media/imported",
        contentType: "video/mp4",
        sourcePath: "assets/video/imported.mp4",
      }],
      mediaFiles: { "media/imported": strToU8("imported") },
    }))).rejects.toThrow(/already exists|overwrite/i);

    expect((await loadProjectSnapshot("p1"))?.snapshot.project.title).toBe("Existing");
    expect(await mediaRecordCount()).toBe(1);
    const existingBlob = await loadMediaBlob(existingRef);
    expect(existingBlob ? await blobToText(existingBlob) : null).toBe("existing");
  });

  it("overwrites an existing project only with explicit permission", async () => {
    await saveProjectSnapshot(snapshot(null, { title: "Existing" }));

    const imported = await importProjectBackup(
      backupFile({ project: snapshot(null, { title: "Imported" }) }),
      { overwrite: true },
    );

    expect(imported.project.title).toBe("Imported");
    expect((await loadProjectSnapshot("p1"))?.snapshot.project.title).toBe("Imported");
  });

  it("rolls back staged media when a later media write hits quota", async () => {
    await saveProjectSnapshot(snapshot(null, { id: "existing", title: "Existing" }));
    const refs = ["local://media/first", "local://media/second"] as LocalMediaRef[];
    const imported = snapshot(refs[0], { id: "imported" });
    imported.storyboard.shots.push({ ...shot(refs[1]), id: "s2", index: 2 });
    const originalPut = IDBObjectStore.prototype.put;
    let mediaWrites = 0;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name === "media" && ++mediaWrites === 2) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return originalPut.call(this, value, key as IDBValidKey | undefined);
    });

    await expect(importProjectBackup(backupFile({
      project: imported,
      media: refs.map((ref, index) => ({
        ref,
        file: `media/${index}`,
        contentType: "video/mp4",
        sourcePath: `assets/video/${index}.mp4`,
      })),
      mediaFiles: { "media/0": strToU8("first"), "media/1": strToU8("second") },
    }))).rejects.toThrow(/quota/i);

    expect((await loadRecentProjectSnapshot())?.id).toBe("existing");
    expect(await loadProjectSnapshot("imported")).toBeNull();
    expect(await mediaRecordCount()).toBe(0);
  });

  it("rolls back staged media when the project commit fails", async () => {
    await saveProjectSnapshot(snapshot(null, { id: "existing", title: "Existing" }));
    const ref = "local://media/imported" as LocalMediaRef;
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name === "projects") {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return originalPut.call(this, value, key as IDBValidKey | undefined);
    });

    await expect(importProjectBackup(backupFile({
      project: snapshot(ref, { id: "imported" }),
      media: [{
        ref,
        file: "media/imported",
        contentType: "video/mp4",
        sourcePath: "assets/video/imported.mp4",
      }],
      mediaFiles: { "media/imported": strToU8("media") },
    }))).rejects.toThrow(/quota/i);

    expect((await loadRecentProjectSnapshot())?.id).toBe("existing");
    expect(await loadProjectSnapshot("imported")).toBeNull();
    expect(await mediaRecordCount()).toBe(0);
  });

  it("rejects backup files over the compressed archive limit before reading", async () => {
    const backup = backupFile({ project: snapshot(null, { id: "imported" }) });
    Object.defineProperty(backup, "size", { value: 512 * 1024 * 1024 + 1 });

    await expect(importProjectBackup(backup)).rejects.toThrow(/archive.*large|archive.*limit/i);
  });

  it("rejects archives with too many entries", async () => {
    const mediaFiles = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [`extra/${index}`, new Uint8Array(0)]),
    );

    await expect(importProjectBackup(backupFile({
      project: snapshot(null, { id: "imported" }),
      mediaFiles,
    }))).rejects.toThrow(/entr(y|ies).*limit|too many/i);

    expect(await loadProjectSnapshot("imported")).toBeNull();
  });

  it("rejects an archive entry whose declared uncompressed size exceeds the limit", async () => {
    const backup = await patchDeclaredSize(
      backupFile({
        project: snapshot(null, { id: "imported" }),
        mediaFiles: { "extra/large": strToU8("small") },
      }),
      "extra/large",
      256 * 1024 * 1024 + 1,
    );

    await expect(importProjectBackup(backup)).rejects.toThrow(/entry.*large|entry.*limit/i);
    expect(await loadProjectSnapshot("imported")).toBeNull();
  });

  it("rejects archives whose declared total uncompressed size exceeds the limit", async () => {
    let backup = backupFile({
      project: snapshot(null, { id: "imported" }),
      mediaFiles: {
        "extra/one": strToU8("one"),
        "extra/two": strToU8("two"),
        "extra/three": strToU8("three"),
        "extra/four": strToU8("four"),
        "extra/five": strToU8("five"),
      },
    });
    for (const name of ["extra/one", "extra/two", "extra/three", "extra/four", "extra/five"]) {
      backup = await patchDeclaredSize(backup, name, 220 * 1024 * 1024);
    }

    await expect(importProjectBackup(backup)).rejects.toThrow(/total.*large|total.*limit/i);
    expect(await loadProjectSnapshot("imported")).toBeNull();
  });
});
