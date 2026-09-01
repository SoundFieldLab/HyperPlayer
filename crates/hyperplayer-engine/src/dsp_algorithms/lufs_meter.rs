//! HyperPlayer 的 LUFS 分析 tap 适配层。
//!
//! 响度与真峰值算法由 `hse_core::lufs_meter::LufsMeter` 权威实现；本模块只负责引擎
//! PCM 适配、单 writer 原子发布、revision 状态继承与预分配 checkpoint。

use crate::dsp::{PcmBlock, PcmFormat, PcmProcessor, ResetReason};
use crate::error::{EngineError, Result as EngineResult};
use hse_core::lufs_meter::{LufsMeter as CoreLufsMeter, LufsReadings as CoreLufsReadings};
use std::array;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LufsReadings {
    pub integrated_lufs: f64,
    pub momentary_lufs: f64,
    pub short_term_lufs: f64,
    pub loudness_range: f64,
    pub peak_db: f64,
    pub true_peak_db: f64,
}

impl LufsReadings {
    pub const fn unmeasured() -> Self {
        Self {
            integrated_lufs: f64::NAN,
            momentary_lufs: f64::NAN,
            short_term_lufs: f64::NAN,
            loudness_range: f64::NAN,
            peak_db: f64::NEG_INFINITY,
            true_peak_db: f64::NEG_INFINITY,
        }
    }
}

impl From<CoreLufsReadings> for LufsReadings {
    fn from(readings: CoreLufsReadings) -> Self {
        Self {
            integrated_lufs: readings.integrated_lufs,
            momentary_lufs: readings.momentary_lufs,
            short_term_lufs: readings.short_term_lufs,
            loudness_range: readings.loudness_range,
            peak_db: readings.peak_db,
            true_peak_db: readings.true_peak_db,
        }
    }
}

const SNAPSHOT_ATTEMPTS: usize = 3;
const SNAPSHOT_SLOTS: usize = SNAPSHOT_ATTEMPTS + 2;

/// 单写、多读的 LUFS 发布状态。
///
/// writer 轮换写入不可变槽位后发布 generation。reader 最多尝试固定次数；若连续撞上
/// writer，则返回调用开始时已稳定发布的槽位。writer 在覆盖槽位前至少跨过 reader 的最大
/// 读取窗口，因此六项始终来自同一代，实时线程也不会无界自旋。
pub struct SharedLufsState {
    writer_claimed: AtomicBool,
    generation: AtomicU64,
    slots: [[AtomicU64; 6]; SNAPSHOT_SLOTS],
    realtime_integrated_lufs: AtomicU64,
    realtime_momentary_lufs: AtomicU64,
    #[cfg(test)]
    read_probe: AtomicUsize,
}

impl Default for SharedLufsState {
    fn default() -> Self {
        Self::new()
    }
}

impl SharedLufsState {
    pub fn new() -> Self {
        let readings = LufsReadings::unmeasured();
        let bits = readings.to_bits();
        Self {
            writer_claimed: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            slots: array::from_fn(|_| array::from_fn(|index| AtomicU64::new(bits[index]))),
            realtime_integrated_lufs: AtomicU64::new(readings.integrated_lufs.to_bits()),
            realtime_momentary_lufs: AtomicU64::new(readings.momentary_lufs.to_bits()),
            #[cfg(test)]
            read_probe: AtomicUsize::new(0),
        }
    }

    pub fn readings(&self) -> LufsReadings {
        let fallback_generation = self.generation.load(Ordering::Acquire);
        let fallback = self.read_slot(fallback_generation);

        for _ in 0..SNAPSHOT_ATTEMPTS {
            let generation = self.generation.load(Ordering::Acquire);
            let readings = self.read_slot(generation);
            self.run_read_probe();
            if self.generation.load(Ordering::Acquire) == generation {
                return readings;
            }
        }

        // The writer needs more than the bounded read window to reach this slot again, so the
        // snapshot captured at entry remains coherent even when every validation attempt collides.
        fallback
    }

