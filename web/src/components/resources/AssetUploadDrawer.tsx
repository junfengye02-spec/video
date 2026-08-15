import { Upload, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type RefObject } from "react";
import type { AssetRecord, ReferenceImageUploadRequest } from "../../domain/types";
import { getStrings, type UIStrings } from "../../i18n";
import { SelectMenu } from "../../shared/ui";
import { useModalFocus } from "../accessibility/useModalFocus";

export interface AssetUploadDrawerProps {
  busy: boolean;
  error: string | null;
  returnFocusRef: RefObject<HTMLElement | null>;
  resource?: AssetRecord;
  strings?: UIStrings["resources"];
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSubmit: (payload: ReferenceImageUploadRequest) => Promise<void>;
}

export function AssetUploadDrawer({
  busy,
  error,
  returnFocusRef,
  resource,
  strings = getStrings("zh").resources,
  onClose,
  onDirtyChange,
  onSubmit,
}: AssetUploadDrawerProps) {
  const [kind, setKind] = useState<ReferenceImageUploadRequest["kind"]>(resource?.kind ?? "character");
  const [label, setLabel] = useState(resource?.label ?? "");
  const [description, setDescription] = useState(resource?.description ?? "");
  const [prompt, setPrompt] = useState(resource?.prompt ?? "");
  const [file, setFile] = useState<File | null>(null);
  const dirty = resource
    ? Boolean(file)
    : kind !== "character" || Boolean(label || description || prompt || file);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const requestClose = () => {
    if (busy) return;
    if (dirty && !window.confirm(strings.discardDrawerChanges)) return;
    onClose();
  };

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
      ...(resource ? { resource_id: resource.id } : {}),
    } satisfies ReferenceImageUploadRequest;
    void onSubmit(payload);
  };

  const { panelRef, onKeyDown } = useModalFocus<HTMLDialogElement>({
    open: true,
    onEscape: requestClose,
    returnFocusRef,
  });

  return (
    <dialog
      ref={panelRef}
      aria-modal="true"
      aria-labelledby="resource-upload-title"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="section-heading">
        <h2 id="resource-upload-title">{resource ? strings.uploadPlannedReferenceTitle(resource.label) : strings.uploadDialogTitle}</h2>
        <button
          type="button"
          title={strings.closeUploadAction}
          aria-label={strings.closeUploadAction}
          disabled={busy}
          onClick={requestClose}
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>

      <form className="resource-form" onSubmit={handleSubmit}>
        {resource ? <p className="resource-plan-prefill" role="status">{strings.uploadPlannedReferenceNotice}</p> : <><SelectMenu
          disabled={busy}
          label={strings.kindLabel}
          value={kind}
          onValueChange={setKind}
          options={[
            { value: "character", label: strings.kindLabels.character },
            { value: "scene", label: strings.kindLabels.scene },
            { value: "prop", label: strings.kindLabels.prop },
          ]}
        />
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
        </label></>}
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
