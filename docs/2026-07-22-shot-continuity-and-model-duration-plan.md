# 分镜连续性与视频模型时长适配计划

日期：2026-07-22  
范围：分镜生成、单镜头重新生成、视频模型时长适配、最终合成

> 2026-07-24 修订：本文件关于“叙事分镜与 generation unit 一镜一调用”的规则、6 镜头 Omni 生成 60 秒的示例，以及对应实施/验收项已被 [叙事节拍与视频生成单元分层执行计划](./2026-07-24-narrative-beats-and-generation-units-execution-plan.md)取代。新的权威语义是保留用户确认的叙事分镜，并在模型选定后将一个或多个允许合并的相邻叙事节拍映射到实际计费 generation unit。连续性、首尾帧、三类时长和完整源素材合成部分继续适用。

## 1. 已确认的问题

### 1.1 中间镜头连续性没有落到新生成的分镜

当前新生成的分镜没有持久化默认连续性。`ShotContinuity` 的默认值是 `mode=cut`、`inherit_previous_tail=false`，分镜生成器也没有为第 2 个及以后的镜头补 `carry`。

因此，单独生成一个中间镜头时，批量生成接口认为它不需要上一镜依赖，不会显示“上一个分镜未生成，暂时无法生成当前分镜”。

既定业务语义应为：

- 首次生成中间镜头：上一镜视频完成后提取上一镜尾帧，作为当前镜头首帧；
- 当前镜头生成完成后提取当前镜头尾帧，供下一镜使用；
- 已完成镜头二次生成：当前镜头的首帧和尾帧都必须可用；
- 缺少依赖时阻止生成，不退化为纯文本视频。

这里的“上一镜首帧”在当前数据模型中实际对应“上一镜尾帧作为当前镜头首帧”。

### 1.2 分镜目标时长与模型实际输出时长被混为一层

刚生成的项目 `65a71f19e0614b578bc6b6c1d567cb27` 已核实：

- 6 个源视频实际都是约 `10.005s`；
- 分镜和 `asset_manifest` 都记录为每镜 `5s`；
- `edit_decisions` 将每镜 `source_out_seconds` 固定为 `5`；
- 最终成片被固定为 `30s`。

当前代码存在两个强制截断点：

- 视频请求使用 `_shot_duration_seconds()` 的 5 秒作为 `seconds`；
- FFmpeg 合成使用分镜时长生成 `-t 5 -i input.mp4`。

当 Omni 实际返回 10 秒时，后 5 秒被截掉，导致动作/情绪在镜头末尾突然中断。若改成把 10 秒压缩到 5 秒，则会产生明显加速，这两种行为都不能作为默认策略。

### 1.3 模型能力目录没有提供时长契约

`/api/generation/models` 目前只返回模型 ID，不返回：

- 固定时长还是可变时长；
- 支持的时长集合或最小/最大时长；
- 实际输出时长；
- 首尾帧原生能力。

因此前端可以让用户选择 `omni_flash-10s` 或其他模型，但分镜仍然按统一 5 秒生成。

### 1.4 灵感阶段没有写死镜头数，但后续流程又把时长均分成固定节奏

当前灵感生成器明确要求“暂不创建 storyboard/shot list”，前端确认灵感时也没有默认提交 `shot_count`。这一层方向是对的，应继续保留。

问题重新出现在分镜规划和产物同步阶段：

- storyboard 提示词虽然允许模型自行决定镜头数，但仍用“多数短剧 3-12 镜头”作为固定数值偏置；
- `_billing_shot_count_instruction()` 保留了缺省 5 镜头的兜底，未来若辅助函数不可用会重新写死为 5；
- `Shot` 没有正式的模型请求时长字段，`_with_target_shot_durations()` 会把目标总时长平均分给所有缺时长镜头；
- 创作蓝图前端用 `总时长 / 镜头数` 展示“镜头时长”，把内容分镜误写成均匀节拍；
- 后续视频请求和时间线继续把这个均分值当作供应商时长和实际素材时长。

