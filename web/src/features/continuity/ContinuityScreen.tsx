import {
  AudioLines,
  BookOpenText,
  CircleCheck,
  Layers3,
  Palette,
  SlidersHorizontal,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { ContinuityEditor } from "../../components/continuity/ContinuityEditor";
import styles from "./ContinuityScreen.module.css";
import {
  useContinuityController,
  type ContinuityControllerProps,
} from "./model/useContinuityController";

const SECTION_ICONS: Record<string, LucideIcon> = {
  "settings-worldview": BookOpenText,
  "settings-characters": UsersRound,
  "settings-visual": Palette,
  "settings-sound": AudioLines,
  "settings-generation": SlidersHorizontal,
  "settings-episodes": Layers3,
};

export function ContinuityScreen(props: ContinuityControllerProps) {
  const controller = useContinuityController(props);
  const {
    pageStrings, draft, resetVersion, error, dirty, savePending, statusMessage,
    sections, characters, consistencyReport, workflow, strings,
    goToSection, updateDraft, save,
  } = controller;

  return (
    <section className={`${styles.root} global-settings-page`} aria-labelledby="global-settings-title">
      <header className="global-settings-heading">
        <div>
          <span className="settings-eyebrow">mise studio</span>
          <h1 id="global-settings-title">{pageStrings.title}</h1>
        </div>
        {workflow ? (
          <span className="settings-workflow-status" data-approved={workflow.phase === "approved"}>
            <CircleCheck aria-hidden="true" size={16} />
            {workflow.phase === "approved" ? pageStrings.workflowApproved : pageStrings.workflowNotApproved}
          </span>
        ) : null}
      </header>

      <p className="settings-impact-notice">{pageStrings.notice}</p>

      <div className={`global-settings-workspace ${styles.workspace}`}>
        <aside className={`settings-directory ${styles.directory}`}>
          <nav aria-label={pageStrings.directoryLabel}>
            {sections.map(({ id, label }) => {
              const Icon = SECTION_ICONS[id];
              return (
                <button type="button" key={id} onClick={() => goToSection(id)}>
                  <Icon aria-hidden="true" size={16} />
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>
          <dl className="settings-directory-summary">
            <div><dt>{pageStrings.characterRosterTitle}</dt><dd>{characters.length}</dd></div>
            <div><dt>{pageStrings.continuityIssuesTitle}</dt><dd>{consistencyReport?.issues.length ?? 0}</dd></div>
          </dl>
        </aside>

        <main className={`settings-document settings-grid ${styles.document}`}>
          <ContinuityEditor
            plan={draft}
            resetVersion={resetVersion}
            strings={strings}
            characters={characters}
            consistencyReport={consistencyReport}
            onChange={updateDraft}
          />
        </main>
      </div>

      <footer className={`settings-save-bar ${styles.saveBar}`}>
        <span aria-live="polite" role={statusMessage ? "status" : undefined}>{statusMessage}</span>
        {error ? <p role="alert">{error}</p> : null}
        <button className="primary-button async-action" type="button" disabled={savePending || !dirty} onClick={() => void save()}>
          {savePending ? pageStrings.saving : pageStrings.save}
        </button>
      </footer>
    </section>
  );
}
