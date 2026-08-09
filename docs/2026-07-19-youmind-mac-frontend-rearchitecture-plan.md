# mise studio 前端质感升级与架构治理计划

日期：2026-07-19  
状态：待确认后执行  
目标风格：YouMind 的克制创作工具气质 + 轻盈、舒适的 Mac 桌面应用感

## 1. 结论

本轮不能继续在现有页面上零散追加圆角、阴影和动画。

视觉升级必须和前端架构治理一起完成，否则新的交互、动效和组件会继续堆进以下巨型文件：

- `web/src/features/workbench/WorkbenchSessionProvider.tsx`：1783 行
- `web/src/app/routeModules/workbenchRoutes.tsx`：935 行
- `web/src/components/ShotEditor.tsx`：811 行
- `web/src/pages/ResourceLibraryPage.tsx`：640 行
- `web/src/pages/InspirationPage.tsx`：526 行
- `web/src/styles/pages.css`：5633 行
- `web/src/styles/responsive.css`：1600 行
- `web/src/i18n.ts`：1774 行

计划采用“行为冻结、边界先行、逐页迁移”的方式：先建立清晰的功能模块和设计系统，再优先重做创作首页、灵感对话、蓝图和分镜工作区，最后统一辅助页面。

## 2. 与已有方案的关系

### 2.1 保留

保留 `docs/2026-07-15-mise-studio-frontend-optimization-execution-plan.md` 中已经落地或确认的产品规则：

- 灵感、蓝图、分镜、成片四阶段流程。
- 蓝图最终确认前不得生成图片、视频或成片。
- 项目资源、连续性、计费、恢复和本地备份能力。
- 现有路由、后端接口和持久化契约。
- 键盘操作、焦点管理和 `prefers-reduced-motion` 支持。

### 2.2 废弃

- `web/design-preview/` 不再作为视觉实现基线。
- `output/frontend-youmind-complete-design/` 只用于回顾信息架构，不作为最终质感标准。
- 不继续向 `pages.css`、`responsive.css` 和巨型页面组件中追加整页实现。
- 不采用一次性重写全部前端的“大爆炸”方式。

### 2.3 新的参考来源

最终视觉和动效以以下输入为准：

1. 用户提供的真实 YouMind 操作录屏或 GIF。
2. YouMind 中可观察的按钮、卡片、菜单、抽屉和页面切换行为。
3. Mac 桌面工具的通用交互原则：克制、连续、低噪声、直接反馈。
4. OpenMontage 自身的视频创作任务，而不是照搬其他产品的品牌资产和文案。

## 3. 产品体验目标

### 3.1 视觉目标

- 默认使用明亮、温暖的中性画布，不做传统后台式纯白大平面。
- 顶栏、工具栏和浮层有轻微透光感，但禁止全站滥用毛玻璃。
- 使用三级表面层次：画布、内容面板、浮层。
- 主要内容依靠排版、媒体和留白建立层级，不依赖粗边框和大色块。
- 主按钮保持近黑色；品牌绿只承担状态、焦点和少量强调。
- 项目首页恢复媒体封面，避免所有项目都显示同一个影片图标。
- 工作台以中央媒体舞台为视觉焦点，左右面板降低噪声。
- 中文字号、行高和字重按桌面生产力工具重新校准，避免全站文字偏小。

### 3.2 动效目标

- 动效用于解释状态变化，不作为装饰。
- hover、按下、选中、加载、保存、展开、关闭必须连续。
- 面板切换不闪烁、不突然改变尺寸。
- 项目卡、镜头卡和资源卡在更新时保持位置连续。
- 异步操作有明确的开始、进行中、成功和失败反馈。
- 所有动画尊重 `prefers-reduced-motion`。

建议节奏：

