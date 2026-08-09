import { MiseLogo } from "../../../components/brand/MiseLogo";
import type { InspirationMessage } from "../../../domain/types";
import { LiftFade } from "../../../shared/motion";
import { inspirationCopy as copy } from "../copy";
import styles from "./Conversation.module.css";

export function InspirationMessageRow({ role, content }: InspirationMessage) {
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
          <p>{content}</p>
        </div>
      </article>
    </LiftFade>
  );
}
