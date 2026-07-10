import { Boxes, Search, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { AssetDetailDrawer } from "../components/resources/AssetDetailDrawer";
import { AssetGrid } from "../components/resources/AssetGrid";
import { AssetUploadDrawer } from "../components/resources/AssetUploadDrawer";
import {
  filterAssets,
  type AssetKindFilter,
  type ResourcePanelState,
} from "../components/resources/assetLibrary";
import type {
  AssetRecord,
  ConsistencyReport,
  ReferenceImageUploadRequest,
  Shot,
} from "../domain/types";
import { getStrings } from "../i18n";

export interface ResourceLibraryPageProps {
  assets: AssetRecord[];
  consistencyReport: ConsistencyReport | null;
  currentShotId: string | null;
  shots: Shot[];
  uploading: boolean;
  onBindAsset: (shotId: string, assetId: string, bind: boolean) => Promise<void>;
  onUploadReferenceImage: (payload: ReferenceImageUploadRequest) => Promise<void>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ResourceLibraryPage({
  assets,
  consistencyReport,
  currentShotId,
  shots,
  uploading,
  onBindAsset,
  onUploadReferenceImage,
}: ResourceLibraryPageProps) {
  const strings = getStrings("zh").resources;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<AssetKindFilter>("all");
  const [panel, setPanel] = useState<ResourcePanelState>({ mode: "closed" });
  const [binding, setBinding] = useState(false);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [uploadPending, setUploadPending] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const operationPending = binding || uploadPending || uploading;

  const filteredAssets = useMemo(
    () => filterAssets(assets, { kind, query }),
    [assets, kind, query],
  );
  const supportedAssets = useMemo(
    () => filterAssets(assets, { kind: "all", query: "" }),
    [assets],
  );
  const selectedAsset = panel.mode === "detail"
    ? supportedAssets.find((asset) => asset.id === panel.assetId) ?? null
    : null;

  const openDetail = (assetId: string) => {
    if (operationPending) {
      return;
    }
    setBindingError(null);
    setUploadError(null);
    setPanel({ mode: "detail", assetId });
  };

  const openUpload = () => {
    if (operationPending) {
      return;
    }
    setBindingError(null);
    setUploadError(null);
    setPanel({ mode: "upload" });
  };

  const closePanel = () => {
    if (operationPending) {
      return;
    }
    setPanel({ mode: "closed" });
    setBindingError(null);
    setUploadError(null);
  };

  const handleBind = async (bind: boolean) => {
    if (
      operationPending
      || panel.mode !== "detail"
      || !currentShotId
      || !shots.some((shot) => shot.id === currentShotId)
    ) {
      return;
    }

    const assetId = panel.assetId;
    setBinding(true);
    setBindingError(null);
    try {
      await onBindAsset(currentShotId, assetId, bind);
    } catch (error) {
      setBindingError(errorMessage(error, strings.bindError));
    } finally {
      setBinding(false);
    }
  };

  const handleUpload = async (payload: ReferenceImageUploadRequest) => {
    if (operationPending) {
      return;
    }

    setUploadPending(true);
    setUploadError(null);
    try {
      await onUploadReferenceImage(payload);
      setPanel((current) => current.mode === "upload" ? { mode: "closed" } : current);
    } catch (error) {
      setUploadError(errorMessage(error, strings.uploadError));
    } finally {
      setUploadPending(false);
    }
  };

  return (
    <section className="storyboard-panel resource-library" aria-labelledby="resource-library-title">
      <div className="section-heading">
        <Boxes aria-hidden="true" size={18} />
        <h1 id="resource-library-title">{strings.title}</h1>
        <button type="button" disabled={operationPending} onClick={openUpload}>
          <Upload aria-hidden="true" size={16} />
          {strings.uploadResourceAction}
        </button>
      </div>

      <div className="resource-form">
        <label>
          <span>{strings.filterLabel}</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as AssetKindFilter)}
          >
            <option value="all">{strings.allKindsLabel}</option>
            <option value="character">{strings.kindLabels.character}</option>
            <option value="scene">{strings.kindLabels.scene}</option>
            <option value="prop">{strings.kindLabels.prop}</option>
          </select>
        </label>
        <label>
          <span>{strings.searchLabel}</span>
          <span>
            <Search aria-hidden="true" size={16} />
            <input
              type="search"
              value={query}
              placeholder={strings.searchPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
            />
          </span>
        </label>
      </div>

      <AssetGrid
        assets={filteredAssets}
        disabled={operationPending}
        shots={shots}
        strings={strings}
        onSelect={openDetail}
      />

      {selectedAsset ? (
        <AssetDetailDrawer
          asset={selectedAsset}
          binding={binding}
          bindingError={bindingError}
          consistencyReport={consistencyReport}
          currentShotId={currentShotId}
          panelLocked={operationPending}
          shots={shots}
          strings={strings}
          onBind={(bind) => void handleBind(bind)}
          onClose={closePanel}
        />
      ) : null}

      {panel.mode === "upload" ? (
        <AssetUploadDrawer
          busy={operationPending}
          error={uploadError}
          strings={strings}
          onClose={closePanel}
          onSubmit={handleUpload}
        />
      ) : null}
    </section>
  );
}
