# Inspiration / Blueprint 第二批实施与验收记录

日期：2026-07-19  
执行目录：`C:\Users\zhuba\Desktop\OpenMontage\videro`  
分支：`main`（领先 `origin/main` 149；保留既有未提交用户修改）  
工作树策略：普通本地会话增量修改；未 reset、checkout、clean、提交、push 或切分支

## 1. 结论

灵感对话与蓝图代码批次已完成，且不改变后端契约、领域事实、批准门禁或 URL 语义。Inspiration 已拆为 feature 组件与 CSS Module；PlanReview/Blueprint 已拆为目录、纸张文档、章节状态、反馈 Drawer、确认 Dialog 和 sticky 命令栏。单元/路由测试与构建门禁通过。

正常动效下，灵感页面完成了真实浏览器的消息即时插入、建议 Chip、Composer、局部简报更新、长对话滚动和确认栏检查。1024px 验收发现确认栏两列布局造成窄文本列，已在 `<=1100px` 改为单列并重新验证。

蓝图真实浏览器路径受本地文本规划 provider 阻塞：验收项目的三次规划请求最终均返回 `502`，重试入口本身可用；当前已有可复查项目要么仍是灵感阶段、要么已经批准并被门禁送往分镜，没有可合法进入的 `plan_review` 服务端快照。因此本记录不伪造章节状态，也不宣称 Drawer、章节切换或最终批准 Dialog 已完成真人浏览器验收；这些行为由 14 项 PlanReview 测试和 37 项路由测试覆盖。

## 2. 代码修改

灵感 feature：

- `web/src/pages/InspirationPage.tsx`：仅保留布局组合与 feature 状态接线（约 101 行）。
- `web/src/features/inspiration/useInspirationController.ts`：乐观消息、请求去重、重试、项目切换过期响应抑制。
- `web/src/features/inspiration/components/`：对话流、消息行、Composer、建议 Chip、纸张式简报和确认命令栏。
- `web/src/features/inspiration/*.module.css`：feature 根作用域；简报字段只做局部交叉淡化。

蓝图 feature：

- `web/src/pages/PlanReviewPage.tsx`：仅保留页面入口。
- `web/src/features/blueprint/useBlueprintReview.ts`：服务端章节状态/revision、章节切换滚动位置、反馈/确认命令、重试和过期响应抑制。
- `web/src/features/blueprint/components/BlueprintDirectory.tsx`、`BlueprintDocument.tsx`、`BlueprintFeedbackDrawer.tsx`、`BlueprintFinalDialog.tsx`、`BlueprintCommandBar.tsx`。
- `web/src/features/blueprint/*.module.css`：目录、纸张文档、Drawer、Dialog、sticky command bar 的 feature 样式。
- 反馈命令错误现在同时进入打开的 Drawer，输入校验错误与 API 错误分开呈现；Drawer 失败后保留草稿，可原位重试。

边界与无关恢复：

- 删除已被 CSS Module 替代的旧 `.inspiration-composer` 规则，并加入旧选择器静态契约。
- 恢复历史中被误删的 Global Settings/Workbench 移动端无关规则；`responsive.test.ts` 契约保持 `14/14`。
- 新增共享 `LiftFade` 与消息 180ms 动效 token；未引入大型动效依赖，无 `transition: all`。
- 删除旧蓝图展示组件；未向 `pages.css`/`responsive.css` 添加整页规则。

## 3. 测试与构建

记录落盘前的最终门禁结果：

```powershell
cd web
npm.cmd test -- --run
npm.cmd run build
cd ..
git diff --check
```

- 测试：53 个文件、771 项通过。
- 构建：1731 modules。
- CSS：158.27 kB，gzip 26.61 kB。
- 主 JS：559.41 kB，gzip 166.18 kB。
- `git diff --check`：通过，无输出。
- 已通过针对性切片：Inspiration 12、PlanReview 14、AppRoutes 37、Workbench Provider 13、Responsive 9、Foundation 5；本轮修复后的针对性集合为 77 项全部通过。
- 静态扫描：迁移旧选择器 0、`transition: all` 0；feature 最大 CSS 265 行，最大 controller 230 行，无文件达到 300 行；无大型动效依赖或 shared/ui 反向依赖。

