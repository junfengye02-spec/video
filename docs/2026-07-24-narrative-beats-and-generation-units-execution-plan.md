# 叙事节拍与视频生成单元分层执行计划

日期：2026-07-24  
状态：待实施  
优先级：P0  
范围：灵感简报、叙事分镜、模型适配、异步视频任务、计费、素材发布、最终时间线、模型切换

## 1. 结论与目标行为

当前系统虽然已经增加 `generation_plan` 和 `generation_units`，但规划器、任务提交器、计费 operation、输出路径和 UI 仍以单个 storyboard shot 为执行粒度。当前实际行为是：

```text
1 个叙事分镜 = 1 个 generation unit = 1 个 task item = 1 次供应商视频请求
```

本计划将其改为：

```text
灵感叙事节拍
  -> 用户确认的叙事分镜（稳定，不被模型适配覆盖）
  -> 模型适配 generation plan（可重新计算）
  -> generation units（实际请求、计费和素材单位）
  -> edit timeline（每个生成素材只出现一次）
```

30 秒、6 个叙事节拍的基准示例：

| 模型契约 | 叙事分镜 | generation units | 原生预计时长 |
|---|---:|---:|---:|
| Omni 固定 10 秒，支持相邻多节拍 | 6 | 3，每个 unit 承载 2 个相邻节拍 | 30 秒 |
| Sora 固定 12 秒，支持相邻多节拍 | 6 | 通常 3 | 36 秒 |
| 可变/固定 5 秒单节拍模型 | 6 | 6，一一对应 | 30 秒 |

核心不变量：

1. 模型适配不得删除、覆盖或静默合并用户确认的叙事分镜。
2. 一个 generation unit 可以映射一个或多个相邻叙事分镜，但不能跨集、跨不允许合并的边界或改变事件顺序。
3. 实际任务数、供应商请求数和计费次数等于待生成的 generation unit 数，不等于叙事分镜数。
4. 已完成或供应商已接受的 generation unit 不因模型切换而改变；新模型只作用于未生成或用户明确选择重新生成的 unit。
5. 不能得到目标时长时必须在请求供应商前阻止提交，并让用户在接受更长成片、修改分镜或更换模型之间选择。

## 2. 术语和数据所有权

### 2.1 Narrative beat：故事节拍

灵感阶段保存故事结构，不保存供应商请求参数。新增 `NarrativeBeat`：

```text
id
index
summary
recommended_duration_seconds
duration_range_seconds: [min, max]
can_merge_with_next
must_complete_action
must_preserve_emotion
cannot_split_reason
```

规则：

- `recommended_duration_seconds` 和 `duration_range_seconds` 是叙事节奏建议，不是供应商的 `requested_duration_seconds`；
- 目标 30 秒、6 个节拍时可以得到每节拍约 5 秒、建议区间 4-6 秒；该区间由目标时长和内容复杂度计算，不能成为所有项目的全局常量；
- `can_merge_with_next=false` 表示该边界不能放进同一次供应商请求；
- `must_complete_action` 和 `must_preserve_emotion` 禁止规划器在动作或情绪尚未完成的位置拆分；
- 灵感阶段仍不创建镜头语言、供应商 prompt、首尾帧或视频素材。

### 2.2 Storyboard shot：用户确认的叙事分镜

storyboard planner 将已确认 beat 丰富为镜头语言，但必须保留稳定的 beat 身份和数量，除非用户明确要求重新规划故事：

```text
Shot
  id
  beat_id
  beat
  prompt
  shot_language
  continuity
  can_merge_with_next
  must_complete_action
  must_preserve_emotion
  cannot_split_reason
  ...现有角色、场景、道具和版本字段
```

规则：

- 第一版默认一个 narrative beat 对应一个 storyboard shot；
- 用户确认后，模型适配只能引用 `shot.id` / `beat_id`，不能改写 shot；
- 拆分、合并、删除或重排 storyboard 必须走显式 storyboard revision，并使尚未执行的 generation plan 失效；
- `Shot.output_path` 只作为旧项目兼容字段，不能继续作为多分镜 generation unit 的权威素材绑定。

