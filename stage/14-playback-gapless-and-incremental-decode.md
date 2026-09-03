# Stage 14：增量解码与真正 gapless

状态：进行中（工程侧全部完成；仅剩 Windows 实机录回/听感验收）

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

## 已完成（第二波，2026-09-03，提交于 worker/真实编码器收尾）

### 7. preparation worker（任务 2 完成）

- `actor.rs` 新增 `PreparationWorker`（照 `DspCompiler` 模式：Mutex+Condvar+单元素 `ArrayQueue`，独立 `hyperplayer-preparation` 线程）：decoder **open/probe（含无头 MP3/FLAC 的整曲扫描）移出 actor 控制路径**。
- `DecoderFactory` trait 新增 `clone_factory()`：worker 与 runtime 各持一份工厂（`LocalDecoderFactory`/`WavDecoderFactory` 为 Copy；测试 mock 各自实现）。
- `runtime.rs` 新增 `prime_standby_with_opened`：接收已打开 decoder 完成格式统一/裁剪/PCM 预拉（与 `prime_standby` 语义一致）。
- actor 侧调度：`prime_next` 同步路径保留为**无 worker 时的退化路径**（全部现有测试语义不变）；worker 模式下 `prime_next_async` 投递（新请求覆盖旧请求），tick 里 `service_preparation` 收结果并校验「queue_id 仍是当前 next」后预填 standby；transition/EOF 的 `prepare_target` 保持同步 promote/load 兜底（正确性优先，standby 未就绪不允许断播）。
- worker 起不来时降级为同步 prime（不阻止 actor 启动）。

### 8. actor 级回退语义测试（任务 5 完成剩余部分）

- `preparation_worker_primes_standby_asynchronously`：LoadContext + Enqueue 后 standby 经 worker 异步预取，Next 通过 promote 命中（2s 上限轮询）。
- `slow_decoder_open_does_not_block_the_actor_control_path`：factory open 人为延迟 300ms，期间 Snapshot 命令 <150ms 返回（actor 事件循环不被 preparation 阻塞）。
- `preparation_worker_failure_falls_back_to_synchronous_transition`：损坏文件让 worker 反复失败，actor 保持响应、当前曲可播；手动 Next 走同步 load 失败 → restore 语义保持当前曲。

### 9. 真实编码器连续专辑 fixture + 长时播放（任务 5 验收完成）

- `tests/gapless_real_encoder.rs`：**flacenc 0.5.1**（Apache-2.0，dev-dependency，完整 FLAC 编码链：LPC/QLPC、Rice 熵编码、CRC）把同一连续正弦切成三轨独立编码（44.1 kHz 立体声 16-bit、block_size 4096）：
  - `real_encoder_album_full_chain_output_matches_reference`：跨三轨 load → prime → pump → promote 全链路输出与权威参考逐点一致（±6.1e-5 量化容差、总样本数精确 3×8192×2）；
  - `real_encoder_output_opens_with_the_production_decoder`：真实编码输出被生产增量解码器正确打开（格式/总帧数/增量读）；
  - `long_playback_across_many_track_transitions_stays_stable`：8 轮 × 三轨（≈24 次 promote 切换、~40 万帧、repeat-all 回绕），输出总量精确、相位零漂移 —— 覆盖「长时播放」验收项。
- 许可证门禁：`symphonia-bundle-flac` / `symphonia-common`（MPL-2.0）加入 deny.toml exceptions（与既有 symphonia 族同口径，AGENTS.md 弱 copyleft 记录原则）；`cargo deny` advisories/bans/licenses/sources 四项 ok。

## 剩余（关闭切片的唯一阻断项）

- **Windows 实机验收**：真实 WASAPI 输出下录回对比（或等价权威 PCM 对比）+ 用户听感确认曲间无咔哒/空隙。当前全部自动证据来自 fake output（无设备 CI 可跑）+ 真实编码器 fixture；按切片定义此项不能用模拟结果替代，需要真实硬件在环与用户本人确认。

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
