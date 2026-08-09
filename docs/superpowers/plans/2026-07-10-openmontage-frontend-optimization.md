# OpenMontage Workbench Frontend Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有单页 OpenMontage 前端改造成方案 C 的多页面中文创作工作台，同时完整保留浏览器本地项目、AI 分镜、提示词优化、资源绑定和制作成片能力。

**Architecture:** 使用 `react-router-dom` 建立项目列表、创建项目和四个项目内页面的真实路由；把当前 `App.tsx` 中的共享业务状态与 API 操作迁入 `WorkbenchProvider`，各页面通过窄接口消费。先以纯组件和纯状态函数建立可测试的页面单元，最后接入路由和共享状态，避免在拆分期间改变后端协议或本地存储格式。

**Tech Stack:** React 18、TypeScript 5.6、Vite 5、Vitest、Testing Library、React Router 6、Lucide、IndexedDB/OPFS、本地 CSS。

## Global Constraints

- 本轮只优化工作台；不实现登录、注册、账号中心、钱包、余额、充值套餐、订阅或支付接口。
- 顶部保留 `充值`，点击只显示 `功能开发中`，不得创建充值或钱包路由。
- 顶部保留紧凑的 `接口配置` 抽屉，继续承载现有网关、文本/图片/视频 Key 和模型字段。
- 不实现模板库、模板选择、风格市场、团队协作、数据分析或复杂应用设置页。
- 创建项目时不得发送 `shot_count`；由现有后端 AI 返回实际分镜数和每个分镜的初始提示词。
- 每个分镜必须有 `AI 优化提示词`；优化结果只进入未保存草稿，不得自动保存或自动重新生成视频。
- 资源类型严格限制为 `character`、`scene`、`prop`；资源详情检查器和上传抽屉必须互斥。
- 全局设定只影响后续优化和生成，不自动改写或重新生成已完成分镜。
- 保留现有浏览器本地项目、媒体缓存、导入导出和最终视频下载行为。
- 不修改现有后端接口协议，不要求新增服务端字段。
- 使用中文产品文案；视觉采用白色/冷灰表面、深色正文、蓝色主操作、青绿色状态，圆角不得超过 `8px`。
- 不使用紫色渐变、装饰光球、嵌套卡片、营销式首屏或完整非线性剪辑器视觉。
- 尊重当前脏工作区；每个任务只暂存该任务明确列出的文件，不回退其他改动。

---

## Scope Check

本规格包含一个共享状态层和六个前端页面，它们都属于同一个浏览器本地项目工作流，不能独立发布为互不关联的子产品。因此使用一份计划，但以页面纵向切片分任务：每个任务先交付可单测的页面或组件，路由接线集中在 Task 8。登录与钱包保留为后续独立计划。

## File Structure

- `web/src/App.tsx`
  最终只负责挂载 `BrowserRouter`、`WorkbenchProvider` 和 `AppRoutes`。

- `web/src/app/AppRoutes.tsx`
  定义完整路由表、根布局、项目布局和不存在项目的状态。

- `web/src/app/routes.ts`
  集中定义项目 URL 生成函数，避免页面手写路径。

- `web/src/app/workbench/WorkbenchProvider.tsx`
  拥有项目快照、接口配置、作业事件、媒体 URL、忙碌态和现有 API 操作。

- `web/src/app/workbench/types.ts`
  定义 `WorkbenchContextValue`、`WorkbenchBusyState`、`CreateProjectInput` 等页面契约。

- `web/src/app/workbench/snapshot.ts`
  放置空连续性计划、快照合成和分镜替换等纯函数。

- `web/src/app/workbench/useWorkbench.ts`
  提供带 Provider 检查的 `useWorkbench()`。

- `web/src/components/shell/AppShell.tsx`
  顶栏、项目侧栏、面包屑、充值入口、接口配置入口和主内容框架。

- `web/src/components/shell/ProviderDrawer.tsx`
  在互斥抽屉中承载现有 `KeyGate`。

- `web/src/components/feedback/ToastRegion.tsx`
  提供短暂成功反馈和 `功能开发中` 状态播报。

- `web/src/pages/ProjectsPage.tsx`
  浏览器本地项目列表、打开、导出、导入和删除。

- `web/src/pages/NewProjectPage.tsx`
  标题、项目类型、总提示词和 AI 建立分镜提交界面。

- `web/src/pages/StoryboardPage.tsx`
  组合分镜列表、中央预览、只读顺序条和右侧分镜检查器。

- `web/src/components/storyboard/shotDraft.ts`
  维护分镜已保存基线、当前草稿和单次 AI 优化撤销状态。

- `web/src/components/storyboard/ShotList.tsx`
  左侧可滚动分镜列表。

- `web/src/components/storyboard/ShotPreview.tsx`
  当前分镜视频或无视频状态。

- `web/src/components/storyboard/ShotOrderStrip.tsx`
  只读分镜顺序和选择，不实现拖拽或剪辑。

- `web/src/components/ShotEditor.tsx`
  重构为当前分镜检查器，严格分离 AI 优化、保存和重新生成。

- `web/src/pages/GlobalSettingsPage.tsx`
  项目级连续性页面和项目类型裁剪。

- `web/src/components/continuity/ContinuityEditor.tsx`
  从 `App.tsx` 抽出连续性字段编辑器。

- `web/src/pages/ResourceLibraryPage.tsx`
  资源搜索、筛选、网格、详情、上传和当前分镜绑定。

- `web/src/components/resources/AssetGrid.tsx`
  角色、场景、道具资源卡片网格。

- `web/src/components/resources/AssetDetailDrawer.tsx`
  资源详情、参考媒体、关联分镜和绑定操作。

- `web/src/components/resources/AssetUploadDrawer.tsx`
  现有参考图上传表单。

- `web/src/pages/ProductionPage.tsx`
  作业进度、工作流产物、一致性报告、渲染、预览和下载。

- `web/src/components/production/WorkflowArtifacts.tsx`
  工作流产物状态列表。

- `web/src/components/production/FinalRenderPanel.tsx`
  最终视频预览和下载。

- `web/src/styles/tokens.css`
  颜色、尺寸、阴影、圆角和焦点变量。

- `web/src/styles/shell.css`
  顶栏、侧栏、抽屉、toast 和通用工作台布局。

- `web/src/styles/pages.css`
  项目、创建、分镜、设定、资源和制作页面布局。

- `web/src/styles/responsive.css`
  1180px、768px 两个响应式断点和移动分段视图。

- `web/src/i18n.ts`
  增加新工作台所需中文文案；保留现有类型安全结构。

- `web/src/test/fixtures.ts`
  提供跨页面测试共用的完整项目、分镜和连续性工厂，避免测试间复制失真的数据结构。

- `web/src/**/*.test.ts(x)`
  为纯状态、页面组件、路由深链和关键业务顺序建立回归测试。

---

### Task 1: Build The Shared Workbench Shell

**Files:**

- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Create: `web/src/app/routes.ts`
- Create: `web/src/components/feedback/ToastRegion.tsx`
- Create: `web/src/components/shell/AppShell.tsx`
- Create: `web/src/components/shell/ProviderDrawer.tsx`
- Create: `web/src/components/shell/AppShell.test.tsx`
- Create: `web/src/styles/tokens.css`
- Create: `web/src/styles/shell.css`
- Modify: `web/src/main.tsx`

**Interfaces:**

- Produces: `projectRoutes`, `AppShell`, `ProviderDrawer`, `ToastRegion`.
- Consumes: existing `KeyGate`, `Project`, `ProviderCredentials`, `GatewayKeySession` and Lucide icons.

- [ ] **Step 1: Install the routing dependency**

Run from `web`:

```powershell
npm install react-router-dom@^6.30.1
```

Expected: `react-router-dom` appears under `dependencies`; no other dependency is removed.

- [ ] **Step 2: Define exact route builders**

Create `web/src/app/routes.ts`:

```ts
export const projectRoutes = {
  list: "/projects",
  create: "/projects/new",
  storyboard: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/storyboard`,
  settings: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/settings`,
  resources: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/resources`,
  production: (projectId: string) => `/projects/${encodeURIComponent(projectId)}/production`,
} as const;
```

- [ ] **Step 3: Write the failing shell test**

Create `web/src/components/shell/AppShell.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

