# mise studio 前端重构第一批收尾与真实验收记录

日期：2026-07-19  
执行目录：`C:\Users\zhuba\Desktop\OpenMontage\videro`  
分支：`main`（工作树领先 `origin/main` 149，保留全部既有未提交修改）  
提交：未创建  
工作树策略：普通本地会话直接增量修改；未 reset、checkout、clean、提交、push 或切分支

## 1. 收尾结论

第一批的代码门禁和 normal-motion 真实浏览器路径已经完成：

- Workbench command token、过期响应和 CAS 版本保护形成独立 contract，并实际接回 Provider。
- `ProjectLayout`、项目导航、dirty navigation 和 command recovery adapter 已从 `workbenchRoutes.tsx` 拆出。
- `ProjectComposer` 已迁入 feature CSS Module，不再依赖 `pages.css` / `responsive.css` 的整块 Composer 规则。
- Composer 已接入共享 `Button`、`Tabs`、`Surface` 和新增的通用 `Popover`。
- shared UI 已修复默认按钮提交、Overlay 重复关闭、Menu 键盘打开、Tabs 重复选择和 Popover 焦点/移动端定位问题。
- 390、1024、1440、1600 四个视口完成真实点击、截图、横向溢出和 console 检查。

仍有一个明确环境阻塞：当前 in-app browser 只暴露 viewport/visibility 能力，不提供 `prefers-reduced-motion` 媒体仿真；浏览器实际查询值为 `false`。因此本记录不宣称 reduced-motion 真人浏览器验收完成。

## 2. Workbench command contract

新增：

- `web/src/features/workbench/commandContract.ts`
- `web/src/features/workbench/commandContract.test.ts`

独立 contract 覆盖：

- 当前命令成功提交。
- 当前命令失败并保持原异常。
- 同类新命令使旧响应过期。
- 项目会话切换使旧项目命令失效。
- CAS 使用精确 expected version。
- CAS 冲突返回显式状态。
- snapshot 已过期时不尝试写入。

Provider 只接入两个已证明安全的边界：

1. command token 的 begin / current / invalidate 生命周期。
2. 后台 snapshot 的 `saveIfVersion` CAS 保护。

未继续抽离 creative/storyboard/resource/production controller。`WorkbenchSessionProvider.tsx` 仍约 1792 行；媒体 URL、SSE、后台缓存、下载和各领域命令继续留在原位置，避免在当前工作树上扩大竞态风险。后续切点已经明确为：在独立 creative command contract 测试补齐后，按领域逐个迁移，而不是机械搬空 Provider。

## 3. 路由拆分

`workbenchRoutes.tsx` 从 887 行降至 529 行。新增有意义的职责模块：

- `ProjectLayout.tsx`：项目加载状态、AppShell 组合和 Outlet context。
- `ProjectNavigation.tsx`：阶段导航、工具导航和项目面包屑。
- `useDirtyNavigation.ts`：beforeunload、history popstate 恢复和离开确认。
- `workbenchRouteRecovery.ts`：登录过期恢复和账单/命令错误适配。
- `WorkbenchRouteSurfaces.tsx`：Workbench error 与本地备份状态表面。

既有 `WorkbenchSessionLayout`、workflow gate 和 workflow model 保持独立。深链、批准门禁、项目切换、dirty storyboard、dirty global settings 和 history navigation 仍由完整路由测试覆盖。

## 4. ProjectComposer 与样式边界

新增：

- `web/src/components/projects/ProjectComposer.module.css`：145 行，包含组件自身响应式规则。
- `web/src/shared/ui/Popover.tsx`：通用非模态 Popover。

迁移结果：

- `pages.css` / `responsive.css` 中 `project-composer`、`project-mode-selector` 规则已删除。
- 静态扫描未发现 Composer 全局选择器残留。
- 模式选择使用共享 Tabs，Arrow 键行为由共享组件提供。
- 画幅、项目类型和标题收进“创作设置” Popover。
- Popover 打开后焦点进入第一个表单控件，Escape 关闭并恢复触发按钮。
- 创建按钮使用共享 Button，loading 保持尺寸并禁用重复提交。
- 390px 初验发现 Popover 左侧越出可视区 12px；修复后实测矩形为 left=29、right=346，页面无横向滚动。

## 5. shared UI 缺陷修复

- `Button` 默认 `type="button"`，避免放进 form 后意外提交；显式 `type="submit"` 的调用保持不变。
- `useOverlayFocus` 使用最新 onClose 引用，避免父组件 inline callback 使 focus effect 重跑。
- Dialog/Drawer 关闭请求做单次保护，连续 Escape 不会重复调用 onClose。
- Menu 支持 trigger 上 ArrowDown 打开并聚焦首项、ArrowUp 打开并聚焦末项、Escape 恢复 trigger、Tab 正常退出。
- Tabs 对已选 Tab 的重复点击不再重复触发 value change；选中项 disabled 时为首个可用项保留 roving tabindex。
- Popover 支持点击外部关闭、Escape 恢复 trigger、打开后聚焦首个控件和单实例切换。

shared UI 针对性测试从 4 项增加到 9 项。

## 6. 测试与 build

### 修改前当前基线

- 52 个测试文件通过。
- 750 项测试通过。
- build 通过，1702 个模块。
- CSS 157.18 kB，gzip 26.25 kB。
- 主 JS 545.43 kB，gzip 161.53 kB。

### 最终完整门禁

```powershell
cd web
npm.cmd test -- --run
npm.cmd run build
cd ..
git diff --check
```

结果：

