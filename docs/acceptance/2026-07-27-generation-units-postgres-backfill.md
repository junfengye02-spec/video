# Generation Units 隔离 PostgreSQL 迁移、backfill 与双读发布门验收

- 日期：2026-07-27
- 范围：Alembic `017 -> 018 -> 017 -> 018`、PostgreSQL schema/约束、legacy v1 backfill、只读兼容与双读、v2 unit API、v1/v2 双向混用门、幂等和 active/protected 查询
- 结论：上述范围在本任务专用的本地隔离 PostgreSQL 16.13 中通过
- 发布结论：`generation_units_v2` 继续默认关闭；本记录不等于 staging/production 迁移通过，也不等于生产 backfill/双读观察通过

## 隔离边界

本轮没有连接或修改任何既有 PostgreSQL 数据库。开始前发现机器上存在多个既有 PostgreSQL 容器，因此没有复用它们，而是创建了单独的临时容器：

| 项目 | 值 |
|---|---|
| 容器 | `generation-units-acceptance-cc008d9fc5` |
| 镜像 | `postgres:16-alpine` |
| 数据库 | `generation_units_acceptance_cc008d9fc5` |
| 用户 | `generation_units_acceptance` |
| 宿主连接 | `127.0.0.1:56913` |
| 容器连接 | `5432` |
| PostgreSQL | `16.13` |

创建前已确认容器名不存在、宿主端口没有 listener。启动后通过 `current_database()`、`current_user`、Docker 端口映射和 PostgreSQL version 反向核对目标。Alembic 只通过当前命令进程中的 `DATABASE_URL` 指向该库；验收 URL 还由测试强制要求包含 `generation_units_acceptance`。

## Migration 往返

1. 空库 public table count 为 0。
2. `alembic upgrade 017` 从 base 依次执行到 `017`；此时 public table count 为 19，`video_generation_units` 不存在。
3. 在 `017` 插入 legacy sentinel user/project，随后执行 `alembic upgrade 018`。结果为唯一 head `018`，sentinel project 保留。
4. 在 `018` 的 ledger 写入 1 条有效 schema probe row，确认 downgrade 前 ledger count 为 1。
5. `alembic downgrade 017` 成功：`video_generation_units` 被删除，probe row 随表删除；sentinel project count 仍为 1。
6. 再执行 `alembic upgrade 018`：ledger 表重建且 count 为 0，sentinel project count 仍为 1。
7. 最终 `alembic current`、`alembic heads` 均为 `018 (head)`，`alembic upgrade head` 为成功 no-op。

这说明 018 的 downgrade contract 可执行，但语义是删除 ledger 表及其数据，不是无损回滚。生产若需要回退，必须先完成备份/导出和明确的数据恢复方案。

## PostgreSQL Schema

系统目录实查 `video_generation_units` 有 28 列，包含 project/unit/revision 身份、plan/status/active、ordered source JSON、provider/model/profile、三类 duration、asset/task/billing/replacement、legacy shot、execution key、diagnostics 和 timestamps。

| 类型 | 实查结果 |
|---|---|
| Primary key | `pk_video_generation_units (project_id, id, revision)` |
| Foreign keys | project -> projects，task item -> task_items，billing job -> generation_jobs；project 使用 `ON DELETE CASCADE` |
| Unique constraints | execution key、task item、billing job 各自唯一 |
| Check constraints | revision、status、operation、requested/source/timeline duration、plan ID length、execution key length，共 8 个 |
| 普通 index | `ix_video_generation_units_project_status` |
| PostgreSQL partial unique index | `(project_id,id) WHERE active=true`；`(project_id,legacy_source_shot_id) WHERE legacy_source_shot_id IS NOT NULL` |

隔离 PostgreSQL 测试不只检查 metadata，还实际触发并核对：非法 status 被 `ck_video_generation_units_status` 拒绝；同一 project/unit 的第二条 active revision 被 `uq_video_generation_units_active_revision` 拒绝。

## Legacy v1 Backfill 与双读

代表性 legacy project：`d086e39e330047c0ae8043a62b173f72`。

- 准备 4 个 storyboard shots；前 2 个带旧 `Shot.output_path`。
- 准备 2 个历史 `storyboard_video.generate` batches、2 个 complete TaskItems 和 2 个 billed GenerationJobs。
- 使用仓库 Remotion 随附二进制，不依赖 PATH：
  - `C:\Users\zhuba\Desktop\OpenMontage\videro\remotion-composer\node_modules\@remotion\compositor-win32-x64-msvc\ffmpeg.exe`
  - `C:\Users\zhuba\Desktop\OpenMontage\videro\remotion-composer\node_modules\@remotion\compositor-win32-x64-msvc\ffprobe.exe`
- 生成并探测两个实际 1 秒 MP4：`assets/video/legacy-1.mp4`、`assets/video/legacy-2.mp4`。

flag 关闭时，`GET /api/projects/{id}` 继续只读返回两个旧 output paths，`generation_execution` 为 `null`。测试进程内打开 v2 后，首次 GET 触发 backfill，第二次 GET 不增行：

