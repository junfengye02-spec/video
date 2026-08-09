# mise studio 前端重构第一批执行与验收记录

日期：2026-07-19  
执行目录：`C:\Users\zhuba\Desktop\OpenMontage\videro`  
分支：`main`（执行前领先 `origin/main` 149）  
提交：未创建  
工作树策略：直接在现有普通工作树增量修改，保留全部既有未提交修改

## 1. 修改前审计

### 已经完成或基本可用

- 项目首页已有单焦点 Composer、模式/画幅/项目类型选择和创建后进入灵感路由。
- 全局壳层已有半透明顶栏、项目上下文、阶段导航和移动端菜单的初步实现。
- `components/ui/CommandButton.tsx` 已提供 loading 按钮和 IconButton 的早期封装。
- Workbench 已有 reducer、snapshot helper、路由模块和覆盖竞态/CAS/SSE/项目切换的测试。
- 首页已有搜索、导入、导出、删除和创建竞态保护。

### 部分完成

- 暖灰/中性 token 已开始进入 `styles/tokens.css`，但颜色、间距、圆角、阴影、排版、motion 和 z-index 尚未形成完整共享体系。
- 壳层和首页视觉已开始向轻量 Mac 创作工具靠拢，但项目历史仍是图标型列表，没有真实媒体封面。
- Workbench 路由已有模块入口，但 session layout、workflow gate 和 route adapter 仍混在同一个 935 行文件中。
- reduced motion 已有全局兜底，但没有共享 motion primitive 和模块边界门禁。

### 修改前缺失

- `web/src/shared/ui`、`web/src/shared/motion`、`web/src/shared/styles` 架构骨架。
- Button、Tabs、Tooltip、Menu、Dialog、Drawer、Surface 的共享实现和焦点/键盘测试。
- 真实项目封面 view model 与本地媒体 URL 解析。
- shared 依赖方向、`transition: all`、CSS Module 行数和响应式静态门禁。

## 2. 修改前测试与 build 基线

在任何代码修改前执行：

```powershell
cd web
npm.cmd test -- --run
npm.cmd run build
```

结果：

- 测试：48 个测试文件通过，740 项测试通过；Vitest 报告耗时 31.29 秒。
- build：通过；Vite 转换 1673 个模块。
- 基线 CSS：143.35 kB，gzip 23.55 kB。
- 基线主 JS：538.58 kB，gzip 157.91 kB。
- 基线警告：主 JS chunk 超过 500 kB；未阻断 build。
- 测试 stderr：存在既有 React Router v7 future flag 警告；未导致失败。

## 3. 本批次实际完成

### 3.1 shared styles 与 token

新增 `web/src/shared/styles/`：

- `tokens.css`：暖灰画布、三级 surface、ink/line/accent/status、4–48 间距、6/10/14/18/pill 圆角、四级阴影、字体梯度、motion 和 z-index。
- `reset.css`、`typography.css`、`utilities.css`。
- `motion.css`：统一 fade、scale-fade、slide、route、spinner keyframes 和 reduced-motion 规则。

旧 `styles/tokens.css` 保留为兼容别名层，未强制迁移其他页面；新代码直接消费 shared token。

### 3.2 shared UI 与 motion primitive

新增：

- `Button`、`IconButton`：hover、active、focus-visible、disabled、loading，loading 不改变按钮结构。
- `Tabs`：ArrowLeft/ArrowRight/Home/End 键盘切换。
- `Tooltip`：hover/focus 可见并通过 `aria-describedby` 关联。
- `Menu`、`MenuItem`：焦点进入、方向键、Home/End、Escape、点击外部关闭。
- `Dialog`、`Drawer`：modal focus trap、Escape、遮罩关闭、关闭后恢复 opener。
- `Surface`：content、raised、floating 三级表面。
- `Fade`、`ScaleFade`、`SlidePanel`、`RouteTransition`、`useReducedMotion`。

现有 `components/ui/CommandButton.tsx` 改为共享 Button/IconButton 的兼容适配器，保留原调用方 API。

### 3.3 Workbench 路由低风险拆分

新增：

- `app/routeModules/WorkbenchSessionLayout.tsx`
- `app/routeModules/workflowModel.ts`
- `app/routeModules/workflowGates.tsx`

将 session provider layout、legacy workflow 推导、section approval 门禁、项目索引重定向从 `workbenchRoutes.tsx` 抽离。主要深链、批准门禁、dirty navigation、竞态保护和版本控制仍由原有实现与测试覆盖。

### 3.4 壳层与首页

