import { vi } from "vitest";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function bytesFromChunk(chunk: FileSystemWriteChunkType): Promise<Uint8Array> {
  if (chunk instanceof Blob) {
    const buffer = typeof chunk.arrayBuffer === "function"
      ? await chunk.arrayBuffer()
      : await new Response(chunk).arrayBuffer();
    return new Uint8Array(buffer);
  }
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error("Test OPFS only accepts byte or Blob writes");
}

export interface TestStorageOptions {
  failGetDirectory?: Error;
  failCreateFile?: Error;
  failWriteAt?: number;
  writeError?: Error;
  failClose?: Error;
  failRemove?: Error;
  pauseClose?: boolean;
  pauseRemove?: boolean;
  pauseGetDirectory?: boolean;
  verifiedSizeDelta?: number;
}

export interface TestStorageController {
  readonly files: Map<string, Uint8Array>;
  readonly getDirectory: ReturnType<typeof vi.fn>;
  readonly removeEntry: ReturnType<typeof vi.fn>;
  readonly closeStarted: Promise<void>;
  readonly removeStarted: Promise<void>;
  readonly directoryStarted: Promise<void>;
  releaseClose(): void;
  releaseRemove(): void;
  releaseDirectory(): void;
  seedFile(name: string, bytes: Uint8Array, lastModified: number): void;
  restore(): void;
}

export function installTestStorage(
  options: TestStorageOptions = {},
): TestStorageController {
  const originalStorage = Object.getOwnPropertyDescriptor(Navigator.prototype, "storage");
  const files = new Map<string, Uint8Array>();
  const modifiedAt = new Map<string, number>();
  const closeGate = deferred<void>();
  const removeGate = deferred<void>();
  const closeStarted = deferred<void>();
  const removeStarted = deferred<void>();
  const directoryStarted = deferred<void>();
  const directoryGate = deferred<void>();
  let writeCalls = 0;

  const removeEntry = vi.fn(async (name: string) => {
    removeStarted.resolve();
    if (options.pauseRemove) await removeGate.promise;
    if (options.failRemove) throw options.failRemove;
    if (!files.delete(name)) throw new DOMException("File not found", "NotFoundError");
    modifiedAt.delete(name);
  });

  const mediaDirectory = {
    async getFileHandle(name: string, handleOptions?: { create?: boolean }) {
      if (options.failCreateFile) throw options.failCreateFile;
      if (!files.has(name) && !handleOptions?.create) {
        throw new DOMException("File not found", "NotFoundError");
      }
      if (!files.has(name)) {
        files.set(name, new Uint8Array());
        modifiedAt.set(name, Date.now());
      }
      return {
        async createWritable() {
          files.set(name, new Uint8Array());
          return {
            async write(chunk: FileSystemWriteChunkType) {
              writeCalls += 1;
              if (options.failWriteAt === writeCalls) {
                throw options.writeError ?? new Error("OPFS write failed");
              }
              const next = await bytesFromChunk(chunk);
              const current = files.get(name) ?? new Uint8Array();
              const combined = new Uint8Array(current.byteLength + next.byteLength);
              combined.set(current);
              combined.set(next, current.byteLength);
              files.set(name, combined);
              modifiedAt.set(name, Date.now());
            },
            async close() {
              closeStarted.resolve();
              if (options.pauseClose) await closeGate.promise;
              if (options.failClose) throw options.failClose;
            },
          };
        },
        async getFile() {
          const bytes = files.get(name);
          if (!bytes) throw new DOMException("File not found", "NotFoundError");
          const delta = options.verifiedSizeDelta ?? 0;
          const verified = delta === 0
            ? bytes
            : new Uint8Array(Math.max(0, bytes.byteLength + delta));
          const file = new Blob([verified.slice().buffer]) as Blob & { lastModified: number };
          Object.defineProperty(file, "lastModified", {
            value: modifiedAt.get(name) ?? Date.now(),
          });
          return file;
        },
      };
    },
    removeEntry,
    async *entries() {
      for (const name of [...files.keys()]) {
        yield [name, { kind: "file", name }];
      }
    },
  };

  const getDirectory = vi.fn(async () => {
    directoryStarted.resolve();
    if (options.pauseGetDirectory) await directoryGate.promise;
    if (options.failGetDirectory) throw options.failGetDirectory;
    return {
      async getDirectoryHandle() {
        return mediaDirectory;
      },
    };
  });

  Object.defineProperty(Navigator.prototype, "storage", {
    configurable: true,
    value: { getDirectory },
  });

  return {
    files,
    getDirectory,
    removeEntry,
    closeStarted: closeStarted.promise,
    removeStarted: removeStarted.promise,
    directoryStarted: directoryStarted.promise,
    releaseClose: () => closeGate.resolve(),
    releaseRemove: () => removeGate.resolve(),
    releaseDirectory: () => directoryGate.resolve(),
    seedFile(name, bytes, lastModified) {
      files.set(name, bytes);
      modifiedAt.set(name, lastModified);
    },
    restore() {
      if (originalStorage) {
        Object.defineProperty(Navigator.prototype, "storage", originalStorage);
      } else {
        delete (Navigator.prototype as { storage?: StorageManager }).storage;
      }
    },
  };
}
