# mise studio 前端优化执行计划

日期: 2026-07-15  
状态: 已确认设计方向, 待进入生产前端实施  
品牌: `mise studio`  
品牌标语: `让想法入镜`

## 1. 目标

将现有 `web/src` 生产前端改造成一套接近 YouMind 产品气质的视频创作工作台, 并完整落地以下创作流程:

1. 用户先与 AI 讨论灵感。
2. AI 整理创作意图, 用户明确确认后才进入规划。
3. 系统自动规划世界观、人物、场景、道具、声音和分镜提示词。
4. 每个蓝图分类都可单独确认或要求修改。
5. 所有必需分类确认后, 用户再执行一次最终确认。
6. 最终确认前, 禁止图片生成、视频生成和最终渲染。
7. 已确认蓝图成为分镜编辑、一致性控制、资源生成和成片制作的唯一上游依据。

本计划的交付目标不是继续扩展静态概念稿, 而是将已经确认的设计语言迁入真实 React 前端, 接通当前项目数据、账户、计费、生成、资源和渲染能力。

## 2. 已确认的产品方向

### 2.1 品牌

- 用户可见品牌统一为 `mise studio`, 标识采用小写 `m` 或 `mise` 字标。
- 中文标语使用 `让想法入镜`。
- 页面标题、登录文案、AI 助手身份、空状态和导出设计图统一使用 `mise`。
- 本轮只改用户界面品牌。仓库名、Python 包名、API 路径、历史 artifact 字段和兼容性标识继续保留 `OpenMontage`, 避免无关迁移风险。
- 禁止把用户提供过的 API Key、网关地址或任何密钥写入前端代码、截图、测试 fixture 和浏览器存储。

### 2.2 视觉语言

参考 YouMind 的产品界面组织方式, 但不复制其品牌资产、文案或专有图形。

- 使用 52px 轻量顶部栏, 不使用永久深色侧边栏。
- 大面积白色和近白色画布, 内容依赖留白、排版和轻边线建立层级。
- 首页以大输入编辑器作为第一视觉焦点, 项目历史退居次级区域。
- 工作区采用“对话 / 内容列表 / 可编辑文档或预览画布”的结构。
- 主操作使用近黑色胶囊按钮; 次操作使用透明图标按钮或轻描边按钮。
- 模式选择使用浅色选中胶囊; 状态使用低饱和绿、琥珀和红, 不使用大面积蓝紫渐变。
- 除命令胶囊外, 内容卡片圆角不超过 8px。
- 不嵌套卡片, 不使用装饰光球、渐变背景、厚重阴影或营销式大 Hero。
- 所有工具按钮优先使用 `lucide-react`, 陌生图标必须带 `title` 或 Tooltip。

### 2.3 设计基线

实现时以以下现有高保真稿为视觉基线:

- 总览图: `output/frontend-youmind-complete-design/00-contact-sheet.png`
- 登录: `01-login.png`
- 注册: `02-register.png`
- 账户恢复: `03-account-recovery.png`
- 创作首页: `04-projects.png`
- 灵感对话: `05-inspiration-chat.png`
- 创作蓝图: `06-creative-blueprint.png`
- 分镜工作区: `07-storyboard-studio.png`
- 全局设定: `08-global-settings.png`
- 资源库: `09-resource-library.png`
- 制作与成片: `10-production.png`
- 钱包: `11-wallet.png`
- 订单: `12-orders.png`
- 计费后台: `13-billing-admin.png`

可交互参考原型位于 `web/design-preview/`。该目录只作为视觉参考, 不得成为生产前端运行依赖。

## 3. 范围

### 3.1 本轮包含

- 统一品牌、字体、颜色、间距、按钮、输入框、导航、状态和反馈组件。
- 重构登录、注册、账户恢复、创作首页和项目列表。
- 重构灵感对话、创意意图确认、自动规划等待态和创作蓝图确认。
- 增加世界观、人物、场景、道具、声音、分镜六类蓝图的持久化确认状态。
- 重构分镜、全局设定、资源库、制作与成片页面。
- 重构钱包、订单和计费管理页面。
- 完整响应式、键盘操作、焦点状态、错误状态、空状态、加载状态和只读状态。
- 自动化测试、生产构建、浏览器验收和 13 张最终截图。

