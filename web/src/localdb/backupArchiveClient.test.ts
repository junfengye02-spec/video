import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShortDramaProjectResponse } from "../domain/types";
import {
  BackupWorkerProtocolError,
  BackupWorkerUnavailableError,
  readBackupArchive,
  type BackupWorkerRequest,
  type BackupWorkerResponse,
} from "./backupArchiveClient";
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

type WorkerListener = ((event: MessageEvent) => void) | null;

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  static constructionError: unknown;
  static postMessageFailure: ((message: BackupWorkerRequest) => unknown) | null = null;

  onmessage: WorkerListener = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: WorkerListener = null;
  readonly requests: BackupWorkerRequest[] = [];
  readonly url: URL;
  readonly options: WorkerOptions | undefined;
  terminated = false;

  constructor(url: URL, options?: WorkerOptions) {
    if (ControlledWorker.constructionError) throw ControlledWorker.constructionError;
    this.url = url;
    this.options = options;
    ControlledWorker.instances.push(this);
  }

  postMessage(message: BackupWorkerRequest): void {
    const failure = ControlledWorker.postMessageFailure?.(message);
    if (failure) throw failure;
    this.requests.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: BackupWorkerResponse | unknown): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }

  fail(message = "worker died"): void {
    this.onerror?.(new ErrorEvent("error", { message }));
  }
}

function installControlledWorker(): void {
  ControlledWorker.instances = [];
  ControlledWorker.constructionError = undefined;
  ControlledWorker.postMessageFailure = null;
  vi.stubGlobal("Worker", ControlledWorker);
}

function worker(): ControlledWorker {
  const instance = ControlledWorker.instances[0];
  if (!instance) throw new Error("Worker was not constructed");
  return instance;
}