### 2.3 Generation plan：模型适配候选

`GenerationPlan` 是针对 `storyboard_revision + provider + model + operation + protected_units` 的不可变候选。至少新增：

```text
storyboard_shot_count
generation_unit_count
protected_generation_unit_ids
pending_shot_ids
covered_shot_ids
native_total_duration_seconds
target_duration_seconds
duration_difference_seconds
compatible_with_target
requires_confirmation
issues
adaptation_options
generation_units
```

`plan.id` 的哈希输入必须包含：

- storyboard revision；
- provider、model、operation 及 profile revision；
-所有 source shot IDs 及其版本；
- 已完成/活动 unit 的 ID、revision、模型和 shot 映射；
- 新 unit 的完整映射和请求时长；
- 用户明确选择的 regeneration unit IDs。

### 2.4 Generation unit：供应商请求、计费和素材单位

扩展 `GenerationUnit`：

```text
id
revision
status: planned | queued | running | waiting_provider | complete | failed | stale
source_shot_ids
source_beat_ids
prompt_segments[]
provider
model_id
operation
requested_duration_seconds
source_duration_seconds
timeline_duration_seconds
output_asset_id
output_path
billing_job_id
task_item_id
replaces_unit_id
```

约束：

- `source_shot_ids` 必须非空、连续、有序且属于同一集；
- 每个 shot 在同一个计划中恰好被一个 protected 或 pending unit 覆盖；
- unit prompt 必须按 `source_shot_ids` 顺序保留每个节拍，不能只拼接最后一个 shot 的 prompt；
- 一个 unit 只创建一个 task item、一个 generation key、一个 provider operation 和一个输出素材；
- 输出路径使用 `assets/video/units/<unit-id>/v<revision>.mp4`，重新生成成功前不得覆盖当前可用素材；
- `source_duration_seconds` 只取发布后探测结果。

### 2.5 Generation execution ledger：已接受计划和历史结果

当前 `generation_plan.json` 会被新预览覆盖，不能承担历史保护。新增版本化执行账本，建议由数据库保存并同步只读 artifact：

```text
video_generation_units
  id
  project_id
  plan_id
  revision
  status
  source_shot_ids_json
  source_shot_versions_json
  provider
  model_id
  operation
  requested_duration_seconds
  output_asset_id
  output_path
  task_item_id
  billing_job_id
  created_at
  updated_at
```

数据库负责并发、幂等和计费绑定；`artifacts/generation_execution.json` 仅作为项目导出和调试快照。不能只靠可覆盖的 JSON 文件保护已完成任务。

## 3. 模型能力契约

现有 `supports_multi_shot_prompt` 不足以区分“连续动作中的多个节拍”和“一个 clip 内的多镜头切换”。Profile 增加：

```text
supports_sequential_beats: boolean
supports_multi_shot_prompt: boolean
max_narrative_beats_per_unit: integer
profile_revision: string
```

分组许可：

- 相同连续镜头中的多个节拍要求 `supports_sequential_beats=true`；
- unit 内需要实际镜头切换时要求 `supports_multi_shot_prompt=true`；
- 两者都为 `false` 时强制一分镜一 unit；
- `max_narrative_beats_per_unit` 是硬上限；
- 不能仅凭“固定 10 秒”推断模型支持两个节拍。

Omni、Sora 等首批 profile 必须按当前 NewAPI 接入链路实测后配置。基准验收数据要求 Omni 10 秒 profile 能承载两个相邻节拍；如果当前通道无法验证该能力，则不能伪造 6 -> 3 结果，而应将该 profile 标为不支持并在 UI 解释原因。

## 4. 规划算法

### 4.1 输入

纯函数 `build_generation_plan()` 接收：

```text
storyboard
target_duration_seconds
provider
model_id
operation
model_profile
protected_units
requested_regeneration_unit_ids
```

