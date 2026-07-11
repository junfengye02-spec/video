/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import type { ShortDramaProjectResponse } from "../domain/types";
import backupFormatSource from "./backupFormat.ts?raw";
import {
  BACKUP_MEDIA_MANIFEST_NAME,
  BACKUP_PROJECT_MANIFEST_NAME,
  BackupByteAccount,
  BackupValidationError,
  MANIFEST_NAME,
  MAX_ARCHIVE_ENTRIES,
  MAX_MANIFEST_BYTES,
  MEDIA_MANIFEST_NAME,
  archiveEntryByteLimit,
  collectLocalMediaRefs,
  isSafeArchiveEntryName,
  isSafeBackupPath,
  parseBackupJson,
  validateBackupManifests,
  validateMediaManifest,
  validateProjectEnvelope,
} from "./backupFormat";
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

describe("backupFormat", () => {
  it("exports the legacy constant and path-helper names for shared consumers", () => {
    expect(MANIFEST_NAME).toBe(BACKUP_PROJECT_MANIFEST_NAME);
    expect(MEDIA_MANIFEST_NAME).toBe(BACKUP_MEDIA_MANIFEST_NAME);
    expect(MAX_ARCHIVE_ENTRIES).toBe(512);
    expect(archiveEntryByteLimit(MANIFEST_NAME)).toBe(MAX_MANIFEST_BYTES);
    expect(isSafeArchiveEntryName("media/clip.mp4")).toBe(true);
  });

  it("accepts legacy v0 snapshots and version 1 envelopes", () => {
    const legacy = snapshot();
    delete legacy.project.project_type;

    expect(validateProjectEnvelope(legacy).project.project_type).toBe("single_video");
    expect(validateProjectEnvelope({ version: 1, project: snapshot() }).project.id)
      .toBe("project-1");
  });

  it("rejects unsupported versions and schema-invalid envelopes with typed errors", () => {
    expect(() => validateProjectEnvelope({ version: 2, project: snapshot() }))
      .toThrow(BackupValidationError);
    expect(() => validateProjectEnvelope({ version: 1, project: { project: { id: "bad" } } }))
      .toThrow(BackupValidationError);
  });

  it("rejects invalid UTF-8 JSON with a typed validation error", () => {
    const invalidUtf8 = new Uint8Array([
      0x7b, 0x22, 0x76, 0x61, 0x6c, 0x75, 0x65, 0x22, 0x3a, 0x22,
      0xc3, 0x28, 0x22, 0x7d,
    ]);

    expect(() => parseBackupJson(invalidUtf8, BACKUP_PROJECT_MANIFEST_NAME))
      .toThrow(BackupValidationError);
  });

  it.each([
    "",
    "/absolute",
    "C:/absolute",
    "media\\windows",
    "media//empty",
    "media/./dot",
    "media/../escape",
    "media/trailing/",
  ])("rejects unsafe backup path %j", (path) => {
    expect(isSafeBackupPath(path)).toBe(false);
  });

  it("accepts only canonical bounded backup paths", () => {
    expect(isSafeBackupPath(BACKUP_PROJECT_MANIFEST_NAME)).toBe(true);
    expect(isSafeBackupPath(BACKUP_MEDIA_MANIFEST_NAME)).toBe(true);
    expect(isSafeBackupPath("media/clip-1.mp4")).toBe(true);
    expect(isSafeBackupPath(`media/${"x".repeat(251)}`)).toBe(false);
  });

  it("rejects duplicate paths and excessive entry counts", () => {
    const duplicate = new BackupByteAccount({ maxEntries: 2 });
    duplicate.registerEntry("media/one", 1);
    expect(() => duplicate.registerEntry("media/one", 1)).toThrow(/duplicate/i);

    const count = new BackupByteAccount({ maxEntries: 1 });
    count.registerEntry(BACKUP_PROJECT_MANIFEST_NAME, 1);
    expect(() => count.registerEntry(BACKUP_MEDIA_MANIFEST_NAME, 1)).toThrow(/entr(y|ies)/i);
  });

  it("accounts actual manifest, per-entry, and total bytes", () => {
    const manifest = new BackupByteAccount({
      maxEntries: 3,
      maxManifestBytes: 4,
      maxEntryBytes: 8,
      maxTotalBytes: 12,
    });
    manifest.registerEntry(BACKUP_PROJECT_MANIFEST_NAME, 1);
    expect(() => manifest.addActualBytes(BACKUP_PROJECT_MANIFEST_NAME, 5))
      .toThrow(/manifest.*limit/i);

    const entry = new BackupByteAccount({
      maxEntries: 3,
      maxManifestBytes: 4,
      maxEntryBytes: 4,
      maxTotalBytes: 12,
    });
    entry.registerEntry("media/one", 1);
    expect(() => entry.addActualBytes("media/one", 5)).toThrow(/entry.*limit/i);

    const total = new BackupByteAccount({
      maxEntries: 3,
      maxManifestBytes: 8,
      maxEntryBytes: 8,
      maxTotalBytes: 5,
    });
    total.registerEntry(BACKUP_PROJECT_MANIFEST_NAME, 1);
    total.registerEntry("media/one", 1);
    total.addActualBytes(BACKUP_PROJECT_MANIFEST_NAME, 3);
    expect(() => total.addActualBytes("media/one", 3)).toThrow(/total.*limit/i);
  });

  it("validates media schema, required refs, missing files, and undeclared files", () => {
    const ref = "local://media/original" as LocalMediaRef;
    const requiredRefs = collectLocalMediaRefs(snapshot(ref));
    const valid = {
      version: 1,
      media: [{
        ref,
        file: "media/original",
        contentType: "video/mp4",
        sourcePath: "assets/video/original.mp4",
      }],
    };

    expect(validateMediaManifest(valid, requiredRefs, ["media/original"]).media).toHaveLength(1);
    expect(() => validateMediaManifest({ ...valid, version: 2 }, requiredRefs, ["media/original"]))
      .toThrow(/version|unsupported/i);
    expect(() => validateMediaManifest(valid, requiredRefs, []))
      .toThrow(/missing/i);
    expect(() => validateMediaManifest(valid, requiredRefs, ["media/original", "media/extra"]))
      .toThrow(/undeclared/i);
    expect(() => validateMediaManifest({ version: 1, media: [] }, requiredRefs, []))
      .toThrow(/resolve every local media/i);
  });

  it("requires the media manifest exactly when retained media or local refs exist", () => {
    const ref = "local://media/original" as LocalMediaRef;
    expect(() => validateBackupManifests(
      { version: 1, project: snapshot(ref) },
      undefined,
      ["media/original"],
    )).toThrow(/missing.*media manifest/i);

    expect(() => validateBackupManifests(
      { version: 1, project: snapshot() },
      undefined,
      ["media/orphan"],
    )).toThrow(/without a media manifest/i);
  });

  it("rejects every undeclared safe entry in the shared manifest inventory", () => {
    expect(() => validateBackupManifests(
      { version: 1, project: snapshot() },
      undefined,
      [BACKUP_PROJECT_MANIFEST_NAME, "notes.txt"],
    )).toThrow(/undeclared/i);
  });

  it("does not import a ZIP decoder", () => {
    expect(backupFormatSource).not.toMatch(/from\s+["']fflate(?:\/browser)?["']/);
  });
});
