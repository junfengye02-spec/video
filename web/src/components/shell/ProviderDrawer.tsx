import type { UIStrings } from "../../i18n";
import type { GatewayKeySession, ProviderCredentials } from "../../domain/types";
import { KeyGate } from "../KeyGate";

export interface ProviderDrawerProps {
  credentials: ProviderCredentials;
  maskedKeys: GatewayKeySession["masked_keys"] | null;
  saving: boolean;
  strings: UIStrings["keyGate"];
  onFieldChange: <K extends keyof ProviderCredentials>(
    field: K,
    value: ProviderCredentials[K],
  ) => void;
  onSubmit: () => void;
}

export function ProviderDrawer({
  credentials,
  maskedKeys,
  saving,
  strings,
  onFieldChange,
  onSubmit,
}: ProviderDrawerProps) {
  return (
    <KeyGate
      baseUrl={credentials.base_url}
      textKey={credentials.text_key}
      imageKey={credentials.image_key}
      videoKey={credentials.video_key}
      textModel={credentials.text_model}
      imageModel={credentials.image_model}
      videoModel={credentials.video_model}
      maskedKeys={maskedKeys}
      saving={saving}
      strings={strings}
      onBaseUrlChange={(value) => onFieldChange("base_url", value)}
      onTextKeyChange={(value) => onFieldChange("text_key", value)}
      onImageKeyChange={(value) => onFieldChange("image_key", value)}
      onVideoKeyChange={(value) => onFieldChange("video_key", value)}
      onTextModelChange={(value) => onFieldChange("text_model", value)}
      onImageModelChange={(value) => onFieldChange("image_model", value)}
      onVideoModelChange={(value) => onFieldChange("video_model", value)}
      onSubmit={onSubmit}
    />
  );
}