不得从 `Shot.output_path` 猜测 protected unit；必须从 execution ledger 获取。

### 4.2 先冻结已有结果

1. 按故事顺序加载 complete、waiting_provider、running、queued unit。
2. 验证它们引用的 shot version 仍然有效。
3. 将有效 unit 放入 `protected_generation_unit_ids`。
4. 只有 `requested_regeneration_unit_ids` 中的 complete unit 才进入替换计划。
5. 新模型不得跨 protected unit 的前后边界重新分组。

### 4.3 对未覆盖的相邻分镜分区

固定时长模型使用确定性的动态规划，不使用依赖输入顺序偶然性的贪心规则。候选分组必须满足：

- shot IDs 连续且同集；
- 每个内部边界都允许合并；
- 不拆开 `must_complete_action` / `must_preserve_emotion` 约束；
- 不超过 profile 的节拍上限；
- 模型支持所需的 sequential beat 或 multi-shot prompt；
- unit 内叙事建议时长总和能在模型固定时长内合理完成。

评分优先级：

1. 不违反硬语义约束；
2. 覆盖所有叙事分镜且不重复；
3. 使原生总时长接近用户目标；
4. 使每个 unit 的叙事建议时长接近模型请求时长；
5. 减少不必要的供应商调用；
6. 在同分时选择更早边界，保证结果确定。

`flexible` / `supported_values` 模型先为单个叙事分镜分配内容驱动时长；只有单个请求无法满足内容时长或用户明确允许时才合并。5 秒单节拍模型的默认结果因此是 6 分镜 -> 6 units。

### 4.4 不可兼容结果

如果所有硬约束下无法同时满足目标时长，计划仍返回完整映射预览，但设置：

```text
compatible_with_target=false
requires_confirmation=true
can_generate=false
```

并按实际可行情况返回：

```text
accept_longer_duration
revise_or_merge_storyboard
choose_compatible_model
```

`accept_longer_duration` 必须生成一份新的、带确认策略的 plan，确认后才能设置 `can_generate=true`。不能靠前端本地布尔值绕过服务端计划哈希。

禁止行为：

- 自动删除不可合并的节拍；
- 把两个节拍文本截断后塞进一个 prompt；
- 自动把 10/12 秒素材压成 5 秒；
- 为满足 30 秒而静默覆盖 6 个叙事分镜为 3 个；
- 先提交计费任务再提示时长不兼容。

## 5. API 合约

### 5.1 灵感与 storyboard

修改：

- `CreativeBrief` 增加 `narrative_beats`；
- inspiration prompt 要求在 `ready_to_confirm=true` 时输出有序 beats 和叙事时长建议；
- storyboard planner 输入已确认 beats，并为每个 shot 持久化 `beat_id` 和合并/不可拆约束；
- storyboard revision API 保持显式增删改，不允许 generation planner 调用。

### 5.2 预览

保留并扩展：

```http
POST /api/projects/{project_id}/generation-plan/preview
```

请求：

```json
{
  "video_model": "omni_flash-10s",
  "operation": "text_to_video",
  "shot_ids": ["s1", "s2", "s3", "s4", "s5", "s6"],
  "regenerate_unit_ids": [],
  "confirmed_strategy": null
}
```

响应必须直接支持 UI 展示：

```text
6 个叙事节拍 / 3 个视频生成单元 / 预计 30 秒
```

并逐 unit 返回来源 shot/beat、建议叙事时长、请求时长、模型能力和阻塞原因。

### 5.3 提交

新增：

```http
POST /api/projects/{project_id}/generation-units/generate
```

请求只接受：

```text
generation_plan_id
generation_unit_ids
idempotency_key
```

服务端必须重新构建并比较 plan，验证 storyboard revision、profile revision、protected units 和映射后才创建任务。

旧 `/shots/generate` 在迁移期只作为兼容适配器：

- 若每个 unit 都恰好映射一个 shot，可以转发新入口；
- 若存在多 shot unit，返回明确的升级错误，不能退回逐 shot 提交；
- 前端迁移完成后删除旧入口。

