//! 播放可视化使用的有界、无身份 PCM 摘要。
//!
//! HPTM v3：在 v2 固定布局（字节 0..780 不变）尾部追加 dynamic-eq 5-band
//! 读数块（64 字节），并把协议预留的 true-peak / limiter-reduction 有效位
//! 与 SPECTRUM 有效位投入实际生产。频谱由 [`TelemetryProducer`] 在 ingest
//! 侧用 hse-core 的 Stage 17 [`SpectrumAnalyzer`]（2048 点 Hann + FFT）生成
//! 96 个 u16 dB bins，全程零分配、可丢帧。

use crate::dsp::PcmFormat;
use hse_core::engine_chain::{SpectrumAnalyzer, ANALYSIS_WINDOW_SIZE};
use std::cell::{Cell, UnsafeCell};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;

pub const TELEMETRY_TAP: &str = "post_dsp_pre_output_gain";
pub const TELEMETRY_WIRE_MAGIC: [u8; 4] = *b"HPTM";
pub const TELEMETRY_WIRE_VERSION: u16 = 4;
pub const WAVEFORM_BINS: usize = 64;
pub const SPECTRUM_BINS: usize = 96;
/// 频谱分析窗块长（Stage 17 权威分析口径）。
pub const SPECTRUM_ANALYSIS_WINDOW: usize = ANALYSIS_WINDOW_SIZE;
/// 频谱 u16 量化的 dB 地板（与前端 `TELEMETRY_SPECTRUM_FLOOR_DB` 一致）。
pub const SPECTRUM_DB_FLOOR: f32 = -90.0;
/// dynamic-eq 遥测带数（Stage 18 固定 5 带）。
pub const DYNAMIC_EQ_BANDS: usize = 5;
pub const TELEMETRY_FRAME_ENCODED_SIZE: usize = 856;

/// LUFS 追加块字段数（integrated/momentary/short_term，各 f32），紧随 dynamic-eq 块。
pub const LUFS_FIELD_COUNT: usize = 3;

// HPTM v4 header: magic [0..4], version [4..6], validity [6..8],
// clocks [8..40], sample rate [40..44], waveform count [44], spectrum count [45].
// v3 固定区 0..844（v2 固定区 0..780 + dynamic-eq 块 780..844）；
// v4 追加 LUFS 块 844..856（integrated/momentary/short-term 各 f32，无有效位时保持全零）。
pub const TELEMETRY_VALID_WAVEFORM: u16 = 1 << 0;
pub const TELEMETRY_VALID_SAMPLE_PEAK: u16 = 1 << 1;
pub const TELEMETRY_VALID_RMS: u16 = 1 << 2;
pub const TELEMETRY_VALID_SPECTRUM: u16 = 1 << 3;
pub const TELEMETRY_VALID_TRUE_PEAK: u16 = 1 << 4;
pub const TELEMETRY_VALID_LIMITER_REDUCTION: u16 = 1 << 5;
pub const TELEMETRY_VALID_DYNAMIC_EQ: u16 = 1 << 6;
pub const TELEMETRY_VALID_LUFS: u16 = 1 << 7;
pub const TELEMETRY_KNOWN_VALIDITY_FLAGS: u16 = TELEMETRY_VALID_WAVEFORM
    | TELEMETRY_VALID_SAMPLE_PEAK
    | TELEMETRY_VALID_RMS
    | TELEMETRY_VALID_SPECTRUM
    | TELEMETRY_VALID_TRUE_PEAK
    | TELEMETRY_VALID_LIMITER_REDUCTION
    | TELEMETRY_VALID_DYNAMIC_EQ
    | TELEMETRY_VALID_LUFS;
const BASIC_VALIDITY_FLAGS: u16 =
    TELEMETRY_VALID_WAVEFORM | TELEMETRY_VALID_SAMPLE_PEAK | TELEMETRY_VALID_RMS;

// v3 追加块布局：generation [780..784]，gain_db/level_db/reduction_db
// 各 5×f32（784..804 / 804..824 / 824..844）。编码用顺序 offset 计数，
// 无需独立命名常量（此处注释固定块布局即可）。

const SLOT_FREE: u8 = 0;
const SLOT_READY: u8 = 1;
const SLOT_READING: u8 = 2;
const SLOT_WRITING: u8 = 3;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum TelemetryActivity {
    #[default]
    Inactive = 0,
    Minimal2Hz = 2,
    Reduced15Hz = 15,
    Active30Hz = 30,
}

