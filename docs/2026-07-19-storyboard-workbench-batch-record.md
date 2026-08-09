# 2026-07-19 分镜三栏工作台批次记录

## 1. 批次结论

本批已将分镜页迁入独立 `features/storyboard` 边界，并完成“镜头列表 / 中央媒体舞台 / 镜头检查器”的轻量三栏工作台。桌面以中央舞台为主，小屏使用不卸载编辑器 DOM 的分段面板；镜头草稿、AI 优化撤销、保存、重新生成确认、资源绑定、项目切换旧响应、重复提交锁和 dirty 离开门禁保持现有领域与计费契约。

结论：自动化、生产构建、静态扫描和专用项目四视口验收均达到进入下一批“资源 / 连续性 / 制作”界面工作的门槛。下一批仍必须沿用现有媒体恢复、账单 quote、批准门禁和 URL 语义，不得把本批未执行的真实视频生成视为已验收。

## 2. 范围与约束

- 仅修改当前普通本地工作树，没有创建 worktree、切分支、提交或 push。
- 未启用 Superpowers 或 mattpocock-skills，也未读取或执行 `docs/superpowers` 下的计划。
- 保留了工作树中既有的蓝图、灵感、规划模型配置、计费、媒体恢复及其他用户未提交修改。
- 未改变后端领域契约、批准门禁、媒体恢复语义、账单结算语义、Provider 抽离范围或 URL 语义。
- 未实现拖拽排序、时间线剪辑、批量生成或新的后端媒体能力。

## 3. 主要修改

### 3.1 Feature 边界与控制器

- `web/src/pages/StoryboardPage.tsx` 变为薄组合页。
- 新建 `web/src/features/storyboard/`，页面状态不进入 `shared/ui`。
- `model/useStoryboardController.ts` 统一管理：
  - 有序镜头与当前镜头；
  - 已保存 baseline、当前 draft 与 dirty；
  - AI 优化结果和单次撤销；
  - 保存成功、失败与重试；
  - 重新生成失败、恢复和重复提交锁；
  - 项目切换后的过期响应抑制；
  - dirty 镜头切换确认。
- 草稿、镜头语言、滚动与画幅拟合逻辑拆到独立 model 文件，避免表现组件承担领域状态。

### 3.2 三栏工作台

- 桌面：左栏 `240–280px`、中央 `minmax(420px, 1fr)`、右栏 `320–360px`，只使用细分隔线。
- 1600px 实测为左栏 `280px`、中央区域 `960px`（媒体画布 `900px`）、右栏 `360px`。
- 1440px 实测为左栏 `259.19px`、媒体画布 `789.63 × 444.16px`、右栏 `331.19px`。
- 工作台占满顶栏以下可用高度，中央舞台获得最大空间。
- 小屏使用共享 Tabs 进行“分镜列表 / 预览 / 分镜检查器”切换，三个 pane 始终保留在 React 树中。
- 真实响应式验收发现紧凑视口聚焦后根容器可能保留内部滚动偏移；最终通过 `overflow: clip` 和断点变化时同步归零根 scroll offset 修复，并新增回归测试。

### 3.3 镜头列表与胶片条

- 镜头列表展示缩略图、序号、名称/节拍、预计时长与状态。
- 生成中、完成、失败等状态同时使用图标和文字。
- 不再分页，30+ 镜头保持在同一滚动列表中。
- 列表与只读胶片条选择同步，使用 280ms 的局部自动揭示，不新增拖拽或剪辑能力。
- 移动端从列表选中镜头后回到预览，胶片条保持选中项可见。

### 3.4 中央媒体舞台

- 使用项目画幅；`useFittedMediaCanvas.ts` 根据实际可用宽高拟合画布，避免容器拉伸。
- 图片、视频、空状态和生成状态使用同一稳定画布尺寸。
- 镜头切换采用 210ms opacity 交叉淡化。
- 新媒体 ready 前保留旧媒体；重新生成时在旧媒体上叠加覆盖层，不闪白、不跳尺寸。
- 视频控件贴近舞台底部并降低视觉存在感。
- 视频媒体释放时清空 `src`，避免旧 blob/媒体 URL 继续占用。

### 3.5 镜头检查器与命令

- 保留节拍、提示词、场景、道具、镜头意图、景别、运镜、焦段、打光、景深、色温、角色与资源绑定。
- AI 优化只写入未保存草稿，支持一次撤销，不隐式保存。
- 保存成功后才更新 baseline；保存期间继续输入的内容不会被旧响应覆盖。
- 重新生成使用共享 Dialog，明确使用最近已保存内容，不覆盖未保存文本。
- 共享 Dialog 增加向后兼容的 `closeDisabled`，生成请求 pending 时不能重复关闭/提交。
- 保存成功使用检查器内克制状态反馈，没有新增 Toast 滥用。

### 3.6 壳层与旧样式清理

