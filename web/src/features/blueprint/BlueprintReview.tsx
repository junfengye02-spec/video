import { ArrowLeft, Check, FileText, ListTree, MessageCircle } from "lucide-react";
import { useRef, useState } from "react";
import type { PlanSectionId } from "../../domain/types";
import { Button, Tabs } from "../../shared/ui";
import { blueprintCopy as copy } from "./copy";
import { useBlueprintReview, type BlueprintReviewOptions } from "./useBlueprintReview";
import { BlueprintCommandBar } from "./components/BlueprintCommandBar";
import { BlueprintDirectory } from "./components/BlueprintDirectory";
import { BlueprintDocument } from "./components/BlueprintDocument";
import { BlueprintFeedbackDrawer } from "./components/BlueprintFeedbackDrawer";
import { BlueprintFinalDialog } from "./components/BlueprintFinalDialog";
import { EndFrameTaskStatus } from "./components/EndFrameTaskStatus";
import styles from "./BlueprintWorkspace.module.css";

type MobilePane = "categories" | "document";

export function BlueprintReview(options: BlueprintReviewOptions) {
  const review = useBlueprintReview(options);
  const [mobilePane, setMobilePane] = useState<MobilePane>("document");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollPositionsRef = useRef<Partial<Record<PlanSectionId, number>>>({});
  const feedbackOpenerRef = useRef<HTMLButtonElement>(null);
  const finalOpenerRef = useRef<HTMLButtonElement>(null);

  function selectSection(section: PlanSectionId) {
    if (section === review.activeSection) {
      setMobilePane("document");
      return;
    }
    scrollPositionsRef.current[review.activeSection] = scrollRef.current?.scrollTop ?? 0;
    review.selectSection(section);
    setMobilePane("document");
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollPositionsRef.current[section] ?? 0;
    });
  }

  return (
    <section className={styles.page} aria-labelledby="plan-review-title" data-mobile-pane={mobilePane}>
      <header className={styles.pageHeading}>
        <div>
          <span>02 / 04 · BLUEPRINT</span>
          <h1 id="plan-review-title">{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
        <div className={styles.headingActions}>
          {options.revisionMode && options.onCancelRevision ? (
            <Button
              type="button"
              variant="secondary"
              icon={<ArrowLeft size={15} />}
              loading={review.cancelingRevision}
              disabled={review.interactionPending}
              onClick={() => void review.cancelRevision()}
            >
              取消修订并返回分镜
            </Button>
          ) : null}
          <div className={styles.progress} aria-label={`${review.approvedCount} / 6 已确认`}>
            <strong>{review.approvedCount} / 6</strong>
            <span>已确认</span>
            <div><i style={{ width: `${review.approvedCount / 6 * 100}%` }} /></div>
          </div>
        </div>
      </header>

      <div className={styles.mobileTabs}>
        <Tabs
          ariaLabel="蓝图视图"
          value={mobilePane}
          onValueChange={setMobilePane}
          items={[
            { value: "categories", label: <><ListTree aria-hidden="true" size={15} />{copy.categories}</> },
            { value: "document", label: <><FileText aria-hidden="true" size={15} />{copy.document}</> },
          ]}
        />
      </div>

      <div className={styles.workspace}>
        <BlueprintDirectory
          active={mobilePane === "categories"}
          activeSection={review.activeSection}
          documents={review.documents}
          sections={review.sections}
          onSelect={selectSection}
        />

        <section className={styles.documentPane} aria-label={`${review.document.title}文档`} data-mobile-active={mobilePane === "document"}>
          <header className={styles.documentToolbar}>
            <div className={styles.documentIdentity}>
              <span data-status={review.approval.status} />
              <strong>{review.document.title}</strong>
              <small>{review.approval.status === "approved" ? "已确认" : review.approval.status === "changes_requested" ? "修改中" : "待确认"}</small>
            </div>
            <EndFrameTaskStatus
              enabled={options.snapshot.creative_workflow?.control_end_frames === true}
              onListTasks={options.onListTasks}
              onRetryTaskItem={options.onRetryTaskItem}
              taskEvents={options.taskEvents}
            />
            <div className={styles.documentActions}>
              <Button
                ref={feedbackOpenerRef}
                type="button"
                variant="secondary"
                icon={<MessageCircle size={15} />}
                disabled={review.interactionPending}
                onClick={() => review.setFeedbackOpen(true)}
              >
                {copy.requestChanges}
              </Button>
              <Button
                type="button"
                variant="secondary"
                icon={<Check size={15} />}
                loading={review.sectionApproving}
                disabled={review.interactionPending || review.approval.status === "approved"}
                onClick={() => void review.confirmSection()}
              >
                {review.sectionApproving ? copy.approvingSection : review.approval.status === "approved" ? copy.approvedSection : copy.approveSection}
              </Button>
            </div>
          </header>

          <div ref={scrollRef} className={styles.documentScroll}>
            <BlueprintDocument document={review.document} approval={review.approval} />
          </div>

          <BlueprintCommandBar
            allApproved={review.allApproved}
            error={review.error}
            interactionPending={review.interactionPending || review.finalSubmitting}
            missingCount={review.missingCount}
            notice={review.notice}
            openerRef={finalOpenerRef}
            onOpenConfirm={() => review.setFinalConfirmOpen(true)}
          />
        </section>
      </div>

      <BlueprintFeedbackDrawer
        commandError={review.error}
        draft={review.activeDraft}
        impactLabels={review.impactLabels}
        loading={review.sectionRevising}
        onChange={review.setDraft}
        onClose={() => review.setFeedbackOpen(false)}
        onSubmit={() => void review.requestChanges()}
        open={review.feedbackOpen}
        openerRef={feedbackOpenerRef}
        section={review.activeSection}
        validationError={review.feedbackError}
      />
      <BlueprintFinalDialog
        error={review.error}
        loading={review.approving || review.finalSubmitting}
        onClose={() => review.setFinalConfirmOpen(false)}
        onConfirm={() => void review.approveFinal()}
        open={review.finalConfirmOpen}
        openerRef={finalOpenerRef}
      />
    </section>
  );
}