- AppShell 增加 CSS Module 作用域的暖灰画布、88% 半透明顶栏、18px blur/saturate、移动菜单进入动效和页面内容 RouteTransition。
- 首页项目历史改为自适应媒体卡网格；1440px 及以上固定四列，窄屏使用 `minmax(min(260px, 100%), 1fr)` 防止页面级溢出。
- 项目操作迁移到共享 Menu；删除和覆盖确认迁移到共享 Dialog。
- 项目卡保留“继续创作”，更多菜单提供导出和删除，异步导出仍按项目独立去重。

### 3.5 真实项目封面

新增 `features/projects/projectCover.ts`，封面优先级为：

1. `final_path` 成片。
2. 第一个有输出的镜头。
3. 第一个可用项目资源媒体或参考图。
4. 无真实媒体时才显示中性影片占位。

远端媒体通过既有 `MediaRepository.remoteUrl`，本地 `local://media/` 通过既有 `MediaRepository.resolve`，没有新增后端契约。

## 4. 测试与工程门禁

新增/更新：

- shared UI 键盘、loading、菜单、Dialog 焦点测试。
- 项目封面优先级测试。
- workflow model 门禁测试。
- 首页菜单化导出/删除、并发导出和焦点恢复测试。
- shared 依赖方向、禁止 `transition: all`、reduced motion、CSS Module 行数和响应式静态门禁。

最终执行：

```powershell
cd web
npm.cmd test -- --run
npm.cmd run build
```

结果：

- 完整测试：52 个测试文件通过，750 项测试通过；最终一次 Vitest 报告耗时 15.64 秒。
- build：通过；Vite 转换 1702 个模块。
- 最终 CSS：157.18 kB，gzip 26.25 kB。
- 最终主 JS：545.43 kB，gzip 161.53 kB。
- 相对基线：CSS gzip +2.70 kB，主 JS gzip +3.62 kB，低于计划中约 50 kB gzip 的动效增量目标。
- 仍有既有/持续的 >500 kB 主 chunk 警告；本批次未引入第三方 motion 依赖。
- React Router v7 future flag 警告仍存在，属于修改前已有警告。

## 5. 响应式与 reduced-motion 验收

本会话未执行真实浏览器截图或登录态真人点击验收，因此不宣称完成浏览器视觉验收。

实际完成的是静态响应式和组件行为验收：

| 视口 | 实际检查 |
| --- | --- |
| 390px | Shell 已有 520/820px 移动断点；项目网格使用 `min(260px, 100%)`；Dialog 底部贴近且宽度 100%；Drawer 100vw。 |
| 1024px | 项目网格 auto-fill；卡片和媒体固定 16:9；Shell 内容 `min-width: 0` 且根节点 `overflow-x: clip`。 |
| 1440px | 项目网格切换为四列；内容不依赖固定卡宽。 |
| 1600px | 继续使用四列与稳定媒体比例，不无限增加卡片列数。 |

reduced motion：

- 全局取消位移/缩放/过渡时长并保留状态变化。
- 项目卡 hover transform 在 reduced motion 下显式关闭。
- 菜单、Dialog、Drawer、RouteTransition 在无动画环境下仍直接渲染并可键盘操作。

## 6. 未完成项与风险

- `WorkbenchSessionProvider.tsx` 仍为 1783 行；本批次没有抽离 project session controller 与 creative command runner。原因是这些区域与现有媒体缓存、CAS、过期响应、项目切换和 SSE 恢复高度耦合，在当前大量未提交修改上继续移动风险过高。
- `workbenchRoutes.tsx` 从当前实现的 935 行降至约 887 行，只完成 session layout 和 workflow gate 的第一刀；ProjectLayout、creative/storyboard/production route adapters 仍需后续拆分。
- `ProjectComposer` 仍使用现有 feature 根全局类；本批次没有继续向 `pages.css`/`responsive.css` 添加新规则，但尚未把 Composer 完整迁移到 CSS Module。
- 灵感、蓝图、分镜、资源、制作、账户页面没有做全面视觉迁移，符合本批次范围控制。
- 未执行真实浏览器 390/1024/1440/1600 截图、hover 性能、console error 或登录态点击；下一批开始前应补齐。
- 主 bundle 仍超过 500 kB；建议在功能切片稳定后做 route-level dynamic import，而不是在架构迁移期间同时改加载语义。

## 7. 下一批入口

1. 先为 Workbench project session/creative commands 补充独立 command contract 测试，再抽离 controller；不得直接移动 1783 行 Provider。
2. 将 `ProjectLayout`、项目导航和 route recovery hook 移出 `workbenchRoutes.tsx`，保持现有深链与 dirty navigation 测试。
3. 把 `ProjectComposer` 迁移到 CSS Module，并用共享 Tabs/Popover 收口低频设置。
4. 用可登录的本地后端执行 390/1024/1440/1600 浏览器截图与点击验收，包含 normal/reduced-motion 两套。
5. 第一批浏览器验收通过后，再进入灵感/蓝图视觉切片；不要同时开始分镜工作台大改。
