# 分镜视频排队、供应商等待与防重复扣费修复计划

日期：2026-07-23  
状态：问题已确认，待实施  
优先级：P0  
范围：分镜批量生成、单镜头重新生成、异步任务状态、计费任务绑定、供应商结果回收

> 2026-07-24 修订：`waiting_provider`、稳定 settlement key、供应商结果恢复和防重复扣费机制继续适用；但新执行链路的任务、operation、generation key、输出和恢复实体必须按 [叙事节拍与视频生成单元分层执行计划](./2026-07-24-narrative-beats-and-generation-units-execution-plan.md)迁移到 generation unit revision。本文中的 `shot:<shot_id>`、逐 shot task item 和逐 shot 输出路径仅作为 v1 兼容说明，不能用于 v2 多节拍 unit。

## 1. 事故摘要

项目 `487ce4a6aee24668811885a8e81ec188` 暴露了两个相互放大的问题：

1. storyboard 中间镜头被模型写成 `cut` 或 `match_cut` 后，任务调度也随之断链，导致 `s01`、`s03`、`s06`、`s08` 等镜头成为独立根任务并向供应商并行提交；
2. 供应商已经接受任务后，本地把“结果仍在生成/协调”当作普通可重试错误。约 45 秒内耗尽重试次数后，前端显示失败，但远端任务仍继续执行并可能扣费。

现场还确认：

- `task_items.billing_job_id` 在供应商等待阶段仍为 `null`；
- 当前环境没有运行独立的 `server.billing_worker`；
- 多个远端任务后来已经完成，但本地仍停留在 `failed` 或 `receipt_pending`；
- 本地失败后再次走单镜头重新生成路径，会创建新的计费任务，存在重复请求和重复扣费风险。

这不是单一前端显示问题。任务图、任务状态机、计费任务绑定和重新生成幂等性都需要同时修复。

## 2. 修复目标

1. 同一集首次批量生成时建立完整的镜头顺序依赖，视觉上的 `cut` 不再解除调度依赖。
2. 增加 `waiting_provider` 状态，供应商已接受但尚未完成的任务不消耗普通失败重试次数，也不显示为失败。
3. 供应商任务一经接受，立即把对应 `billing_job_id` 持久化到任务项。
4. 同一镜头版本存在活动或可恢复的计费任务时，禁止创建新的供应商任务，只能恢复原任务。
5. 缺少可用的计费协调 worker 时，在任何视频供应商请求发出前失败关闭。
6. 已经发出的任务和已完成结果能够恢复，不重新请求、不重复扣费。

## 3. 核心设计决定

### 3.1 分离视觉连续性、帧继承和调度依赖

当前实现把三个不同概念绑定在 `continuity.mode` 上：

- `cut/carry/match_cut`：视觉转场语义；
- `inherit_previous_tail`：是否使用上一镜尾帧；
- `depends_on`：任务是否必须等待上一镜完成。

修复后必须分开处理：

```text
continuity.mode
  只描述视觉转场，不决定任务是否可以越过上一镜执行

inherit_previous_tail
  只描述帧继承；必须服从已验证的视频模型帧能力契约

execution predecessor
  描述同一集首次生成时的执行顺序，由服务端生成，不接受 LLM 覆盖
```

业务规则：

- 同一集首次批量生成形成 `s01 -> s02 -> ... -> sNN` 的完整顺序链；
- LLM 输出 `cut` 或 `match_cut` 只能改变视觉语义，不能把中间镜头变成可立即提交的根任务；
- 用户显式硬切可以关闭尾帧继承，但仍不解除同一批次的顺序执行；
- 非连续选择不自动扩大用户选择范围。若当前镜头的实际前序镜头未选择且未完成，则进入 `waiting_dependency`，不向供应商提交；
- 不同集、不同项目或明确独立的生成单元可以在受限并发下执行。

任务依赖应由服务端按 `episode + shot order + generation mode` 生成，不能直接从 storyboard 的视觉字段推导。

### 3.2 新增 `waiting_provider` 非终态

任务状态至少调整为：

```text
queued
  -> running
  -> waiting_provider
  -> queued              # 远端结果已可恢复，重新进入本地发布阶段
  -> running
  -> complete
```

其他分支：

```text
queued/running -> waiting_dependency
queued/running -> awaiting_payment
queued/running -> failed             # 仅确定的终态失败
waiting_provider -> failed            # 仅供应商终态失败或恢复截止时间到期
```

约束：

