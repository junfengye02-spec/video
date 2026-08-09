import { CircleHelp } from "lucide-react";
import type { CreativeBrief, ProjectType } from "../../../domain/types";
import { inspirationCopy as copy } from "../copy";
import { InspirationCommandBar } from "./InspirationCommandBar";
import type { CommandError } from "../../../components/feedback/DomainErrorBoundary";
import styles from "./CreativeBrief.module.css";

function displayValue(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function BriefValue({ value }: { value: string | null | undefined }) {
  const displayed = displayValue(value);
  return (
    <span key={displayed ?? "empty"} className={`${styles.fieldTransition} ${displayed ? "" : styles.empty}`}>
      {displayed ?? copy.emptyValue}
    </span>
  );
}

function BriefFact({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string | null | undefined;
  wide?: boolean;
}) {
  return (
    <div className={wide ? styles.wide : undefined}>
      <dt>{label}</dt>
      <dd><BriefValue value={value} /></dd>
    </div>
  );
}

function BriefDetails({
  brief,
  projectType,
}: {
  brief: CreativeBrief | null;
  projectType: ProjectType;
}) {
  const duration = brief?.duration_seconds ? `${brief.duration_seconds} 秒` : null;
  const mustKeep = brief?.must_have.filter((item) => item.trim()) ?? [];
  const title = displayValue(brief?.title);
  const generatedFormat = displayValue(brief?.format);
  const projectFormat = copy.projectTypeFormats[projectType];
  const format = generatedFormat && generatedFormat !== projectFormat
    ? `${projectFormat} · ${generatedFormat}`
    : projectFormat;
  return (
    <div className={styles.details}>
      <section className={styles.documentTitle}>
        <span>{copy.fields.title}</span>
        <h2 id="creative-brief-title" key={title ?? "empty"} className={`${styles.fieldTransition} ${title ? "" : styles.empty}`}>
          {title ?? copy.emptyValue}
        </h2>
      </section>
      <section className={styles.logline}>
        <span>{copy.fields.logline}</span>
        <p><BriefValue value={brief?.logline} /></p>
      </section>
      <dl className={styles.factGrid}>
        <BriefFact label={copy.fields.audience} value={brief?.audience} />
        <BriefFact label={copy.fields.format} value={format} />
        <BriefFact label={copy.fields.duration} value={duration} />
        <BriefFact label={copy.fields.aspectRatio} value={brief?.aspect_ratio} />
        <BriefFact label={copy.fields.genre} value={brief?.genre} />
        <BriefFact label={copy.fields.mood} value={brief?.tone} />
        <BriefFact label={copy.fields.visualDirection} value={brief?.visual_style} wide />
      </dl>
      <section className={styles.documentSection}>
        <h3>{copy.fields.outline}</h3>
        <p><BriefValue value={brief?.story_outline} /></p>
      </section>
      <section className={`${styles.documentSection} ${styles.mustKeep}`}>
        <h3>{copy.fields.mustKeep}</h3>
        {mustKeep.length ? (
          <ul>{mustKeep.map((item) => <li key={item} className={styles.fieldTransition}>{item}</li>)}</ul>
        ) : (
          <p><span className={styles.empty}>{copy.emptyValue}</span></p>
        )}
      </section>
    </div>
  );
}

export function CreativeBriefCanvas({
  active,
  brief,
  controlEndFrames,
  developing,
  error,
  intentSaving,
  onConfirm,
  onControlEndFramesChange,
  planning,
  planSubmitted,
  projectType,
  ready,
}: {
  active: boolean;
  brief: CreativeBrief | null;
  controlEndFrames: boolean;
  developing: boolean;
  error: CommandError | null;
  intentSaving: boolean;
  onConfirm: () => void;
  onControlEndFramesChange: (enabled: boolean) => void;
  planning: boolean;
  planSubmitted: boolean;
  projectType: ProjectType;
  ready: boolean;
}) {
  return (
    <aside
      id="inspiration-brief-panel"
      className={styles.panel}
      role="tabpanel"
      aria-label={copy.brief}
      data-mobile-active={active}
    >
      <header className={styles.toolbar}>
        <span className={styles.statusDot} aria-hidden="true" />
        <strong>{copy.briefTitle}</strong>
        <small>{copy.briefSubtitle}</small>
      </header>

      <div className={styles.scroll}>
        <article className={styles.document} aria-labelledby="creative-brief-title">
          <div className={styles.documentMeta}>
            <span>{copy.documentLabel}</span>
            <span>{brief ? "01" : "--"}</span>
          </div>
          <BriefDetails brief={brief} projectType={projectType} />

          {!ready ? (
            <section className={styles.questions} aria-labelledby="brief-questions-title">
              <div>
                <CircleHelp aria-hidden="true" size={17} />
                <h3 id="brief-questions-title">{copy.questionsTitle}</h3>
              </div>
              {brief?.open_questions.length ? (
                <ul>
                  {brief.open_questions.map((question) => <li key={question}>{question}</li>)}
                </ul>
              ) : (
                <p>{copy.questionsEmpty}</p>
              )}
            </section>
          ) : null}

          <InspirationCommandBar
            controlEndFrames={controlEndFrames}
            developing={developing}
            error={error}
            hasBrief={Boolean(brief)}
            intentSaving={intentSaving}
            onConfirm={onConfirm}
            onControlEndFramesChange={onControlEndFramesChange}
            onRetry={onConfirm}
            planning={planning}
            planSubmitted={planSubmitted}
            ready={ready}
          />
        </article>
      </div>
    </aside>
  );
}