### 3.2 本轮不包含

- 不生成新的电影资产, 沿用已有项目图片和媒体。
- 不把设计原型直接复制成生产代码。
- 不更换 React、React Router、Vite、Vitest、IndexedDB/OPFS 等现有技术栈。
- 不重命名后端仓库、API namespace 或历史项目 artifact。
- 不新增复杂时间线剪辑器、多人实时协作或模板市场。
- 不允许纯前端伪造蓝图确认状态。

## 4. 信息架构与路由

| 页面 | 生产路由 | 原型屏幕 | 主要任务 |
|---|---|---|---|
| 登录 | `/login` | `login` | 登录并回到原请求页面 |
| 注册 | `/register` | `register` | 创建创作者账户 |
| 找回账户 | `/forgot-password`, `/reset-password` | `recovery` | 请求和完成密码重置 |
| 创作首页 | `/projects` | `projects` | 输入想法、选择模式、打开历史项目 |
| 新建项目 | `/projects/new` | 合并进 `projects` | 创建空项目并进入灵感对话 |
| 灵感对话 | `/projects/:id/idea` | `inspiration` | 讨论想法并确认创作意图 |
| 创作蓝图 | `/projects/:id/plan-review` | `blueprint` | 审核六类规划并最终确认 |
| 分镜工作区 | `/projects/:id/storyboard` | `storyboard` | 编辑、优化、保存、生成单镜头 |
| 全局设定 | `/projects/:id/settings` | `settings` | 管理世界观与连续性 |
| 资源库 | `/projects/:id/resources` | `resources` | 查看、生成、上传、绑定资源 |
| 制作与成片 | `/projects/:id/production` | `production` | 检查产物、进度、成片和下载 |
| 钱包 | `/wallet` | `wallet` | 余额、充值和流水 |
| 订单 | `/orders` | `orders` | 订单查询与状态 |
| 计费管理 | `/admin/billing` | `admin` | 管理员订单、额度和风险操作 |

项目内顶部阶段固定为:

`灵感 -> 蓝图 -> 分镜 -> 成片`

- 已完成阶段显示勾选状态。
- 当前阶段显示深色选中状态。
- 未解锁阶段不可点击, 并说明解锁条件。
- 全局设定和资源库属于分镜阶段的工具视图, 不单独占用主阶段。

## 5. 创作流程状态机

### 5.1 用户可见状态

| 状态 | 允许操作 | 禁止操作 | 默认路由 |
|---|---|---|---|
| `inspiration` | 对话、补充、调整想法 | 规划、资源生成、视频生成、渲染 | `idea` |
| `intent_ready` | 继续对话、确认创作意图 | 资源生成、视频生成、渲染 | `idea` |
| `planning` | 查看真实等待状态、取消返回 | 重复提交、资源生成、视频生成、渲染 | `idea` |
| `plan_review` | 审核、修改、确认蓝图分类 | 图片生成、视频生成、渲染 | `plan-review` |
| `approved` | 分镜、资源、生成、渲染 | 无创作门禁限制 | `storyboard` |

服务端仍可保留现有 `CreativeWorkflowPhase = inspiration | plan_review | approved`, 其中 `intent_ready` 由 `ready_to_confirm` 派生, `planning` 由正在执行的 operation 派生。不要为了瞬时 UI 状态扩大持久化枚举。

### 5.2 蓝图确认模型

在 `CreativeWorkflow` 中增加以下兼容字段:

```ts
export type PlanSectionId =
  | "worldview"
  | "characters"
  | "scenes"
  | "props"
  | "sound"
  | "storyboard";

export type PlanSectionStatus =
  | "pending"
  | "approved"
  | "changes_requested";

export interface PlanSectionApproval {
  status: PlanSectionStatus;
  revision: number;
  feedback: string | null;
  updated_at: string | null;
}

export interface CreativeWorkflow {
  // 保留现有字段
  phase: "inspiration" | "plan_review" | "approved";
  messages: InspirationMessage[];
  brief: CreativeBrief | null;
  ready_to_confirm: boolean;
  planned_asset_ids: string[];
  approved_at: string | null;

  // 新增兼容字段
  brief_confirmed_at?: string | null;
  plan_generated_at?: string | null;
  plan_sections?: Record<PlanSectionId, PlanSectionApproval>;
}
```