- `ProviderResultPending` 不再转换成 `RetryableTaskError`；
- 增加专用的 `TaskWaitingProvider` 控制流，携带 `billing_job_id` 和建议的下次检查时间；
- 进入 `waiting_provider` 后不再由普通任务 worker 每 5 秒重复执行 handler；
- 供应商轮询由唯一的 billing reconciliation worker 负责；
- 供应商完成并且结果可见后，协调 worker 将任务重新置为可恢复执行，由原 handler 完成本地发布、尾帧提取和依赖释放；
- 普通 `attempt_count/max_attempts` 只用于实际执行失败，供应商轮询次数单独记录，不得耗尽任务重试预算；
- 上游处于 `waiting_provider` 时，下游保持 `waiting_dependency`，不能提前变成 `dependency_failed`。

### 3.3 供应商接受后立即绑定计费任务

当前 `TaskWorker` 只在 handler 成功返回结果后绑定 `billing_job_id`。这导致供应商已接受但 handler 抛出 `ProviderResultPending` 时，任务项仍不知道对应的计费任务。

修复规则：

1. 创建计费 reservation 后使用稳定的 task item settlement key；
2. NewAPI 返回供应商 task reference 并完成 `GenerationJob` 绑定后，立即得到稳定的 `billing_job_id`；
3. handler 抛出 `TaskWaitingProvider(billing_job_id)`；
4. worker 在同一次 claim 内校验用户、项目、operation 和目标镜头版本后绑定 `task_items.billing_job_id`；
5. 绑定成功后原子地将任务转为 `waiting_provider`；
6. 即使进程在远端接受后崩溃，下一次恢复也必须通过 settlement key 找回同一个 `GenerationJob`，不得重新执行 provider submit。

绑定操作必须具备以下保护：

- 计费任务属于同一用户和项目；
- operation、模型、provider route 和镜头版本与任务快照一致；
- 一个 task item 不能改绑到另一个已接受的计费任务；
- 一个活动计费任务不能被两个不同 task item 认领；
- claim 丢失时不覆盖其他 worker 已写入的状态。

### 3.4 活动计费任务只能恢复，不能重发

批量生成和 `/shots/{shot_id}/regenerate` 必须共用同一个服务端门禁。

以下计费状态视为活动或可恢复，不允许新建供应商请求：

```text
reserved
submitted_ambiguous
reference_recovery_pending
receipt_pending
result_pending
payment_required_quote
payment_required
```

处理规则：

- 找到活动任务且属于当前镜头版本、模型和 operation：返回原 task/billing job，进入恢复流程；
- 找到活动任务但请求参数不一致：返回 `409 provider_generation_in_progress`，不得偷偷新建任务；
- 找到 `billed` 且结果可见：复用并发布现有结果；
- 找到明确的 `*_no_charge` 终态：允许用户显式发起新的生成；
- 找到供应商确定失败且账务已结清：允许显式重新生成；
- 已完成镜头的真正二次生成必须创建新的、服务器签发的 generation revision，但只有旧任务终态后才允许；
- 同步 `/regenerate` 路径改为提交统一异步任务，不再直接调用供应商。

数据库侧应增加稳定的 `generation_key` 或等价唯一约束，至少包含：

```text
owner_user_id
project_id
target_entity_type
target_entity_id
target_entity_version
generation_revision
model
operation
```

服务端在项目/镜头锁内检查活动 generation key，并使用数据库唯一约束兜住并发双击和多实例竞争。

### 3.5 billing worker 健康门禁

`waiting_provider` 依赖持续运行的 billing reconciliation worker。仅在 README 中要求人工启动不足以保证计费安全。

实施要求：

- 每个环境恰好运行一个受监管的 `python -m server.billing_worker`；
- worker 定期写入租约或 heartbeat；
- 视频提交接口在 quote 和 provider submit 之前检查 heartbeat；
- heartbeat 缺失或过期时返回 `503 billing_reconciliation_unavailable`；
- 该失败必须发生在供应商请求之前，不创建 chargeable job；
- 开发启动脚本、部署配置和运维健康检查必须包含 billing worker；
- 对 open reconciliation 超过 `next_retry_at`、worker 退出和 `receipt_pending` 老化建立告警。

## 4. 数据与接口变更

### 4.1 数据库

新增 Alembic 迁移：

- 扩展 `task_items.status` 约束，加入 `waiting_provider`；
- 为供应商等待增加 `provider_wait_started_at`、`provider_next_poll_at` 或等价字段；
- 如需观测轮询，增加独立 `provider_poll_count`，不复用 `attempt_count`；
- 增加 generation key 和活动任务唯一性保护；
- 增加 billing worker heartbeat/lease 存储；
- 为 `billing_job_id`、generation key 和活动状态查询补索引。

