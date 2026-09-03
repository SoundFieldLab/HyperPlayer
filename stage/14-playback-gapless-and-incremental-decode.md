# Stage 14：增量解码与真正 gapless

状态：进行中（增量解码与 codec trim 已完成并全绿；preparation worker 与实机验收未完成）

更新时间：2026-09-03

## 当前基础与目标

当前播放主链可解码 WAV/FLAC/MP3。本切片建立 preparation worker、增量 decoder、codec trim、统一 PCM、standby 预填和采样边界切换。

非目标：以 crossfade 冒充 gapless，或让前端决定音频时序。

## 前置门禁

Rust engine 是唯一播放权威；实时 callback 只做有界无锁读取/增益/欠载补零；所有解码和格式转换在非实时线程。

## 已完成（2026-09-03，全部有测试证据）

### 1. 可增量 pull/seek 的 decoder（WAV/FLAC/MP3 全量）

- `crates/hyperplayer-engine/src/audio.rs` 中 `FlacDecoder` / `Mp3Decoder` 由「open 时整曲解进内存（MemoryDecoder/claxon）」重写为 **symphonia 增量实现**：`open` 只做 probe + 建解码器 + 解析头元数据即返回；`read_pcm` 逐 packet 拉取到内部单帧缓冲（`block` / `frame_buf`），不再整曲常驻内存（任务 1、6）。
- 依赖变化：symphonia features `["mp3"]` → `["mp3", "flac"]`；claxon 依赖移除（crates 与 src-tauri 两份 Cargo.lock 已同步更新）。
- WAV 此前已是增量实现，未改动。

### 2. codec trim（encoder delay/padding）读取与应用

三 codec 统一为 **raw 时间轴契约**（与 `runtime.rs` 既有 gapless 模型一致）：

- `total_frames()` 返回**原始**可解码帧总数（含 delay/padding）；`read_pcm` 返回**原始** PCM；`runtime.rs` 的 `prepare_decoder` 以 `total − delay − padding` 计算 playable 并 `seek(delay)` 统一裁剪。解码器**只上报** trim，不在解码层裁剪。
- FLAC：从 symphonia 轨道头（通常为 None）+ Vorbis Comment 私有 tag `ENCODER_DELAY` / `ENCODER_PADDING` 回退读取；读不到为 0。
- MP3：从 Xing/Info 头的 LAME 扩展 tag 读 `enc_delay` / `enc_padding`；demuxer 已把 `num_frames` 归一化为已减 delay+padding，raw 总数 = `num_frames + delay + padding`（无头文件退回整曲「解码即弃」扫描，样本不驻留内存）。
- **MP3 双重裁剪修复**：symphonia `AudioDecoderOptions` 默认 `gapless=true` 会在包级逐样本裁掉 delay/padding，与 raw 契约冲突；改为显式 `gapless(false)` 打开。
- **采样级 seek 精度**：MP3/FLAC seek 经 demuxer `SeekMode::Accurate` 落到参考帧边界（MP3 含 bit reservoir 预热回退），`actual_ts` 与目标的帧内差由解码侧 `skip_frames` 在解码块内逐采样跳过补齐（任务 5 的 seek 语义）。
- **流末 seek 边界**：`seek(raw_total)`（runtime 在 padding=0 时 `seek(delay + playable)` 会到达）在两个 codec 中短路进入 eof 态，规避 demuxer 对恰好等于流末的 ts 报 OutOfRange；流末 seek 后可再 seek 回中部继续增量读。

### 3. 测试证据（「没有 trim 与 standby 证据不宣称 gapless」门禁）

- **单元级**（`audio.rs` 内，16 个 audio 测试）：
  - MP3/FLAC 增量分段拉取 == 一次性读（逐样本一致）；seek 后位置记账：`seek(p)` 后读到流尾的样本数**精确**等于 `raw_total − p`（含非帧对齐 p、流末、越界、流末→回退四种情况）；
  - Xing/LAME trim：descriptor 如实上报 delay/padding、raw 总数正确、runtime 模型裁剪后逐样本等于 raw 去首尾段；
  - FLAC Vorbis Comment trim 同上；无元数据时 trim 为 0；
  - malformed MP3 不 panic（catch_unwind 防护保持）。
