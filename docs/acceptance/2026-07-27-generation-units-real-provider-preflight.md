# Generation Units 真实付费 Provider 验收预检

- 日期：2026-07-27
- 范围：仅做只读预检；未调用 quote、execute、视频生成或任何计费接口
- 计划：`docs/2026-07-24-narrative-beats-and-generation-units-execution-plan.md`
- 结论：**blocked**。当前不能安全开始真实付费验收

## 1. 本轮安全边界

本轮只读取仓库、调用本地 `registry.provider_menu_summary()` / `registry.provider_menu()`、解析脱敏配置状态，并检查本机回环代理的 TCP 可达性。没有执行以下操作：

- 没有调用 `NewApiClient.list_models()`；
- 没有调用 `NewApiClient.quote()` 或 `execute_quoted()`；
- 没有向 `/v1/videos` 发送任何请求；
- 没有查询或修改 Provider 账户、余额、配额；
- 没有创建验收项目、TaskItem、GenerationJob、wallet hold、素材或视频；
- 没有开启 `generation_units_v2`，没有启动服务，没有提交或清理工作树。

未查询实时模型目录的原因不是接口不可读，而是现有配置没有明确的 staging/acceptance 身份。使用该凭据前无法证明它不是生产账户或生产路由。

## 2. 已读取的依据

- `AGENTS.md`、`AGENT_GUIDE.md`；
- 执行计划与三份现有 Generation Units 验收记录；
- `tools/base_tool.py`、`tools/tool_registry.py`；
- `tools/video/syapi_video.py`、`tools/video/heygen_video.py`、`tools/video/_shared.py`；
- `.agents/skills/ai-video-gen/SKILL.md`；另核对 `.agents/skills/syapi-minimax-kling/SKILL.md`，后者只覆盖配音/口型，不是本验收的视频生成指导；
- `server/app/provider/newapi.py`、`server/app/openmontage_runner.py`、`server/app/video_model_profiles.py`；
- generation-unit task、ledger、publication、timeline、billing、wallet 相关实现和测试。

既有验收只证明 mock 合同、浏览器交互和缺陷回归。三份记录均明确声明没有真实 Provider 报价、执行或计费，真实 Omni/Sora 小批量仍是开放发布门。

## 3. Registry 结果

按 `AGENT_GUIDE.md` 要求，先调用 `provider_menu_summary()`，再调用 `provider_menu()` 深查 `video_generation`：

| 项目 | 结果 |
|---|---|
| `video_generation` | `0/17 configured` |
| 可用视频生成 provider | 无 |
| `syapi_video` | unavailable |
| `heygen_video` | unavailable |
| FFmpeg | available |
| Remotion | available |
| HyperFrames | unavailable |

因此 registry 的权威结论是：**本进程没有可执行的真实视频生成工具**。

### Registry 与应用内 NewAPI 的断层

应用服务端另有独立 `NewApiClient` 配置链。脱敏状态如下：

| 配置 | 状态 |
|---|---|
| environment | development |
| NewAPI video keyring | configured |
| NewAPI current video alias | configured |
| NewAPI video fixed group | configured |
| NewAPI base | configured；本机回环代理可达 |
| staging/acceptance 标记 | missing |
| registry 所需 SYAPI 进程凭据 | missing |
| `generation_units_v2` | false |
| 独立 acceptance/staging 数据库或 Redis 标记 | missing |

这说明“服务端可能有视频凭据”不等于“registry 证明视频生成可用”。当前没有 registry 中的 `newapi_video` BaseTool；Generation Units 的付费链通过应用内部任务和 `NewApiClient` 执行，绕开了 Provider Menu 的可用性模型。验收前必须先明确这是否是被批准的例外，或补齐 registry 映射，不能把两套配置静默等同。

## 4. 候选通道与能力证据

### 4.1 Omni 10 秒

候选应用内执行合同：

