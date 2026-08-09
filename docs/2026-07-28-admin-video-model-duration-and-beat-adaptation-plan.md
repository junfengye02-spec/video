# 管理员视频模型时长与故事节拍适配计划

日期：2026-07-28  
状态：需求已确认，待实施  
范围：管理员模型配置、视频模型 profile、故事节拍到 generation unit 的规划、生成提示词适配、执行与最终合成

## 1. 背景

当前系统已经具备以下基础能力：

- `/api/generation/models?capability=video` 通过 NewAPI `/v1/models` 获取视频模型列表；
- `VideoModelProfile` 描述模型时长、首尾帧能力和多节拍能力；
- generation planner 可以把一个或多个故事节拍映射为 generation unit；
- generation unit、执行账本和生成计划会保存 profile revision；
- 最终合成可以使用探测到的源视频实际时长。

当前主要问题是视频模型单次生成时长仍由 `server/app/video_model_profiles.py` 的静态 profile 写死。新增或更换视频模型时，需要修改后端代码，且新模型会因为时长契约未知而被阻止生成。

同时，现有多节拍规划仍受 `supports_multi_shot_prompt` 和 `max_narrative_beats_per_unit` 的静态配置限制，不能完全按照灵感阶段给出的节拍建议时长和所选视频模型的单次生成时长自动规划。

## 2. 已确认的产品规则

### 2.1 管理员只配置模型单次生成时长

- 管理后台按视频模型统一配置“单次调用生成秒数”；
- 同一个模型默认只设置一个时长，不要求管理员分别配置文生视频、图生视频、首尾帧视频等 operation；
- 服务端在构造不同 operation 的有效 profile 时，共享该模型级时长配置；
- 管理员不配置“最多覆盖几个故事节拍”；
- 管理员不需要通过代码或配置文件登记新的模型 ID。

### 2.2 模型列表必须来自供应商接口

- 管理后台通过服务端接口获取当前 NewAPI 视频模型列表；
- 服务端继续以 NewAPI `/v1/models` 为模型目录来源；
- 管理员页面展示每个模型的已配置/未配置状态和当前单次生成秒数；
- 供应商新增模型后，管理员刷新页面即可看到并配置，无需发布后端代码；
- 供应商暂时删除的模型不自动删除其历史配置，避免模型重新出现后丢失设置。

### 2.3 未配置模型不得使用猜测时长

- 新模型未设置秒数时，状态为“未配置”；
- 未配置模型可以出现在模型目录中，但不能创建付费视频生成任务；
- 不允许默认回退到 5 秒、10 秒或根据模型名称猜测时长；
- 用户侧模型选择器应明确显示“管理员尚未配置生成时长”；
- generation plan 应返回可识别的阻塞原因，而不是在供应商请求阶段失败。

### 2.4 灵感模型决定叙事节拍建议时长

- 灵感阶段继续生成高层故事节拍；
- 每个故事节拍保留 `recommended_duration_seconds`，必要时保留 `duration_range_seconds`；
- 这些数值表达叙事节奏建议，不是供应商请求时长，也不是最终时间线时长；
- 灵感阶段不需要知道用户最终选择哪个视频模型；
- 切换视频模型不得反向修改已经确认的故事节拍。

### 2.5 视频模型时长决定 generation unit 的原生时长

- 用户选择视频模型后，规划器读取管理员配置的单次生成秒数；
- 固定时长模型的每个 generation unit 都按该完整时长请求供应商；
- generation unit 内节拍建议时长之和可以小于模型时长；
- 例如 A 为 3 秒、B 为 4 秒，固定 10 秒模型可以生成一个覆盖 A+B 的 10 秒 unit；
- 该 unit 的内容建议时长是 7 秒，但 `requested_duration_seconds`、原生素材时长和默认时间线时长均为 10 秒；
- 不得因为内容建议为 7 秒而把生成出的 10 秒素材裁成 7 秒或加速到 7 秒。

### 2.6 多节拍数量由内容时长自动决定

- `max_narrative_beats_per_unit` 不再作为需要管理员维护的固定上限；
- 规划器按照故事顺序、节拍建议时长和可合并边界自动形成 generation units；
- 一个 unit 能覆盖几个节拍，由“相邻节拍累计建议时长是否适合当前模型单次时长”决定；
- 新配置模型不能因为缺少静态 `supports_multi_shot_prompt` 条目而默认退化为一节拍一调用；
- 如果供应商未来存在明确且已验证的多段提示词限制，可以保留为服务端技术限制，但不能让未知静态配置覆盖管理员已配置时长后的正常自动规划。