兼容规则:

- 旧项目 `phase = approved` 时, 缺失的 `plan_sections` 读取为全部 `approved`。
- 旧项目 `phase = plan_review` 时, 缺失的 `plan_sections` 读取为全部 `pending`。
- 新项目只有在六类 section 全部为 `approved` 时才能进入最终批准。
- 任何 section 重新规划后, 其 `revision` 增加并恢复为 `pending`。
- 世界观修改会使人物、场景、道具和分镜重新待确认。
- 人物、场景或道具修改会使对应 section 和分镜重新待确认。
- 声音修改只重置声音; 如果声音提示直接写入分镜, 同时重置分镜。
- 分镜修改只重置分镜。

### 5.3 最小后端接口扩展

保留现有接口:

- `POST /api/projects/:id/inspiration/chat`
- `POST /api/projects/:id/storyboard/plan`
- `POST /api/projects/:id/storyboard/approve`

新增:

```text
PATCH /api/projects/:id/creative-plan/sections/:section
body: { status: "approved" | "changes_requested", feedback?: string, revision: number }

POST /api/projects/:id/creative-plan/revise
body: { sections: PlanSectionId[], feedback: string }
```

接口要求:

- section 更新使用 `revision` 做乐观并发检查, 过期版本返回 `409`。
- `storyboard/approve` 在任一必需 section 未确认时返回 `409` 和结构化缺失项。
- revise 只重算受影响的文本规划和提示词, 不触发图片或视频生成。
- 所有生成图片、生成视频、重新生成镜头和最终渲染接口继续调用统一的 `_require_approved_creative_workflow` 门禁。
- 直接访问深链接也不能绕过门禁。

## 6. 设计系统

### 6.1 Token 基线

在 `web/src/styles/tokens.css` 统一维护, 页面禁止重复声明品牌色和尺寸。

```css
:root {
  --mise-canvas: #fbfbfa;
  --mise-surface: #ffffff;
  --mise-ink: #171717;
  --mise-muted: #71716d;
  --mise-faint: #9a9a94;
  --mise-line: #e8e8e4;
  --mise-line-strong: #d8d8d2;
  --mise-selection: #f1f1ee;
  --mise-success: #2f7654;
  --mise-warning: #9a6818;
  --mise-danger: #b42318;
  --mise-radius-sm: 4px;
  --mise-radius-md: 8px;
  --mise-pill: 999px;
  --mise-topbar-height: 52px;
  --mise-content-max: 1440px;
}
```

正式实现时可调整色值, 但必须通过文字和控件对比度检查。不得为了“更有设计感”引入蓝紫渐变或大面积单色主题。

### 6.2 组件清单

优先复用和改造, 不引入新的 UI 框架:

- `MiseLogo`
- `TopBar`
- `StageNavigation`
- `IconButton`
- `PrimaryCommand`
- `OutlineCommand`
- `ModeSelector`
- `SegmentedControl`
- `StatusBadge`
- `Composer`
- `ArtifactList`
- `DocumentCanvas`
- `ConfirmationBar`
- `SectionApprovalControl`
- `LoadingSurface`
- `EmptySurface`
- `CommandErrorNotice`
- `ConfirmDialog`
- `ToastRegion`

组件约束:

- 可点击图标必须有可访问名称。
- 二元设置使用开关或复选框, 不使用文字胶囊伪装。
- 多选项使用 segmented control、tab 或 menu。
- 数值使用 input、stepper 或 slider。
- 工具操作使用图标按钮, 清晰命令使用图标加文字。
- hover、focus-visible、disabled、loading、success、error 状态必须齐全。

## 7. 分阶段执行

### Phase 0: 冻结现有行为基线

目标: 在改视觉前锁住真实业务能力, 防止“页面变好看但功能退化”。

