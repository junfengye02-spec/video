import { Clapperboard, Send } from "lucide-react";
import type { UIStrings } from "../i18n";

interface ChatPanelProps {
  creating: boolean;
  prompt: string;
  strings: UIStrings["chatPanel"];
  title: string;
  onCreateStoryboard: () => void;
  onPromptChange: (value: string) => void;
  onTitleChange: (value: string) => void;
}

export function ChatPanel({
  creating,
  prompt,
  strings,
  title,
  onCreateStoryboard,
  onPromptChange,
  onTitleChange,
}: ChatPanelProps) {
  return (
    <section className="chat-panel" aria-label={strings.regionLabel}>
      <div className="section-heading">
        <Clapperboard aria-hidden="true" size={18} />
        <h2>{strings.title}</h2>
      </div>
      <div className="prompt-grid">
        <label>
          <span>{strings.projectTitleLabel}</span>
          <input
            aria-label={strings.projectTitleLabel}
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
          />
        </label>
        <label className="prompt-field">
          <span>{strings.promptLabel}</span>
          <textarea
            aria-label={strings.promptLabel}
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            rows={5}
          />
        </label>
      </div>
      <div className="chat-actions">
        <button
          className="primary-button async-action"
          type="button"
          disabled={creating}
          onClick={onCreateStoryboard}
        >
          <Send aria-hidden="true" size={16} />
          {creating ? strings.creatingStoryboardAction : strings.createStoryboardAction}
        </button>
      </div>
    </section>
  );
}
