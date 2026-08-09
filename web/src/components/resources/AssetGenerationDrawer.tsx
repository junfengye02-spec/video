import { Sparkles, Undo2, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type RefObject } from "react";
import type {
  GenerateImagesRequest,
  MediaAssetKind,
  ProjectGenerationPreferences,
  PromptOptimizeResponse,
} from "../../domain/types";
import { getStrings, type UIStrings } from "../../i18n";
import { GenerationModelPicker } from "../../features/generation/GenerationModelPicker";
import { SelectMenu } from "../../shared/ui";
import {
  CommandErrorNotice,
  type CommandError,
} from "../feedback/DomainErrorBoundary";
import { useModalFocus } from "../accessibility/useModalFocus";

export interface AssetGenerationDrawerProps {
  busy: boolean;
  error: CommandError | null;
  fixedCount?: number;
  optimizing?: boolean;
  generationPreferences?: ProjectGenerationPreferences;
  initialDescription?: string;
  initialKind?: GenerateImagesRequest["kind"];
  initialLabel?: string;
  initialPrompt?: string;
  lockKind?: boolean;
  prefillNotice?: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  strings?: UIStrings["resources"];
  title?: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOptimizationInputChange?: (kind: MediaAssetKind, sourceText: string) => void;
  onOptimizePrompt?: (
    kind: MediaAssetKind,
    sourceText: string,
  ) => Promise<PromptOptimizeResponse>;
  onSubmit: (payload: GenerateImagesRequest) => Promise<void>;
}

