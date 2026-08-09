# Generation Units V2 真实浏览器补充验收

- 日期：2026-07-26
- 项目：`8ae8f35beaaa43c6ba26e16d92da1acb`
- 计划：`docs/2026-07-24-narrative-beats-and-generation-units-execution-plan.md`
- 路由：`http://127.0.0.1:5177/projects/8ae8f35beaaa43c6ba26e16d92da1acb/storyboard`
- 既有记录：`docs/acceptance/2026-07-24-generation-units-phase7-8/README.md`
- 结论：Sora 服务端确认门、多分镜再生成、移动布局和状态页已获得真实浏览器证据；仍有 2 个前端缺陷，因此本记录不宣称完整视觉验收通过。

## 环境与安全边界

开始前已确认 D 会话停止其 5177/8788 服务，且 `web/vite.generation-units-acceptance.config.ts` 不存在。本轮使用独立临时 fixture：

```powershell
# 仓库根目录
.\.venv\Scripts\python.exe -m uvicorn tmp.generation_units_browser_acceptance_app:app --host 127.0.0.1 --port 8788

# web/
npm.cmd run dev -- --config vite.generation-units-browser-acceptance.config.ts
```

fixture 由测试应用创建本地数据，并且只在进程内把 `generation_units_v2` 覆盖为 `true`。`AcceptanceFakeNewApi.quote()` 和 `execute_quoted()` 均直接抛出异常；本轮没有真实 provider 报价、执行或计费。源码默认值始终要求保持：

```text
server/app/core/config.py: generation_units_v2: bool = False
.env.example: GENERATION_UNITS_V2=false
```

