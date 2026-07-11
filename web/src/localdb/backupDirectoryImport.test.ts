/// <reference types="vite/client" />

import { describe, expect, it, vi } from "vitest";
import type { ShortDramaProjectResponse } from "../domain/types";
import backupDirectoryImportSource from "./backupDirectoryImport.ts?raw";
import {
  BACKUP_MEDIA_MANIFEST_NAME,
  BACKUP_PROJECT_MANIFEST_NAME,
  BackupValidationError,
  type BackupEntryCallbacks,
  type BackupReadProgress,
  type ValidatedBackupEntry,
} from "./backupFormat";
import { readBackupDirectory } from "./backupDirectoryImport";
import type { LocalMediaRef } from "./types";

function snapshot(ref: LocalMediaRef | null = null): ShortDramaProjectResponse {
  return {
    project: {
      id: "project-1",
      title: "Rain Alley",
      mode: "short_drama",
      project_type: "single_video",
    },
    series_bible: { characters: [], assets: [] },
    storyboard: {
      shots: [{
        id: "shot-1",
        scene_id: "scene-1",
        index: 1,
        beat: "Reveal",
        prompt: "Rain",
        characters: [],
        location: null,
        props: [],
        status: "complete",
        consistency_score: 100,
        output_url: null,
        output_path: ref,
        asset_ids: [],
        version: 1,
        history: [],
      }],
    },
    consistency_report: { score: 100, issues: [] },
    workflow_artifacts: [],
    final_path: ref,
  };
}