- [ ] 记录当前路由、权限、项目加载、钱包、订单和管理员访问矩阵。
- [ ] 补齐创意流程、深链接重定向和生成门禁的 characterization tests。
- [ ] 运行并保存当前 `npm.cmd test -- --run` 与 `npm.cmd run build` 结果。
- [ ] 保留现有工作树中的用户改动, 不回退或覆盖无关文件。

主要文件:

- `web/src/app/AppComposition.test.tsx`
- `web/src/app/AppRoutes.test.tsx`
- `web/src/pages/*.test.tsx`
- `server/tests/test_api.py`
- `server/tests/test_project_ownership.py`

验收:

- 当前测试基线可复现。
- 所有 13 个目标页面都有至少一个路由级断言。
- 未批准项目调用生成或渲染接口时有明确失败断言。

### Phase 1: 品牌与设计系统基础

目标: 先替换全局视觉语言, 不在每个页面重复写样式。

- [ ] 新增 `MiseLogo`, 替换所有用户可见 `OpenMontage` 品牌。
- [ ] 重写 token、全局 typography、focus ring 和基础表单样式。
- [ ] 建立黑色主命令、透明图标按钮、轻描边按钮和模式胶囊。
- [ ] 保留现有错误边界、Toast 和账户/计费 slot 接口。
- [ ] 更新 `index.html` 的 title、description 和主题色。

主要文件:

- `web/index.html`
- `web/src/components/brand/MiseLogo.tsx` (新建)
- `web/src/components/ui/*` (按需新建)
- `web/src/styles/tokens.css`
- `web/src/styles.css`

验收:

- 全局无旧品牌用户文案。
- 颜色、圆角、阴影和字号均来自 token。
- 按钮尺寸在 loading 时不跳动。
- 键盘焦点清晰可见。

### Phase 2: 顶部栏与全局导航

目标: 用轻量顶部栏取代当前后台式框架。

- [ ] 将 `AppShell` 改成 52px 顶部栏和无永久侧栏布局。
- [ ] 首页显示“创作 / 资源 / 额度 / 订单”导航。
- [ ] 项目页显示返回、项目名、当前阶段和四步进度。
- [ ] 右侧保留通知、额度和账户菜单, 窄屏折叠为可访问菜单。
- [ ] 路由切换继续执行未保存内容保护。

主要文件:

- `web/src/components/shell/AppShell.tsx`
- `web/src/components/shell/AppShell.test.tsx`
- `web/src/app/routeModules/workbenchRoutes.tsx`
- `web/src/styles/shell.css`
- `web/src/styles/responsive.css`

验收:

- 桌面没有永久深色侧栏。
- 顶栏高度稳定, 页面切换不跳动。
- 390px 宽度下没有横向滚动或控件重叠。
- 未保存分镜时返回、切路由和浏览器后退都仍会提示。

### Phase 3: 账户页面

目标: 交付登录、注册、找回账户三个完整状态。

- [ ] 用单列安静布局重构 AuthForm, 品牌为 `mise`。
- [ ] 补齐密码显示、提交中、字段错误、服务错误和成功反馈。
- [ ] 保持受保护深链接登录后返回原地址。
- [ ] 更新示例邮箱和无障碍标签, 不在 UI 暴露内部服务名。

主要文件:

- `web/src/auth/AuthForm.tsx`
- `web/src/auth/auth.css`
- `web/src/pages/LoginPage.tsx`
- `web/src/pages/RegisterPage.tsx`
- `web/src/pages/ForgotPasswordPage.tsx`
- `web/src/pages/ResetPasswordPage.tsx`

验收:

- 登录、注册、找回账户和重置密码均有测试。
- 表单错误不会改变整体宽高造成明显抖动。
- 触屏控件最小点击区域为 44px。

### Phase 4: 创作首页与项目历史

目标: 第一屏直接开始创作, 项目管理退居次级。

- [ ] 将新建项目入口合并为首页大 Composer。
- [ ] 提供视频模式、比例、时长和项目类型选择, 使用模式胶囊和菜单。
- [ ] 提交后先创建空项目, 再进入 `/idea`, 不直接生成分镜。
- [ ] 下方显示最近项目、搜索、状态、更新时间和更多菜单。
- [ ] 保留导入、导出、删除、本地缓存和只读恢复能力。