- task/tool：`generation_unit_video.generate`
- provider：`newapi`
- model：`omni_flash-10s`
- operation：`text_to_video`
- Provider route：`POST /v1/videos`
- 请求时长字段：`seconds="10"`

静态能力证据：

- `video_model_profiles.py` 将该模型标为 fixed 10s、支持 sequential beats、支持 multi-shot prompt、每 unit 最多 2 个 narrative beats；合同来源为 `verified_override`；
- planner 与 execution 测试证明 6 shots 可规划为 3 units，且一个 unit 对应一个 task、job、provider execution 和 asset；
- registry 中对应的 `syapi_video` 枚举了同名 model variant，但当前 unavailable；其本地静态估价为 USD 0.40/次，静态耗时 90 秒/次。

证据缺口：没有当前 NewAPI 账户的实时模型目录、真实 10 秒输出、真实双节拍遵循度或真实收据。`syapi_video` 的可用性和估价不能替代应用内 NewAPI 通道的实时证据。

### 4.2 Sora 12 秒

候选应用内执行合同：

- task/tool：`generation_unit_video.generate`
- provider：`newapi`
- model：`sora_v2`
- operation：`text_to_video`
- Provider route：`POST /v1/videos`
- 请求时长字段：`seconds="12"`

静态能力证据：

- `video_model_profiles.py` 对 `sora_v2` 及三个兼容别名声明 fixed 12s、支持 sequential beats、支持 multi-shot prompt、每 unit 最多 2 个 narrative beats；
- planner、API 和真实浏览器 fake-provider 验收均证明 6 shots 会得到 3 units / 36s / +6s，并在确认前阻断提交；
- registry 中 `heygen_video` 的 provider matrix 包含 `sora_v2`，但工具当前 unavailable；本地静态估价为 USD 0.35/次，静态耗时 300 秒/次。

证据缺口：`syapi_video` 不包含 Sora；`heygen_video` 不是 Generation Units 应用内 NewAPI 计费链，且其合同没有证明固定 12 秒。当前无法从 registry 证明 NewAPI 的 `sora_v2` 实时可用。

### 4.3 Layer 3 指导缺口

`syapi_video.agent_skills` 指向 `ai-video-gen`，但该 Layer 3 文件只把 Sora 写为 HeyGen 路径，并未覆盖 Omni 或应用内 NewAPI `/v1/videos` 的提示与参数合同。现有 `syapi-minimax-kling` 文件只处理 TTS、自定义声音和口型同步。按仓库“调用生成工具前必须读取对应 Layer 3”的规则，当前缺少与实际 NewAPI Omni/Sora 路径准确匹配的 Provider 指导。

## 5. 成本、耗时、账户与配额

本轮禁止 quote，所以无法给出 NewAPI 的准确实时报价。下面只能作为非权威静态基线：

| 样本 | 静态 registry 估价 | 静态耗时 |
|---|---:|---:|
| 1 x Omni 10s（`syapi_video` 基线） | USD 0.40 | 90 秒 |
| 1 x Sora（`heygen_video` 基线） | USD 0.35 | 300 秒 |

这些数字来自不同且均 unavailable 的 registry 工具，不是应用内 NewAPI quote，不能作为付款依据。

当前可确认：

- NewAPI video 配置为 configured，本机回环代理 TCP 可达；
- Provider 模型权限、Provider 余额、Provider 配额：unknown；
- 验收用户、验收 wallet 余额、当前 billing multiplier：unknown；
- 配置默认 multiplier：missing，必须在隔离验收库显式固定；
- quote stale retry 配置允许重试，若不加外层上限会扩大请求数。

只有在明确的 acceptance/staging 凭据下执行 `list_models()` 和 quote-only 检查后，才能把模型、价格、余额/配额从 unknown 改为 confirmed。quote 返回正价格只证明该请求可报价；Provider 余额不足仍可能在 quote 或 execute 阶段暴露，因此必须将两者分别记录。