因此不能通过换一个固定的节拍数、镜头数或“建议每镜 5 秒”修复。叙事拆分必须由内容决定；模型时长只能在模型选定后的生成计划中出现。

## 2. 目标

1. 连续镜头依赖、单独生成、二次生成三条路径使用同一套首尾帧门禁。
2. 将“模型输出时长”和“时间线使用时长”拆成两个明确字段。
3. 对固定 10 秒、固定 12 秒和可变时长模型分别处理，不再静默截断或变速。
4. 目标时长与模型能力不兼容时，在提交生成前明确提示并给出可执行选择。
5. 合成默认保持原始播放速度和完整镜头动作；任何裁切、变速都必须是显式的编辑决策。
6. 灵感和故事规划不保存固定 `beat_count`、默认 `shot_count` 或统一每镜时长；镜头数量由内容自然产生并允许用户编辑。

## 3. 推荐方案

### 3.1 建立服务端模型能力配置

增加服务端的 `VideoModelProfile`（可以先使用静态配置，后续再由供应商目录补充）：

```text
provider
model_id
operation: text_to_video | image_to_video | first_last_frame_to_video | extend
duration_mode: fixed | supported_values | flexible | unknown
fixed_duration_seconds: number | null
supported_duration_seconds: number[]
min_duration_seconds: number | null
max_duration_seconds: number | null
supports_start_frame: boolean
supports_end_frame: boolean
supports_extend: boolean
supports_multi_shot_prompt: boolean
contract_source: provider_catalog | verified_override
```

能力必须描述“当前 provider 接入链路实际能提交并验证的契约”，不能描述模型品牌在其他官网或供应商可能具备的能力。时长契约与帧契约要分别按证据处理：已验证 `fixed=10` 不代表首帧或尾帧也已验证。

首批至少配置：

- `omni_flash-10s`: `fixed=10`；
- 当前接入的 Sora 具体模型 ID：按已验证接口契约配置为 `fixed=12`，不能只按“Sora”品牌名推断；
- 无限制/可选时长模型：`flexible` 或 `supported_values`，不能根据模型名称猜测。

当前 `provider=newapi` 的 `/v1/videos` 只提供普通 `images` 数组，没有已验证的原生 start/end-frame 字段。因此 `omni_flash-10s`、Veo 和其他经该链路调用的模型都必须返回 `supports_start_frame=false`、`supports_end_frame=false`；Omni 的 `fixed=10` 仍可保留。需要首帧或首尾帧的 generation unit 可以明确降级为 `reference_to_video`：按时间顺序优先放置边界帧，后续继续携带当前镜头绑定的人物、场景和道具资源图；普通资源按资产轮询，先为每个资产选择一张代表图，再考虑同一资产的第二视图。原先本地写死的三图上限已删除，只有 provider/model profile 中经过验证的 `max_reference_images` 才能截断。长系列按双向关系解析当前镜头资源：同时读取镜头的 `asset_ids` 和资源的 `shot_ids`，不会因旧项目 `asset_ids` 为空而漏掉人物、场景或道具，也不会把全剧资产放进单次请求。发送给模型的提示词必须逐张声明角色，资产图只能约束对应对象的身份或外观，不能覆盖边界帧的时间状态与构图；结果必须记录 `degraded_from_operation`，不能包装成“已锁定首尾帧”。

同一个模型在 text-to-video、image-to-video、首尾帧插值和 Extend 模式下可能支持不同的时长，因此 profile 的键必须至少包含 `provider + model_id + operation`。`/api/generation/models` 返回模型 ID 时同时返回对应 operation 的 profile。旧客户端仍可读取 `models` 字段，新客户端使用 profile 做校验和时长推荐。

### 3.2 分离三个时长概念

每个镜头以及编辑决策分别保留：

- `requested_duration_seconds`：提交给模型的目标时长；
- `source_duration_seconds`：下载并探测到的实际视频时长；
- `timeline_duration_seconds`：最终时间线实际使用的时长。

