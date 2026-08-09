# 通用视频工作台渲染后端方案 v2

更新日期：2026-07-18

## 目标

本方案面向整个 OpenMontage 视频生成工作台，不针对美女跳舞或任何单一视频类型写特例。

必须满足：

1. 支持剧情短片、人物口播、广告、舞蹈、纪录片、产品演示、动画和混合素材。
2. 剧情需要多少秒，最终时间线就是多少秒，不受前端固定时长选项或 provider 返回时长限制。
3. 默认保留视频人物自己的对白、配音、演唱和现场原声。
4. 支持原声、旁白、音乐、音效和环境声组合。
5. 人工调整的入点、出点、轨道、转场和音频决策不能被刷新或重渲染覆盖。
6. 所有渲染运行时消费同一份冻结计划，不能自行猜测故事板。
7. 最终文件必须经过真实媒体探测和质量门禁后才能发布。

## 本轮调研结论

原方案的总体方向正确：统一 Render Plan、默认保留原声、中央音频混合、真实 ffprobe 和 final review 都应该保留。

但原方案仍然偏“顺序拼接器”，不足以支撑真正的通用视频工作台。v2 需要进一步优化：

- 用帧/时间基代替浮点秒作为权威时间表达。
- 转场必须是两个相邻片段之间的独立对象，不能在两个 clip 上重复记录。
- 将用户可编辑时间线与后端冻结渲染计划分成两个工件。
- 从单层 clips 扩展为视频轨、字幕轨和多种音频轨。
- 音频由独立中央混音器负责，画面运行时不再决定人物原声是否存在。
- 保存对白、音乐、音效等 stems，便于返修、配音和多语言版本复用。
- 渲染运行时必须先做能力检查；缺少 `xfade` 等能力时要阻止执行，不能静默丢转场。

## 权威参考

### OpenTimelineIO

来源：

- https://github.com/AcademySoftwareFoundation/OpenTimelineIO
- https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-timeline-structure.html
- https://opentimelineio.readthedocs.io/en/latest/tutorials/time-ranges.html

已确认的关键规则：

- OTIO 是成熟的剪辑信息交换格式和 API，不是媒体容器或渲染器。
- `MediaReference.available_range`、`Clip.source_range` 和片段在父轨道中的范围是不同概念。
- 时间使用 `RationalTime(value, rate)`，例如 24 fps 的第 7 帧，而不是不稳定的浮点秒。
- `Transition` 位于两个相邻对象之间，使用 `in_offset` 和 `out_offset` 消耗两侧 handles。
- 转场本身不改变轨道总时长。
- 多视频轨按 painter order 合成；音频轨相加，建议浮点混音并经过压缩以避免削波。
- `Gap`、`Track`、`Stack` 和嵌套 composition 都是正式时间线对象。

对 OpenMontage 的影响：不能长期维持只有一个平面 `clips[]` 的模型。

### Remotion TransitionSeries

来源：

- https://www.remotion.dev/docs/transitions/transitionseries
- https://www.remotion.dev/docs/audio
- https://github.com/remotion-dev/remotion

已确认的关键规则：

- TransitionSeries 的 transition 会让相邻两个 sequence 重叠，因此默认会缩短总时长。
- Overlay 不改变相邻 sequence 的长度，适合闪光、漏光等覆盖效果。
- transition 必须位于相邻 sequence 之间。
- 音频支持逐帧 volume 曲线、trim、loop 和多音频流选择。

对 OpenMontage 的影响：编译器必须显式加入转场 handles，保证重叠后总时间线仍等于剧情时长；不能直接把每镜时长相加后再盲目插 transition。

### GStreamer Editing Services

来源：

- https://gstreamer.freedesktop.org/documentation/gst-editing-services/

已确认的关键规则：

- `GESTimeline` 是中央编辑对象。
- Layer 表达用户看见的片段排列；Track 表达最终音视频输出流。
- 典型视频编辑项目至少有独立 video track 和 audio track。
- `GESPipeline` 负责把时间线接入实际渲染管线。

对 OpenMontage 的影响：前端编辑语义、输出轨道语义和运行时渲染器应当分层，不能由一个函数同时负责。

### FFmpeg

来源：

- https://github.com/FFmpeg/FFmpeg/blob/master/doc/filters.texi
- https://ffmpeg.org/ffmpeg-filters.html