相对本批开始的 1710 modules / CSS 157.26 kB（gzip 26.33 kB）/ 主 JS 549.69 kB（gzip 162.67 kB）：CSS gzip `+0.28 kB`，主 JS gzip `+3.51 kB`。主 chunk 仍超过 500 kB，属于既有警告，本批未引入 route-level code splitting。

## 4. 真实浏览器证据

环境：

- 前端：`http://127.0.0.1:5173/`，Vite 已运行。
- 后端：`http://127.0.0.1:8787/`，uvicorn 已运行；`/openapi.json` 返回 200。
- 浏览器：Codex in-app browser，已有本地登录态 `novice.local@example.com`。
- console：验收路径未发现应用 error/warn；浏览器工具自身曾报告 Statsig 网络超时，不是应用 console 错误。

验收项目：

- 项目 ID：`eb0c91dfec7e4e289a9b664a194d9bef`。
- 创建提示以“第二批浏览器验收 · 纸上雨夜”开头；服务端项目标题实际为“未命名项目”，按事实记录，不修改或删除。
- 三次确认/规划请求均进入 loading，最终返回 `Request failed with status 502`；错误表面显示 `重试规划`，重试后仍可恢复为 loading。规划失败没有生成蓝图快照。
- 直接访问该项目 `/plan-review` 回到 `/idea`；直接访问已批准项目 `e8ebf8552e014d0a8de1a4999a1b16bf/plan-review` 回到 `/storyboard`，批准门禁保持有效。
- 验收期间未执行最终批准、未删除项目、未修改真实用户项目。

已保存截图目录：`docs/acceptance/2026-07-19-inspiration-blueprint-batch/`

- `inspiration-final-390.png`：390×844，长对话、移动 Tab、Composer、无横向溢出。
- `inspiration-1024-fixed.png`：1024×768，修复后的单列 sticky 确认栏；说明宽 305px、按钮宽 333px、`position: sticky`。
- `inspiration-final-1440.png`：1440×900，左右对话/简报双 pane、纸张画布与底部确认栏。
- `inspiration-final-1600.png`：1600×1000，长简报、稳定阅读宽度、无横向溢出。
- 辅助过程图：`inspiration-conversation-390.png`、`inspiration-brief-390.png`、`inspiration-1440.png`、`inspiration-1024.png`。

视口实测（最终代码）：

| 视口 | root client/scroll | 主要证据 |
| --- | --- | --- |
| 390×844 | 390 / 390 | 仅消息区滚动；对话/简报 Tab 可切换；无横向溢出 |
| 1024×768 | 1024 / 1024 | 双 pane；确认栏单列、sticky、按钮与正文不挤压 |
| 1440×900 | 1440 / 1440 | 对话消息区与简报文档区独立滚动；纸张表面稳定 |
| 1600×1000 | 1600 / 1600 | 长内容不破坏布局；确认栏在文档底部可达 |

## 5. reduced-motion 状态

浏览器实际查询：

```text
window.matchMedia("(prefers-reduced-motion: reduce)").matches === false
```

当前 in-app browser 只提供 viewport/visibility 能力，不提供 `prefers-reduced-motion` 媒体仿真。因此没有用单测冒充真人 reduced-motion 验收，也没有宣称该路径完成。静态 motion/reduced-motion 契约和完整测试通过；后续应在支持媒体仿真的浏览器中补验消息淡入、局部简报淡化、Composer/Drawer/最终 Dialog 的即时状态。

## 6. 剩余风险与下一批入口

剩余风险：

- provider 502 阻塞了本地真实蓝图快照，蓝图目录、章节切换、反馈 Drawer/重规划提交、最终批准 Dialog 的浏览器点击证据待 provider 可用后补做。
- 本地验收项目仍是“未命名项目”，但提示和 ID 已记录，未删除，便于复查；规划重试已消耗本地钱包额度，未对真实项目执行批准。
- reduced-motion 真人浏览器验收仍受工具能力限制。
- 主 JS chunk >500 kB；Provider 仍保持既有边界，未做无关抽离。

进入分镜三栏工作台批次：**暂不宣称可进入**。代码与自动化门禁已达到批次要求，但正式进入前必须在 provider 恢复后完成一次真实 `plan_review` 项目的四视口蓝图验收，至少覆盖目录/章节、Drawer 焦点恢复、重规划错误、最终批准确认并取消。