function selectedFile(path: string, contents: BlobPart, type = "application/octet-stream"): File {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? path;
  const file = new File([contents], name, { type });
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

function flatFile(name: string, contents: BlobPart, type = "application/octet-stream"): File {
  return new File([contents], name, { type });
}

function backupFiles(options: { relative?: boolean; extra?: File } = {}): File[] {
  const ref = "local://media/original" as LocalMediaRef;
  const project = JSON.stringify({ version: 1, project: snapshot(ref) });
  const media = JSON.stringify({
    version: 1,
    media: [{
      ref,
      file: "media/original.mp4",
      contentType: "video/mp4",
      sourcePath: "assets/video/original.mp4",
    }],
  });
  const make = options.relative
    ? (name: string, value: BlobPart, type?: string) => selectedFile(`rain-backup/${name}`, value, type)
    : flatFile;
  return [
    make(BACKUP_PROJECT_MANIFEST_NAME, project, "application/json"),
    make(BACKUP_MEDIA_MANIFEST_NAME, media, "application/json"),
    make(options.relative ? "media/original.mp4" : "original.mp4", "video", "video/mp4"),
    ...(options.extra ? [options.extra] : []),
  ];
}

function collectingCallbacks(options: { abort?: AbortController } = {}) {
  const starts: ValidatedBackupEntry[] = [];
  const chunks = new Map<string, number>();
  const ends: string[] = [];
  const progress: BackupReadProgress[] = [];
  const complete = vi.fn();
  const callbacks: BackupEntryCallbacks = {
    onEntryStart: async (entry) => {
      starts.push(entry);
      options.abort?.abort();
    },
    onEntryChunk: async (entry, chunk) => {
      chunks.set(entry.name, (chunks.get(entry.name) ?? 0) + chunk.byteLength);
    },
    onEntryEnd: async (entry) => { ends.push(entry.name); },
    onProgress: async (value) => { progress.push(value); },
    onComplete: complete,
  };
  return { callbacks, starts, chunks, ends, progress, complete };
}

describe("readBackupDirectory", () => {
  it("strips one common webkitRelativePath root and streams validated entries", async () => {
    const observed = collectingCallbacks();

    const result = await readBackupDirectory(backupFiles({ relative: true }), observed.callbacks);

    expect(result.project.project.id).toBe("project-1");
    expect(result.entries.map((entry) => entry.name)).toEqual([
      BACKUP_PROJECT_MANIFEST_NAME,
      BACKUP_MEDIA_MANIFEST_NAME,
      "media/original.mp4",
    ]);
    expect(observed.starts.map((entry) => entry.name)).toEqual(result.entries.map((entry) => entry.name));
    expect(observed.starts[observed.starts.length - 1]).toMatchObject({
      kind: "media",
      media: { sourcePath: "assets/video/original.mp4", contentType: "video/mp4" },
      projectId: "project-1",
    });
    expect(observed.chunks.get("media/original.mp4")).toBe(5);
    expect(observed.ends).toEqual(result.entries.map((entry) => entry.name));
    expect(observed.complete).toHaveBeenCalledWith(result);
  });

  it("matches a multiple-file selection by unique basename", async () => {
    const files = backupFiles().reverse();
    const observed = collectingCallbacks();

    const result = await readBackupDirectory(files, observed.callbacks);

    expect(result.entries[result.entries.length - 1]?.name).toBe("media/original.mp4");
    expect(observed.chunks.get("media/original.mp4")).toBe(5);
  });

  it("rejects duplicate basenames in multiple-file mode", async () => {
    const files = backupFiles();
    files.push(flatFile("original.mp4", "duplicate"));

    await expect(readBackupDirectory(files, collectingCallbacks().callbacks))
      .rejects.toThrow(/duplicate.*basename/i);
  });

  it("rejects unsafe and duplicate relative paths", async () => {
    const unsafe = backupFiles({ relative: true });
    unsafe[2] = selectedFile("rain-backup/media/../original.mp4", "video");
    await expect(readBackupDirectory(unsafe, collectingCallbacks().callbacks))
      .rejects.toBeInstanceOf(BackupValidationError);

    const duplicate = backupFiles({ relative: true });
    duplicate.push(selectedFile("rain-backup/media/original.mp4", "duplicate"));
    await expect(readBackupDirectory(duplicate, collectingCallbacks().callbacks))
      .rejects.toThrow(/duplicate/i);
  });

  it("rejects missing manifests, missing media, and undeclared retained media before callbacks", async () => {
    const missingProject = backupFiles({ relative: true }).slice(1);
    const first = collectingCallbacks();
    await expect(readBackupDirectory(missingProject, first.callbacks)).rejects.toThrow(/project manifest/i);
    expect(first.starts).toHaveLength(0);

    const missingMedia = backupFiles({ relative: true }).slice(0, 2);
    const second = collectingCallbacks();
    await expect(readBackupDirectory(missingMedia, second.callbacks)).rejects.toThrow(/missing/i);
    expect(second.starts).toHaveLength(0);

    const extra = backupFiles({
      relative: true,
      extra: selectedFile("rain-backup/media/extra.mp4", "extra"),
    });
    const third = collectingCallbacks();
    await expect(readBackupDirectory(extra, third.callbacks)).rejects.toThrow(/undeclared/i);
    expect(third.starts).toHaveLength(0);
  });

  it("rejects schema-invalid project data before emitting media", async () => {
    const files = backupFiles({ relative: true });
    files[0] = selectedFile(
      `rain-backup/${BACKUP_PROJECT_MANIFEST_NAME}`,
      JSON.stringify({ version: 1, project: { project: { id: "bad" } } }),
      "application/json",
    );
    const observed = collectingCallbacks();

    await expect(readBackupDirectory(files, observed.callbacks)).rejects.toThrow(/metadata|invalid/i);
    expect(observed.starts).toHaveLength(0);
  });

  it("reports monotonic byte and entry progress through completion", async () => {
    const observed = collectingCallbacks();

    await readBackupDirectory(backupFiles({ relative: true }), observed.callbacks);

    expect(observed.progress.length).toBeGreaterThan(0);
    for (let index = 1; index < observed.progress.length; index += 1) {
      expect(observed.progress[index].bytesRead).toBeGreaterThanOrEqual(
        observed.progress[index - 1].bytesRead,
      );
      expect(observed.progress[index].entriesRead).toBeGreaterThanOrEqual(
        observed.progress[index - 1].entriesRead,
      );
    }
    const finalProgress = observed.progress[observed.progress.length - 1];
    expect(finalProgress).toMatchObject({
      bytesRead: finalProgress.totalBytes,
      entriesRead: 3,
      totalEntries: 3,
    });
  });

  it("honors cancellation between callbacks", async () => {
    const controller = new AbortController();
    const observed = collectingCallbacks({ abort: controller });

    await expect(readBackupDirectory(
      backupFiles({ relative: true }),
      observed.callbacks,
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });

    expect(observed.starts).toHaveLength(1);
    expect(observed.chunks.size).toBe(0);
    expect(observed.complete).not.toHaveBeenCalled();
  });

  it("rejects actual bytes that exceed a forged declared file size", async () => {
    const files = backupFiles({ relative: true });
    Object.defineProperty(files[2], "size", { value: 0 });

    await expect(readBackupDirectory(files, collectingCallbacks().callbacks))
      .rejects.toThrow(/size|bytes|length/i);
  });

  it("rejects undeclared non-media directory files before callbacks", async () => {
    const files = backupFiles({
      relative: true,
      extra: selectedFile("rain-backup/notes.txt", "notes"),
    });
    const observed = collectingCallbacks();

    await expect(readBackupDirectory(files, observed.callbacks)).rejects.toThrow(/undeclared/i);
    expect(observed.starts).toHaveLength(0);
  });

  it("does not import a ZIP decoder", () => {
    expect(backupDirectoryImportSource).not.toMatch(/from\s+["']fflate(?:\/browser)?["']/);
  });
});