### 5.4 明确重新生成

重新生成的选择对象改为 generation unit。叙事分镜界面点击“重新生成”时先解析其当前 unit：

- 单 shot unit：确认后替换该 unit；
- 多 shot unit：提示该 unit 同时承载哪些叙事分镜，确认后整体替换；
- 不允许只重生成多 shot unit 内的一半并覆盖原素材；若用户只想修改一个节拍，先创建 storyboard revision 和新的适配计划。

## 6. 异步任务、计费与发布

### 6.1 任务粒度

新增 `generation_unit_video.generate` handler。每个 pending unit 创建一个 `TaskItemSubmit`：

```text
target_entity_type = generation_unit
target_entity_id = unit.id
target_entity_version = unit.revision
generation_key = project + unit + revision + model + operation
operation = generation_unit:<unit-id>:v<revision>
```

删除提交器中的以下单 shot 假设：

- `units_by_shot`；
- `unit.shot_ids[0]`；
- `for shot in selected` 创建视频任务；
- `operation=shot:<shot_id>`；
- `assets/video/<shot-id>.mp4` 作为唯一发布地址。

### 6.2 Prompt 编译

新增 `compile_generation_unit_prompt(unit, shots, ...)`：

- 保留公共角色、场景、风格和资产锁；
- 为每个 beat 输出有序 prompt segment；
- 明确节拍间是连续动作、情绪延续还是镜头切换；
- 不重复冲突的首尾帧角色说明；
- 编译结果和 source shot versions 写入 task snapshot，重试时不得重新读取已变化的 storyboard。

### 6.3 连续性依赖

任务依赖链按 generation unit 顺序建立，而不是按 unit 内部 shot 建立：

- unit 内部节拍由一个供应商 clip 完成，不创建中间尾帧依赖；
- 下一个 unit 需要继承时，使用上一个 unit 的尾帧；
- `cut/match_cut` 仍是视觉语义，不自行解除任务顺序；
- 已完成 protected unit 可以作为新 unit 的依赖来源。

### 6.4 原子发布和恢复

- 供应商结果先写入 revision 专属临时文件；
- 校验媒体、探测时长、提取尾帧后原子发布；
- ledger 更新成功后才把新 revision 标记为 active；
- 替换失败、等待或取消时旧 unit 继续可用；
- `waiting_provider`、billing reconciliation 和防重复扣费逻辑改为校验 generation unit，而不是单 shot；
- 同一个 unit revision 只允许一个活动或可恢复的 GenerationJob。

## 7. 素材和最终时间线

新增权威绑定：

```text
generation_unit -> one video asset
generation_unit -> ordered source shot IDs
```

时间线编译规则：

- 每个 complete generation unit 只生成一个主视频 clip；
- 多个叙事分镜共享同一 unit 时，不能把同一个视频重复加入时间线；
- `metadata` 记录 `generation_unit_id`、`source_shot_ids` 和 `source_beat_ids`；
- 默认完整播放 source duration；
- 若以后要对 unit 内 beat 建立可编辑锚点，新增 `beat_time_ranges`，但没有可靠时间定位前不得伪造平均切点；
- `Shot.output_path` 迁移后只用于兼容展示，render compiler 不再从它构建重复 clips。

## 8. 模型切换与已有视频保护

切换模型时：

1. 查询 execution ledger，冻结所有 queued/running/waiting_provider/complete units。
2. 只为未覆盖的叙事分镜生成新模型候选 units。
3. 不修改旧 unit 的 model、prompt、requested duration、output 或 billing job。
4. UI 同时显示“已锁定已有单元”和“将使用新模型的待生成单元”。
5. 用户明确勾选重新生成 unit 后，才将它加入 `regenerate_unit_ids`。
6. 新结果成功发布后通过 `replaces_unit_id` 切换 active binding，旧素材保留为历史版本。

仅检查文件存在和画幅并不足以证明复用关系；复用必须以 ledger 的 active unit binding 为准。

## 9. 前端交互

