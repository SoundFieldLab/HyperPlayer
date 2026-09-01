//! 播放可视化使用的有界、无身份 PCM 摘要。

use crate::dsp::PcmFormat;
use std::cell::{Cell, UnsafeCell};
use std::sync::atomic::{AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;

pub const TELEMETRY_TAP: &str = "post_dsp_pre_output_gain";
pub const WAVEFORM_BINS: usize = 64;
pub const SPECTRUM_BINS: usize = 96;
pub const TELEMETRY_FRAME_ENCODED_SIZE: usize = 780;

// HPTM v2 header: magic [0..4], version [4..6], validity [6..8],
// clocks [8..40], sample rate [40..44], waveform count [44], spectrum count [45].
pub const TELEMETRY_VALID_WAVEFORM: u16 = 1 << 0;
pub const TELEMETRY_VALID_SAMPLE_PEAK: u16 = 1 << 1;
pub const TELEMETRY_VALID_RMS: u16 = 1 << 2;
pub const TELEMETRY_VALID_SPECTRUM: u16 = 1 << 3;
pub const TELEMETRY_VALID_TRUE_PEAK: u16 = 1 << 4;
pub const TELEMETRY_VALID_LIMITER_REDUCTION: u16 = 1 << 5;
pub const TELEMETRY_VALID_LUFS: u16 = 1 << 6;
const BASIC_VALIDITY_FLAGS: u16 =
    TELEMETRY_VALID_WAVEFORM | TELEMETRY_VALID_SAMPLE_PEAK | TELEMETRY_VALID_RMS;

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
    pub spectrum: [u16; SPECTRUM_BINS],
    pub peak: [f32; 2],
    pub true_peak: [f32; 2],
    pub meter: [f32; 2],
    pub limiter_reduction_db: f32,
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
        }
    }
}

impl TelemetryFrame {
    pub fn encode(&self) -> [u8; TELEMETRY_FRAME_ENCODED_SIZE] {
        let mut output = [0_u8; TELEMETRY_FRAME_ENCODED_SIZE];
        let mut offset = 0;
        put(&mut output, &mut offset, b"HPTM");
        put(&mut output, &mut offset, &2_u16.to_le_bytes());
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
        debug_assert_eq!(offset, TELEMETRY_FRAME_ENCODED_SIZE);
        output
    }
}

fn put<const N: usize>(output: &mut [u8], offset: &mut usize, bytes: &[u8; N]) {
    output[*offset..*offset + N].copy_from_slice(bytes);
    *offset += N;
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
        }
    }

    pub(crate) fn subscribe(&self) -> TelemetrySubscriber {
        self.hub.subscribe()
    }

    pub(crate) fn begin_epoch(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.shared.epoch.store(self.epoch, Ordering::Release);
        self.sequence = 0;
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

    fn make_frame(&self, sample_rate: u32, dsp_revision: u64, sample_frame: u64) -> TelemetryFrame {
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
    fn binary_frame_is_fixed_and_under_one_kibibyte() {
        let encoded = TelemetryFrame::default().encode();
        assert_eq!(encoded.len(), TELEMETRY_FRAME_ENCODED_SIZE);
        assert!(encoded.len() <= 1024);
        assert_eq!(&encoded[..4], b"HPTM");
    }

    #[test]
    fn unavailable_metrics_are_explicitly_absent_and_spectrum_is_not_generated() {
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
        assert_eq!(u16::from_le_bytes(encoded[4..6].try_into().unwrap()), 2);
        assert_eq!(
            u16::from_le_bytes(encoded[6..8].try_into().unwrap()),
            frame.validity_flags
        );
        assert_eq!(encoded[45], 0);
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
}