    /// Returns only the values needed by realtime normalization without loading a full snapshot.
    pub fn realtime_loudness(&self) -> (f64, f64) {
        (
            f64::from_bits(self.realtime_integrated_lufs.load(Ordering::Acquire)),
            f64::from_bits(self.realtime_momentary_lufs.load(Ordering::Acquire)),
        )
    }

    fn claim_writer(&self) -> EngineResult<()> {
        self.writer_claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| {
                EngineError::InvalidInput("LUFS shared state already has a meter writer".into())
            })
    }

    fn publish(&self, readings: LufsReadings) {
        let next_generation = self.generation.load(Ordering::Relaxed).wrapping_add(1);
        let slot = &self.slots[Self::slot_index(next_generation)];
        for (field, bits) in slot.iter().zip(readings.to_bits()) {
            field.store(bits, Ordering::Relaxed);
        }
        self.realtime_integrated_lufs
            .store(readings.integrated_lufs.to_bits(), Ordering::Release);
        self.realtime_momentary_lufs
            .store(readings.momentary_lufs.to_bits(), Ordering::Release);
        self.generation.store(next_generation, Ordering::Release);
    }

    fn read_slot(&self, generation: u64) -> LufsReadings {
        let slot = &self.slots[Self::slot_index(generation)];
        LufsReadings::from_bits(array::from_fn(|index| slot[index].load(Ordering::Relaxed)))
    }

    fn slot_index(generation: u64) -> usize {
        (generation % SNAPSHOT_SLOTS as u64) as usize
    }

    #[cfg(test)]
    fn run_read_probe(&self) {
        if self
            .read_probe
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            self.generation.fetch_add(1, Ordering::AcqRel);
        }
    }

    #[cfg(not(test))]
    fn run_read_probe(&self) {}
}

impl LufsReadings {
    fn to_bits(self) -> [u64; 6] {
        [
            self.integrated_lufs.to_bits(),
            self.momentary_lufs.to_bits(),
            self.short_term_lufs.to_bits(),
            self.loudness_range.to_bits(),
            self.peak_db.to_bits(),
            self.true_peak_db.to_bits(),
        ]
    }

    fn from_bits(bits: [u64; 6]) -> Self {
        Self {
            integrated_lufs: f64::from_bits(bits[0]),
            momentary_lufs: f64::from_bits(bits[1]),
            short_term_lufs: f64::from_bits(bits[2]),
            loudness_range: f64::from_bits(bits[3]),
            peak_db: f64::from_bits(bits[4]),
            true_peak_db: f64::from_bits(bits[5]),
        }
    }
}

#[derive(Clone)]
struct LufsMeterCheckpoint {
    sample_rate: u32,
    meter: CoreLufsMeter,
    published_block_count: u64,
}

/// 第 19 级 LUFS tap。构造和 `prepare` 完成全部分配，`process` 只复用声道暂存。
pub struct LufsMeterProcessor {
    sample_rate: u32,
    meter: CoreLufsMeter,
    shared: Arc<SharedLufsState>,
    left: Vec<f32>,
    right: Vec<f32>,
    published_block_count: u64,
}

impl LufsMeterProcessor {
    pub fn new(sample_rate: u32, shared: Arc<SharedLufsState>) -> EngineResult<Self> {
        shared.claim_writer()?;
        let meter = match CoreLufsMeter::new(f64::from(sample_rate)) {
            Ok(meter) => meter,
            Err(error) => {
                shared.writer_claimed.store(false, Ordering::Release);
                return Err(EngineError::InvalidInput(error));
            }
        };
        Ok(Self {
            sample_rate,
            meter,
            shared,
            left: Vec::new(),
            right: Vec::new(),
            published_block_count: 0,
        })
    }

    fn publish_readings(&mut self) {
        self.shared.publish(self.meter.readings().into());
    }
}