describe("AppShell", () => {
  it("shows project navigation and keeps recharge as a development notice", () => {
    render(
      <MemoryRouter>
        <AppShell
          project={{ id: "p1", title: "雨夜来信", mode: "short_drama" }}
          providerPanel={<div>接口表单</div>}
        >
          <div>页面内容</div>
        </AppShell>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "分镜编辑" })).toHaveAttribute(
      "href",
      "/projects/p1/storyboard",
    );
    expect(screen.queryByRole("link", { name: "钱包" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "充值" }));
    expect(screen.getByRole("status")).toHaveTextContent("功能开发中");
  });

  it("opens and closes the interface configuration drawer", () => {
    const onOpenChange = vi.fn();
    render(
      <MemoryRouter>
        <AppShell
          project={null}
          providerPanel={<div>接口表单</div>}
          providerOpen={false}
          onProviderOpenChange={onOpenChange}
        >
          <div>项目列表</div>
        </AppShell>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "接口配置" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
```

- [ ] **Step 4: Run the shell test and verify it fails**

Run:

```powershell
npm test -- AppShell.test.tsx
```

Expected: FAIL because `AppShell` does not exist.

- [ ] **Step 5: Implement the shell contract**

Create `AppShell.tsx` with this public interface and behavior:

```tsx
import { CreditCard, Settings2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import type { Project } from "../../domain/types";
import { projectRoutes } from "../../app/routes";
import { ToastRegion } from "../feedback/ToastRegion";

export interface AppShellProps {
  children: ReactNode;
  project: Project | null;
  providerPanel: ReactNode;
  providerOpen?: boolean;
  onProviderOpenChange?: (open: boolean) => void;
}

export function AppShell({
  children,
  project,
  providerPanel,
  providerOpen,
  onProviderOpenChange,
}: AppShellProps) {
  const [localProviderOpen, setLocalProviderOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const drawerOpen = providerOpen ?? localProviderOpen;
  const setDrawerOpen = onProviderOpenChange ?? setLocalProviderOpen;

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const links = project
    ? [
        ["分镜编辑", projectRoutes.storyboard(project.id)],
        ["全局设定", projectRoutes.settings(project.id)],
        ["资源库", projectRoutes.resources(project.id)],
        ["制作与成片", projectRoutes.production(project.id)],
      ]
    : [];

  return (
    <div className="workbench-shell">
      <header className="workbench-topbar">
        <Link className="workbench-brand" to={projectRoutes.list}>OpenMontage</Link>
        <span className="workbench-project-title">{project?.title ?? "项目工作台"}</span>
        <div className="workbench-topbar-actions">
          <button type="button" onClick={() => setDrawerOpen(true)}>
            <Settings2 aria-hidden="true" size={16} />接口配置
          </button>
          <button type="button" onClick={() => setToast("功能开发中")}>
            <CreditCard aria-hidden="true" size={16} />充值
          </button>
        </div>
      </header>
      <div className="workbench-body">
        {project ? (
          <aside className="project-navigation" aria-label="项目导航">
            {links.map(([label, to]) => (
              <NavLink key={to} to={to}>{label}</NavLink>
            ))}
          </aside>
        ) : null}
        <main className="workbench-content">{children}</main>
      </div>
      {drawerOpen ? (
        <div className="drawer-layer" role="dialog" aria-modal="true" aria-label="接口配置">
          <button type="button" aria-label="关闭接口配置" onClick={() => setDrawerOpen(false)}>×</button>
          {providerPanel}
        </div>
      ) : null}
      <ToastRegion message={toast} />
    </div>
  );
}
```

Implement `ToastRegion` so it renders `null` without a message and `<div className="toast-region" role="status" aria-live="polite">` with a message otherwise. Implement `ProviderDrawer` as a thin adapter around existing `KeyGate`; it must not duplicate or persist credentials.

- [ ] **Step 6: Add base shell tokens**

Define exact reusable variables in `tokens.css`:

```css
:root {
  --om-bg: #f5f7fa;
  --om-surface: #ffffff;
  --om-surface-subtle: #f8fafc;
  --om-text: #172033;
  --om-text-muted: #667085;
  --om-border: #d9e0ea;
  --om-primary: #2563eb;
  --om-primary-hover: #1d4ed8;
  --om-success: #0f9f8f;
  --om-warning: #b7791f;
  --om-danger: #c2413b;
  --om-focus: #60a5fa;
  --om-radius: 6px;
  --om-shadow: 0 8px 24px rgb(23 32 51 / 8%);
  color: var(--om-text);
  background: var(--om-bg);
}
```

Import `tokens.css` and `shell.css` before the current `styles.css` in `main.tsx` so the existing app remains runnable until Task 8.

- [ ] **Step 7: Run the test and build**

Run:

```powershell
npm test -- AppShell.test.tsx
npm run build
```

Expected: PASS; current application still builds.

- [ ] **Step 8: Commit**

```powershell
git add web/package.json web/package-lock.json web/src/app/routes.ts web/src/components/feedback web/src/components/shell web/src/styles/tokens.css web/src/styles/shell.css web/src/main.tsx
git commit -m "feat: add multi-page workbench shell"
```

---

### Task 2: Add Projects And AI Project Creation Pages

**Files:**

- Create: `web/src/app/workbench/types.ts`
- Create: `web/src/pages/ProjectsPage.tsx`
- Create: `web/src/pages/ProjectsPage.test.tsx`
- Create: `web/src/pages/NewProjectPage.tsx`
- Create: `web/src/pages/NewProjectPage.test.tsx`
- Create: `web/src/test/fixtures.ts`
- Create: `web/src/utils/downloadBlob.ts`
- Modify: `web/src/i18n.ts`

**Interfaces:**

- Produces: `ProjectsPage`, `NewProjectPage`, `CreateProjectInput`, `downloadBlob`.
- Consumes: `listProjectSummaries`, `deleteProject`, `exportProjectBackup`, `importProjectBackup`, `projectRoutes`.
- `NewProjectPage` calls `onCreate(input) -> Promise<ShortDramaProjectResponse>`; `CreateProjectInput` contains only `title`, `prompt`, `project_type`.

- [ ] **Step 1: Create shared typed test fixtures**

Create `web/src/test/fixtures.ts`:

```ts
import type {
  ContinuityPlan,
  ProjectType,
  ShortDramaProjectResponse,
  Shot,
} from "../domain/types";

export function createShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: "shot-1",
    scene_id: "scene-1",
    index: 1,
    beat: "发现信封",
    prompt: "雨夜巷口，玛拉发现一封信",
    characters: ["char-1"],
    location: "雨巷",
    props: ["信封"],
    shot_intent: "建立悬念",
    shot_language: { shot_size: "medium_close", camera_movement: "dolly_in" },
    status: "ready",
    consistency_score: 100,
    output_url: null,
    output_path: null,
    asset_ids: [],
    version: 1,
    history: [],
    ...overrides,
  };
}

export function createContinuityPlan(projectType: ProjectType): ContinuityPlan {
  return {
    project_type: projectType,
    active_episode_number: projectType === "single_video" ? null : 1,
    series_bible: {
      worldview: "近未来沿海城市",
      main_arc: "找出匿名信的寄件人",
      style_lock: "冷色写实悬疑",
      visual_rules: "角色服装和主色保持一致",
      taboos: [],
      locations: ["雨巷"],
      props: ["信封"],
      relationship_map: ["玛拉与林警官互不信任"],
    },
    episodes: projectType === "single_video"
      ? []
      : [{
          episode_number: 1,
          title: "匿名信",
          goal: "查明来信目的",
          conflict: "线索互相矛盾",
          twist: "寄件人就在身边",
          cliffhanger: "第二封信出现",
          inherited_state: [],
          locked: false,
        }],
    story_state: {
      character_knowledge: [],
      relationship_changes: [],
      active_foreshadowing: [],
      resolved_foreshadowing: [],
      prop_state: ["信封尚未拆开"],
      character_status: ["玛拉保持警惕"],
      current_locations: ["雨巷"],
    },
  };
}

export function createProjectResponse(
  options: { projectType?: ProjectType; shotCount?: number } = {},
): ShortDramaProjectResponse {
  const projectType = options.projectType ?? "single_video";
  const shotCount = options.shotCount ?? 2;
  return {
    project: { id: "p1", title: "雨夜来信", mode: "short_drama", project_type: projectType },
    series_bible: {
      title: "雨夜来信",
      mode: "short_drama",
      style_lock: "冷色写实悬疑",
      characters: [{
        id: "char-1",
        name: "玛拉",
        role: "调查者",
        visual_lock: "红色风衣，短发",
        voice: null,
        reference_images: [],
        locked: true,
      }],
      assets: [{
        id: "asset-char-1",
        kind: "character",
        label: "玛拉",
        description: "红色风衣角色参考",
        prompt: "红色风衣，短发，冷色写实",
        reference_images: ["assets/images/character/mara.png"],
        media_urls: [],
        shot_ids: [],
        version: 1,
      }],
    },
    storyboard: {
      shots: Array.from({ length: shotCount }, (_, index) => createShot({
        id: `shot-${index + 1}`,
        index: index + 1,
        beat: `分镜 ${index + 1}`,
      })),
    },
    consistency_report: { score: 100, issues: [] },
    continuity_plan: createContinuityPlan(projectType),
    workflow_artifacts: [{ name: "storyboard.json", path: "storyboard.json", exists: true }],
    render_report: null,
    final_path: null,
  };
}
```

- [ ] **Step 2: Write project list behavior tests**

Create tests that mock the local database modules and assert these exact outcomes:

```tsx
it("lists browser-local projects and opens the selected project", async () => {
  projectStoreMocks.listProjectSummaries.mockResolvedValue([
    { id: "p1", title: "雨夜来信", updatedAt: "2026-07-10T08:00:00Z", shotCount: 8, hasFinalRender: false },
  ]);
  render(<MemoryRouter><ProjectsPage /></MemoryRouter>);

  expect(await screen.findByText("雨夜来信")).toBeInTheDocument();
  expect(screen.getByText("8 个分镜")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "打开 雨夜来信" })).toHaveAttribute(
    "href",
    "/projects/p1/storyboard",
  );
});

it("requires confirmation before deleting a local project", async () => {
  projectStoreMocks.listProjectSummaries.mockResolvedValue([
    { id: "p1", title: "雨夜来信", updatedAt: "2026-07-10T08:00:00Z", shotCount: 8, hasFinalRender: false },
  ]);
  render(<MemoryRouter><ProjectsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: "删除 雨夜来信" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(projectStoreMocks.deleteProject).toHaveBeenCalledWith("p1"));
});
```

- [ ] **Step 3: Write the AI creation contract test**

```tsx
it("submits title, project type and master prompt without a shot count", async () => {
  const onCreate = vi.fn().mockResolvedValue(createProjectResponse({ shotCount: 2 }));
  const onCreated = vi.fn();
  render(<NewProjectPage providerReady onCreate={onCreate} onCreated={onCreated} />);

  fireEvent.change(screen.getByLabelText("项目标题"), { target: { value: "雨夜来信" } });
  fireEvent.change(screen.getByLabelText("故事与画面要求"), { target: { value: "一封信改变两个人的命运" } });
  fireEvent.click(screen.getByRole("button", { name: "AI 规划分镜" }));

  await waitFor(() => expect(onCreate).toHaveBeenCalled());
  expect(onCreate.mock.calls[0][0]).toEqual({
    title: "雨夜来信",
    prompt: "一封信改变两个人的命运",
    project_type: "single_video",
  });
  expect(onCreate.mock.calls[0][0]).not.toHaveProperty("shot_count");
  expect(onCreated).toHaveBeenCalledWith("p1", 2);
});
```

- [ ] **Step 4: Run tests and verify failure**

Run:

```powershell
npm test -- ProjectsPage.test.tsx NewProjectPage.test.tsx
```

Expected: FAIL because both pages are missing.

- [ ] **Step 5: Implement the narrow creation type and form**

Define the shared input in `web/src/app/workbench/types.ts`, then import it in `NewProjectPage.tsx`:

```ts
export type CreateProjectInput = Pick<
  ShortDramaProjectRequest,
  "title" | "prompt"
> & { project_type: ProjectType };

export interface NewProjectPageProps {
  providerReady: boolean;
  onOpenProvider?: () => void;
  onCreate: (input: CreateProjectInput) => Promise<ShortDramaProjectResponse>;
  onCreated: (projectId: string, shotCount: number) => void;
}
```

The form owns `title`, `prompt`, `projectType`, `creating` and `error`. Its submit handler must be exactly ordered as follows:

```ts
const input: CreateProjectInput = {
  title: title.trim() || "未命名项目",
  prompt: prompt.trim(),
  project_type: projectType,
};
const result = await onCreate(input);
onCreated(result.project.id, result.storyboard.shots.length);
```

Do not render an input named `shot_count`, template selector or advanced model fields. When `providerReady` is false, disable `AI 规划分镜` and render an `打开接口配置` button.

- [ ] **Step 6: Implement project list operations**

`ProjectsPage` must load summaries on mount, use native `<dialog>` or the existing modal convention for delete confirmation, call `exportProjectBackup(id)` followed by `downloadBlob(blob, `${title}.omproj`)`, and call `importProjectBackup(file)` before navigating to `projectRoutes.storyboard(snapshot.project.id)`.

Implement `downloadBlob` as a reusable exact helper:

```ts
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 7: Run targeted tests**

Run:

```powershell
npm test -- ProjectsPage.test.tsx NewProjectPage.test.tsx
```

Expected: PASS, including no `shot_count` property.

- [ ] **Step 8: Commit**

```powershell
git add web/src/app/workbench/types.ts web/src/pages/ProjectsPage.tsx web/src/pages/ProjectsPage.test.tsx web/src/pages/NewProjectPage.tsx web/src/pages/NewProjectPage.test.tsx web/src/test/fixtures.ts web/src/utils/downloadBlob.ts web/src/i18n.ts
git commit -m "feat: add local projects and AI creation pages"
```

---

### Task 3: Make AI Shot Optimization An Explicit Draft Workflow

**Files:**

- Create: `web/src/components/storyboard/shotDraft.ts`
- Create: `web/src/components/storyboard/shotDraft.test.ts`
- Modify: `web/src/components/ShotEditor.tsx`
- Create: `web/src/components/ShotEditor.test.tsx`
- Modify: `web/src/i18n.ts`

**Interfaces:**

- Produces: `ShotDraftFields`, `ShotDraftState`, `createShotDraftState`, `applyPromptOptimization`, `undoPromptOptimization`, `shotDraftIsDirty`, `toShotSaveRequest`.
- Consumes: `Shot`, `ShotLanguage`, `PromptOptimizeResponse`, `ShotSaveRequest`.
- `ShotEditor` continues to consume existing `onOptimizePrompt`, `onSaveShot`, `onRegenerateShot`, but no longer saves automatically from the regenerate button.

- [ ] **Step 1: Write pure draft state tests**

Import `createShot` from `web/src/test/fixtures.ts` and define `const sampleShot = createShot();` at module scope, then add:

```ts
it("applies all AI fields as an unsaved draft and supports one undo", () => {
  const initial = createShotDraftState(sampleShot);
  const optimized = applyPromptOptimization(initial, {
    project_id: "p1",
    model: "text-model",
    optimized_text: "优化后的画面提示词",
    notes: [],
    shot_intent: "强调人物犹豫",
    shot_language: { shot_size: "close_up", camera_movement: "dolly_in" },
  });

  expect(optimized.draft.prompt).toBe("优化后的画面提示词");
  expect(optimized.draft.shotIntent).toBe("强调人物犹豫");
  expect(optimized.draft.shotLanguage.shot_size).toBe("close_up");
  expect(shotDraftIsDirty(optimized)).toBe(true);
  expect(undoPromptOptimization(optimized).draft).toEqual(initial.draft);
});

it("converts the current draft to the existing save payload", () => {
  const state = createShotDraftState(sampleShot);
  expect(toShotSaveRequest(state.draft)).toEqual({
    prompt: sampleShot.prompt,
    characters: sampleShot.characters,
    location: sampleShot.location,
    props: sampleShot.props,
    asset_ids: sampleShot.asset_ids,
    shot_intent: sampleShot.shot_intent,
    shot_language: sampleShot.shot_language,
  });
});
```

- [ ] **Step 2: Run the pure test and verify failure**

Run:

```powershell
npm test -- shotDraft.test.ts
```

Expected: FAIL because `shotDraft.ts` is missing.

- [ ] **Step 3: Implement the complete draft model**

Create `shotDraft.ts`:

```ts
import type { PromptOptimizeResponse, Shot, ShotLanguage, ShotSaveRequest } from "../../domain/types";

export interface ShotDraftFields {
  prompt: string;
  characters: string[];
  location: string;
  props: string[];
  assetIds: string[];
  shotIntent: string;
  shotLanguage: ShotLanguage;
}

export interface ShotDraftState {
  shotId: string | null;
  baseline: ShotDraftFields;
  draft: ShotDraftFields;
  undoOptimization: ShotDraftFields | null;
}

function cloneFields(value: ShotDraftFields): ShotDraftFields {
  return {
    ...value,
    characters: [...value.characters],
    props: [...value.props],
    assetIds: [...value.assetIds],
    shotLanguage: { ...value.shotLanguage },
  };
}

export function fieldsFromShot(shot: Shot | null): ShotDraftFields {
  return {
    prompt: shot?.prompt ?? "",
    characters: [...(shot?.characters ?? [])],
    location: shot?.location ?? "",
    props: [...(shot?.props ?? [])],
    assetIds: [...(shot?.asset_ids ?? [])],
    shotIntent: shot?.shot_intent ?? "",
    shotLanguage: { ...(shot?.shot_language ?? {}) },
  };
}

export function createShotDraftState(shot: Shot | null): ShotDraftState {
  const baseline = fieldsFromShot(shot);
  return { shotId: shot?.id ?? null, baseline, draft: cloneFields(baseline), undoOptimization: null };
}

export function applyPromptOptimization(
  state: ShotDraftState,
  response: PromptOptimizeResponse,
): ShotDraftState {
  return {
    ...state,
    undoOptimization: cloneFields(state.draft),
    draft: {
      ...state.draft,
      prompt: response.optimized_text,
      shotIntent: response.shot_intent ?? state.draft.shotIntent,
      shotLanguage: response.shot_language
        ? { ...state.draft.shotLanguage, ...response.shot_language }
        : state.draft.shotLanguage,
    },
  };
}

export function undoPromptOptimization(state: ShotDraftState): ShotDraftState {
  if (!state.undoOptimization) return state;
  return { ...state, draft: cloneFields(state.undoOptimization), undoOptimization: null };
}

export function shotDraftIsDirty(state: ShotDraftState): boolean {
  return JSON.stringify(state.draft) !== JSON.stringify(state.baseline);
}

export function toShotSaveRequest(draft: ShotDraftFields): ShotSaveRequest {
  return {
    prompt: draft.prompt,
    characters: draft.characters,
    location: draft.location.trim() || null,
    props: draft.props,
    asset_ids: draft.assetIds,
    shot_intent: draft.shotIntent.trim() || null,
    shot_language: draft.shotLanguage,
  };
}
```

- [ ] **Step 4: Write interaction tests before changing `ShotEditor`**

Add tests that assert the API sequence, not only rendered text:

```tsx
const sampleShot = createShot();
const optimizedResponse: PromptOptimizeResponse = {
  project_id: "p1",
  model: "text-model",
  optimized_text: "优化后的画面提示词",
  notes: [],
  shot_intent: "强调人物犹豫",
  shot_language: { shot_size: "close_up" },
};

function renderEditor(overrides: Partial<ShotEditorProps> = {}) {
  const props: ShotEditorProps = {
    assets: [],
    characters: [],
    optimizing: false,
    regenerating: false,
    saving: false,
    shot: sampleShot,
    strings: getStrings("zh").shotEditor,
    onOptimizePrompt: vi.fn().mockResolvedValue(optimizedResponse),
    onRegenerateShot: vi.fn().mockResolvedValue(undefined),
    onSaveShot: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { ...render(<ShotEditor {...props} />), props };
}
```

Export `ShotEditorProps` from `ShotEditor.tsx` so the helper remains type-checked. Then add the interaction cases:

```tsx
it("keeps optimization local until the user saves", async () => {
  const onOptimizePrompt = vi.fn().mockResolvedValue(optimizedResponse);
  const onSaveShot = vi.fn().mockResolvedValue(undefined);
  const onRegenerateShot = vi.fn().mockResolvedValue(undefined);
  renderEditor({ onOptimizePrompt, onSaveShot, onRegenerateShot });

  fireEvent.click(screen.getByRole("button", { name: "AI 优化提示词" }));
  expect(await screen.findByDisplayValue("优化后的画面提示词")).toBeInTheDocument();
  expect(onSaveShot).not.toHaveBeenCalled();
  expect(onRegenerateShot).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
  await waitFor(() => expect(onSaveShot).toHaveBeenCalledTimes(1));
  expect(onRegenerateShot).not.toHaveBeenCalled();
});

it("does not save automatically when regenerate is clicked", async () => {
  const onSaveShot = vi.fn();
  const onRegenerateShot = vi.fn().mockResolvedValue(undefined);
  renderEditor({ onSaveShot, onRegenerateShot });
  fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
  await waitFor(() => expect(onRegenerateShot).toHaveBeenCalledTimes(1));
  expect(onSaveShot).not.toHaveBeenCalled();
});

it("preserves the current form when optimization fails", async () => {
  const onOptimizePrompt = vi.fn().mockRejectedValue(new Error("优化失败"));
  renderEditor({ onOptimizePrompt });
  fireEvent.change(screen.getByLabelText("分镜提示词"), { target: { value: "用户当前草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "AI 优化提示词" }));
  await waitFor(() => expect(onOptimizePrompt).toHaveBeenCalled());
  expect(screen.getByDisplayValue("用户当前草稿")).toBeInTheDocument();
});
```

- [ ] **Step 5: Refactor `ShotEditor` around `ShotDraftState`**

Replace its parallel form states with one `ShotDraftState`. On `shot.id` change, reset with `createShotDraftState(shot)`. On optimization success, dispatch `applyPromptOptimization`. Render `撤销优化` only while `undoOptimization` is non-null. Disable `重新生成` while `shotDraftIsDirty(state)` and show `请先保存修改` next to the button.

The three actions must call exactly one callback each:

- `AI 优化提示词` -> `onOptimizePrompt(shot, state.draft.prompt)`
- `保存修改` -> `onSaveShot(shot.id, toShotSaveRequest(state.draft))`
- `重新生成` -> `onRegenerateShot(shot)`

After save resolves, update `baseline` and `draft` from the payload accepted by the server-facing callback and clear `undoOptimization`.

- [ ] **Step 6: Run all shot tests**

Run:

```powershell
npm test -- shotDraft.test.ts ShotEditor.test.tsx App.test.tsx
```

Expected: PASS; existing app regression tests are updated where they previously expected save-before-regenerate.

- [ ] **Step 7: Commit**

```powershell
git add web/src/components/storyboard/shotDraft.ts web/src/components/storyboard/shotDraft.test.ts web/src/components/ShotEditor.tsx web/src/components/ShotEditor.test.tsx web/src/App.test.tsx web/src/i18n.ts
git commit -m "feat: separate shot optimization save and regenerate"
```

---

### Task 4: Build The Dedicated Storyboard Editor Page

**Files:**

- Create: `web/src/components/storyboard/ShotList.tsx`
- Create: `web/src/components/storyboard/ShotPreview.tsx`
- Create: `web/src/components/storyboard/ShotOrderStrip.tsx`
- Create: `web/src/pages/StoryboardPage.tsx`
- Create: `web/src/pages/StoryboardPage.test.tsx`
- Modify: `web/src/i18n.ts`

**Interfaces:**

- Produces: `StoryboardPage` and three focused storyboard view components.
- Consumes: ordered `Shot[]`, selected shot ID, decorated media URL, `ShotEditor`, asset and character arrays, existing shot callbacks.

- [ ] **Step 1: Write the page composition test**

Define a complete typed fixture at module scope:

```tsx
const project = createProjectResponse({ shotCount: 2 });
const storyboardProps: StoryboardPageProps = {
  assets: project.series_bible.assets ?? [],
  characters: project.series_bible.characters,
  optimizingShotId: null,
  regeneratingShotId: null,
  savingShotId: null,
  selectedShotId: "shot-1",
  shots: project.storyboard.shots,
  plannedShotCount: null,
  resolveShotMedia: () => null,
  onSelectShot: vi.fn(),
  onOptimizePrompt: vi.fn().mockResolvedValue({
    project_id: "p1",
    model: "text-model",
    optimized_text: "优化后的画面提示词",
    notes: [],
  }),
  onSaveShot: vi.fn().mockResolvedValue(undefined),
  onRegenerateShot: vi.fn().mockResolvedValue(undefined),
};
```

Then add:

```tsx
it("renders a selectable shot list, central preview, read-only order strip and inspector", () => {
  render(<StoryboardPage {...storyboardProps} />);

  expect(screen.getByRole("navigation", { name: "分镜列表" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "分镜预览" })).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "分镜顺序" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "分镜检查器" })).toBeInTheDocument();
  expect(screen.queryByText("视频轨")).not.toBeInTheDocument();
  expect(screen.queryByText("音频轨")).not.toBeInTheDocument();
});

it("changes the current shot from either list without regenerating", () => {
  const onSelectShot = vi.fn();
  render(<StoryboardPage {...storyboardProps} onSelectShot={onSelectShot} />);
  fireEvent.click(screen.getByRole("button", { name: "选择分镜 2" }));
  expect(onSelectShot).toHaveBeenCalledWith("shot-2");
  expect(storyboardProps.onRegenerateShot).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
npm test -- StoryboardPage.test.tsx
```

Expected: FAIL because `StoryboardPage` is missing.

- [ ] **Step 3: Define the exact page interface**

```ts
export interface StoryboardPageProps {
  assets: AssetRecord[];
  characters: Character[];
  optimizingShotId: string | null;
  regeneratingShotId: string | null;
  savingShotId: string | null;
  selectedShotId: string | null;
  shots: Shot[];
  plannedShotCount?: number | null;
  resolveShotMedia: (shot: Shot) => string | null;
  onSelectShot: (shotId: string) => void;
  onOptimizePrompt: (shot: Shot, sourceText: string) => Promise<PromptOptimizeResponse>;
  onSaveShot: (shotId: string, payload: ShotSaveRequest) => Promise<void>;
  onRegenerateShot: (shot: Shot) => Promise<void>;
}
```

- [ ] **Step 4: Implement the three-column page**

Sort once with `orderedShots(shots)`. Resolve `selectedShot` by ID, falling back to the first ordered shot. Render:

```tsx
const strings = getStrings("zh");

<section className="storyboard-workspace">
  {plannedShotCount ? <div role="status">AI 已为你规划 {plannedShotCount} 个分镜</div> : null}
  <ShotList shots={ordered} selectedShotId={selectedShot?.id ?? null} onSelect={onSelectShot} />
  <div className="storyboard-stage">
    <ShotPreview shot={selectedShot} mediaUrl={selectedShot ? resolveShotMedia(selectedShot) : null} />
    <ShotOrderStrip shots={ordered} selectedShotId={selectedShot?.id ?? null} onSelect={onSelectShot} />
  </div>
  <ShotEditor
    assets={assets}
    characters={characters}
    optimizing={optimizingShotId === selectedShot?.id}
    regenerating={regeneratingShotId === selectedShot?.id}
    saving={savingShotId === selectedShot?.id}
    shot={selectedShot}
    strings={strings.shotEditor}
    onOptimizePrompt={onOptimizePrompt}
    onSaveShot={onSaveShot}
    onRegenerateShot={onRegenerateShot}
  />
</section>
```

`ShotOrderStrip` renders buttons ordered by `Shot.index`; it must not register drag, resize, trim, drop or pointer-move handlers.

- [ ] **Step 5: Add unsaved navigation protection**

Expose `onDirtyChange(dirty: boolean)` from `ShotEditor`. `StoryboardPage` blocks selection changes while dirty and asks `当前分镜有未保存修改，确定放弃吗？`. Register `beforeunload` only while dirty and remove it on cleanup.

- [ ] **Step 6: Run targeted tests**

Run:

```powershell
npm test -- StoryboardPage.test.tsx ShotEditor.test.tsx
```

Expected: PASS; selecting either list changes only the selected ID.

- [ ] **Step 7: Commit**

```powershell
git add web/src/components/storyboard web/src/pages/StoryboardPage.tsx web/src/pages/StoryboardPage.test.tsx web/src/i18n.ts
git commit -m "feat: add dedicated storyboard editor page"
```

---

### Task 5: Extract Project-Level Global Settings

**Files:**

- Create: `web/src/app/workbench/snapshot.ts`
- Create: `web/src/app/workbench/snapshot.test.ts`
- Create: `web/src/components/continuity/ContinuityEditor.tsx`
- Create: `web/src/pages/GlobalSettingsPage.tsx`
- Create: `web/src/pages/GlobalSettingsPage.test.tsx`
- Modify: `web/src/i18n.ts`

**Interfaces:**

- Produces: `GlobalSettingsPage` and `ContinuityEditor`.
- Consumes: existing `ContinuityPlan`, `EpisodeOutlineItem`, `ProjectType`, `saveContinuityPlan` callback.

- [ ] **Step 1: Write visibility and save tests**

Use the shared factory at module scope:

```ts
const singleVideoPlan = createContinuityPlan("single_video");
const seriesPlan = createContinuityPlan("mini_series");
```

Then add:

```tsx
it("shows the reduced settings set for a single video", () => {
  render(<GlobalSettingsPage plan={singleVideoPlan} saving={false} onSave={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "故事核心" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "视觉规则" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "角色与关系" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "分集规划" })).not.toBeInTheDocument();
  expect(screen.getByText("只影响后续优化和生成，不会修改已完成分镜")).toBeInTheDocument();
});

it("shows and saves episode planning for a series", async () => {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<GlobalSettingsPage plan={seriesPlan} saving={false} onSave={onSave} />);
  expect(screen.getByRole("heading", { name: "分集规划" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("第 1 集目标"), { target: { value: "找到失踪证人" } });
  fireEvent.click(screen.getByRole("button", { name: "保存全局设定" }));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(onSave.mock.calls[0][0].episodes[0].goal).toBe("找到失踪证人");
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
npm test -- GlobalSettingsPage.test.tsx
```

Expected: FAIL because the page is missing.

- [ ] **Step 3: Extract continuity editing without changing field names**

Move `emptyContinuityPlan` into `web/src/app/workbench/snapshot.ts`. Move `splitLines`, `joinLines`, `createEpisode` and the existing `ContinuityEditor` logic into `web/src/components/continuity/ContinuityEditor.tsx`. Add a pure test that asserts a single video has `active_episode_number: null` and both series types start at episode 1. Keep these exact backend property names:

```text
series_bible.worldview
series_bible.main_arc
series_bible.style_lock
series_bible.visual_rules
series_bible.taboos
series_bible.locations
series_bible.props
series_bible.relationship_map
story_state.character_knowledge
story_state.character_status
story_state.relationship_changes
story_state.active_foreshadowing
story_state.resolved_foreshadowing
story_state.prop_state
story_state.current_locations
episodes[].goal
episodes[].conflict
episodes[].twist
episodes[].cliffhanger
episodes[].inherited_state
episodes[].locked
active_episode_number
```

For `single_video`, omit episode fields, active episode controls and cross-episode inheritance from the DOM; do not delete their stored values from the `ContinuityPlan` object.

- [ ] **Step 4: Implement explicit save ownership**

`GlobalSettingsPage` owns a draft copy initialized from the `plan` prop. It calls `onSave(draft)` only from `保存全局设定`. On failure it leaves the draft visible and shows the returned error. On success it replaces the baseline with the saved draft and clears the dirty state.

- [ ] **Step 5: Run tests**

Run:

```powershell
npm test -- snapshot.test.ts GlobalSettingsPage.test.tsx App.test.tsx
```

Expected: PASS; all existing continuity fields remain serializable to `ContinuityPlan`.

- [ ] **Step 6: Commit**

```powershell
git add web/src/app/workbench/snapshot.ts web/src/app/workbench/snapshot.test.ts web/src/components/continuity/ContinuityEditor.tsx web/src/pages/GlobalSettingsPage.tsx web/src/pages/GlobalSettingsPage.test.tsx web/src/i18n.ts
git commit -m "feat: add project global settings page"
```

---

### Task 6: Build The Character Scene And Prop Resource Library

**Files:**

- Create: `web/src/components/resources/assetLibrary.ts`
- Create: `web/src/components/resources/assetLibrary.test.ts`
- Create: `web/src/components/resources/AssetGrid.tsx`
- Create: `web/src/components/resources/AssetDetailDrawer.tsx`
- Create: `web/src/components/resources/AssetUploadDrawer.tsx`
- Create: `web/src/pages/ResourceLibraryPage.tsx`
- Create: `web/src/pages/ResourceLibraryPage.test.tsx`
- Modify: `web/src/i18n.ts`

**Interfaces:**

- Produces: `ResourcePanelState`, `filterAssets`, `countLinkedShots`, resource grid, detail drawer and upload drawer.
- Consumes: `AssetRecord`, `Shot`, `ReferenceImageUploadRequest`, current shot ID and existing upload/save callbacks.

- [ ] **Step 1: Write the pure resource tests**

Define the complete pure-test fixtures, then add the assertions:

```ts
const sampleShot = createShot();
const assets: AssetRecord[] = [
  ...(createProjectResponse().series_bible.assets ?? []),
  {
    id: "scene-rain",
    kind: "scene",
    label: "雨巷",
    description: "夜雨中的旧城巷口",
    prompt: "冷色雨夜，湿润石板路",
    reference_images: [],
  },
];
```

Then add:

```ts
it("filters only the three supported resource kinds", () => {
  expect(filterAssets(assets, { kind: "scene", query: "雨" }).map((asset) => asset.id)).toEqual(["scene-rain"]);
});

it("counts bindings from current storyboard shots", () => {
  expect(countLinkedShots("asset-char-1", [
    { ...sampleShot, asset_ids: ["asset-char-1"] },
    { ...sampleShot, id: "s2", asset_ids: [] },
  ])).toBe(1);
});
```

Define the mutually exclusive panel state:

```ts
export type ResourcePanelState =
  | { mode: "closed" }
  | { mode: "detail"; assetId: string }
  | { mode: "upload" };
```

- [ ] **Step 2: Write the interaction test for panel exclusion and binding**

Export this page interface from `ResourceLibraryPage.tsx`:

```ts
export interface ResourceLibraryPageProps {
  assets: AssetRecord[];
  consistencyReport: ConsistencyReport | null;
  currentShotId: string | null;
  shots: Shot[];
  uploading: boolean;
  onBindAsset: (shotId: string, assetId: string, bind: boolean) => Promise<void>;
  onUploadReferenceImage: (payload: ReferenceImageUploadRequest) => Promise<void>;
}
```

Define complete test props:

```ts
const project = createProjectResponse();
const resourceProps: ResourceLibraryPageProps = {
  assets: project.series_bible.assets ?? [],
  consistencyReport: project.consistency_report,
  currentShotId: "shot-1",
  shots: project.storyboard.shots,
  uploading: false,
  onBindAsset: vi.fn().mockResolvedValue(undefined),
  onUploadReferenceImage: vi.fn().mockResolvedValue(undefined),
};
```

Then add:

```tsx
it("never shows asset detail and upload drawers at the same time", () => {
  render(<ResourceLibraryPage {...resourceProps} />);
  fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));
  expect(screen.getByRole("dialog", { name: "资源详情" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "上传资源" }));
  expect(screen.queryByRole("dialog", { name: "资源详情" })).not.toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "上传资源" })).toBeInTheDocument();
});

it("binds the selected resource through the current shot save contract", async () => {
  const onBindAsset = vi.fn().mockResolvedValue(undefined);
  render(<ResourceLibraryPage {...resourceProps} currentShotId="shot-1" onBindAsset={onBindAsset} />);
  fireEvent.click(screen.getByRole("button", { name: "查看资源 玛拉" }));
  fireEvent.click(screen.getByRole("button", { name: "绑定到当前分镜" }));
  await waitFor(() => expect(onBindAsset).toHaveBeenCalledWith("shot-1", "asset-char-1", true));
});
```

- [ ] **Step 3: Run and verify failure**

Run:

```powershell
npm test -- assetLibrary.test.ts ResourceLibraryPage.test.tsx
```

Expected: FAIL because the resource module is missing.

- [ ] **Step 4: Implement resource filtering and counts**

```ts
export type AssetKindFilter = "all" | AssetRecord["kind"];

export function filterAssets(
  assets: AssetRecord[],
  filter: { kind: AssetKindFilter; query: string },
): AssetRecord[] {
  const query = filter.query.trim().toLocaleLowerCase();
  return assets.filter((asset) => {
    const kindMatches = filter.kind === "all" || asset.kind === filter.kind;
    const queryMatches = !query || [asset.label, asset.description, asset.prompt]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(query));
    return kindMatches && queryMatches;
  });
}

export function countLinkedShots(assetId: string, shots: Shot[]): number {
  return shots.filter((shot) => shot.asset_ids.includes(assetId)).length;
}
```

- [ ] **Step 5: Implement page state and upload contract**

`ResourceLibraryPage` owns `query`, `kind`, and one `ResourcePanelState`. Opening detail assigns `{ mode: "detail", assetId }`; opening upload assigns `{ mode: "upload" }`; closing assigns `{ mode: "closed" }`.

`AssetUploadDrawer` submits exactly:

```ts
{
  kind,
  label: label.trim(),
  description: description.trim(),
  prompt: prompt.trim(),
  file,
} satisfies ReferenceImageUploadRequest
```

The type selector contains only `角色` (`character`), `场景` (`scene`) and `道具` (`prop`). The detail drawer renders prompt, all available `reference_images`/`media_urls`, `countLinkedShots`, and a read-only consistency section only when relevant consistency issues reference linked shots.

- [ ] **Step 6: Implement binding through existing `saveShot` data**

The route adapter in Task 8 will implement `onBindAsset` by finding the shot, computing the next unique `asset_ids`, and calling:

```ts
await saveShotChanges(shotId, { asset_ids: nextAssetIds });
```

The resource page must not mutate `AssetRecord.shot_ids` locally.

- [ ] **Step 7: Run tests**

Run:

```powershell
npm test -- assetLibrary.test.ts ResourceLibraryPage.test.tsx
```

Expected: PASS; no unsupported resource category appears.

- [ ] **Step 8: Commit**

```powershell
git add web/src/components/resources web/src/pages/ResourceLibraryPage.tsx web/src/pages/ResourceLibraryPage.test.tsx web/src/i18n.ts
git commit -m "feat: add shot-aware resource library"
```

---

### Task 7: Build The Production And Final Preview Page

**Files:**

- Create: `web/src/components/production/WorkflowArtifacts.tsx`
- Create: `web/src/components/production/FinalRenderPanel.tsx`
- Create: `web/src/pages/ProductionPage.tsx`
- Create: `web/src/pages/ProductionPage.test.tsx`
- Modify: `web/src/components/JobProgress.tsx`
- Modify: `web/src/components/ConsistencyPanel.tsx`
- Modify: `web/src/i18n.ts`

**Interfaces:**

- Produces: `ProductionPage`, localized job/consistency panels, workflow artifact list and final render panel.
- Consumes: `JobEvent[]`, `WorkflowArtifactStatus[]`, `ConsistencyReport`, final render URL/path, render and download callbacks.

- [ ] **Step 1: Write the production page test**

Define a complete typed fixture at module scope:

```ts
const project = createProjectResponse();
const productionProps: ProductionPageProps = {
  consistencyReport: project.consistency_report,
  downloading: false,
  events: [],
  finalPath: null,
  finalRenderUrl: null,
  rendering: false,
  shotCount: project.storyboard.shots.length,
  workflowArtifacts: project.workflow_artifacts ?? [],
  onDownload: vi.fn().mockResolvedValue(undefined),
  onRender: vi.fn().mockResolvedValue(undefined),
};
```

Then add:

```tsx
it("shows progress, workflow artifacts, consistency and final preview", () => {
  render(<ProductionPage {...productionProps} finalPath="local://media/final" finalRenderUrl="blob:final" />);
  expect(screen.getByRole("heading", { name: "制作进度" })).toBeInTheDocument();
  expect(screen.getByText("storyboard.json")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "一致性检查" })).toBeInTheDocument();
  expect(screen.getByLabelText("最终成片预览")).toHaveAttribute("src", "blob:final");
});

it("keeps render and download as explicit actions", async () => {
  const onRender = vi.fn().mockResolvedValue(undefined);
  const onDownload = vi.fn().mockResolvedValue(undefined);
  render(<ProductionPage {...productionProps} onRender={onRender} onDownload={onDownload} />);
  fireEvent.click(screen.getByRole("button", { name: "生成最终成片" }));
  await waitFor(() => expect(onRender).toHaveBeenCalledTimes(1));
  expect(onDownload).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
npm test -- ProductionPage.test.tsx
```

Expected: FAIL because `ProductionPage` is missing.

- [ ] **Step 3: Implement the page contract**

```ts
export interface ProductionPageProps {
  consistencyReport: ConsistencyReport | null;
  downloading: boolean;
  events: JobEvent[];
  finalPath: string | null;
  finalRenderUrl: string | null;
  rendering: boolean;
  shotCount: number;
  workflowArtifacts: WorkflowArtifactStatus[];
  onDownload: () => Promise<void>;
  onRender: () => Promise<void>;
}
```

Disable render when `shotCount === 0` or `rendering`; disable download without `finalPath` or while `downloading`. Keep media paths visible as secondary diagnostic text but wrap long paths.

- [ ] **Step 4: Localize existing review components**

Replace hard-coded English in `JobProgress` and `ConsistencyPanel` with Chinese labels from `i18n.ts`: `制作进度`, `暂无进行中的任务`, `一致性检查`, `暂无报告`, `未发现问题`. Preserve their current ARIA regions and severity/status details.

- [ ] **Step 5: Run tests**

Run:

```powershell
npm test -- ProductionPage.test.tsx App.test.tsx
```

Expected: PASS; current final render behavior remains covered.

- [ ] **Step 6: Commit**

```powershell
git add web/src/components/production web/src/pages/ProductionPage.tsx web/src/pages/ProductionPage.test.tsx web/src/components/JobProgress.tsx web/src/components/ConsistencyPanel.tsx web/src/i18n.ts
git commit -m "feat: add production and final preview page"
```

---

### Task 8: Extract Shared Workbench State And Wire Real Routes

**Files:**

- Modify: `web/src/app/workbench/types.ts`
- Modify: `web/src/app/workbench/snapshot.ts`
- Modify: `web/src/app/workbench/snapshot.test.ts`
- Create: `web/src/app/workbench/WorkbenchProvider.tsx`
- Create: `web/src/app/workbench/useWorkbench.ts`
- Create: `web/src/app/AppRoutes.tsx`
- Create: `web/src/app/AppRoutes.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/main.tsx`

**Interfaces:**

- Produces: `WorkbenchProvider`, `useWorkbench`, `AppRoutes`, route adapters for every page.
- Consumes: all existing API client functions, local database functions, media helpers and Tasks 1-7 page components.

- [ ] **Step 1: Define the shared context before moving behavior**

Create `types.ts` with these exact public members:

```ts
export interface WorkbenchBusyState {
  creating: boolean;
  downloading: boolean;
  optimizingShotId: string | null;
  regeneratingShotId: string | null;
  rendering: boolean;
  savingContinuity: boolean;
  savingProvider: boolean;
  savingShotId: string | null;
  uploadingReference: boolean;
}

export interface WorkbenchContextValue {
  snapshot: ShortDramaProjectResponse | null;
  selectedShotId: string | null;
  events: JobEvent[];
  error: string | null;
  finalRenderUrl: string | null;
  localMediaUrls: Partial<Record<LocalMediaRef, string>>;
  providerCredentials: ProviderCredentials;
  maskedKeys: GatewayKeySession["masked_keys"] | null;
  providerReady: boolean;
  busy: WorkbenchBusyState;
  openLocalProject: (projectId: string) => Promise<boolean>;
  createProject: (input: CreateProjectInput) => Promise<ShortDramaProjectResponse>;
  saveProvider: () => Promise<void>;
  updateProviderField: <K extends keyof ProviderCredentials>(key: K, value: ProviderCredentials[K]) => void;
  selectShot: (shotId: string) => void;
  optimizeShotPrompt: (shot: Shot, sourceText: string) => Promise<PromptOptimizeResponse>;
  saveShotChanges: (shotId: string, payload: ShotSaveRequest) => Promise<void>;
  regenerateSelectedShot: (shot: Shot) => Promise<void>;
  saveContinuity: (plan: ContinuityPlan) => Promise<void>;
  uploadReference: (payload: ReferenceImageUploadRequest) => Promise<void>;
  renderFinal: () => Promise<void>;
  downloadFinal: () => Promise<void>;
  resolveShotMedia: (shot: Shot) => string | null;
  clearError: () => void;
}
```

- [ ] **Step 2: Write pure snapshot tests**

Define `const snapshot = createProjectResponse();` and `const sampleShot = createShot();`, then cover these transitions before extraction:

```ts
it("replaces one shot while preserving project render metadata", () => {
  const next = replaceShotInSnapshot(snapshot, { ...sampleShot, prompt: "新提示词" });
  expect(next.storyboard.shots[0].prompt).toBe("新提示词");
  expect(next.final_path).toBe(snapshot.final_path);
});

it("builds a complete empty continuity plan for each project type", () => {
  expect(emptyContinuityPlan("single_video").active_episode_number).toBeNull();
  expect(emptyContinuityPlan("mini_series").active_episode_number).toBe(1);
  expect(emptyContinuityPlan("long_series").series_bible.relationship_map).toEqual([]);
});
```

- [ ] **Step 3: Move existing state and operations into the provider**

Move, without changing API payloads, these current `App.tsx` responsibilities:

- provider credentials and `saveGatewayKey`
- project snapshot application and `saveProjectSnapshot`
- local media cache/resolution/revocation and storage estimate refresh
- project event subscription
- `saveShot`, `optimizePrompt`, `regenerateShot`
- `saveContinuityPlan`, `uploadReferenceImage`, `renderProject`
- final video download

The creation implementation must be exact about omitted fields:

```ts
const result = await createShortDramaProject({
  title: input.title,
  prompt: input.prompt,
  project_type: input.project_type,
  ...providerCredentials,
});
await applyAndPersistProjectSnapshot({ ...result, final_path: null });
return result;
```

There is deliberately no `shot_count` property.

`openLocalProject(projectId)` must call `loadProjectSnapshot(projectId)`, apply `record.snapshot`, set the recent project ID, and return `false` without calling `/api/projects/latest` when no record exists.

- [ ] **Step 4: Write route tests before replacing `App`**

In `AppRoutes.test.tsx`, use the same hoisted API/local database mock shapes already present in `App.test.tsx`, and define these helpers:

```tsx
function renderAppAt(path: string) {
  window.history.pushState({}, "", path);
  return render(<App />);
}

async function enterProviderCredentials() {
  fireEvent.click(screen.getByRole("button", { name: "接口配置" }));
  fireEvent.change(screen.getByLabelText("文本 API Key"), { target: { value: "text-test-key" } });
  fireEvent.change(screen.getByLabelText("图片 API Key"), { target: { value: "image-test-key" } });
  fireEvent.change(screen.getByLabelText("视频 API Key"), { target: { value: "video-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "保存接口配置" }));
  await waitFor(() => expect(apiMocks.saveGatewayKey).toHaveBeenCalledTimes(1));
}

function submitNewProject() {
  fireEvent.change(screen.getByLabelText("项目标题"), { target: { value: "雨夜来信" } });
  fireEvent.change(screen.getByLabelText("故事与画面要求"), {
    target: { value: "一封信改变两个人的命运" },
  });
  fireEvent.click(screen.getByRole("button", { name: "AI 规划分镜" }));
}
```

Set the provider mock to this non-secret test session and define the project response, then add the route cases:

```ts
apiMocks.saveGatewayKey.mockResolvedValue({
  masked_keys: { text: "***text", image: "***image", video: "***video" },
  provider: "syapi",
  base_url: "https://example.invalid",
  models: { text: "text-model", image: "image-model", video: "video-model" },
  valid: true,
});
const projectWithEightShots = createProjectResponse({ shotCount: 8 });
```

Then add:

```tsx
it("restores the project named by a deep link from browser-local storage", async () => {
  localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue({
    id: "p1",
    title: "雨夜来信",
    updatedAt: "2026-07-10T08:00:00Z",
    snapshot: cloneProjectResponse(),
  });
  renderAppAt("/projects/p1/resources");
  await waitFor(() => expect(localProjectStoreMocks.loadProjectSnapshot).toHaveBeenCalledWith("p1"));
  expect(await screen.findByRole("heading", { name: "资源库" })).toBeInTheDocument();
});

it("shows a recoverable state for an unknown local project", async () => {
  localProjectStoreMocks.loadProjectSnapshot.mockResolvedValue(null);
  renderAppAt("/projects/missing/storyboard");
  expect(await screen.findByText("此项目不在当前浏览器中")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "返回项目列表" })).toHaveAttribute("href", "/projects");
});

it("routes a created project to its storyboard and reports the AI shot count", async () => {
  apiMocks.createShortDramaProject.mockResolvedValue(projectWithEightShots);
  renderAppAt("/projects/new");
  await enterProviderCredentials();
  submitNewProject();
  expect(await screen.findByText("AI 已为你规划 8 个分镜")).toBeInTheDocument();
  expect(window.location.pathname).toBe("/projects/p1/storyboard");
});
```

- [ ] **Step 5: Implement the final route tree**

Create `AppRoutes.tsx` with this route table:

```tsx
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate replace to="/projects" />} />
      <Route path="/projects" element={<RootLayout />}>
        <Route index element={<ProjectsPage />} />
        <Route path="new" element={<NewProjectRoute />} />
      </Route>
      <Route path="/projects/:projectId" element={<ProjectLayout />}>
        <Route index element={<Navigate replace to="storyboard" />} />
        <Route path="storyboard" element={<StoryboardRoute />} />
        <Route path="settings" element={<GlobalSettingsRoute />} />
        <Route path="resources" element={<ResourceLibraryRoute />} />
        <Route path="production" element={<ProductionRoute />} />
      </Route>
      <Route path="*" element={<Navigate replace to="/projects" />} />
    </Routes>
  );
}
```

`ProjectLayout` reads `projectId`, calls `openLocalProject` when it differs from `snapshot.project.id`, renders a stable loading state during the request, and renders the missing-project state on `false`. It wraps the outlet in `AppShell` using the active project and `ProviderDrawer`.

- [ ] **Step 6: Wire page adapters to existing operations**

Use `useWorkbench()` in route adapters. The resource binding adapter must compute IDs without duplicates:

```ts
async function bindAsset(shotId: string, assetId: string, bind: boolean) {
  const shot = snapshot?.storyboard.shots.find((item) => item.id === shotId);
  if (!shot) return;
  const nextAssetIds = bind
    ? Array.from(new Set([...shot.asset_ids, assetId]))
    : shot.asset_ids.filter((id) => id !== assetId);
  await saveShotChanges(shotId, { asset_ids: nextAssetIds });
}
```

The new project route calls `createProject`, then navigates with:

```ts
navigate(projectRoutes.storyboard(result.project.id), {
  state: { plannedShotCount: result.storyboard.shots.length },
});
```

The storyboard route reads this number and passes it to `StoryboardPage` for the AI planning notice.

- [ ] **Step 7: Reduce the application entry point**

Replace `App.tsx` with:

```tsx
import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./app/AppRoutes";
import { WorkbenchProvider } from "./app/workbench/WorkbenchProvider";

export default function App() {
  return (
    <BrowserRouter>
      <WorkbenchProvider>
        <AppRoutes />
      </WorkbenchProvider>
    </BrowserRouter>
  );
}
```

Remove the now-extracted inline `ProjectTypeSelector`, `ContinuityEditor`, `ResourceLibrary`, `StudioView`, `STUDIO_VIEWS` and single-page three-aside markup from `App.tsx`. Do not delete existing API or local database modules.

- [ ] **Step 8: Run route and regression tests**

Run:

```powershell
npm test -- snapshot.test.ts AppRoutes.test.tsx App.test.tsx
```

Expected: PASS; route tests prove refresh/deep-link loading, local missing-project behavior, and AI shot count notice.

- [ ] **Step 9: Commit**

```powershell
git add web/src/app web/src/App.tsx web/src/App.test.tsx web/src/main.tsx
git commit -m "feat: route the multi-page workbench"
```

---

### Task 9: Finish Visual System Responsive Behavior And Regression Coverage

**Files:**

- Create: `web/src/styles/pages.css`
- Create: `web/src/styles/responsive.css`
- Modify: `web/src/styles/shell.css`
- Modify: `web/src/styles.css`
- Modify: `web/src/main.tsx`
- Modify: `web/src/i18n.ts`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/pages/*.test.tsx`

**Interfaces:**

- Produces: the approved bright SaaS visual system at desktop, tablet and mobile sizes.
- Consumes: the route/page class names created in Tasks 1-8 and preview images named in the design spec.

- [ ] **Step 1: Add page layout CSS with stable tracks**

The desktop storyboard layout must use constrained tracks rather than content-sized columns:

```css
.storyboard-workspace {
  display: grid;
  grid-template-columns: minmax(220px, 260px) minmax(420px, 1fr) minmax(320px, 380px);
  min-height: calc(100vh - 64px);
  overflow: hidden;
}

.storyboard-stage {
  display: grid;
  grid-template-rows: minmax(360px, 1fr) 116px;
  min-width: 0;
}

.shot-preview-media {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: contain;
  background: #111827;
}

.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.asset-card,
.project-item {
  border: 1px solid var(--om-border);
  border-radius: var(--om-radius);
  background: var(--om-surface);
}
```

No card may contain another card-styled container. Page sections use unframed bands or borders between regions.

- [ ] **Step 2: Add tablet and mobile modes**

Use exact breakpoints from the spec:

```css
@media (max-width: 1179px) {
  .storyboard-workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .storyboard-shot-list,
  .shot-editor {
    position: fixed;
    inset-block: 56px 0;
    width: min(380px, 92vw);
    z-index: 30;
    background: var(--om-surface);
  }
}

@media (max-width: 767px) {
  .workbench-topbar {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .workbench-project-title {
    grid-column: 1 / -1;
  }

  .project-navigation {
    overflow-x: auto;
    white-space: nowrap;
  }

  .settings-grid,
  .resource-layout,
  .production-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

Add a segmented view control on mobile for `分镜列表`, `预览`, `分镜检查器`; it changes visibility without unmounting a dirty `ShotEditor`.

- [ ] **Step 3: Remove obsolete visual rules**

Delete only selectors from `styles.css` that belong to the removed `.app-shell`, `.left-rail`, `.workspace`, `.right-panel`, `.studio-nav` and old inline resource/continuity layouts. Preserve reusable button, form, status, media and visually-hidden rules until their new equivalents are verified.

Set the final stylesheet order in `main.tsx` so legacy reusable rules cannot override the new page system:

```ts
import "./styles/tokens.css";
import "./styles.css";
import "./styles/shell.css";
import "./styles/pages.css";
import "./styles/responsive.css";
```

- [ ] **Step 4: Add accessibility regression assertions**

Extend tests to assert:

- icon-only buttons have `aria-label` and `title`;
- drawers use `role="dialog"`, move initial focus inside, close on Escape and return focus to the opener;
- status pills include visible text;
- mobile segmented controls expose `aria-selected`;
- async buttons retain stable text width while showing progress;
- delete confirmation does not run from Escape or cancel.

- [ ] **Step 5: Run all frontend tests**

Run from `web`:

```powershell
npm test
```

Expected: all Vitest suites PASS; no test expects `/api/projects/latest` during app boot.

- [ ] **Step 6: Run the production build**

```powershell
npm run build
```

Expected: TypeScript and Vite complete with exit code 0 and no unresolved route/page imports.

- [ ] **Step 7: Perform browser visual verification**

Start the existing backend and frontend in separate terminals:

```powershell
uvicorn server.app.main:create_app --factory --host 127.0.0.1 --port 8787
```

```powershell
cd web
npm run dev -- --port 5173
```

Use the browser control skill to capture and inspect these viewports:

1. `1440x900`: `/projects`, `/projects/new`, storyboard, settings, resources, production.
2. `1024x768`: storyboard list panel and inspector panel opened separately.
3. `390x844`: each mobile storyboard segment, resource upload drawer, global settings form.

Expected: no text clipping, overlap, nested cards, purple gradient, blank media area caused by broken URLs, or simultaneous resource detail/upload drawers. The top-level brand, current project, `接口配置` and `充值` remain visible or reachable at every viewport.

- [ ] **Step 8: Verify the critical manual workflow**

1. Open `/projects` and import or create a browser-local project.
2. Create with title and master prompt; confirm the request contains no `shot_count` and the UI reports the returned shot count.
3. Open every returned shot; confirm each initial `prompt` appears.
4. Run `AI 优化提示词`; confirm prompt, intent and shot language change locally, then undo.
5. Optimize again; confirm no save or regenerate request occurs until the corresponding explicit button is clicked.
6. Save, then regenerate; refresh the deep link and confirm the same project/page returns.
7. Save global settings and confirm completed shots did not change.
8. Open a resource detail, then upload; confirm only one panel is visible. Bind a resource to the current shot.
9. Open production, inspect event progress and consistency, render, preview and download the final video.
10. Click `充值`; confirm only `功能开发中` appears and the URL does not change.

- [ ] **Step 9: Commit**

```powershell
git add web/src/styles/tokens.css web/src/styles/shell.css web/src/styles/pages.css web/src/styles/responsive.css web/src/styles.css web/src/main.tsx web/src/i18n.ts web/src/App.test.tsx web/src/pages/ProjectsPage.test.tsx web/src/pages/NewProjectPage.test.tsx web/src/pages/StoryboardPage.test.tsx web/src/pages/GlobalSettingsPage.test.tsx web/src/pages/ResourceLibraryPage.test.tsx web/src/pages/ProductionPage.test.tsx
git commit -m "style: finish responsive workbench optimization"
```

---

## Final Verification

- [ ] Confirm the repository contains no frontend route for login, wallet, recharge, subscription, templates or settings outside project global settings:

```powershell
rg -n "wallet|pricing|subscription|template-market|/login|/recharge" web/src
```

Expected: no route definitions; copy may mention that recharge is in development only.

- [ ] Confirm project creation never sends a shot count:

```powershell
rg -n "shot_count" web/src
```

Expected: only domain type definitions or tests asserting omission; no creation payload assignment.

- [ ] Confirm no credential or gateway secret was added to source or plan artifacts:

```powershell
rg -n "sk-[A-Za-z0-9_-]{12,}" web/src docs/superpowers
```

Expected: no matches.

- [ ] Run the full frontend gate:

```powershell
cd web
npm test
npm run build
```

Expected: all tests PASS and build exits 0.

- [ ] Review `git status --short` and verify each implementation commit contains only files from its task. Preserve all unrelated pre-existing changes.

## Requirement Traceability

| Confirmed requirement | Implemented by |
| --- | --- |
| 方案 C 多页面工作台 | Tasks 1, 4, 8, 9 |
| 工作台优先，无登录/钱包/模板库 | Global Constraints, Tasks 1, 8, Final Verification |
| 充值预留并显示开发中 | Tasks 1, 9 |
| 接口配置保留为紧凑抽屉 | Tasks 1, 8 |
| AI 自动决定分镜数并自动填充分镜提示词 | Tasks 2, 8 |
| 每个分镜都有 AI 一键优化提示词 | Tasks 3, 4 |
| AI 优化、保存、重新生成严格分离 | Task 3 |
| 全局设定按项目类型裁剪 | Task 5 |
| 资源库只有角色/场景/道具 | Task 6 |
| 资源详情与上传互斥 | Task 6 |
| 现有制作进度、一致性和成片能力 | Task 7 |
| 浏览器本地项目和媒体行为保留 | Tasks 2, 8 |
| 桌面/平板/手机无重叠 | Task 9 |