### 4.2 后端任务 API

`TaskItemResponse.status` 增加 `waiting_provider`。

任务响应在该状态下返回：

```json
{
  "status": "waiting_provider",
  "billing_job_id": "<owned-job-id>",
  "error_code": null,
  "retryable": false,
  "progress": 5
}
```

重新生成冲突统一返回：

```json
{
  "code": "provider_generation_in_progress",
  "task_id": "<existing-task-id>",
  "task_item_id": "<existing-item-id>",
  "billing_job_id": "<existing-owned-job-id>"
}
```

响应只能暴露已经过所有权校验的内部 ID，不暴露 token、quote 细节或供应商密钥。

### 4.3 前端

分镜列表新增明确状态：

- `waiting_provider`：显示“供应商生成中”或“结果回收中”；
- `waiting_dependency`：继续显示“等待上一镜”；
- `failed`：只用于已经确认的终态失败。

交互约束：

- `waiting_provider` 不显示“重试当前分镜”；
- 活动 generation job 存在时禁用重新生成按钮；
- API 返回 `provider_generation_in_progress` 时接管并展示原任务，而不是弹出通用失败；
- 页面刷新或 SSE 重连后从持久化任务恢复该状态；
- 上游等待供应商时，下游继续显示等待，不显示依赖失败；
- 只有明确终态失败且后端允许新 generation revision 时才显示重新生成。

## 5. 现有事故数据恢复

恢复必须先于允许用户再次点击生成，并且全程禁止创建新的 provider request。

步骤：

1. 暂停当前项目的重新生成入口；
2. 启动唯一 billing worker，或执行一次只处理既有任务的 reconciliation；
3. 根据 task item settlement key、`GenerationJob.operation` 和 video generation intent 匹配已有任务；
4. 将错误标为 `provider_result_pending` 且计费任务仍活动的 item 回填 `billing_job_id`，状态改为 `waiting_provider`；
5. 将仅因上游非终态而成为 `dependency_failed` 的子任务恢复为 `waiting_dependency`；
6. 对已经完成的供应商任务下载、校验并发布结果；
7. 发布成功后提取尾帧并依次释放下游任务；
8. 若同一镜头存在多个已接受任务，只自动绑定 settlement key 对应任务；其他任务进入人工审计，不能任意覆盖镜头结果；
9. 输出恢复报告：复用任务数、已发布结果数、仍等待数、重复任务数、确认计费数和未解决项。

如果供应商没有经过验证的取消接口，不得假装已经取消远端任务。

## 6. 实施阶段

### Phase 0：立即止损

- 后端在活动计费任务存在时阻止新的批量生成和单镜头重新生成；
- 前端隐藏 `provider_result_pending` 项目的重试按钮；
- 增加 billing worker 健康门禁；
- 对当前 open reconciliations 执行只恢复、不重发的处理；
- 记录当前重复任务和潜在费用，不自动删除账务证据。

### Phase 1：任务状态与数据库迁移

- 增加 `waiting_provider` 状态及迁移；
- 增加 provider wait/poll 字段；
- 增加 `TaskWaitingProvider` 和原子状态转换；
- 将 provider pending 从普通 retryable failure 中移除；
- 让依赖传播区分非终态等待和终态失败。

### Phase 2：完整镜头依赖图

- 服务端按集和镜头顺序建立 execution predecessor；
- 移除 `cut/match_cut` 对任务依赖图的控制权；
- 保留 `cut` 对帧继承和视觉转场的独立语义；
- 修复部分选择、单独生成中间镜头和跨集边界规则。

### Phase 3：计费任务即时绑定与恢复

- 在 provider task reference 确认后立即绑定 `billing_job_id`；
- billing worker 完成结果回收后恢复对应 task item；
- 复用同一个 billing job 完成本地发布、尾帧提取和依赖释放；
- 覆盖 worker 崩溃、服务重启和 claim 丢失场景。

### Phase 4：统一重新生成与幂等门禁

- 单镜头重新生成改为统一异步任务；
- 增加 generation key 和活动状态唯一约束；
- 重复点击、并发请求和多实例只能得到同一个活动任务；
- 仅在旧任务终态后创建新的 generation revision。

### Phase 5：前端与运维闭环

- 展示 `waiting_provider` 和原任务恢复状态；
- 移除非终态任务的重试入口；
- 增加 worker heartbeat 健康展示和告警；
- 完成真实 NewAPI 长耗时视频任务端到端验收。