已确认的关键规则：

- `xfade` 要求两侧视频具有相同的分辨率、像素格式、帧率和 timebase。
- `acrossfade` 负责相邻音频流的交叉过渡，可指定曲线和重叠时长。
- `sidechaincompress` 可根据对白/旁白总线压低音乐总线。
- `loudnorm` 实现 EBU R128，文件输出支持两遍分析与线性归一；单遍更适合直播或快速草稿。
- 精简版 Remotion FFmpeg 不包含所有滤镜，不能把“找到 ffmpeg.exe”等同于“具备完整合成能力”。

### Netflix VMAF

来源：

- https://github.com/Netflix/vmaf

已确认的关键规则：

- VMAF 是有参考源的感知质量评价工具，适合判断转码前后质量退化。
- VMAF 不能判断生成视频的人物一致性、剧情完成度或剪辑合理性。
- 2026 年仓库已提供新一代 v1 模型，但模型选择仍需匹配场景。

### PySceneDetect 与 Auto-Editor

来源：

- https://github.com/Breakthrough/PySceneDetect
- https://github.com/WyattBlue/auto-editor

已确认的关键规则：

- PySceneDetect 可用于实际切点、场景变化和异常跳切检查。
- Auto-Editor 组合音量、运动等多种信号自动选段，并用 margin 保留句子和动作边界。
- 自动选段不能只依据固定时长或单一阈值。

### Whisper、MediaPipe 与 Chromaprint

来源：

- https://github.com/openai/whisper
- https://github.com/google-ai-edge/mediapipe
- https://github.com/acoustid/chromaprint

已确认的关键规则：

- Whisper 可做多语言语音识别、语言识别和 VAD，适合检查最终对白是否仍存在。
- MediaPipe 的人脸、姿态和关键点能力适合辅助生成后的人物/动作连续性检查。
- Chromaprint 面向近似相同的完整音频识别，不是通用短片段混音校验工具。

对 OpenMontage 的影响：原声保留应使用波形相关性加可选 ASR 对照；不能只靠“输出里存在音频流”判断。

## 优化后的工件分层

### 1. `edit_timeline.json`

这是用户和前端编辑器的权威工件，表达剪辑意图，可持续修改。

包含：

- 时间基和项目画幅。
- Media references 与真实 available ranges。
- 视频、字幕、对白、旁白、音乐、音效、环境声轨道。
- clips、gaps、overlays 和嵌套 compositions。
- 独立 boundary transitions。
- 人工锁定字段和修改来源。

刷新故事板时只能合并新增默认值，不能覆盖已有人工决策。

### 2. `render_plan.json`

这是由已批准时间线编译得到的不可变执行计划。

包含：

- `edit_timeline` 内容哈希和故事板版本。
- 所有素材的绝对受控路径、probe 哈希和实际流信息。
- 已验证的 source ranges、transition handles 和轨道排序。
- 运行时选择、运行时能力快照和输出规格。
- 分段缓存 key、音频总线计划和质量门禁参数。

渲染器只读 Render Plan。用户修改时间线后，旧 Render Plan 失效并重新编译。

### 3. `render_report.json` 与 `final_review.json`

Render Report 记录实际执行信息；Final Review 记录发布门禁。二者都引用 Render Plan 哈希和最终文件哈希。

## v2 时间模型

不再使用浮点秒作为权威值。采用类似 OTIO 的有理时间：

```json
{
  "timebase": {"numerator": 1, "denominator": 24},
  "start": {"value": 96, "rate": 24},
  "duration": {"value": 120, "rate": 24}
}
```

前端仍可显示 `4.0 秒`，但存储和渲染以整数帧为准。音频内部以采样点/采样率处理，最终按时间基对齐。

兼容期继续读取 `source_in_seconds` 等旧字段，编译后立即转换为 RationalTime；新工件不再写回浮点秒作为唯一真相。

## v2 转场模型

转场从 clip 中移出，成为轨道里的独立边界对象：

```json
{
  "id": "transition-shot-01-shot-02",
  "from_item_id": "clip-shot-01",
  "to_item_id": "clip-shot-02",
  "type": "dissolve",
  "in_offset": {"value": 3, "rate": 24},
  "out_offset": {"value": 3, "rate": 24},
  "audio_curve": "equal_power"
}
```

编译门禁：

