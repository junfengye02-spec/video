import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
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

function validEntries(mediaBytes = strToU8("media")): Record<string, Uint8Array> {
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

describe("backup import module Worker", () => {
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
});