### 2.7 单个节拍超过模型时长时使用模型拆解

- 不允许按照字符数、句号或固定比例机械拆分提示词；
- 先由确定性代码计算至少需要多少个调用，例如 `ceil(8 / 5) = 2`；
- 然后执行一次独立的“视频生成适配规划”文本模型调用；
- 该调用可以复用灵感阶段使用的文本模型，但必须使用独立任务和独立结构化提示词；
- 文本模型根据完整故事上下文、当前节拍、前后节拍、角色/场景约束和视频模型单次时长，生成有顺序的视觉子段提示词；
- 所有子段保留同一个原始 `beat_id`，同时拥有稳定的子段 ID、顺序、提示词和连续性关系；
- 原始故事节拍保持不变，模型切换只重新生成适配计划；
- 如果节拍明确标记为不可拆，则不得静默强拆，应阻止生成并建议更换更长时长模型或修改故事节拍。

### 2.8 最终合成使用完整实际素材时长

- 固定 10 秒模型生成的 unit 默认在时间线上使用完整 10 秒；
- 固定 5 秒模型为一个 8 秒建议节拍生成两个 unit 时，默认时间线总时长为 10 秒；
- `source_duration_seconds` 必须来自下载后媒体探测；
- `timeline_duration_seconds` 默认等于探测到的完整源时长；
- 供应商实际返回 10.005 秒时，以探测值为源事实，不把故事节拍建议值当作实际时长；
- 裁切、变速或缩短只能是用户明确选择的编辑决策，不能作为默认适配行为。

### 2.9 配置变更只影响新计划

- 管理员更新模型秒数后，新生成或重新预览的 generation plan 立即使用新配置；
- 已排队、运行中、等待供应商和已完成的 generation unit 保留原 profile 快照；
- 不回写历史 `requested_duration_seconds`、账单、输出素材或时间线；
- 修改前已经预览但尚未提交的计划必须变为 stale，并要求重新预览；
- plan ID 和 unit ID 必须包含新的 `profile_revision`，避免新旧配置混用。

## 3. 核心概念与时长语义

必须继续区分以下四类时长：

| 字段 | 含义 | 来源 |
|---|---|---|
| `recommended_duration_seconds` | 一个故事节拍建议占用的叙事时间 | 灵感/故事规划文本模型 |
| `configured_call_duration_seconds` | 视频模型单次调用的管理员配置时长 | 管理员数据库配置 |
| `requested_duration_seconds` | 当前 generation unit 提交给供应商的时长 | 有效模型 profile |
| `source_duration_seconds` | 下载后探测到的素材实际时长 | ffprobe/媒体探测 |
| `timeline_duration_seconds` | 最终时间线默认使用时长 | 默认等于完整源时长 |

不得用 `recommended_duration_seconds` 覆盖后面三类时长。

## 4. 数据模型设计

### 4.1 新增管理员模型时长表

建议新增 `video_model_duration_settings`：

```text
provider                       string, default "newapi"
model_id                       string
call_duration_seconds          number > 0
version                        integer >= 1
created_at                     datetime
updated_at                     datetime
```

约束：

- 唯一键为 `provider + model_id`；
- 时长必须是有限正数；
- 使用版本字段进行并发更新保护；
- 模型从供应商目录消失时不级联删除；
- 当前静态已验证的 Omni/Sora 时长在迁移或 bootstrap 时写入数据库，运行时数据库成为时长权威来源。

### 4.2 有效 VideoModelProfile

`VideoModelProfile` 继续作为 generation plan 和执行快照的合同，但时长来源调整为：

1. 查询 `provider + model_id` 的管理员时长配置；
2. 已配置时，为当前 operation 构造 `duration_mode=fixed` 和 `fixed_duration_seconds=call_duration_seconds`；
3. `profile_revision` 由 provider、model ID、配置 version 和时长生成稳定版本；
4. 未配置时返回 `duration_mode=unknown`；
5. 首尾帧、Extend 等非时长能力继续独立管理，不能从时长推断；
6. 模型级时长适用于该模型当前支持的所有视频 operation。