分镜页至少包含：

- 叙事分镜计数；
- generation unit 计数；
- 目标时长、模型原生预计时长和差值；
- 每个 unit 承载的相邻分镜；
- 已完成/活动/待生成/待重新生成状态；
- 不可合并边界及原因；
- 三个不兼容选择：接受更长成片、减少/合并分镜、更换模型。

示例：

```text
6 个叙事节拍 / 3 个视频生成单元 / 预计 30 秒

U1  10 秒  分镜 1-2  可生成
U2  10 秒  分镜 3-4  可生成
U3  10 秒  分镜 5-6  可生成
```

Sora 示例显示 `预计 36 秒 · 比目标长 6 秒`，并在用户确认前禁用生成。

模型切换后不能清空已完成 unit 的状态或把它们加入默认选择。按钮文案从“生成已选分镜”改为“生成待处理单元”，避免继续暗示一镜一请求。

## 10. 迁移策略

### 10.1 旧项目

对每个可用旧 `Shot.output_path` 建立一个 legacy complete unit：

```text
source_shot_ids = [shot.id]
model_id = 从生成记录恢复，无法恢复时为 legacy_unknown
source_duration_seconds = ffprobe 实测
status = complete
output_path = 现有路径，不移动、不重生成
```

无法证明同一供应商请求来自多个旧 shot 时，不得自动合并 legacy units。

### 10.2 双读阶段

1. 有 generation unit ledger 时只读新绑定。
2. 无 ledger 时从 `Shot.output_path` 读取并触发幂等 backfill。
3. render compiler 对新项目禁止回退到 per-shot duplicate timeline。
4. 完成迁移和观察后删除写入 `Shot.output_path` 的新逻辑。

### 10.3 发布开关

使用服务端 feature flag `generation_units_v2`：

- 开启前，新 planner 和新执行入口只在测试环境运行；
- 开启后，新项目只走 unit v2；
- 旧项目按访问触发 backfill；
- 不允许同一个项目同时提交 v1 per-shot 和 v2 multi-shot 任务。

## 11. 实施阶段与文件清单

### Phase 0：把正确行为写成失败测试

目标：先删除“一镜一 unit”作为固定验收项。

修改：

- `server/tests/test_video_model_profiles.py`
- `server/tests/test_model_duration_api.py`
- 新增 `server/tests/test_generation_unit_planner.py`

必须先出现的失败测试：

1. Omni：6 个可合并的 5 秒节拍 -> 3 units，映射 `[s1,s2] [s3,s4] [s5,s6]`，总时长 30。
2. Sora：相同分镜 -> 3 units，总时长 36，生成前要求选择。
3. 5 秒单节拍模型：6 分镜 -> 6 units，总时长 30。
4. `s2/s3` 不可合并时不得删除节拍，返回更长方案和三类选择。
5. 每个 shot 恰好被一个 unit 覆盖。

完成条件：测试失败原因只能是缺少新行为，不能是 fixture 或 schema 错误。

### Phase 1：叙事数据和 schema

修改：

- `server/app/models.py`
- `server/app/inspiration_developer.py`
- `server/app/storyboard_generator.py`
- `web/src/domain/types.ts`
- `web/src/localdb/snapshotSchema.ts`
- `schemas/artifacts/generation_plan.schema.json`
- 新增 `schemas/artifacts/generation_execution.schema.json`

任务：

- 增加 `NarrativeBeat` 和 Shot 映射/约束字段；
- 更新提示词、规范化和向后兼容默认值；
- 更新前后端类型及本地快照验证；
- 保证旧 brief/storyboard 可读。

完成条件：灵感确认后能持久化 6 个 beats，storyboard 保留 6 个稳定 `beat_id`，模型字段仍未进入 inspiration artifact。

### Phase 2：纯规划器和 profile

修改：

- `server/app/video_model_profiles.py`
- 可拆出 `server/app/generation_unit_planner.py`
- `server/tests/test_generation_unit_planner.py`
- `server/tests/test_video_model_profiles.py`

