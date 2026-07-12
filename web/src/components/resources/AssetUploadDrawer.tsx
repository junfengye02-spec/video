import { Upload, X } from "lucide-react";
import { useState, type FormEvent, type RefObject } from "react";
import type { ReferenceImageUploadRequest } from "../../domain/types";
import { getStrings, type UIStrings } from "../../i18n";
import { useModalFocus } from "../accessibility/useModalFocus";

export interface AssetUploadDrawerProps {
  busy: boolean;
  error: string | null;
  returnFocusRef: RefObject<HTMLElement | null>;
  strings?: UIStrings["resources"];
  onClose: () => void;
  onSubmit: (payload: ReferenceImageUploadRequest) => Promise<void>;
}

export function AssetUploadDrawer({
  busy,
  error,
  returnFocusRef,
  strings = getStrings("zh").resources,
  onClose,
  onSubmit,
}: AssetUploadDrawerProps) {
  const [kind, setKind] = useState<ReferenceImageUploadRequest["kind"]>("character");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file || busy) {
      return;
    }

    const payload = {
      kind,
      label: label.trim(),
      description: description.trim(),
      prompt: prompt.trim(),
      file,
    } satisfies ReferenceImageUploadRequest;
    void onSubmit(payload);
  };

  const { panelRef, onKeyDown } = useModalFocus<HTMLDialogElement>({
    open: true,
    onEscape: () => {
      if (!busy) onClose();
    },
    returnFocusRef,
  });

  return (
    <dialog
      ref={panelRef}
      open
      aria-modal="true"
      aria-labelledby="resource-upload-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) {
          onClose();
        }
      }}
      onKeyDown={onKeyDown}
    >
      <div className="section-heading">
        <h2 id="resource-upload-title">{strings.uploadDialogTitle}</h2>
        <button
          type="button"
          title={strings.closeUploadAction}
          aria-label={strings.closeUploadAction}
          disabled={busy}
          onClick={onClose}
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>

      <form className="resource-form" onSubmit={handleSubmit}>
        <label>
          <span>{strings.kindLabel}</span>
          <select
            value={kind}
            disabled={busy}
            onChange={(event) => setKind(event.target.value as ReferenceImageUploadRequest["kind"])}
          >
            <option value="character">{strings.kindLabels.character}</option>
            <option value="scene">{strings.kindLabels.scene}</option>
            <option value="prop">{strings.kindLabels.prop}</option>
          </select>
        </label>
        <label>
          <span>{strings.labelLabel}</span>
          <input value={label} disabled={busy} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label>
          <span>{strings.descriptionLabel}</span>
          <input
            value={description}
            disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          <span>{strings.promptLabel}</span>
          <textarea
            rows={3}
            value={prompt}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>
        <label>
          <span>{strings.fileLabel}</span>
          <input
            type="file"
            required={!file}
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button className="async-action" type="submit" disabled={busy || !file}>
          <Upload aria-hidden="true" size={16} />
          {busy ? strings.uploadingResourceAction : strings.submitUploadAction}
        </button>
      </form>
    </dialog>
  );
}
