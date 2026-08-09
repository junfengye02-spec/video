import { MapPinned, Package, UserRound } from "lucide-react";
import type { MediaAssetKind } from "../../domain/types";
import type { UIStrings } from "../../i18n";

export function AssetKindLabel({
  kind,
  strings,
}: {
  kind: MediaAssetKind;
  strings: UIStrings["resources"];
}) {
  const Icon = kind === "character" ? UserRound : kind === "scene" ? MapPinned : Package;
  return (
    <span className="asset-kind-label" data-resource-kind-icon={kind}>
      <Icon aria-hidden="true" size={14} />
      {strings.kindLabels[kind]}
    </span>
  );
}