| 场景 | 时长 | 建议曲线 |
| --- | ---: | --- |
| hover、focus、按下 | 120–180ms | `cubic-bezier(.2,.8,.2,1)` |
| 分段选择、标签切换 | 160–220ms | `cubic-bezier(.2,.8,.2,1)` |
| 菜单、Popover | 180–240ms | `cubic-bezier(.16,1,.3,1)` |
| 抽屉、检查器、对话框 | 240–320ms | `cubic-bezier(.16,1,.3,1)` |
| 页面主内容切换 | 200–280ms | opacity + 4–8px 位移 |
| 列表重排、卡片迁移 | 弹簧 | 仅对位置和尺寸使用 |

禁止使用：

- `transition: all`。
- 大幅缩放、长距离飞入和频繁弹跳。
- 对输入文字、长文档和视频画面做无意义动画。
- 动画期间阻断用户输入。

## 4. 前端目标架构

### 4.1 顶层目录

目标结构如下：

```text
web/src/
  app/                    # 路由、Provider 组合、全局壳层
  shared/                 # 无业务含义的通用能力
    ui/                   # Button、Dialog、Drawer、Tooltip 等
    motion/               # 动效 token、Presence、布局过渡
    styles/               # reset、tokens、全局基础样式
    lib/                  # 通用纯函数
  features/
    projects/             # 项目列表、创建、导入导出
    inspiration/          # 灵感对话和创意意图
    blueprint/            # 蓝图分类审核和最终批准
    storyboard/           # 分镜选择、编辑、生成和绑定
    resources/            # 资源浏览、上传、生成和绑定
    production/           # 渲染准备、进度、预览和下载
    continuity/           # 全局设定和一致性
    billing/              # 钱包、订单和计费确认
    account/              # 登录、账户和权限
    workbench/            # 跨功能项目会话编排
  pages/                  # 薄路由页面，只负责组合 feature
  domain/                 # 后端领域类型和稳定规则
  platform/               # HTTP、存储、媒体 URL 等基础设施
```

不要求一次性搬完目录。每改造一个页面，迁移一个功能切片，旧目录逐步清空。

### 4.2 单个功能模块结构

```text
features/storyboard/
  api/                    # 该功能需要的请求适配
  model/                  # 状态、命令、selectors、view model
  hooks/                  # 页面级协调 hook
  components/             # 仅属于分镜领域的组件
  styles/                 # CSS Modules
  index.ts                # 模块公开接口
```

规则：

- 页面只能通过 feature 的 `index.ts` 使用其公开能力。
- feature 不得导入其他 feature 的内部文件。
- `shared` 不得依赖任何 feature。
- 跨 feature 的工作流只进入 `features/workbench`，不放进 UI 组件。
- 后端响应先转换成 view model，再交给表现组件。
- 表现组件不得直接理解持久化版本、账单任务、媒体缓存和 API 错误结构。

### 4.3 状态归属

| 状态 | 归属 |
| --- | --- |
| 服务端项目快照、版本、可写状态 | `workbench/project-session` |
| 媒体缓存、Object URL、远端 URL 解析 | `workbench/media-session` |
| 灵感、蓝图命令 | `features/inspiration`、`features/blueprint` |
| 镜头草稿和未保存状态 | `features/storyboard` |
| 资源筛选、抽屉和选中项 | `features/resources` |
| 渲染事件、SSE、下载 | `features/production` |
| 对话框、菜单、hover 等瞬时 UI 状态 | 最近的组件 |
| 可以由其他状态计算的值 | selector，不重复存储 |

禁止：

- 为了方便在多个页面复制同一份派生状态。
- 页面组件直接调用多个底层 repository 并自行处理竞态。
- 使用全局事件总线传递业务状态。
- 在组件卸载后继续写入旧项目状态。

## 5. 巨型文件拆解方案

### 5.1 `WorkbenchSessionProvider.tsx`

保留一个不超过约 250 行的薄 Provider，负责组合以下控制器：

