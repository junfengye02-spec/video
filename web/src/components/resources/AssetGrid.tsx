import type { AssetRecord, Shot } from "../../domain/types";
import { getStrings, type UIStrings } from "../../i18n";
import { countLinkedShots } from "./assetLibrary";

export interface AssetGridProps {
  assets: AssetRecord[];
  disabled: boolean;
  shots: Shot[];
  strings?: UIStrings["resources"];
  onSelect: (assetId: string) => void;
}

export function AssetGrid({
  assets,
  disabled,
  shots,
  strings = getStrings("zh").resources,
  onSelect,
}: AssetGridProps) {
  if (assets.length === 0) {
    return <p className="empty-state">{strings.emptyState}</p>;
  }

  return (
    <div className="asset-list">
      {assets.map((asset) => {
        const thumbnail = asset.media_urls?.find((url) => !/\.(?:mp4|mov|webm)(?:[?#]|$)/i.test(url))
          ?? asset.reference_images[0];

        return (
          <button
            className="asset-card"
            type="button"
            key={asset.id}
            aria-label={strings.viewAsset(asset.label)}
            disabled={disabled}
            onClick={() => onSelect(asset.id)}
          >
            {thumbnail ? <img src={thumbnail} alt="" /> : null}
            <strong>{asset.label}</strong>
            <small>{strings.kindLabels[asset.kind]}</small>
            <span>{strings.linkedShotCount(countLinkedShots(asset.id, shots))}</span>
          </button>
        );
      })}
    </div>
  );
}
