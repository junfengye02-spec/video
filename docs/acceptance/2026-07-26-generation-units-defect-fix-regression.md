# Generation Units 缺陷修复回归记录

- 日期：2026-07-26
- 范围：只复验原 E 记录中的 storyboard revision 死路与关键帧 AI 按钮溢出
- 原始失败记录：`docs/acceptance/2026-07-26-generation-units-real-browser-acceptance.md`
- 结论：本轮两项缺陷均通过聚焦自动化测试与应用内真实浏览器回归

## 修复行为

1. “减少或合并分镜”现在先调用服务端 start transition，再进入显式路由 `/projects/:projectId/storyboard/revision`。服务端将 approved workflow 持久化为 storyboard revision session，只修改 `creative_workflow.json`。
2. revision 页面默认打开“分镜规划文档”。“取消修订并返回分镜”调用服务端 cancel transition；仅当 revision section 未继续变化时恢复 approved，发生进一步修改时返回 409，不能用本地状态假恢复。
3. revision start/cancel 和真实 plan revision/approval 明确管理 `revision_session`。continuity、Sora 模型、generation execution 与已完成 active unit 不在 start/cancel 的写入范围内。
4. `ShotInspector` 以自身 inline size 为响应依据；关键帧操作按钮填满网格轨道，检查器不超过 340px 时改为单列。

## 自动化验证

| 命令 | 结果 |
|---|---|
| `npm.cmd test -- --run`（7 个相关 Web 文件） | 7 files / 107 tests passed |
| `pytest server/tests/test_api.py -k "creative_plan or plan_section or storyboard_revision"` | 11 passed / 96 deselected |
| `pytest server/tests/test_generation_unit_planner.py server/tests/test_generation_units.py server/tests/test_generation_unit_execution.py` | 26 passed |
| `npm.cmd run build` | TypeScript 与 Vite production build 通过；仅保留既有 chunk size warning |
| `python -m py_compile server/app/models.py server/app/main.py server/tests/test_api.py` | 通过 |
| `ruff 0.15.21 check server/app/main.py server/app/models.py server/tests/test_api.py` | 主会话最终审计通过 |
| `python -m alembic -c alembic.ini heads` | `018 (head)` |

仓库没有 Web lint script，修复子会话的 `.venv` 也未安装 Ruff；主会话随后使用系统级 Ruff 完成了上述 Python scoped lint。

测试先行时，原 3 个 Web 文件为 51 passed / 3 failed；失败分别命中旧 link、缺少显式 revision route、缺少局部 container layout。服务端新增 start/cancel 合同在实现前返回 404。

## 浏览器环境与安全边界

- 使用 `browser:control-in-app-browser` 的应用内浏览器与其 `tab.playwright` API。
- 临时 Web/API 端口：5193 / 8793；验收后均已停止。
- fixture 复用真实 FastAPI project/workflow/store 与 generation-unit ledger，只在 fixture 的 `AppSettings` 中设置 `generation_units_v2=True`。
- strict fake provider 的 `quote()` 与 `execute_quoted()` 均直接抛异常；没有真实 provider 报价、执行或计费。
- 源码默认值保持 `server/app/core/config.py: generation_units_v2: bool = False`，`.env.example: GENERATION_UNITS_V2=false`。

## 路由与状态结果

| 检查 | 结果 |
|---|---|
| approved storyboard 点击“减少或合并分镜” | `/storyboard` -> `/storyboard/revision` |
| revision 初始内容 | “分镜规划文档”可见，storyboard 为“修改中”，其余 5 section 保持 approved |
| 取消修订 | 调服务端 cancel 后 `/storyboard/revision` -> `/storyboard` |
| 模型 | 返回后仍显示 `sora_v2 · 固定 12 秒` |
| 已完成 unit | 返回后仍显示 `acceptance-asset-1`；服务端为 1 completed / 1 active |
| 最终 workflow | `phase=approved`，`revision_session=null` |
| 浏览器控制台 | 0 error |

最终请求计数：generation-plan preview 4 次（初始挂载与路由返回），generation execute 0 次，revision start 1 次，revision cancel 1 次，provider quote 0 次，provider execute 0 次。

## DOM 尺寸

| 视口 | 检查器 | AI 首帧按钮 | AI 尾帧按钮 | 横向溢出 |
|---|---:|---:|---:|---|
| 1440x1000 | client/scroll `330/330`，rect `331.19` | client/scroll `281/281`，rect `283.19` | client/scroll `281/281`，rect `283.19` | document `1440/1440`，body `1440/1440` |
| 390x844 | client/scroll `390/390` | client/scroll `341/341`，rect `343` | client/scroll `341/341`，rect `343` | document `390/390`，body `390/390` |

两种视口中两枚按钮均为单列（`sameRow=false`），完整文案可见，按钮自身与页面均无横向溢出。

## 截图

- `docs/acceptance/artifacts/2026-07-26-generation-units-fix-regression/01-storyboard-revision.png`
- `docs/acceptance/artifacts/2026-07-26-generation-units-fix-regression/02-storyboard-keyframe-actions-1440x1000.png`
- `docs/acceptance/artifacts/2026-07-26-generation-units-fix-regression/03-storyboard-keyframe-actions-390x844.png`

## 清理状态

- 5193 / 8793 listener：0
- 临时 fixture、临时 Vite config、验收日志、pytest basetemp：0 残留
- fixture `__pycache__`：0 残留

## 仍开放的发布门

本记录不宣称以下项目通过，`generation_units_v2` 不应因此默认开启：

1. 真实付费 Omni/Sora provider 小批量 QA、真实 provider 请求数与计费核对。
2. staging/production PostgreSQL 018 migration、备份、约束/索引检查与回滚演练。
3. 真实 ffmpeg QA，以及 worker/provider 崩溃注入、waiting/recovery 和原子发布验证。
4. 真实素材时长 ffprobe 核对、生产 v1 backfill 与双读观察。
