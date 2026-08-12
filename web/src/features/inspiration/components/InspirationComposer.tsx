import { ArrowUp, FileText, LoaderCircle, Paperclip, X } from "lucide-react";
import { useRef, type FormEvent, type KeyboardEvent } from "react";
import { inspirationCopy as copy } from "../copy";
import type { InspirationSuggestion } from "../model";
import type { InspirationAttachment } from "../../../domain/types";
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
  attachments,
  uploadingAttachments,
  onUploadAttachment,
  onRemoveAttachment,
}: {
  disabled: boolean;
  loading: boolean;
  message: string;
  onChange: (message: string) => void;
  onTextModelChange: (model: string) => void;
  onSubmit: (event?: FormEvent<HTMLFormElement>) => void;
  suggestions: InspirationSuggestion[];
  textModel: string;
  attachments?: InspirationAttachment[];
  uploadingAttachments?: boolean;
  onUploadAttachment?: (file: File) => void;
  onRemoveAttachment?: (id: string) => void;
}) {
  const selectedAttachments = attachments ?? [];
  const isUploadingAttachments = uploadingAttachments ?? false;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
        {selectedAttachments.length || isUploadingAttachments ? (
          <div className={styles.attachments} aria-label="已添加附件">
            {selectedAttachments.map((attachment) => {
              const image = attachment.content_type.startsWith("image/");
              return (
                <div className={styles.attachmentCard} key={attachment.id}>
                  {image ? (
                    <img src={attachment.url} alt="" className={styles.attachmentPreview} />
                  ) : <span className={styles.attachmentIcon}><FileText size={16} /></span>}
                  <span className={styles.attachmentName} title={attachment.filename}>{attachment.filename}</span>
                  <button type="button" className={styles.removeAttachment} onClick={() => onRemoveAttachment?.(attachment.id)} aria-label={`移除 ${attachment.filename}`}>
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            {isUploadingAttachments ? <div className={styles.uploadingCard}>正在上传…</div> : null}
          </div>
        ) : null}
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
        <input
          ref={fileInputRef}
          type="file"
          hidden
          multiple
          accept="image/png,image/jpeg,image/webp,.txt,.md,.markdown,.json,.csv,.yaml,.yml,.srt,.pdf,.doc,.docx"
          onChange={(event) => {
            for (const file of Array.from(event.target.files ?? [])) onUploadAttachment?.(file);
            event.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          className={styles.attachButton}
          aria-label="上传附件"
          disabled={disabled || loading || isUploadingAttachments || !onUploadAttachment}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip size={17} />
        </button>
        <button
          type="submit"
          className={styles.sendCommand}
          aria-label={copy.send}
          aria-busy={loading || undefined}
          disabled={loading || (!message.trim() && !selectedAttachments.length) || disabled}
        >
          {loading ? (
            <LoaderCircle aria-hidden="true" className={styles.sendSpinner} size={17} />
          ) : (
            <ArrowUp aria-hidden="true" size={18} strokeWidth={2.4} />
          )}
        </button>
      </div>
    </form>
  );
}
