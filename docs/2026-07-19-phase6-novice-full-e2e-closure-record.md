# Phase 6 小白用户全产品前端闭环记录

- 日期：2026-07-19 至 2026-07-20
- 产品：mise studio / OpenMontage
- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:8787`
- 执行方式：普通本地会话、共享 main 工作树、串行执行；未创建 worktree、未切分支、未提交或 push。
- 证据口径：下文明确区分“真人浏览器”“自动化”“合法阻塞”和“未验证”，不以内部 API 冒充本应点击的 UI。

## 1. 账号、安全边界与验收对象

### 1.1 专用账号与余额

- 唯一产生本轮新增计费、允许管理加款的账号：`phase6.novice.20260719@example.com`。
- 用户 ID：`2746bd66b489430abdae8ede3d4e8fea`；钱包 ID：`f529da13d2cd4937a3a1e31644eb5362`。
- 加款前余额 `0`、冻结 `0`；唯一一次管理 UI 加款 `+50,000,000`；加款后余额 `50,000,000`。
- 管理审计 ID：`b3fe8362416c45a29fb5b993d1ca43f2`；动作 `wallet.balance.adjust`；只作用于上述钱包。
- 原因：`Phase 6 多镜头小白真人闭环验收：为逐镜头视频与一次多镜头最终渲染提供足够余额，仅限本会话专用账号。`
- 最终余额 `39,110,960`、冻结 `0`；没有为了“补回整数”追加 9,682，也没有把正常 Provider 消耗描述为退款。
- 未修改其他用户余额、订单、权限、项目或媒体。

### 1.2 项目与资源

| 对象 | ID / 路径 | 最终状态 |
| --- | --- | --- |
| 三镜头真实媒体项目 | `cf0e8246dbc9419699d02d98699790aa` | 12 秒、16:9、3 镜头媒体 ready、成片 ready；未删除 |
| 九镜头长列表项目 | `ea3db1f2b7da46b89a553c6bd56de219` | 40 秒、16:9、9 镜头；只做 UI 回归，未生成视频，未删除 |
| 既有专用项目 | `eb0c91dfec7e4e289a9b664a194d9bef` | 未删除、未改归属、未改密码；最终长列表产品验收由同账号新建的 9 镜头项目完成 |
| 上传 fixture 资源 | `887a83e2d54c4820bf76bfd962e50074` | `Phase 6 上传 fixture`，prop/upload/ready，29,984 bytes；保留 |
| 本地尾帧资源 | 三镜头项目 3 个 `video_frame` | 从既有三段视频本地原子抽取，费用 0；二次抽取 `reused=true`，旧视频未重生成 |
| `.omproj` 导出 | `C:\Users\zhuba\Downloads\未命名项目.omproj` | 33,407 bytes，SHA-256 `CAFDC787...EAF0BA94`，ZIP 可读，含 `openmontage-project.json` |
| 最终下载 | `C:\Users\zhuba\Downloads\未命名项目-final (2).mp4` | 4,199,893 bytes，SHA-256 `708AC9D7...9A3B4B48`，与服务端文件完全一致 |

本轮没有测试删除项目或资源；因此没有删除对象清单。既有项目和其他真实用户资产均保持原状。

## 2. 小白真人点击矩阵

### A. 认证与账户

- 真人浏览器：未登录深链回登录、登录空值、错误密码错误态、正常登录、退出后重新登录均完成。
- 真人浏览器：注册、忘记密码、重置密码页面的必填项、邮箱格式、密码确认和合法阻塞均验证；未发送验证码、未创建额外账号、未修改现有密码。
- 真人浏览器：顶栏、账户信息、返回项目列表、390px 移动导航可用。
- 自动化：认证 pending 锁、守卫目的地、注册/重置表单 disabled、非管理员阻塞和焦点路径由 `AuthPages.test.tsx`、`AuthProvider.test.tsx`、`RequireAdmin.test.tsx` 覆盖。

### B. 创作首页与项目

- 真人浏览器：通过首页 Composer 创建三镜头真实项目和九镜头长列表项目；模式/偏好、输入、创建 loading 与重复点击锁均按 UI 操作。
- 真人浏览器：项目卡真实媒体/占位、进入项目、项目切换、深链、刷新恢复、菜单与 Dialog 均验证。
- 真人浏览器：通过可见 UI 导出 `.omproj`；文件系统确认非空、ZIP 可读。导入只验证浏览器能力入口与自动化约束，未用内部 API 代替文件选择。
- 没有点击删除其他用户或既有验收项目。

### C. 灵感

- 真人浏览器：首条想法、建议 Chip、发送、乐观消息、失败/重试、重复提交锁和创意简报字段更新均验证。
- 三镜头项目只执行一次成功灵感文本样本；九镜头项目在三次无收费缺结果后合法恢复，并执行一次成功样本。
- 所有失败草稿均保留可重试；项目切换旧响应和草稿隔离由真人与自动化共同覆盖。

### D. 蓝图

- 真人浏览器：六类目录/章节、独立滚动、反馈 Drawer、草稿保持、Escape/焦点恢复、章节确认、失败/冲突恢复、重规划锁和最终批准 Dialog 均验证。
- 三镜头项目和九镜头项目各只批准一次，未重新批准其他项目。
- 原生 `confirm` 曾导致 Browser 控制标签失联；取得一次 dirty 门禁证据后未重复触发该工具不稳定路径。history/beforeunload/路由门禁的其余分支由自动化覆盖。

### E. 分镜：单镜头证据

- 三镜头项目的 `shot_01` 独立覆盖 quote、失败、合法重试、loading、旧媒体保留、ready 和重复请求锁。
- AI 优化只改草稿、撤销、保存、角色/资源绑定、项目切换旧响应由真人和自动化覆盖。
- “单镜头证据”是镜头级独立链路，不另建无必要的单镜头项目。

### E. 分镜：多镜头真实媒体证据

| 镜头 | 成功媒体 | Provider / UI 结果 |
| --- | --- | --- |
| `shot_01` | `assets/video/shot_01.mp4`，2,893,982 bytes | 首次 Provider 结果异常后 refunded；一次合法重试成功 |
| `shot_02` | `assets/video/shot_02.mp4`，2,646,211 bytes | 一次成功；quote/loading/ready/切换状态通过 |
| `shot_03` | `assets/video/shot_03.mp4`，2,529,553 bytes | 首次上游失败 refunded；修订提示词后一次合法重试成功 |

- 按顺序生成 3 段真实视频；每个镜头最多一次成功样本，没有批量生成或无目的重复调用。
- 生成期间切换镜头无状态串线；旧媒体保持、loading 覆盖、失败恢复、ready、重复请求锁均通过。
- 视频/Blob 清理由 `MediaRepository` revoke 和分镜视频卸载时 `removeAttribute("src")` 覆盖；未播放视频不再无条件调用 `pause()`，避免测试/运行时 console 噪声。

### E. 分镜：九镜头长列表证据

- 九镜头项目从 Phase 6 账号的可见 UI 创建，完整走灵感、规划、六类蓝图确认、唯一一次批准，再进入分镜。
- 计划目标 40 秒，实际 9 镜头，每镜约 4.4 秒，16:9；未生成九段视频。
- 1440：首/中/尾列表与胶片同步，列表内部滚动 `12 → 25`，胶片 `0 → 76`，舞台稳定为 `849.625 × 849`。
- 1600：舞台稳定 `960 × 849`，无横向溢出。
- 1024：移动标签布局，舞台 `1024 × 696`，无横向溢出。
- 390：舞台 `390 × 652`，列表/预览/检查器标签可用，无横向溢出。
- 修复移动端“在预览胶片选择尾镜头后再打开列表，选中项只部分可见”：列表可见状态加入滚动 effect 依赖。真人回归 `scrollTop=108`，第 9 镜完整位于列表 `171..843` 可视区内；针对性测试 18 项通过。
- `shot_09` 资源绑定同形保存：重启后的运行时 schema 含 continuity；勾选“会发光的旧录音机”并保存，PATCH `200`、无 alert、dirty 清除。取证后取消绑定并再次保存成功，最终恢复原状态；未触发视频生成。
- 首尾帧连续性任务已作为最终基线集成：Alembic `015` 为 head；三镜头既有视频各本地抽取 1 个 `video_frame`，Provider/钱包费用 0，jobs `57 → 57`、chargeable jobs `50 → 50`，二次抽取均 `reused=true`。独立记录：`docs/2026-07-20-shot-frame-continuity-closure-record.md`；截图：`docs/acceptance/2026-07-20-shot-frame-continuity/`。

### F. 资源

- 真人浏览器：项目/个人视图、类型/来源/搜索、详情 Drawer、上传 Drawer、焦点恢复均通过。
- 通过可见 UI 与正常 Windows 文件选择器完成真实 fixture 上传；资源 ID `887a83e2d54c4820bf76bfd962e50074`，29,984 bytes，服务端文件 SHA-256 `278E0586...FCE1350`。
- 过滤条件“道具 / 上传 / Phase 6”可稳定找到上传结果；详情和个人视图均可见。
- 本轮未执行 AI 生图，避免无必要 Provider 成本；产品生图成功/失败/锁由自动化覆盖，不宣称真人 Provider 生图通过。

### G. 连续性 / 全局设定

- 真人浏览器：世界观、人物连续性、视觉规则、声音和生成偏好等主要 section 均浏览并做可逆编辑。
- 草稿跨 section 保持，保存成功；最终恢复原值，无遗留 dirty 状态。
- 保存失败/重试、dirty 切换、路由与 beforeunload 由自动化覆盖。
- 系列 AI 自动补全集成引用：`docs/2026-07-20-series-ai-autocomplete-closure-record.md`。短/长系列 prompt、3/12 集规范化、fill-only 合并、locked episode 保留和前端草稿隔离自动化通过；该独立任务未新增真人 Provider 调用，因此此处不冒充真人短/长系列生成通过。

### H. 制作与最终成片

- 真人浏览器：成片舞台、制作状态/SSE、预检、工作流证据、连续性报告、终态刷新、下载和重复提交锁均验证。
- 首次 UI render parent `33428a0948b54a9b8165b2ffb6a2fe36` 因 bundled FFmpeg 缺少 `xfade` 失败；FFmpeg → Remotion fallback 后，parent `4a8c80d8e7fd4107a45b3aa9d5967854` 完成。
- 真实最终 render quote `0`，生成镜头 `0`、复用镜头 `3`；没有 Provider 计费。
- 修复“计划 12 秒但 3 个 edit decision 各 5 秒导致 15 秒”：按 approved brief 的 12 秒平均为 4/4/4 秒，编辑决策与 render plan 总时长均为 12 秒。
- 修复旧本地 final Blob 缓存覆盖权威服务端成片：缓存字节数与 `render_report.file_size_bytes` 不一致时不覆盖远程 `final_path`。
- 修复旧 render report 分辨率反向钉死下一次输出：下一次 render plan 的宽高以 approved brief 为权威，旧 report 仅用于 fps 等事实。
- 使用现有三段媒体做本地 0 quote 校正渲染，设置“如请求任何镜头生成立即失败”的保护；Provider 调用 `0`，未创建新计费 job。
- 最终服务端与下载文件：4,199,893 bytes，H.264 1280×720、AAC stereo 48 kHz、30 fps、12.000 秒；SHA-256 完全一致。
- 开头 0.5 秒、6 秒中段、11.5 秒结尾人工检查分别为窗边、城市街道、海边，不是重复单段。

### I. 钱包、订单与管理

- 真人浏览器：钱包余额、冻结、充值入口的合法本地阻塞、订单列表、搜索、状态过滤、空分页和账单管理页面均验证。
- 空充值金额、空管理调整原因/金额均被 UI 合法阻塞。
- 管理后台只筛选并操作 Phase 6 专用账号；没有提交第二次余额调整、倍率或权限修改。
- 非管理员阻塞、危险 Dialog、原因字段与焦点由 UI/自动化覆盖。

## 3. Provider、quote、receipt 与钱包对账

### 3.1 成功和收费调用

| 项目 / 能力 | job | model | 提交前 quote | hold / 钱包安全 | receipt quota | 实际扣费 | 终态 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| 三镜头灵感 | `85fd3fbfd23e4374aa3454cc33227354` | `gpt-5.5` | 118 | 236 | 1,904 | 3,808 | billed / settled |
| 三镜头规划 | `b1bfd2aca23a46379e55d839fefab435` | `gpt-5.4` | 135 | 270 | 2,937 | 5,874 | billed / settled |
| Shot 1 成功重试 | `19627744b78c4aa5a591cb44d0482d01` | `omni_flash-10s` | 1,811,250 | 3,622,500 | 1,811,250 | 3,622,500 | billed / settled |
| Shot 2 | `8f832e43b1314a6da434fc55ddbcfb72` | `omni_flash-10s` | 1,811,250 | 3,622,500 | 1,811,250 | 3,622,500 | billed / settled |
| Shot 3 成功重试 | `564eeba564c643f48e5a74964b86311a` | `omni_flash-10s` | 1,811,250 | 3,622,500 | 1,811,250 | 3,622,500 | billed / settled |
| 九镜头灵感成功样本 | `a15dd1943efd47739b034be699366e53` | `gpt-5.5` | 118 | 236 | 1,086 | 2,172 | billed / settled |
| 九镜头规划 | `9580ebc98d99425486a11ebae2280d52` | `gpt-5.4` | quote-only 101；实际 job 156 | 312 | 4,843 | 9,686 | billed / settled；记录报价漂移 |
| 最终成片 | `4a8c80d8e7fd4107a45b3aa9d5967854` | local render | 0 | 0 | 0 | 0 | complete |

### 3.2 失败、模糊提交与无收费终态

- Shot 1 首次 `00a697c7e5194e5db9e9b2963bdf84d0`：Provider task `task_WxYZ1vWJ0wqk3pU360yeQyIaPwrADGA4`，refunded，hold released，扣费 0。
- Shot 3 首次 `e659418c75d74e3299c55d8b925e9761`：Provider task `task_wPW17BCd2GfEekMcCzt1b2gVtIuIelB2`，refunded，hold released，扣费 0。
- 九镜头灵感三笔旧 quote 118：
  - `3e0ed118de8f423aa4f89148a58a9a13`
  - `efb1ab4b1306456e803bd5cdaa89a445`
  - `7990e8bca63e4e2aa89a9933ba45a1aa`
- 三笔均已终结为 `provider_result_missing_no_charge`，hold `236` released，无 receipt、扣费 0；不再遗漏此前的 `submitted_ambiguous` 跟踪项。
- UI 首次最终渲染失败 parent 无收费；两次本地 12 秒/16:9 校正渲染均只复用已有媒体，不创建 Provider 或钱包流水。

钱包流水总消耗 `10,889,040`，与 `50,000,000 - 39,110,960` 完全一致；冻结为 0，无悬挂 hold。

## 4. 视口、可访问性、console 与失败恢复

- 390/1024/1440/1600 对首页、灵感、蓝图、分镜、资源、连续性、制作、钱包/订单/管理做 smoke；主要页面无页面级横向溢出。
- 九镜头分镜 390 修复后：`clientWidth=scrollWidth=390`，尾镜头完整可见。
- 最终制作页：390 的 `375/375`、1024 的 `1009/1009`、1600 的 `1585/1585`；差异为垂直滚动条，不是横向溢出。
- 最终视频舞台尺寸随视口稳定：390 为 `317×177.44`，1024 为 `884.13×496.44`，1600 为 `939.17×527.41`。
- 键盘主要导航、Tabs、菜单、Drawer、Dialog、表单和焦点恢复由真人与自动化共同覆盖。
- Browser 新鲜制作标签 warn/error 为 0。旧分镜/制作标签在并发任务热更新 Provider/route 文件时留下 `useWorkbench must be used within a WorkbenchSessionProvider` 历史 HMR 错误；刷新后的干净标签正常、production build 与路由测试通过，未将历史 HMR 噪声描述为生产错误。
- 前端全量测试曾发现未播放胶片 `<video>` 卸载时无条件 `pause()` 的 jsdom console error；已改为仅实际播放时暂停，53 项相关回归通过。
- reduced-motion 真人验证：尝试打开 Windows“动画效果”真实设置，但 Computer Use 在读取设置窗口前返回 `SetIsBorderRequired failed: 不支持此接口 (0x80004002)`；未修改系统值，设置窗口已关闭。产品的 `prefers-reduced-motion` CSS、Hook、即时滚动与相关测试通过，但不冒充真人 reduced-motion 已验收。
- 可安全制造的 402、Provider 失败、receipt refunded、SSE 刷新、重复提交、dirty 放弃和下载失败均有真人或针对性自动化证据；不能安全真人制造的分支均标注为自动化。

## 5. 截图与下载证据

目录：`docs/acceptance/2026-07-19-phase6-novice-full-e2e/`

关键新增/终态证据：

- `storyboard-nine-shot-blueprint-1440.jpg`
- `storyboard-nine-shots-first-1440.jpg`
- `storyboard-nine-shots-last-1440.jpg`
- `storyboard-nine-shots-390.jpg`
- `storyboard-nine-shots-tail-auto-scroll-390.jpg`
- `storyboard-nine-shot-binding-save-clean-1440.jpg`
- `resources-upload-fixture-filter-detail-1440.jpg`
- `resources-upload-fixture-personal-1440.jpg`
- `production-final-12s-16x9-ui-1440.jpg`
- `production-final-12s-16x9-390.jpg`
- `production-final-12s-16x9-start-frame.jpg`
- `production-final-12s-16x9-middle-frame.jpg`
- `production-final-12s-16x9-end-frame.jpg`

早期 quote/loading/retry、三镜头 ready、首次 render 失败/恢复、1024/1600 smoke 等截图也保留在同目录，未删除历史证据。

## 6. 修复切片

1. `server/app/artifact_sync.py` / `server/app/openmontage_runner.py`：approved brief 时长分配到缺少显式时长的镜头，FFmpeg 不可用能力合法 fallback，12 秒 render plan 与成片一致。
2. `server/app/main.py`：下一次 render plan 规格以 approved brief 画幅为权威，不由旧 report 分辨率钉死。
3. `web/src/domain/types.ts`、`web/src/features/workbench/WorkbenchSessionProvider.tsx`：render report 增加权威文件大小；本地 final Blob 与权威字节数不一致时不覆盖服务端成片。该窄修复完成后已释放共享文件，未回退首尾帧字段。
4. `web/src/features/storyboard/components/ShotList.tsx`、`StoryboardWorkbench.tsx`：紧凑视口列表重新可见时再次 reveal selected item。
5. `web/src/features/storyboard/components/ShotFilmstrip.tsx`、`ShotList.tsx`：视频卸载仅在播放中暂停，并移除 `src`，消除清理噪声。
6. 真实 continuity 422：首尾帧任务完成 015 migration、schema 和 8787 重启；Phase 6 使用同一 UI 动作复验 PATCH 200，绑定随后回滚。三段既有视频只做零成本本地尾帧抽取，未重生成；本任务未重复修改其 schema/workbench 链路。

## 7. 遗留清理与静态审计

- 删除已确认无消费者的旧 `StoryboardWaterfall.tsx`、旧 `ShotEditor`/旧 storyboard 组件及对应全局选择器；没有为了扫描数字删除仍在使用的兼容规则。
- `transition: all`：0。
- 生产 `console.log/warn/error`：0。
- 旧 `StoryboardWaterfall`、旧 `components/storyboard/*`、旧 shot 选择器生产消费者：0。
- 大型动效依赖：0；依赖仅 React、React Router、lucide、fflate 等现有轻量依赖。
- 非测试 TS/TSX：165 文件、455 条相对导入边、循环依赖 0。
- Object URL：下载工具立即 revoke；`MediaRepository` 在替换/释放时 revoke；分镜视频卸载移除 `src`。
- 仍超过评审触发线且有真实消费者的现有模块：`WorkbenchSessionProvider.tsx` 1807 行、`mediaStore.ts` 1170 行、`pages.css` 3520 行、`responsive.css` 995 行、`i18n.ts` 1879 行。保留原因是职责拆分/全局兼容仍需独立 Phase 8，而不是确认无消费者的死代码。
- 路由已有按功能模块边界，但主 chunk 仍超过 500 kB；没有引入大型动效库或新的循环依赖。

## 8. 测试、构建与包体

针对性回归包括：

- render output spec / artifact sync / render plan / FFmpeg：15 passed。
- StoryboardPage + selected-item scroll：18 passed。
- AppRoutes + StoryboardPage 视频清理：53 passed。
- 首尾帧独立任务：Alembic `015` head、3 个本地 `video_frame`、幂等复用、PATCH 200/绑定回滚和独立门禁均通过；本任务又由 server/web 全量覆盖。

本记录最后编辑后执行的终态门禁：

```text
python -m pytest server/tests -q
1230 passed, 25 skipped, 1 warning
Alembic head: 015
active generation jobs: 0

cd web
npm.cmd test -- --run
56 test files passed, 763 tests passed

npm.cmd run build
1765 modules transformed
CSS 165.86 kB (gzip 27.63 kB)
main JS 591.32 kB (gzip 176.45 kB)
existing >500 kB chunk warning remains

cd ..
git diff --check
passed with no output
```

相对 Phase 6 开始基线：CSS `+0.72 kB`（gzip `+0.05 kB`）；主 JS `+19.50 kB`（gzip `+5.51 kB`）；模块 `+4`。增长包含同期落盘的系列自动补全与首尾帧连续性能力，不全由 Phase 6 窄修复产生。大 chunk 是最终架构收尾风险。

## 9. 剩余合法阻塞与未验证

1. Windows 设置窗口无法被当前 Computer Use 读取，真人 reduced-motion 为工具阻塞；自动化通过但不冒充真人。
2. 独立“短系列/长系列 AI 自动补全”任务完成代码与自动化，未做两次额外真实 Provider UI 调用；Phase 6 只做集成引用。
3. 既有 `eb0c...` 项目未被删除或破坏；最终长列表真人闭环落在同账号新建的 9 镜头项目，避免继续混用两个验收账号。对象特定的 `eb0c...` 最终再登录回归不作为本记录的通过项。
4. 主 chunk 591.32 kB、Workbench Provider/i18n/global CSS 仍超过 Phase 8 评审线；它们有消费者，不属于可安全机械删除的死代码。

## 10. 两份总计划结论

1. `docs/2026-07-19-lightweight-mac-creative-ui-plan.md`：**可标记 Done，但必须保留 reduced-motion 真人工具阻塞注记**。首页到三镜头真实媒体、多镜头最终成片、九镜头长列表、资源上传、导出、账户/账单、四视口、失败恢复和最终门禁均已闭环；确认无消费者的遗留已清理。不能把 Windows 设置阻塞改写成真人通过。
2. `docs/2026-07-19-youmind-mac-frontend-rearchitecture-plan.md`：**可进入/收口账户与商业页面，并继续 Phase 8；不可最终关闭**。账户、钱包、订单和管理 UI 已具备真人与自动化证据，但其完成定义仍要求进一步拆分 `WorkbenchSessionProvider`、i18n 与全局 CSS、完成新旧代码最终清理、解决主 chunk 警告并取得真人 reduced-motion 证据。