主要文件:

- `web/src/pages/ProjectsPage.tsx`
- `web/src/pages/NewProjectPage.tsx`
- `web/src/app/routeModules/workbenchRoutes.tsx`
- `web/src/features/projects/ProjectRepository.ts`
- `web/src/styles/pages.css`

验收:

- 首页首屏焦点是创作输入, 不是项目卡片墙。
- 创建项目只产生空 storyboard 和 inspiration workflow。
- 导入、导出、删除和离线只读行为无回归。
- 初始想法会在进入灵感页后自动发送一次, 不重复发送。

### Phase 5: 创作流程后端契约

目标: 为真实的分类确认和生成门禁提供持久化支持。

- [ ] 扩展 creative workflow schema 和默认值。
- [ ] 增加 section 确认和 revise 接口。
- [ ] 在最终 approve 中校验六类 section。
- [ ] 实现 revision 冲突、依赖失效和旧项目兼容。
- [ ] 统一审计所有图片、视频、镜头重生成和 render 路径的批准门禁。
- [ ] 在客户端类型、API client、ProjectRepository、GenerationService 和 reducer 中接入新字段与 operation。

主要文件:

- `server/app/main.py`
- `server/app/schemas.py` 或当前请求模型所在模块
- `server/tests/test_api.py`
- `server/tests/test_project_ownership.py`
- `web/src/domain/types.ts`
- `web/src/api/client.ts`
- `web/src/features/projects/ProjectRepository.ts`
- `web/src/features/generation/GenerationService.ts`
- `web/src/features/workbench/reducer.ts`
- `web/src/features/workbench/WorkbenchSessionProvider.tsx`
- `web/src/app/workbench/types.ts`

验收:

- section 状态刷新页面后仍存在。
- 两个浏览器同时修改同一 revision 时, 后提交者收到可恢复的冲突提示。
- 任一 section 未确认时最终批准返回结构化 `409`。
- 未批准项目无法通过任何直连 API 生成媒体或成片。

### Phase 6: 灵感对话与创意意图确认

目标: 用户先把想法说清楚, 确认后才进行昂贵或长耗时规划。

- [ ] 页面采用左侧连续对话、右侧实时创意简报结构。
- [ ] AI 助手身份改为 `mise`。
- [ ] 简报展示标题、logline、受众、形式、时长、比例、类型、情绪、视觉方向、故事轮廓和必须保留项。
- [ ] `ready_to_confirm = false` 时明确列出仍待回答的问题。
- [ ] 用户点击“确认创意并开始规划”后锁定重复提交, 展示真实等待态。
- [ ] 规划失败保留对话和简报, 允许重试, 不产生半批准状态。

主要文件:

- `web/src/pages/InspirationPage.tsx`
- `web/src/pages/InspirationPage.test.tsx`
- `web/src/components/chat/*` (按需拆分)
- `web/src/styles/pages.css`

验收:

- 用户未点击确认前不会调用 `/storyboard/plan`。
- 对话滚动、输入区和右侧简报在桌面无互相挤压。
- 移动端使用“对话 / 简报”分段视图, 不把两列硬压缩。
- 失败和重试不会重复追加用户消息。

### Phase 7: 创作蓝图与分类确认

目标: 让用户在媒体生成前真正掌控文本规划。

- [ ] 左侧显示 artifact 列表和六类确认进度。
- [ ] 右侧采用文档画布展示当前分类的内容和提示词。
- [ ] 每类提供“确认此部分”和“要求修改”命令。
- [ ] 修改使用反馈输入和明确影响范围提示。
- [ ] section 已确认后显示版本和确认时间。
- [ ] revision 冲突时刷新最新版本, 保留用户反馈草稿。
- [ ] 底部最终确认按钮只有在六类全部确认时可用。
- [ ] 最终确认后进入分镜工作区并锁定蓝图版本。

六类蓝图内容:

| 分类 | 必须展示 |
|---|---|
| 世界观 | 时空、规则、叙事边界、主线、视觉规则 |
| 人物 | 角色定位、外貌锁定、服装、表演、人物提示词 |
| 场景 | 地点、时间、光线、空间关系、场景提示词 |
| 道具 | 外观、材质、叙事用途、连续性、道具提示词 |
| 声音 | 旁白、对白、环境声、音乐方向、声音提示词 |
| 分镜 | 节拍、景别、机位、运动、镜头时长、画面提示词 |

主要文件:

- `web/src/pages/PlanReviewPage.tsx`
- `web/src/pages/PlanReviewPage.test.tsx`
- `web/src/components/blueprint/*` (新建)
- `web/src/styles/pages.css`

验收:

- 分类切换不会丢失当前反馈草稿。
- 确认、修改、等待、冲突和失败状态均有测试。
- 六类未全部通过时不能进入分镜、资源和生产路由。
- 蓝图阶段无任何图片或视频生成按钮。

### Phase 8: 分镜工作区

目标: 保留真实编辑能力, 改造成更安静的内容工作台。

- [ ] 左侧为可滚动分镜列表, 中间为稳定 16:9 或项目比例预览, 右侧为检查器。
- [ ] 下方顺序条继续只负责选择, 不伪装成未实现的时间线剪辑器。
- [ ] 分镜检查器保留节拍、景别、机位、镜头运动、镜头语言、提示词、角色和资源绑定。
- [ ] 清楚分离 AI 优化、保存修改和重新生成视频三个命令。
- [ ] 重新生成前显示额度和绑定资源摘要。
- [ ] 所有动态状态不得改变预览画布尺寸。

主要文件:

- `web/src/pages/StoryboardPage.tsx`
- `web/src/components/storyboard/ShotList.tsx`
- `web/src/components/storyboard/ShotPreview.tsx`
- `web/src/components/storyboard/ShotOrderStrip.tsx`
- `web/src/components/ShotEditor.tsx`
- `web/src/styles/pages.css`
- `web/src/styles/responsive.css`

验收:

- AI 优化只修改未保存草稿, 不自动保存或生成。
- 保存不触发生成, 生成不掩盖未保存修改。
- 预览比例稳定, 图片、视频、空状态和 loading 不引发布局跳动。
- 移动端使用“列表 / 预览 / 检查器”三段视图。

### Phase 9: 全局设定与资源库

目标: 将连续性和媒体资产作为分镜的辅助工具, 保持信息密度但避免后台表格感。

- [ ] 全局设定改成左侧目录和右侧文档编辑区。
- [ ] 分离世界观、人物连续性、视觉规则、声音和项目级生成偏好。
- [ ] 明确提示全局设定只影响后续优化和生成, 不自动重写已完成分镜。
- [ ] 资源库采用轻量过滤工具栏和媒体网格。
- [ ] 资源详情、上传和生成使用抽屉, 不嵌套卡片。
- [ ] 角色、场景、道具使用不同图标和清晰文字, 不只靠颜色区分。
- [ ] 保留项目资源 / 全部资源切换、搜索、绑定、上传、生成和媒体缓存。

主要文件:

- `web/src/pages/GlobalSettingsPage.tsx`
- `web/src/components/continuity/ContinuityEditor.tsx`
- `web/src/pages/ResourceLibraryPage.tsx`
- `web/src/components/resources/AssetGrid.tsx`
- `web/src/components/resources/AssetDetailDrawer.tsx`
- `web/src/components/resources/AssetGenerationDrawer.tsx`
- `web/src/components/resources/AssetUploadDrawer.tsx`

验收:

- 保存连续性不会自动生成媒体。
- 资源绑定后, 分镜、资源库和 artifact 中的关联保持一致。
- 抽屉具备焦点锁定、Esc 关闭、返回焦点和离开确认。
- 缩略图失败有可识别的降级状态。

### Phase 10: 制作与成片

目标: 让用户能清楚理解生产状态, 但不把页面做成运维仪表盘。

