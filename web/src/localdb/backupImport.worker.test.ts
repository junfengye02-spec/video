import { strToU8, Zip, ZipPassThrough, zipSync, type Zippable } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { ShortDramaProjectResponse } from "../domain/types";
import {
  installBackupImportWorker,
  type BackupImportWorkerScope,
} from "./backupImport.worker";
import type { BackupWorkerRequest, BackupWorkerResponse } from "./backupArchiveClient";
import type { LocalMediaRef } from "./types";

function snapshot(ref: LocalMediaRef | null = null): ShortDramaProjectResponse {
  return {
    project: { id: "worker-project", title: "Worker", mode: "short_drama", project_type: "single_video" },
    series_bible: { characters: [], assets: [] },
    storyboard: { shots: [{
      id: "shot-1", scene_id: "scene-1", index: 1, beat: "Reveal", prompt: "Rain",
      characters: [], location: null, props: [], status: "complete", consistency_score: 100,
      output_url: null, output_path: ref, asset_ids: [], version: 1, history: [],
    }] },
    consistency_report: { score: 100, issues: [] },
    workflow_artifacts: [],
    final_path: ref,
  };
}

class TestWorkerScope implements BackupImportWorkerScope {
  private listener: ((event: MessageEvent<BackupWorkerRequest>) => void) | null = null;
  readonly responses: BackupWorkerResponse[] = [];
  readonly transfers: Transferable[][] = [];
  autoAck = true;
  notify: (() => void) | null = null;

  addEventListener(_type: "message", listener: (event: MessageEvent<BackupWorkerRequest>) => void): void {
    this.listener = listener;
  }

  postMessage(message: BackupWorkerResponse, transfer: Transferable[] = []): void {
    this.responses.push(message);
    this.transfers.push(transfer);
    this.notify?.();
    if (this.autoAck && message.type === "entry-chunk") {
      queueMicrotask(() => this.dispatch({
        type: "ack",
        requestId: message.requestId,
        sequence: message.sequence,
      }));
    }
  }

  dispatch(message: BackupWorkerRequest): void {
    this.listener?.({ data: message } as MessageEvent<BackupWorkerRequest>);
  }

  async waitFor(predicate: (message: BackupWorkerResponse) => boolean): Promise<BackupWorkerResponse> {
    const existing = this.responses.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for worker response")), 5_000);
      this.notify = () => {
        const match = this.responses.find(predicate);
        if (!match) return;
        clearTimeout(timeout);
        this.notify = null;
        resolve(match);
      };
    });
  }
}

function backupFile(entries: Record<string, Uint8Array>): File {
  return new File([zipSync(entries)], "project.omproj", { type: "application/zip" });
}

type ZipLayoutEntry = {
  name: string;
  centralOffset: number;
  localOffset: number;
  payloadOffset: number;
  descriptorOffset: number;
};

type ZipLayout = {
  eocdOffset: number;
  centralOffset: number;
  entries: ZipLayoutEntry[];
};

async function fileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
      else reject(new Error("Could not read test ZIP"));
    };
    reader.readAsArrayBuffer(file);
  });
}

function inspectZip(bytes: Uint8Array): ZipLayout {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("EOCD not found");
  const decoder = new TextDecoder();
  const count = view.getUint16(eocdOffset + 10, true);
  const directoryOffset = view.getUint32(eocdOffset + 16, true);
  let centralOffset = directoryOffset;
  const entries: ZipLayoutEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(centralOffset, true) !== 0x02014b50) {
      throw new Error("Central entry not found");
    }
    const compressedSize = view.getUint32(centralOffset + 20, true);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const localOffset = view.getUint32(centralOffset + 42, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const name = decoder.decode(bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength));
    const payloadOffset = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({
      name,
      centralOffset,
      localOffset,
      payloadOffset,
      descriptorOffset: payloadOffset + compressedSize,
    });
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return { eocdOffset, centralOffset: directoryOffset, entries };
}

async function mutateBackup(
  file: File,
  mutate: (view: DataView, layout: ZipLayout, bytes: Uint8Array) => void,
): Promise<File> {
  const bytes = await fileBytes(file);
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  mutate(view, inspectZip(copy), copy);
  return new File([copy], file.name, { type: file.type });
}