- `AppShell` 对 `/storyboard` 使用局部 CSS Module 的 full-bleed 路由表面。
- 已从 `pages.css`、`responsive.css` 删除旧分镜整页规则，包括 `.storyboard-workspace`、`.storyboard-shot-list`、`.storyboard-stage`、`.storyboard-preview`、`.storyboard-order-strip`、`.shot-editor` 及旧移动/平板面板选择器。
- 全局 `.shot-list` 仍由 `components/StoryboardWaterfall.tsx` 使用，因此按“保留无关用户样式”的约束未删除。

## 4. 关键文件

- `web/src/pages/StoryboardPage.tsx`
- `web/src/features/storyboard/StoryboardWorkbench.tsx`
- `web/src/features/storyboard/StoryboardWorkbench.module.css`
- `web/src/features/storyboard/model/useStoryboardController.ts`
- `web/src/features/storyboard/model/shotDraft.ts`
- `web/src/features/storyboard/model/storyboardScroll.ts`
- `web/src/features/storyboard/model/useFittedMediaCanvas.ts`
- `web/src/features/storyboard/components/ShotList.tsx`
- `web/src/features/storyboard/components/MediaStage.tsx`
- `web/src/features/storyboard/components/MediaVisual.tsx`
- `web/src/features/storyboard/components/ShotFilmstrip.tsx`
- `web/src/features/storyboard/components/ShotInspector.tsx`
- `web/src/features/storyboard/components/ShotCommandBar.tsx`
- `web/src/components/shell/AppShell.tsx`
- `web/src/components/shell/AppShell.module.css`
- `web/src/shared/ui/Dialog.tsx`

## 5. 冻结行为与自动化覆盖

自动化覆盖包括：

- 镜头选择、列表/胶片条同步与自动滚动；
- 30+ 镜头长列表；
- 项目切换和过期异步响应；
- dirty 镜头切换确认、路由离开、history 与 `beforeunload`；
- AI 优化成功、失败、撤销，且只修改 draft；
- 保存成功、失败、重试和保存期间继续编辑；
- 重新生成 loading、失败、恢复、重复点击锁和 Dialog 焦点恢复；
- 旧媒体覆盖层和媒体 ready 后的交叉淡化；
- 视频 URL 切换清理；
- 角色与资源绑定保持；
- 小屏分段切换不卸载草稿、恢复此前字段焦点；
- 深链与最终批准门禁；
- 跨紧凑断点后清理工作台根滚动偏移。

## 6. 自动化与构建结果

### 6.1 修改前基线

- Web：53 个测试文件、771 项通过。
- Build：1731 modules。
- CSS：158.27 kB，gzip 26.61 kB。
- 主 JS：559.41 kB，gzip 166.18 kB。
- 既有警告：主 chunk 超过 500 kB。

### 6.2 最终结果

- `npm.cmd test -- --run`：54 个测试文件、746 项全部通过。
- `npm.cmd run build`：1750 modules，成功。
- CSS：162.61 kB，gzip 27.05 kB。
- 主 JS：569.18 kB，gzip 170.03 kB。
- `git diff --check`：通过。
- 仅保留既有的主 chunk 超过 500 kB 警告。

相对修改前基线：

- modules：`+19`；
- CSS：`+4.34 kB`，gzip `+0.44 kB`；
- 主 JS：`+9.77 kB`，gzip `+3.85 kB`。

测试数量下降来自旧 `ShotEditor`/旧 storyboard 组件测试被 feature 级测试替换；最终测试文件数增加 1，核心行为覆盖按本批冻结清单重建。

## 7. 真实浏览器验收

### 7.1 专用项目与批准状态

- 账号：`novice.local@example.com`。
- 唯一验收项目：`eb0c91dfec7e4e289a9b664a194d9bef`。
- 本批按授权只对该项目执行了一次最终蓝图批准，并合法进入 `/storyboard`。
- 项目包含 8 个真实镜头；未批准、删除或修改其他真实用户项目。
- 未批量生成媒体，也未删除任何项目或媒体。

### 7.2 四视口

| 视口 | 结果 |
| --- | --- |
| 390 × 844 | root `390/390`，无横向溢出；媒体画布 `366 × 205.88px`，16:9；8 镜头胶片条；小屏 Tabs 正常。 |
| 1024 × 768 | root `1024/1024`，无横向溢出；媒体画布 `819.5 × 460.97px`，16:9；8 镜头胶片条；分段面板正常。 |
| 1440 × 900 | 左栏 `259.19px`、媒体画布 `789.63 × 444.16px`、右栏 `331.19px`；镜头切换矩形稳定。 |
| 1600 × 1000 | 左栏 `280px`、媒体画布 `900 × 506.25px`、右栏 `360px`；镜头 1→4 后矩形完全一致；三栏顶部未裁切。 |

共同结果：