function requestId(): string {
  const start = worker().requests[0];
  if (!start || start.type !== "start") throw new Error("Worker was not started");
  return start.requestId;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function completeSingleManifest(finalProgress?: { compressedBytes: number; entries: number }) {
  installControlledWorker();
  const file = new File(["zip"], "project.omproj");
  const reading = readBackupArchive(file, {});
  const id = requestId();
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, project: snapshot() }));
  if (finalProgress) {
    worker().emit({ type: "progress", requestId: id, ...finalProgress });
  }
  worker().emit({
    type: "entry-start",
    requestId: id,
    name: "openmontage-project.json",
    contentLength: bytes.byteLength,
  });
  worker().emit({
    type: "entry-chunk",
    requestId: id,
    name: "openmontage-project.json",
    sequence: 0,
    chunk: bytes.slice().buffer,
  });
  await vi.waitFor(() => expect(worker().requests.some((message) => message.type === "ack")).toBe(true));
  worker().emit({
    type: "entry-end",
    requestId: id,
    name: "openmontage-project.json",
    actualBytes: bytes.byteLength,
  });
  worker().emit({ type: "complete", requestId: id });
  return reading;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readBackupArchive", () => {
  it("constructs the exact same-origin module Worker and structured-clones the File", async () => {
    installControlledWorker();
    const file = new File(["zip"], "project.omproj");
    const reading = readBackupArchive(file, {});

    expect(worker().url).toBeInstanceOf(URL);
    expect(worker().url.pathname).toMatch(/\/src\/localdb\/backupImport\.worker\.ts$/);
    expect(worker().options).toEqual({ type: "module" });
    expect(worker().requests[0]).toMatchObject({ type: "start", file });

    worker().emit({ type: "failure", requestId: requestId(), code: "validation", message: "bad" });
    await expect(reading).rejects.toThrow("bad");
  });

  it("waits for the consumer chunk callback before acknowledging the exact sequence", async () => {
    installControlledWorker();
    let releaseChunk!: () => void;
    const chunkGate = new Promise<void>((resolve) => { releaseChunk = resolve; });
    const file = new File(["zip"], "project.omproj");
    const reading = readBackupArchive(file, {
      onEntryChunk: () => chunkGate,
    });
    const id = requestId();
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, project: snapshot() }));
    const buffer = bytes.slice().buffer;

    worker().emit({
      type: "progress",
      requestId: id,
      compressedBytes: file.size,
      entries: 1,
    });

    worker().emit({
      type: "entry-start",
      requestId: id,
      name: "openmontage-project.json",
      contentLength: bytes.byteLength,
    });
    worker().emit({
      type: "entry-chunk",
      requestId: id,
      name: "openmontage-project.json",
      sequence: 0,
      chunk: buffer,
    });
    await flush();
    expect(worker().requests).toHaveLength(1);

    releaseChunk();
    await vi.waitFor(() => {
      expect(worker().requests[1]).toEqual({ type: "ack", requestId: id, sequence: 0 });
    });

    worker().emit({
      type: "entry-end",
      requestId: id,
      name: "openmontage-project.json",
      actualBytes: bytes.byteLength,
    });
    worker().emit({ type: "complete", requestId: id });
    await expect(reading).resolves.toMatchObject({ project: { project: { id: "project-1" } } });
  });

  it.each([
    { label: "non-object", message: null },
    { label: "wrong request", message: { type: "progress", requestId: "other", compressedBytes: 0, entries: 0 } },
    { label: "chunk before entry", message: { type: "entry-chunk", requestId: "REQUEST", name: "media/a", sequence: 0, chunk: new ArrayBuffer(1) } },
    { label: "out-of-order sequence", message: { type: "entry-chunk", requestId: "REQUEST", name: "media/a", sequence: 3, chunk: new ArrayBuffer(1) } },
  ])("rejects malformed protocol messages: $label", async ({ message }) => {
    installControlledWorker();
    const reading = readBackupArchive(new File(["zip"], "project.omproj"), {});
    const id = requestId();
    const actual = message && typeof message === "object"
      ? { ...message, requestId: message.requestId === "REQUEST" ? id : message.requestId }
      : message;

    worker().emit(actual);

    await expect(reading).rejects.toBeInstanceOf(BackupWorkerProtocolError);
    expect(worker().terminated).toBe(true);
  });

  it("classifies synchronous construction and pre-start CSP failures as unavailable", async () => {
    installControlledWorker();
    ControlledWorker.constructionError = new DOMException("blocked", "SecurityError");
    await expect(readBackupArchive(new File([], "project.omproj"), {}))
      .rejects.toBeInstanceOf(BackupWorkerUnavailableError);

    installControlledWorker();
    const reading = readBackupArchive(new File([], "project.omproj"), {});
    worker().fail("Refused by Content Security Policy");
    await expect(reading).rejects.toBeInstanceOf(BackupWorkerUnavailableError);
  });

  it("classifies post-start idle timeout and unexpected death as protocol failures", async () => {
    vi.useFakeTimers();
    installControlledWorker();
    const timedOut = readBackupArchive(new File([], "project.omproj"), {});
    const timedOutExpectation = expect(timedOut).rejects.toBeInstanceOf(BackupWorkerProtocolError);
    worker().emit({ type: "progress", requestId: requestId(), compressedBytes: 0, entries: 0 });
    await flush();
    await vi.advanceTimersByTimeAsync(15_001);
    await timedOutExpectation;

    installControlledWorker();
    const died = readBackupArchive(new File([], "project.omproj"), {});
    worker().emit({ type: "progress", requestId: requestId(), compressedBytes: 0, entries: 0 });
    await flush();
    worker().fail();
    await expect(died).rejects.toBeInstanceOf(BackupWorkerProtocolError);
  });

  it("terminates on abort and rejects with AbortError without fallback", async () => {
    installControlledWorker();
    const abort = new AbortController();
    const reading = readBackupArchive(new File([], "project.omproj"), {}, abort.signal);
    const id = requestId();

    abort.abort();

    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(worker().requests).toContainEqual({ type: "cancel", requestId: id });
    expect(worker().terminated).toBe(true);
  });

  it("does not count time spent awaiting a consumer callback as Worker idle time", async () => {
    vi.useFakeTimers();
    installControlledWorker();
    let releaseChunk!: () => void;
    const chunkGate = new Promise<void>((resolve) => { releaseChunk = resolve; });
    const reading = readBackupArchive(new File(["zip"], "project.omproj"), {
      onEntryChunk: () => chunkGate,
    });
    const id = requestId();
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, project: snapshot() }));
    worker().emit({
      type: "entry-start",
      requestId: id,
      name: "openmontage-project.json",
      contentLength: bytes.byteLength,
    });
    worker().emit({
      type: "entry-chunk",
      requestId: id,
      name: "openmontage-project.json",
      sequence: 0,
      chunk: bytes.slice().buffer,
    });
    await flush();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(worker().terminated).toBe(false);
    expect(worker().requests).toHaveLength(1);

    releaseChunk();
    await flush();
    worker().emit({ type: "failure", requestId: id, code: "validation", message: "stop" });
    await expect(reading).rejects.toThrow("stop");
  });

  it.each(["entry-chunk", "entry-end", "complete"] as const)(
    "rejects a second %s synchronously while a chunk callback is outstanding",
    async (violation) => {
      installControlledWorker();
      let releaseChunk!: () => void;
      const gate = new Promise<void>((resolve) => { releaseChunk = resolve; });
      const callback = vi.fn(() => gate);
      const file = new File(["zip"], "project.omproj");
      const reading = readBackupArchive(file, { onEntryChunk: callback });
      const outcome = reading.then(() => null, (error: unknown) => error);
      const id = requestId();
      const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, project: snapshot() }));
      worker().emit({ type: "progress", requestId: id, compressedBytes: file.size, entries: 1 });
      worker().emit({
        type: "entry-start",
        requestId: id,
        name: "openmontage-project.json",
        contentLength: bytes.byteLength,
      });
      worker().emit({
        type: "entry-chunk",
        requestId: id,
        name: "openmontage-project.json",
        sequence: 0,
        chunk: bytes.slice().buffer,
      });
      await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));

      if (violation === "entry-chunk") {
        worker().emit({
          type: "entry-chunk",
          requestId: id,
          name: "openmontage-project.json",
          sequence: 1,
          chunk: new ArrayBuffer(1),
        });
      } else if (violation === "entry-end") {
        worker().emit({
          type: "entry-end",
          requestId: id,
          name: "openmontage-project.json",
          actualBytes: bytes.byteLength,
        });
      } else {
        worker().emit({ type: "complete", requestId: id });
      }
      const terminatedImmediately = worker().terminated;
      releaseChunk();
      worker().emit({ type: "complete", requestId: id });
      const error = await outcome;

      expect(terminatedImmediately).toBe(true);
      expect(error).toBeInstanceOf(BackupWorkerProtocolError);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(worker().requests.filter((message) => message.type === "ack")).toHaveLength(0);
    },
  );

  it("bounds the synchronous response queue and rejects a progress flood", async () => {
    installControlledWorker();
    let releaseProgress!: () => void;
    const gate = new Promise<void>((resolve) => { releaseProgress = resolve; });
    const reading = readBackupArchive(new File([new Uint8Array(32)], "project.omproj"), {
      onProgress: () => gate,
    });
    const outcome = reading.then(() => null, (error: unknown) => error);
    const id = requestId();
    worker().emit({ type: "progress", requestId: id, compressedBytes: 0, entries: 0 });
    await flush();
    for (let index = 0; index < 17; index += 1) {
      worker().emit({ type: "progress", requestId: id, compressedBytes: 0, entries: 0 });
    }
    const terminatedImmediately = worker().terminated;
    releaseProgress();
    worker().emit({ type: "complete", requestId: id });

    expect(terminatedImmediately).toBe(true);
    expect(await outcome).toBeInstanceOf(BackupWorkerProtocolError);
  });

  it("keeps the chunk outstanding when posting its exact ACK throws", async () => {
    installControlledWorker();
    const failure = new DOMException("clone failed", "DataCloneError");
    ControlledWorker.postMessageFailure = (message) => message.type === "ack" ? failure : null;
    const file = new File(["zip"], "project.omproj");
    const reading = readBackupArchive(file, {});
    const id = requestId();
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, project: snapshot() }));
    worker().emit({ type: "progress", requestId: id, compressedBytes: file.size, entries: 1 });
    worker().emit({
      type: "entry-start",
      requestId: id,
      name: "openmontage-project.json",
      contentLength: bytes.byteLength,
    });
    worker().emit({
      type: "entry-chunk",
      requestId: id,
      name: "openmontage-project.json",
      sequence: 0,
      chunk: bytes.slice().buffer,
    });

    await expect(reading).rejects.toBeInstanceOf(BackupWorkerProtocolError);
    expect(worker().requests.filter((message) => message.type === "ack")).toHaveLength(0);
    expect(worker().terminated).toBe(true);
  });

  it.each([
    ["missing final progress", undefined],
    ["short final progress", { compressedBytes: 2, entries: 1 }],
    ["wrong final entry count", { compressedBytes: 3, entries: 2 }],
  ])("rejects complete with %s", async (_label, progress) => {
    await expect(completeSingleManifest(progress)).rejects.toBeInstanceOf(BackupWorkerProtocolError);
  });
});