async function insertUnindexedLocalRecord(
  file: File,
  placement: "before-first" | "between-indexed" | "before-central",
): Promise<File> {
  const bytes = await fileBytes(file);
  const layout = inspectZip(bytes);
  const byLocalOffset = [...layout.entries].sort((left, right) => left.localOffset - right.localOffset);
  const insertOffset = placement === "before-first"
    ? 0
    : placement === "between-indexed"
      ? byLocalOffset[1].localOffset
      : layout.centralOffset;
  const orphanArchive = zipSync({ "orphan.bin": strToU8("hidden") }, { level: 0 });
  const orphanLocalRecord = orphanArchive.subarray(0, inspectZip(orphanArchive).centralOffset);
  const shifted = new Uint8Array(bytes.byteLength + orphanLocalRecord.byteLength);
  shifted.set(bytes.subarray(0, insertOffset));
  shifted.set(orphanLocalRecord, insertOffset);
  shifted.set(bytes.subarray(insertOffset), insertOffset + orphanLocalRecord.byteLength);

  const shiftedView = new DataView(shifted.buffer);
  const delta = orphanLocalRecord.byteLength;
  for (const entry of layout.entries) {
    const centralEntryOffset = entry.centralOffset + delta;
    const localOffset = entry.localOffset >= insertOffset ? entry.localOffset + delta : entry.localOffset;
    shiftedView.setUint32(centralEntryOffset + 42, localOffset, true);
  }
  shiftedView.setUint32(layout.eocdOffset + delta + 16, layout.centralOffset + delta, true);
  return new File([shifted], file.name, { type: file.type });
}

async function streamingBackup(entries: Record<string, Uint8Array>): Promise<File> {
  const chunks: ArrayBuffer[] = [];
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const zip = new Zip((error, data, final) => {
    if (error) rejectDone(error);
    else {
      chunks.push(data.slice().buffer as ArrayBuffer);
      if (final) resolveDone();
    }
  });
  for (const [name, bytes] of Object.entries(entries)) {
    const entry = new ZipPassThrough(name);
    zip.add(entry);
    entry.push(bytes, true);
  }
  zip.end();
  await done;
  return new File(chunks, "streaming.omproj", { type: "application/zip" });
}

async function terminalResponse(file: File): Promise<{
  terminal: BackupWorkerResponse;
  responses: BackupWorkerResponse[];
}> {
  const scope = new TestWorkerScope();
  installBackupImportWorker(scope);
  scope.dispatch({ type: "start", requestId: "review", file });
  const terminal = await scope.waitFor(
    (message) => message.type === "failure" || message.type === "complete",
  );
  return { terminal, responses: scope.responses };
}

async function expectStructuralFailureBeforeMedia(file: File): Promise<void> {
  const { terminal, responses } = await terminalResponse(file);
  expect(terminal).toMatchObject({ type: "failure", code: "validation" });
  expect(responses.some(
    (message) => message.type === "entry-start" && message.name.startsWith("media/"),
  )).toBe(false);
}

function validEntries(
  mediaBytes: Uint8Array<ArrayBufferLike> = strToU8("media"),
): Record<string, Uint8Array<ArrayBufferLike>> {
  const ref = "local://media/original" as LocalMediaRef;
  return {
    "media/original": mediaBytes,
    "openmontage-media.json": strToU8(JSON.stringify({ version: 1, media: [{
      ref,
      file: "media/original",
      contentType: "video/mp4",
      sourcePath: "assets/video/original.mp4",
    }] })),
    "openmontage-project.json": strToU8(JSON.stringify({ version: 1, project: snapshot(ref) })),
  };
}

function incompressibleBytes(size: number, seed = 0x12345678): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