- [ ] 主区域以成片预览和当前生产状态为核心。
- [ ] 左侧或下方展示 workflow artifact, 一致性和镜头完成情况。
- [ ] 实时事件流映射为用户可理解的步骤和错误。
- [ ] 渲染前显示将生成 / 复用的镜头数量、预计额度和输出规格。
- [ ] 渲染中禁用重复提交, 但允许离开后返回恢复状态。
- [ ] 成片完成后提供预览、下载和重新制作入口。

主要文件:

- `web/src/pages/ProductionPage.tsx`
- `web/src/components/production/WorkflowArtifacts.tsx`
- `web/src/components/production/FinalRenderPanel.tsx`
- `web/src/components/JobProgress.tsx`

验收:

- 刷新页面后能恢复 render report 和 final video。
- SSE 断线、任务失败、额度不足和成功完成均有明确状态。
- 下载使用真实最终文件, 不使用设计图占位。
- 生成按钮不会因进度文字变化而缩放。

### Phase 11: 钱包、订单与管理后台

目标: 统一产品视觉, 同时保持操作型页面的扫描效率。

- [ ] 钱包展示可用、冻结、总额度, 充值套餐和流水。
- [ ] 订单使用简洁表格、筛选、搜索和状态标签。
- [ ] 管理后台保留收入指标、订单、额度调整和二次审核提示。
- [ ] 危险操作使用确认对话框和明确原因输入。
- [ ] 账户菜单、钱包和订单之间可稳定往返。

主要文件:

- `web/src/pages/WalletPage.tsx`
- `web/src/pages/OrdersPage.tsx`
- `web/src/pages/admin/BillingAdminPage.tsx`
- `web/src/features/billing/*`
- `web/src/styles/pages.css`

验收:

- 支付返回、轮询、成功、失败和 pending 状态无回归。
- 非管理员不能访问 `/admin/billing`。
- 表格在窄屏转为可扫描列表, 不产生页面级横向滚动。

### Phase 12: 响应式、无障碍与性能收口

目标: 在常用桌面和移动视口都可完成核心工作流。

- [ ] 验收 `1600x1000`, `1440x900`, `1024x768`, `768x1024`, `390x844`。
- [ ] 全站检查水平溢出、文字截断、中文长词、按钮折行和固定区域重叠。
- [ ] 检查键盘导航顺序、focus-visible、对话框焦点、ARIA live 和表单 label。
- [ ] 尊重 `prefers-reduced-motion`。
- [ ] 图片使用稳定 aspect-ratio、合适尺寸和懒加载。
- [ ] 避免一次性渲染全部长列表, 需要时分页或虚拟化。
- [ ] 清理 console error、React warning、重复请求和未释放 object URL。

验收:

- Lighthouse Accessibility 目标不低于 95, 但以手动键盘验收为最终标准。
- 所有核心页面无 viewport overflow。
- 无文字和控件重叠。
- 首屏不依赖第三方字体或图片服务成功才能使用。

### Phase 13: 最终验证与设计图交付

目标: 同时证明“功能可用”和“视觉已落地”。

- [ ] 运行完整前端测试。
- [ ] 运行完整后端相关测试。
- [ ] 运行 TypeScript 和 Vite production build。
- [ ] 使用浏览器逐页完成主流程和错误流程。
- [ ] 在 1600x1000 重新导出 13 张生产前端截图。
- [ ] 生成 4x4 总览图, 标注页面名和最终品牌。
- [ ] 将截图输出到新的 `output/mise-studio-frontend-final/`, 不覆盖旧稿。
- [ ] 更新 README 中的产品截图和本地启动说明。

建议命令:

```powershell
cd web
npm.cmd test -- --run
npm.cmd run build

cd ..
.venv\Scripts\python.exe -m pytest server\tests\test_api.py server\tests\test_project_ownership.py
```

浏览器验收必须检查:

- 无 console error。
- 无失败静态资源。
- 无重复 mutation 请求。
- 所有按钮点击后有可见反馈。
- 所有抽屉、菜单、Tab 和阶段导航可操作。
- 桌面和移动端均可从首页走到蓝图最终确认。
- 未确认蓝图时无法生成任何图片、视频或成片。

## 8. 实施顺序和依赖

