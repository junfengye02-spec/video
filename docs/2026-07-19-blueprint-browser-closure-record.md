# 蓝图真实浏览器验收阻塞闭环记录

日期：2026-07-19  
执行目录：`C:\Users\zhuba\Desktop\OpenMontage\videro`  
分支：`main`（保留既有大量未提交修改；未 reset、checkout、clean、切分支、提交、push 或创建 worktree）

## 1. 结论

上一批被三次真实 `502` 阻塞的蓝图验收已闭环。验收项目 `eb0c91dfec7e4e289a9b664a194d9bef` 现已通过原有登录、CSRF、计费 quote、NewAPI provider、结果暂存/回执、项目 artifact 持久化和前端路由链，取得合法 `plan_review` 服务端快照。

真实浏览器已完成蓝图目录与章节切换、服务端章节状态、每章节滚动位置、反馈 Drawer 草稿/Escape/焦点恢复/冲突失败原位重试、真实重规划 loading/重复点击锁定/成功恢复、最终批准 Dialog 打开并取消，以及 390、1024、1440、1600 四视口检查。最终批准没有执行；项目仍为 `phase = plan_review`，直接访问 `/storyboard` 仍被送回 `/plan-review`。

进入“分镜三栏工作台批次”的蓝图门禁：**解除，可以进入下一批**。剩余 provider 时延和 reduced-motion 工具限制列在第 8 节，不再阻塞该批次入口。

## 2. 三次 502 的真实根因

### 2.1 本地链路健康

诊断时实际运行：

- Vite：`127.0.0.1:5173`。
- uvicorn：`127.0.0.1:8787`，`/openapi.json` 返回 200。
- 本地 NewAPI：Docker 容器 `new-api-prod-app`，`127.0.0.1:3000`，容器 healthy，根页面返回 200。
- Postgres、Redis 容器运行正常。
- 当前配置为 development；文本 token alias 为 `text-primary`，固定组为 `gptpro稳定组`。
- 项目所有者为本地活动管理员账号 `novice.local@example.com`。
- 同一项目两次较小的 Inspiration 文本请求均以 `gpt-5.5` 正常完成并结算，证明账号、余额、CSRF、数据库、token alias 和本地 NewAPI 并未整体失效。

### 2.2 三次失败的上游事实

三个 `storyboard_generation` 作业：

| 作业 | NewAPI 请求时间 | 模型 | 结果 |
| --- | --- | --- | --- |
| `961e7fe45ffb45adbd50c10e4055c885` | 12:18:45 | `gpt-5.5` | 约 125.3 秒后上游 524；`provider_result_missing_no_charge` |
| `2f3652e01b11420a95bf993618c7f06d` | 12:26:44 | `gpt-5.5` | 约 125.5 秒后上游 524；`provider_result_missing_no_charge` |
| `1a4a792d6b7c42d7aa56cd3dc9f5c062` | 13:50:26 | `gpt-5.5` | 约 126.0 秒后上游 524；`provider_result_missing_no_charge` |

每次 quote 请求都先返回 200；真正的 `/v1/chat/completions` 执行随后收到 Cloudflare HTML `Error code 524`，日志指向上游 `ccapi.yuanapi.org`。OpenMontage 的文本执行 read timeout 为 180 秒，因此不是本地 30 秒默认超时抢先终止；是上游在约 125 秒返回非 200。NewAPI 将其记录为 channel/relay 524，OpenMontage 再通过 `NewApiCallError` 映射为对前端的 `502 {"code":"provider_call_failed"}`。

三个失败作业都有 provider request reference，但没有可见结果，均按 no-charge 失败状态保存；没有生成蓝图 artifact，也没有把失败伪装成成功。

## 3. 最小配置修复