### 4.3 新增故事节拍子段

为支持一个故事节拍跨多个 generation units，建议在 generation plan 中增加 `generation_segments`，或扩展现有 `GenerationPromptSegment`：

```text
id
source_beat_id
source_shot_id
segment_index
segment_count
recommended_content_duration_seconds
prompt
transition
continuity_requirements
```

规则：

- 同一个 `source_beat_id` 可以出现在多个 generation segments 中；
- segment ID 必须由故事版本、beat ID、模型 profile revision、顺序和内容哈希稳定生成；
- generation unit 保存有序 `source_segment_ids`；
- 一个 unit 可以覆盖一个节拍的一个子段，也可以覆盖多个相邻节拍/子段；
- 执行账本继续保存原始 beat/shot 映射，保证资源追踪和重新生成能力。

现有“每个 shot 在计划中只能出现一次”的验证需要改为“每个 generation segment 恰好被一个 pending/protected unit 覆盖”，否则无法表示一个 beat/shot 跨多个 unit。

## 5. 服务端接口计划

### 5.1 保留用户侧模型目录接口

继续使用：

```http
GET /api/generation/models?capability=video
```

返回：

- NewAPI 当前模型 ID 列表；
- 基于数据库配置生成的有效 profiles；
- 未配置模型的 profile 为 `duration_mode=unknown`；
- 可增加 `duration_configuration_status`，便于用户侧显示明确原因。

### 5.2 新增管理员模型配置接口

建议新增独立 router：

```http
GET /api/admin/video-model-duration-settings
PUT /api/admin/video-model-duration-settings/{model_id}
```

管理员 GET 返回：

```text
provider
model_id
catalog_status: available | missing_from_catalog
configuration_status: configured | unconfigured
call_duration_seconds
version
updated_at
```

管理员 PUT 请求：

```json
{
  "call_duration_seconds": 10,
  "expected_version": 3,
  "reason": "供应商模型升级后重新验证为固定 10 秒"
}
```

写接口要求：

- `require_admin`；
- CSRF 校验；
- 服务端数值校验；
- 乐观并发控制；
- 写入 `AdminAuditLog`，记录 before/after、管理员和 reason；
- 不把供应商密钥、token alias 或其他凭据返回前端。

### 5.3 上游目录失败处理

- NewAPI 模型目录可用时，返回实时模型列表并合并数据库配置；
- NewAPI 暂时不可用时，管理员接口返回已持久化配置，同时明确标记目录刷新失败；
- 不应因为目录暂时不可用而清空现有配置；
- 用户侧模型选择接口继续按现有错误合同处理供应商目录不可用。

## 6. 管理员后台计划

### 6.1 新页面与导航

- 新增路由 `/admin/video-models`；
- 管理员账户菜单新增“模型管理”；
- 页面继续使用 `RequireAdmin` 和现有后台 shell；
- 不把模型配置混入计费管理页面。

### 6.2 页面内容

页面提供：

- 刷新模型目录按钮；
- 模型 ID 搜索；
- 模型列表；
- 已配置/未配置状态；
- 单次生成秒数输入框；
- 单模型保存操作；
- 供应商目录异常提示；
- 已从目录移除但仍有配置的模型状态；
- 修改确认对话框和变更原因输入。

页面不提供：

- 最大故事节拍数；
- `supports_multi_shot_prompt` 开关；
- 静默默认秒数；
- 对历史 generation units 的批量回写。

## 7. 自动规划算法

### 7.1 输入

```text
confirmed narrative beats
storyboard shots and continuity constraints
selected provider/model
effective model profile
configured_call_duration_seconds
protected generation units
target duration (optional)
```

### 7.2 相邻节拍装箱

对固定时长 `D` 的模型：

1. 保持故事节拍顺序；
2. 读取每个节拍的建议时长；
3. 只合并语义上允许合并的相邻节拍；
4. 不跨越 `can_merge_with_next=false`、不可拆动作、不可破坏情绪或明确连续性边界；
5. 在允许范围内寻找有序分组，使每组建议内容时长尽量接近但不超过 `D`；
6. 不使用固定的节拍数量上限；
7. 每个最终 unit 的 `requested_duration_seconds=D`；
8. 计划的 `native_total_duration_seconds=unit_count * D`；
9. 目标时长不匹配时展示真实原生总时长，不能靠裁切伪装匹配。