任务：

- 增加 profile 能力；
- 实现 protected units 和确定性分区算法；
- 实现覆盖、不重复、边界和时长校验；
- 实现 plan 哈希和不兼容选项。

完成条件：Phase 0 全绿，并证明输入相同得到稳定 plan ID。

### Phase 3：执行账本和迁移

修改：

- 新增 Alembic migration；
- 新增 `server/app/generation_units/` repository、service、schemas；
- `server/app/artifact_sync.py`
- 项目导入/导出和 snapshot schema；
- 迁移测试。

任务：

- 建表和唯一约束；
- 实现 active/protected unit 查询；
- 实现 legacy per-shot backfill；
- 同步只读 execution artifact。

完成条件：重复 backfill 不产生重复 unit，旧视频路径和计费记录不变。

### Phase 4：预览和确认 API

修改：

- `server/app/main.py`
- `server/app/projects/schemas.py` 或拆分 generation router；
- `web/src/api/client.ts`
- API contract tests。

任务：

- 扩展 preview；
- 服务端确认策略生成新 plan；
- 增加 stale/profile/protected-unit 校验；
- 新增 generation-unit submit endpoint。

完成条件：仅预览不创建 TaskItem/GenerationJob，也不改写 storyboard 或 execution ledger。

### Phase 5：按 unit 执行、计费和恢复

修改：

- `server/app/tasks/shot_videos.py`，逐步替换为 unit handler；
- `server/app/tasks/service.py`
- `server/app/tasks/recovery.py`
- `server/app/openmontage_runner.py`
- `server/app/keyframe_service.py`
- `server/app/billing/execution.py` 相关校验；
- async、billing、provider recovery 测试。

任务：

- 一个 unit 创建一个 task 和 provider call；
- 编译 multi-beat prompt；
- unit 级 generation key、billing binding、waiting_provider 和恢复；
- revision 专属路径和原子激活；
- unit 级尾帧提取和依赖释放。

完成条件：6 -> 3 的计划只产生 3 个 task items、3 个 GenerationJobs、3 次 `/v1/videos` 请求。

### Phase 6：素材、时间线和合成

修改：

- `server/app/rendering/compiler.py`
- `server/app/rendering/timeline_compiler.py`
- `server/app/openmontage_runner.py`
- `schemas/artifacts/asset_manifest.schema.json`
- `schemas/artifacts/edit_decisions.schema.json`
- render tests。

任务：

- 从 active units 编译素材和时间线；
- 多 shot unit 只出现一次；
- 保持完整 source duration；
- 记录来源 shot/beat metadata；
- 去除新项目对 `Shot.output_path` 的权威依赖。

完成条件：Omni 示例最终为 3 个完整 10 秒 clip、约 30 秒，而不是 6 个 clip 或重复播放共享素材。

### Phase 7：前端适配和模型切换

修改：

- `web/src/features/storyboard/StoryboardWorkbench.tsx`
- `web/src/features/storyboard/components/ShotList.tsx`
- 新增 generation plan/unit 映射组件；
- `web/src/i18n.ts`
- Storyboard 页面测试。

任务：

- 展示三项计数和逐 unit 映射；
- 展示阻塞原因和三类选择；
- 提交 unit IDs；
- 将完成/活动 units 从默认选择排除；
- 模型切换只刷新 pending candidate；
- 多 shot unit 重新生成需要整体确认。

完成条件：用户能在提交前看见并确认“6 / 3 / 30 秒”，切换模型后已有 unit 仍保持原模型和完成状态。

### Phase 8：移除兼容路径和端到端验收

任务：

- 运行 legacy backfill 和双读测试；
- 禁止新项目调用 per-shot provider submit；
- 删除 UI 的旧 shot batch submit；
- 保留只读兼容字段一个发布周期；
- 完成真实 provider 小批量验收后再默认开启 feature flag。

完成条件：日志、任务、计费、素材和时间线使用同一个 generation unit ID 串联。

## 12. 必测场景