生成完成后必须以探测结果更新 `source_duration_seconds`，不能继续把请求值当成实际时长。现有 `source_in_seconds/source_out_seconds` 和 `timeline_*` 字段继续使用，但必须来自同一份明确的编辑决策。

### 3.3 灵感、叙事分镜和模型执行计划分层

视频模型后选并不要求灵感阶段猜测一个“通用镜头时长”。正确做法是让三个阶段各自保存不同语义，后一个阶段不能反向伪装成前一个阶段的事实。

#### 3.3.1 灵感阶段只确认创作意图

灵感阶段允许保存：

- 用户明确提出的 `target_duration_seconds`；用户未指定时保持 `null`，不能擅自补 30 秒、60 秒等默认值；
- 标题、故事目标、受众、形式、画幅、风格、情绪和声音方向；
- `story_outline`、必须出现的事件/对白/角色，以及事件先后和不可破坏的语义约束。

灵感阶段不保存或推荐：

- 固定 `beat_count`；
- 默认 `shot_count` 或 `shot_count_hint`；
- 每个节拍的固定秒数、统一 5 秒或 4-6 秒区间；
- 尚未选择模型时的 `requested_duration_seconds`。

模型可以在对话中用自然语言讨论故事结构，但内部推理出来的节拍数不能成为不可变产品字段。当前“灵感阶段不创建 storyboard、前端默认不提交 `shot_count`”的行为应保留。

#### 3.3.2 Storyboard 由内容自然拆分

用户确认创意后，storyboard planner 根据动作完成度、场景变化、对白、情绪递进和镜头语言自然决定镜头边界。`beat` 只是每个镜头的内容说明，不存在独立的全局 `beat_count` 契约。

- 未选视频模型时，storyboard 不写供应商秒数；
- 可以记录 `can_merge_with_next`、`must_complete_action`、`continuity_mode` 等语义约束，供后续适配参考；
- 用户可以添加、删除、拆分、合并和重排镜头；
- 用户显式输入镜头数时可以作为一次性硬约束，否则规划器不得使用固定默认数或固定推荐区间；
- API 的最大镜头数只作为资源和滥用保护，不得在 UI 或提示词中表现为叙事建议。

需要删除 `_shot_count_instruction(None)` 中“多数短剧 3-12 镜头”的数值偏置，并删除 `_billing_shot_count_instruction()` 的缺省 5 镜头兜底。

#### 3.3.3 选定模型后生成可确认的执行计划

模型选定后，系统根据 `provider + model_id + operation` 的 profile 生成一份只读适配预览，不直接覆盖 storyboard：

- `flexible`：按各镜头内容复杂度分配时长，总时长以用户目标为约束；不能简单平均分配；
- `supported_values`：从模型支持值中组合候选时长，并展示总时长差异；不能直接吸附后静默提交；
- `fixed=d`：每次模型调用按完整 `d` 秒计算，现有 `n` 个生成单元的原生总时长就是 `n * d`；
- `unknown`：阻止计费生成，直到拿到已验证契约，不能默认 5 秒；
- 切换模型或 operation 后，旧执行计划失效并重新预览。

当目标总时长与模型不兼容时，预览至少给出这些选择：

1. 保留现有 storyboard，接受模型原生总时长；
2. 由规划器提出一个适配该模型的新 storyboard 版本，展示拆分/合并差异，用户确认后才应用；
3. 选择支持合适时长的其他模型；
4. 明确进入编辑模式，对指定素材做裁切或变速，并展示损失。该选项绝不能默认执行。

执行数据建议分为三层：

- `storyboard_shots`：用户确认的内容和镜头语言；
- `generation_plan`：针对当前模型生成的版本化适配建议；
- `generation_units`：实际计费调用，每个 unit 记录模型、operation、请求时长和来源 shot IDs。

只有 profile 明确声明 `supports_multi_shot_prompt=true` 时，一个 generation unit 才能承载多个 storyboard shots。普通单镜头模型必须保持一镜一调用，不能为了凑时长把两个镜头偷偷塞进一个 prompt。

