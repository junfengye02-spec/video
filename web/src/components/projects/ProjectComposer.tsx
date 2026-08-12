import { ArrowUp, Film, Megaphone, Settings2, Sparkles } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type {
  DraftProjectRequest,
  ProjectType,
  ShortDramaProjectResponse,
} from "../../domain/types";
import { GenerationModelPicker } from "../../features/generation/GenerationModelPicker";
import { getStrings } from "../../i18n";
import {
  CommandErrorNotice,
  commandErrorFrom,
  type CommandError,
} from "../feedback/DomainErrorBoundary";
import { Button, Popover, SelectMenu, Surface, Tabs, type TabItem } from "../../shared/ui";
import styles from "./ProjectComposer.module.css";

type VideoMode = "brand" | "concept" | "story";
const textModelLabel = "\u7075\u611f\u6587\u672c\u6a21\u578b";

const copy = {
  formLabel: "开始新作品",
  composerLabel: "你想做一支什么样的视频？",
  composerPlaceholder: "描述一个故事、一个画面，或者一种想让观众记住的感觉……",
  modeLabel: "视频模式",
  modes: {
    story: "故事短片",
    brand: "品牌叙事",
    concept: "概念预告",
  } satisfies Record<VideoMode, string>,
  ratioLabel: "画幅",
  startAction: "开始聊灵感",
  startingAction: "正在准备创作空间...",
};

const modeIcons = {
  story: <Film size={15} />,
  brand: <Megaphone size={15} />,
  concept: <Sparkles size={15} />,
} satisfies Record<VideoMode, ReactNode>;

const modeTabs = (Object.keys(copy.modes) as VideoMode[]).map((value) => ({
  value,
  label: (
    <span className={styles.tabLabel}>
      <span aria-hidden="true">{modeIcons[value]}</span>
      {copy.modes[value]}
    </span>
  ),
})) satisfies TabItem<VideoMode>[];

export interface ProjectComposerProps {
  onCreateDraft: (input: DraftProjectRequest) => Promise<ShortDramaProjectResponse>;
  onStarted: (projectId: string, initialMessage: string, textModel: string) => void;
  onSessionExpired?: () => void;
  walletAvailableUnits?: number | null;
  autoFocus?: boolean;
}

export function buildInitialIdea(
  message: string,
  mode: VideoMode,
  aspectRatio: string,
): string {
  return [
    message.trim(),
    `创作偏好：${copy.modes[mode]}，${aspectRatio} 画幅。`,
  ].join("\n\n");
}

export function ProjectComposer({
  autoFocus = false,
  onCreateDraft,
  onSessionExpired,
  onStarted,
  walletAvailableUnits = null,
}: ProjectComposerProps) {
  const strings = getStrings("zh").newProjectPage;
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [projectType, setProjectType] = useState<ProjectType>("single_video");
  const [mode, setMode] = useState<VideoMode>("story");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [textModel, setTextModel] = useState("gpt-5.5");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<CommandError | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    if (!message.trim()) {
      setError({ kind: "message", message: getStrings("zh").errors.createStoryboardRequiresPrompt });
      return;
    }

    const initialMessage = buildInitialIdea(message, mode, aspectRatio);
    setCreating(true);
    setError(null);
    try {
      const result = await onCreateDraft({
        title: title.trim() || strings.projectTitlePlaceholder,
        title_source: title.trim() ? "user" : "placeholder",
        project_type: projectType,
        prompt: initialMessage,
      });
      onStarted(result.project.id, initialMessage, textModel.trim());
    } catch (requestError) {
      setError(commandErrorFrom(requestError, {
        fallback: strings.createDraftError,
        onSessionExpired,
        walletAvailableUnits,
      }));
    } finally {
      setCreating(false);
    }
  }

  return (
    <form
      className={styles.form}
      aria-label={copy.formLabel}
      onSubmit={(event) => void handleSubmit(event)}
    >
      <Surface className={styles.surface} tone="raised">
        <label className={styles.message}>
          <span className="sr-only">{copy.composerLabel}</span>
          <textarea
            autoFocus={autoFocus}
            rows={4}
            value={message}
            placeholder={copy.composerPlaceholder}
            disabled={creating}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>

        <div className={styles.controls}>
          <div className={styles.modeTabs}>
            <Tabs
              ariaLabel={copy.modeLabel}
              items={modeTabs.map((item) => ({ ...item, disabled: creating }))}
              value={mode}
              onValueChange={setMode}
            />
          </div>

          <div className={styles.modelPicker}>
            <GenerationModelPicker
              capability="text"
              compact
              disabled={creating}
              label={textModelLabel}
              required
              strings={getStrings("zh").modelCatalog}
              value={textModel}
              onChange={setTextModel}
            />
          </div>

          <Popover
            label="创作设置"
            trigger={(triggerProps) => (
              <Button
                {...triggerProps}
                className={styles.settingsButton}
                type="button"
                variant="ghost"
                icon={<Settings2 size={16} />}
                disabled={creating}
              >
                创作设置
              </Button>
            )}
          >
            <div className={styles.options}>
              <SelectMenu
                disabled={creating}
                label={copy.ratioLabel}
                value={aspectRatio}
                onValueChange={setAspectRatio}
                options={[
                  { value: "16:9", label: "16:9" },
                  { value: "9:16", label: "9:16" },
                  { value: "1:1", label: "1:1" },
                  { value: "4:3", label: "4:3" },
                ]}
              />
              <SelectMenu
                disabled={creating}
                label={strings.projectTypeLabel}
                value={projectType}
                onValueChange={setProjectType}
                options={[
                  { value: "single_video", label: strings.singleVideo },
                  { value: "mini_series", label: strings.miniSeries },
                  { value: "long_series", label: strings.longSeries },
                ]}
              />
              <label className={styles.title}>
                <span>{strings.projectTitleLabel}</span>
                <input
                  type="text"
                  value={title}
                  placeholder={strings.projectTitlePlaceholder}
                  disabled={creating}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
            </div>
          </Popover>

          <Button
            className={styles.submit}
            type="submit"
            variant="primary"
            icon={<ArrowUp size={16} />}
            loading={creating}
          >
            {creating ? copy.startingAction : copy.startAction}
          </Button>
        </div>
      </Surface>
      <div className={styles.error}>
        <CommandErrorNotice error={error} />
      </div>
    </form>
  );
}
