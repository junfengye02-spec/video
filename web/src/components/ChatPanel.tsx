import { Clapperboard, Send } from "lucide-react";

interface ChatPanelProps {
  creating: boolean;
  prompt: string;
  title: string;
  onCreateStoryboard: () => void;
  onPromptChange: (value: string) => void;
  onTitleChange: (value: string) => void;
}

export function ChatPanel({
  creating,
  prompt,
  title,
  onCreateStoryboard,
  onPromptChange,
  onTitleChange,
}: ChatPanelProps) {
  return (
    <section className="chat-panel" aria-label="Production assistant">
      <div className="section-heading">
        <Clapperboard aria-hidden="true" size={18} />
        <h2>Production Assistant</h2>
      </div>
      <div className="prompt-grid">
        <label>
          <span>Project Title</span>
          <input
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="Rain Alley"
          />
        </label>
        <label className="prompt-field">
          <span>Short Drama Prompt</span>
          <textarea
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            rows={5}
          />
        </label>
      </div>
      <div className="chat-actions">
        <button
          className="primary-button"
          type="button"
          disabled={creating}
          onClick={onCreateStoryboard}
        >
          <Send aria-hidden="true" size={16} />
          {creating ? "Creating" : "Create storyboard"}
        </button>
      </div>
    </section>
  );
}
