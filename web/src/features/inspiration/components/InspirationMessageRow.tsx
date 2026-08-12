import { FileText } from "lucide-react";
import { MiseLogo } from "../../../components/brand/MiseLogo";
import type { InspirationMessage } from "../../../domain/types";
import { LiftFade } from "../../../shared/motion";
import { inspirationCopy as copy } from "../copy";
import styles from "./Conversation.module.css";

export function InspirationMessageRow({
  role,
  content,
  attachments = [],
  streaming = false,
}: InspirationMessage & { streaming?: boolean }) {
  const assistant = role === "assistant";
  return (
    <LiftFade className={styles.messageEntrance}>
      <article className={`${styles.message} ${assistant ? styles.assistantMessage : styles.userMessage}`}>
        <div className={styles.identity}>
          {assistant ? (
            <MiseLogo compact className={styles.assistantLogo} aria-label="mise" />
          ) : (
            <span className={styles.userMark} aria-hidden="true">{copy.you}</span>
          )}
        </div>
        <div className={styles.messageContent}>
          <p>{content}{streaming ? <span className={styles.streamCursor} aria-hidden="true" /> : null}</p>
          {attachments.length ? (
            <div className={styles.messageAttachments}>
              {attachments.map((attachment) => (
                <a className={styles.messageAttachment} key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer">
                  {attachment.content_type.startsWith("image/") ? <img src={attachment.url} alt="" /> : <FileText size={15} />}
                  <span>{attachment.filename}</span>
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </article>
    </LiftFade>
  );
}
