import { ImagePlus, RefreshCw, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import type {
  AssetRecord,
  ProjectGenerationPreferences,
  ReferenceImageUploadRequest,
  ReferenceImageUploadResponse,
  Shot,
  ShotFrameSource,
} from "../../../domain/types";
import type { UIStrings } from "../../../i18n";
import { Button, IconButton, SelectMenu } from "../../../shared/ui";
import type { ShotDraftFields } from "../model/shotDraft";
import { ShotFrameGeneration, type FrameTarget } from "./ShotFrameGeneration";
import styles from "./ShotInspector.module.css";

interface ShotKeyframesProps {
  assets: AssetRecord[];
  busy: boolean;
  draft: ShotDraftFields;
  generationPreferences?: ProjectGenerationPreferences;
  projectAspectRatio?: string | null;
  projectId: string;
  shot: Shot | null;
  strings: UIStrings["shotEditor"];
  onGenerate?: Parameters<typeof ShotFrameGeneration>[0]["onGenerate"];
  onListTasks?: Parameters<typeof ShotFrameGeneration>[0]["onListTasks"];
  onRetryTaskItem?: Parameters<typeof ShotFrameGeneration>[0]["onRetryTaskItem"];
  onSessionExpired?: () => void;
  onUpload?: (
    payload: ReferenceImageUploadRequest,
  ) => Promise<ReferenceImageUploadResponse>;
  updateDraft: (update: (draft: ShotDraftFields) => ShotDraftFields) => void;
  walletAvailableUnits?: number | null;
  taskEvents?: Parameters<typeof ShotFrameGeneration>[0]["taskEvents"];
}

function previewUrl(asset: AssetRecord | undefined): string | null {
  return asset?.reference_images.find(Boolean)
    ?? asset?.media_url
    ?? asset?.media_urls?.find(Boolean)
    ?? null;
}

function sourceFor(asset: AssetRecord | undefined): ShotFrameSource {
  if (asset?.source_type === "ai_generated") return "ai_generated";
  if (asset?.source_type === "video_frame") return "video_extract";
  return "user";
}

export function ShotKeyframes({
  assets,
  busy,
  draft,
  generationPreferences,
  projectId,
  projectAspectRatio = null,
  shot,
  strings,
  onGenerate,
  onListTasks,
  onRetryTaskItem,
  onSessionExpired,
  onUpload,
  updateDraft,
  walletAvailableUnits = null,
  taskEvents,
}: ShotKeyframesProps) {
  const [error, setError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [uploadedPreview, setUploadedPreview] = useState<{
    assetId: string;
    url: string;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [generationPending, setGenerationPending] = useState(false);
  const [generatedPreviews, setGeneratedPreviews] = useState<Partial<Record<FrameTarget, {
    assetId: string;
    url: string;
  }>>>({});
  const requestRevision = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const explicitId = draft.continuity.explicit_user_first_frame_asset_id;
  const inheritedId = draft.continuity.inherited_first_frame_asset_id;
  const effectiveFirstId = explicitId ?? inheritedId;
  const firstAsset = assets.find((asset) => asset.id === effectiveFirstId);
  const tailAsset = assets.find(
    (asset) => asset.id === draft.continuity.last_frame_asset_id,
  );
  const firstUrl = generatedPreviews.first?.assetId === effectiveFirstId
    ? generatedPreviews.first.url
    : uploadedPreview?.assetId === effectiveFirstId
    ? uploadedPreview.url
    : previewUrl(firstAsset);
  const tailUrl = generatedPreviews.last?.assetId === draft.continuity.last_frame_asset_id
    ? generatedPreviews.last.url
    : previewUrl(tailAsset);
  const selectableAssets = useMemo(
    () => assets.filter((asset) => asset.status !== "stale" && previewUrl(asset)),
    [assets],
  );
  useEffect(() => {
    requestRevision.current += 1;
    setError(null);
    setPendingFile(null);
    setUploadedPreview(null);
    setUploading(false);
    setGenerationPending(false);
    setGeneratedPreviews({});
  }, [projectId, shot?.id]);

  const setExplicitAsset = (assetId: string | null, asset?: AssetRecord) => {
    updateDraft((current) => ({
      ...current,
      continuity: {
        ...current.continuity,
        explicit_user_first_frame_asset_id: assetId,
        first_frame: assetId
          ? {
              asset_id: assetId,
              version: 1,
              status: "ready",
              source: sourceFor(asset),
            }
          : null,
      },
    }));
  };

  const setLastFrameAsset = (assetId: string | null, asset?: AssetRecord) => {
    updateDraft((current) => ({
      ...current,
      continuity: {
        ...current.continuity,
        last_frame_asset_id: assetId,
        last_frame: assetId
          ? {
              asset_id: assetId,
              version: 1,
              status: "ready",
              source: sourceFor(asset),
            }
          : null,
      },
    }));
  };

  const handleGenerated = (target: FrameTarget, asset: AssetRecord, mediaUrl: string) => {
    setGeneratedPreviews((current) => ({
      ...current,
      [target]: { assetId: asset.id, url: mediaUrl },
    }));
    if (target === "first") setExplicitAsset(asset.id, asset);
    else setLastFrameAsset(asset.id, asset);
  };

  const upload = async (file: File) => {
    if (!onUpload || !shot || uploading || generationPending || busy) return;
    const revision = ++requestRevision.current;
    const capturedProjectId = projectId;
    const capturedShotId = shot.id;
    setUploading(true);
    setError(null);
    setPendingFile(file);
    try {
      const result = await onUpload({
        kind: "scene",
        label: `${shot.id} first frame`,
        description: "Explicit user first frame",
        prompt: "",
        file,
      });
      if (
        requestRevision.current !== revision
        || projectId !== capturedProjectId
        || shot.id !== capturedShotId
      ) return;
      setUploadedPreview({
        assetId: result.library_asset.id,
        url: result.media.media_url,
      });
      setExplicitAsset(result.library_asset.id, {
        ...result.asset,
        ...result.library_asset,
        reference_images: [result.media.media_url],
      });
      setPendingFile(null);
      fileInputRef.current?.focus();
    } catch {
      if (requestRevision.current === revision) {
        setError(strings.firstFrameUploadFailed);
      }
    } finally {
      if (requestRevision.current === revision) setUploading(false);
    }
  };

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void upload(file);
  };

  const firstSource = explicitId
    ? draft.continuity.first_frame?.source === "ai_generated"
      ? strings.firstFrameSourceAi
      : strings.firstFrameSourceUser
    : inheritedId
      ? strings.firstFrameSourceInherited
      : strings.noFirstFrame;
  const tailSource = draft.continuity.last_frame?.source === "ai_generated"
    ? strings.firstFrameSourceAi
    : strings.tailFrameSourceExtracted;

  return (
    <section className={styles.section} aria-labelledby="shot-keyframes-title">
      <div className={styles.sectionHeading}>
        <h3 id="shot-keyframes-title">{strings.keyframesSectionTitle}</h3>
        <span>{draft.continuity.stale ? strings.frameStaleStatus : strings.frameReadyStatus}</span>
      </div>

      <div className={styles.continuityControls}>
        <SelectMenu
            label={strings.continuityModeLabel}
            value={draft.continuity.mode}
            disabled={!shot || busy || uploading || generationPending}
            onValueChange={(value) => updateDraft((current) => ({
              ...current,
              continuity: {
                ...current.continuity,
                mode: value as typeof current.continuity.mode,
              },
            }))}
            options={[{ value: "cut", label: strings.continuityModes.cut }, { value: "carry", label: strings.continuityModes.carry }, { value: "match_cut", label: strings.continuityModes.match_cut }]}
          />
        <label className={styles.inheritToggle}>
          <input
            type="checkbox"
            checked={draft.continuity.inherit_previous_tail}
            disabled={!shot || busy || uploading || generationPending || draft.continuity.mode !== "carry"}
            onChange={(event) => updateDraft((current) => ({
              ...current,
              continuity: {
                ...current.continuity,
                inherit_previous_tail: event.target.checked,
              },
            }))}
          />
          <span>{strings.inheritPreviousTailLabel}</span>
        </label>
      </div>

      <div className={styles.keyframeGrid}>
        <article className={styles.keyframeItem}>
          <div className={styles.keyframeHeading}>
            <span>{strings.firstFrameLabel}</span>
            {explicitId ? (
              <IconButton
                icon={<X size={15} />}
                label={strings.removeFirstFrameAction}
                disabled={busy || uploading || generationPending}
                onClick={() => setExplicitAsset(null)}
              />
            ) : null}
          </div>
          <div className={styles.keyframePreview} data-empty={firstUrl ? "false" : "true"}>
            {firstUrl ? <img src={firstUrl} alt={strings.firstFrameLabel} /> : <ImagePlus aria-hidden="true" size={21} />}
          </div>
          <span className={styles.frameSource}>{firstSource}</span>
        </article>

        <article className={styles.keyframeItem}>
          <div className={styles.keyframeHeading}>
            <span>{strings.tailFrameLabel}</span>
            {draft.continuity.last_frame_asset_id ? (
              <IconButton
                icon={<X size={15} />}
                label={strings.removeTailFrameAction}
                disabled={busy || uploading || generationPending}
                onClick={() => {
                  setGeneratedPreviews((current) => ({ ...current, last: undefined }));
                  setLastFrameAsset(null);
                }}
              />
            ) : null}
          </div>
          <div className={styles.keyframePreview} data-empty={tailUrl ? "false" : "true"}>
            {tailUrl ? <img src={tailUrl} alt={strings.tailFrameLabel} /> : <ImagePlus aria-hidden="true" size={21} />}
          </div>
          <span className={styles.frameSource}>
            {draft.continuity.last_frame_asset_id ? tailSource : strings.noTailFrame}
          </span>
        </article>
      </div>

      <div className={styles.keyframeActions}>
        <label>
          <span>{strings.uploadFirstFrameAction}</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={!shot || busy || uploading || generationPending || !onUpload}
            onChange={handleFile}
          />
        </label>
        <SelectMenu
            label={strings.selectFirstFrameLabel}
            value={explicitId ?? ""}
            disabled={!shot || busy || uploading || generationPending}
            onValueChange={(value) => {
              const assetId = value || null;
              setUploadedPreview(null);
              setExplicitAsset(
                assetId,
                selectableAssets.find((asset) => asset.id === assetId),
              );
            }}
            options={[{ value: "", label: strings.noExplicitFirstFrameOption }, ...selectableAssets.map((asset) => ({ value: asset.id, label: asset.label }))]}
          />
        <ShotFrameGeneration
          busy={busy || uploading}
          draft={draft}
          generationPreferences={generationPreferences}
          projectAspectRatio={projectAspectRatio}
          projectId={projectId}
          shot={shot}
          strings={strings}
          walletAvailableUnits={walletAvailableUnits}
          onGenerate={onGenerate}
          onGenerated={handleGenerated}
          onListTasks={onListTasks}
          onPendingChange={setGenerationPending}
          onRetryTaskItem={onRetryTaskItem}
          onSessionExpired={onSessionExpired}
          taskEvents={taskEvents}
        />
      </div>
      {uploading ? <span className={styles.frameStatus} role="status">{strings.uploadingFirstFrameStatus}</span> : null}
      {error ? (
        <div className={styles.frameError} role="alert">
          <span>{error}</span>
          {pendingFile ? (
            <Button
              icon={<RefreshCw size={15} />}
              disabled={busy || uploading || generationPending}
              onClick={() => void upload(pendingFile)}
            >
              {strings.retryFirstFrameUploadAction}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