- 两侧必须是相邻可合成对象。
- handles 不能超过相邻片段可见范围。
- 同一片段两端转场不能互相覆盖。
- 不允许两个转场直接相邻。
- 缺少 handles 时必须阻止渲染或由用户批准降级，不能静默丢弃。
- 转场不改变权威总时长。

## v2 音频架构

人物原声是一级素材，默认策略始终为 `preserve`。

统一音频总线：

- `dialogue`：人物对白、人物自带配音和演唱。
- `narration`：独立旁白。
- `music`：背景音乐。
- `sfx`：音效。
- `ambience`：环境声。

策略：

- `preserve`：保留视频原声，不自动添加其他轨道。
- `mix`：保留原声并叠加其他总线。
- `replace`：仅在明确决策下替换视频原声。
- `mute`：仅在明确决策下静音。

混音流程：

1. 按 source range 提取每个片段原声。
2. 按时间线位置和转场曲线拼入 dialogue/ambience 总线。
3. 旁白进入 narration 总线。
4. 音乐在对白/旁白出现时通过 sidechain ducking 降低。
5. 内部使用浮点混音和 limiter 防止削波。
6. 文件交付采用两遍 EBU R128 loudnorm；草稿可使用单遍。
7. 导出 `dialogue.wav`、`narration.wav`、`music.wav`、`sfx.wav`、`ambience.wav` 和 `master.wav`。
8. 最后把 master 与各画面运行时结果 mux，确保 Remotion、FFmpeg、HyperFrames 都不会误删人物原声。

## 渲染运行时策略

### Remotion 主路径

- 负责通用多轨画面、字幕、图层和帧精确转场。
- 使用受控 public staging 读取本地素材，避免 `file://` 失败。
- 显式使用本机 Chrome，避免运行时从 Google 下载浏览器导致任务挂起。
- 不再通过远程 Google Fonts 阻塞首次打包。
- 画面渲染默认静音，最终统一 mux 中央音频 master。

### 完整 FFmpeg 快速路径

- 适合纯视频、硬切、批量输出和服务端低成本渲染。
- 启动前检查 `xfade`、`acrossfade`、`sidechaincompress`、`loudnorm` 等具体能力。
- 只有完整构建满足计划能力时才能运行；精简版二进制只能执行其真实支持的子集。

### HyperFrames

- 适合 HTML/CSS/GSAP 标题、产品宣传和动态图形。
- 只负责画面时也必须消费同一 Render Plan。
- 最终统一 mux 中央音频 master，解决现有 HyperFrames 将视频标签静音后丢失人物原声的问题。

运行时锁定后不得静默切换。能力不足时返回结构化 blocker，由用户批准后修改时间线决策日志。

## 素材与预览策略

- 原始 provider 文件不可变保存。
- 每个素材生成 `shot_media_report.json`，记录真实时长、流、帧率、画幅、切点、响度、静音和主体分析。
- 前端预览使用代理文件，最终渲染仍引用原始素材或高质量 mezzanine。
- 代理与原片共享 media reference，不允许前端把代理路径写成最终 source。
- 片段渲染缓存使用素材哈希、source range、效果、时间基和输出规格共同生成 key。

## 最终质量门禁

### 硬门禁

- 容器、编码、分辨率、帧率和时长来自真实 ffprobe。
- 时长误差不超过 2 帧。
- Render Plan 要求保留原声时，输出必须有音轨且源音频相关性不能全部失败。
- 已锁定运行时必须与提案和决策日志一致。
- 所有素材路径必须位于项目工作区，且计划哈希与当前故事板版本一致。
- 声明的转场必须实际执行，不能被运行时忽略。

### 音频门禁

- 对白/演唱片段执行波形相关性检查。
- 有脚本或对白时可用 Whisper 对最终音频做 ASR 对照。
- 检查长静音、切点爆音、削波、true peak、LUFS 和音乐淹没人声。
- 保留 stems，便于定位问题来自源素材、剪辑还是 master。

### 画面与剪辑门禁

- 在开头、中段、高潮、结尾和每个切点前后抽帧。
- 用 PySceneDetect 对照计划切点，发现意外跳切或实际未发生的转场。
- 人物视频可选用人脸/姿态/运动方向检查连续性。
- VMAF/CAMBI 仅用于有参考源的转码退化检查，不评价生成内容本身。

Final Review 缺失、失败或计划过期时，不得把暂存文件发布为 `renders/final.mp4`。

