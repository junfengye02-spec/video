import { Send } from "lucide-react";
import { useRef, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "../../../shared/ui";
import { inspirationCopy as copy } from "../copy";
import type { InspirationSuggestion } from "../model";
import { GenerationModelPicker } from "../../generation/GenerationModelPicker";
import { getStrings } from "../../../i18n";
import styles from "./InspirationComposer.module.css";

export function InspirationComposer({
  disabled,
  loading,
  message,
  onChange,
  onTextModelChange,
  onSubmit,
  suggestions,
  textModel,
}: {
  disabled: boolean;
  loading: boolean;
  message: string;
  onChange: (message: string) => void;
  onTextModelChange: (model: string) => void;
  onSubmit: (event?: FormEvent<HTMLFormElement>) => void;
  suggestions: InspirationSuggestion[];
  textModel: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  function chooseSuggestion(value: string) {
    onChange(value);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(value.length, value.length);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <form className={styles.composer} onSubmit={onSubmit}>
      <div className={styles.tools}>
        <div className={styles.suggestions} aria-label={copy.suggestionsLabel}>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              disabled={disabled || loading}
              onClick={() => chooseSuggestion(suggestion.value)}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
        <div className={styles.modelPicker}>
          <GenerationModelPicker
            capability="text"
            compact
            disabled={disabled || loading}
            label="灵感文本模型"
            required
            strings={getStrings("zh").modelCatalog}
            value={textModel}
            onChange={onTextModelChange}
          />
        </div>
      </div>
      <label className={styles.srLabel} htmlFor="inspiration-message">{copy.composerLabel}</label>
      <div className={styles.composerSurface}>
        <textarea
          ref={textareaRef}
          id="inspiration-message"
          rows={3}
          value={message}
          placeholder={copy.composerPlaceholder}
          disabled={disabled || loading}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <Button
          type="submit"
          variant="primary"
          className={styles.sendCommand}
          aria-label={copy.send}
          icon={<Send size={16} />}
          loading={loading}
          disabled={!message.trim() || disabled}
        >
          <span className={styles.sendLabel}>{copy.send}</span>
        </Button>
      </div>
    </form>
  );
}