describe("backup import module Worker", () => {
  it.each([
    ["before the first indexed entry", "before-first"],
    ["between indexed entries", "between-indexed"],
    ["between the final entry and central directory", "before-central"],
  ] as const)("rejects an unindexed local record %s before media callbacks", async (_label, placement) => {
    const mutated = await insertUnindexedLocalRecord(backupFile(validEntries()), placement);

    await expectStructuralFailureBeforeMedia(mutated);
  });

  it("rejects an empty archive as missing the project manifest", async () => {
    const { terminal, responses } = await terminalResponse(backupFile({}));

    expect(terminal).toMatchObject({ type: "failure", code: "validation" });
    expect((terminal as Extract<BackupWorkerResponse, { type: "failure" }>).message)
      .toMatch(/missing openmontage-project\.json/i);
    expect(responses.some(
      (message) => message.type === "entry-start" && message.name.startsWith("media/"),
    )).toBe(false);
  });

  it.each([
    ["stored", async () => new File([zipSync(validEntries(), { level: 0 })], "stored.omproj")],
    ["data-descriptor", async () => streamingBackup(validEntries())],
  ] as const)("accepts a valid %s archive with exact local spans", async (_label, createFile) => {
    const { terminal } = await terminalResponse(await createFile());

    expect(terminal).toMatchObject({ type: "complete" });
  });

  it("does not slice or decode a large media payload during pass 1", async () => {
    const bytes = zipSync(validEntries(incompressibleBytes(2 * 1024 * 1024)));
    const layout = inspectZip(bytes);
    const media = layout.entries.find((entry) => entry.name === "media/original")!;
    const reads: Array<{ start: number; end: number }> = [];
    const file = new File([bytes], "large-media.omproj", { type: "application/zip" });
    const originalSlice = file.slice.bind(file);
    Object.defineProperty(file, "slice", {
      configurable: true,
      value(start = 0, end = file.size, contentType?: string) {
        reads.push({ start, end });
        return originalSlice(start, end, contentType);
      },
    });
    const scope = new TestWorkerScope();
    scope.autoAck = false;
    installBackupImportWorker(scope);
    scope.dispatch({ type: "start", requestId: "pass-one", file });

    await scope.waitFor((message) => (
      message.type === "entry-chunk" && message.name === "openmontage-project.json"
    ));

    expect(reads.some(({ start, end }) => (
      start < media.descriptorOffset && end > media.payloadOffset
    ))).toBe(false);
    scope.dispatch({ type: "cancel", requestId: "pass-one" });
  });

  it.each([
    ["central flags", (view: DataView, entry: ZipLayoutEntry) => view.setUint16(entry.centralOffset + 8, 0x0800, true)],
    ["central method", (view: DataView, entry: ZipLayoutEntry) => view.setUint16(entry.centralOffset + 10, 0, true)],
    ["central CRC", (view: DataView, entry: ZipLayoutEntry) => view.setUint32(entry.centralOffset + 16, 0x12345678, true)],
    ["central compressed size", (view: DataView, entry: ZipLayoutEntry) => view.setUint32(entry.centralOffset + 20, 1, true)],
    ["central local offset", (view: DataView, entry: ZipLayoutEntry) => view.setUint32(entry.centralOffset + 42, entry.localOffset + 1, true)],
    ["local flags", (view: DataView, entry: ZipLayoutEntry) => view.setUint16(entry.localOffset + 6, 0x0800, true)],
    ["local method", (view: DataView, entry: ZipLayoutEntry) => view.setUint16(entry.localOffset + 8, 0, true)],
    ["local CRC", (view: DataView, entry: ZipLayoutEntry) => view.setUint32(entry.localOffset + 14, 0x12345678, true)],
    ["local compressed size", (view: DataView, entry: ZipLayoutEntry) => view.setUint32(entry.localOffset + 18, 1, true)],
  ])("rejects mismatched %s before media callbacks", async (_label, patch) => {
    const file = backupFile(validEntries());
    const mutated = await mutateBackup(file, (view, layout) => {
      const entry = layout.entries.find((candidate) => candidate.name === "openmontage-project.json")!;
      patch(view, entry);
    });

    await expectStructuralFailureBeforeMedia(mutated);
  });

  it.each([
    ["flags", (view: DataView, entry: ZipLayoutEntry) => {
      view.setUint16(entry.centralOffset + 8, 0x0020, true);
      view.setUint16(entry.localOffset + 6, 0x0020, true);
    }],
    ["method", (view: DataView, entry: ZipLayoutEntry) => {
      view.setUint16(entry.centralOffset + 10, 99, true);
      view.setUint16(entry.localOffset + 8, 99, true);
    }],
  ])("rejects unsupported ZIP %s before media callbacks", async (_label, patch) => {
    const mutated = await mutateBackup(backupFile(validEntries()), (view, layout) => {
      patch(view, layout.entries[0]);
    });
    await expectStructuralFailureBeforeMedia(mutated);
  });

  it("rejects a local filename that differs from its central raw name", async () => {
    const mutated = await mutateBackup(backupFile(validEntries()), (_view, layout, bytes) => {
      const entry = layout.entries[0];
      bytes[entry.localOffset + 30] ^= 1;
    });
    await expectStructuralFailureBeforeMedia(mutated);
  });

  it("rejects encrypted stored entries before media callbacks", async () => {
    const file = new File([zipSync(validEntries(), { level: 0 })], "stored.omproj");
    const mutated = await mutateBackup(file, (view, layout) => {
      const entry = layout.entries.find((candidate) => candidate.name === "media/original")!;
      view.setUint16(entry.centralOffset + 8, view.getUint16(entry.centralOffset + 8, true) | 1, true);
      view.setUint16(entry.localOffset + 6, view.getUint16(entry.localOffset + 6, true) | 1, true);
    });

    await expectStructuralFailureBeforeMedia(mutated);
  });

  it.each([
    ["CRC", 0],
    ["compressed size", 4],
    ["uncompressed size", 8],
  ])("validates data descriptor %s at the exact central compressed-size boundary", async (_label, fieldOffset) => {
    const file = await streamingBackup(validEntries());
    const mutated = await mutateBackup(file, (view, layout) => {
      const entry = layout.entries.find((candidate) => candidate.name === "openmontage-project.json")!;
      const hasSignature = view.getUint32(entry.descriptorOffset, true) === 0x08074b50;
      view.setUint32(
        entry.descriptorOffset + (hasSignature ? 4 : 0) + fieldOffset,
        0x12345678,
        true,
      );
    });

    await expectStructuralFailureBeforeMedia(mutated);
  });

  it("rejects media whose actual streamed CRC32 differs from central metadata", async () => {
    const file = new File([zipSync(validEntries(), { level: 0 })], "crc.omproj");
    const mutated = await mutateBackup(file, (_view, layout, bytes) => {
      const media = layout.entries.find((entry) => entry.name === "media/original")!;
      bytes[media.payloadOffset] ^= 0xff;
    });
    const { terminal, responses } = await terminalResponse(mutated);

    expect(terminal).toMatchObject({ type: "failure", code: "validation" });
    expect((terminal as Extract<BackupWorkerResponse, { type: "failure" }>).message)
      .toMatch(/CRC32/i);
    expect(responses.some((message) => message.type === "complete")).toBe(false);
  });

  it.each([
    ["EOCD entry count", (view: DataView, layout: ZipLayout) => view.setUint16(layout.eocdOffset + 10, 0xffff, true)],
    ["EOCD central size", (view: DataView, layout: ZipLayout) => view.setUint32(layout.eocdOffset + 12, 0xffffffff, true)],
    ["EOCD central offset", (view: DataView, layout: ZipLayout) => view.setUint32(layout.eocdOffset + 16, 0xffffffff, true)],
    ["central compressed size", (view: DataView, layout: ZipLayout) => view.setUint32(layout.entries[0].centralOffset + 20, 0xffffffff, true)],
    ["central uncompressed size", (view: DataView, layout: ZipLayout) => view.setUint32(layout.entries[0].centralOffset + 24, 0xffffffff, true)],
    ["central disk start", (view: DataView, layout: ZipLayout) => view.setUint16(layout.entries[0].centralOffset + 34, 0xffff, true)],
    ["central local offset", (view: DataView, layout: ZipLayout) => view.setUint32(layout.entries[0].centralOffset + 42, 0xffffffff, true)],
  ])("rejects ZIP64 sentinel: %s", async (_label, patch) => {
    const mutated = await mutateBackup(backupFile(validEntries()), (view, layout) => patch(view, layout));
    await expectStructuralFailureBeforeMedia(mutated);
  });

  it("rejects ZIP64 extra fields", async () => {
    const zippable = Object.fromEntries(Object.entries(validEntries()).map(([name, bytes]) => [
      name,
      [bytes, { extra: { 1: new Uint8Array(16) } }],
    ])) as Zippable;
    await expectStructuralFailureBeforeMedia(
      new File([zipSync(zippable)], "zip64-extra.omproj"),
    );
  });

  it("uses two passes so manifests may follow media and transfers one acknowledged chunk at a time", async () => {
    const scope = new TestWorkerScope();
    scope.autoAck = false;
    installBackupImportWorker(scope);
    scope.dispatch({ type: "start", requestId: "request-a", file: backupFile(validEntries()) });

    const first = await scope.waitFor((message) => message.type === "entry-chunk");
    expect(first).toMatchObject({ requestId: "request-a", sequence: 0 });
    expect(scope.responses.filter((message) => message.type === "entry-chunk")).toHaveLength(1);
    expect(scope.transfers[scope.responses.indexOf(first)]).toEqual([
      (first as Extract<BackupWorkerResponse, { type: "entry-chunk" }>).chunk,
    ]);

    scope.dispatch({ type: "ack", requestId: "other-request", sequence: 0 });
    await Promise.resolve();
    expect(scope.responses.filter((message) => message.type === "entry-chunk")).toHaveLength(1);

    let observed = 0;
    while (true) {
      const response = await scope.waitFor((message) => (
        message.type === "complete" || message.type === "failure" ||
        (message.type === "entry-chunk" && message.sequence >= observed)
      ));
      if (response.type === "complete") break;
      if (response.type === "failure") throw new Error(response.message);
      if (response.type !== "entry-chunk") throw new Error("Unexpected worker response");
      expect(response.sequence).toBe(observed);
      observed += 1;
      scope.dispatch({ type: "ack", requestId: "request-a", sequence: response.sequence });
    }

    const starts = scope.responses
      .filter((message): message is Extract<BackupWorkerResponse, { type: "entry-start" }> =>
        message.type === "entry-start")
      .map((message) => message.name);
    expect(starts).toEqual([
      "openmontage-project.json",
      "openmontage-media.json",
      "media/original",
    ]);
    expect(scope.responses.some((message) => message.type === "progress")).toBe(true);
  });

  it.each([
    ["unsafe paths", { "../escape": strToU8("bad"), ...validEntries() }, /unsafe|malformed/i],
    ["safe undeclared extras", { ...validEntries(), "notes.txt": strToU8("bad") }, /undeclared/i],
    ["undeclared media", { ...validEntries(), "media/extra": strToU8("bad") }, /undeclared/i],
  ])("rejects %s before emitting retained media", async (_label, entries, expected) => {
    const scope = new TestWorkerScope();
    installBackupImportWorker(scope);
    scope.dispatch({ type: "start", requestId: "invalid", file: backupFile(entries) });

    const failure = await scope.waitFor((message) => message.type === "failure");

    expect(failure).toMatchObject({ type: "failure", requestId: "invalid", code: "validation" });
    expect((failure as Extract<BackupWorkerResponse, { type: "failure" }>).message).toMatch(expected);
    expect(scope.responses.some(
      (message) => message.type === "entry-start" && message.name.startsWith("media/"),
    )).toBe(false);
  });

  it("enforces actual manifest bytes for a highly compressed archive", async () => {
    const scope = new TestWorkerScope();
    installBackupImportWorker(scope);
    const oversized = snapshot();
    oversized.project.title = "x".repeat(8 * 1024 * 1024);
    scope.dispatch({
      type: "start",
      requestId: "high-compression",
      file: backupFile({
        "openmontage-project.json": strToU8(JSON.stringify({ version: 1, project: oversized })),
      }),
    });

    const failure = await scope.waitFor((message) => message.type === "failure");
    expect(failure).toMatchObject({ type: "failure", code: "validation" });
    expect((failure as Extract<BackupWorkerResponse, { type: "failure" }>).message)
      .toMatch(/manifest.*limit/i);
  }, 15_000);

  it("cancels only the matching request and never completes it", async () => {
    const scope = new TestWorkerScope();
    installBackupImportWorker(scope);
    const file = backupFile(validEntries(new Uint8Array(2 * 1024 * 1024)));
    scope.dispatch({ type: "start", requestId: "cancelled", file });
    scope.dispatch({ type: "cancel", requestId: "other" });
    scope.dispatch({ type: "cancel", requestId: "cancelled" });

    await Promise.resolve();
    await Promise.resolve();
    expect(scope.responses.some(
      (message) => message.requestId === "cancelled" && message.type === "complete",
    )).toBe(false);
  });

  it("reports a protocol failure for an out-of-order ACK on the matching request", async () => {
    const scope = new TestWorkerScope();
    scope.autoAck = false;
    installBackupImportWorker(scope);
    scope.dispatch({ type: "start", requestId: "bad-ack", file: backupFile(validEntries()) });
    const chunk = await scope.waitFor(
      (message): message is Extract<BackupWorkerResponse, { type: "entry-chunk" }> =>
        message.type === "entry-chunk",
    );
    if (chunk.type !== "entry-chunk") throw new Error("Expected an entry chunk");

    scope.dispatch({ type: "ack", requestId: "bad-ack", sequence: chunk.sequence + 1 });

    await expect(scope.waitFor((message) => message.type === "failure"))
      .resolves.toMatchObject({ type: "failure", requestId: "bad-ack", code: "protocol" });
  });

  it("rejects a malformed ACK for the matching request without releasing its chunk", async () => {
    const scope = new TestWorkerScope();
    scope.autoAck = false;
    installBackupImportWorker(scope);
    scope.dispatch({ type: "start", requestId: "malformed-ack", file: backupFile(validEntries()) });
    const chunk = await scope.waitFor((message) => message.type === "entry-chunk");
    if (chunk.type !== "entry-chunk") throw new Error("Expected chunk");

    scope.dispatch({
      type: "ack",
      requestId: "malformed-ack",
      sequence: chunk.sequence,
      extra: true,
    } as unknown as BackupWorkerRequest);

    await vi.waitFor(() => {
      expect(scope.responses).toContainEqual(expect.objectContaining({
        type: "failure",
        requestId: "malformed-ack",
        code: "protocol",
      }));
    });
    expect(scope.responses.filter((message) => message.type === "entry-chunk")).toHaveLength(1);
  });
});
