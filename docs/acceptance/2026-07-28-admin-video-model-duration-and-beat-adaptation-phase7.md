# 管理员视频模型时长与故事节拍适配 Phase 7 最终验收记录

- 日期：2026-07-28
- 计划：`docs/2026-07-28-admin-video-model-duration-and-beat-adaptation-plan.md`
- 范围：Phase 1-6 真实工作区改动的最终集成、发布门、双数据库迁移、无付费端到端夹具、production preview 浏览器验收
- 结论：**代码可发布，但必须按“数据库升级到 020 -> 同步发布 server/web contract 2 -> 验证 preview -> 开启 `GENERATION_UNITS_V2`”的顺序灰度。** 本次未连接或修改任何生产数据库，也未调用真实付费生成。

## 1. 环境

- Windows / PowerShell
- Python 3.12，仓库 `.venv`
- Node.js 24.18.0，Vitest 2.1.9，Vite 5.4.21
- SQLite：临时文件数据库
- PostgreSQL：Docker `postgres:16-alpine`，服务端版本 `16.13`，本机 `127.0.0.1:55432`
- PostgreSQL 验收库：`generation_units_acceptance_phase7_019fa7ff`，名称含 acceptance 防误连保护；验收后已删除
- FFmpeg/ffprobe：Remotion 本地 compositor 附带的完整二进制；未使用 stub probe 代替发布门验证
- 浏览器：Codex in-app browser；production build + Vite preview + 隔离 FastAPI/SQLite/FakeNewApi/确定性 adaptation

## 2. Phase 1-6 对照审计

### 配置、目录和安全

- `video_model_duration_settings` 是模型调用秒数的运行时权威来源；静态 profile 只保留不能由秒数表达的能力。
- 管理员目录使用实时 NewAPI 目录与历史持久化配置的并集；目录失败不删除配置，目录中新模型不需要 Python 登记。
- 未配置模型返回 `duration_mode=unknown`；旧项目仍可创建、读取和编辑，但 artifact 不写隐式 `requested_duration_seconds`，付费任务在创建 `GenerationJob` 前阻塞。
- 管理员读写要求 admin，写入要求 CSRF、reason、`expected_version`；更新写审计 before/after，拒绝 NaN、Infinity、零和负数，响应不包含密钥或 token alias。
- 修改时长配置只写设置和审计，不触发任何生成调用。

### 规划、适配和缓存

- 相邻 beat 使用确定性有序 DP 装箱，不依赖固定最大 beat 数；不跨 `can_merge_with_next=false`、`cannot_split` 和 continuity 边界。
- A=3、B=4、D=10 形成一个 10 秒 unit；A=3、B=4、C=6、D=4、模型 D=10 精确形成 `[A+B]`、`[C+D]` 两个 10 秒 units。
- Beat=8、D=5 的 segment count 由代码确定为 2；结构化 adapter 只负责连续视觉段内容。
- adapter 校验 segment ID/数量/顺序、source beat/shot、事实 hash、事实列表、连续 start/end state 和 `introduced_story_facts=[]`；错误数量、增加事实和不可拆 beat 均阻塞。
- adaptation 缓存键包含 contract version 与完整结构化 request，因此 storyboard/beat、profile revision、时长、segment IDs、上下文、事实、text model 等变化自然失效。
- 缓存是项目 artifact，复用前重新校验；同进程相同 key 有锁，Web 相同在途 preview 也合并，避免 React StrictMode 重复写请求。

### 执行、账本、媒体和兼容

- plan、unit、ledger 和 task snapshot 冻结 `profile_json`、`profile_revision`、requested duration、beat/shot/segment 映射。
- 多 beats/一 unit 只发布并进入时间线一次；一 beat/多 units 全部按 segment 顺序进入。
- 下载后的媒体由 ffprobe 给出 `source_duration_seconds`，默认 `timeline_duration_seconds` 使用完整实际时长；10.005 秒不会按推荐时长裁剪或变速。
- 配置变更使未提交 preview stale；queued/running/completed unit、账单、资产、时间线和已冻结 profile 不回写。
- legacy render selector、计费请求和结果 metadata 已统一读取数据库 duration profile，避免旧入口重新引入静态默认值。
- 旧项目保持可读和双读回填。flag 关闭时保持 v1 路径；flag 开启后，旧客户端或错误 contract 返回明确 409，不会误入 v2。已经采用 v1/v2 提交模式的项目不能静默切换。

## 3. 发布门

