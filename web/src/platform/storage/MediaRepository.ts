import {
  cacheRemoteMedia,
  findCommittedMedia,
  loadMediaBlob,
  loadMediaRecord,
  startMediaRecoveryController,
  type MediaRecoveryController,
} from "../../localdb/mediaStore";
import { deleteProject as deleteLocalProject } from "../../localdb/projectStore";
import { getStorageEstimate } from "../../localdb/storageEstimate";
import { mediaUrl } from "../../api/client";
import type {
  LocalMediaRecord,
  LocalMediaRef,
  StorageEstimate,
} from "../../localdb/types";

export interface MediaRepository {
  cacheRemote(
    url: string,
    metadata: { projectId: string; projectIncarnation?: string; sourcePath: string },
  ): Promise<LocalMediaRef | null>;
  findCommitted(
    projectId: string,
    sourcePath: string,
    projectIncarnation?: string,
  ): Promise<LocalMediaRecord | null>;
  load(ref: LocalMediaRef): Promise<Blob | null>;
  resolve(ref: LocalMediaRef): Promise<string | null>;
  remoteUrl(path: string | null | undefined, projectId?: string | null): string | null;
  startRecovery(): MediaRecoveryController;
  revokeProject(projectId: string): void;
  revokeAll(): void;
  deleteProject(projectId: string): Promise<void>;
  estimate(): Promise<StorageEstimate>;
}

interface ResolvedMediaUrl {
  projectId: string | null;
  url: string | null;
}

interface FailedResolution {
  error: unknown;
  failureCount: number;
  retryAt: number;
}

interface MediaRepositoryOptions {
  cacheRemoteMedia?: typeof cacheRemoteMedia;
  findCommittedMedia?: typeof findCommittedMedia;
  loadMediaBlob?: typeof loadMediaBlob;
  loadMediaRecord?: typeof loadMediaRecord;
  startMediaRecoveryController?: typeof startMediaRecoveryController;
  deleteProject?: typeof deleteLocalProject;
  getStorageEstimate?: typeof getStorageEstimate;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  now?: () => number;
}

const ERROR_RETRY_BASE_MS = 1_000;
const ERROR_RETRY_MAX_MS = 30_000;

export class LocalMediaRepository implements MediaRepository {
  private readonly cacheRemoteMedia: typeof cacheRemoteMedia;
  private readonly findCommittedMedia: typeof findCommittedMedia;
  private readonly loadMediaBlob: typeof loadMediaBlob;
  private readonly loadMediaRecord: typeof loadMediaRecord;
  private readonly startMediaRecoveryController: typeof startMediaRecoveryController;
  private readonly deleteLocalProject: typeof deleteLocalProject;
  private readonly getStorageEstimate: typeof getStorageEstimate;
  private readonly createObjectURL: (blob: Blob) => string;
  private readonly revokeObjectURL: (url: string) => void;
  private readonly now: () => number;
  private readonly resolvedUrls = new Map<LocalMediaRef, ResolvedMediaUrl>();
  private readonly inFlightResolutions = new Map<LocalMediaRef, Promise<string | null>>();
  private readonly failedResolutions = new Map<LocalMediaRef, FailedResolution>();
  private cacheGeneration = 0;