impl TelemetryActivity {
    fn frames_per_publication(self, sample_rate: u32) -> usize {
        (sample_rate as usize)
            .checked_div(self as usize)
            .unwrap_or(usize::MAX)
            .max(1)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TelemetryFrame {
    pub validity_flags: u16,
    pub epoch: u64,
    pub sequence: u64,
    pub sample_frame: u64,
    pub dsp_revision: u64,
    pub sample_rate: u32,
    pub waveform_min: [[i16; WAVEFORM_BINS]; 2],
    pub waveform_max: [[i16; WAVEFORM_BINS]; 2],
    /// u16 线性幅度 bins（65535 = 0 dBFS；0 = 地板/静音），对数频率映射。
    pub spectrum: [u16; SPECTRUM_BINS],
    pub peak: [f32; 2],
    pub true_peak: [f32; 2],
    pub meter: [f32; 2],
    pub limiter_reduction_db: f32,
    /// dynamic-eq 读数代际低 32 位（0 = 从未发布）。
    pub dynamic_eq_generation: u32,
    /// dynamic-eq 各带平滑增益（dB；20·log10(线性增益)，线性 1 → 0 dB）。
    pub dynamic_eq_gain_db: [f32; DYNAMIC_EQ_BANDS],
    /// dynamic-eq 各带最近分析电平（dB，原值透传）。
    pub dynamic_eq_level_db: [f32; DYNAMIC_EQ_BANDS],
    /// dynamic-eq 各带控制衰减幅度（dB，≥ 0，原值透传）。
    pub dynamic_eq_reduction_db: [f32; DYNAMIC_EQ_BANDS],
    /// 整合响度 LUFS（BS.1770 双门限；无读数时 NaN）。
    pub integrated_lufs: f32,
    /// 瞬时响度 LUFS（最新 400ms 块；无读数时 NaN）。
    pub momentary_lufs: f32,
    /// 短时响度 LUFS（最近 3s；无读数或块数不足时 NaN）。
    pub short_term_lufs: f32,
}

impl Default for TelemetryFrame {
    fn default() -> Self {
        Self {
            validity_flags: 0,
            epoch: 0,
            sequence: 0,
            sample_frame: 0,
            dsp_revision: 0,
            sample_rate: 0,
            waveform_min: [[0; WAVEFORM_BINS]; 2],
            waveform_max: [[0; WAVEFORM_BINS]; 2],
            spectrum: [0; SPECTRUM_BINS],
            peak: [0.0; 2],
            true_peak: [0.0; 2],
            meter: [0.0; 2],
            limiter_reduction_db: 0.0,
            dynamic_eq_generation: 0,
            dynamic_eq_gain_db: [0.0; DYNAMIC_EQ_BANDS],
            dynamic_eq_level_db: [0.0; DYNAMIC_EQ_BANDS],
            dynamic_eq_reduction_db: [0.0; DYNAMIC_EQ_BANDS],
            integrated_lufs: 0.0,
            momentary_lufs: 0.0,
            short_term_lufs: 0.0,
        }
    }
}

impl TelemetryFrame {
    pub fn encode(&self) -> [u8; TELEMETRY_FRAME_ENCODED_SIZE] {
        let mut output = [0_u8; TELEMETRY_FRAME_ENCODED_SIZE];
        let mut offset = 0;
        put(&mut output, &mut offset, &TELEMETRY_WIRE_MAGIC);
        put(
            &mut output,
            &mut offset,
            &TELEMETRY_WIRE_VERSION.to_le_bytes(),
        );
        put(&mut output, &mut offset, &self.validity_flags.to_le_bytes());
        for value in [
            self.epoch,
            self.sequence,
            self.sample_frame,
            self.dsp_revision,
        ] {
            put(&mut output, &mut offset, &value.to_le_bytes());
        }
        put(&mut output, &mut offset, &self.sample_rate.to_le_bytes());
        put(
            &mut output,
            &mut offset,
            &[
                if self.validity_flags & TELEMETRY_VALID_WAVEFORM != 0 {
                    WAVEFORM_BINS as u8
                } else {
                    0
                },
                if self.validity_flags & TELEMETRY_VALID_SPECTRUM != 0 {
                    SPECTRUM_BINS as u8
                } else {
                    0
                },
            ],
        );
        put(&mut output, &mut offset, &0_u16.to_le_bytes());
        for values in self.waveform_min.iter().chain(self.waveform_max.iter()) {
            for value in values {
                put(&mut output, &mut offset, &value.to_le_bytes());
            }
        }
        for value in self.spectrum {
            put(&mut output, &mut offset, &value.to_le_bytes());
        }
        for value in self
            .peak
            .iter()
            .chain(self.true_peak.iter())
            .chain(self.meter.iter())
            .chain(std::iter::once(&self.limiter_reduction_db))
        {
            put(&mut output, &mut offset, &value.to_le_bytes());
        }
        // v3 追加块：dynamic-eq 5-band 读数（无有效位时保持全零）。
        let dynamic_eq_valid = self.validity_flags & TELEMETRY_VALID_DYNAMIC_EQ != 0;
        put(
            &mut output,
            &mut offset,
            &if dynamic_eq_valid {
                self.dynamic_eq_generation
            } else {
                0
            }
            .to_le_bytes(),
        );
        for index in 0..DYNAMIC_EQ_BANDS {
            put(
                &mut output,
                &mut offset,
                &if dynamic_eq_valid {
                    self.dynamic_eq_gain_db[index]
                } else {
                    0.0
                }
                .to_le_bytes(),
            );
        }
        for index in 0..DYNAMIC_EQ_BANDS {
            put(
                &mut output,
                &mut offset,
                &if dynamic_eq_valid {
                    self.dynamic_eq_level_db[index]
                } else {
                    0.0
                }
                .to_le_bytes(),
            );
        }
        for index in 0..DYNAMIC_EQ_BANDS {
            put(
                &mut output,
                &mut offset,
                &if dynamic_eq_valid {
                    self.dynamic_eq_reduction_db[index]
                } else {
                    0.0
                }
                .to_le_bytes(),
            );
        }
        // v4 追加块：LUFS 响度（integrated/momentary/short-term 各 f32）。无有效位时保持全零。
        let lufs_valid = self.validity_flags & TELEMETRY_VALID_LUFS != 0;
        for value in [
            self.integrated_lufs,
            self.momentary_lufs,
            self.short_term_lufs,
        ] {
            put(
                &mut output,
                &mut offset,
                &if lufs_valid && value.is_finite() {
                    value
                } else {
                    0.0
                }
                .to_le_bytes(),
            );
        }
        debug_assert_eq!(offset, TELEMETRY_FRAME_ENCODED_SIZE);
        output
    }
}

fn put<const N: usize>(output: &mut [u8], offset: &mut usize, bytes: &[u8; N]) {
    output[*offset..*offset + N].copy_from_slice(bytes);
    *offset += N;
}

// ---------------------------------------------------------------------------
// 链上 meter 读数槽（Stage 04/05 读数口 → HPTM 遥测）。
//
// DynamicEqProcessor / LimiterProcessor 在 process 尾部把既有读数口的快照
// 顺手发布进进程级单槽；TelemetryProducer 在发布帧时读取。写侧只发生在
// 引擎处理线程（ProcessorChain 的 active/pending/retired 处理全部在引擎
// 线程串行执行），读侧跨线程，因此用与 limiter MeterSlot 同型的 seqlock
// 代际槽——固定数组 + 原子量，零分配、零锁。
//
// 订阅热度门：无任何遥测订阅者时写侧只付出一次 Relaxed load；首个生产者
// 发布帧后置位并保持（进程生命周期内），此后写侧每块多 ~20 次原子写。
// ---------------------------------------------------------------------------

/// 无锁代际读数槽：写侧 generation 奇偶 seqlock，读侧校验前后一致。
struct MeterReadingSlot {
    value_bits: AtomicU64,
    generation: AtomicU64,
}

impl MeterReadingSlot {
    const fn new() -> Self {
        Self {
            value_bits: AtomicU64::new(0),
            generation: AtomicU64::new(0),
        }
    }
    fn publish(&self, value: f64) {
        self.generation.fetch_add(1, Ordering::Release);
        self.value_bits.store(value.to_bits(), Ordering::Release);
        self.generation.fetch_add(1, Ordering::Release);
    }

    fn load(&self) -> Option<(f64, u64)> {
        for _ in 0..4 {
            let before = self.generation.load(Ordering::Acquire);
            if before == 0 {
                return None;
            }
            if before % 2 == 1 {
                continue;
            }
            let bits = self.value_bits.load(Ordering::Acquire);
            let after = self.generation.load(Ordering::Acquire);
            if before == after {
                return Some((f64::from_bits(bits), after));
            }
        }
        None
    }

    /// 复位到「从未发布」代际（测试隔离用；生产不复用）。
    #[cfg(test)]
    fn reset(&self) {
        self.generation.store(0, Ordering::Release);
        self.value_bits.store(0, Ordering::Release);
    }
}

/// dynamic-eq 5-band 读数快照（f64 原值；线性增益 / dB 电平 / dB 衰减）。
#[derive(Clone, Copy, Debug, PartialEq)]
struct ChainDynamicEqReading {
    generation: u64,
    gains: [f64; DYNAMIC_EQ_BANDS],
    levels_db: [f64; DYNAMIC_EQ_BANDS],
    reduction_db: [f64; DYNAMIC_EQ_BANDS],
}

struct ChainMeteringSlot {
    /// seqlock 代际（奇 = 写中）；0 = 从未发布。
    dynamic_eq_generation: AtomicU64,
    dynamic_eq_data: UnsafeCell<ChainDynamicEqReading>,
    limiter_reduction: MeterReadingSlot,
    limiter_peak: MeterReadingSlot,
    /// 本槽是否有订阅者消费（写侧热度门；隔离感知，避免测试跨槽泄漏）。
    hot: AtomicBool,
}

// 单写多读：写侧仅引擎处理线程（见模块注释），读侧代际校验。
unsafe impl Sync for ChainMeteringSlot {}

impl Default for ChainMeteringSlot {
    fn default() -> Self {
        Self {
            dynamic_eq_generation: AtomicU64::new(0),
            dynamic_eq_data: UnsafeCell::new(ChainDynamicEqReading {
                generation: 0,
                gains: [1.0; DYNAMIC_EQ_BANDS],
                levels_db: [0.0; DYNAMIC_EQ_BANDS],
                reduction_db: [0.0; DYNAMIC_EQ_BANDS],
            }),
            limiter_reduction: MeterReadingSlot::new(),
            limiter_peak: MeterReadingSlot::new(),
            hot: AtomicBool::new(false),
        }
    }
}

impl ChainMeteringSlot {
    /// 写侧：发布 dynamic-eq 读数（调用方须在引擎线程、已捕获读数时调用）。
    fn publish_dynamic_eq(
        &self,
        generation: u64,
        gains: &[f64; DYNAMIC_EQ_BANDS],
        levels_db: &[f64; DYNAMIC_EQ_BANDS],
        reduction_db: &[f64; DYNAMIC_EQ_BANDS],
    ) {
        self.dynamic_eq_generation.fetch_add(1, Ordering::Release);
        // SAFETY: 单写者（引擎处理线程），seqlock 代际排他保护读侧。
        unsafe {
            *self.dynamic_eq_data.get() = ChainDynamicEqReading {
                generation,
                gains: *gains,
                levels_db: *levels_db,
                reduction_db: *reduction_db,
            };
        }
        self.dynamic_eq_generation.fetch_add(1, Ordering::Release);
    }

    fn load_dynamic_eq(&self) -> Option<ChainDynamicEqReading> {
        for _ in 0..4 {
            let before = self.dynamic_eq_generation.load(Ordering::Acquire);
            if before == 0 {
                return None;
            }
            if before % 2 == 1 {
                continue;
            }
            // SAFETY: 读侧受 seqlock 代际校验保护。
            let candidate = unsafe { *self.dynamic_eq_data.get() };
            let after = self.dynamic_eq_generation.load(Ordering::Acquire);
            if before == after {
                return Some(candidate);
            }
        }
        None
    }

    /// 本槽写侧热度门：任一订阅者消费过即点亮并保持。
    fn mark_hot(&self) {
        self.hot.store(true, Ordering::Release);
    }

    /// 读本槽热度（隔离感知；`chain_metering_hot` 在测试隔离分支读取）。
    #[cfg(test)]
    fn hot(&self) -> bool {
        self.hot.load(Ordering::Relaxed)
    }

    /// 复位到「从未发布」的确定性初态（测试隔离用；生产不复用）。
    #[cfg(test)]
    fn reset(&self) {
        self.dynamic_eq_generation.store(0, Ordering::Release);
        // SAFETY: 单写者上下文，复位无并发读写者。
        unsafe {
            *self.dynamic_eq_data.get() = ChainDynamicEqReading {
                generation: 0,
                gains: [1.0; DYNAMIC_EQ_BANDS],
                levels_db: [0.0; DYNAMIC_EQ_BANDS],
                reduction_db: [0.0; DYNAMIC_EQ_BANDS],
            };
        }
        self.limiter_reduction.reset();
        self.limiter_peak.reset();
        self.hot.store(false, Ordering::Release);
    }
}

static CHAIN_METERING_SLOT: ChainMeteringSlot = ChainMeteringSlot {
    dynamic_eq_generation: AtomicU64::new(0),
    dynamic_eq_data: UnsafeCell::new(ChainDynamicEqReading {
        generation: 0,
        gains: [1.0; DYNAMIC_EQ_BANDS],
        levels_db: [0.0; DYNAMIC_EQ_BANDS],
        reduction_db: [0.0; DYNAMIC_EQ_BANDS],
    }),
    limiter_reduction: MeterReadingSlot::new(),
    limiter_peak: MeterReadingSlot::new(),
    hot: AtomicBool::new(false),
};
static CHAIN_METERING_HOT: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
thread_local! {
    /// 测试隔离：进程级单例槽会跨并行测试泄漏读数，需要隔离的测试把本线程
    /// 的读写切到独立的线程局部槽上（其余测试继续访问永远为空的真槽）。
    static TEST_ISOLATED_METERING: Cell<bool> = const { Cell::new(false) };
    static TEST_METERING_SLOT: ChainMeteringSlot = ChainMeteringSlot::default();
}

/// 以当前线程生效的槽执行 `f`（测试隔离见上；生产路径恒为进程级单例）。
fn with_chain_metering<R>(f: impl FnOnce(&ChainMeteringSlot) -> R) -> R {
    #[cfg(test)]
    if TEST_ISOLATED_METERING.with(Cell::get) {
        return TEST_METERING_SLOT.with(f);
    }
    f(&CHAIN_METERING_SLOT)
}

/// 写侧热度门：任何遥测订阅活跃后置位并保持；否则处理器零成本跳过发布。
///
/// 与读数槽一致采用隔离感知：测试线程切到隔离读数槽时（`TEST_ISOLATED_METERING`），
/// 处理器按隔离槽的热度判断，向隔离槽发布，从而不影响进程级全局槽；生产线程
/// 恒读全局热度。写门与写法（[`publish_limiter_readings`] 等）共用同一槽语义，
/// 保证「读侧看到写侧写的读数」且测试间不泄漏。
pub(crate) fn chain_metering_hot() -> bool {
    #[cfg(test)]
    if TEST_ISOLATED_METERING.with(Cell::get) {
        return TEST_METERING_SLOT.with(|slot| slot.hot());
    }
    CHAIN_METERING_HOT.load(Ordering::Relaxed)
}

/// 写侧：DynamicEqProcessor 在 process 尾部发布读数快照（引擎线程）。
pub(crate) fn publish_dynamic_eq_reading(
    generation: u64,
    gains: &[f64; DYNAMIC_EQ_BANDS],
    levels_db: &[f64; DYNAMIC_EQ_BANDS],
    reduction_db: &[f64; DYNAMIC_EQ_BANDS],
) {
    with_chain_metering(|slot| slot.publish_dynamic_eq(generation, gains, levels_db, reduction_db));
}

/// 写侧：LimiterProcessor 在 process 尾部发布衰减 / 检测峰值读数（引擎线程）。
pub(crate) fn publish_limiter_readings(reduction_db: f64, peak_db: f64) {
    with_chain_metering(|slot| {
        slot.limiter_reduction.publish(reduction_db);
        slot.limiter_peak.publish(peak_db);
    });
}

/// 生产者首次发布帧时点亮链上发布热度（进程生命周期内保持）。
///
/// 隔离感知：测试线程切到隔离槽时只点亮隔离槽的热度（不写全局），生产路径
/// 恒点亮全局槽，保证处理器（`chain_metering_hot`）与读数槽同语义。
fn mark_chain_metering_consumed() {
    #[cfg(test)]
    if TEST_ISOLATED_METERING.with(Cell::get) {
        TEST_METERING_SLOT.with(|slot| slot.mark_hot());
        return;
    }
    CHAIN_METERING_SLOT.mark_hot();
    CHAIN_METERING_HOT.store(true, Ordering::Release);
}

/// 测试专用：复位进程级全局读数槽与热度门，使依赖「默认无读数」的测试在
/// 任意测试顺序下都拿到与全新进程一致的确定性结果（避免跨测试全局泄漏）。
/// 仅在 `cfg(test)` 下由 `runtime` 等非 telemetry 模块的测试调用。
#[cfg(test)]
pub(crate) fn reset_chain_metering_for_tests() {
    CHAIN_METERING_SLOT.reset();
    CHAIN_METERING_HOT.store(false, Ordering::Release);
}

struct FrameSlot {
    state: AtomicU8,
    frame: UnsafeCell<TelemetryFrame>,
}

impl FrameSlot {
    fn new() -> Self {
        Self {
            state: AtomicU8::new(SLOT_FREE),
            frame: UnsafeCell::new(TelemetryFrame::default()),
        }
    }
}

// 对 frame 的访问由原子槽位状态排他保护。
unsafe impl Sync for FrameSlot {}

struct SharedSlot {
    subscribers: AtomicUsize,
    activity_counts: [AtomicUsize; 4],
    latest: AtomicU8,
    epoch: AtomicU64,
    slots: [FrameSlot; 2],
}

#[derive(Clone)]
pub struct TelemetryHub {
    shared: Arc<SharedSlot>,
}

impl Default for TelemetryHub {
    fn default() -> Self {
        Self::new()
    }
}

impl TelemetryHub {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(SharedSlot {
                subscribers: AtomicUsize::new(0),
                activity_counts: std::array::from_fn(|_| AtomicUsize::new(0)),
                latest: AtomicU8::new(0),
                epoch: AtomicU64::new(0),
                slots: [FrameSlot::new(), FrameSlot::new()],
            }),
        }
    }

