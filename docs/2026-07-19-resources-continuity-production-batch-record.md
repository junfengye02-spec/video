# 2026-07-19 资源、连续性与制作页统一批次记录

## 1. 批次结论

本批次将资源库、全局设定/连续性、制作三个工具页收口到独立 feature 边界，并保持 route/page 只负责组合。资源页现在是紧凑筛选栏、媒体优先网格与共享 Drawer；连续性页保持“目录 + 文档编辑区”；制作页按“成片预览 / 制作进度 / 工作流证据”分层。后端领域契约、媒体恢复与保留语义、SSE 事件、账单 quote/结算、批准门禁、下载和 URL 语义均未改变。

自动化、生产构建、静态扫描和专用项目四视口验收通过，可以进入“账户/商业页面”批次。下一批仍不得把本项目的无真实媒体状态当作媒体恢复真人验收，也不得绕过精确 quote 与余额门禁。

## 2. 范围与约束

- 只在当前普通本地工作树增量修改；没有创建 worktree、切分支、提交、push、reset、checkout 或 clean。
- 没有启用 Superpowers 或 `mattpocock-skills`，也没有读取或执行 `docs/superpowers` 下计划。
- 没有修改资源、连续性、制作之外的页面设计；对路由和共享组件只做低风险适配。
- 没有新增批量生成、批量删除、时间线剪辑、Provider 抽离或后端媒体能力。
- 没有上传、删除、批准、图片生成、视频生成、文本生成或最终渲染。

## 3. 主要修改

### 3.1 Feature 边界

- `web/src/pages/ResourceLibraryPage.tsx`、`GlobalSettingsPage.tsx`、`ProductionPage.tsx` 均缩为 8 行组合页。
- 新建 `web/src/features/resources/`：资源筛选、视图、选中、请求竞态、pending quote、上传/生成草稿和命令锁由 controller/model 管理。
- 新建 `web/src/features/continuity/`：完整 plan 克隆、序列化、dirty、保存状态、项目切换旧响应和 episode indexing 由 controller/model 管理。
- 新建 `web/src/features/production/`：预检、render 准备、确认、重复提交锁与制作展示状态由 controller 管理。
- feature 未反向依赖 pages；页面领域状态没有进入 `shared/ui`。

### 3.2 资源库

- 顶部为紧凑的“本项目/我的资源”、类型、来源与搜索工具条；主体使用稳定比例 MediaCard 网格。
- 无媒体资源保留稳定画幅并显示“暂无预览”，不会因 loading/失败改变网格几何。
- 详情、上传、AI 生图继续使用共享 Drawer；关闭详情、上传和生图 Drawer 后焦点均返回原触发器。
- 保留上传/生成 dirty draft、取消、失败重试、pending quote、绑定反馈、重复请求锁和项目切换竞态语义。
- 没有新增 Object URL；媒体错误和视频清理由现有媒体组件及自动化覆盖。

### 3.3 连续性/全局设定

- 桌面为左侧目录和稳定宽度文档编辑区，小屏目录改为紧凑分段入口；所有 section 保留在同一 React 树中。
- 保留世界观、主线、故事状态、人物关系、视觉规则、声音、生成偏好及 episode 字段的完整序列化。
- 保存成功/失败/重试、dirty、项目切换旧响应、路由离开和 `beforeunload` 门禁语义保持不变。
- 真实浏览器中临时“关系图”草稿跨目录切换保持，随后恢复为空；未执行保存调用。

### 3.4 制作页

- 成片舞台为主区域，制作状态/SSE 为第二层，工作流产物、一致性检查、下载和恢复信息为第三层。
- 空态、loading、失败、完成共用稳定成片舞台；旧预览继续由现有媒体恢复语义保留到新媒体 ready。
- render 准备、精确 quote、余额不足、重复提交锁、终态刷新、SSE 断线/重连、下载 loading/失败/重试语义保持不变。
- 制作确认改用共享 `Dialog`；关闭后焦点返回“生成最终成片”。

## 4. 关键文件