impl Drop for LufsMeterProcessor {
    fn drop(&mut self) {
        self.shared.writer_claimed.store(false, Ordering::Release);
    }
}

impl PcmProcessor for LufsMeterProcessor {
    fn name(&self) -> &'static str {
        "lufs"
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
        let Some(previous) = previous.as_any_mut().downcast_mut::<LufsMeterProcessor>() else {
            return false;
        };
        if self.sample_rate != previous.sample_rate {
            return false;
        }
        std::mem::swap(&mut self.meter, &mut previous.meter);
        self.published_block_count = previous.published_block_count;
        self.publish_readings();
        true
    }

    fn create_runtime_checkpoint(&self) -> Option<Box<dyn std::any::Any + Send>> {
        Some(Box::new(LufsMeterCheckpoint {
            sample_rate: self.sample_rate,
            meter: self.meter.clone(),
            published_block_count: self.published_block_count,
        }))
    }

    fn runtime_checkpoint_compatible(&self, state: &(dyn std::any::Any + Send)) -> bool {
        state
            .downcast_ref::<LufsMeterCheckpoint>()
            .is_some_and(|checkpoint| checkpoint.sample_rate == self.sample_rate)
    }

    fn save_runtime_state(&self, state: &mut (dyn std::any::Any + Send)) -> bool {
        let Some(checkpoint) = state.downcast_mut::<LufsMeterCheckpoint>() else {
            return false;
        };
        if checkpoint
            .meter
            .copy_runtime_state_from(&self.meter)
            .is_err()
        {
            return false;
        }
        checkpoint.published_block_count = self.published_block_count;
        true
    }

    fn restore_runtime_state(&mut self, state: &(dyn std::any::Any + Send)) -> bool {
        let Some(checkpoint) = state.downcast_ref::<LufsMeterCheckpoint>() else {
            return false;
        };
        if self
            .meter
            .copy_runtime_state_from(&checkpoint.meter)
            .is_err()
        {
            return false;
        }
        self.published_block_count = checkpoint.published_block_count;
        self.publish_readings();
        true
    }

    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> EngineResult<()> {
        validate_stereo_format(format, self.sample_rate)?;
        self.left.resize(max_block_frames, 0.0);
        self.right.resize(max_block_frames, 0.0);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> EngineResult<()> {
        validate_stereo_format(block.format, self.sample_rate)?;
        if !block.interleaved.len().is_multiple_of(2) {
            return Err(EngineError::InvalidInput(
                "LUFS meter requires complete stereo frames".into(),
            ));
        }
        let frames = block.interleaved.len() / 2;
        if frames > self.left.len() {
            return Err(EngineError::InvalidInput(
                "LUFS block exceeds the prepared frame capacity".into(),
            ));
        }
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        self.meter
            .process_stereo(&self.left[..frames], &self.right[..frames]);
        let completed_blocks = self.meter.completed_blocks();
        if completed_blocks != self.published_block_count {
            self.published_block_count = completed_blocks;
            self.publish_readings();
        }
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {
        self.meter.reset();
        self.published_block_count = 0;
        self.shared.publish(LufsReadings::unmeasured());
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

fn validate_stereo_format(format: PcmFormat, sample_rate: u32) -> EngineResult<()> {
    if format.channels != 2 {
        return Err(EngineError::Unsupported(
            "LUFS meter requires stereo PCM".into(),
        ));
    }
    if format.sample_rate != sample_rate {
        return Err(EngineError::InvalidInput(
            "LUFS meter sample rate does not match PCM format".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::PcmSampleFormat;

    fn format(sample_rate: u32) -> PcmFormat {
        PcmFormat {
            sample_rate,
            channels: 2,
            sample_format: PcmSampleFormat::F32,
        }
    }

    fn process_constant(
        processor: &mut LufsMeterProcessor,
        sample_rate: u32,
        frames: usize,
        value: f32,
    ) {
        let mut samples = vec![value; frames * 2];
        processor
            .process(PcmBlock {
                format: format(sample_rate),
                interleaved: &mut samples,
            })
            .unwrap();
    }

    fn assert_same_readings(got: LufsReadings, core: &mut CoreLufsMeter) {
        let expected: LufsReadings = core.readings().into();
        assert_eq!(
            got.integrated_lufs.to_bits(),
            expected.integrated_lufs.to_bits()
        );
        assert_eq!(
            got.momentary_lufs.to_bits(),
            expected.momentary_lufs.to_bits()
        );
        assert_eq!(
            got.short_term_lufs.to_bits(),
            expected.short_term_lufs.to_bits()
        );
        assert_eq!(
            got.loudness_range.to_bits(),
            expected.loudness_range.to_bits()
        );
        assert_eq!(got.peak_db.to_bits(), expected.peak_db.to_bits());
        assert_eq!(got.true_peak_db.to_bits(), expected.true_peak_db.to_bits());
    }

    fn generation_readings(generation: u64) -> LufsReadings {
        let base = generation as f64 * 10.0;
        LufsReadings {
            integrated_lufs: base,
            momentary_lufs: base + 1.0,
            short_term_lufs: base + 2.0,
            loudness_range: base + 3.0,
            peak_db: base + 4.0,
            true_peak_db: base + 5.0,
        }
    }

    fn preload_generations(shared: &SharedLufsState) {
        for generation in 0..SNAPSHOT_SLOTS as u64 {
            let slot = &shared.slots[SharedLufsState::slot_index(generation)];
            for (field, bits) in slot.iter().zip(generation_readings(generation).to_bits()) {
                field.store(bits, Ordering::Relaxed);
            }
        }
    }

    #[test]
    fn shared_snapshot_preserves_sentinels_and_enforces_one_writer() {
        let shared = Arc::new(SharedLufsState::new());
        let first = LufsMeterProcessor::new(48_000, Arc::clone(&shared)).unwrap();
        assert!(LufsMeterProcessor::new(48_000, Arc::clone(&shared)).is_err());
        let readings = shared.readings();
        assert!(readings.integrated_lufs.is_nan());
        assert_eq!(readings.peak_db, f64::NEG_INFINITY);
        drop(first);
        assert!(LufsMeterProcessor::new(48_000, shared).is_ok());
    }

    #[test]
    fn shared_snapshot_retries_to_a_coherent_generation() {
        let shared = SharedLufsState::new();
        preload_generations(&shared);
        shared.read_probe.store(1, Ordering::Release);

        assert_eq!(shared.readings(), generation_readings(1));
        assert_eq!(shared.generation.load(Ordering::Acquire), 1);
    }

    #[test]
    fn shared_snapshot_falls_back_to_entry_generation_after_bounded_collisions() {
        let shared = SharedLufsState::new();
        preload_generations(&shared);
        shared
            .read_probe
            .store(SNAPSHOT_ATTEMPTS, Ordering::Release);

        assert_eq!(shared.readings(), generation_readings(0));
        assert_eq!(shared.generation.load(Ordering::Acquire), 3);
        assert_eq!(shared.read_probe.load(Ordering::Acquire), 0);
    }

    #[test]
    fn realtime_loudness_reads_dedicated_published_values() {
        let shared = SharedLufsState::new();
        let initial = shared.realtime_loudness();
        assert!(initial.0.is_nan());
        assert!(initial.1.is_nan());

        let readings = generation_readings(2);
        shared.publish(readings);

        assert_eq!(
            shared.realtime_loudness(),
            (readings.integrated_lufs, readings.momentary_lufs)
        );
        assert_eq!(shared.readings(), readings);
    }

    #[test]
    fn adapter_publishes_core_readings_only_after_a_completed_block() {
        let shared = Arc::new(SharedLufsState::new());
        let mut processor = LufsMeterProcessor::new(48_000, Arc::clone(&shared)).unwrap();
        processor.prepare(format(48_000), 19_200).unwrap();
        let mut core = CoreLufsMeter::new(48_000.0).unwrap();

        process_constant(&mut processor, 48_000, 19_199, 0.1);
        let planar = vec![0.1; 19_199];
        core.process_stereo(&planar, &planar);
        assert_eq!(core.completed_blocks(), 0);
        assert!(shared.readings().integrated_lufs.is_nan());

        process_constant(&mut processor, 48_000, 1, 0.1);
        core.process_stereo(&[0.1], &[0.1]);
        assert_eq!(core.completed_blocks(), 1);
        assert_same_readings(shared.readings(), &mut core);
    }

    #[test]
    fn revision_adoption_republishes_the_previous_core_state() {
        let previous_shared = Arc::new(SharedLufsState::new());
        let mut previous = LufsMeterProcessor::new(48_000, previous_shared).unwrap();
        previous.prepare(format(48_000), 19_200).unwrap();
        process_constant(&mut previous, 48_000, 19_200, 0.1);

        let next_shared = Arc::new(SharedLufsState::new());
        let mut next = LufsMeterProcessor::new(48_000, Arc::clone(&next_shared)).unwrap();
        next.prepare(format(48_000), 19_200).unwrap();
        assert!(next.adopt_runtime_state_from(&mut previous));
        assert_same_readings(next_shared.readings(), &mut next.meter);

        let other_shared = Arc::new(SharedLufsState::new());
        let mut other_rate = LufsMeterProcessor::new(44_100, other_shared).unwrap();
        assert!(!other_rate.adopt_runtime_state_from(&mut next));
    }

    #[test]
    fn preallocated_checkpoint_restores_core_state_and_publication() {
        let shared = Arc::new(SharedLufsState::new());
        let mut processor = LufsMeterProcessor::new(48_000, Arc::clone(&shared)).unwrap();
        processor.prepare(format(48_000), 19_200).unwrap();
        process_constant(&mut processor, 48_000, 19_200, 0.1);

        let mut checkpoint = processor.create_runtime_checkpoint().unwrap();
        assert!(processor.save_runtime_state(checkpoint.as_mut()));
        let saved = shared.readings();
        process_constant(&mut processor, 48_000, 4_800, 0.5);
        assert_ne!(
            shared.readings().momentary_lufs.to_bits(),
            saved.momentary_lufs.to_bits()
        );

        assert!(processor.restore_runtime_state(checkpoint.as_ref()));
        let restored = shared.readings();
        assert_eq!(
            restored.integrated_lufs.to_bits(),
            saved.integrated_lufs.to_bits()
        );
        assert_eq!(
            restored.momentary_lufs.to_bits(),
            saved.momentary_lufs.to_bits()
        );
        assert_eq!(
            restored.short_term_lufs.to_bits(),
            saved.short_term_lufs.to_bits()
        );
        assert_eq!(
            restored.loudness_range.to_bits(),
            saved.loudness_range.to_bits()
        );
        assert_eq!(restored.peak_db.to_bits(), saved.peak_db.to_bits());
        assert_eq!(
            restored.true_peak_db.to_bits(),
            saved.true_peak_db.to_bits()
        );
    }

    #[test]
    fn reset_republishes_unmeasured_and_processor_has_no_latency_or_tail() {
        let shared = Arc::new(SharedLufsState::new());
        let mut processor = LufsMeterProcessor::new(48_000, Arc::clone(&shared)).unwrap();
        processor.prepare(format(48_000), 19_200).unwrap();
        process_constant(&mut processor, 48_000, 19_200, 0.1);
        assert!(shared.readings().integrated_lufs.is_finite());

        processor.reset(ResetReason::Seek);
        assert!(shared.readings().integrated_lufs.is_nan());
        assert_eq!(shared.readings().peak_db, f64::NEG_INFINITY);
        assert_eq!(processor.latency_frames(), 0);
        assert_eq!(processor.tail_frames(), 0);
    }
}