- 8 镜头列表与胶片条选择同步。
- 当前项目无预览媒体，空状态清晰；空状态切镜头不改变舞台尺寸。
- 390px 下检查器场景字段写入临时草稿，切到预览再返回后草稿仍在，焦点恢复到原 input；随后恢复原值，最终 clean。
- dirty 镜头切换和点击“资源库”均出现确认门禁；首次验收取消后保留原镜头、URL 与草稿。
- 后续为了保存原生确认框截图再次复现时，in-app Browser 对原生 `confirm` 的点击命令会阻塞，且原生 Dialog 不能被截图；该次不作为额外人工通过证据。
- `tab.reload()` 没有向 Browser API 稳定暴露 `beforeunload` Dialog，并实际重载丢弃了临时草稿。因此这里只记录工具限制，不能声称完成真人 `beforeunload` 验收；该行为由自动化测试覆盖。
- 最终干净分镜标签页 `console.warn/error` 为 0。
- `prefers-reduced-motion` 实际查询为 `false`；in-app Browser 无仿真能力，未以单测冒充真人 reduced-motion 验收。

### 7.3 AI 优化、保存与计费

- 执行了一次单镜头“AI 优化提示词”验收样本。
- 请求走本地 NewAPI；`PromptOptimizeRequest.text_model` 默认是 `gpt-5.5`。
- 仓库规划模型默认仍为 `gpt-5.5`，本地 `.env` 的 `NEWAPI_PLANNING_TEXT_MODEL` 为 `gpt-5.4`；后者用于此前蓝图长规划，并未改变本次 prompt optimize 请求默认模型。
- 钱包从 `2,408,192` 变为 `2,406,958`，本次可见额度差额为 `1,234`。
- 优化后提示词从 193 字符变为 808 字符，只进入未保存草稿；撤销后完整回到原 prompt、dirty 清除、保存按钮重新禁用。
- 资源“残缺旧相册”被临时绑定并保存，随后取消绑定再次保存，最终恢复 `0 / 10`，未留下验收绑定。
- 保存成功使用检查器内状态反馈，未触发视频生成。

### 7.4 重新生成

- 打开了单镜头重新生成确认 Dialog，确认当前余额、已保存角色/场景/道具/资源绑定和“使用最近已保存分镜”的说明。
- Dialog 实例数为 1；取消后 Dialog 关闭，焦点恢复到“重新生成视频”按钮。
- 没有点击最终“确认重新生成”。原因是界面只说明服务端将实时报价，没有在提交前给出可核验的精确 quote，无法证明本次视频费用安全。
- 因此本批没有视频计费调用；loading、失败、恢复、重复点击锁和旧媒体覆盖层由自动化错误恢复测试补足，不能表述为真人视频生成通过。

### 7.5 截图

目录：`docs/acceptance/2026-07-19-storyboard-workbench/`

- `storyboard-390.png`
- `storyboard-1024.png`
- `storyboard-1440.png`
- `storyboard-1600.png`
- `storyboard-dirty-state.png`

原生浏览器确认框无法由截图 API 捕获，因此没有伪造 dirty confirm 或 `beforeunload` 截图。

## 8. 静态扫描

- `transition: all`：`web/src` 中为 0。
- 旧分镜整页选择器：已从 `pages.css`、`responsive.css` 删除；全局 `.shot-list` 因 `StoryboardWaterfall` 仍有消费者而保留。
- 文件行数：
  - 最大表现组件 `StoryboardWorkbench.tsx`：269 行；
  - 最大 feature CSS Module `ShotInspector.module.css`：270 行；
  - controller `useStoryboardController.ts`：325 行；
  - 均未达到本批要求拆分的约束线。
- 依赖方向：`shared/ui` 未反向依赖 `features/storyboard`；storyboard feature 未依赖 `pages`。
- 未新增 `framer-motion`、`motion/react`、`react-spring`、`gsap` 或 `animejs` 等大型动效依赖。

## 9. 剩余风险

- 专用项目当前没有真实图片/视频，真实浏览器只能验收空状态和画布稳定性；媒体交叉淡化、旧媒体覆盖和 URL 清理由自动化覆盖。
- 未获得真人 `beforeunload` 证据，原因是 in-app Browser 原生 Dialog 暴露不稳定；不能把自动化结果当作真人验收。
- 未执行真实视频重新生成，因为提交前没有精确 quote；下一批若要补真人视频验收，必须先取得可核验 quote 并确认钱包安全。
- 主 JS 仍超过 500 kB；这是既有构建警告，本批增量较小，但后续可在不破坏路由深链的前提下继续做 route-level code splitting。
- reduced-motion 仅确认当前环境查询为 `false`，未完成真人仿真。

## 10. 下一批门禁

可以进入“资源 / 连续性 / 制作”批次，条件如下：

1. 继续把页面限制为组合层，领域状态留在各 feature/controller。
2. 不改变本批冻结的 dirty、保存 baseline、媒体恢复、账单 quote、批准门禁和 URL 语义。
3. 若下一批涉及真实视频或图片生成，必须在操作前记录模型、quote、钱包安全和调用次数。
4. 不以当前专用项目的无媒体状态替代真实媒体恢复验收；需要媒体时使用安全、单镜头、可核验的验收样本。
