import type { ProjectType, ShortDramaProjectRequest } from "../../domain/types";

export type CreateProjectInput = Pick<
  ShortDramaProjectRequest,
  "title" | "prompt"
> & { project_type: ProjectType };