  constructor(options: MediaRepositoryOptions = {}) {
    this.cacheRemoteMedia = options.cacheRemoteMedia ?? cacheRemoteMedia;
    this.findCommittedMedia = options.findCommittedMedia ?? findCommittedMedia;
    this.loadMediaBlob = options.loadMediaBlob ?? loadMediaBlob;
    this.loadMediaRecord = options.loadMediaRecord ?? loadMediaRecord;
    this.startMediaRecoveryController = options.startMediaRecoveryController
      ?? startMediaRecoveryController;
    this.deleteLocalProject = options.deleteProject ?? deleteLocalProject;
    this.getStorageEstimate = options.getStorageEstimate ?? getStorageEstimate;
    this.createObjectURL = options.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectURL = options.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));
    this.now = options.now ?? (() => Date.now());
  }

  cacheRemote(
    url: string,
    metadata: { projectId: string; projectIncarnation?: string; sourcePath: string },
  ): Promise<LocalMediaRef | null> {
    return this.cacheRemoteMedia(url, metadata);
  }

  findCommitted(
    projectId: string,
    sourcePath: string,
    projectIncarnation?: string,
  ): Promise<LocalMediaRecord | null> {
    return this.findCommittedMedia(projectId, sourcePath, projectIncarnation);
  }

  load(ref: LocalMediaRef): Promise<Blob | null> {
    return this.loadMediaBlob(ref);
  }

  remoteUrl(path: string | null | undefined, projectId?: string | null): string | null {
    return mediaUrl(path, projectId);
  }

  startRecovery(): MediaRecoveryController {
    return this.startMediaRecoveryController();
  }

  async resolve(ref: LocalMediaRef): Promise<string | null> {
    if (this.resolvedUrls.has(ref)) {
      return this.resolvedUrls.get(ref)?.url ?? null;
    }
    const previousFailure = this.failedResolutions.get(ref);
    if (previousFailure && this.now() < previousFailure.retryAt) {
      return Promise.reject(previousFailure.error);
    }
    const inFlight = this.inFlightResolutions.get(ref);
    if (inFlight) return inFlight;

    const generation = this.cacheGeneration;
    const resolution = this.resolveUncached(ref, generation, previousFailure);
    this.inFlightResolutions.set(ref, resolution);
    const removeInFlight = () => {
      if (this.inFlightResolutions.get(ref) === resolution) {
        this.inFlightResolutions.delete(ref);
      }
    };
    void resolution.then(removeInFlight, removeInFlight);
    return resolution;
  }

  revokeProject(projectId: string): void {
    for (const [ref, resolved] of this.resolvedUrls) {
      if (resolved.projectId !== projectId) continue;
      if (resolved.url) this.revokeObjectURL(resolved.url);
      this.resolvedUrls.delete(ref);
      this.failedResolutions.delete(ref);
      this.inFlightResolutions.delete(ref);
    }
  }

  revokeAll(): void {
    this.cacheGeneration += 1;
    for (const resolved of this.resolvedUrls.values()) {
      if (resolved.url) this.revokeObjectURL(resolved.url);
    }
    this.resolvedUrls.clear();
    this.inFlightResolutions.clear();
    this.failedResolutions.clear();
  }

  async deleteProject(projectId: string): Promise<void> {
    this.revokeProject(projectId);
    await this.deleteLocalProject(projectId);
  }

  estimate(): Promise<StorageEstimate> {
    return this.getStorageEstimate();
  }

  private async resolveUncached(
    ref: LocalMediaRef,
    generation: number,
    previousFailure: FailedResolution | undefined,
  ): Promise<string | null> {
    let record: LocalMediaRecord | null;
    let blob: Blob | null;
    try {
      [record, blob] = await Promise.all([
        this.loadMediaRecord(ref),
        this.loadMediaBlob(ref),
      ]);
    } catch (error) {
      if (generation === this.cacheGeneration) {
        const failureCount = Math.min((previousFailure?.failureCount ?? 0) + 1, 6);
        const retryDelay = Math.min(
          ERROR_RETRY_BASE_MS * 2 ** (failureCount - 1),
          ERROR_RETRY_MAX_MS,
        );
        this.failedResolutions.set(ref, {
          error,
          failureCount,
          retryAt: this.now() + retryDelay,
        });
      }
      throw error;
    }
    if (generation !== this.cacheGeneration) return null;
    this.failedResolutions.delete(ref);
    if (!blob) {
      this.resolvedUrls.set(ref, { projectId: record?.projectId ?? null, url: null });
      return null;
    }

    const url = this.createObjectURL(blob);
    this.resolvedUrls.set(ref, { projectId: record?.projectId ?? null, url });
    return url;
  }
}

export const mediaRepository = new LocalMediaRepository();