建议继续采用确定性的有序动态规划，而不是依赖前端或 LLM 决定 unit 数量。排序目标依次为：

1. 满足不可拆和连续性硬约束；
2. 完整覆盖所有 generation segments；
3. 减少未利用的原生时长；
4. 减少不必要的供应商调用；
5. 在多个等价结果中保持稳定分组和稳定 ID。

### 7.3 不足一个完整调用的内容

例如 A=3 秒、B=4 秒、模型 D=10 秒：

```text
Unit 1 source beats: [A, B]
recommended content duration: 7
requested duration: 10
native duration: 10
timeline duration: 10（生成后以实际探测值为准）
```

生成适配提示词应把剩余时间用于合理的动作展开、停顿、反应、运镜或转场，不得虚构新的剧情事实。

### 7.4 单个节拍超过调用时长

例如 Beat B 建议 8 秒、模型 D=5 秒：

1. 确定性代码计算 `segment_count=ceil(8/5)=2`；
2. 若 B 可拆，调用生成适配文本模型生成 B-1、B-2；
3. 两个子段都保留 `source_beat_id=B`；
4. B-1 和 B-2 分别形成 5 秒 generation unit；
5. 原生总时长为 10 秒；
6. 最终时间线完整使用两个素材，不把结果裁成 8 秒；
7. 若 B 不可拆，计划返回阻塞问题和“更换模型/修改节拍”选项。

## 8. 生成适配文本模型任务

### 8.1 任务边界

该任务位于“选择视频模型之后、创建付费视频任务之前”，逻辑上独立于最初灵感阶段。

它可以复用现有文本模型客户端，但必须有单独的请求类型、结构化输出 schema、缓存键和错误码。

### 8.2 输入上下文

- 完整且已确认的故事节拍列表；
- 当前节拍及其建议时长；
- 前后节拍摘要；
- 对应 storyboard shot；
- 角色、场景、道具和连续性约束；
- 所选视频模型 ID；
- 单次固定生成时长；
- 确定性代码计算出的子段数量；
- 禁止增加、删除或改变的剧情事实。

### 8.3 输出要求

- 严格 JSON；
- 子段数量与请求一致；
- 每个子段拥有明确的开始状态、动作进展、结束状态和视觉提示词；
- 子段按时间顺序推进，不能重复同一个动作；
- 保留原始人物、场景、道具、对白和因果关系；
- 后一子段能够承接前一子段尾部状态；
- 不把剩余时长填充成新剧情；
- 多节拍共用一个 unit 时，输出有序 prompt segments，覆盖每个来源 beat。

### 8.4 校验与缓存

- 服务端使用 schema 校验输出数量、ID、顺序和必填字段；
- 确定性校验负责确认所有来源 beats/segments 被完整覆盖；
- 缓存键至少包含 storyboard revision、beat 内容哈希、model ID、profile revision 和 segment count；
- 相同输入重复预览时复用适配结果，避免重复文本模型费用；
- 模型秒数或故事内容变化后缓存自然失效。

## 9. 执行、账本和时间线

- 每个 generation unit 仍对应一个 task item、一次供应商调用和一个主视频素材；
- task snapshot 保存完整有效 profile、profile revision、source beat IDs、source segment IDs 和请求时长；
- 一个 beat 跨多个 units 时，账本允许多个 unit 指向同一 beat，但每个 generation segment 只能被一个 active unit 覆盖；
- 多个 beats 共用一个 unit 时，最终时间线只能加入该 unit 输出一次；
- 输出媒体发布后立即探测并写入 `source_duration_seconds`；
- render compiler 默认完整播放 active unit 的源素材；
- 已完成 unit 在管理员更新模型秒数后不重新计费、不重新生成、不改时长；
- 重新生成时创建新 revision，新结果成功前保留旧 active 素材。

## 10. 迁移与兼容策略

### 10.1 数据库迁移

- 新增 `video_model_duration_settings` 表；
- 将当前已验证的模型级固定时长作为初始数据写入数据库；
- 不迁移测试专用虚拟模型到生产默认配置；
- 为 SQLite 和 PostgreSQL 保持相同唯一约束、版本约束和正数约束。

### 10.2 旧计划与旧素材