本地文本 token 的合法 `/v1/models` 列表包含：`gpt-5.4`、`gpt-5.5`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-image-2`。现有 NewAPI 日志显示 `gpt-5.4` 能在同一固定组完成较长输出，且成本倍率低于 `gpt-5.5`。

为避免把某台机器的 provider 选择硬编码成仓库全局默认，本批做了窄范围服务端配置：

- `server/app/core/config.py`：新增 `newapi_planning_text_model`，部署默认仍为 `gpt-5.5`。
- `server/app/main.py`：`StoryboardPlanRequest.text_model` 改为可选；未显式传入时，规划使用服务端 `newapi_planning_text_model`。
- `server/app/models.py`：`CreativePlanReviseRequest.text_model` 改为可选；未显式传入时，重规划使用同一服务端配置。
- `.env.example`：记录 `NEWAPI_PLANNING_TEXT_MODEL=gpt-5.5`，不改变通用部署默认。
- 当前本地 `.env`：设置 `NEWAPI_PLANNING_TEXT_MODEL=gpt-5.4`；未新增或回显任何 secret。
- `server/tests/test_api.py`：覆盖规划和重规划在请求未提供模型时使用服务端配置。

显式请求级 `text_model` 仍优先于服务端默认；没有新增假数据接口、数据库直改路径或批准绕过。

## 4. 合法 plan_review 快照

- 项目 ID：`eb0c91dfec7e4e289a9b664a194d9bef`。
- 项目标题仍按服务端事实为“未命名项目”；原始提示以“第二批浏览器验收 · 纸上雨夜”开头。
- 所有者：`novice.local@example.com`。
- 成功规划作业：`1171e7b1608144b2bcfd9824f62d4cf3`。
- 模型：`gpt-5.4`。
- NewAPI 执行：115.56 秒，200；1080 prompt tokens、6091 completion tokens。
- 作业状态：`billed`、`result_visible = true`。
- 持久化结果：`creative_workflow.phase = plan_review`；六类 `plan_sections` 均有真实服务端 revision/updated_at；8 个分镜和对应人物、场景、道具、声音规划已写入 artifact。

随后用于 Drawer 重试的真实重规划作业：`e5f72803ca9447f4a6f30c9e1a272382`，`gpt-5.4`，108.14 秒，200，最终 `billed/result_visible = true`。重复点击验收期间只新增这一项重规划作业。

## 5. 真实浏览器交互证据

浏览器：Codex in-app Browser，使用已有本地登录态；没有读取 cookie、localStorage、密码或 token。

### 5.1 目录、章节与滚动位置

- 六类目录均显示服务端状态、条目数和 revision。
- 世界观文档滚动到 `scrollTop = 950`，人物文档滚动到 `scrollTop = 720`。
- 世界观 → 人物 → 世界观 → 人物往返后分别恢复为 `950` 和 `720`，证明每章节滚动位置独立保存。
- 390px 下“目录 / 文档”Tab 可切换；从目录选择世界观后自动回到文档 Tab。
- 重规划后人物从 `v2/已确认` 经 `v3/修改中` 变为 `v4/待确认`，分镜从 `v1` 变为 `v2/待确认`；人物内容真实更新为 36 岁，旧 34 岁文本不再出现。

### 5.2 Drawer、失败与重试

- 人物“要求修改”打开 Drawer，草稿为“蓝图验收闭环：把修复师年龄从 34 岁调整为 36 岁……” 。
- Escape 关闭后，焦点返回“要求修改”按钮；重新打开时草稿完整保留。
- 使用同一登录账号的第二浏览器标签先确认人物章节，使主标签持有的 `v1` 成为陈旧 revision。
- 主标签首次提交得到真实 409 revision conflict；Drawer 保持打开，草稿保留，页面与 Drawer 同时显示“已载入服务端最新版本，可核对后重试”。
- 原位再次提交后，人物先保存为 `changes_requested`，再进入真实文本重规划。
- loading 时 Drawer 输入和提交按钮禁用；对禁用按钮再次真实点击没有产生第二个 provider 作业。
- 重规划成功后 Drawer 关闭，页面显示“人物已按反馈更新，请确认最新版本”。

### 5.3 最终 Dialog 与批准门禁

- 为使最终 Dialog 的真实入口可达，仅在此专用验收项目内逐项确认六类章节。
- 六类服务端最终章节 revision：世界观 `v2`、人物 `v5`、场景 `v2`、道具 `v2`、声音 `v2`、分镜 `v3`，状态均为 `approved`。
- 点击“全部确认，进入分镜”只打开“确认最终蓝图” Dialog。
- 点击“继续检查”取消；焦点返回“全部确认，进入分镜”。
- 没有点击“确认并进入分镜”，`creative_workflow.phase` 保持 `plan_review`、`approved_at = null`。
- 直接访问项目 `/storyboard` 被路由送回 `/plan-review`，证明最终批准门禁未被绕过。

## 6. 四视口矩阵

| 视口 | root client / scroll | 文档与命令栏 | 结果 |
| --- | --- | --- | --- |
| 390×844 | 390 / 390 | 文档区 `345 / 6604`；命令栏高 141.5px，位于工作区底部 | 无横向溢出；目录/文档 Tab、滚动和最终入口均可达 |
| 1024×768 | 1009 / 1009（15px 垂直滚动条） | 目录 270px、文档 pane 675.6px；文档 `scrollTop 950 → 1800` 时命令栏始终 `top=700/bottom=765` | 无横向溢出；双栏稳定，无布局跳动 |
| 1440×900 | 1440 / 1440 | 文档 `546 / 2125`；命令栏 `top=790/bottom=855` | 目录/文档双栏、Drawer、冲突、重规划和 Dialog 完成 |
| 1600×1000 | 1600 / 1600 | 文档阅读面宽 850px；命令栏 `top=890/bottom=955` | 宽屏阅读宽度稳定，无横向溢出 |

命令栏行为上始终固定在文档 pane 的第三个 grid row，文档只在中间 `.documentScroll` 内滚动，因此滚动前后命令栏坐标不变。计算样式为 `position: static`，不是 CSS `position: sticky`；行为满足“滚动期间始终可达”，记录不把实现伪写成 sticky 属性。

应用 console error/warn：0。验收过程中 Browser 工具自身出现过 Statsig 网络超时，不属于页面 console，未计作应用错误。

## 7. 截图

目录：`docs/acceptance/2026-07-19-blueprint-closure/`

- `blueprint-390-document.png`：390 文档 Tab、内部滚动与底部命令栏。
- `blueprint-390-directory.png`：390 目录 Tab 与六类服务端状态。
- `blueprint-1024.png`：1024 双栏、独立文档滚动、固定命令栏。
- `blueprint-1440-worldview.png`：1440 初始合法 `plan_review` 世界观快照。
- `blueprint-1440-feedback-drawer.png`：Drawer 草稿与影响范围。
- `blueprint-1440-feedback-conflict.png`：真实 409 冲突、错误提示与保留草稿。
- `blueprint-1440-replanning.png`：真实重规划 loading 和禁用提交。
- `blueprint-1440-replanned-success.png`：人物 36 岁更新和新 revision。
- `blueprint-1440-final-dialog.png`：最终批准 Dialog，仅打开未确认。
- `blueprint-1600.png`：1600 宽屏稳定阅读宽度与命令栏。

## 8. 测试、构建与剩余风险

执行结果：

- 最小修复针对性切片：3 项通过。
- 服务端相关回归：`server/tests/test_api.py` + `server/tests/test_auth_database.py`，122 项通过；仅有既有 Starlette TestClient deprecation warning。
- 完整 web：53 个文件、771 项通过。
- production build：1731 modules。
- CSS：158.27 kB，gzip 26.61 kB。
- 主 JS：559.41 kB，gzip 166.18 kB；既有 >500 kB chunk 警告仍在，本批未处理无关 code splitting。
- `git diff --check`：通过，无输出。
- 旧选择器：0。
- `transition: all`：0。
- Inspiration/Blueprint 非测试 feature 文件 ≥300 行：0；最大 CSS 265 行，最大 controller 230 行。
- shared/ui 反向依赖：0；Inspiration/Blueprint feature → pages/routeModules 依赖：0。

剩余风险：

- `gpt-5.4` 两次真实长输出分别用时 115.56 秒和 108.14 秒，虽低于当前上游约 125 秒 Cloudflare 门槛，但余量有限。当前闭环依赖本地 `.env` 的 `NEWAPI_PLANNING_TEXT_MODEL=gpt-5.4`；其他部署应按其合法模型列表配置，不应假设 `gpt-5.4` 普遍存在。
- `gpt-5.5` 对当前长规划 prompt 的上游 524 未被宣称“修好”；本批通过已有请求级模型能力和服务端配置选择可用路径。
- in-app Browser 实测 `prefers-reduced-motion: reduce === false`，且没有媒体特性仿真能力；未用单测冒充真人 reduced-motion 验收。静态 reduced-motion 契约与完整 web 测试通过。
- 当前验收项目六类章节均已确认，但项目本身没有最终批准，仍安全停在 `plan_review`。后续若不再复用此验收项目，可保留用于复查；本批未删除项目。