以下只用于说明数学冲突，不是产品默认节拍或镜头数：假设用户已经确认 6 个内容镜头且目标为 30 秒，Omni 固定 10 秒时，保留结构会得到约 60 秒；只有内容确实可重规划为 3 个镜头且用户确认，才能得到 3 x 10 = 30 秒。固定 12 秒模型没有自然的 30 秒组合，2 个是 24 秒、3 个是 36 秒，必须展示差异。可变时长模型则可以按每个镜头的内容需要分配不同秒数，不能自动写成 6 x 5 秒。

推荐优先级：保持完整镜头和原始速度 > 保持用户确认的故事内容 > 保持目标总时长 > 保持原始镜头数量。不能同时满足时，必须在生成前由用户选择。

### 3.4 合成不再默认截断或变速

默认合成规则：

- `timeline_duration_seconds` 等于 `source_duration_seconds`，完整播放源视频；
- 不再无条件为每个输入添加 `-t <分镜推荐时长>`；
- 不使用 `setpts` 或 `atempo` 把 10 秒压缩成 5 秒；
- 如果用户明确选择“按目标总时长剪辑”，生成一份显式 `source_in/source_out` 窗口，并在 UI 标出“已裁切”，不能伪装成完整镜头；
- 源视频比时间线目标短时才允许补静帧/黑帧或报告缺口，不能凭空拉伸动作。

对于前述“已有 6 个内容镜头”的示例，`omni_flash-10s` 保留结构时应得到 6 个完整 10 秒镜头、约 60 秒成片；这不是系统默认镜头数。若用户必须要 30 秒，应在生成前确认一个内容可行的三镜头版本或更换模型，而不是生成后再压缩。

### 3.5 连续性与时长必须共同校验

在批量提交和单镜头重新生成前统一调用生成前校验：

1. 校验模型 profile 与当前镜头 requested duration；
2. 校验中间镜头上一镜尾帧依赖；
3. 校验已完成镜头二次生成的当前首帧和尾帧；
4. 校验模型是否支持原生首尾帧。如果不支持，则进入分角色的参考图引导路径：边界帧优先，剩余槽位保留人物、场景和道具图；逐张声明 start/end/identity/scene/prop 角色，并明确记录“仅参考图，无法保证首尾对齐”；
5. 校验通过后才创建计费任务。

### 3.6 现有项目迁移

- 已生成且可用的 10 秒视频不重复扣费、不自动重生成；
- 重新探测并写入 `source_duration_seconds`；
- 如果旧时间线仍记录 5 秒，标记为“需要重新规划时间线”，不继续静默截断；
- 用户重新渲染前显示兼容性提示；
- 旧项目缺少连续性字段时按项目规则补默认值：中间镜头补 `carry`，明确的 `cut/match_cut` 保留。

## 4. 主流产品调研结论

调研日期为 2026-07-22。公开产品不会完整披露其内部自动规划算法，因此这里只记录官方文档或公开产品界面能直接确认的行为，不把推测写成事实。

### 4.1 Runway