    pub fn subscribe(&self) -> TelemetrySubscriber {
        self.shared.subscribers.fetch_add(1, Ordering::AcqRel);
        TelemetrySubscriber {
            shared: Arc::clone(&self.shared),
            activity: Cell::new(TelemetryActivity::Inactive),
            last_seen: Cell::new(None),
        }
    }
}

pub struct TelemetrySubscriber {
    shared: Arc<SharedSlot>,
    activity: Cell<TelemetryActivity>,
    last_seen: Cell<Option<(u64, u64)>>,
}

impl TelemetrySubscriber {
    pub fn set_activity(&self, activity: TelemetryActivity) {
        let previous = self.activity.replace(activity);
        if previous == activity {
            return;
        }
        if previous != TelemetryActivity::Inactive {
            self.shared.activity_counts[activity_index(previous)].fetch_sub(1, Ordering::AcqRel);
        }
        if activity != TelemetryActivity::Inactive {
            self.shared.activity_counts[activity_index(activity)].fetch_add(1, Ordering::AcqRel);
        }
    }

    pub fn latest(&self) -> Option<TelemetryFrame> {
        for _ in 0..2 {
            let index = usize::from(self.shared.latest.load(Ordering::Acquire) & 1);
            let slot = &self.shared.slots[index];
            if slot
                .state
                .compare_exchange(
                    SLOT_READY,
                    SLOT_READING,
                    Ordering::Acquire,
                    Ordering::Relaxed,
                )
                .is_ok()
            {
                // SLOT_READING 期间写入方不能进入该槽位。
                let frame = unsafe { *slot.frame.get() };
                slot.state.store(SLOT_READY, Ordering::Release);
                let identity = (frame.epoch, frame.sequence);
                if frame.epoch == self.shared.epoch.load(Ordering::Acquire)
                    && self.last_seen.get() != Some(identity)
                {
                    self.last_seen.set(Some(identity));
                    return Some(frame);
                }
                return None;
            }
        }
        None
    }
}