- 合同版本：`GENERATION_UNITS_CONTRACT_VERSION = 2`。
- 环境开关：`GENERATION_UNITS_V2=false` 默认关闭。
- contract 2 请求同时要求：开关开启、客户端版本 2、Alembic revision 为 020 或更新、019 表和 020 generation-unit segment 列真实存在。
- flag 关闭时 contract 2 preview 立即返回 404；客户端不兼容返回 409 `generation_units_contract_incompatible`；半迁移返回 503 `generation_units_schema_not_ready`。
- 019 revision 但伪造/缺失 019/020 schema 不能通过；revision 020 且列完整时才放行 planner 和执行链路。
- 冻结 unit/profile snapshot 始终优先于当前管理员配置，发布门不会重写历史状态。

推荐部署顺序：

```text
1. 保持 GENERATION_UNITS_V2=false，备份并升级数据库到 Alembic 020。
2. 检查 alembic_version、video_model_duration_settings 和 020 新列/约束。
3. 同步部署支持 contract 2 的 server 与 web。
4. 先用一个已认证 preview 验证 payload 带 contract_version=2。
5. 开启 GENERATION_UNITS_V2，灰度恢复付费提交。
```

回退时先关闭 flag，再恢复匹配的 server/web；有 queued/running v2 task 时不得降级 020，也不得改写 frozen profile、账单或媒体。

## 4. 迁移验收

### SQLite

- fresh `base -> head(020)` 通过，包含历史 003/010/011/012 的 SQLite batch/trigger 兼容修复。
- 独立数据库执行 `base -> 019`（包含 018），插入 020 前旧 unit，再执行 `019 -> 020`；旧行回填 `source_segment_ids_json=[]`，已有 source duration 保留。
- 验证 019 bootstrap：已验证 Omni/Sora 模型写入，测试专用模型不写入。
- 验证 `(provider, model_id)` 唯一、duration 有限正数、version `>=1`、020 segment 列存在。

### PostgreSQL 16

- 在隔离库执行 `downgrade base -> upgrade 018 -> 019 -> seed legacy row -> 020`。
- 验证 Alembic revision `020`、019 bootstrap、唯一/正数/version 约束、020 列和旧行回填。
- 验证 generation-unit PostgreSQL check/unique/partial indexes、legacy 双读/回填、v1/v2 mode gate 与幂等提交。
- 三个 PostgreSQL 专项合计 `17 passed, 0 skipped`；此前因缺失 `GENERATION_UNITS_ACCEPTANCE_DATABASE_URL` 的两条关键测试已真实执行。

## 5. 自动化命令和结果

### 后端大范围回归

```powershell
$env:GENERATION_UNITS_ACCEPTANCE_DATABASE_URL="postgresql+psycopg://openmontage:openmontage@127.0.0.1:55432/generation_units_acceptance_phase7_019fa7ff"
$env:PATH="C:\Users\zhuba\Desktop\OpenMontage\videro\.tmp\phase7-ffmpeg-path;$env:PATH"
.\.venv\Scripts\python.exe -m pytest server/tests tests/tools -q -rs
```

结果：`1536 passed, 25 skipped, 20 warnings in 616.70s`。

- 23 个 skip 使用另一套、未配置的 `OPENMONTAGE_TEST_POSTGRES_URL`，属于既有 auth/billing/wallet/epay PostgreSQL 套件；不计作本计划 PostgreSQL 通过。
- 2 个 skip 是 Windows 不支持测试所需的文件/目录 symlink。
- 本计划使用 `GENERATION_UNITS_ACCEPTANCE_DATABASE_URL` 的 PostgreSQL 测试在同一次全量中实际执行，另有下面的 17 项零 skip 专项证据。
- warnings：12 个 Python 3.12 SQLite datetime adapter deprecation；8 个 Pillow `getdata` deprecation。

### PostgreSQL 019/020 专项

```powershell
$env:GENERATION_UNITS_ACCEPTANCE_DATABASE_URL="postgresql+psycopg://openmontage:openmontage@127.0.0.1:55432/generation_units_acceptance_phase7_019fa7ff"
.\.venv\Scripts\python.exe -m pytest server/tests/test_generation_units_migrations.py server/tests/test_generation_units_postgres.py server/tests/test_video_model_duration_settings.py -q -rs
```

结果：`17 passed, 0 skipped`，12 个 SQLite datetime deprecation warnings。PostgreSQL 报告 `16.13`，最终 revision 为 `020`。

### 无付费 release E2E + 真 FFmpeg

