# Generation Units Phase 7-8 验收记录

- 计划：`docs/2026-07-24-narrative-beats-and-generation-units-execution-plan.md`
- 记录日期：2026-07-26
- 范围：Phase 7 前端适配、模型切换与显式重新生成，以及 Phase 8 在不调用真实付费 provider 前可完成的 UI、合同、mock E2E 和发布门记录
- 结论：自动化与 mock 合同已通过；仅完成 Omni 桌面真实路由的局部视觉审计。真实 provider、生产迁移、故障注入及其余视觉场景仍是阻断默认启用的发布门。

## 已实现工作流

1. Storyboard 在提交前展示 narrative beat 数、generation unit 数、目标时长、模型原生预计时长和差值。每个 unit 展示有序 source shots/beats、requested duration、provider/model、能力边界和执行状态。
2. 提交按钮改为“生成待处理单元”，请求合同为 `generation_plan_id + generation_unit_ids + regenerate_unit_ids + idempotency_key`；前端生产代码不再调用 `/shots/generate`。
3. 不兼容计划在服务端确认前禁止生成，并提供三项实际操作：调用服务端 `confirmed_strategy=accept_longer_duration` 重新规划、导航到显式 storyboard revision、切换兼容模型。没有前端本地布尔绕过。
4. 模型切换只重算 pending candidates。queued/running/waiting/complete unit 保留原模型、素材和 protected 状态，且不进入默认提交选择。
5. 重新生成以 generation unit 为对象。multi-shot unit 对话框列出全部受影响 shots/beats，只能整体确认；修改单个 beat 时导航到 storyboard revision。replacement 等待或失败期间继续展示旧 active 素材，成功发布新 revision 后才切换 active。
6. v2 flag/升级错误显示可操作反馈。`Shot.output_path` 仅保留为旧项目只读兼容字段；服务端旧入口和 v1/v2 混用门禁仍保留一个发布周期。

## Mock E2E

`web/src/pages/StoryboardGenerationUnits.test.tsx` 的 7 个 mock E2E 场景已通过：

| 场景 | 自动断言 |
|---|---|
| Omni 6 -> 3 / 30 秒 | 显示 6 beats、3 units、30 秒；提交 3 个 unit IDs |
| Sora 3 / 36 秒 / +6 秒 | 确认前禁用；接受更长成片调用服务端策略并返回可提交新 plan |
| 5 秒单节拍模型 6 -> 6 / 30 秒 | 显示 6 个 5 秒 units |
| 不可合并边界 | 同时提供接受更长成片、修改/合并分镜、更换兼容模型 |
| 模型切换 | protected units 保留原模型；仅 1 个 pending candidate 可提交 |
| multi-shot regeneration | 列出全部受影响 shots/beats；整体确认；旧 active 素材在 replacement 等待时仍可用 |
| v1/v2 门禁 | v2 disabled 错误可操作；未调用旧 shot submit |

## 自动验证

### 本次收尾复跑

| 命令 | 结果 |
|---|---|
| `npm.cmd test -- --run --reporter=dot src/pages/StoryboardGenerationUnits.test.tsx src/pages/StoryboardPage.test.tsx src/features/generation/GenerationService.test.ts src/api/client.test.ts` | 4 files / 72 tests passed；仅 React Router v7 future-flag warning |
| `.\.venv\Scripts\python.exe -m pytest server/tests/test_generation_unit_planner.py server/tests/test_generation_units.py server/tests/test_generation_unit_execution.py server/tests/test_generation_unit_timeline.py server/tests/test_model_duration_api.py -q --basetemp=tmp/phase78-final-019f9404 -p no:cacheprovider` | 32 passed |
| `rg -n "/shots/generate|generateShots|ShotBatchGenerate" web/src -g "*.ts" -g "*.tsx"` | 无生产 submit endpoint；仅 `generateShotsLabel` 展示文案和 `"generateShots" in service` 的负向合同测试 |
| `rg -n "generation_units_v2|GENERATION_UNITS_V2" server/app/core/config.py .env.example` | `generation_units_v2: bool = False`；`GENERATION_UNITS_V2=false` |