- **集成级**（`tests/gapless_backend.rs` 7 个 + `tests/gapless_continuity.rs` 15 个 + `tests/common/mod.rs` 基建）：
  - fake backend 状态机（`ScriptedStream`/`FakeDecoder`/`SlowIoDecoder`/`FakeAudioOutput`）：欠载部分读、ring 空恢复、慢 IO 增量推进、EOF 语义、seek 复位（任务 5 的欠载/慢 IO 回退语义）；
  - 权威 PCM 对比：WAV 增量解码 == 数学正弦/斜坡权威参考；两块连续 WAV 拼接无 gap/重复；seek 后边界相位连续；
  - **runtime 全链路 trim 证据**：带 Xing/LAME 的 MP3 经 `RuntimeCoordinator::play_to_end` 输出帧数精确等于 `raw − delay − padding`（3985）；FLAC Vorbis trim 同样全链路成立（2 帧）；
  - **standby 证据**：`prime_standby` 对 Xing MP3 预拉必须先 `seek(delay)`（走 demuxer 精确 seek + 帧内 skip 路径），trim 进入 `StandbyState::Primed`，PCM 缓冲后 `is_gapless_ready`；未 primed 时 `take_standby_at_sample_boundary` fail-closed；standby 头样本 == 前一曲尾之后的紧邻采样（正弦相位连续判据）。
- 门禁：crates workspace fmt / strict clippy（-D warnings）/ 25 个测试目标全绿；Tauri workspace 同门禁 165 测试全绿；前端 223 测试全绿（无 engine API 面变化，DTO 未动）。

## 未完成（不得宣称切片关闭）

1. **preparation worker（任务 2）**：`actor.rs` 的 `initialize_runtime`（`factory.open`）与 `prepare_target`（`runtime.load`）仍在 actor 控制路径上同步执行；open/probe/preparation 尚未移到独立工作线程。大文件/慢盘下 `load` 仍可能阻塞 actor 消息循环。
2. **standby 失败/慢 IO 的 actor 级回退语义**（任务 5）：runtime/decoder 级已有测试（见上），但 actor 在 standby 失败、慢 IO 下的完整回退路径（退回同步 load、事件上报）未专项补齐。
3. **连续专辑/长时播放真实音频测试**（任务 5 验收）：当前用合成 fixture（正弦/斜坡/最小 FLAC/MP3/Xing 头）；真实编码器产出的专辑连续曲目、长时播放稳定性未测。
4. **Windows 实机验收**：真实 WASAPI 输出下录回对比（或等价权威 PCM 对比）验证 gapless 未做；当前全部证据来自 fake output / 录音式 `FakeAudioOutput`。

## 预计修改与任务（剩余）

1. ~~抽象可增量 pull/seek 的 decoder，并迁移 MP3/FLAC~~（已完成）
2. 将 open/probe/decode/preparation 移出播放 actor 的控制路径（preparation worker）。
3. ~~读取并应用 encoder delay、padding/gapless metadata~~（已完成）
4. 统一 sample rate/channel/layout，预建 standby DSP chain 和 ring。（`PcmAdapter` + `map_channels` + `resample_linear` + standby DSP checkpoint 既有机制已在证据测试中走过；channel **layout** 语义（非纯计数）未专门定义）
5. 在采样边界原子切换；定义失败回退、seek/skip/queue mutation。（decoder/runtime 级已完成；actor 级回退与 queue mutation 语义部分依赖任务 2）
6. ~~控制内存和 backpressure，避免完整曲目常驻~~（已完成）

## 测试与验收（剩余）

真实编码器产出的连续专辑 fixture、seek/skip/reorder 在 actor 级、standby 失败、慢 IO、欠载、长时播放的完整矩阵；Windows 实机录回或权威 PCM 对比验证 gapless。

没有 codec trim 和 standby 预填证据前不得宣称真正 gapless（codec trim 与 standby 预填证据已具备；actor 异步 preparation 与实机录回证据未具备）。

## 完成后同步

更新播放架构、handover、验收矩阵和资源实测记录（本文件已同步；handover 与验收矩阵见对应更新）。