## 实施顺序

### P0：先修模型，不继续锁定旧结构

1. 新增 `edit_timeline.json` 和 RationalTime。
2. 新增 media references、tracks、gaps 和独立 transitions。
3. 将现有 Render Plan v1 作为兼容输入，编译到 v2，不直接扩大 v1 字段。
4. 保留人工 edit decisions 的合并逻辑，补充显式 lock/source 元数据。

### P1：中央音频和统一执行

1. 将当前原声 master 原型升级为分总线和 stems。
2. 增加 sidechain ducking、limiter 和两遍 loudnorm。
3. Remotion、完整 FFmpeg 和 HyperFrames 只输出画面或标准视频层，统一 mux master。
4. 将正式 Web `/render` 接口接入冻结 Render Plan，不再硬编码 FFmpeg。

### P2：前端编辑与代理预览

1. 去掉 15/30/60/90 秒固定时长选择。
2. 总时长由时间线片段和剧情自然计算，前端显示为只读汇总。
3. 提供入点、出点、轨道、转场、原声/混音策略和音量控制。
4. 使用代理文件实现快速预览，保存时只写编辑时间线。

### P3：智能选段和连续性质检

1. 组合音频、运动、主体、对白边界和 handles 评分自动选段。
2. 加入 PySceneDetect、Whisper 和可选 MediaPipe 检查。
3. 多候选素材择优、缓存和分布式 worker。
4. 有参考源的交付增加 VMAF/CAMBI。

## 当前实现状态

截至 2026-07-18，正式 Web 渲染路径已经接入并完成真实验收：

- `edit_timeline.json` v2 是可编辑权威时间线，使用整数帧和有理时间。
- `render_plan.json` 是冻结执行计划，source range 与 timeline range 已分离。
- 转场是独立 boundary 对象，handles 会验证，转场不改变最终剧情时长。
- 人物原声默认 `preserve`；只有显式 `replace` 或 `mute` 才会移除。
- dialogue、narration、music、sfx、ambience 会进入独立音频 stem 和 v2 audio track。
- 音乐支持基于人声区间的 timeline-envelope ducking；精简 FFmpeg 没有 `sidechaincompress`，因此不会虚报动态 sidechain。
- 文件交付使用双遍 `loudnorm`，目标响度、真峰值和 LRA 写入 Render Plan。
- Remotion WorkbenchRenderer 使用本机 Chrome 和受控 public staging，避免下载浏览器和 `file://` 失败。
- 正式 `/api/projects/{id}/render` 读取已锁定运行时，不允许客户端强制回退 FFmpeg。
- Final Review 会真实执行 ffprobe、23 点黑帧抽检、PCM 峰值/削波检查、静音检测和原声相关性检查。
- 工作流刷新以最新 storyboard 和视频模型更新 scene/asset/proposal 执行字段，同时保留人工剪辑、音频和转场决策。
- 正式项目 `e8ebf8552e014d0a8de1a4999a1b16bf` 已发布 20.000 秒 Remotion 成片到 `renders/final.mp4`，Final Review 为 `pass`。

仍需后续完成：

- 安装完整版 FFmpeg 后可升级为真正的能量检测 sidechain、`alimiter`、`blackdetect` 和 FFmpeg `xfade` 快速路径。
- 字幕目前没有进入独立 cue track，也没有通用烧录/像素级可读性门禁。
- 未知水印仍需人工复核或专用视觉模型；当前源素材右下角 provider 星形标记已记录，不做破坏性裁剪。
- HyperFrames 的 Render Plan 执行器尚未接入；锁定 HyperFrames 时会明确阻止，不会静默切换。

## 验收标准

- 任意视频类型使用同一时间线和编译流程。
- 剧情时长不受固定选项或 provider 素材时长影响。
- 人物原声默认保留，替换/静音只能由明确决策触发。
- 音乐、旁白和音效不会隐式删除人物原声。
- 转场是独立边界对象，总时长不被偷偷缩短。
- 人工编辑不会被刷新、重新生成或渲染覆盖。
- 所有运行时消费同一冻结 Render Plan，能力不足会阻止执行。
- Render Report 只使用真实探测结果。
- Final Review 未通过时不发布最终文件。
- 计费幂等、任务恢复、项目锁、版本 stale 检查和原子发布继续通过测试。
