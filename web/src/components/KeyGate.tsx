import { KeyRound, ShieldCheck } from "lucide-react";

interface KeyGateProps {
  baseUrl: string;
  textKey: string;
  imageKey: string;
  videoKey: string;
  textModel: string;
  imageModel: string;
  videoModel: string;
  maskedKeys: { text: string; image: string; video: string } | null;
  saving: boolean;
  onBaseUrlChange: (value: string) => void;
  onTextKeyChange: (value: string) => void;
  onImageKeyChange: (value: string) => void;
  onVideoKeyChange: (value: string) => void;
  onTextModelChange: (value: string) => void;
  onImageModelChange: (value: string) => void;
  onVideoModelChange: (value: string) => void;
  onSubmit: () => void;
}

const VIDEO_MODEL_OPTIONS = [
  "omni_flash-10s",
  "veo_3_1-lite",
  "veo_3_1-fast-fl",
  "veo_3_1-lite-fl",
];

export function KeyGate({
  baseUrl,
  textKey,
  imageKey,
  videoKey,
  textModel,
  imageModel,
  videoModel,
  maskedKeys,
  saving,
  onBaseUrlChange,
  onTextKeyChange,
  onImageKeyChange,
  onVideoKeyChange,
  onTextModelChange,
  onImageModelChange,
  onVideoModelChange,
  onSubmit,
}: KeyGateProps) {
  return (
    <form
      className="key-gate"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="key-row">
        <label htmlFor="text-key">Text API Key</label>
        <div className="input-with-icon">
          <KeyRound aria-hidden="true" size={16} />
          <input
            id="text-key"
            name="text-key"
            autoComplete="off"
            type="password"
            value={textKey}
            onChange={(event) => onTextKeyChange(event.target.value)}
            placeholder="sk-..."
          />
        </div>
        <label htmlFor="text-model">Text Model</label>
        <input
          id="text-model"
          name="text-model"
          value={textModel}
          onChange={(event) => onTextModelChange(event.target.value)}
        />
      </div>

      <div className="key-row">
        <label htmlFor="image-key">Image API Key</label>
        <div className="input-with-icon">
          <KeyRound aria-hidden="true" size={16} />
          <input
            id="image-key"
            name="image-key"
            autoComplete="off"
            type="password"
            value={imageKey}
            onChange={(event) => onImageKeyChange(event.target.value)}
            placeholder="sk-..."
          />
        </div>
        <label htmlFor="image-model">Image Model</label>
        <input
          id="image-model"
          name="image-model"
          value={imageModel}
          onChange={(event) => onImageModelChange(event.target.value)}
        />
      </div>

      <div className="key-row">
        <label htmlFor="video-key">Video API Key</label>
        <div className="input-with-icon">
          <KeyRound aria-hidden="true" size={16} />
          <input
            id="video-key"
            name="video-key"
            autoComplete="off"
            type="password"
            value={videoKey}
            onChange={(event) => onVideoKeyChange(event.target.value)}
            placeholder="sk-..."
          />
        </div>
        <label htmlFor="video-model">Video Model</label>
        <input
          id="video-model"
          name="video-model"
          list="video-model-options"
          value={videoModel}
          onChange={(event) => onVideoModelChange(event.target.value)}
        />
        <datalist id="video-model-options">
          {VIDEO_MODEL_OPTIONS.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </div>

      <label htmlFor="base-url">Gateway Base URL</label>
      <input
        id="base-url"
        name="base-url"
        type="url"
        value={baseUrl}
        onChange={(event) => onBaseUrlChange(event.target.value)}
      />

      <button className="primary-button" type="submit" disabled={saving}>
        <ShieldCheck aria-hidden="true" size={16} />
        {saving ? "Checking" : maskedKeys ? "Update keys" : "Use keys"}
      </button>

      <div className="key-status" aria-live="polite">
        {maskedKeys ? (
          <span>
            Active T {maskedKeys.text} / I {maskedKeys.image} / V {maskedKeys.video}
          </span>
        ) : (
          <span>Keys not set</span>
        )}
      </div>
    </form>
  );
}