```text
workbench/
  projectSession.ts       # 打开、刷新、版本、可写性、持久化
  mediaSession.ts         # 媒体缓存、URL、生命周期
  creativeCommands.ts     # 灵感、规划、审核、修订
  storyboardCommands.ts   # 保存、优化、重新生成
  resourceCommands.ts     # 上传、生成、查询、绑定
  productionCommands.ts   # 预检、渲染、刷新、下载、SSE
  backgroundJobs.ts       # 后台缓存任务和取消策略
  reducer.ts
  WorkbenchProvider.tsx
```

每个命令模块必须：

- 显式接收依赖，不从全局单例中偷偷读取。
- 有操作 token 或 AbortSignal，避免旧请求覆盖新项目。
- 只负责一个领域的竞态、错误恢复和持久化。
- 有针对成功、失败、切换项目和过期响应的测试。

### 5.2 `workbenchRoutes.tsx`

拆成：

```text
app/routes/
  WorkbenchSessionLayout.tsx
  ProjectLayout.tsx
  ProjectNavigation.tsx
  workflowGates.tsx
  creativeRoutes.tsx
  storyboardRoutes.tsx
  productionRoutes.tsx
```

路由组件只做以下工作：

- 读取参数。
- 执行访问门禁。
- 把 feature hook 的结果传给 Screen。
- 处理导航成功后的 route transition。

不在路由文件中实现媒体转换、资源绑定和复杂业务命令。

### 5.3 `ShotEditor.tsx`

拆成：

```text
storyboard/components/
  ShotInspector.tsx
  ShotNarrativeFields.tsx
  CameraControls.tsx
  ShotBindings.tsx
  ShotCommandBar.tsx
  ShotSaveStatus.tsx
storyboard/model/
  useShotDraft.ts
  shotDraft.ts
  cameraOptions.ts
```

`useShotDraft` 负责草稿、dirty、保存和服务端版本同步；字段组件只接收值、错误和 `onChange`。

### 5.4 资源库与灵感页

`ResourceLibraryPage` 拆为筛选器、资源网格、详情抽屉、生成抽屉、上传抽屉和绑定命令。

`InspirationPage` 拆为对话流、输入 Composer、建议 Chip、创意简报画布和确认命令栏。

页面文件只保留布局组合和 feature 状态，不包含长段领域转换函数。

### 5.5 国际化

将单一 `i18n.ts` 拆为命名空间：

```text
i18n/
  zh/
    common.ts
    projects.ts
    inspiration.ts
    blueprint.ts
    storyboard.ts
    resources.ts
    production.ts
    billing.ts
  index.ts
```

文案键归属对应功能，禁止继续向一个全局对象追加所有页面文案。

## 6. 样式与组件治理

### 6.1 全局样式允许存在的内容

```text
shared/styles/
  reset.css
  tokens.css
  typography.css
  motion.css
  utilities.css
app/shell/AppShell.module.css
```

除 reset、token、排版和可访问性工具外，新页面必须使用 CSS Modules 或明确的 feature 根作用域。

### 6.2 Token 分类

- 颜色：canvas、surface、elevated、overlay、ink、muted、line、accent、status。
- 间距：4、8、12、16、20、24、32、40、48。
- 圆角：6、10、14、18、pill。
- 阴影：control、panel、floating、modal。
- 排版：display、title、heading、body、caption、mono。
- 动效：duration、ease、spring、stagger。
- 层级：topbar、popover、drawer、dialog、toast。

治理目标：

- 品牌和界面颜色不再散落硬编码。
- 新组件不得使用 `transition: all`。
- 新样式选择器嵌套不超过三层。
- 响应式规则跟随组件放置，不再继续扩大单一 `responsive.css`。
- 单个 CSS Module 超过约 300 行时必须说明为何不能拆分。

### 6.3 共享 UI 组件

第一批建立：

- `Button`、`IconButton`、`SplitButton`
- `SegmentedControl`、`Tabs`
- `TextField`、`TextArea`、`SelectField`
- `Tooltip`、`Popover`、`Menu`
- `Dialog`、`Drawer`
- `Surface`、`Toolbar`、`InspectorPanel`
- `StatusDot`、`Badge`、`Progress`
- `Skeleton`、`EmptyState`、`ErrorState`
- `MediaCard`、`MediaStage`
- `Toast`