第一次后端复跑因沙箱无权写入用户全局 pytest 临时目录而产生 17 个 setup errors；将 `--basetemp` 指向仓库 `tmp/` 并关闭 cache 后，同一测试选择 32/32 通过。这不是代码断言失败。

### 实现回合完整回归

以下结果在本子计划实现回合已完成，本次没有重复执行完整集合：

| 检查 | 已记录结果 |
|---|---|
| `npm.cmd test -- --run` | 66 files / 837 tests passed |
| 受影响 backend/API pytest 选择 | 117 passed；1 个 Starlette deprecation warning |
| `npm.cmd run build` | TypeScript 和 Vite build 通过；1774 modules；保留现有 658.26 kB chunk warning |
| scoped Ruff | 通过 |

## 数据库验收

- 配置的本地 PostgreSQL 开发数据库已从 Alembic `017` 升级到 `018_video_generation_units`，迁移成功。
- 这只是本地开发实例，不代表 staging/production PostgreSQL 迁移已执行或通过。
- 生产发布前仍需备份、迁移窗口、`upgrade 018`、schema/索引检查及回滚演练。

## 浏览器与视觉证据

本轮曾使用以下临时验收实例，现均已停止：

- Web：`http://127.0.0.1:5177`
- API：`http://127.0.0.1:8788`
- 路由：`http://127.0.0.1:5177/projects/8ae8f35beaaa43c6ba26e16d92da1acb/storyboard`

已完成的桌面实测：

- 1440 x 1000 下真实路由显示 6 narrative beats / 3 generation units / 30 秒。
- 三个 10 秒 multi-shot units 的顺序映射可扫描，“生成 3 个待处理单元”可用且位于 unit panel 内。
- document 横向 overflow 为 0；unit panel 约 242 x 583 px。
- 没有保存本轮截图文件，因此上述证据是运行时检查记录，不是可重新打开的截图证据。

未完成且不得写成通过：

- Sora 3 units / 36 秒 / +6 秒阻断及三种操作的真实浏览器检查。
- 移动视口、multi-shot regeneration 对话框、loading/error/empty/disabled 状态的真实浏览器检查。
- Inspector 中两个既有 AI keyframe action 按钮发现 `scrollWidth > clientWidth`；需修复后重新检查。由于此问题及上述缺口，本记录不宣称完整视觉验收通过。

临时 `web/vite.generation-units-acceptance.config.ts` 已删除。只停止了本子计划启动的 5177/8788 实例，未操作既有 5173/8787 实例。

## Feature Flag 与发布门

`generation_units_v2` 默认保持关闭：

- `server/app/core/config.py`：`generation_units_v2: bool = False`
- `.env.example`：`GENERATION_UNITS_V2=false`

在以下门全部完成并获人工批准前，不得默认开启：

1. 使用真实付费 Omni/Sora 通道做受控小批量验收，记录 storyboard/unit/task/job/provider request/asset/clip 数、计费、ffprobe 时长、最终时长，以及 model switch 前后 protected unit ID/model/output/billing job 不变。
2. 在真实浏览器完成 Sora 36 秒阻断与三项操作、移动布局、multi-shot dialog 和 loading/error/empty/disabled 状态；修复并复查 keyframe action overflow，保存截图或等价证据。
3. 在 staging/production PostgreSQL 执行并验收 018 迁移，包括备份、索引/约束检查和回滚演练。
4. 在真实 ffmpeg 与 worker/provider 进程环境执行崩溃注入，验证 waiting/recovery、幂等计费、replacement 失败保留旧 active 素材，以及原子发布。
5. 完成 v1 旧项目 backfill/只读兼容观察，并确认新项目开启 flag 后全程只走 v2、混用门禁有效。

## Git 状态

- 工作树包含 A/B/C 及其他用户改动，无法证明 Phase 7-8 可在不夹带既有修改的前提下独立提交。
- 本子计划未暂存、未提交；验收收尾时暂存区为空。