export function AssetGenerationDrawer({
  busy,
  error,
  fixedCount,
  optimizing = false,
  generationPreferences,
  initialDescription = "",
  initialKind = "character",
  initialLabel = "",
  initialPrompt = "",
  lockKind = false,
  prefillNotice,
  returnFocusRef,
  strings = getStrings("zh").resources,
  title,
  onClose,
  onDirtyChange,
  onOptimizationInputChange,
  onOptimizePrompt,
  onSubmit,
}: AssetGenerationDrawerProps) {
  const [kind, setKind] = useState<GenerateImagesRequest["kind"]>(initialKind);
  const [label, setLabel] = useState(initialLabel);
  const [description, setDescription] = useState(initialDescription);
  const [prompt, setPrompt] = useState(initialPrompt);
  const initialModel = generationPreferences?.image_model || "gpt-image-2";
  const initialSize = generationPreferences?.image_size || "1024x1024";
  const initialQuality = generationPreferences?.image_quality || "standard";
  const [model, setModel] = useState(initialModel);
  const [count, setCount] = useState(fixedCount ?? 1);
  const [size, setSize] = useState(initialSize);
  const [quality, setQuality] = useState(initialQuality);
  const [promptBeforeOptimization, setPromptBeforeOptimization] = useState<string | null>(null);

  const locked = busy || optimizing;
  const dirty = kind !== initialKind
    || label !== initialLabel
    || description !== initialDescription
    || prompt !== initialPrompt
    || model !== initialModel
    || count !== (fixedCount ?? 1)
    || size !== initialSize
    || quality !== initialQuality;
  const valid = Boolean(label.trim() && prompt.trim() && model.trim() && count >= 1 && count <= 10);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const requestClose = () => {
    if (locked) return;
    if (dirty && !window.confirm(strings.discardDrawerChanges)) return;
    onClose();
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!valid || locked) return;
    void onSubmit({
      kind,
      label: label.trim(),
      description: description.trim(),
      prompt: prompt.trim(),
      model: model.trim(),
      count,
      size,
      quality,
    });
  };
  const handleOptimize = async () => {
    const sourceText = prompt.trim();
    if (!onOptimizePrompt || !sourceText || locked) return;
    try {
      const result = await onOptimizePrompt(kind, sourceText);
      setPromptBeforeOptimization(sourceText);
      setPrompt(result.optimized_text);
      onOptimizationInputChange?.(kind, result.optimized_text);
    } catch {
      // The page owns the domain error so payment recovery remains consistent.
    }
  };

  const handleUndoOptimization = () => {
    if (promptBeforeOptimization === null || locked) return;
    setPrompt(promptBeforeOptimization);
    setPromptBeforeOptimization(null);
    onOptimizationInputChange?.(kind, promptBeforeOptimization);
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
      aria-labelledby="resource-generate-title"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="section-heading">
        <h2 id="resource-generate-title">{title ?? strings.generateDialogTitle}</h2>
        <button
          type="button"
          title={strings.closeGenerateAction}
          aria-label={strings.closeGenerateAction}
          disabled={locked}
          onClick={requestClose}
        >
          <X aria-hidden="true" size={16} />
        </button>
      </div>

      {prefillNotice ? <p className="resource-plan-prefill" role="status">{prefillNotice}</p> : null}
      <form className="resource-form resource-generation-form" onSubmit={handleSubmit}>
        <fieldset disabled={locked}>
          <SelectMenu
              label={strings.kindLabel}
              value={kind}
              disabled={lockKind}
              onValueChange={(nextKind) => {
                setKind(nextKind);
                setPromptBeforeOptimization(null);
                onOptimizationInputChange?.(nextKind, prompt);
              }}
              options={[
                { value: "character", label: strings.kindLabels.character },
                { value: "scene", label: strings.kindLabels.scene },
                { value: "prop", label: strings.kindLabels.prop },
              ]}
            />
          <label>
            <span>{strings.labelLabel}</span>
            <input
              required
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label>
            <span>{strings.descriptionLabel}</span>
            <textarea
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label>
            <span>{strings.promptLabel}</span>
            <textarea
              required
              rows={5}
              value={prompt}
              onChange={(event) => {
                const nextPrompt = event.target.value;
                setPrompt(nextPrompt);
                setPromptBeforeOptimization(null);
                onOptimizationInputChange?.(kind, nextPrompt);
              }}
            />
          </label>
          {onOptimizePrompt ? (
            <div className="resource-prompt-actions">
              <button
                className="secondary-button async-action"
                type="button"
                disabled={locked || !prompt.trim()}
                onClick={() => void handleOptimize()}
              >
                <Sparkles aria-hidden="true" size={16} />
                {optimizing ? strings.optimizingPromptAction : strings.optimizePromptAction}
              </button>
              {promptBeforeOptimization !== null ? (
                <button
                  type="button"
                  disabled={locked}
                  onClick={handleUndoOptimization}
                >
                  <Undo2 aria-hidden="true" size={16} />
                  {strings.undoPromptOptimizationAction}
                </button>
              ) : null}
            </div>
          ) : null}
          <GenerationModelPicker
            capability="image"
            disabled={locked}
            label={strings.modelLabel}
            required
            strings={getStrings("zh").modelCatalog}
            value={model}
            onChange={setModel}
          />
          <div className="resource-generation-options">
            <label>
              <span>{strings.countLabel}</span>
              <input
                type="number"
                min={1}
                max={10}
                disabled={fixedCount !== undefined}
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
              />
            </label>
            <SelectMenu label={strings.sizeLabel} value={size} onValueChange={setSize} options={[
              { value: "1024x1024", label: strings.sizeLabels["1024x1024"] },
              { value: "1536x1024", label: strings.sizeLabels["1536x1024"] },
              { value: "1024x1536", label: strings.sizeLabels["1024x1536"] },
            ]} />
            <SelectMenu label={strings.qualityLabel} value={quality} onValueChange={setQuality} options={[
              { value: "standard", label: strings.qualityLabels.standard },
              { value: "high", label: strings.qualityLabels.high },
            ]} />
          </div>
        </fieldset>
        <CommandErrorNotice error={error} walletLinkTarget="_blank" />
        <button className="primary-button async-action" type="submit" disabled={locked || !valid}>
          <Sparkles aria-hidden="true" size={16} />
          {busy ? strings.generatingImagesAction : strings.submitGenerateAction}
        </button>
      </form>
    </dialog>
  );
}