共享组件只解决通用交互、可访问性和视觉状态，不承载项目、镜头、资源或计费业务。

## 7. 动效实现策略

### 7.1 技术分工

- CSS transition：hover、focus、press、颜色和轻微位移。
- Web Animations 或轻量 React 动效库：mount/unmount、抽屉、Popover、布局重排。
- 原生滚动：文档和长列表，不自定义惯性滚动。
- 视频和图片：只动画容器，不反复动画媒体像素。

如引入 `motion` 包，必须满足：

- 仅在共享 motion primitive 和确有布局过渡需求的 feature 中使用。
- 不允许页面自行定义互相冲突的 spring 参数。
- 检查生产包体积，gzip 增量目标不超过约 50KB。
- 无动画环境下功能完全可用。

### 7.2 统一动效原语

```text
motion/
  Fade.tsx
  ScaleFade.tsx
  SlidePanel.tsx
  Collapse.tsx
  LayoutGroup.tsx
  RouteTransition.tsx
  useReducedMotion.ts
  motionTokens.ts
```

页面不得随意复制 `opacity + translateY` 动画代码。

### 7.3 重点交互

| 页面 | 交互 |
| --- | --- |
| 创作首页 | 模式选择滑块、项目卡 hover、更多菜单、创建中状态 |
| 灵感对话 | 新消息进入、建议 Chip 选中、简报字段更新、确认命令栏 |
| 蓝图 | 目录选中、章节状态切换、反馈抽屉、最终批准确认 |
| 分镜 | 镜头选择、中央媒体交叉淡化、底部胶片移动、检查器切换 |
| 资源库 | 筛选、卡片选中、详情抽屉、生成进度、绑定反馈 |
| 制作 | 事件流推进、预检确认、进度、完成态和下载反馈 |

## 8. 分阶段实施

### Phase 0：参考行为和回归基线

目标：在改代码前冻结真实行为和交互参考。

任务：

- 由用户提供真实 YouMind 操作录屏，覆盖首页、项目卡、灵感、文档、菜单和抽屉。
- 输出一份交互矩阵：触发方式、初始状态、动画属性、时长、结束状态。
- 记录当前前端在 1600×1000、1440×900、1024×768、390×844 的截图。
- 为主要路由补齐行为测试，确保功能迁移不改变后端契约。
- 记录现有测试、构建和关键浏览器流程结果。

验收：

- 未开始视觉实现。
- 所有核心行为有测试或人工验收步骤。
- 真实 YouMind 参考与旧仓库原型明确分离。

### Phase 1：架构骨架和设计系统

目标：停止继续扩大全局 CSS 和巨型模块。

任务：

- 建立 `shared/ui`、`shared/motion`、`shared/styles`。
- 建立新的颜色、间距、圆角、阴影、排版和 motion token。
- 建立 Button、IconButton、Tabs、Tooltip、Menu、Dialog、Drawer、Surface。
- 增加模块边界测试，阻止 `shared -> features` 和 feature 内部跨域导入。
- 增加源码体积报告，将超大文件作为重构告警。

验收：

- 新 UI 组件具备 hover、press、focus、disabled、loading。
- 新组件无硬编码品牌色、无 `transition: all`。
- 旧页面仍可运行。

### Phase 2：Workbench Provider 和路由减肥

目标：先拆编排层，避免后续页面继续依赖巨型 Context。

任务：

- 抽离 project、media、creative、storyboard、resource、production command 模块。
- Provider 缩为依赖组合与 Context 暴露。
- 拆分布局、门禁和路由适配器。
- 保持现有竞态保护、版本控制、后台缓存和断线恢复测试。

验收：

- 每个领域命令可独立测试。
- 切换项目时旧请求不能污染新项目。
- 主要路由和深链接行为不变。

### Phase 3：全局壳层和创作首页

目标：建立第一眼的 Mac/YouMind 质感。

任务：

