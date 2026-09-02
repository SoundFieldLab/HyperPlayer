# Stage 14：增量解码与真正 gapless

状态：待选择

## 当前基础与目标

当前播放主链可解码 WAV/FLAC/MP3，但 MP3/FLAC 仍有整体解码和 actor 被 open/decode/standby preparation 阻塞的风险。缓存完成不等于 gapless。本切片建立 preparation worker、增量 decoder、codec trim、统一 PCM、standby 预填和采样边界切换。

非目标：以 crossfade 冒充 gapless，或让前端决定音频时序。

## 前置门禁

Rust engine 是唯一播放权威；实时 callback 只做有界无锁读取/增益/欠载补零；所有解码和格式转换在非实时线程。

## 预计修改与任务

修改 engine decoder/source/actor/output/queue、ring buffer、metadata trim、播放 DTO/telemetry 和大量音频 fixture 测试。

1. 抽象可增量 pull/seek 的 decoder，并迁移 MP3/FLAC。
2. 将 open/probe/decode/preparation 移出播放 actor 的控制路径。
3. 读取并应用 encoder delay、padding/gapless metadata。
4. 统一 sample rate/channel/layout，预建 standby DSP chain 和 ring。
5. 在采样边界原子切换；定义失败回退、seek/skip/queue mutation。
6. 控制内存和 backpressure，避免完整曲目常驻。

## 测试与验收

覆盖不同 codec/sample rate/channel、带/不带 trim metadata、连续专辑 fixture、seek/skip/reorder、standby 失败、慢 IO、欠载、长时播放和采样边界无重复/缺失。Windows 实机录回或权威 PCM 对比验证 gapless。

没有 codec trim 和 standby 预填证据前不得宣称真正 gapless。

## 完成后同步

更新播放架构、handover、验收矩阵和资源实测记录。