- `web/src/features/resources/ResourceLibraryScreen.tsx`
- `web/src/features/resources/ResourceLibrary.module.css`
- `web/src/features/resources/model/useResourceLibraryController.ts`
- `web/src/features/resources/model/resourceLibraryCommands.ts`
- `web/src/features/continuity/ContinuityScreen.tsx`
- `web/src/features/continuity/ContinuityScreen.module.css`
- `web/src/features/continuity/model/useContinuityController.ts`
- `web/src/features/continuity/model/continuityPlan.ts`
- `web/src/features/production/ProductionScreen.tsx`
- `web/src/features/production/ProductionScreen.module.css`
- `web/src/features/production/model/useProductionController.ts`
- `web/src/pages/ResourceLibraryPage.tsx`
- `web/src/pages/GlobalSettingsPage.tsx`
- `web/src/pages/ProductionPage.tsx`

## 5. 冻结行为与测试覆盖

自动化继续覆盖：

- 资源组合筛选、搜索、本项目/我的资源、详情选择与滚动保持。
- 上传/生成 Drawer 草稿、取消、焦点恢复、失败/重试、pending quote 和重复提交锁。
- 资源媒体失败、旧媒体保持、URL 清理、视频 `src` 清理和绑定保持。
- 连续性目录切换、完整字段序列化、episode indexing、dirty、保存成功/失败/重试、项目切换旧响应、路由离开和 `beforeunload`。
- 制作预检、精确 quote、余额不足、render 重复锁、SSE 断线/重连/终态刷新、失败恢复、旧预览覆盖和下载失败/重试。
- 三页深链、批准门禁、小屏不卸载草稿和跨断点滚动清理。

修改后定向测试：资源 36 项、连续性 17 项、制作 25 项，全部通过。

## 6. 测试与构建

### 6.1 修改前基线

- `npm.cmd test -- --run`：54 个测试文件、746 项通过。
- Build：1750 modules。
- CSS：162.61 kB，gzip 27.05 kB。
- 主 JS：569.18 kB，gzip 170.03 kB。
- 仅有既有主 chunk 超过 500 kB 警告。

### 6.2 修改后结果

- `npm.cmd test -- --run`：54 个测试文件、746 项通过。
- `npm.cmd run build`：1761 modules，成功。
- CSS：165.14 kB，gzip 27.58 kB。
- 主 JS：571.80 kB，gzip 170.95 kB。
- TypeScript 检查通过；`git diff --check` 通过。
- 仅保留既有主 chunk 超过 500 kB 警告。

相对基线：modules `+11`；CSS `+2.53 kB`、gzip `+0.53 kB`；主 JS `+2.62 kB`、gzip `+0.92 kB`。

## 7. 真实浏览器验收

### 7.1 专用项目

- 账户：`novice.local@example.com`。
- 项目：`eb0c91dfec7e4e289a9b664a194d9bef`。
- 最终保持 8 个镜头、10 个项目资源、10 个无预览资源；没有新增、删除、上传或绑定资源。
- 没有批准任何项目，没有操作其他真实用户项目。

### 7.2 四视口与溢出

| 页面 | 390 | 1024 | 1440 | 1600 |
| --- | --- | --- | --- | --- |
| 资源 | `390/375` | `1024/1009` | `1440/1425` | `1600/1585` |
| 连续性 | `390/375` | `1024/1009` | `1440/1425` | `1600/1585` |
| 制作 | `390/375` | `1024/1009` | `1440/1425` | `1600/1585` |

表内为 `innerWidth/document.scrollWidth`；差值为浏览器垂直滚动条占用，三页均未出现页面级横向溢出。390 下资源保持双列稳定占位，连续性目录在文档前分段排列，制作证据区顺序下沉；1440/1600 下媒体、文档和成片预览均为第一视觉层。

### 7.3 资源交互

- 本项目展示 10 个现有资源；类型“道具”得到 8 项，搜索“牛皮”得到唯一“牛皮信封”。
- “我的资源”可切换；验收结束已清空搜索、恢复“全部资源”和“本项目”。
- 详情 Drawer、上传 Drawer、AI 生图 Drawer 均只出现一个实例；取消后 Dialog 数为 0，焦点回到对应触发器。
- 没有上传、删除或生成资源。

### 7.4 连续性交互

- 五个目录入口可跳转；390 下“关系图”临时草稿跨“世界观/人物连续性”切换保持。
- 临时草稿随后恢复为空，dirty 状态清除；没有执行保存，因此服务端原值未改变。
- 路由离开触发了原生 confirm，URL 保持在 settings。in-app Browser 对该原生 Dialog 的控制连接超时，无法补充可靠的“取消后继续操作”证据；自动化覆盖取消/确认、history 和 `beforeunload`，这里不把单测冒充真人验收。