- 重做顶栏、项目上下文、阶段导航和全局菜单。
- 创作首页建立明确单焦点 Composer。
- 项目摘要增加封面 view model，优先使用成片或首个可用镜头。
- 项目历史改为媒体卡片或自适应混合布局。
- 补齐搜索、导入、导出、删除和空状态交互。

验收：

- 首页不再像管理后台表格。
- 项目卡内容变化不引起明显布局跳动。
- 键盘可以完成创建、打开和菜单操作。

### Phase 4：灵感对话和蓝图

目标：让“AI 对话 + 创作文档”成为产品核心体验。

任务：

- 对话、Composer、建议和创意简报拆成独立 feature 组件。
- 简报更新使用局部过渡，不重置整页滚动。
- 蓝图目录、文档画布、章节状态和反馈抽屉统一。
- 最终批准使用清晰的 sticky command bar 和确认反馈。

验收：

- 消息发送和简报更新有连续反馈。
- 章节确认状态来自服务端事实。
- 长内容、错误和重新规划不会破坏布局。

### Phase 5：分镜工作区

目标：完成最高价值、最高复杂度的工作台重构。

任务：

- 建立 `ThreePaneWorkbench` 布局原语。
- 拆分镜头列表、媒体舞台、胶片条和镜头检查器。
- 引入 `useShotDraft` 管理 dirty、保存、冲突和恢复。
- 镜头选择时中央媒体采用轻微交叉淡化。
- 右侧 Inspector 的分组、保存和生成反馈统一。

验收：

- 50 个镜头仍可顺畅选择和滚动。
- 镜头切换、保存、优化和重新生成不存在状态串线。
- 页面在常用桌面宽度下保持中央画面为主角。

### Phase 6：资源库、连续性和制作

目标：统一工具页面，同时保留高信息密度。

任务：

- 资源库迁移为筛选栏、MediaCard、详情 Drawer 和生成 Drawer。
- 全局设定改为目录 + 文档编辑区，避免表单墙。
- 制作页以成片预览、生产状态和证据区为三级层次。
- 统一异步进度、错误恢复、计费确认和下载状态。

验收：

- 资源上传、生成、绑定和取消行为不回归。
- SSE 断线、恢复、失败、完成状态清楚且可继续操作。

### Phase 7：账户和商业页面

目标：收口登录、钱包、订单和管理后台。

任务：

- 登录和恢复页面使用克制的环境背景与浮动面板。
- 钱包和订单提高数据可扫描性。
- 管理后台保持操作效率，不强行套用大卡片和重动画。
- 危险操作统一 Dialog 和原因输入。

### Phase 8：删除遗留与最终验收

目标：真正减少代码，而不是新旧两套长期共存。

任务：

- 删除已迁移的 `pages.css`、`responsive.css` 规则。
- 删除废弃组件、别名 token 和重复文案。
- 拆分 i18n 命名空间。
- 运行完整测试、构建、浏览器点击验收和截图对比。
- 检查 bundle、运行时长任务、Object URL 泄漏和 console error。

验收：

- 新页面不依赖旧整页 CSS。
- 全局硬编码颜色显著下降，品牌色集中在 token。
- 无新增巨型 Provider、路由文件或页面组件。

## 9. 每个变更批次的质量门禁

### 9.1 代码门禁

- Screen/Page 主要负责组合，不直接包含复杂请求竞态。
- 单个表现组件超过约 300 行时必须拆分或记录原因。
- 单个 hook/service 超过约 400 行时必须拆分或记录原因。
- 单个 CSS Module 超过约 300 行时必须拆分或记录原因。
- feature 仅通过公开接口被其他模块使用。
- 禁止新增循环依赖。
- 禁止把 feature 业务塞入 `shared/ui`。

以上数字是评审触发线，不是为了机械切碎文件；拆分必须形成有意义的职责边界。

### 9.2 测试门禁

- 纯函数和 selector 使用单元测试。
- 命令模块覆盖成功、失败、过期响应、项目切换和重试。
- 组件覆盖键盘、焦点、disabled、loading 和错误状态。
- 路由覆盖门禁、深链接和未保存离开确认。
- 每批运行：