### 12.1 规划

- 6 可合并 beats + Omni 10 秒 -> 3 units / 30 秒。
- 6 可合并 beats + Sora 12 秒 -> 3 units / 36 秒 / 阻塞确认。
- 6 beats + 5 秒单节拍模型 -> 6 units / 30 秒。
- 任一内部边界禁止合并 -> 不删除、不压缩，返回更长方案。
- 不可拆动作跨边界 -> planner 拒绝非法分区。
- storyboard revision 变化 -> 原 plan stale。
- profile revision 变化 -> 原 plan stale。

### 12.2 提交和计费

- task item 数等于 pending unit 数。
- 每个 task snapshot 包含全部有序 source shots。
- 重复 idempotency key 不重复创建 provider call。
- waiting_provider 恢复原 billing job。
- 活动 unit 不允许因模型切换重发。

### 12.3 已有视频和模型切换

- 已完成前 2 个 units 后从 Omni 切到 Sora：前 2 个 unit、素材和 billing job 不变，只重规划剩余 beats。
- 用户未选择 regenerate 时，complete unit 不进入新任务。
- 明确重新生成失败时旧素材仍为 active。
- 新 revision 成功后才原子替换 active binding。

### 12.4 合成

- 多 shot unit 的素材只播放一次。
- ffprobe duration 写入 unit 和 asset manifest。
- 默认不裁切、不变速。
- 目标时长差异在 render preparation 和最终报告中一致。

### 12.5 前端

- 显示“6 个叙事节拍 / 3 个视频生成单元 / 预计 30 秒”。
- Sora 显示 36 秒和 +6 秒差值。
- 不可合并时显示三类可执行选择。
- 模型切换不清空完成状态。
- 多 shot unit 的重新生成对话框列出所有受影响分镜。

## 13. 验证命令

每个 Phase 至少运行对应聚焦测试；合并前运行：

```powershell
python -m pytest server/tests/test_generation_unit_planner.py server/tests/test_video_model_profiles.py server/tests/test_model_duration_api.py -q
python -m pytest server/tests/test_async_shot_generation.py server/tests/test_async_tasks.py server/tests/test_provider_recovery.py server/tests/test_billing_e2e.py -q
python -m pytest server/tests/test_render_plan.py server/tests/test_edit_timeline.py server/tests/test_render_ffmpeg.py -q
pnpm --dir web test -- --run
```

真实 provider 验收必须记录：

- storyboard shot count；
- generation unit count；
- `/v1/videos` 实际请求数；
- GenerationJob 数量和计费结果；
- 每个 source 视频的 ffprobe 时长；
- 最终时间线 clip 数和总时长；
- 切换模型前后 protected unit 的 ID、model、output 和 billing job 是否保持不变。

## 14. 最终验收标准

- 6 个已确认叙事分镜在 Omni 10 秒适配后仍是 6 个分镜，但只创建 3 个 generation units。
- UI、API、TaskItem、GenerationJob、provider request 和输出素材对同一个 unit 数量达成一致。
- Sora 12 秒示例返回 3 units / 36 秒，不伪装成 30 秒。
- 5 秒单节拍模型返回 6 units / 30 秒。
- 不可合并边界不会导致自动删除、压缩、裁切或变速。
- 模型切换不修改任何已完成或活动 unit；明确重新生成采用 revision 和原子替换。
- storyboard 不保存供应商请求时长，generation plan 不覆盖 storyboard。
- 最终时间线按 generation unit 素材编译，共享素材不会因多个 source shots 被重复播放。
- 所有计费和恢复幂等键从 shot 粒度迁移到 generation unit revision 粒度。

## 15. 非目标

- 本计划不尝试自动识别生成视频内每个 beat 的精确时间码；
- 不在没有模型能力证据时假设任意模型支持多节拍或多镜头；
- 不自动修改用户确认的 storyboard 来满足模型固定时长；
- 不把裁切或变速作为默认时长适配方案；
- 不重新生成现有可用视频来完成数据迁移。