### 7.5 制作、quote 与计费

- 当前项目无最终媒体，成片舞台显示稳定“暂无最终成片预览”，下载按钮合法禁用。
- SSE 状态显示“实时更新已连接”；工作流显示 8 个镜头、0 复用、8 待生成、0 完成，`render_report` 合法缺失。
- 点击一次“生成最终成片”仅执行服务端制作预检/quote：8 个生成镜头、0 复用，精确 quote `14,490,000`，可用额度 `2,406,958`。
- 输出规格为 1280x720、16:9、MP4、60s；项目默认视频模型仍为 `omni_flash-10s`，本次没有提交真实模型调用。
- 余额不足提示出现，“确认并开始制作”禁用；只点击取消，焦点恢复到“生成最终成片”。
- 预检 pending 时触发按钮立即禁用并改为“正在检查制作信息”，真实浏览器未产生重复 render 提交。
- 计费调用：0；最终渲染调用：0；图片/视频/文本生成调用：0；下载调用：0；钱包最终仍为 `2,406,958`。

### 7.6 Console、动效与截图

- 干净验收标签页 `console.error/warn` 为 0。
- `window.matchMedia("(prefers-reduced-motion: reduce)").matches` 为 `false`。
- in-app Browser 不支持 `prefers-reduced-motion` 仿真；未将单测当作真人 reduced-motion 验收。
- 截图目录：`docs/acceptance/2026-07-19-resources-continuity-production/`。
- 截图：`resources-{390,1024,1440,1600}.png`、`continuity-{390,1024,1440,1600}.png`、`production-{390,1024,1440,1600}.png`。

## 8. 静态扫描

- 新 feature/page 范围无 `transition: all`。
- 新 feature 代码无直接 `URL.createObjectURL` / `URL.revokeObjectURL`；现有视频清理路径继续清空 `src`。
- 最大 controller 为 `useResourceLibraryController.ts` 312 行；连续性 135 行；制作 109 行，均低于 400 行约束。
- 新 screen 与 CSS Module 均低于 100 行，未接近 300 行表现层拆分线。
- `shared/ui` 未反向依赖三项 feature，feature 未依赖 pages。
- 未新增 `framer-motion`、`motion/react`、`react-spring`、`gsap` 或 `animejs` 等大型动效依赖。
- 旧选择器扫描没有发现无消费者的迁移页 class：`AssetGrid`、`ContinuityEditor`、`FinalRenderPanel`、`WorkflowArtifacts`、`JobProgress` 及资源/连续性/制作组合层仍输出这些共享 class，因此保留既有 `pages.css`/`responsive.css` 规则作为兼容层；本批次没有向这两个文件新增整页规则。
- 新增的布局和断点规则位于各 feature CSS Module 的根作用域；旧共享组件样式不会被误删。

## 9. 剩余风险

- 专用项目没有真实图片、视频或最终成片；真人验收只能证明空态、占位、布局和门禁，旧媒体覆盖、媒体 ready 切换、Object URL/视频清理由自动化覆盖。
- 原生 dirty confirm 能触发，但 in-app Browser 对该 Dialog 的取消控制不稳定；真实 `beforeunload` 仍不能声称完整真人通过。
- 没有执行真实渲染，因为精确 quote `14,490,000` 高于钱包 `2,406,958`；失败恢复、SSE 重连和下载失败/重试由自动化覆盖。
- 主 JS 仍超过 500 kB；这是既有警告，本批次仅小幅增加。
- reduced-motion 只有查询结果，没有真人仿真证据。

## 10. 下一批门禁

可以进入“账户/商业页面”批次，前提是：

1. 继续保持页面薄组合、feature/controller 持有领域状态、shared 只提供通用 UI。
2. 不改变本批次冻结的资源草稿、连续性 dirty、SSE、媒体恢复、quote/结算、批准、下载与 URL 语义。
3. 不把无媒体项目的空态验收扩写为真实媒体恢复或下载通过。
4. 任何生成或渲染前继续先记录模型、精确 quote、钱包安全和调用次数；余额不足时不得提交。