impl Drop for TelemetrySubscriber {
    fn drop(&mut self) {
        let activity = self.activity.get();
        if activity != TelemetryActivity::Inactive {
            self.shared.activity_counts[activity_index(activity)].fetch_sub(1, Ordering::AcqRel);
        }
        self.shared.subscribers.fetch_sub(1, Ordering::AcqRel);
    }
}

fn activity_index(activity: TelemetryActivity) -> usize {
    match activity {
        TelemetryActivity::Inactive => 0,
        TelemetryActivity::Minimal2Hz => 1,
        TelemetryActivity::Reduced15Hz => 2,
        TelemetryActivity::Active30Hz => 3,
    }
}

fn demanded_activity(shared: &SharedSlot) -> TelemetryActivity {
    for activity in [
        TelemetryActivity::Active30Hz,
        TelemetryActivity::Reduced15Hz,
        TelemetryActivity::Minimal2Hz,
    ] {
        if shared.activity_counts[activity_index(activity)].load(Ordering::Relaxed) != 0 {
            return activity;
        }
    }
    TelemetryActivity::Inactive
}

/// 频谱发布器：Stage 17 权威分析（mid 下混 + Hann + 2048 FFT）+ 96 bin
/// 对数频率映射 + u16 线性幅度量化。全部缓冲在构造期一次性分配，稳态
/// `push_one`/映射零分配；采样率变化时仅重算固定 bin 映射表（无分配）。
struct SpectrumPublisher {
    analyzer: SpectrumAnalyzer,
    window_sum: f64,
    /// 每个输出 bin 的 FFT 幅度谱区间 [start, end)（不含 DC bin 0）。
    bin_ranges: [(u32, u32); SPECTRUM_BINS],
    sample_rate: u32,
    latest: [u16; SPECTRUM_BINS],
    ready: bool,
}

/// 频谱映射的频率下界（Hz）。
const SPECTRUM_FMIN_HZ: f64 = 20.0;
/// 频谱映射的频率上界（Hz；实际取 min(20 kHz, nyquist)）。
const SPECTRUM_FMAX_HZ: f64 = 20_000.0;

impl SpectrumPublisher {
    fn new() -> Self {
        let analyzer = SpectrumAnalyzer::new().expect("2048 点分析内核构造不可能失败");
        let window_sum = analyzer.window_sum();
        Self {
            analyzer,
            window_sum,
            bin_ranges: [(0, 0); SPECTRUM_BINS],
            sample_rate: 0,
            latest: [0; SPECTRUM_BINS],
            ready: false,
        }
    }

    fn reset(&mut self) {
        self.analyzer.reset();
        self.latest = [0; SPECTRUM_BINS];
        self.ready = false;
    }

    /// 推入一帧立体声样本；攒满一个分析窗时立即做窗分析并刷新 bins。
    fn push_one(&mut self, left: f32, right: f32) {
        if self.analyzer.push_one(left, right) > 0 {
            self.analyzer.analyze_window();
            self.remap();
            self.ready = true;
        }
    }

    /// 幅度谱 → 96 个 u16 bins：对数频带内取峰值幅度，经 Hann 相干增益
    /// （2/Σw）归一到 dBFS，线性量化（65535 = 0 dBFS；前端按
    /// 20·log10(u16/65535) 解码，地板 [`SPECTRUM_DB_FLOOR`]）。
    fn remap(&mut self) {
        let magnitude = self.analyzer.magnitude();
        let gain = 2.0 / self.window_sum;
        for (bin, &(start, end)) in self.bin_ranges.iter().enumerate() {
            let peak = magnitude[start as usize..end as usize]
                .iter()
                .copied()
                .fold(0.0_f32, f32::max);
            let amplitude = (f64::from(peak) * gain).clamp(0.0, 1.0);
            self.latest[bin] = (amplitude * f64::from(u16::MAX)).round() as u16;
        }
    }

    fn ensure_mapping(&mut self, sample_rate: u32) {
        if self.sample_rate == sample_rate {
            return;
        }
        self.sample_rate = sample_rate;
        let hz = f64::from(sample_rate) / SPECTRUM_ANALYSIS_WINDOW as f64;
        let nyquist = f64::from(sample_rate) / 2.0;
        // 测试用的极低采样率下 nyquist 可能低于 fmin：退化为最小可用映射。
        let fmax = if nyquist < SPECTRUM_FMIN_HZ * 2.0 {
            SPECTRUM_FMIN_HZ * 2.0
        } else {
            nyquist.min(SPECTRUM_FMAX_HZ)
        };
        let ratio = fmax / SPECTRUM_FMIN_HZ;
        let max_start = SPECTRUM_ANALYSIS_WINDOW / 2;
        let max_end = SPECTRUM_ANALYSIS_WINDOW / 2 + 1;
        for (index, range) in self.bin_ranges.iter_mut().enumerate() {
            let f_lo = SPECTRUM_FMIN_HZ * ratio.powf(index as f64 / SPECTRUM_BINS as f64);
            let f_hi = SPECTRUM_FMIN_HZ * ratio.powf((index + 1) as f64 / SPECTRUM_BINS as f64);
            let mut start = ((f_lo / hz).ceil() as usize).clamp(1, max_start);
            let mut end = ((f_hi / hz).ceil() as usize).clamp(1, max_end);
            if end <= start {
                end = (start + 1).min(max_end);
            }
            if end <= start {
                start = end - 1;
            }
            *range = (start as u32, end as u32);
        }
    }
}

pub(crate) struct TelemetryProducer {
    hub: TelemetryHub,
    shared: Arc<SharedSlot>,
    epoch: u64,
    sequence: u64,
    collected_frames: usize,
    waveform_min: [[f32; WAVEFORM_BINS]; 2],
    waveform_max: [[f32; WAVEFORM_BINS]; 2],
    peak: [f32; 2],
    square_sum: [f64; 2],
    spectrum: SpectrumPublisher,
    last_dynamic_eq_generation: u64,
    last_limiter_reduction_generation: u64,
    last_limiter_peak_generation: u64,
    lufs: Option<Arc<crate::dsp_algorithms::lufs_meter::SharedLufsState>>,
    last_lufs_block_count: u64,
}

impl TelemetryProducer {
    pub(crate) fn new(hub: TelemetryHub) -> Self {
        Self {
            shared: Arc::clone(&hub.shared),
            hub,
            epoch: 0,
            sequence: 0,
            collected_frames: 0,
            waveform_min: [[f32::INFINITY; WAVEFORM_BINS]; 2],
            waveform_max: [[f32::NEG_INFINITY; WAVEFORM_BINS]; 2],
            peak: [0.0; 2],
            square_sum: [0.0; 2],
            spectrum: SpectrumPublisher::new(),
            last_dynamic_eq_generation: 0,
            last_limiter_reduction_generation: 0,
            last_limiter_peak_generation: 0,
            lufs: None,
            last_lufs_block_count: 0,
        }
    }

    /// 绑定 LUFS 分析 tap 的共享读数（Stage 19 读数闭环）。每次配置 DSP 时由运行时注入。
    pub(crate) fn set_lufs_source(
        &mut self,
        state: Arc<crate::dsp_algorithms::lufs_meter::SharedLufsState>,
    ) {
        self.lufs = Some(state);
        self.last_lufs_block_count = 0;
    }

    pub(crate) fn subscribe(&self) -> TelemetrySubscriber {
        self.hub.subscribe()
    }

    pub(crate) fn begin_epoch(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.shared.epoch.store(self.epoch, Ordering::Release);
        self.sequence = 0;
        self.spectrum.reset();
        self.reset_accumulator();
    }