```powershell
$env:PATH="C:\Users\zhuba\Desktop\OpenMontage\videro\.tmp\phase7-ffmpeg-path;$env:PATH"
.\.venv\Scripts\python.exe -m pytest server/tests/test_video_duration_adaptation_release_e2e.py server/tests/test_generation_units_release_gate.py -q -rs
```

结果：`3 passed, 0 skipped`，8 个 Pillow deprecation warnings。

### Ruff

对 Phase 1-7 实际相关迁移、服务、planner/adaptation、执行、测试、schema 和兼容修复运行 scoped Ruff：

```powershell
ruff check server/alembic/versions/003_owned_projects_not_null.py server/alembic/versions/010_wallet_payment_tables.py server/alembic/versions/011_billing_job_tables.py server/alembic/versions/012_billing_constraints.py server/alembic/versions/019_video_model_duration_settings.py server/alembic/versions/020_generation_unit_segments.py server/app/admin/video_model_router.py server/app/billing/execution.py server/app/core/config.py server/app/generation_unit_planner.py server/app/generation_units server/app/main.py server/app/models.py server/app/openmontage_runner.py server/app/video_generation_adaptation.py server/app/video_model_profiles.py server/app/video_model_settings server/tests/test_api.py server/tests/test_generation_unit_execution.py server/tests/test_generation_unit_planner.py server/tests/test_generation_unit_timeline.py server/tests/test_generation_units.py server/tests/test_generation_units_migrations.py server/tests/test_generation_units_postgres.py server/tests/test_generation_units_release_gate.py server/tests/test_model_duration_api.py server/tests/test_openmontage_runner.py server/tests/test_project_ownership.py server/tests/test_video_duration_adaptation_release_e2e.py server/tests/test_video_generation_adaptation.py server/tests/test_video_model_duration_settings.py server/tests/test_video_model_profiles.py schemas/artifacts/__init__.py tools/graphics/openai_image.py tests/tools/test_openai_image_gpt_image_2.py
```

结果：`All checks passed!`

额外运行 `ruff check server schemas tools tests`，结果为 `208 errors`。这些是仓库既有、跨出本计划的 lint 基线，主要位于旧认证/合同测试和未参与本计划的工具模块；未使用 `--fix` 批量改写用户的脏工作区。它不计为通过，也不掩盖；本计划发布面 scoped Ruff 为干净。

### JSON Schema

```powershell
@'
from pathlib import Path
import json
from jsonschema.validators import validator_for
paths = sorted(Path('schemas').rglob('*.schema.json'))
for path in paths:
    schema = json.loads(path.read_text(encoding='utf-8'))
    validator_for(schema).check_schema(schema)
print(f'{len(paths)} JSON Schemas valid')
'@ | .\.venv\Scripts\python.exe -
```

结果：`28 JSON Schemas valid`。

### Web

```powershell
cd web
npm.cmd test
npx.cmd tsc --noEmit
npm.cmd run build
```

最终结果：

- Vitest：`68 passed files / 854 passed tests`。
- TypeScript：通过，无输出。
- production build：通过，1778 modules transformed；仅保留既有 `>500 kB` chunk warning。

失败历史已保留：第一次全量为 `67 passed files, 1 failed / 852 passed, 2 failed`，原因是组件 mock 仍重复要求由 HTTP/GenerationService 边界注入的 contract version，已修复。第二次为 `853 passed, 1 failed` 的 `App.test.tsx` 对话框等待偶发时序失败；该用例单独通过，随后第三次完整全量稳定 `854/854`。

## 6. 浏览器 production preview 验收

使用真实 production build、Vite preview `127.0.0.1:5198`、隔离 FastAPI `127.0.0.1:8798`、SQLite 020、FakeNewApi 和确定性 adaptation。未使用真实付费 provider。

- 普通用户访问 `/admin/video-models` 显示 `Not authorized`；管理员可访问。
- 实时目录展示 configured/unconfigured；目录模型移除后显示 missing；目录失败仍保留持久化配置。
- 保存必须填写 reason；配置后用户目录立即返回 fixed profile；旧 `expected_version` 显示冲突。
- 未配置用户模型 selector 禁用并显示明确原因，无默认秒数。
- 10 秒模型：U1 `[A+B]`，内容 7 秒、请求 10 秒；U2 `[C+D]`，内容 10 秒、请求 10 秒。原文数值为 A=3、B=4、C=6、D=4。
- 12 秒模型：两个 12 秒 units；5.25 秒模型：5 个 5.25 秒 units，超长 C 拆成两个连续 segments。
- 真实 API payload 包含 `source_segment_ids` 和 `prompt_segments`；重复 preview 返回相同 plan ID。
- 桌面 1440x1000 和移动 390x844 均无横向 overflow；Escape 关闭确认层并恢复 opener focus；键盘可到达控件。
- 浏览器 console warning/error 数组为空。
- in-app browser 收尾时无残留验收标签页。

