import { ArrowLeft, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { projectRoutes } from "../app/routes";
import {
  ProjectComposer,
  type ProjectComposerProps,
} from "../components/projects/ProjectComposer";
import { getStrings } from "../i18n";

const introCopy = {
  eyebrow: "灵感起点",
  heading: "先把想法聊清楚",
  body: "让想法入镜",
};

export type NewProjectPageProps = ProjectComposerProps;

export function NewProjectPage(props: NewProjectPageProps) {
  const strings = getStrings("zh").newProjectPage;
  return (
    <section className="new-project-page inspiration-start" aria-labelledby="new-project-title">
      <div className="page-heading">
        <div>
          <Link to={projectRoutes.list}>
            <ArrowLeft aria-hidden="true" size={16} />
            {strings.backToProjects}
          </Link>
          <p className="inspiration-eyebrow">
            <Sparkles aria-hidden="true" size={14} />
            {introCopy.eyebrow}
          </p>
          <h1 id="new-project-title">{introCopy.heading}</h1>
          <p>{introCopy.body}</p>
        </div>
      </div>
      <ProjectComposer {...props} />
    </section>
  );
}