```powershell
cd web
npm.cmd test -- --run
npm.cmd run build
```

### 9.3 浏览器验收门禁

每个核心页面按真人路径点击：

- hover 和按压是否有反馈。
- 菜单、抽屉、Dialog 是否平滑且焦点正确。
- 异步按钮是否防止重复提交。
- 页面切换是否闪烁或跳动。
- 动画中途快速点击是否产生错误状态。
- reduced motion 下是否立即、清楚、可操作。
- 390px、1024px、1440px、1600px 无溢出和遮挡。

## 10. 建议的提交顺序

为避免超大 PR，按以下批次交付：

1. `frontend-foundation`：token、共享 UI、motion、边界测试。
2. `workbench-architecture`：Provider 和 route adapters 拆解。
3. `projects-mac-refresh`：壳层、Composer、项目卡。
4. `creative-workflow-refresh`：灵感和蓝图。
5. `storyboard-workbench-refresh`：分镜工作台。
6. `resources-production-refresh`：资源、连续性、制作。
7. `account-billing-refresh`：账户和商业页面。
8. `frontend-legacy-cleanup`：删除旧 CSS、组件和兼容层。

每个批次必须能独立构建、测试和人工点击，不允许依赖一个长期不可运行的中间状态。

## 11. 风险和处理

### 风险 1：一边拆架构一边换皮导致回归范围过大

处理：先冻结行为，先拆编排层；单个批次只迁移一个功能切片。

### 风险 2：新设计系统建立后旧 CSS 继续覆盖

处理：新页面使用 CSS Modules；迁移完成立即删除对应旧规则，不长期双写。

### 风险 3：动效库被滥用导致包体和性能下降

处理：CSS 处理基础状态；React 动效库只处理 Presence 和布局连续性；集中参数。

### 风险 4：拆 Provider 时破坏异步竞态保护

处理：迁移前补充项目切换、过期响应、后台缓存、CAS 和 SSE 恢复测试。

### 风险 5：没有真实 YouMind 交互参考又做回旧原型风格

处理：旧原型明确废弃；真实微交互必须来自用户录屏或后续可访问的真实页面。

### 风险 6：当前工作树存在大量未提交修改

处理：实施前确定基准提交或新工作树；不得覆盖当前无关修改；每个阶段只触碰明确文件集合。

## 12. 完成定义

只有同时满足以下条件，才视为完成：

- 创作首页、灵感、蓝图、分镜、资源和制作形成统一的 Mac/YouMind 视觉语言。
- 关键按钮、卡片、菜单、抽屉和页面切换有连续且克制的动效。
- 旧仓库原型不再作为生产前端依赖或视觉基线。
- `WorkbenchSessionProvider`、工作台路由和 `ShotEditor` 已按职责拆分。
- 新功能不再进入单一巨型页面 CSS。
- feature、shared、app、platform 的依赖方向清楚并有自动检查。
- 现有创作流程、计费、持久化、媒体缓存和生成门禁无回归。
- 完整前端测试和 production build 通过。
- 主要桌面和移动视口通过真人点击验收。
- 动画开启和 reduced-motion 两种模式均可完整操作。
- 新旧代码完成清理，不留下长期双实现。

## 13. 推荐的第一实施批次

第一批不直接重做所有页面，执行以下内容：

1. 冻结当前行为和截图基线。
2. 建立 token、Button、IconButton、Tabs、Tooltip、Menu、Dialog、Drawer 和 motion primitive。
3. 抽离 Workbench 的 project session 与 creative commands。
4. 拆分工作台布局和 workflow gate。
5. 重做全局壳层和创作首页。
6. 用真实数据接入项目封面，而不是静态占位图。
7. 完成浏览器点击、键盘、reduced-motion、测试和构建验收。

第一批通过后，再进入灵感、蓝图和分镜工作台，避免视觉系统和业务拆分同时失控。
