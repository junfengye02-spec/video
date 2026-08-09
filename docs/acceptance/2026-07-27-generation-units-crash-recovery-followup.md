# Generation Units OS crash/recovery follow-up

- 日期：2026-07-27
- 结论：**OS crash/recovery 子发布门通过**
- Provider 范围：严格本地 fake provider；零真实或付费 provider 调用
- 数据范围：隔离 SQLite、项目目录、provider 状态文件和 pytest 临时目录
- 证据目录：`docs/acceptance/artifacts/2026-07-27-generation-units-crash-recovery-followup/crash-recovery/`

## 1. 初始化阻断根因

`submit-crash` 最初在 `POST /api/projects/short-drama` 返回 502。最小 traceback 捕获确认实际调用面为：

```text
storyboard_generation
  -> finalize_billed_sync_result()
  -> storyboard_generator.persist_hidden()
  -> WorkbenchStore.stage_sync_result()
  -> _atomic_write_bytes()
  -> Path.open("xb")
  -> FileNotFoundError
```

provider 文本结果已经正常返回并完成解析。失败路径长 268 个字符，超过本机 Windows 传统 `MAX_PATH`；长 pytest test node 目录、`process-gate`、project/job ID 和原子写临时 UUID 叠加后触发。严格视频 provider 此时仍未被调用，因此不是 provider 方法缺失，也不是生产 generation-unit 执行缺陷。

harness 改用 `tmp_path_factory.mktemp("gu")` 作为短且隔离的状态根目录。修复后 `submit-crash` 真正到达严格视频 provider，并由 worker 进程以退出码 91 中断。

## 2. 恢复与发布闭环

harness 按生产职责边界显式推进两个恢复器：

1. task worker 恢复过期 `running` item 为 `waiting_provider`，并绑定原 GenerationJob；
2. billing reconciliation 通过原 quote 恢复 `task_*` provider reference；
3. provider 进程停止时 reconciliation 返回错误，item 保持 `waiting_provider`；
4. provider 恢复后原 job 完成下载、结算和 v1 发布；
5. v2 replacement 在尾帧发布故障下注入失败，v1 继续 active 且旧文件存在；
6. 将已延后的 reconciliation 置为到期后重试同一 task，复用 v2 原 job 和 provider 结果，原子激活 v2。

为使幂等证据只覆盖一个 logical unit，进程场景固定为 2 shots / 1 generation unit。快照同时记录每条 wallet consume 的 `source_id`，按 billing job 精确核对，不把初始化 storyboard 文本账单混入 generation-unit 断言。

最终证据：

| 检查项 | 结果 |
|---|---:|
| Worker OS exit code | 91 |
| v1 provider quote / execute | 1 / 1 |
| v2 provider quote / execute | 1 / 1 |
| Duplicate execute attempts | 0 |
| v1 / v2 wallet consume | 1 / 1 |
| Provider-down 状态 | `waiting_provider` 保持 |
| Replacement failure | v1 active，v2 failed |
| Replacement retry | v2 complete 且 active |
| Final active revisions for unit | 1 |
| Retained v1 file | 存在 |

机器可读汇总位于 `crash-recovery/qa-summary.json`；各阶段数据库快照位于 `crash-recovery/snapshots/`；`retained-v1.mp4` 和 `active-v2.mp4` 分别保存旧 revision 与最终 active revision 的媒体证据。

## 3. 验证结果

最终 crash gate：

```powershell
$env:GENERATION_UNITS_GATE_ARTIFACTS='docs/acceptance/artifacts/2026-07-27-generation-units-crash-recovery-followup'
.\.venv\Scripts\python.exe -m pytest server/tests/test_generation_units_release_gate.py::test_generation_unit_worker_and_provider_process_crash_recovery -q -s --basetemp=.tmp/gu-final-summary -p no:cacheprovider
```

结果：`1 passed in 37.42s`。

相关回归：

| 命令范围 | 结果 |
|---|---:|
| `test_generation_units.py test_generation_unit_execution.py test_provider_recovery.py` | 20 passed in 16.82s |
| `test_billing_e2e.py` | 11 passed in 1.83s |
| Ruff 0.15.21（本轮 2 个 Python 文件） | All checks passed |
| `python -m py_compile`（本轮 2 个 Python 文件） | passed |

## 4. 发布边界

本轮没有修改 Generation Units 生产执行、恢复、计费或发布代码，也没有改动已通过的 FFmpeg 兼容修复。`AppSettings.generation_units_v2` 默认值仍为 `False`，`.env.example` 仍为 `GENERATION_UNITS_V2=false`。

该结论关闭本地严格 fake provider 的 OS crash/recovery 子发布门。真实付费 provider、生产数据库和默认启用 v2 仍不在本轮验收范围内。
