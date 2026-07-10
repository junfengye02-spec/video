export const projectRoutes = {
  list: "/projects",
  create: "/projects/new",
  storyboard: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/storyboard`,
  settings: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/settings`,
  resources: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/resources`,
  production: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/production`,
} as const;
