import { ArrowLeft, Settings2, Sparkles } from "lucide-react";
import { useState, type FormEvent } from "react";
import { projectRoutes } from "../app/routes";
import type { CreateProjectInput } from "../app/workbench/types";
import type { ProjectType, ShortDramaProjectResponse } from "../domain/types";
import { getStrings } from "../i18n";

export interface NewProjectPageProps {
  providerReady: boolean;
  onOpenProvider?: () => void;
  onCreate: (input: CreateProjectInput) => Promise<ShortDramaProjectResponse>;
  onCreated: (projectId: string, shotCount: number) => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function NewProjectPage({
  providerReady,
  onOpenProvider,
  onCreate,
  onCreated,
}: NewProjectPageProps) {
  const uiStrings = getStrings("zh");
  const strings = uiStrings.newProjectPage;
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [projectType, setProjectType] = useState<ProjectType>("single_video");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      setError(uiStrings.errors.createStoryboardRequiresPrompt);
      return;
    }
    setCreating(true);
    setError(null);

    try {
      const input: CreateProjectInput = {
        title: title.trim() || "未命名项目",
        prompt: normalizedPrompt,
        project_type: projectType,
      };
      const result = await onCreate(input);
      onCreated(result.project.id, result.storyboard.shots.length);
    } catch (requestError) {
      setError(errorMessage(requestError, strings.createError));
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="new-project-page" aria-labelledby="new-project-title">
      <div className="page-heading">
        <a href={projectRoutes.list}>
          <ArrowLeft aria-hidden="true" size={16} />
          {strings.backToProjects}
        </a>
        <h1 id="new-project-title">{strings.title}</h1>
      </div>

      <form className="new-project-form" onSubmit={handleSubmit}>
        <label>
          <span>{strings.projectTitleLabel}</span>
          <input
            type="text"
            value={title}
            placeholder={strings.projectTitlePlaceholder}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label>
          <span>{strings.projectTypeLabel}</span>
          <select
            value={projectType}
            onChange={(event) => setProjectType(event.target.value as ProjectType)}
          >
            <option value="single_video">{strings.singleVideo}</option>
            <option value="mini_series">{strings.miniSeries}</option>
            <option value="long_series">{strings.longSeries}</option>
          </select>
        </label>

        <label>
          <span>{strings.promptLabel}</span>
          <textarea
            rows={8}
            value={prompt}
            placeholder={strings.promptPlaceholder}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>

        {error ? <p role="alert">{error}</p> : null}

        {!providerReady ? (
          <button type="button" onClick={onOpenProvider} disabled={!onOpenProvider || creating}>
            <Settings2 aria-hidden="true" size={16} />
            {strings.openProvider}
          </button>
        ) : null}

        <button className="async-action" type="submit" disabled={!providerReady || creating}>
          <Sparkles aria-hidden="true" size={16} />
          {creating ? strings.creatingAction : strings.createAction}
        </button>
      </form>
    </section>
  );
}
