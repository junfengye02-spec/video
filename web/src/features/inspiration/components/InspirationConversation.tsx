import { ShieldCheck } from "lucide-react";
import { useEffect, useRef, type FormEvent } from "react";
import { CommandErrorNotice, type CommandError } from "../../../components/feedback/DomainErrorBoundary";
import type { InspirationMessage } from "../../../domain/types";
import { inspirationCopy as copy } from "../copy";
import type { InspirationSuggestion } from "../model";
import { InspirationComposer } from "./InspirationComposer";
import { InspirationMessageRow } from "./InspirationMessageRow";
import styles from "./Conversation.module.css";

export function InspirationConversation({
  active,
  developing,
  streamingReply,
  disabled,
  error,
  message,
  messages,
  onMessageChange,
  onTextModelChange,
  onSubmit,
  suggestions,
  textModel,
  attachments,
  uploadingAttachments,
  onUploadAttachment,
  onRemoveAttachment,
}: {
  active: boolean;
  developing: boolean;
  streamingReply: string;
  disabled: boolean;
  error: CommandError | null;
  message: string;
  messages: InspirationMessage[];
  onMessageChange: (message: string) => void;
  onTextModelChange: (model: string) => void;
  onSubmit: (event?: FormEvent<HTMLFormElement>) => void;
  suggestions: InspirationSuggestion[];
  textModel: string;
  attachments: import("../../../domain/types").InspirationAttachment[];
  uploadingAttachments: boolean;
  onUploadAttachment?: (file: File) => void;
  onRemoveAttachment: (id: string) => void;
}) {
  const conversationRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }, [developing, messages.length]);

  return (
    <section
      id="inspiration-conversation-panel"
      className={styles.panel}
      role="tabpanel"
      aria-label={copy.conversation}
      data-mobile-active={active}
    >
      <header className={styles.header}>
        <div>
          <span>{copy.conversationEyebrow}</span>
          <h2>{copy.conversationTitle}</h2>
        </div>
        <p><ShieldCheck aria-hidden="true" size={14} />{copy.conversationNote}</p>
      </header>

      <div ref={conversationRef} className={styles.messages} aria-live="polite">
        {messages.length === 0 ? (
          <InspirationMessageRow role="assistant" content={copy.assistantIntro} />
        ) : messages.map((item, index) => (
          <InspirationMessageRow
            key={`${item.role}-${index}-${item.content.slice(0, 24)}`}
            {...item}
            streaming={Boolean(streamingReply) && index === messages.length - 1 && item.role === "assistant"}
          />
        ))}
        {developing && !streamingReply ? (
          <div className={styles.thinking} role="status">
            <span className={styles.thinkingDots} aria-hidden="true"><i /><i /><i /></span>
            <span>{copy.sending}</span>
          </div>
        ) : null}
      </div>

      <div className={styles.composerDock}>
        <div className={styles.commandFeedback} aria-live="assertive">
          <CommandErrorNotice error={error} />
        </div>
        <InspirationComposer
          disabled={disabled}
          loading={developing}
          message={message}
          onChange={onMessageChange}
          onTextModelChange={onTextModelChange}
          onSubmit={onSubmit}
          suggestions={suggestions}
          textModel={textModel}
          attachments={attachments}
          uploadingAttachments={uploadingAttachments}
          onUploadAttachment={onUploadAttachment}
          onRemoveAttachment={onRemoveAttachment}
        />
      </div>
    </section>
  );
}