[Runway Gen-4.5 官方说明](https://help.runwayml.com/hc/en-us/articles/46974685288467-Creating-with-Gen-4-5)把生成单位定义为单个 shot/clip。用户在生成前选择 2-10 秒；包含多个连续动作的 prompt 建议使用更长时长；生成后再迭代 prompt。它没有在灵感阶段固定统一的节拍数或把所有模型压成 5 秒。

### 4.2 Google Flow

[Google Flow 官方入门说明](https://blog.google/innovation-and-ai/products/flow-video-tips/)把 clip 生成和 Scenebuilder 分开：用户先生成单个 clip，再在 Scenebuilder 里组装完整叙事。`Extend` 根据尾帧继续动作，`Jump To` 用上一镜外观进入新场景；官方示例也明确单个 Veo clip 有自己的时长约束。长故事来自多个 clip 的组装或延展，不是把固定长度素材静默压短。

### 4.3 Luma Dream Machine

[Luma 官方模型 Field Guide](https://lumalabs.ai/learning-hub/luma-video-models-guide-ray3.14-veo-sora-kling-compared)显示时长是“模型 + operation”能力：Ray3.14 text-to-video 支持 5/10 秒，image-to-video 为 5 秒，Modify 最长约 18 秒，Extend 可到约 30 秒，并支持 start/end frame。Luma 用 Boards/Ideas 组织创意，再按模型生成、Modify 或 Extend；这支持按能力建 profile，而不是全局统一时长。

### 4.4 Adobe Firefly

[Firefly Boards 官方说明](https://helpx.adobe.com/firefly/web/create-mood-boards/firefly-boards/about-firefly-boards.html)把 Boards 定位为探索早期想法、moodboard 和 storyboard 的画布。[Firefly 多模型视频说明](https://helpx.adobe.com/firefly/web/create-mood-boards/firefly-boards/partner-models-to-generate-videos.html)明确写着“可用的视频生成设置取决于所选模型”，并按模型分别展示首帧、尾帧、多镜头和时长控制。Kling 3.0/Omni 的公开界面可逐 shot 设置时长，最大 15 秒；其他模型则显示各自可用的控制。它没有用一个全局 5 秒字段覆盖所有模型。

### 4.5 LibTV

[LibTV 官方公开页面](https://www.liblib.tv/)的当前入口先接收创作灵感，同时把“选择模型”“Skill”“生成模式”作为独立控制；视频模型列表直接标出能力差异，例如 Seedance 2.0 的 15 秒音画同步、Kling O3/3.0 的多镜头能力。公开页面没有披露自动分镜如何计算镜头数，因此不能据此照搬某个固定节拍算法；可确认的产品模式是创作意图、工作流模板和模型能力分层。

### 4.6 小云雀

[小云雀官方网页](https://xiaoyunque.jianying.com/)以“输入你的灵感”进入 Agent，并把短剧 Agent、通用创作和“分镜脚本编写”作为不同工作流；官方页面强调长剧本解析、镜头打磨和长视频一致性。[官方 App Store 产品说明](https://apps.apple.com/cn/app/id6746231056)称成片目标为 15-60 秒，系统会自动思考脚本、设计分镜、调色和配乐。公开页面没有提供逐镜时长分配算法或可验证的固定节拍数，因此对 OpenMontage 有价值的是“意图先行、工作流后展开、用户继续打磨镜头”，而不是复制一个未公开的数量规则。

### 4.7 可复用的共同模式

- 灵感/Board 层保存意图和素材，不把模型秒数当叙事事实；
- storyboard/Scenebuilder 层允许添加、重排、替换和延展 clip；
- 模型和 operation 决定单次生成可用时长、首尾帧、多镜头和 Extend 能力；
- 更长内容通过多个 clip、Extend、Continue 或编辑时间线组成；
- 生成前显示当前模型的 duration/control，生成后保留完整源时长；
- 没有证据表明主流产品会把所有模型输出静默截成统一 5 秒。

因此 OpenMontage 应采用“灵感无固定节拍 -> 内容驱动 storyboard -> 模型适配预览 -> 用户确认 generation plan -> 完整素材合成”的流程。

## 5. 实施步骤

### Phase 1：数据与模型能力

- 增加按 `provider + model_id + operation` 索引的视频模型 profile、服务端配置和 API 响应字段；
- 增加模型时长兼容校验；
- 统一记录 requested/source/timeline 三类时长；
- 增加版本化 `generation_plan` 和 `generation_units`，不改写原始 storyboard；
- 修复二次生成错误消息的编码问题。

### Phase 2：连续性门禁

- 分镜生成规范化阶段为中间镜头写入默认 `carry`；
- 批量生成与 `/regenerate` 共用依赖校验；
- 补“新建分镜单独生成中间镜头”的失败测试；
- 补“已完成镜头二次生成缺首帧/尾帧”的批量入口测试；
- 对不支持原生首尾帧的模型显示明确降级状态。

### Phase 3：合成时长修复

- 删除 `_with_target_shot_durations()` 对缺时长镜头的总时长平均分配；
- 合成前探测每个源视频实际时长；
- 默认按完整源时长建立时间线；
- 删除默认 `-t <分镜时长>` 截断行为；
- 将裁切/变速变成显式编辑模式；
- 补 Omni 10 秒、Sora 12 秒和可变时长模型的合成测试。

### Phase 4：前端交互

- 模型选择器展示时长能力和首尾帧能力；
- 当前 NewAPI 模型统一显示“首尾帧原生约束未支持”，即使模型品牌在其他渠道声称支持；
- 灵感阶段只展示用户创作意图和可选目标总时长，不展示固定节拍数、镜头预算或未经模型适配的供应商时长；
- 创作蓝图移除“总时长 / 镜头数”的均分镜头时长；
- 分镜页在模型切换后生成新的适配候选，不直接改变镜头数或时长；
- 提供“适配视频模型”预览，展示 storyboard 变更建议、generation units、预计总时长和所有内容映射；
- 保留叙事分镜与生成单元的映射，不直接覆盖用户确认的 storyboard；
- 目标时长不兼容时显示阻塞提示，而不是照常提交；
- 生成前显示预计成片时长和“完整播放/按目标剪辑”选项；
- 合成结果展示实际时长与目标时长差异。

### Phase 5：灵感与 storyboard 去固定化

- 保留 inspiration prompt 中“暂不创建 storyboard”的边界；
- 删除 `_shot_count_instruction(None)` 的 3-12 镜头数值偏置；
- 删除 `_billing_shot_count_instruction()` 的缺省 5 镜头回退；
- 只有用户显式输入时才发送 `shot_count`；
- storyboard 未选择模型时不生成供应商 `requested_duration_seconds`；
- 补测试确认不同内容可以自然产生不同镜头数，且目标总时长不会被平均分摊成统一镜头时长。

## 6. 验收标准

- Omni 10 秒模型不会再把 10 秒视频默默截成 5 秒或加速成 5 秒；
- 选择 Sora 12 秒模型时，系统不会继续按 5 秒提交；
- 可变时长模型可以按内容使用不同镜头时长，不被统一成 5 秒；
- 30 秒目标与固定 10/12 秒模型不兼容时，生成前明确阻止或确认，不产生错误成片；
- 灵感产物不包含系统生成的 `beat_count`、`shot_count_hint` 或逐节拍固定时长；
- 未显式指定 `shot_count` 时，提示词不包含 3-12、5 镜头等数值建议；
- 分镜蓝图不再显示“按创意简报总时长均分”；
- 模型后选或切换时只生成可确认的 `generation_plan`，不静默改写 storyboard；
- 不支持多镜头 prompt 的模型不会把多个 storyboard shots 合并成一次调用；
- 生成后的 `source_duration_seconds` 与 ffprobe 实测一致；
- 连续中间镜头缺上一镜尾帧时显示暂时无法生成；
- 二次生成缺当前首帧或尾帧时不会产生供应商请求；
- NewAPI 缺少原生首尾帧字段时按顺序上传边界帧和剩余资产图，并为每张图注入互不覆盖的精确角色提示；
- 所有相关测试覆盖批量生成、单镜头生成、重新生成和最终合成。

## 7. 当前结论

本次 6 镜头项目的异常不是单一 FFmpeg 参数问题，而是“用户目标总时长、内容分镜、模型请求时长、实际素材时长、编辑时间线时长”被压进一个 5 秒字段造成的契约错误。修复重点应先完成 operation 级模型 profile、内容分镜与 generation plan 分层、生成前兼容校验，再调整合成。

叙事节拍数和镜头数都不能成为新的写死规则。30 秒、6 镜头、Omni 10 秒和 Sora 12 秒只用于复现冲突及验证适配器；产品行为必须适用于任意内容、任意镜头数、任意目标时长和后续新增模型。单纯把 `-t 5` 改成 `-t 10`，或把“6 镜头”改成“3 镜头”，都只是在移动错误。