## 6. 最小而完整的付费验收提案

单独各生成 1 个样本只需 2 次付费调用，但不能同时覆盖计划要求的“6 个 storyboard shots、protected units、模型切换后旧 unit 不变”。覆盖核心验收面的最小方案是 **3 次付费调用**：

1. 只读 preview：6 shots + Omni，确认 3 units / 30s；不 quote、不执行。
2. 只读 preview：6 shots + Sora，确认 3 units / 36s / +6s 和服务端确认门；不 quote、不执行。
3. Batch A：对 `s1-s4` 使用 `generation_unit_video.generate` / `newapi` / `omni_flash-10s` / `text_to_video`，生成 2 个 10s units，共 2 次 execute。
4. 等两个 Omni units complete 并记录 protected 快照。
5. 对完整 `s1-s6` 切换到 `sora_v2`；前两个 Omni units 必须保持 protected，只为 `s5-s6` 规划 1 个 12s Sora unit。显式确认较长时长后执行 1 次。
6. 用 3 个 active unit 素材编译时间线；预期为 3 clips，真实总时长以 ffprobe 为准，计划原生值约 32s，不裁切、不变速。

该序列恰好覆盖“先完成前 2 个 Omni units，再切 Sora，只重规划剩余 beats”的计划验收条目。

### 建议硬上限

以下是执行许可上限，不是本轮已取得的报价：

| 限制 | 上限 |
|---|---:|
| Provider task acceptances / 付费 execute | 3 |
| Omni execute | 2 |
| Sora execute | 1 |
| 外部 quote-only 请求 | 3 |
| 外部 `/v1/videos` POST 总数 | 6（3 quote + 3 execute） |
| 单次 Omni provider quote | USD 0.50 |
| 单次 Sora provider quote | USD 0.75 |
| Provider 总成本 | USD 1.75 |
| 验收 billing multiplier | 15000 bps，必须写入隔离库 |
| 应用 wallet 总扣费 | 2,625,000 units，即 USD 2.625 等值上限 |
| 预计 Provider 生成时间 | 静态基线约 8 分钟 |
| 建议验收窗口 | 20 分钟；超过则停止新提交，只恢复已接受任务 |

任一 quote 超过单次或累计上限、model/fixed_group/route 不匹配、出现第 4 次 quote 或 execute、或 Provider 返回不明确接受状态时，必须停止新调用。已接受任务只能走 status/receipt/content 恢复，不能重新 execute。

### 严格限流实现要求

后续执行不能直接把真实 `NewApiClient` 无保护地交给多并发 worker。应在隔离验收进程中注入一个 capped client：

- `max_concurrency=1`；
- 只允许上述两个精确 model、`text_to_video`、`POST /v1/videos`；
- 分别计数 quote 与 execute；第 4 次在本地拒绝，不发网络请求；
- quote 后先校验单次和累计 provider cost，再允许 execute；
- 禁止 fallback、模型替换和批量扩容；
- 禁止 quote-stale 自动产生第 4 个外部 quote；发生 stale 时终止新提交；
- 对 request body 只记录 SHA-256、model、seconds、size 和阶段，不记录 token、完整 URL、图片 data URI 或完整 prompt。

## 7. 验收隔离方案

代码具备进程内隔离基础：`create_app(db_path, projects_root)` 可使用独立数据库和项目根目录，测试已经通过 dependency override 只在进程内设置 `generation_units_v2=True`。

真实验收应满足以下条件：

- 新建一次性 acceptance 进程，显式 `environment=test`；
- 使用独立数据库、独立 projects root、独立 Redis DB/prefix；不得指向当前开发或生产数据；
- 只在该进程的 settings override 中设置 `generation_units_v2=True`；源码默认和 `.env.example` 继续保持 false；
- 创建专用 acceptance 用户、项目和 wallet；wallet 只注入上述 2,625,000 units 上限；
- 使用明确标注 acceptance/staging 的 NewAPI keyring、alias、fixed group 和上游项目；
- billing worker 也必须读取同一隔离 settings；
- 完成后停止进程并保留只读证据，不把临时配置或凭据写入仓库。