    pub(crate) fn ingest(
        &mut self,
        format: PcmFormat,
        pcm: &[f32],
        dsp_revision: u64,
        first_sample_frame: u64,
    ) {
        if self.shared.subscribers.load(Ordering::Relaxed) == 0 {
            return;
        }
        let activity = demanded_activity(&self.shared);
        if activity == TelemetryActivity::Inactive || format.channels == 0 {
            return;
        }
        self.spectrum.ensure_mapping(format.sample_rate);
        let channels = usize::from(format.channels);
        let period = activity.frames_per_publication(format.sample_rate);
        for (frame_index, frame) in pcm.chunks_exact(channels).enumerate() {
            let bin = (self.collected_frames * WAVEFORM_BINS / period).min(WAVEFORM_BINS - 1);
            let left = finite_sample(frame[0]);
            let right = finite_sample(frame[if channels > 1 { 1 } else { 0 }]);
            for (channel, sample) in [left, right].into_iter().enumerate() {
                self.waveform_min[channel][bin] = self.waveform_min[channel][bin].min(sample);
                self.waveform_max[channel][bin] = self.waveform_max[channel][bin].max(sample);
                self.peak[channel] = self.peak[channel].max(sample.abs());
                self.square_sum[channel] += f64::from(sample) * f64::from(sample);
            }
            self.spectrum.push_one(left, right);
            self.collected_frames += 1;
            if self.collected_frames >= period {
                let sample_frame = first_sample_frame
                    .wrapping_add(frame_index as u64)
                    .wrapping_add(1);
                self.publish(format.sample_rate, dsp_revision, sample_frame);
                self.reset_accumulator();
            }
        }
    }

    fn publish(&mut self, sample_rate: u32, dsp_revision: u64, sample_frame: u64) {
        mark_chain_metering_consumed();
        let frame = self.make_frame(sample_rate, dsp_revision, sample_frame);
        let latest = usize::from(self.shared.latest.load(Ordering::Relaxed) & 1);
        for index in [latest ^ 1, latest] {
            let slot = &self.shared.slots[index];
            let state = slot.state.load(Ordering::Relaxed);
            if state == SLOT_READING || state == SLOT_WRITING {
                continue;
            }
            if slot
                .state
                .compare_exchange(state, SLOT_WRITING, Ordering::Acquire, Ordering::Relaxed)
                .is_err()
            {
                continue;
            }
            // SLOT_WRITING 赋予生产者对固定帧存储的排他访问权。
            unsafe { *slot.frame.get() = frame };
            slot.state.store(SLOT_READY, Ordering::Release);
            self.shared.latest.store(index as u8, Ordering::Release);
            self.sequence = self.sequence.wrapping_add(1);
            return;
        }
    }

    fn make_frame(
        &mut self,
        sample_rate: u32,
        dsp_revision: u64,
        sample_frame: u64,
    ) -> TelemetryFrame {
        let mut frame = TelemetryFrame {
            validity_flags: BASIC_VALIDITY_FLAGS,
            epoch: self.epoch,
            sequence: self.sequence,
            sample_frame,
            dsp_revision,
            sample_rate,
            ..TelemetryFrame::default()
        };
        for channel in 0..2 {
            for bin in 0..WAVEFORM_BINS {
                frame.waveform_min[channel][bin] = quantize_wave(self.waveform_min[channel][bin]);
                frame.waveform_max[channel][bin] = quantize_wave(self.waveform_max[channel][bin]);
            }
            frame.peak[channel] = self.peak[channel];
            frame.meter[channel] =
                (self.square_sum[channel] / self.collected_frames.max(1) as f64).sqrt() as f32;
        }
        if self.spectrum.ready {
            frame.validity_flags |= TELEMETRY_VALID_SPECTRUM;
            frame.spectrum = self.spectrum.latest;
        }
        // 链上读数：仅在代际推进（有新读数）时置有效位，陈旧读数按缺失处理。
        // 读侧与写侧共用 with_chain_metering（隔离感知），保证测试线程内
        // 写入的读数能被同线程的发布器读到，且跨测试不泄漏。
        with_chain_metering(|slot| {
            if let Some((value_db, generation)) = slot.limiter_reduction.load() {
                if generation != self.last_limiter_reduction_generation && value_db.is_finite() {
                    frame.validity_flags |= TELEMETRY_VALID_LIMITER_REDUCTION;
                    frame.limiter_reduction_db = value_db as f32;
                    self.last_limiter_reduction_generation = generation;
                }
            }
            if let Some((peak_db, generation)) = slot.limiter_peak.load() {
                if generation != self.last_limiter_peak_generation && peak_db.is_finite() {
                    frame.validity_flags |= TELEMETRY_VALID_TRUE_PEAK;
                    let linear = 10_f64.powf(peak_db / 20.0).clamp(0.0, 64.0);
                    frame.true_peak = [linear as f32; 2];
                    self.last_limiter_peak_generation = generation;
                }
            }
            if let Some(reading) = slot.load_dynamic_eq() {
                if reading.generation != self.last_dynamic_eq_generation {
                    frame.validity_flags |= TELEMETRY_VALID_DYNAMIC_EQ;
                    frame.dynamic_eq_generation = reading.generation as u32;
                    for index in 0..DYNAMIC_EQ_BANDS {
                        let gain = reading.gains[index].max(1.0e-6);
                        frame.dynamic_eq_gain_db[index] = if gain.is_finite() {
                            (20.0 * gain.log10()) as f32
                        } else {
                            0.0
                        };
                        let level = reading.levels_db[index];
                        frame.dynamic_eq_level_db[index] =
                            if level.is_finite() { level as f32 } else { 0.0 };
                        let reduction = reading.reduction_db[index];
                        frame.dynamic_eq_reduction_db[index] = if reduction.is_finite() {
                            reduction as f32
                        } else {
                            0.0
                        };
                    }
                    self.last_dynamic_eq_generation = reading.generation;
                }
            }
        });
        // Stage 19 LUFS 读数：从共享发布状态读取三档响度。换源（DSP 重配）后第一帧
        // 重新对齐块计数，避免把旧源的读数误当作新源发布。
        if let Some(lufs) = self.lufs.as_ref() {
            let readings = lufs.readings();
            let generation = lufs.generation();
            if generation != self.last_lufs_block_count || self.last_lufs_block_count == 0 {
                self.last_lufs_block_count = generation;
                if readings.integrated_lufs.is_finite()
                    || readings.momentary_lufs.is_finite()
                    || readings.short_term_lufs.is_finite()
                {
                    frame.validity_flags |= TELEMETRY_VALID_LUFS;
                    frame.integrated_lufs = readings.integrated_lufs as f32;
                    frame.momentary_lufs = readings.momentary_lufs as f32;
                    frame.short_term_lufs = readings.short_term_lufs as f32;
                }
            }
        }
        frame
    }

    fn reset_accumulator(&mut self) {
        self.collected_frames = 0;
        self.waveform_min.fill([f32::INFINITY; WAVEFORM_BINS]);
        self.waveform_max.fill([f32::NEG_INFINITY; WAVEFORM_BINS]);
        self.peak.fill(0.0);
        self.square_sum.fill(0.0);
    }
}

fn finite_sample(sample: f32) -> f32 {
    if sample.is_finite() {
        sample
    } else {
        0.0
    }
}

