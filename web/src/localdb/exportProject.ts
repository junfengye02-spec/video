import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { ShortDramaProjectResponse } from "../domain/types";
import { loadMediaBlob, saveMediaBlob } from "./mediaStore";
import { loadProjectSnapshot, saveProjectSnapshot } from "./projectStore";
import type { LocalMediaRef } from "./types";

const MANIFEST_NAME = "openmontage-project.json";
const MEDIA_MANIFEST_NAME = "openmontage-media.json";
const LOCAL_MEDIA_PREFIX = "local://media/";

type MediaBackupEntry = {
  ref: LocalMediaRef;
  file: string;
  contentType: string;
  sourcePath: string;
};

type MediaBackupManifest = {
  version: 1;
  media: MediaBackupEntry[];
};

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
      reject(new Error("Could not read backup file"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

function isLocalMediaRef(value: unknown): value is LocalMediaRef {
  return typeof value === "string" && value.startsWith(LOCAL_MEDIA_PREFIX);
}

function collectLocalMediaRefs(value: unknown, refs = new Set<LocalMediaRef>()): Set<LocalMediaRef> {
  if (isLocalMediaRef(value)) {
    refs.add(value);
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLocalMediaRefs(item, refs);
    }
    return refs;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectLocalMediaRefs(item, refs);
    }
  }
  return refs;
}

function rewriteLocalMediaRefs(value: unknown, refMap: Map<LocalMediaRef, LocalMediaRef>): unknown {
  if (isLocalMediaRef(value)) {
    return refMap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteLocalMediaRefs(item, refMap));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewriteLocalMediaRefs(item, refMap)]),
    );
  }
  return value;
}

function mediaIdFromRef(ref: LocalMediaRef): string {
  return ref.slice(LOCAL_MEDIA_PREFIX.length);
}

function validateSnapshot(value: ShortDramaProjectResponse): void {
  if (!value.project?.id || !value.project.title || !Array.isArray(value.storyboard?.shots)) {
    throw new Error("Backup project metadata is invalid");
  }
}

export async function exportProjectBackup(projectId: string): Promise<Blob> {
  const record = await loadProjectSnapshot(projectId);
  if (!record) {
    throw new Error("Project not found in this browser");
  }

  const files: Record<string, Uint8Array> = {
    [MANIFEST_NAME]: strToU8(JSON.stringify(record.snapshot, null, 2)),
  };
  const mediaManifest: MediaBackupManifest = { version: 1, media: [] };

  for (const ref of collectLocalMediaRefs(record.snapshot)) {
    const blob = await loadMediaBlob(ref);
    if (!blob) {
      continue;
    }
    const file = `media/${mediaIdFromRef(ref)}`;
    files[file] = new Uint8Array(await blobToArrayBuffer(blob));
    mediaManifest.media.push({
      ref,
      file,
      contentType: blob.type || "application/octet-stream",
      sourcePath: file,
    });
  }

  if (mediaManifest.media.length > 0) {
    files[MEDIA_MANIFEST_NAME] = strToU8(JSON.stringify(mediaManifest, null, 2));
  }

  return new Blob([zipSync(files)], { type: "application/zip" });
}

export async function importProjectBackup(file: File): Promise<ShortDramaProjectResponse> {
  const bytes = new Uint8Array(await blobToArrayBuffer(file));
  const files = unzipSync(bytes);
  const manifestBytes = files[MANIFEST_NAME];
  if (!manifestBytes) {
    throw new Error("Backup is missing openmontage-project.json");
  }

  const snapshot = JSON.parse(strFromU8(manifestBytes)) as ShortDramaProjectResponse;
  validateSnapshot(snapshot);

  const refMap = new Map<LocalMediaRef, LocalMediaRef>();
  const mediaManifestBytes = files[MEDIA_MANIFEST_NAME];
  const mediaManifest = mediaManifestBytes
    ? (JSON.parse(strFromU8(mediaManifestBytes)) as MediaBackupManifest)
    : null;

  for (const entry of mediaManifest?.media ?? []) {
    const mediaBytes = files[entry.file];
    if (!mediaBytes || !isLocalMediaRef(entry.ref)) {
      continue;
    }
    const restoredRef = await saveMediaBlob({
      projectId: snapshot.project.id,
      sourcePath: entry.sourcePath || entry.file,
      contentType: entry.contentType || "application/octet-stream",
      blob: new Blob([mediaBytes], { type: entry.contentType || "application/octet-stream" }),
    });
    refMap.set(entry.ref, restoredRef);
  }

  const restoredSnapshot =
    refMap.size > 0
      ? (rewriteLocalMediaRefs(snapshot, refMap) as ShortDramaProjectResponse)
      : snapshot;
  validateSnapshot(restoredSnapshot);
  await saveProjectSnapshot(restoredSnapshot);
  return restoredSnapshot;
}