## 7. 回归测试

### 7.1 依赖图

- 同一集 5 个镜头全部为 `carry` 时形成完整链；
- 中间镜头由 LLM 输出 `cut` 时仍形成完整执行链；
- `match_cut` 不创建新的根任务；
- 用户显式硬切只关闭帧继承，不解除执行顺序；
- 部分选择缺少未完成前序镜头时不发供应商请求；
- 不同集的首镜头可以成为各自的根任务。

### 7.2 waiting_provider

- 供应商返回 queued/in_progress 后任务进入 `waiting_provider`；
- 连续轮询超过 10 次仍不变成 `failed`；
- provider poll 不增加普通 `attempt_count`；
- 上游等待时下游保持 `waiting_dependency`；
- 供应商完成后任务恢复、发布并变成 `complete`；
- 供应商明确失败后才进入终态 `failed` 并传播依赖失败。

### 7.3 计费绑定与幂等

- 第一次 provider accept 后 `task_items.billing_job_id` 立即非空；
- accept 后进程崩溃，重启只恢复原 job；
- 任务 worker 和 billing worker 并发时不会重复提交；
- 连续点击两次重新生成只调用一次 `execute_quoted`；
- 两个服务实例同时提交只创建一个活动 generation job；
- 活动 job 参数不一致时返回 409，不创建第二个任务；
- payment required、receipt pending 和 result pending 都复用原 job；
- `*_no_charge` 终态允许显式创建新 revision。

### 7.4 运行与恢复

- billing worker 不健康时请求在 provider submit 前返回 503；
- worker 重启后继续处理过期的 open reconciliation；
- 旧 `provider_result_pending` 失败项可以迁移为 `waiting_provider`；
- 已完成远端结果恢复时不产生新供应商请求；
- 重复远端任务不会被静默选中覆盖当前镜头；
- SSE 断线和页面刷新后状态一致。

## 8. 验收标准

- 同一集批量生成时，不再出现“隔一个镜头直接排队”；
- `cut/match_cut` 不再解除任务执行依赖；
- 供应商已经接受的视频任务在前端显示生成中，而不是失败；
- 供应商等待任意合理时长都不耗尽普通重试次数；
- 每个已接受任务都能从 task item 追溯到唯一 billing job；
- 活动任务存在时，任何批量、单镜头、重试或多实例请求都不会创建第二个供应商任务；
- billing worker 缺失时不会发出视频供应商请求；
- 服务重启、页面刷新和 SSE 断线后仍能恢复原任务；
- 已有远端结果可以发布，恢复过程不重新计费；
- 只有供应商明确终态失败或已确认 no-charge 后，用户才能重新生成。

## 9. 明确不做

- 不把 `max_attempts` 简单调大来掩盖状态机错误；
- 不让前端用更长轮询时间模拟 `waiting_provider`；
- 不依赖 LLM 正确输出 `carry` 来保证计费安全；
- 不在活动任务未结清时允许用户“强制重新生成”；
- 不把供应商处理中误写为失败；
- 不在没有已验证取消契约时声称已经取消远端任务；
- 不放宽 NewAPI 首尾帧能力契约。时长 profile 与帧能力仍按实际接入验证结果分别处理。

## 10. 涉及的主要代码

- `server/app/main.py`：批量任务图、重新生成入口、提交前门禁；
- `server/app/continuity_frames.py`：帧继承需求，不再控制完整执行链；
- `server/app/tasks/models.py`：`waiting_provider` 数据状态；
- `server/app/tasks/schemas.py`：API 状态契约；
- `server/app/tasks/service.py`：状态转换、依赖传播、恢复；
- `server/app/tasks/worker.py`：`TaskWaitingProvider` 控制流和即时绑定；
- `server/app/tasks/shot_videos.py`：供应商等待处理；
- `server/app/openmontage_runner.py`：稳定 generation key 与计费任务复用；
- `server/app/billing/reconciliation.py`：完成后恢复 task item；
- `server/billing_worker.py`：heartbeat、持续协调和运行健康；
- `server/alembic/versions/`：状态、索引和唯一约束迁移；
- `web/src/domain/types.ts`：前端任务状态；
- `web/src/features/storyboard/`：状态展示和重试门禁；
- `web/src/features/generation/GenerationService.ts`：活动任务冲突接管；
- `server/tests/test_async_shot_generation.py`、`server/tests/test_async_tasks.py`、`server/tests/test_billing_e2e.py`：主要回归覆盖。
