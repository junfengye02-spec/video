import { FileText, MessageCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { CreativeBriefCanvas } from "../features/inspiration/components/CreativeBriefCanvas";
import { InspirationConversation } from "../features/inspiration/components/InspirationConversation";
import { inspirationCopy as copy } from "../features/inspiration/copy";
import { creativeBriefToPrompt, suggestionsFor } from "../features/inspiration/model";
import { useInspirationController } from "../features/inspiration/useInspirationController";
import type {
  CreativeBrief,
  CreativeWorkflow,
  InspirationMessage,
  ProjectType,
} from "../domain/types";
import { Tabs } from "../shared/ui";
import styles from "../features/inspiration/InspirationPage.module.css";

type MobileView = "conversation" | "brief";

export { creativeBriefToPrompt };

export interface InspirationPageProps {
  workflow: CreativeWorkflow;
  projectType?: ProjectType;
  initialMessage?: string;
  initialTextModel?: string;
  sessionKey?: string;
  developing: boolean;
  planning: boolean;
  onDevelop: (messages: InspirationMessage[], textModel: string) => Promise<void>;
  onInitialMessageConsumed?: () => void;
  onPlan: (brief: CreativeBrief, controlEndFrames: boolean, textModel: string) => Promise<void>;
  onUpdateEndFrameIntent?: (enabled: boolean) => Promise<void>;
  onSessionExpired?: () => void;
  walletAvailableUnits?: number | null;
}

export function InspirationPage({
  workflow,
  projectType = "single_video",
  initialMessage = "",
  initialTextModel = "gpt-5.5",
  sessionKey = "default",
  developing,
  planning,
  onDevelop,
  onInitialMessageConsumed,
  onPlan,
  onUpdateEndFrameIntent = async () => undefined,
  onSessionExpired,
  walletAvailableUnits = null,
}: InspirationPageProps) {
  const [activeMobileView, setActiveMobileView] = useState<MobileView>("conversation");
  const controller = useInspirationController({
    workflow,
    initialMessage,
    initialTextModel,
    sessionKey,
    developing,
    planning,
    onDevelop,
    onInitialMessageConsumed,
    onPlan,
    onUpdateEndFrameIntent,
    onSessionExpired,
    walletAvailableUnits,
  });
  const suggestions = useMemo(
    () => suggestionsFor(workflow.brief, projectType),
    [projectType, workflow.brief],
  );

  return (
    <section className={styles.page} aria-labelledby="inspiration-title">
      <h1 id="inspiration-title" className="sr-only">{copy.title}</h1>

      <div className={styles.mobileTabs}>
        <Tabs
          ariaLabel={copy.title}
          value={activeMobileView}
          onValueChange={setActiveMobileView}
          items={[
            { value: "conversation", label: <><MessageCircle aria-hidden="true" size={16} />{copy.conversation}</> },
            { value: "brief", label: <><FileText aria-hidden="true" size={16} />{copy.brief}</> },
          ]}
        />
      </div>

      <div className={styles.workspace}>
        <InspirationConversation
          active={activeMobileView === "conversation"}
          developing={controller.developingLocked}
          disabled={controller.planningLocked}
          error={controller.errorOrigin === "develop" ? controller.error : null}
          message={controller.message}
          messages={controller.visibleMessages}
          onMessageChange={controller.setMessage}
          onTextModelChange={controller.setTextModel}
          onSubmit={(event) => void controller.submitMessage(event)}
          suggestions={suggestions}
          textModel={controller.textModel}
        />
        <CreativeBriefCanvas
          active={activeMobileView === "brief"}
          brief={workflow.brief}
          controlEndFrames={controller.controlEndFrames}
          projectType={projectType}
          developing={controller.developingLocked}
          error={controller.errorOrigin === "plan" ? controller.error : null}
          intentSaving={controller.intentSaving}
          onConfirm={() => void controller.submitPlan()}
          onControlEndFramesChange={(enabled) => void controller.setControlEndFrames(enabled)}
          planning={controller.planningLocked}
          planSubmitted={controller.planSubmitted}
          ready={workflow.ready_to_confirm}
        />
      </div>
    </section>
  );
}
