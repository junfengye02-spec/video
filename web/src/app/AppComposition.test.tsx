import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import type { ShortDramaProjectResponse } from "../domain/types";
import { getStrings } from "../i18n";
import { createProjectResponse } from "../test/fixtures";

const apiMocks = vi.hoisted(() => ({
  authRequest: vi.fn(),
  createDraftProject: vi.fn(),
  createShortDramaProject: vi.fn(),
  loadLatestProject: vi.fn(),
  loadProject: vi.fn(),
  mediaUrl: vi.fn((path: string | null | undefined, projectId?: string | null) => {
    if (!path) return null;
    return path.startsWith("/api/") || !projectId
      ? path
      : `/api/projects/${projectId}/media/${path}`;
  }),
  optimizePrompt: vi.fn(),
  regenerateShot: vi.fn(),
  renderProject: vi.fn(),
  saveContinuityPlan: vi.fn(),
  saveShot: vi.fn(),
  subscribeProjectEvents: vi.fn(),
  uploadReferenceImage: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  value: {
    user: { id: "user-1", email: "user@example.com", role: "user" } as null | {
      id: string;
      email: string;
      role: "user" | "admin";
    },
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    sendVerification: vi.fn(),
    requestPasswordReset: vi.fn(),
    resetPassword: vi.fn(),
  },
}));

const billingMocks = vi.hoisted(() => ({
  value: {
    wallet: { balance_units: 1000, held_units: 0, available_units: 1000 },
    loading: false,
    error: null,
    refreshWallet: vi.fn(),
  },
}));

const localProjectStoreMocks = vi.hoisted(() => ({
  deleteProject: vi.fn(),
  listProjectSummaries: vi.fn(),
  loadProjectSnapshot: vi.fn(),
  loadRecentProjectSnapshot: vi.fn(),
  saveProjectSnapshot: vi.fn(),
  saveProjectSnapshotIfVersion: vi.fn(),
  setRecentProjectId: vi.fn(),
}));

const localMediaStoreMocks = vi.hoisted(() => ({
  cacheRemoteMedia: vi.fn(),
  findCommittedMedia: vi.fn(),
  loadMediaBlob: vi.fn(),
  saveMediaBlob: vi.fn(),
  startMediaRecoveryController: vi.fn(),
}));

const localExportMocks = vi.hoisted(() => ({
  exportProjectBackup: vi.fn(),
  importProjectBackup: vi.fn(),
  importProjectBackupDirectory: vi.fn(),
  prepareProjectBackupDirectoryImport: vi.fn(),
  prepareProjectBackupImport: vi.fn(),
}));

const localStorageEstimateMocks = vi.hoisted(() => ({
  formatBytes: vi.fn((bytes: number | null) => (bytes === null ? "Unknown" : `${bytes} B`)),
  getStorageEstimate: vi.fn(),
}));

const localMediaUrlMocks = vi.hoisted(() => ({
  resolveLocalMediaUrl: vi.fn(),
  revokeLocalMediaUrls: vi.fn(),
}));

vi.mock("../api/client", () => apiMocks);
vi.mock("../features/generation/GenerationService", () => ({
  generationService: {
    optimize: vi.fn((projectId: string, shotId: string, sourceText: string) => (
      apiMocks.optimizePrompt(projectId, {
        target: "shot",
        target_id: shotId,
        source_text: sourceText,
        mode: "shot_json",
      })
    )),
    saveShot: vi.fn((projectId: string, shotId: string, payload: unknown) => (
      apiMocks.saveShot(projectId, shotId, payload)
    )),
    regenerate: vi.fn((projectId: string, shotId: string) => (
      apiMocks.regenerateShot(projectId, shotId, {})
    )),
    render: vi.fn((projectId: string) => (
      apiMocks.renderProject(projectId, { render_runtime: "ffmpeg" })
    )),
    subscribe: vi.fn((projectId: string, onEvent: (event: unknown) => void) => (
      apiMocks.subscribeProjectEvents(projectId, onEvent)
    )),
  },
}));
vi.mock("../auth/AuthProvider", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMocks.value,
}));
vi.mock("../billing/BillingProvider", () => ({
  BillingProvider: ({ children }: { children: ReactNode }) => children,
  useBilling: () => billingMocks.value,
}));
vi.mock("../localdb/projectStore", () => localProjectStoreMocks);
vi.mock("../localdb/mediaStore", () => localMediaStoreMocks);
vi.mock("../localdb/mediaUrls", () => localMediaUrlMocks);
vi.mock("../localdb/exportProject", () => localExportMocks);
vi.mock("../localdb/storageEstimate", () => localStorageEstimateMocks);

const zh = getStrings("zh");

const routeMatrix = [
  { path: "/login", label: "Sign in", access: "public", kind: "heading" },
  { path: "/register", label: "Create account", access: "public", kind: "heading" },
  { path: "/projects", label: zh.projectsPage.title, access: "authenticated", kind: "heading" },
  { path: "/projects/p1/storyboard", label: zh.storyboardPage.shotListLabel, access: "authenticated", kind: "text" },
  { path: "/projects/p1/settings", label: zh.globalSettings.title, access: "authenticated", kind: "heading" },
  { path: "/projects/p1/resources", label: zh.resources.title, access: "authenticated", kind: "heading" },
  { path: "/projects/p1/production", label: zh.production.pageLabel, access: "authenticated", kind: "label" },
  { path: "/wallet", label: zh.billing.walletTitle, access: "authenticated", kind: "heading" },
  { path: "/orders", label: zh.billing.ordersTitle, access: "authenticated", kind: "heading" },
] as const;