| 项目 | 结果 |
|---|---|
| Ledger units | 2，均 `complete + active` |
| Source mapping | 每个旧 shot 单独对应 1 个 legacy unit，没有猜测性合并 |
| Model/requested duration | 两个 unit 均从历史执行恢复为 `omni_flash-10s / 10s` |
| Measured source/timeline duration | 两个 unit 均为 `1.0s / 1.0s`，probe status=`complete` |
| Output paths | 保持两个原路径，不移动、不重生成 |
| Task/billing binding | 两个 unit 均保留原 TaskItem 和 GenerationJob ID |
| Billing rows | backfill 前后均为 2，没有新增或改写 |
| Artifact | `generation_execution.json` 写出 2 个 active units |

随后只修改 legacy `Shot.output_path` 为另一个路径并再次 GET。ledger row 和 `generation_execution` 仍返回首次 backfill 的两个权威 output paths，证明“有 ledger 时读新绑定”；storyboard 兼容字段没有被 backfill 写回。

`active_units()` 返回 2 个 active units，`protected_units()` 返回 2 个 protected units。重复访问没有生成重复 legacy unit，数据库 partial unique index 同时提供并发兜底。

## 新项目 v2 与发布门

代表性新 project：`65d043c31679413b8bd14c2777adaf99`。

- 4 个相邻可合并 shots 预览为 2 个 multi-shot units，每个 unit 覆盖 2 个有序 shots。
- 旧 `/shots/generate` 适配器提交 multi-shot plan 返回 `generation_units_v2_required`，没有退回 per-shot submit。
- 停止测试 worker 后，只通过 `/generation-units/generate` 提交 2 个 unit IDs。
- 第一次请求返回 202 且 `deduplicated=false`；同 idempotency key 和 payload 第二次返回相同 task ID 且 `deduplicated=true`。
- 数据库为 1 个 `generation_unit_video.generate` batch、2 个 TaskItems、2 个 ledger rows；没有 GenerationJob，也没有 provider 调用。
- queued units 均进入 protected 查询；人工将一个 unit 模拟为 complete/active 后，active 查询只返回该 unit，protected 查询仍返回 complete + queued 两个 units。

混用门结果：

| 方向 | 结果 |
|---|---|
| 有 v1 batch 的 legacy project -> v2 submit | 409 `generation_submission_mode_conflict` |
| v2 multi-shot plan -> 旧 shot endpoint | 409 `generation_units_v2_required` |
| 已有 v2 batch，进程内关闭 flag -> v1 submit | 409 `generation_submission_mode_conflict` |

provider dependency 使用调用即抛错的 strict stub；v2 submit 前停止 worker。测试通过且 v2 project 的 GenerationJob count 为 0，因此本轮没有 provider quote、execute 或计费调用。

## 自动验证

| 命令 | 结果 |
|---|---|
| `pytest server/tests/test_generation_units_postgres.py`，显式隔离 PostgreSQL URL | 1 passed |
| `pytest test_generation_units.py test_generation_unit_planner.py test_generation_unit_execution.py test_generation_unit_timeline.py` | 28 passed |
| scoped `ruff check`：018 migration、generation_units package、两个 generation_units tests | 通过 |
| `alembic current / heads / upgrade head`，隔离 PostgreSQL | `018 (head)` / `018 (head)` / 成功 no-op |

新增的 PostgreSQL 验收测试默认 skip；只有显式设置 `GENERATION_UNITS_ACCEPTANCE_DATABASE_URL` 才运行，并强制 URL 含 `generation_units_acceptance`。源码默认仍为：

```text
server/app/core/config.py: generation_units_v2: bool = False
.env.example: GENERATION_UNITS_V2=false
```

## 未覆盖与发布限制

本记录不宣称以下项目通过：

1. staging/production PostgreSQL 的备份、迁移、锁/耗时观察、索引构建影响和回滚恢复。
2. 生产 legacy 项目数据量下的 backfill 批次观察、错误率、真实路径异常和双读观察窗口。
3. 真实付费 Omni/Sora provider 请求、计费、worker/provider 崩溃注入、waiting recovery 和原子发布。
4. 生产 feature flag 开启批准。

因此 `generation_units_v2` 不得因本记录默认开启。生产迁移与生产观察仍是独立发布门。

## 清理

只清理了本任务创建的对象，没有操作任何既有 PostgreSQL 容器或数据库：

- Docker events 已记录目标容器的 `kill -> stop -> die -> destroy`；`docker ps -a` 中目标容器为 0。
- 容器用 `--rm` 创建且没有命名卷；专用数据库随容器删除。
- `127.0.0.1:56913` listener 为 0。
- 名称带 `cc008d9fc5` 的本任务 pytest basetemp 为 0。
- 新增 PostgreSQL 测试产生的 pyc 为 0。
- 本任务没有启动 Web/API/provider 进程；临时 worker 随 TestClient 停止。
- Git 暂存区为空；未提交。