- 已有 generation unit 的 `profile_json` 和 `profile_revision` 保持权威；
- 旧候选计划提交时重新构建当前计划；
- profile revision 不一致时返回 `generation_plan_stale`；
- 已完成视频继续按 ffprobe 实际时长合成；
- 不自动重写旧 storyboard 或 narrative beats。

### 10.3 静态 profile 退场

- 时长字段从 `_STATIC_PROFILES` 迁移到数据库；
- 静态 profile 只保留已经验证且不能由管理员秒数表达的技术能力；
- 新模型不再需要在 Python 静态表中新增时长条目；
- 最终验收必须证明仅通过后台配置即可让供应商目录中的新模型通过时长校验并生成计划。

## 11. 安全与审计

- 管理员读取和写入接口均要求管理员角色；
- 写接口要求 CSRF；
- 每次新增或修改记录管理员 ID、before、after、reason 和目标模型；
- 响应不得包含 NewAPI 密钥或 token alias；
- 数值必须拒绝 NaN、Infinity、零和负数；
- 并发更新必须通过 version 检测冲突；
- 管理员修改模型秒数不直接触发任何付费生成任务。

## 12. 实施阶段

### Phase 1：模型时长持久化

- 新增数据库模型和 Alembic migration；
- bootstrap 当前已验证的模型级时长；
- 新增读取、写入和 profile revision 服务；
- 将 `video_model_profile()` 改为使用持久化配置。

完成条件：不修改 Python 静态表即可为一个供应商新模型建立有效固定时长 profile。

### Phase 2：管理员接口与审计

- 新增管理员模型配置 router；
- 接入 NewAPI 模型目录；
- 实现列表、单模型更新、目录失败降级、版本冲突和审计日志；
- 更新 `/api/generation/models` 返回有效配置状态。

完成条件：管理员可以通过 API 查看实时模型并保存时长，普通用户不能写入。

### Phase 3：管理员页面

- 新增 `/admin/video-models`；
- 增加管理员导航；
- 实现刷新、搜索、状态、时长编辑、确认和原因输入；
- 补充加载、空列表、目录异常、保存冲突和成功状态。

完成条件：供应商新增模型后，管理员无需部署代码即可在页面中配置秒数。

### Phase 4：自动节拍装箱

- 去除固定 `max_narrative_beats_per_unit` 对正常规划的限制；
- 根据节拍建议时长和模型固定时长生成有序最优分组；
- 保留语义边界、不可拆约束和 continuity 约束；
- 确保 underfilled unit 仍使用完整模型原生时长。

完成条件：3 秒 + 4 秒节拍在 10 秒模型下形成一个 10 秒 unit，最终时间线为完整 10 秒。

### Phase 5：超长节拍模型拆解

- 增加 generation segments 数据合同；
- 实现确定性 segment count；
- 增加结构化文本模型适配任务；
- 支持一个 beat 映射多个 units；
- 增加缓存、验证和不可拆阻塞路径。

完成条件：8 秒建议节拍在 5 秒模型下生成两个共享同一 beat ID 的 5 秒 units，提示词语义连续且不机械切割。

### Phase 6：执行账本与合成

- 扩展 unit snapshot 和 ledger 的 segment 映射；
- 调整 exact coverage 验证；
- 确保多 unit 同 beat 和多 beat 同 unit 均不会漏播或重复播；
- 保持探测源时长和完整时间线播放；
- 验证配置更新后的历史保护和 stale plan 行为。

完成条件：最终渲染严格按 active unit 的完整实际素材时长合成。

### Phase 7：发布门与端到端验收

- 增加 feature flag 或 schema version，避免半迁移环境启用新规划；
- 完成 SQLite/PostgreSQL 双路径测试；
- 完成管理员后台、计划预览、生成执行和最终渲染的端到端测试；
- 完成旧项目、运行中任务和已完成项目的回归验证。

## 13. 测试计划

### 13.1 后端配置测试

- 管理员能读取供应商模型目录和配置状态；
- 普通用户读取管理员接口返回 403；
- 非管理员或无 CSRF 写入被拒绝；
- 新模型保存 10 秒后立即得到 fixed profile；
- 未配置模型继续返回 unknown 并阻止计费任务；
- 更新配置产生新 version、profile revision 和审计记录；
- 并发 expected version 冲突不会覆盖新值；
- 上游目录失败不会删除已保存设置。

### 13.2 规划器测试

