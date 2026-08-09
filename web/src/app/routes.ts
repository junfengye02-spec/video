export const projectRoutes = {
  list: "/projects",
  create: "/projects/new",
  wallet: "/wallet",
  orders: "/orders",
  adminBilling: "/admin/billing",
  adminVideoModels: "/admin/video-models",
  idea: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/idea`,
  planReview: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/plan-review`,
  storyboard: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/storyboard`,
  storyboardRevision: (projectId: string) => (
    `/projects/${encodeURIComponent(projectId)}/storyboard/revision`
  ),
  settings: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/settings`,
  resources: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/resources`,
  production: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/production`,
} as const;