function projectSnapshot(): ShortDramaProjectResponse {
  const snapshot = createProjectResponse();
  snapshot.project = { ...snapshot.project, id: "p1", title: "Rain Alley" };
  return snapshot;
}

function renderAt(path: string) {
  window.history.replaceState({}, "", path);
  return render(<App />);
}

async function expectRouteLabel(route: (typeof routeMatrix)[number]) {
  if (route.kind === "heading") {
    expect(await screen.findByRole("heading", { name: route.label })).toBeInTheDocument();
  } else if (route.kind === "label") {
    expect(await screen.findByLabelText(route.label)).toBeInTheDocument();
  } else {
    expect((await screen.findAllByText(route.label)).length).toBeGreaterThan(0);
  }
}

describe("App composition contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window.navigator, "language", {
      configurable: true,
      value: "zh-CN",
    });
    authMocks.value = {
      user: { id: "user-1", email: "user@example.com", role: "user" },
      loading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      sendVerification: vi.fn(),
      requestPasswordReset: vi.fn(),
      resetPassword: vi.fn(),
    };
    billingMocks.value = {
      wallet: { balance_units: 1000, held_units: 0, available_units: 1000 },
      loading: false,
      error: null,
      refreshWallet: vi.fn(),
    };
    apiMocks.authRequest.mockResolvedValue(undefined);
    apiMocks.createShortDramaProject.mockResolvedValue(projectSnapshot());
    apiMocks.loadProject.mockResolvedValue(projectSnapshot());
    apiMocks.subscribeProjectEvents.mockReturnValue(vi.fn());
    localProjectStoreMocks.listProjectSummaries.mockResolvedValue([]);
    localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
      id: "p1",
      title: "Rain Alley",
      updatedAt: "2026-07-11T08:00:00Z",
      snapshot: projectSnapshot(),
    });
    localProjectStoreMocks.loadRecentProjectSnapshot.mockResolvedValue(null);
    localProjectStoreMocks.saveProjectSnapshot.mockImplementation((next: ShortDramaProjectResponse) => Promise.resolve({
      id: next.project.id,
      title: next.project.title,
      updatedAt: "2026-07-11T08:00:00Z",
      snapshot: structuredClone(next),
    }));
    localProjectStoreMocks.saveProjectSnapshotIfVersion.mockResolvedValue(null);
    localProjectStoreMocks.setRecentProjectId.mockResolvedValue(undefined);
    localStorageEstimateMocks.getStorageEstimate.mockResolvedValue({
      usageBytes: 0,
      quotaBytes: 0,
      persisted: false,
    });
    localMediaStoreMocks.cacheRemoteMedia.mockResolvedValue(null);
    localMediaStoreMocks.findCommittedMedia.mockResolvedValue(null);
    localMediaStoreMocks.startMediaRecoveryController.mockReturnValue({
      dispose: vi.fn(),
      run: vi.fn().mockResolvedValue(0),
    });
    localMediaUrlMocks.resolveLocalMediaUrl.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it.each(routeMatrix)("renders the route matrix entry $path", async (route) => {
    if (route.access === "public") {
      authMocks.value = { ...authMocks.value, user: null };
    }

    renderAt(route.path);

    await expectRouteLabel(route);
  });

  it.each(routeMatrix.filter((route) => route.access === "public"))(
    "does not bootstrap the workbench for public route $path",
    async (route) => {
      authMocks.value = { ...authMocks.value, user: null };

      renderAt(route.path);

      await expectRouteLabel(route);
      expect(localMediaStoreMocks.startMediaRecoveryController).not.toHaveBeenCalled();
      expect(localProjectStoreMocks.loadProjectSnapshot).not.toHaveBeenCalled();
      expect(localProjectStoreMocks.listProjectSummaries).not.toHaveBeenCalled();
    },
  );

  it.each(routeMatrix.filter((route) => route.access === "authenticated"))(
    "preserves the return URL for protected deep link $path",
    async (route) => {
      authMocks.value = { ...authMocks.value, user: null };

      renderAt(route.path);

      expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
      expect(window.location.pathname).toBe("/login");
      const from = window.history.state?.usr?.from as {
        hash?: string;
        pathname?: string;
        search?: string;
      } | undefined;
      expect(`${from?.pathname ?? ""}${from?.search ?? ""}${from?.hash ?? ""}`)
        .toBe(route.path);
      expect(localMediaStoreMocks.startMediaRecoveryController).not.toHaveBeenCalled();
    },
  );

  it("keeps account and billing routes independent from project load failures", async () => {
    localProjectStoreMocks.loadProjectSnapshot.mockRejectedValue(new Error("project cache unavailable"));

    authMocks.value = { ...authMocks.value, user: null };
    const login = renderAt("/login");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    login.unmount();

    authMocks.value = {
      ...authMocks.value,
      user: { id: "user-1", email: "user@example.com", role: "user" },
    };
    renderAt("/wallet");
    expect(await screen.findByRole("heading", { name: zh.billing.walletTitle })).toBeInTheDocument();
    await waitFor(() => expect(localProjectStoreMocks.loadProjectSnapshot).not.toHaveBeenCalled());
  });
});