- A=3、B=4、D=10：一个 unit，requested/native/timeline 为 10；
- A=3、B=4、C=6、D=4、模型 D=10：形成 `[A+B]`、`[C+D]` 两个 10 秒 units；
- 不可合并边界不会被跨越；
- 不再因为固定 max beat count 把本可合并内容拆开；
- 配置更新后计划 ID 和 unit ID 改变；
- 旧预览提交返回 `generation_plan_stale`。

### 13.3 超长节拍测试

- Beat=8、D=5：计算两个 segments 和两个 5 秒 units；
- 两个 segments 共享 source beat ID，顺序稳定；
- 文本适配输出数量不符时拒绝计划；
- 适配输出增加剧情事实时由验证/审查路径阻止；
- `cannot_split` 的 8 秒 beat 在 5 秒模型下返回阻塞问题；
- 相同输入重复预览命中适配缓存。

### 13.4 执行与渲染测试

- 7 秒建议内容生成的 10 秒素材完整进入时间线；
- 两个 5 秒 units 完整合成为 10 秒；
- 实际探测 10.005 秒时保留实际源时长；
- 多 beats 共用一个 unit 时只加入一次时间线；
- 同一 beat 的两个 units 均按顺序加入时间线；
- 管理员改秒数不修改 queued/running/complete unit；
- 无显式编辑决策时不存在默认裁切或变速。

### 13.5 前端测试

- 只有管理员看到“模型管理”入口；
- 模型列表来自 API，不使用前端静态数组；
- 未配置状态、已配置秒数和目录缺失状态正确展示；
- 保存前要求确认和原因；
- 保存成功后刷新显示新 version；
- 用户侧模型选择器显示有效时长或未配置阻塞原因；
- generation plan 预览展示内容建议时长、模型请求时长和原生总时长的区别。

## 14. 最终验收标准

1. NewAPI 新增一个视频模型后，无需修改后端代码即可在管理员后台看到该模型。
2. 管理员为该模型设置单次生成秒数后，用户侧模型目录立即返回有效 fixed profile。
3. 未设置秒数的模型不能创建付费视频生成任务，且没有隐式默认值。
4. 灵感模型输出的节拍建议时长保持独立，不被视频模型配置反向覆盖。
5. 相邻可合并节拍按照建议时长自动装入 generation unit，不需要管理员设置最大节拍数。
6. 3 秒 + 4 秒内容使用固定 10 秒模型时，生成和最终合成都按完整 10 秒处理。
7. 8 秒节拍使用固定 5 秒模型时，由文本模型生成两个语义连续的子段提示词，最终得到两个完整 5 秒 units。
8. 不可拆节拍不会被机械拆分或静默截断。
9. 配置更新使未提交旧计划失效，但不修改任何历史执行记录、账单或素材。
10. 最终时间线默认完整使用媒体探测时长，不按故事节拍建议值裁切或变速。

## 15. 预计主要修改文件

服务端：

- `server/app/video_model_profiles.py`
- `server/app/generation_unit_planner.py`
- `server/app/main.py`
- `server/app/generation_units/models.py`
- `server/app/generation_units/schemas.py`
- `server/app/generation_units/service.py`
- `server/app/openmontage_runner.py`
- `server/app/auth/models.py`（仅复用审计模型，原则上不改表结构）
- `server/app/admin/` 下新增模型配置 router/service
- `server/alembic/versions/` 下新增 migration
- `schemas/artifacts/generation_plan.schema.json`
- `schemas/artifacts/generation_execution.schema.json`

前端：

- `web/src/app/routes.ts`
- `web/src/app/routeModules/billingRoutes.tsx` 或拆分独立 admin routes
- `web/src/features/account/AccountShellAction.tsx`
- `web/src/pages/admin/` 下新增视频模型管理页面
- `web/src/features/generation/GenerationService.ts`
- `web/src/features/generation/GenerationModelPicker.tsx`
- `web/src/features/storyboard/components/GenerationPlanPanel.tsx`
- `web/src/domain/types.ts`
- `web/src/i18n.ts`

测试：

- `server/tests/test_model_duration_api.py`
- `server/tests/test_video_model_profiles.py`
- `server/tests/test_generation_unit_planner.py`
- `server/tests/test_generation_units.py`
- 新增管理员模型配置 API 测试
- 新增管理员模型配置页面测试
- 扩展 generation plan、执行账本和最终渲染测试