```text
Phase 0 行为基线
  -> Phase 1 设计系统
  -> Phase 2 全局壳层
  -> Phase 3 账户页面
  -> Phase 4 创作首页
  -> Phase 5 工作流契约
  -> Phase 6 灵感对话
  -> Phase 7 创作蓝图
  -> Phase 8 分镜
  -> Phase 9 设定与资源
  -> Phase 10 制作成片
  -> Phase 11 计费页面
  -> Phase 12 响应式与无障碍
  -> Phase 13 最终交付
```

可并行项仅限互不修改同一全局 CSS 和壳层文件的页面。Phase 1、2、5、12 必须串行收口, 否则容易产生样式冲突、状态契约漂移或重复返工。

## 9. 里程碑

| 里程碑 | 包含阶段 | 可验收结果 |
|---|---|---|
| M1 视觉骨架 | Phase 0-2 | 品牌、token、顶栏和阶段导航落地 |
| M2 创作入口 | Phase 3-4 | 账户和创作首页可用 |
| M3 核心闭环 | Phase 5-7 | 灵感、意图确认、六类蓝图确认真实可用 |
| M4 制作工作台 | Phase 8-10 | 分镜、连续性、资源和成片全部换肤且无回归 |
| M5 商业与收口 | Phase 11-13 | 钱包、订单、后台、响应式、测试和最终截图完成 |

## 10. 风险与处理

### 风险 1: 只改 CSS 导致结构仍像旧后台

处理: `AppShell`、首页、灵感页和蓝图页必须调整 DOM 和信息架构, 不接受仅换颜色和圆角。

### 风险 2: 前端显示分类确认, 后端没有真实状态

处理: Phase 5 先提供持久化契约和 API 测试, Phase 7 才接 UI。禁止 localStorage 伪造批准。

### 风险 3: 修改蓝图后旧分镜仍被视为已确认

处理: 使用 revision 和依赖失效规则, 后端负责原子更新, 前端只展示服务端事实。

### 风险 4: 大量全局 CSS 改动破坏旧页面

处理: 先建 token 和组件层, 页面分阶段迁移; 每个 Phase 都跑相关组件测试和截图检查。

### 风险 5: 视觉稿好看但真实数据溢出

处理: 测试超长项目名、超长中文提示词、空媒体、12+ 角色、30+ 分镜、低余额和多条错误消息。

### 风险 6: 用户密钥泄漏到浏览器

处理: 所有 provider 配置保留服务端托管; 前端只显示能力和计费结果, 不持久化或回显 provider secret。

## 11. 完成定义

只有同时满足以下条件, 才视为前端优化完成:

- [ ] 用户可见品牌已经统一为 `mise studio / 让想法入镜`。
- [ ] 13 个目标页面全部迁入真实 `web/src`, 不依赖 `design-preview`。
- [ ] 视觉与已确认高保真稿保持同一设计语言。
- [ ] 灵感对话后必须先确认创作意图, 才能自动规划。
- [ ] 世界观、人物、场景、道具、声音和分镜都有持久化确认状态。
- [ ] 六类全部确认前无法最终批准。
- [ ] 最终批准前无法通过 UI 或直连 API 生成图片、视频或成片。
- [ ] 分镜、设定、资源、制作、钱包、订单和后台原有能力无回归。
- [ ] 前端完整测试和 production build 通过。
- [ ] 相关后端 workflow 和 ownership 测试通过。
- [ ] 五个目标视口无溢出、重叠和不可操作控件。
- [ ] 浏览器控制台无错误, 静态资源无失败。
- [ ] 13 张 1600x1000 最终截图和一张总览图已输出。

## 12. 第一实施批次

开始编码时先执行以下最小批次, 完成后再进入核心工作流:

1. Phase 0: 补齐行为基线测试。
2. Phase 1: 建立 `mise` 品牌、token 和通用按钮。
3. Phase 2: 重构顶栏和阶段导航。
4. Phase 4: 将创作首页迁移到真实 React 页面。
5. 浏览器验证首页、项目列表和项目壳层。

第一批次不修改创作 workflow 数据结构。通过视觉骨架验收后, 再进入 Phase 5-7 的后端契约和确认闭环, 可以显著减少全局壳层与业务状态同时变化造成的回归范围。
