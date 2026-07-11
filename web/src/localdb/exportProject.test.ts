import "fake-indexeddb/auto";
import { inflateSync, strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContinuityPlan, ShortDramaProjectResponse, Shot } from "../domain/types";
import {
  exportProjectBackup,
  importProjectBackup,
  ProjectImportConflictError,
} from "./exportProject";
import { BackupValidationError } from "./backupFormat";
import { resetLocalDbForTests } from "./indexedDb";
import { loadMediaBlob, saveMediaBlob } from "./mediaStore";
import {
  loadProjectSnapshot,
  loadRecentProjectSnapshot,
  saveProjectSnapshot,
} from "./projectStore";
import { LOCAL_DB_NAME, type LocalMediaRef } from "./types";

const originalStorage = Object.getOwnPropertyDescriptor(Navigator.prototype, "storage");
const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, "createObjectURL");

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function installDelayedOpfs(options: { onFirstStorageAccess?: () => Promise<void> } = {}) {
  const files = new Map<string, Blob>();
  const writeStarted = deferred<void>();
  const closeGate = deferred<void>();
  let storageAccessObserved = false;
  const mediaDirectory = {
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && !options?.create) {
        throw new DOMException("File not found", "NotFoundError");
      }
      return {
        async createWritable() {
          return {
            async write(blob: Blob) {
              files.set(name, blob);
              writeStarted.resolve();
            },
            async close() {
              await closeGate.promise;
            },
          };
        },
        async getFile() {
          const blob = files.get(name);
          if (!blob) throw new DOMException("File not found", "NotFoundError");
          return blob;
        },
      };
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
  };
  Object.defineProperty(Navigator.prototype, "storage", {
    configurable: true,
    value: {
      async getDirectory() {
        if (!storageAccessObserved) {
          storageAccessObserved = true;
          await options.onFirstStorageAccess?.();
        }
        return {
          async getDirectoryHandle() {
            return mediaDirectory;
          },
        };
      },
    },
  });
  return { files, writeStarted: writeStarted.promise, releaseClose: closeGate.resolve };
}

async function saveThroughSecondConnection(value: ShortDramaProjectResponse): Promise<void> {
  const request = indexedDB.open(LOCAL_DB_NAME);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  const transaction = db.transaction(["projects", "settings"], "readwrite");
  transaction.objectStore("projects").put({
    id: value.project.id,
    title: value.project.title,
    updatedAt: new Date().toISOString(),
    snapshot: value,
  });
  transaction.objectStore("settings").put({ key: "recentProjectId", value: value.project.id });
  await new Promise<void>((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
  db.close();
}

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

function legacyBackupFile(project: unknown): File {
  return new File([zipSync({
    "openmontage-project.json": strToU8(JSON.stringify(project)),
  })], "legacy.omproj", { type: "application/zip" });
}

function continuityPlan(
  projectType: "single_video" | "mini_series" | "long_series",
): ContinuityPlan {
  return {
    project_type: projectType,
    active_episode_number: projectType === "single_video" ? null : 1,
    series_bible: {
      worldview: "Near future",
      main_arc: "Find the sender",
      style_lock: "Noir",
      visual_rules: "Consistent wardrobe",
      taboos: [],
      locations: ["Alley"],
      props: ["Letter"],
      relationship_map: [],
    },
    episodes: projectType === "single_video" ? [] : [{
      episode_number: 1,
      title: "The Letter",
      goal: "Find the sender",
      conflict: "Hidden clues",
      twist: "The sender is nearby",
      cliffhanger: "Another letter",
      inherited_state: [],
      locked: false,
    }],
    story_state: {
      character_knowledge: [],
      relationship_changes: [],
      active_foreshadowing: [],
      resolved_foreshadowing: [],
      prop_state: [],
      character_status: [],
      current_locations: ["Alley"],
    },
  };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function incompressibleBytes(size: number, seed: number): Uint8Array {
  const result = new Uint8Array(size);
  let state = seed >>> 0;
  for (let index = 0; index < result.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result[index] = state & 0xff;
  }
  return result;
}

function installInflateWorker(options: {
  constructionError?: Error;
  hangAfterProbe?: boolean;
  asyncErrorAfterProbe?: Error;
} = {}) {
  const stats = { created: 0, active: 0, maxActive: 0 };
  const workers = new Set<InflateWorker>();
  class InflateWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    private readonly chunks: Uint8Array[] = [];
    private terminated = false;
    private readonly ordinal: number;

    constructor() {
      if (options.constructionError) throw options.constructionError;
      stats.created += 1;
      this.ordinal = stats.created;
      stats.active += 1;
      stats.maxActive = Math.max(stats.maxActive, stats.active);
      workers.add(this);
    }

    postMessage(message: unknown): void {
      if (!Array.isArray(message) || !(message[0] instanceof Uint8Array)) return;
      const chunk = new Uint8Array(message[0]);
      this.chunks.push(chunk);
      if (message[1] !== true) return;
      if (this.ordinal > 1 && options.hangAfterProbe) return;
      if (this.ordinal > 1 && options.asyncErrorAfterProbe) {
        const error = options.asyncErrorAfterProbe;
        queueMicrotask(() => this.onmessage?.({
          data: { $e$: [error.message, 0, error.stack] },
        } as MessageEvent));
        return;
      }
      const inflated = inflateSync(concatBytes(this.chunks));
      queueMicrotask(() => this.onmessage?.({ data: [inflated, true] } as MessageEvent));
    }

    terminate(): void {
      if (this.terminated) return;
      this.terminated = true;
      stats.active -= 1;
      workers.delete(this);
    }
  }
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:inflate-worker"),
  });
  vi.stubGlobal("Worker", InflateWorker);
  return {
    ...stats,
    get created() { return stats.created; },
    get active() { return stats.active; },
    get maxActive() { return stats.maxActive; },
    terminateAll: () => {
      for (const worker of [...workers]) worker.terminate();
    },
  };
}