使用的 fixture 控制命令：

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8788/__acceptance__/seed-ledger
Invoke-RestMethod -Method Post http://127.0.0.1:8788/__acceptance__/reset
Invoke-RestMethod -Method Post http://127.0.0.1:8788/__acceptance__/mode/slow
Invoke-RestMethod -Method Post http://127.0.0.1:8788/__acceptance__/mode/error
Invoke-RestMethod -Method Post http://127.0.0.1:8788/__acceptance__/mode/empty
Invoke-RestMethod -Method Post http://127.0.0.1:8788/__acceptance__/mode/normal
Invoke-RestMethod -Method Get  http://127.0.0.1:8788/__acceptance__/status
```

## 验收结果

| 场景 | 期望 | 实际 | 结果 |
|---|---|---|---|
| Sora 规划，1440x1000 | 3 units / 36s / +6s，确认前禁用生成 | UI 显示 `6 个叙事节拍 / 3 个视频生成单元 / 预计 36 秒`、原生预计 `36 秒`、差值 `+6 秒`；`生成 3 个待处理单元` disabled | 通过 |
| 服务端确认门 | 绕过 UI 直接提交也必须失败 | 未确认 plan 的直接提交返回 HTTP 409，code=`generation_plan_confirmation_required`；fake provider 未进入 quote/execute | 通过 |
| 接受更长成片 | 服务端确认后返回可提交 plan，不自动生成 | pending 时接受按钮与生成按钮均 disabled；preview payload 带 `confirmed_strategy=accept_longer_duration`；新 plan 可生成，但 `generate_requests=0` | 通过 |
| 减少或合并分镜 | 进入可执行的 storyboard revision 流程 | link href 正确指向 `/projects/.../plan-review`，但已批准工作流的 `PlanReviewRoute` 立即重定向回 storyboard，并把本地模型重置为 Omni | **失败：操作死路** |
| 更换兼容模型 | 打开模型选择器，可切回兼容模型 | 按钮打开并聚焦模型菜单；选择 `omni_flash-10s` 后显示 3 units / 30s，生成按钮 enabled | 通过 |
| multi-shot 对话框 | 列出全部受影响 shots/beats | U1 对话框列出分镜 1 `Arrival and the unexpected invitation` 和分镜 2 `The first rule changes the room`，并说明承载 2 个有序叙事节拍 | 通过 |
| multi-shot 取消 | 不产生 preview/generate | reset 后打开对话框再取消，`preview_requests=0`、`generate_requests=0`，对话框关闭 | 通过 |
| multi-shot 确认 | 只重规划目标 unit，不误提交；旧 active 素材继续可用 | `preview_requests=1`、`generate_requests=0`；payload 的 `regenerate_unit_ids=["unit-5faf4af3d0e3b9905c912700"]`；UI 仍显示 `acceptance-asset-1` 和“替换成功前，当前 active 素材仍可用” | 通过 |
| loading | 有明确加载反馈 | 显示“正在获取可用模型...”和“正在检查模型时长与首尾帧能力...” | 通过 |
| error | 模型目录/规划失败可见且无伪计划 | 显示“获取可用模型失败，可继续使用当前值或重试。”、空规划提示和 `Temporary browser acceptance error` | 通过 |
| empty catalog | 空目录有明确回退 | 显示“接口未返回可用模型，可继续使用当前值。”；当前 Omni 规划仍可显示 | 通过 |
| disabled | 不可提交状态不能点击生成 | Sora 未确认时 3-unit 生成按钮 disabled；全部 unit 已完成时 `生成 0 个待处理单元` 的 `isEnabled()` 为 `false` | 通过 |

## 移动视口

真实视口为 390x844。

| 检查 | DOM 测量与实际结果 | 结果 |
|---|---|---|
| 页面横向溢出 | `innerWidth=390`、`documentElement.clientWidth=390`、`scrollWidth=390`、`body.scrollWidth=390` | 通过 |
| unit mapping 面板 | x=8、right=367、width=359、clientWidth=359、scrollWidth=359；操作按钮均未超出视口或面板 | 通过 |
| 三项不兼容操作 | 三个控件均 x=8、right=367、width=359、height=32，`scrollWidth=clientWidth=357` | 通过 |
| multi-shot dialog | x=12、right=378、y=440.5、bottom=832、width=366、height=391.5；取消/确认按钮均在 844px 视口内，无内部横向滚动 | 通过 |
| 关键帧操作 | 检查器单列布局宽 343；两枚 AI 按钮 width=343、clientWidth=scrollWidth=341，无移动端文字溢出 | 通过 |

移动证据中的 seeded replacement 页面只用于布局检查；Sora 36s 语义以 1440x1000 的未 seed 阻断截图和 HTTP 409 记录为准。

## 已复现视觉缺陷

### 1. “减少或合并分镜”操作死路

复现：选择 `sora_v2` -> 等待 3 units / 36s 阻断规划 -> 点击“减少或合并分镜”。地址短暂进入 `/projects/8ae8f35beaaa43c6ba26e16d92da1acb/plan-review`，随后因 workflow 已 approved 自动回到 storyboard，用户没有可执行的 revision UI，且当前模型恢复为 Omni。

### 2. 桌面检查器 AI keyframe 文本溢出

复现：1440x1000 -> storyboard -> 右侧“分镜检查器” -> 向下滚动到“首尾关键帧”。

- 区域：x=1125.8125、right=1409、width=283.1875、clientWidth=283、scrollWidth=306。
- `AI 生成首帧（需报价）`：width=135.59375、clientWidth=134、scrollWidth=144、`white-space: nowrap`、`overflow-x: visible`。
- `AI 生成目标尾帧（需报价）`：width=135.59375、clientWidth=134、scrollWidth=158、`white-space: nowrap`、`overflow-x: visible`。
- 两枚并排按钮文字互相侵入；页面级 `documentElement.scrollWidth` 仍为 1440，所以只看 document overflow 会漏掉该缺陷。

本轮按要求只记录，没有修改业务代码。

## 截图索引

目录：`docs/acceptance/artifacts/2026-07-26-generation-units-browser/`

| 文件 | 内容 |
|---|---|
| `02-sora-blocked-three-actions-1440x1000.png` | Sora 3 units / 36s / +6s 与三项操作 |
| `03-accept-longer-pending-disabled-1440x1000.png` | 接受更长成片 pending/disabled |
| `04-multi-shot-dialog-1440x1000.png` | 桌面 multi-shot 对话框全部受影响 shots/beats |
| `05-multi-shot-confirm-preview-only-1440x1000.png` | 确认后待重生成且旧 active 素材仍在 |
| `06-mobile-unit-mapping-390x844.png` | 移动 unit mapping 布局 |
| `07-mobile-sora-actions-390x844.png` | 移动三项操作布局（seeded replacement，布局证据） |
| `08-mobile-multi-shot-dialog-390x844.png` | 移动 multi-shot 对话框 |
| `09-loading-390x844.png` | 模型目录与规划 loading |
| `10-error-empty-plan-390x844.png` | error 与空规划 |
| `11-empty-model-catalog-390x844.png` | empty model catalog 回退 |
| `13-desktop-keyframe-overflow-1440x1000.png` | 桌面两枚 AI keyframe 按钮文字碰撞 |

## Omni 既有记录

D 记录已经在 1440x1000 真实路由验证 Omni 的 6 narrative beats / 3 generation units / 30s、三个顺序映射单元、可用生成按钮和 0 document overflow。本轮引用该记录，并额外在移动视口及 seeded ledger 状态复查 Omni 布局；不伪造新的真实 provider 或计费证据。

## 未执行与发布限制

以下工作本轮明确未做，不能从本记录推导为已通过：

1. 真实付费 Omni/Sora provider 小批量 QA、真实 provider request 数与计费核对。
2. staging/production PostgreSQL 018 migration、备份、索引/约束检查和回滚演练。
3. 真实 ffmpeg QA，以及 worker/provider 崩溃注入、waiting/recovery 和原子发布验证。
4. 真实素材时长的 ffprobe 核对和生产环境 v1 backfill/双读观察。

由于“减少或合并分镜”死路和桌面 keyframe action overflow 尚未修复，且真实 provider、生产迁移、真实 ffmpeg/崩溃注入仍未完成，`generation_units_v2` 不应默认开启。
