# Generation Units 真实 FFmpeg 与崩溃恢复发布门

- 日期：2026-07-27
- 结论：**部分通过，发布门仍阻断**
- FFmpeg 范围：本机真实 `ffmpeg` / `ffprobe`，Remotion 捆绑版本 `n7.1`
- Provider 范围：严格本地 fake provider；未调用任何真实或付费 provider
- 数据范围：pytest 隔离临时 SQLite、项目目录和 provider 状态文件；未访问生产数据库

## 1. 结论

真实 3-clip FFmpeg 验收通过，且 FFmpeg 聚焦回归 7 项全绿。源素材、generation-unit clip、时间线和最终 render 的时长由真实 `ffprobe` 核对一致；6 个 storyboard shots 被编译为 3 个 generation-unit clips，每个 multi-shot unit 只播放一次，默认不裁切、不变速。

OS crash/recovery harness 未通过。它在 `submit-crash` 子进程的项目初始化 helper `_create_project_with_fake_generator()` 中返回 HTTP 502 `{"code":"provider_result_unavailable"}`，进程以 1 退出而不是预期的注入退出码 91。此时严格视频 provider 的 `quote_count=0`、`execute_count=0`，说明执行尚未到达视频 provider 调用和 worker crash 注入点。因此本记录**不宣称** waiting-provider 恢复、幂等计费或 replacement 原子发布已通过。

## 2. 已修复的真实 FFmpeg 兼容缺陷

本机实际解析到的 Remotion FFmpeg 禁用了 `setpts` 和 `format` filter。原渲染命令无条件使用这些 filter，最小视频会报错：

```text
No option name near 'PTS-STARTPTS'
```

`server/app/rendering/ffmpeg.py` 现在在全源播放和显式裁切时省略不可用且非必要的 `setpts` / `format`；显式变速在缺少 `setpts` 时转交既有 Remotion renderer，避免静默忽略变速。相关兼容与 fallback 行为由 `server/tests/test_render_ffmpeg.py` 覆盖。

## 3. 真实 3-clip 证据

执行命令：

```powershell
$env:GENERATION_UNITS_GATE_ARTIFACTS='docs/acceptance/artifacts/2026-07-27-generation-units-ffmpeg-crash-recovery'
.\.venv\Scripts\python.exe -m pytest server/tests/test_generation_units_release_gate.py::test_real_ffmpeg_generation_unit_timeline_and_render -q --basetemp=tmp/generation-units-real-ffmpeg-final -p no:cacheprovider
```

结果：`1 passed in 3.20s`。Pillow `Image.getdata()` 产生 8 条未来弃用警告，不影响渲染或 probe 结果。

| 检查项 | 结果 |
|---|---:|
| Storyboard shots | 6 |
| Generation units / timeline clips | 3 / 3 |
| Source durations | 0.8s, 1.0s, 1.2s |
| Timeline duration | 3.0s |
| Final ffprobe duration | 3.0s |
| Target / difference | 4.0s / -1.0s |
| Duration policy | `full_source` |
| Source in | `0` |
| Playback rate | `1` |
| Final review | `pass` |

逐 clip 断言 `source_out_seconds == source ffprobe duration`、`timeline_duration_seconds == source ffprobe duration`；render plan、edit timeline、render report 和最终 ffprobe 的总时长一致。证据位于 `docs/acceptance/artifacts/2026-07-27-generation-units-ffmpeg-crash-recovery/ffmpeg/`。

## 4. 回归结果

```powershell
.\.venv\Scripts\python.exe -m pytest server/tests/test_render_ffmpeg.py -q --basetemp=tmp/generation-units-ffmpeg-regression-final -p no:cacheprovider
```

结果：`7 passed in 0.45s`。

扩展与静态检查：

| 命令 | 结果 |
|---|---|
| `pytest server/tests/test_generation_unit_timeline.py server/tests/test_generation_units.py server/tests/test_generation_unit_execution.py` | 15 passed in 17.00s |
| `ruff check`（本轮 4 个 Python 文件） | All checks passed |
| `python -m py_compile`（本轮 4 个 Python 文件） | passed |

## 5. Crash harness 阻断

执行命令：

```powershell
.\.venv\Scripts\python.exe -m pytest server/tests/test_generation_units_release_gate.py::test_generation_unit_worker_and_provider_process_crash_recovery -q -s --basetemp=tmp/generation-units-process-crash-final -p no:cacheprovider
```

结果：`1 failed in 3.78s`。失败发生在：

```text
submit-crash
  -> _project()
  -> _create_project_with_fake_generator()
  -> POST /api/projects/short-drama
  -> 502 {"code":"provider_result_unavailable"}
```

已做一次限定在初始化 helper 的最小尝试：初始化阶段直接使用仓库 `FakeNewApi`，在视频 generation-unit 提交前再恢复严格进程 provider；结果仍为相同 502，因此已停止扩展并撤销该无效尝试。失败证据摘要位于 `docs/acceptance/artifacts/2026-07-27-generation-units-ffmpeg-crash-recovery/crash-recovery/blocker.json`。

本轮未到达并且未证明：

1. worker/provider 进程中断后恢复原 GenerationJob 与 billing job。
2. provider call 和 wallet 扣费在恢复及重试时保持单次。
3. replacement 发布失败时旧 active 素材继续可用。
4. 新 revision 重试成功后的原子发布、唯一 active 切换和旧文件保留。

## 6. 发布边界

`generation_units_v2` 源码默认值保持 `False`，`.env.example` 保持 `GENERATION_UNITS_V2=false`。本轮没有启动长期服务、没有提交 Git 暂存内容，也没有调用真实付费 provider。

清理后 `tmp/generation-units-*`、手工诊断 fixture 和本轮目标 `.pyc` 计数均为 0；没有残留 `generation_units_process_gate.py`、pytest、FFmpeg 或 ffprobe 进程。工作区另有 3 个在本轮之前数日已存在的交互式 `server.manage create-admin` Python 进程，未终止或修改。

发布门仍保持关闭：OS crash/recovery harness 尚未越过初始化阻断；真实付费 provider 和生产数据库仍未验收。