当前配置不满足这些条件：只标记 development，没有 acceptance/staging 名称，也没有可证明的专用 Provider 项目或专用密钥。因此本轮不创建项目、不查询模型、不查询账户。

## 8. 证据记录设计

后续真实验收应同时保存 Markdown 汇总和机器可读 JSON/CSV，至少记录：

| 对象 | 权威来源与字段 |
|---|---|
| storyboard | `episode_storyboard.json`：shot/beat count、稳定 ID、version、顺序与 merge 边界 |
| generation plan | preview response/candidate：plan ID、provider/model/profile revision、unit mapping、requested/native duration、confirmation state |
| generation unit | `video_generation_units` 与 `generation_execution.json`：ID、revision、status、source shots/beats、provider/model、task/job/asset/path、active |
| task | `task_batches` / `task_items`：target unit、generation key、settlement key、状态、attempt、dependency、billing job |
| job | `generation_jobs`：operation、model、route、status、quote cost、provider reference type；敏感 alias 只记 configured |
| provider request | capped client audit：quote/execute 序号、request hash、model、seconds、size、结果状态；不记 token、URL、data URI、完整 prompt |
| billing | `generation_jobs`、`cost_receipts`、`wallet_holds`、`wallet_entries`：quote、settled/refund 状态、provider cost、wallet charge、总额 |
| asset | ledger + `asset_manifest.json`：asset ID、unit ID/revision、active、相对路径、文件 SHA-256 |
| ffprobe | 每个 source MP4 的 duration、video/audio stream、size；与 `source_duration_seconds` 核对 |
| clip/timeline | `render_plan.json` / `edit_timeline.json` / `render_report.json`：3 clips、各 source unit、无重复、无默认 trim/retime、总时长 |
| protected unit | 模型切换前后比较前两个 unit 的 ID、revision、model、output asset/path、billing job、active；必须逐字段不变 |

计数不变量应为：最终 6 storyboard shots、3 active generation units、3 TaskItems、3 chargeable GenerationJobs、3 provider task references、3 active video assets、3 timeline clips；quote/execute 与账单必须能按 unit revision 一一关联。

## 9. 阻断项与放行条件

1. **没有明确 staging/acceptance Provider 项目和专用密钥。** 当前 development 配置和回环代理不足以证明隔离。
2. **Registry 报告 `video_generation 0/17 configured`。** 应用内 NewAPI 通道未纳入 registry，不能把 configured keyring 当成 Provider Menu 通过。
3. **实时模型权限未知。** 在安全凭据确定前没有调用 `list_models()`；Omni/Sora 只有静态 profile 和测试证据。
4. **准确 NewAPI 成本未知。** 本轮禁止 quote；registry 静态估价来自不同工具，不能作为真实账单依据。
5. **Provider 余额/配额与 acceptance wallet 未确认。** 当前没有专用验收账户身份，也没有隔离 wallet/billing setting。
6. **缺少匹配实际 NewAPI Omni/Sora 路径的 Layer 3 指导。** 现有 `ai-video-gen` 主要描述 HeyGen/fal，不覆盖本执行链。
7. **缺少现成 capped client。** 当前 billing 代码允许 quote-stale retry；不加外层门禁不能把所有外部 POST 和 execute 严格限制在提案上限。

全部放行条件：主会话先向用户披露上述状态并取得明确付费批准；用户提供或确认专用 acceptance/staging 身份；registry 与实际 NewAPI 通道关系被明确批准；只读模型目录、账户/配额和三次 quote 均通过；capped client、隔离数据库/项目/wallet/worker 已就绪；再按三次 execute 上限开始。任何条件未满足，继续保持 `generation_units_v2=false`，不得付费。