- 53 个测试文件通过。
- 761 项测试通过。
- build 通过，1710 个模块。
- CSS 157.26 kB，gzip 26.33 kB。
- 主 JS 549.69 kB，gzip 162.67 kB。
- `git diff --check` 通过，无输出。
- shared / Composer 静态扫描无 `transition: all`。
- Composer 全局样式残留扫描为 0。
- 最终主 chunk 仍超过 500 kB；属于既有持续警告，本批未做 route-level code splitting。
- React Router v7 future flag warning 仍只出现在既有测试 stderr，不阻断门禁。

相对本会话基线：CSS gzip +0.08 kB，主 JS gzip +1.14 kB。

## 7. 真实浏览器验收

环境：

- 后端：`127.0.0.1:8787`，本地 uvicorn 已运行。
- 前端：`127.0.0.1:5173`，本地 Vite 已运行。
- 浏览器：Codex in-app browser，使用已有本地验收登录态。
- console：全部已检查路径均无 error/warn。

### 7.1 视口与横向溢出

| 视口 | 页面 | 实测 client/scroll | 结果 |
| --- | --- | --- | --- |
| 1600×1000 | 首页 | root 1600 / 1600 | 无横向溢出 |
| 1440×900 | 首页 | root 1440 / 1440 | 四列卡片，无横向溢出 |
| 1024×768 | 首页 | root 1024 / 1024 | 三列卡片，无横向溢出 |
| 390×844 | 首页 | root 375 / 375（15px 垂直滚动条） | 单列卡片，无横向溢出 |
| 1600×1000 | Storyboard | root 1585 / 1585 | 无横向溢出 |
| 1600×1000 | Production | root 1585 / 1585 | 无横向溢出 |

### 7.2 真实点击证据

- 首页加载 2 个真实项目，其中已有成片项目显示真实媒体封面；创建后项目卡立即增加到 3 个。
- 项目更多菜单通过 ArrowDown 打开，焦点落在“导出项目”；DOM 中只有一个 menu。
- Escape 关闭菜单后，焦点恢复到对应项目的更多按钮。
- 选择“删除项目”打开 Dialog，焦点落在关闭按钮；Escape 关闭后焦点恢复到项目更多按钮；未执行删除。
- Composer 选择“概念预告”、打开创作设置、选择 9:16、填写标题并真实创建 draft。
- 创建后进入 `/projects/<id>/idea`，初始消息包含概念预告与 9:16 偏好；异步灵感响应稳定完成，无 alert、无 console error。
- 返回项目列表后新卡片“第一批浏览器验收 · 停电胶片”可见。
- 390px 移动导航可打开，焦点停留在关闭导航按钮，页面仍无横向溢出。
- 390px Composer Popover 打开后焦点进入画幅 select，Escape 恢复“创作设置”按钮。
- 从项目卡进入真实 Storyboard 深链，再点击“成片”切换到 Production；两次路由切换 URL、项目上下文和 active stage 一致。

### 7.3 截图

截图目录：`docs/acceptance/2026-07-19-first-batch/`

1. `02-delete-dialog-1600x1000-normal.png`
2. `03-home-1440x900-normal.png`
3. `04-composer-popover-1440x900-normal.png`
4. `06-home-1024x768-normal.png`
5. `07-home-390x844-normal.png`
6. `08-mobile-menu-390x844-normal.png`
7. `09-composer-popover-390x844-normal.png`

Storyboard、Production 和创建完成态使用 URL、DOM snapshot、console 与横向尺寸作为明确点击证据。in-app browser 的部分 `fullPage` 长页截图出现与 viewport override 不一致的捕获结果，已从交付截图中剔除，未把该工具异常当作视觉证据。

### 7.4 reduced motion 阻塞

实际浏览器查询：

```text
window.matchMedia("(prefers-reduced-motion: reduce)").matches === false
```

当前浏览器能力只有 viewport 和 visibility，无法切换或仿真媒体偏好。因此没有伪造 reduced-motion 真人点击结果。

已经通过的替代保护：

- shared motion/reduced-motion 静态边界测试。
- GlobalSettings reduced-motion 行为测试。
- motion CSS 和 Composer/项目卡的媒体查询扫描。
- 完整 761 项测试与 build。

可复现补验步骤：

1. 在操作系统开启“减少动态效果”或使用支持 `prefers-reduced-motion` emulation 的浏览器 DevTools。
2. 打开 `http://127.0.0.1:5173/projects`。
3. 在 console 确认 media query 返回 `true`。
4. 重走首页 Tabs、创作设置 Popover、项目 Menu、删除 Dialog、移动导航和项目路由切换。
5. 确认状态立即清楚呈现、无位移/缩放依赖、焦点与重复点击行为不变。

## 8. 剩余风险与下一批入口

剩余风险：

- reduced-motion 真人浏览器路径尚未完成，属于环境能力阻塞。
- Provider 仍为巨型模块；本批只抽 token/CAS contract，没有抽 creative controller。
- 主 JS chunk 仍超过 500 kB。
- 浏览器验收真实创建了一个本地验收 draft：`第一批浏览器验收 · 停电胶片`；未删除，便于复查。

进入灵感/蓝图批次的结论：

- 代码、测试、build、normal-motion 四视口和核心点击路径已经满足第一批收尾要求。
- 可以开始下一批的设计准备和低风险模块规划。
- 在正式宣称第一批“完整验收通过”并开始灵感/蓝图视觉落地前，仍应补一次真实 reduced-motion 手动点击。除此之外没有发现阻止进入下一批的本批回归。
