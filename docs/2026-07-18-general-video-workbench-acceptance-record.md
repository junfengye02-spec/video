# 2026-07-18 通用视频工作台正式验收记录

## 结论

正式前端和渲染后端验收通过。

- 项目：`霓虹舞台 20 秒舞蹈`
- 项目 ID：`e8ebf8552e014d0a8de1a4999a1b16bf`
- 管理员：`novice.local@example.com`
- 前端：`http://127.0.0.1:5173/`
- 后端：`http://127.0.0.1:8787/`
- 正式成片：`projects/e8ebf8552e014d0a8de1a4999a1b16bf/renders/final.mp4`
- 锁定运行时：`remotion`

## 人类点击流程

1. 从登录页使用管理员登录。
2. 在最近项目中打开 `霓虹舞台 20 秒舞蹈`。
3. 检查 4 个分镜和已生成视频。
4. 进入成片页并点击 `重新制作`。
5. 预检显示：4 个镜头复用、0 个镜头生成、预计额度 0。
6. 输出规格显示 `720x1280 · 9:16 · MP4 · 20s`，没有 15/30/60/90 秒选择。
7. 点击 `确认重新制作`，由正式 `/api/projects/{id}/render` 执行 Remotion。
8. 页面恢复为 `已完成`，刷新后仍恢复成片、工件、进度和实时连接状态。
9. 在 390x844 手机视口复核，页面无横向溢出，视频、下载和重新制作入口均可达。

## 本轮发现并修复

### 新制作期间显示旧的 100% 状态

- 现象：页面标题显示 `制作中`，进度卡却仍显示上一轮的 `成片已完成 / 100%`。
- 根因：`JobProgress.visibleStage()` 在检查本次 `rendering` 前先接受了旧 complete 事件。
- 修复：进行中的本地或服务端任务优先于旧 terminal event；只有本次任务结束后才显示 complete。
- 回归：新增 `旧 complete + 新 rendering` 用例，定向测试 25/25 通过。

### 工作流刷新保留了过期镜头和模型字段

- 现象：修改镜头后 scene plan 仍显示旧描述；重新生成后 proposal/asset model 仍是旧模型。
- 修复：scene plan、asset manifest 和 proposal 执行字段以最新 storyboard/model 为准；人工剪辑、音频和转场仍保留。
- 回归：相关定向测试 9/9 通过，服务端全量测试通过。

### 下载按钮没有触发浏览器下载

- 现象：服务端成片先执行 `fetch -> Blob -> object URL`，浏览器没有收到下载事件。
- 根因：大文件被重复载入内存，且临时 URL 可能在下载建立前被回收。
- 修复：服务端成片改为同源媒体 URL + `<a download>` 直接下载；只有浏览器本地 Blob 使用 object URL。
- 验证：真实页面点击后浏览器收到 download 事件，新增服务端成片下载回归用例。

## 正式媒体结果

- 容器：MP4
- 文件大小：8,564,020 bytes
- 时长：20.000 秒
- 画面：H.264，720x1280，30 fps
- 音频：AAC，48 kHz，双声道
- 时间线：600 帧，Remotion
- 原声策略：4/4 镜头均为 `preserve`
- 原声相关性：0.9825、0.9997、0.9988、0.9993
- 黑帧检查：23 帧，黑帧 0，黑尾 0 秒
- PCM 峰值：-1.666 dBFS，削波样本 0
- Final Review：`pass`

## 自动化结果

- 服务端：`1188 passed, 25 skipped`
- 前端最终：`48 files / 740 tests passed`
- 前端 TypeScript + Vite 生产构建：通过
- Render Plan / 时间线 / 音频专项：`13 passed`
- 渲染 API 专项：`19 passed`

## 已知边界

- 内置浏览器成功加载并解码视频：`readyState=4`、20 秒、720x1280、无 media error，首帧和原生 controls 可见。自动化层无法驱动 Chromium 原生 video shadow controls 使时间轴前进，因此播放按钮仍建议人工点一次复核。
- 源素材右下角存在 provider 星形标记。当前只记录并人工复核，不通过裁剪、模糊或覆盖破坏原画。
- 本机项目内置 FFmpeg 是精简版，不包含 `sidechaincompress`、`alimiter`、`blackdetect` 和 `xfade`。当前使用可执行的时间线 ducking、双遍 loudnorm、PNG 黑帧抽检和 WAV PCM 峰值分析，并在报告中如实标注能力。
- 根目录手工 QA 仍有环境型失败：部分测试直接依赖 PATH 中的完整版 `ffmpeg`，另有可选 OpenAI SDK 和旧 provider 清单断言；正式服务和渲染代码会使用 Remotion 随包 FFmpeg/FFprobe 兜底，不受 PATH 缺失影响。

## 续跑复核

- 管理员会话恢复后直接打开正式成片页，项目、4 个镜头、工作流产物、100% 进度和实时连接状态均正常恢复。
- 浏览器真实媒体状态：`readyState=4`、`duration=20`、720x1280、原生 controls 开启、`media error=null`。
- 390x844 移动端视口无横向溢出，视频、下载和重新制作入口均位于可视宽度内，控制台无 warning/error。
- 实际点击 `重新制作` 后，预检显示 0 个生成镜头、4 个复用镜头、预计额度 0，输出为 `720x1280 · 9:16 · MP4 · 20s`；随后取消，未启动重复渲染。
- 页面不存在 15/30/60/90 秒预设控件，成片时长继续由剧情时间线决定。
- 定向回归：渲染计划/时间线/音频 `13 passed`；成片页和会话恢复 `37 passed`。
- Remotion 随包 FFprobe 再次确认成片为 20.000 秒、8,564,020 bytes、H.264 720x1280 30 fps、AAC 48 kHz 双声道。