## 7. 最终 10 条标准

| # | 状态 | 证据 |
|---|---|---|
| 1 | 通过 | FakeNewApi 新目录模型无需代码登记即出现在管理员页/API。 |
| 2 | 通过 | 管理员保存后用户目录立即从 unknown 变 fixed，revision/version 同步变化。 |
| 3 | 通过 | unknown 模型在创建计费 job 前阻塞，旧项目 artifact 不写隐式默认秒数。 |
| 4 | 通过 | beat 推荐时长保留在 creative workflow/storyboard，切换视频模型只重建 generation plan。 |
| 5 | 通过 | 确定性有序 DP 按时长和边界装箱，无管理员最大 beat 数。 |
| 6 | 通过 | 3+4 在 10 秒模型下生成一个完整 10 秒 unit；执行/合成不按 7 秒裁切。 |
| 7 | 通过（确定性边界） | 8/5 得到两个连续 5 秒 units；adapter 数量、顺序、状态和事实约束通过。任意自然语言语义等价仍是残余风险。 |
| 8 | 通过 | `cannot_split` 在 adapter 调用前返回结构化 blocker，不机械拆分。 |
| 9 | 通过 | 配置更新使未提交计划 stale；completed/queued/running snapshot、账单、资产和 timeline 不回写。 |
| 10 | 通过 | ffprobe 10.005 秒完整进入 timeline，默认 source in=0、out=10.005、playback rate=1。 |

## 8. 残余风险和外部条件

- 自然语言“剧情事实等价”无法由确定性代码完全证明。当前边界能证明 ID/hash/事实列表/数量/顺序/连续状态和 adapter 自报新增事实；高风险内容仍需要模型质量监控或人工审阅。
- adaptation cache 随项目 artifact 保留到项目删除，没有独立 TTL；长期大量改稿可能产生小量存储增长。因为 key 内容寻址且命中时重新校验，不存在旧 profile/beat 被错误复用的问题。
- adaptation 锁是进程内锁，Web dedupe 也是单客户端在途合并。当前支持并记录的部署拓扑是单 Uvicorn 进程；多 API 主机共享本地 project store 不在本次支持范围，需要跨进程锁/共享缓存后才能扩展。
- 全仓 Ruff 仍有 208 个既有 lint 问题；本计划发布面 scoped Ruff 通过。后续应单独建立仓库 lint 基线，不应在本次脏工作区中批量修复。
- production build 有既有大 chunk warning，不影响正确性，但应在后续前端性能工作中拆包。
- 生产发布仍依赖运维在目标库完成备份、020 迁移和 schema 检查；本次只验证隔离 SQLite/PostgreSQL 16，不能代替目标生产环境变更审批。

## 9. 修改文件

Phase 7 集成新增或修改的主要文件：

- 发布说明与配置：`.env.example`、`README.md`
- SQLite 全历史兼容：`server/alembic/versions/003_owned_projects_not_null.py`、`010_wallet_payment_tables.py`、`011_billing_job_tables.py`、`012_billing_constraints.py`
- 发布门与运行时：`server/app/core/config.py`、`server/app/generation_units/release_gate.py`、`server/app/generation_units/schemas.py`、`server/app/main.py`
- 跨入口时长与缓存：`server/app/openmontage_runner.py`、`server/app/video_generation_adaptation.py`
- Python 兼容修复：`tools/graphics/openai_image.py`
- 后端验收：`server/tests/test_api.py`、`test_generation_units_migrations.py`、`test_generation_units_postgres.py`、`test_project_ownership.py`、`test_video_duration_adaptation_release_e2e.py`、`test_video_generation_adaptation.py`、`tests/tools/test_openai_image_gpt_image_2.py`
- Web contract/dedupe：`web/src/api/client.ts`、`client.test.ts`、`web/src/features/generation/GenerationService.ts`、`GenerationService.test.ts`、`web/src/pages/StoryboardGenerationUnits.test.tsx`
- 本记录：`docs/acceptance/2026-07-28-admin-video-model-duration-and-beat-adaptation-phase7.md`

原计划状态未改写；发布结论以本记录的条件化门禁为准。