async function streamAsSingleChunk(file: File): Promise<void> {
  const archiveBytes = new Uint8Array(await blobToArrayBuffer(file));
  Object.defineProperty(file, "stream", {
    configurable: true,
    value: () => {
      let read = false;
      return {
        getReader: () => ({
          read: async () => {
            if (read) return { done: true, value: undefined };
            read = true;
            return { done: false, value: archiveBytes };
          },
          cancel: async () => {
            read = true;
          },
        }),
      };
    },
  });
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

async function expectMalformedNestedSnapshot(value: ShortDramaProjectResponse): Promise<void> {
  await expect(importProjectBackup(backupFile({ project: value })))
    .rejects.toThrow(/metadata|invalid/i);
  expect(await loadProjectSnapshot(value.project.id)).toBeNull();
  expect(await mediaRecordCount()).toBe(0);
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalCreateObjectUrl) {
    Object.defineProperty(URL, "createObjectURL", originalCreateObjectUrl);
  } else {
    delete (URL as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
  }
  if (originalStorage) {
    Object.defineProperty(Navigator.prototype, "storage", originalStorage);
  } else {
    delete (Navigator.prototype as { storage?: StorageManager }).storage;
  }
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

  it("imports a legacy raw snapshot and derives its missing project type", async () => {
    const legacy = snapshot(null, { id: "legacy" });
    delete legacy.project.project_type;
    legacy.continuity_plan = continuityPlan("mini_series");

    const imported = await importProjectBackup(legacyBackupFile(legacy));

    expect(imported.project.project_type).toBe("mini_series");
    expect((await loadProjectSnapshot("legacy"))?.snapshot.project.project_type).toBe("mini_series");
  });

  it("rejects a raw-shaped payload with an explicit unsupported version", async () => {
    const rawVersioned = {
      ...snapshot(null, { id: "raw-versioned" }),
      version: 2,
    };

    await expect(importProjectBackup(legacyBackupFile(rawVersioned))).rejects.toThrow(/version/i);
    expect(await loadProjectSnapshot("raw-versioned")).toBeNull();
  });

  it("defaults a legacy project without any project type to single video", async () => {
    const legacy = snapshot(null, { id: "legacy-default" });
    delete legacy.project.project_type;

    const imported = await importProjectBackup(legacyBackupFile(legacy));

    expect(imported.project.project_type).toBe("single_video");
  });

  it("exports an old local snapshot without project type as a versioned backup", async () => {
    const oldLocal = snapshot(null, { id: "old-local" });
    delete oldLocal.project.project_type;
    oldLocal.continuity_plan = continuityPlan("long_series");
    await saveProjectSnapshot(oldLocal);

    const backup = await exportProjectBackup("old-local");
    const archive = unzipSync(new Uint8Array(await blobToArrayBuffer(backup)));
    const manifest = JSON.parse(strFromU8(archive["openmontage-project.json"]));

    expect(manifest.version).toBe(1);
    expect(manifest.project.project.project_type).toBe("long_series");
  });

  it("restores local media blobs referenced by the manifest", async () => {
    await saveProjectSnapshot(snapshot());
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

  it("durably creates the import session before the first media storage access", async () => {
    let sessionAtFirstStorageAccess: Record<string, unknown> | undefined;
    const opfs = installDelayedOpfs({
      onFirstStorageAccess: async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(LOCAL_DB_NAME);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
        const records = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
          const request = db.transaction("mediaOperations", "readonly")
            .objectStore("mediaOperations").getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
        sessionAtFirstStorageAccess = records.find((record) => record.kind === "import_session");
        db.close();
      },
    });
    const ref = "local://media/original" as LocalMediaRef;
    const importing = importProjectBackup(backupFile({
      project: snapshot(ref, { id: "ordered" }),
      media: [{
        ref,
        file: "media/original",
        contentType: "video/mp4",
        sourcePath: "assets/video/shot.mp4",
      }],
      mediaFiles: { "media/original": strToU8("media") },
    }));

    await opfs.writeStarted;
    expect(sessionAtFirstStorageAccess).toMatchObject({
      kind: "import_session",
      projectId: "ordered",
      state: "importing",
    });
    opfs.releaseClose();
    await expect(importing).resolves.toMatchObject({ project: { id: "ordered" } });
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

    await expect(importProjectBackup(backupFile({ version: 2 })))
      .rejects.toBeInstanceOf(BackupValidationError);

    expect((await loadRecentProjectSnapshot())?.snapshot.project.title).toBe("Existing");
    expect(await loadProjectSnapshot("p1")).toBeNull();
  });

  it("rejects malformed project envelopes before writing", async () => {
    await expect(importProjectBackup(backupFile({ project: { project: { id: "p1" } } })))
      .rejects.toThrow(/metadata|invalid/i);

    expect(await loadProjectSnapshot("p1")).toBeNull();
    expect(await mediaRecordCount()).toBe(0);
  });

  it("classifies invalid manifest JSON as backup validation failure", async () => {
    const invalidJson = new File([zipSync({
      "openmontage-project.json": strToU8("{"),
    })], "invalid-json.omproj", { type: "application/zip" });

    await expect(importProjectBackup(invalidJson)).rejects.toBeInstanceOf(BackupValidationError);
  });

  it("rejects invalid UTF-8 manifest JSON with the shared validation error", async () => {
    const invalidUtf8 = new File([zipSync({
      "openmontage-project.json": new Uint8Array([
        0x7b, 0x22, 0x76, 0x61, 0x6c, 0x75, 0x65, 0x22, 0x3a, 0x22,
        0xc3, 0x28, 0x22, 0x7d,
      ]),
    })], "invalid-utf8.omproj", { type: "application/zip" });

    await expect(importProjectBackup(invalidUtf8)).rejects.toBeInstanceOf(BackupValidationError);
  });

  it("rejects project envelopes with malformed shot records", async () => {
    const malformed = snapshot(null, { id: "imported" }) as unknown as Record<string, unknown>;
    malformed.storyboard = { shots: [{ id: "s1" }] };

    await expect(importProjectBackup(backupFile({ project: malformed })))
      .rejects.toThrow(/metadata|invalid/i);

    expect(await loadProjectSnapshot("imported")).toBeNull();
  });

  it("rejects malformed nested character records", async () => {
    const malformed = snapshot(null, { id: "bad-character" });
    malformed.series_bible.characters = [{ id: "character-1" }] as never;

    await expectMalformedNestedSnapshot(malformed);
  });

  it("rejects malformed nested asset media arrays", async () => {
    const malformed = snapshot(null, { id: "bad-asset" });
    malformed.series_bible.assets = [{
      id: "asset-1",
      kind: "scene",
      label: "Alley",
      reference_images: "not-an-array",
    }] as never;

    await expectMalformedNestedSnapshot(malformed);
  });

  it("rejects malformed shot language and revision records", async () => {
    const malformed = snapshot(null, { id: "bad-shot-nested" });
    malformed.storyboard.shots[0].shot_language = { lens_mm: 13 } as never;
    malformed.storyboard.shots[0].history = [{ version: 1, source: "unknown" }] as never;

    await expectMalformedNestedSnapshot(malformed);
  });

  it("rejects malformed consistency issues", async () => {
    const malformed = snapshot(null, { id: "bad-consistency" });
    malformed.consistency_report.issues = [{
      shot_id: null,
      severity: "fatal",
      code: "bad",
      message: "bad",
    }] as never;

    await expectMalformedNestedSnapshot(malformed);
  });

  it("rejects malformed continuity episodes and story state", async () => {
    const malformed = snapshot(null, { id: "bad-continuity" });
    malformed.continuity_plan = {
      ...continuityPlan("mini_series"),
      episodes: [{
        ...continuityPlan("mini_series").episodes[0],
        locked: "yes",
      }],
      story_state: {
        ...continuityPlan("mini_series").story_state,
        current_locations: "Alley",
      },
    } as never;

    await expectMalformedNestedSnapshot(malformed);
  });

  it("rejects malformed workflow artifacts", async () => {
    const malformed = snapshot(null, { id: "bad-workflow" });
    malformed.workflow_artifacts = [{ name: "storyboard.json", path: 7, exists: true }] as never;

    await expectMalformedNestedSnapshot(malformed);
  });

  it("rejects malformed render reports", async () => {
    const malformed = snapshot(null, { id: "bad-render" });
    malformed.render_report = {
      version: "2.0",
      outputs: [{
        path: "render.mp4",
        format: "mp4",
        resolution: "1080p",
        duration_seconds: Number.NaN,
      }],
    } as never;

    await expectMalformedNestedSnapshot(malformed);
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

  it("rejects safe non-media archive entries undeclared by the backup manifests", async () => {
    await expect(importProjectBackup(backupFile({
      project: snapshot(null, { id: "safe-extra" }),
      mediaFiles: { "notes.txt": strToU8("notes") },
    }))).rejects.toThrow(/undeclared/i);

    expect(await loadProjectSnapshot("safe-extra")).toBeNull();
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
    await saveProjectSnapshot(snapshot(null, { title: "Existing" }));
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

  it("atomically rejects a project created by another connection during media staging", async () => {
    const opfs = installDelayedOpfs();
    const ref = "local://media/imported" as LocalMediaRef;
    const importing = importProjectBackup(backupFile({
      project: snapshot(ref, { id: "raced", title: "Imported" }),
      media: [{
        ref,
        file: "media/imported",
        contentType: "video/mp4",
        sourcePath: "assets/video/imported.mp4",
      }],
      mediaFiles: { "media/imported": strToU8("imported") },
    }));
    await opfs.writeStarted;

    await saveThroughSecondConnection(snapshot(null, { id: "raced", title: "Concurrent" }));
    opfs.releaseClose();

    await expect(importing).rejects.toBeInstanceOf(ProjectImportConflictError);
    expect((await loadProjectSnapshot("raced"))?.snapshot.project.title).toBe("Concurrent");
    expect(await mediaRecordCount()).toBe(0);
    expect(opfs.files.size).toBe(0);
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

    await expect(importProjectBackup(backup)).rejects.toBeInstanceOf(BackupValidationError);
  });

  it("rejects export when the actual project manifest exceeds its JSON limit", async () => {
    const oversized = snapshot(null, { id: "oversized-export" });
    oversized.project.title = "x".repeat(8 * 1024 * 1024);
    await saveProjectSnapshot(oversized);

    await expect(exportProjectBackup("oversized-export")).rejects.toThrow(/manifest.*limit/i);
  });

  it("rejects an actually decompressed project manifest over its JSON limit", async () => {
    const oversized = snapshot(null, { id: "oversized-import" });
    oversized.project.title = "x".repeat(8 * 1024 * 1024);

    await expect(importProjectBackup(backupFile({ project: oversized }))).rejects.toThrow(
      /manifest.*limit/i,
    );
    expect(await loadProjectSnapshot("oversized-import")).toBeNull();
  });

  it("uses a Worker for high-compression output and enforces the actual manifest limit", async () => {
    const workerStats = installInflateWorker();
    const oversized = snapshot(null, { id: "high-compression" });
    oversized.project.title = "x".repeat(8 * 1024 * 1024);
    const backup = await patchDeclaredSize(
      backupFile({ project: oversized }),
      "openmontage-project.json",
      400_000,
    );

    await expect(importProjectBackup(backup)).rejects.toThrow(/manifest.*limit/i);
    expect(workerStats.created).toBe(2);
    expect(await loadProjectSnapshot("high-compression")).toBeNull();
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

  it("falls back to bounded synchronous inflate when Worker construction is blocked", async () => {
    installInflateWorker({ constructionError: new DOMException("Blocked by CSP", "SecurityError") });

    const imported = await importProjectBackup(backupFile({
      project: snapshot(null, { id: "csp-fallback" }),
    }));

    expect(imported.project.id).toBe("csp-fallback");
  });

  it("does not create a Worker for every small deflated archive entry", async () => {
    const workerStats = installInflateWorker();
    const mediaFiles = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`extra/small-${index}`, strToU8(`small-${index}`)]),
    );

    await expect(importProjectBackup(backupFile({
      project: snapshot(null, { id: "small-entries" }),
      mediaFiles,
    }))).rejects.toThrow(/undeclared/i);

    expect(workerStats.created).toBe(1);
    expect(workerStats.maxActive).toBe(1);
  });

  it("uses at most two concurrent Workers for large deflated entries", async () => {
    const workerStats = installInflateWorker();
    const mediaFiles = Object.fromEntries(
      Array.from({ length: 3 }, (_, index) => [
        `extra/large-${index}`,
        incompressibleBytes(400_000, index + 1),
      ]),
    );
    const backup = backupFile({
      project: snapshot(null, { id: "large-entries" }),
      mediaFiles,
    });
    await streamAsSingleChunk(backup);

    await expect(importProjectBackup(backup)).rejects.toThrow(/undeclared/i);

    expect(workerStats.created).toBe(4);
    expect(workerStats.maxActive).toBeLessThanOrEqual(2);
  });

  it("rejects and releases all decoder slots when active Workers stop responding", async () => {
    const workerStats = installInflateWorker({ hangAfterProbe: true });
    const mediaFiles = Object.fromEntries(
      Array.from({ length: 3 }, (_, index) => [
        `extra/hang-${index}`,
        incompressibleBytes(400_000, index + 11),
      ]),
    );
    const backup = backupFile({
      project: snapshot(null, { id: "worker-hang" }),
      mediaFiles,
    });
    await streamAsSingleChunk(backup);
    vi.useFakeTimers();

    let outcome: "pending" | "resolved" | "rejected" = "pending";
    void importProjectBackup(backup).then(
      () => { outcome = "resolved"; },
      () => { outcome = "rejected"; },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(workerStats.created).toBe(3);
    await vi.advanceTimersByTimeAsync(30_000);
    const observedOutcome = outcome;
    workerStats.terminateAll();

    expect(observedOutcome).toBe("rejected");
    expect(workerStats.active).toBe(0);
  });

  it("rejects an asynchronous Worker error before starting a queued decoder", async () => {
    const workerStats = installInflateWorker({
      asyncErrorAfterProbe: new Error("Worker inflate failed"),
    });
    const mediaFiles = Object.fromEntries(
      Array.from({ length: 3 }, (_, index) => [
        `extra/error-${index}`,
        incompressibleBytes(400_000, index + 21),
      ]),
    );
    const backup = backupFile({
      project: snapshot(null, { id: "worker-error" }),
      mediaFiles,
    });
    await streamAsSingleChunk(backup);

    await expect(importProjectBackup(backup)).rejects.toThrow(/Worker inflate failed/i);
    expect(workerStats.created).toBe(3);
    expect(workerStats.active).toBe(0);
  });
});