fn quantize_wave(sample: f32) -> i16 {
    if !sample.is_finite() {
        return 0;
    }
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::PcmSampleFormat;
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    struct CountingAllocator;

    thread_local! {
        static COUNT_ALLOCATIONS: Cell<bool> = const { Cell::new(false) };
        static ALLOCATION_COUNT: Cell<usize> = const { Cell::new(0) };
    }

    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            COUNT_ALLOCATIONS.with(|armed| {
                if armed.get() {
                    ALLOCATION_COUNT.with(|count| count.set(count.get() + 1));
                }
            });
            unsafe { System.alloc(layout) }
        }

        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            unsafe { System.dealloc(ptr, layout) }
        }

        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            COUNT_ALLOCATIONS.with(|armed| {
                if armed.get() {
                    ALLOCATION_COUNT.with(|count| count.set(count.get() + 1));
                }
            });
            unsafe { System.alloc_zeroed(layout) }
        }

        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            COUNT_ALLOCATIONS.with(|armed| {
                if armed.get() {
                    ALLOCATION_COUNT.with(|count| count.set(count.get() + 1));
                }
            });
            unsafe { System.realloc(ptr, layout, new_size) }
        }
    }

    #[global_allocator]
    static ALLOCATOR: CountingAllocator = CountingAllocator;

    struct AllocationGuard;

    impl AllocationGuard {
        fn arm() -> Self {
            ALLOCATION_COUNT.with(|count| count.set(0));
            COUNT_ALLOCATIONS.with(|armed| armed.set(true));
            Self
        }

        fn count(&self) -> usize {
            ALLOCATION_COUNT.with(Cell::get)
        }
    }

    impl Drop for AllocationGuard {
        fn drop(&mut self) {
            COUNT_ALLOCATIONS.with(|armed| armed.set(false));
        }
    }

    fn format(sample_rate: u32) -> PcmFormat {
        PcmFormat {
            sample_rate,
            channels: 2,
            sample_format: PcmSampleFormat::F32,
        }
    }

    /// 恰好一个发布周期的立体声 PCM（Active30Hz @48 kHz = 1600 帧）。
    fn one_period(value: f32) -> Vec<f32> {
        vec![value; 2 * 1_600]
    }

    /// 把本线程的读数读写切到隔离槽上执行，结束后恢复——避免进程级全局槽在
    /// 测试间泄漏，且线程局部标志不跨测试残留（RAII 作用域）。
    fn with_test_metering_isolation<R>(f: impl FnOnce() -> R) -> R {
        TEST_ISOLATED_METERING.with(|flag| flag.set(true));
        let result = f();
        TEST_ISOLATED_METERING.with(|flag| flag.set(false));
        result
    }

    #[test]
    fn activity_rates_map_to_the_approved_frame_periods() {
        assert_eq!(
            TelemetryActivity::Active30Hz.frames_per_publication(48_000),
            1_600
        );
        assert_eq!(
            TelemetryActivity::Reduced15Hz.frames_per_publication(48_000),
            3_200
        );
        assert_eq!(
            TelemetryActivity::Minimal2Hz.frames_per_publication(48_000),
            24_000
        );
        assert_eq!(
            TelemetryActivity::Inactive.frames_per_publication(48_000),
            usize::MAX
        );
    }

    #[test]
    fn lufs_readings_reach_the_frame_when_fresh() {
        with_test_metering_isolation(|| {
            let mut producer = TelemetryProducer::new(TelemetryHub::new());
            let subscriber = producer.subscribe();
            subscriber.set_activity(TelemetryActivity::Active30Hz);

            let lufs = Arc::new(crate::dsp_algorithms::lufs_meter::SharedLufsState::new());
            let readings = crate::dsp_algorithms::lufs_meter::LufsReadings {
                integrated_lufs: -17.5,
                momentary_lufs: -17.4,
                short_term_lufs: -17.6,
                loudness_range: 0.0,
                peak_db: -20.0,
                true_peak_db: -20.1,
            };
            lufs.publish_for_tests(readings);

            // set_lufs_source 后 first ingest 对齐块计数（此时无读数，不置 flag）；
            // 随后新读数代际推进，下一帧应发布 LUFS。
            producer.set_lufs_source(Arc::clone(&lufs));
            producer.ingest(format(30), &[0.75, -0.25], 4, 0);
            lufs.publish_for_tests(readings);
            producer.ingest(format(30), &[0.5, -0.5], 5, 1);
            let frame = subscriber.latest().unwrap();
            assert_ne!(frame.validity_flags & TELEMETRY_VALID_LUFS, 0);
            assert_eq!(frame.integrated_lufs, -17.5);
            assert_eq!(frame.momentary_lufs, -17.4);
            assert_eq!(frame.short_term_lufs, -17.6);
        });
    }

    #[test]
    fn binary_frame_is_fixed_and_counts_describe_availability() {
        let unavailable = TelemetryFrame {
            validity_flags: TELEMETRY_VALID_SAMPLE_PEAK | TELEMETRY_VALID_RMS,
            ..TelemetryFrame::default()
        }
        .encode();
        assert_eq!(unavailable.len(), TELEMETRY_FRAME_ENCODED_SIZE);
        assert!(unavailable.len() <= 1024);
        assert_eq!(&unavailable[..4], &TELEMETRY_WIRE_MAGIC);
        assert_eq!(unavailable[44], 0);
        assert_eq!(unavailable[45], 0);
        assert_eq!(&unavailable[46..48], &[0, 0]);

        let available = TelemetryFrame {
            validity_flags: TELEMETRY_VALID_WAVEFORM | TELEMETRY_VALID_SPECTRUM,
            ..TelemetryFrame::default()
        }
        .encode();
        assert_eq!(available.len(), TELEMETRY_FRAME_ENCODED_SIZE);
        assert_eq!(available[44], WAVEFORM_BINS as u8);
        assert_eq!(available[45], SPECTRUM_BINS as u8);
    }

    #[test]
    fn unavailable_metrics_are_explicitly_absent_and_spectrum_is_not_generated() {
        // 隔离读数槽：本测试只有发布器、没有任何处理器，不受其它测试写入真实
        // 全局读数槽的残留影响，保证 validity 恰好为三个基础位。
        with_test_metering_isolation(|| {
            let mut producer = TelemetryProducer::new(TelemetryHub::new());
            let subscriber = producer.subscribe();
            subscriber.set_activity(TelemetryActivity::Active30Hz);
            producer.ingest(format(30), &[0.75, -0.25], 4, 0);

            let frame = subscriber.latest().unwrap();
            assert_eq!(
                frame.validity_flags,
                TELEMETRY_VALID_WAVEFORM | TELEMETRY_VALID_SAMPLE_PEAK | TELEMETRY_VALID_RMS
            );
            assert!(frame.spectrum.iter().all(|value| *value == 0));
            assert_eq!(frame.true_peak, [0.0; 2]);
            assert_eq!(frame.limiter_reduction_db, 0.0);

            let encoded = frame.encode();
            assert_eq!(u16::from_le_bytes(encoded[4..6].try_into().unwrap()), 4);
            assert_eq!(
                u16::from_le_bytes(encoded[6..8].try_into().unwrap()),
                frame.validity_flags
            );
            assert_eq!(encoded[45], 0);
        });
    }

    #[test]
    fn inactive_or_unsubscribed_producer_does_no_analysis() {
        let mut producer = TelemetryProducer::new(TelemetryHub::new());
        producer.ingest(format(60), &[1.0, -1.0], 7, 0);
        assert_eq!(producer.collected_frames, 0);
        let subscriber = producer.subscribe();
        producer.ingest(format(60), &[1.0, -1.0], 7, 0);
        assert_eq!(producer.collected_frames, 0);
        subscriber.set_activity(TelemetryActivity::Active30Hz);
        producer.ingest(format(60), &[1.0, -1.0, 0.5, -0.5], 7, 0);
        assert_eq!(subscriber.latest().unwrap().sample_frame, 2);
    }

    #[test]
    fn latest_slot_overwrites_an_unread_frame() {
        let mut producer = TelemetryProducer::new(TelemetryHub::new());
        let subscriber = producer.subscribe();
        subscriber.set_activity(TelemetryActivity::Active30Hz);
        producer.ingest(format(30), &[0.1, -0.1], 1, 0);
        producer.ingest(format(30), &[0.2, -0.2], 2, 0);
        producer.ingest(format(30), &[0.3, -0.3], 3, 0);
        let frame = subscriber.latest().unwrap();
        assert_eq!(frame.sequence, 2);
        assert_eq!(frame.dsp_revision, 3);
        assert!(subscriber.latest().is_none());
    }

    #[test]
    fn subscribers_observe_the_same_latest_frame_independently() {
        let mut producer = TelemetryProducer::new(TelemetryHub::new());
        let first = producer.subscribe();
        let second = producer.subscribe();
        first.set_activity(TelemetryActivity::Active30Hz);
        producer.ingest(format(30), &[0.5, -0.5], 4, 0);
        assert_eq!(first.latest(), second.latest());
        assert!(first.latest().is_none());
        assert!(second.latest().is_none());
    }

    #[test]
    fn subscriber_is_send_and_activity_uses_maximum_live_demand() {
        fn assert_send<T: Send>() {}
        assert_send::<TelemetrySubscriber>();

        let hub = TelemetryHub::new();
        let mut producer = TelemetryProducer::new(hub.clone());
        let slow = hub.subscribe();
        let fast = hub.subscribe();
        slow.set_activity(TelemetryActivity::Minimal2Hz);
        fast.set_activity(TelemetryActivity::Active30Hz);

        producer.ingest(format(30), &[0.25, -0.25], 1, 0);
        assert!(slow.latest().is_some());
        drop(fast);

        for sample_frame in 1..15 {
            producer.ingest(format(30), &[0.25, -0.25], 2, sample_frame);
        }
        assert!(slow.latest().is_none());
        producer.ingest(format(30), &[0.25, -0.25], 2, 15);
        assert!(slow.latest().is_some());

        drop(slow);
        producer.ingest(format(30), &[0.25, -0.25], 3, 16);
        assert_eq!(producer.collected_frames, 0);
    }

    #[test]
    fn frame_contains_only_bounded_aggregates() {
        let mut producer = TelemetryProducer::new(TelemetryHub::new());
        let subscriber = producer.subscribe();
        subscriber.set_activity(TelemetryActivity::Active30Hz);
        producer.ingest(format(60), &[-2.0, 0.25, 0.5, 2.0], 9, 0);
        let frame = subscriber.latest().unwrap();
        assert_eq!(frame.waveform_min[0][0], -i16::MAX);
        assert_eq!(frame.waveform_max[1][32], i16::MAX);
        assert_eq!(frame.peak, [2.0, 2.0]);
        assert_eq!(frame.dsp_revision, 9);
    }

    #[test]
    fn active_ingest_and_publication_allocate_nothing() {
        let mut producer = TelemetryProducer::new(TelemetryHub::new());
        let subscriber = producer.subscribe();
        subscriber.set_activity(TelemetryActivity::Active30Hz);
        let pcm = [0.25_f32; 532];
        let guard = AllocationGuard::arm();
        producer.ingest(format(8_000), &pcm, 3, 0);
        assert_eq!(guard.count(), 0);
        drop(guard);
        assert!(subscriber.latest().is_some());
    }

    #[test]
    fn epoch_resets_sequence_and_sample_clock() {
        let mut producer = TelemetryProducer::new(TelemetryHub::new());
        let subscriber = producer.subscribe();
        subscriber.set_activity(TelemetryActivity::Active30Hz);
        producer.ingest(format(30), &[0.0, 0.0], 0, 0);
        producer.begin_epoch();
        assert!(subscriber.latest().is_none());
        producer.ingest(format(30), &[0.0, 0.0], 4, 0);
        let frame = subscriber.latest().unwrap();
        assert_eq!(frame.epoch, 1);
        assert_eq!(frame.sequence, 0);
        assert_eq!(frame.sample_frame, 1);
    }

    // ------------------------- HPTM v3 扩展 -------------------------

    #[test]
    fn v4_frame_is_fixed_size_and_reserves_absent_sections_as_zero() {
        let absent = TelemetryFrame::default().encode();
        assert_eq!(absent.len(), TELEMETRY_FRAME_ENCODED_SIZE);
        assert_eq!(u16::from_le_bytes(absent[4..6].try_into().unwrap()), 4);
        assert_eq!(
            u16::from_le_bytes(absent[6..8].try_into().unwrap()),
            0,
            "无有效位时 validity 必须为 0"
        );
        // v2 固定区尾（meter/limiter）、v3 dynamic-eq 块与 v4 LUFS 块都保持全零。
        assert!(absent[752..].iter().all(|byte| *byte == 0));

        let mut present = TelemetryFrame {
            validity_flags: TELEMETRY_VALID_SPECTRUM
                | TELEMETRY_VALID_TRUE_PEAK
                | TELEMETRY_VALID_LIMITER_REDUCTION
                | TELEMETRY_VALID_DYNAMIC_EQ
                | TELEMETRY_VALID_LUFS,
            ..TelemetryFrame::default()
        };
        present.spectrum[0] = 1;
        present.true_peak = [1.5; 2];
        present.limiter_reduction_db = -3.5;
        present.dynamic_eq_generation = 7;
        present.dynamic_eq_gain_db = [-1.0; DYNAMIC_EQ_BANDS];
        present.dynamic_eq_level_db = [-30.0; DYNAMIC_EQ_BANDS];
        present.dynamic_eq_reduction_db = [2.0; DYNAMIC_EQ_BANDS];
        present.integrated_lufs = -17.5;
        present.momentary_lufs = -17.4;
        present.short_term_lufs = -17.6;
        let encoded = present.encode();
        assert_eq!(u32::from_le_bytes(encoded[780..784].try_into().unwrap()), 7);
        assert_eq!(
            f32::from_le_bytes(encoded[784..788].try_into().unwrap()),
            -1.0
        );
        assert_eq!(
            f32::from_le_bytes(encoded[824..828].try_into().unwrap()),
            2.0
        );
        // v4 LUFS 块（844..856）。
        assert_eq!(
            f32::from_le_bytes(encoded[844..848].try_into().unwrap()),
            -17.5
        );
        assert_eq!(
            f32::from_le_bytes(encoded[848..852].try_into().unwrap()),
            -17.4
        );
        assert_eq!(
            f32::from_le_bytes(encoded[852..856].try_into().unwrap()),
            -17.6
        );
    }

    #[test]
    fn spectrum_bins_use_a_monotonic_log_frequency_mapping() {
        let mut publisher = SpectrumPublisher::new();
        publisher.ensure_mapping(48_000);
        let hz = 48_000.0 / SPECTRUM_ANALYSIS_WINDOW as f64;
        let fmax = 20_000.0_f64;
        for (index, &(start, end)) in publisher.bin_ranges.iter().enumerate() {
            assert!(start >= 1, "bin {index} 不得包含 DC");
            assert!(end > start, "bin {index} 区间必须非空");
            assert!(
                end <= (SPECTRUM_ANALYSIS_WINDOW / 2 + 1) as u32,
                "bin {index} 越界"
            );
            if index > 0 {
                let (_, previous_end) = publisher.bin_ranges[index - 1];
                assert!(start <= previous_end, "bin {index} 映射必须单调");
            }
        }
        // 首个 bin 覆盖 20 Hz 附近的解析位置。
        let (first_start, _) = publisher.bin_ranges[0];
        assert!((first_start as f64 - 20.0 / hz).abs() <= 1.0);
        // 末个 bin 覆盖 fmax 附近。
        let (last_start, last_end) = publisher.bin_ranges[SPECTRUM_BINS - 1];
        assert!(last_end > last_start);
        assert!(last_end as f64 * hz >= fmax - hz);
        // 采样率变化触发重映射（8 kHz → nyquist 4 kHz 上界）。
        publisher.ensure_mapping(8_000);
        let hz_8k = 8_000.0 / SPECTRUM_ANALYSIS_WINDOW as f64;
        let (_, last_end_8k) = publisher.bin_ranges[SPECTRUM_BINS - 1];
        assert!(last_end_8k as f64 * hz_8k >= 4_000.0 - hz_8k);
    }

    #[test]
    fn spectrum_publishes_a_tone_into_the_expected_u16_bins() {
        let mut producer = TelemetryProducer::new(TelemetryHub::new());
        let subscriber = producer.subscribe();
        subscriber.set_activity(TelemetryActivity::Active30Hz);
        // 40 号 bin 正弦（@48 kHz → 937.5 Hz），mid 下混 0.5 幅度：相干增益
        // 归一后 ≈ 0.5 → u16 ≈ 0.5·65535。两个分析窗保证发布点（1600/3200）
        // 晚于首个窗分析（2048）。
        let k0 = 40_usize;
        let mut pcm = Vec::with_capacity(4 * SPECTRUM_ANALYSIS_WINDOW);
        for i in 0..2 * SPECTRUM_ANALYSIS_WINDOW {
            let sample = (2.0 * std::f64::consts::PI * k0 as f64 * i as f64
                / SPECTRUM_ANALYSIS_WINDOW as f64)
                .sin() as f32
                * 0.5;
            pcm.push(sample);
            pcm.push(sample);
        }
        producer.ingest(format(48_000), &pcm, 1, 0);
        let frame = subscriber.latest().unwrap();
        assert!(frame.validity_flags & TELEMETRY_VALID_SPECTRUM != 0);
        // 找出幅度最大的 bin：应覆盖 k=40。
        let peak_bin = (0..SPECTRUM_BINS)
            .max_by_key(|&bin| frame.spectrum[bin])
            .unwrap();
        let (start, end) = publisher_range_for_test(48_000, peak_bin);
        assert!(
            start <= k0 as u32 && (k0 as u32) < end,
            "峰值 bin {peak_bin} 应覆盖 FFT bin {k0}"
        );
        let peak_value = frame.spectrum[peak_bin];
        let amplitude = f64::from(peak_value) / f64::from(u16::MAX);
        assert!(
            (amplitude - 0.5).abs() < 5e-3,
            "归一幅度 {amplitude} 应 ≈ 0.5"
        );
        // 底部 bin 保持近地板。
        assert!(frame.spectrum[0] <= u16::MAX / 100);
    }

    fn publisher_range_for_test(sample_rate: u32, bin: usize) -> (u32, u32) {
        let mut publisher = SpectrumPublisher::new();
        publisher.ensure_mapping(sample_rate);
        publisher.bin_ranges[bin]
    }

    #[test]
    fn spectrum_is_absent_before_the_first_analysis_window() {
        let mut producer = TelemetryProducer::new(TelemetryHub::new());
        let subscriber = producer.subscribe();
        subscriber.set_activity(TelemetryActivity::Active30Hz);
        // 一个发布周期（1600 帧）不足以攒满 2048 分析窗。
        producer.ingest(format(48_000), &one_period(0.5), 1, 0);
        let frame = subscriber.latest().unwrap();
        assert!(frame.validity_flags & TELEMETRY_VALID_SPECTRUM == 0);
        assert!(frame.spectrum.iter().all(|value| *value == 0));
        // 复位分析环形窗，避免上一段 tone 样本残留在窗内产生非零谱；然后喂
        // 足够的静音帧使下一次发布（frame 3200）在第 2048 窗满之后发生。
        producer.begin_epoch();
        let silence = vec![0.0_f32; 4 * SPECTRUM_ANALYSIS_WINDOW];
        producer.ingest(format(48_000), &silence, 1, 0);
        let frame = subscriber.latest().unwrap();
        assert!(frame.validity_flags & TELEMETRY_VALID_SPECTRUM != 0);
        assert!(frame.spectrum.iter().all(|value| *value == 0));
    }

    #[test]
    fn epoch_resets_the_spectrum_ring() {
        let mut producer = TelemetryProducer::new(TelemetryHub::new());
        let subscriber = producer.subscribe();
        subscriber.set_activity(TelemetryActivity::Active30Hz);
        // 4·W 个 f32 = 4096 帧（两条发布线 1600/3200），第 2 条发布晚于首个
        // 分析窗（2048），故最后发布带 SPECTRUM 有效位。
        let silence = vec![0.0_f32; 4 * SPECTRUM_ANALYSIS_WINDOW];
        producer.ingest(format(48_000), &silence, 1, 0);
        assert!(subscriber.latest().unwrap().validity_flags & TELEMETRY_VALID_SPECTRUM != 0);
        producer.begin_epoch();
        producer.ingest(format(48_000), &one_period(0.0), 2, 0);
        let frame = subscriber.latest().unwrap();
        assert!(frame.validity_flags & TELEMETRY_VALID_SPECTRUM == 0);
    }

    #[test]
    fn chain_metering_readings_reach_the_frame_when_fresh() {
        // 本测试写进程级读数槽，必须与其它测试隔离开（否则写进真实全局槽，
        // `make_frame` 会跨测试读到陈旧读数）。隔离把读写都切到线程局部槽。
        with_test_metering_isolation(|| {
            let mut producer = TelemetryProducer::new(TelemetryHub::new());
            let subscriber = producer.subscribe();
            subscriber.set_activity(TelemetryActivity::Active30Hz);
            let pcm = one_period(0.1);

            // 无发布：读数位全缺。
            producer.ingest(format(48_000), &pcm, 1, 0);
            let frame = subscriber.latest().unwrap();
            assert!(frame.validity_flags & TELEMETRY_VALID_LIMITER_REDUCTION == 0);
            assert!(frame.validity_flags & TELEMETRY_VALID_TRUE_PEAK == 0);
            assert!(frame.validity_flags & TELEMETRY_VALID_DYNAMIC_EQ == 0);

            // limiter 发布：衰减 ≤ 0 dB 透传，检测峰值换算线性真峰值。
            publish_limiter_readings(-2.5, -6.0206);
            producer.ingest(format(48_000), &pcm, 1, 1_600);
            let frame = subscriber.latest().unwrap();
            assert!(frame.validity_flags & TELEMETRY_VALID_LIMITER_REDUCTION != 0);
            assert!((f64::from(frame.limiter_reduction_db) + 2.5).abs() < 1e-6);
            assert!(frame.validity_flags & TELEMETRY_VALID_TRUE_PEAK != 0);
            assert!((f64::from(frame.true_peak[0]) - 0.5).abs() < 1e-3);
            assert_eq!(frame.true_peak[0], frame.true_peak[1]);

            // 同代际不再重复发布（陈旧读数按缺失处理）。
            producer.ingest(format(48_000), &pcm, 1, 3_200);
            let frame = subscriber.latest().unwrap();
            assert!(frame.validity_flags & TELEMETRY_VALID_LIMITER_REDUCTION == 0);

            // dynamic-eq 发布：线性增益换 dB，电平/衰减透传。
            publish_dynamic_eq_reading(
                42,
                &[0.5, 1.0, 2.0, 1.0, 1.0],
                &[-31.0, -30.0, -29.0, -30.0, -30.0],
                &[3.0, 0.0, 1.0, 0.0, 0.0],
            );
            producer.ingest(format(48_000), &pcm, 1, 4_800);
            let frame = subscriber.latest().unwrap();
            assert!(frame.validity_flags & TELEMETRY_VALID_DYNAMIC_EQ != 0);
            assert_eq!(frame.dynamic_eq_generation, 42);
            assert!((f64::from(frame.dynamic_eq_gain_db[0]) + 6.0206).abs() < 1e-3);
            assert_eq!(frame.dynamic_eq_gain_db[1], 0.0);
            assert!((f64::from(frame.dynamic_eq_level_db[0]) + 31.0).abs() < 1e-6);
            assert!((f64::from(frame.dynamic_eq_reduction_db[0]) - 3.0).abs() < 1e-6);

            // 代际不推进则不再置位。
            producer.ingest(format(48_000), &pcm, 1, 6_400);
            let frame = subscriber.latest().unwrap();
            assert!(frame.validity_flags & TELEMETRY_VALID_DYNAMIC_EQ == 0);
        });
    }

    #[test]
    fn backpressure_keeps_dropping_whole_spectrum_frames_without_blocking() {
        let mut producer = TelemetryProducer::new(TelemetryHub::new());
        let subscriber = producer.subscribe();
        subscriber.set_activity(TelemetryActivity::Active30Hz);
        let mut pcm = Vec::new();
        for i in 0..SPECTRUM_ANALYSIS_WINDOW * 4 {
            let sample = if i % 2 == 0 { 0.1_f32 } else { -0.1 };
            pcm.push(sample);
            pcm.push(sample);
        }
        // 连续多次发布期间不取帧：只保留最新帧，无队列增长、无阻塞。
        for revision in 1..=6_u64 {
            producer.ingest(format(48_000), &pcm, revision, 0);
        }
        let frame = subscriber.latest().unwrap();
        assert_eq!(frame.dsp_revision, 6);
        assert!(frame.validity_flags & TELEMETRY_VALID_SPECTRUM != 0);
        assert!(subscriber.latest().is_none());
    }

    #[test]
    fn active_spectrum_ingest_and_publication_allocate_nothing() {
        let mut producer = TelemetryProducer::new(TelemetryHub::new());
        let subscriber = producer.subscribe();
        subscriber.set_activity(TelemetryActivity::Active30Hz);
        // 恰好跨两个分析窗的单块 ingest（覆盖 FFT + bin 映射路径）。
        let mut pcm = Vec::new();
        for i in 0..SPECTRUM_ANALYSIS_WINDOW * 2 {
            let sample = ((i as f64) * 0.01).sin() as f32 * 0.4;
            pcm.push(sample);
            pcm.push(-sample);
        }
        let guard = AllocationGuard::arm();
        producer.ingest(format(48_000), &pcm, 3, 0);
        assert_eq!(guard.count(), 0, "Active30Hz 分析路径不允许分配");
        drop(guard);
        let frame = subscriber.latest().unwrap();
        assert!(frame.validity_flags & TELEMETRY_VALID_SPECTRUM != 0);
    }
}
