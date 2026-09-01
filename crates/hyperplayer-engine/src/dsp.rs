use crate::error::{EngineError, Result};
use serde::{Deserialize, Serialize};
use std::any::Any;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PcmSampleFormat {
    F32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PcmFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: PcmSampleFormat,
}

#[derive(Debug)]
pub struct PcmBlock<'a> {
    pub format: PcmFormat,
    pub interleaved: &'a mut [f32],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetReason {
    Load,
    Seek,
    Stop,
    FormatChange,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessorFaultKind {
    ProcessingFailed,
    NonFiniteOutput,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeStateCapability {
    Stateless,
    Stateful,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ProcessorFault {
    pub processor_index: usize,
    pub processor_name: &'static str,
    pub kind: ProcessorFaultKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ProcessorChainSnapshot {
    pub revision: u64,
    pub pending_revision: Option<u64>,
    pub applied_at_frame: u64,
    pub latency_frames: u32,
    pub tail_frames: u32,
    pub fault: Option<ProcessorFault>,
    pub fault_stream_frame: Option<u64>,
    pub safe_bypass_active: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExecutionMode {
    Configured,
    SafeBypass,
}

pub trait AsAny {
    fn as_any_mut(&mut self) -> &mut dyn Any;
}

impl<T: Any> AsAny for T {
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

pub trait PcmProcessor: Send + AsAny {
    fn name(&self) -> &'static str;
    fn runtime_state_capability(&self) -> RuntimeStateCapability {
        RuntimeStateCapability::Stateful
    }
    fn adopt_runtime_state_from(&mut self, _previous: &mut dyn PcmProcessor) -> bool {
        false
    }
    fn create_runtime_checkpoint(&self) -> Option<Box<dyn Any + Send>> {
        None
    }
    fn runtime_checkpoint_compatible(&self, _state: &(dyn Any + Send)) -> bool {
        false
    }
    fn save_runtime_state(&self, _state: &mut (dyn Any + Send)) -> bool {
        false
    }
    fn restore_runtime_state(&mut self, _state: &(dyn Any + Send)) -> bool {
        false
    }
    fn prepare(&mut self, format: PcmFormat, max_block_frames: usize) -> Result<()>;
    fn process(&mut self, block: PcmBlock<'_>) -> Result<()>;
    fn reset(&mut self, reason: ResetReason);
    fn latency_frames(&self) -> u32;
    fn tail_frames(&self) -> u32;
}

#[derive(Default)]
pub struct BypassProcessor;

impl PcmProcessor for BypassProcessor {
    fn name(&self) -> &'static str {
        "bypass"
    }

    fn runtime_state_capability(&self) -> RuntimeStateCapability {
        RuntimeStateCapability::Stateless
    }

    fn prepare(&mut self, _format: PcmFormat, _max_block_frames: usize) -> Result<()> {
        Ok(())
    }

    fn process(&mut self, _block: PcmBlock<'_>) -> Result<()> {
        Ok(())
    }

    fn reset(&mut self, _reason: ResetReason) {}

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

pub struct PreparedProcessorChain {
    revision: u64,
    format: PcmFormat,
    max_block_frames: usize,
    processors: Vec<Box<dyn PcmProcessor>>,
    runtime_checkpoint: Vec<Option<Box<dyn Any + Send>>>,
    rollback: Vec<f32>,
    latency_frames: u32,
    tail_frames: u32,
    fault: Option<ProcessorFault>,
    fault_stream_frame: Option<u64>,
    checkpoint_fault: Option<ProcessorFault>,
    checkpoint_fault_stream_frame: Option<u64>,
    applied_at_frame: u64,
}

impl PreparedProcessorChain {
    pub fn prepare(
        revision: u64,
        format: PcmFormat,
        max_block_frames: usize,
        mut processors: Vec<Box<dyn PcmProcessor>>,
    ) -> Result<Self> {
        if format.sample_rate == 0 || format.channels == 0 {
            return Err(EngineError::InvalidInput(
                "DSP format must have a sample rate and channels".into(),
            ));
        }
        if max_block_frames == 0 {
            return Err(EngineError::InvalidInput(
                "DSP maximum block size must be greater than zero".into(),
            ));
        }
        if processors.is_empty() {
            processors.push(Box::new(BypassProcessor));
        }
        for processor in &mut processors {
            processor.prepare(format, max_block_frames)?;
        }
        let latency_frames = processors.iter().try_fold(0_u32, |total, processor| {
            total
                .checked_add(processor.latency_frames())
                .ok_or_else(|| {
                    EngineError::InvalidInput("DSP latency exceeds the supported range".into())
                })
        })?;
        let tail_frames = processors.iter().try_fold(0_u32, |total, processor| {
            total.checked_add(processor.tail_frames()).ok_or_else(|| {
                EngineError::InvalidInput("DSP tail exceeds the supported range".into())
            })
        })?;
        let max_samples = max_block_frames
            .checked_mul(usize::from(format.channels))
            .ok_or_else(|| EngineError::InvalidInput("DSP block size overflows memory".into()))?;
        let runtime_checkpoint = processors
            .iter()
            .map(|processor| processor.create_runtime_checkpoint())
            .collect();
        Ok(Self {
            revision,
            format,
            max_block_frames,
            processors,
            runtime_checkpoint,
            rollback: vec![0.0; max_samples],
            latency_frames,
            tail_frames,
            fault: None,
            fault_stream_frame: None,
            checkpoint_fault: None,
            checkpoint_fault_stream_frame: None,
            applied_at_frame: 0,
        })
    }

    pub fn bypass(revision: u64, format: PcmFormat, max_block_frames: usize) -> Result<Self> {
        Self::prepare(
            revision,
            format,
            max_block_frames,
            vec![Box::new(BypassProcessor)],
        )
    }

    pub fn format(&self) -> PcmFormat {
        self.format
    }

    pub fn max_block_frames(&self) -> usize {
        self.max_block_frames
    }

    pub fn snapshot(&self) -> ProcessorChainSnapshot {
        ProcessorChainSnapshot {
            revision: self.revision,
            pending_revision: None,
            applied_at_frame: self.applied_at_frame,
            latency_frames: self.latency_frames,
            tail_frames: self.tail_frames,
            fault: self.fault,
            fault_stream_frame: self.fault_stream_frame,
            safe_bypass_active: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn processor_names(&self) -> Vec<&'static str> {
        self.processors
            .iter()
            .map(|processor| processor.name())
            .collect()
    }

    fn adopt_runtime_state_from(&mut self, previous: &mut Self) {
        for next_processor in &mut self.processors {
            for previous_processor in &mut previous.processors {
                if next_processor.adopt_runtime_state_from(previous_processor.as_mut()) {
                    break;
                }
            }
        }
    }

    fn process(&mut self, samples: &mut [f32]) {
        if self.fault.is_some() {
            return;
        }
        let channels = usize::from(self.format.channels);
        if samples.len() > self.rollback.len() || !samples.len().is_multiple_of(channels) {
            self.fault = Some(ProcessorFault {
                processor_index: 0,
                processor_name: "processor_chain",
                kind: ProcessorFaultKind::ProcessingFailed,
            });
            return;
        }
        self.rollback[..samples.len()].copy_from_slice(samples);
        for (processor_index, processor) in self.processors.iter_mut().enumerate() {
            let processor_name = processor.name();
            if processor
                .process(PcmBlock {
                    format: self.format,
                    interleaved: samples,
                })
                .is_err()
            {
                samples.copy_from_slice(&self.rollback[..samples.len()]);
                self.fault = Some(ProcessorFault {
                    processor_index,
                    processor_name,
                    kind: ProcessorFaultKind::ProcessingFailed,
                });
                return;
            }
            if samples.iter().any(|sample| !sample.is_finite()) {
                samples.copy_from_slice(&self.rollback[..samples.len()]);
                self.fault = Some(ProcessorFault {
                    processor_index,
                    processor_name,
                    kind: ProcessorFaultKind::NonFiniteOutput,
                });
                return;
            }
        }
    }

    fn reset(&mut self, reason: ResetReason) {
        for processor in &mut self.processors {
            processor.reset(reason);
        }
    }
}

pub struct ProcessorChain {
    active: PreparedProcessorChain,
    bypass: PreparedProcessorChain,
    pending: Option<PreparedProcessorChain>,
    retired: Option<PreparedProcessorChain>,
    execution_mode: ExecutionMode,
    checkpoint_execution_mode: ExecutionMode,
    unreported_fault: Option<(u64, ProcessorFault, u64)>,
    checkpoint_unreported_fault: Option<(u64, ProcessorFault, u64)>,
    has_runtime_checkpoint: bool,
}

impl ProcessorChain {
    pub fn bypass_only(format: PcmFormat, max_block_frames: usize) -> Result<Self> {
        let active = PreparedProcessorChain::bypass(0, format, max_block_frames)?;
        Ok(Self {
            bypass: PreparedProcessorChain::bypass(0, format, max_block_frames)?,
            active,
            pending: None,
            retired: None,
            execution_mode: ExecutionMode::Configured,
            checkpoint_execution_mode: ExecutionMode::Configured,
            unreported_fault: None,
            checkpoint_unreported_fault: None,
            has_runtime_checkpoint: false,
        })
    }

    pub fn from_prepared(active: PreparedProcessorChain) -> Self {
        let bypass = PreparedProcessorChain::bypass(
            active.revision,
            active.format(),
            active.max_block_frames(),
        )
        .expect("active DSP chain already has a valid block contract");
        Self {
            active,
            bypass,
            pending: None,
            retired: None,
            execution_mode: ExecutionMode::Configured,
            checkpoint_execution_mode: ExecutionMode::Configured,
            unreported_fault: None,
            checkpoint_unreported_fault: None,
            has_runtime_checkpoint: false,
        }
    }

    pub fn queue_prepared(
        &mut self,
        prepared: PreparedProcessorChain,
    ) -> Result<Option<PreparedProcessorChain>> {
        if self.has_runtime_checkpoint {
            return Err(EngineError::InvalidInput(
                "cannot replace DSP chain during speculative processing".into(),
            ));
        }
        if prepared.format() != self.active.format()
            || prepared.max_block_frames() != self.active.max_block_frames()
        {
            return Err(EngineError::InvalidInput(
                "prepared DSP chain does not match the active block contract".into(),
            ));
        }
        let newest_revision = self
            .pending
            .as_ref()
            .map_or(self.active.revision, |pending| pending.revision);
        if prepared.revision <= newest_revision {
            return Err(EngineError::InvalidInput(
                "DSP chain revision must increase monotonically".into(),
            ));
        }
        if self.retired.is_some() {
            return Err(EngineError::InvalidInput(
                "previous DSP chain replacement has not been reclaimed".into(),
            ));
        }
        Ok(self.pending.replace(prepared))
    }

    pub fn process(
        &mut self,
        format: PcmFormat,
        samples: &mut [f32],
        stream_frame: u64,
    ) -> Result<()> {
        self.validate_block(format, samples)?;
        if samples.is_empty() {
            return Ok(());
        }
        if !self.has_runtime_checkpoint {
            self.apply_pending_at_block_boundary(stream_frame);
        }
        self.process_and_capture_fault(samples, stream_frame);
        Ok(())
    }

    pub(crate) fn process_applied(
        &mut self,
        format: PcmFormat,
        samples: &mut [f32],
        stream_frame: u64,
    ) -> Result<()> {
        self.validate_block(format, samples)?;
        if !samples.is_empty() {
            self.process_and_capture_fault(samples, stream_frame);
        }
        Ok(())
    }

    fn process_and_capture_fault(&mut self, samples: &mut [f32], stream_frame: u64) {
        if self.execution_mode == ExecutionMode::SafeBypass {
            self.bypass.process(samples);
            return;
        }
        let prior_fault = self.active.fault;
        self.active.process(samples);
        if prior_fault.is_none() {
            if let Some(fault) = self.active.fault {
                self.active.fault_stream_frame = Some(stream_frame);
                self.unreported_fault = Some((self.active.revision, fault, stream_frame));
                self.execution_mode = ExecutionMode::SafeBypass;
            }
        }
    }

    fn validate_block(&self, format: PcmFormat, samples: &[f32]) -> Result<()> {
        if format != self.active.format() {
            return Err(EngineError::InvalidInput(
                "PCM block format does not match the prepared DSP chain".into(),
            ));
        }
        let channels = usize::from(format.channels);
        if samples.len() > self.active.rollback.len() || !samples.len().is_multiple_of(channels) {
            return Err(EngineError::InvalidInput(
                "PCM block does not match the prepared DSP block contract".into(),
            ));
        }
        Ok(())
    }

    fn apply_pending_at_block_boundary(&mut self, stream_frame: u64) {
        if let Some(mut next) = self.pending.take() {
            if self.active.fault.is_none() {
                next.adopt_runtime_state_from(&mut self.active);
            }
            next.applied_at_frame = stream_frame;
            self.retired = Some(std::mem::replace(&mut self.active, next));
            self.execution_mode = ExecutionMode::Configured;
        }
    }

    pub fn drain(
        &mut self,
        format: PcmFormat,
        samples: &mut [f32],
        stream_frame: u64,
    ) -> Result<()> {
        self.validate_block(format, samples)?;
        samples.fill(0.0);
        if !samples.is_empty() {
            self.process_and_capture_fault(samples, stream_frame);
        }
        Ok(())
    }

    pub fn snapshot(&self) -> ProcessorChainSnapshot {
        let mut snapshot = self.active.snapshot();
        snapshot.pending_revision = self.pending.as_ref().map(|pending| pending.revision);
        snapshot.safe_bypass_active = self.execution_mode == ExecutionMode::SafeBypass;
        if snapshot.safe_bypass_active {
            snapshot.latency_frames = 0;
            snapshot.tail_frames = 0;
        }
        snapshot
    }

    pub fn reset(&mut self, reason: ResetReason) {
        self.has_runtime_checkpoint = false;
        self.checkpoint_unreported_fault = None;
        self.unreported_fault = None;
        self.active.reset(reason);
        self.bypass.reset(reason);
        if let Some(pending) = &mut self.pending {
            pending.reset(reason);
        }
    }

    pub fn take_unreported_fault(&mut self) -> Option<(u64, ProcessorFault, u64)> {
        self.unreported_fault.take()
    }

    pub fn reclaim_retired(&mut self) -> Option<PreparedProcessorChain> {
        self.retired.take()
    }

    pub fn begin_speculative_processing(&mut self) -> Result<()> {
        if self.has_runtime_checkpoint {
            return Err(EngineError::InvalidInput(
                "DSP speculative processing is already active".into(),
            ));
        }
        for (processor, state) in self
            .active
            .processors
            .iter()
            .zip(&self.active.runtime_checkpoint)
        {
            match state {
                Some(state) if !processor.runtime_checkpoint_compatible(state.as_ref()) => {
                    return Err(EngineError::InvalidInput(
                        "DSP runtime checkpoint does not match its processor".into(),
                    ));
                }
                None if processor.runtime_state_capability()
                    == RuntimeStateCapability::Stateful =>
                {
                    return Err(EngineError::InvalidInput(
                        "stateful DSP processor does not support speculative checkpoints".into(),
                    ));
                }
                _ => {}
            }
        }
        for (processor, state) in self
            .active
            .processors
            .iter()
            .zip(&mut self.active.runtime_checkpoint)
        {
            if let Some(state) = state {
                if !processor.save_runtime_state(state.as_mut()) {
                    return Err(EngineError::InvalidInput(
                        "DSP runtime checkpoint does not match its processor".into(),
                    ));
                }
            }
        }
        self.active.checkpoint_fault = self.active.fault;
        self.active.checkpoint_fault_stream_frame = self.active.fault_stream_frame;
        self.checkpoint_unreported_fault = self.unreported_fault;
        self.checkpoint_execution_mode = self.execution_mode;
        self.has_runtime_checkpoint = true;
        Ok(())
    }

    pub fn speculative_processing_fault(&self) -> Option<ProcessorFault> {
        if !self.has_runtime_checkpoint || self.active.fault == self.active.checkpoint_fault {
            return None;
        }
        self.active.fault
    }

    pub fn restore_speculative_processing(&mut self) -> Result<()> {
        if !self.has_runtime_checkpoint {
            return Ok(());
        }
        for (processor, state) in self
            .active
            .processors
            .iter()
            .zip(&self.active.runtime_checkpoint)
        {
            match state {
                Some(state) if !processor.runtime_checkpoint_compatible(state.as_ref()) => {
                    return Err(EngineError::InvalidInput(
                        "DSP runtime checkpoint does not match its processor".into(),
                    ));
                }
                None if processor.runtime_state_capability()
                    != RuntimeStateCapability::Stateless =>
                {
                    return Err(EngineError::InvalidInput(
                        "stateful DSP processor does not support speculative checkpoints".into(),
                    ));
                }
                _ => {}
            }
        }
        for (processor, state) in self
            .active
            .processors
            .iter_mut()
            .zip(&self.active.runtime_checkpoint)
        {
            if let Some(state) = state {
                if !processor.restore_runtime_state(state.as_ref()) {
                    return Err(EngineError::InvalidInput(
                        "DSP runtime checkpoint does not match its processor".into(),
                    ));
                }
            }
        }
        self.active.fault = self.active.checkpoint_fault;
        self.active.fault_stream_frame = self.active.checkpoint_fault_stream_frame;
        self.unreported_fault = self.checkpoint_unreported_fault;
        self.execution_mode = self.checkpoint_execution_mode;
        self.has_runtime_checkpoint = false;
        Ok(())
    }

    pub fn restore_speculative_processing_to_safe_bypass(&mut self) -> Result<bool> {
        let Some(fault) = self.speculative_processing_fault() else {
            self.restore_speculative_processing()?;
            return Ok(false);
        };
        let revision = self.active.revision;
        let stream_frame = self
            .active
            .fault_stream_frame
            .expect("a speculative DSP fault records its stream frame");
        self.restore_speculative_processing()?;
        self.active.fault = Some(fault);
        self.active.fault_stream_frame = Some(stream_frame);
        self.unreported_fault = Some((revision, fault, stream_frame));
        self.execution_mode = ExecutionMode::SafeBypass;
        Ok(true)
    }

    pub fn commit_speculative_processing(&mut self) {
        self.has_runtime_checkpoint = false;
    }

    pub fn max_block_frames(&self) -> usize {
        self.active.max_block_frames()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn format() -> PcmFormat {
        PcmFormat {
            sample_rate: 48_000,
            channels: 2,
            sample_format: PcmSampleFormat::F32,
        }
    }

    #[test]
    fn bypass_is_bit_transparent_and_has_no_latency() {
        let original = vec![-1.0_f32, -0.25, -0.0, 0.0, 0.75, 1.0];
        let original_bits = original
            .iter()
            .map(|sample| sample.to_bits())
            .collect::<Vec<_>>();
        let mut samples = original;
        let mut chain = ProcessorChain::bypass_only(format(), 3).unwrap();
        chain.process(format(), &mut samples, 0).unwrap();
        assert_eq!(
            samples
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            original_bits
        );
        assert_eq!(chain.snapshot().latency_frames, 0);
        assert_eq!(chain.snapshot().tail_frames, 0);
    }

    struct FaultingProcessor {
        non_finite: bool,
    }

    impl PcmProcessor for FaultingProcessor {
        fn name(&self) -> &'static str {
            "faulting"
        }
        fn prepare(&mut self, _format: PcmFormat, _max_block_frames: usize) -> Result<()> {
            Ok(())
        }
        fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
            block.interleaved[0] = if self.non_finite { f32::NAN } else { 99.0 };
            if self.non_finite {
                Ok(())
            } else {
                Err(EngineError::AudioBackend("test processor failed".into()))
            }
        }
        fn reset(&mut self, _reason: ResetReason) {}
        fn latency_frames(&self) -> u32 {
            3
        }
        fn tail_frames(&self) -> u32 {
            5
        }
    }

    #[test]
    fn nested_speculative_checkpoint_is_rejected() {
        let mut chain = ProcessorChain::bypass_only(format(), 1).unwrap();
        chain.begin_speculative_processing().unwrap();
        assert!(matches!(
            chain.begin_speculative_processing(),
            Err(EngineError::InvalidInput(_))
        ));
        chain.restore_speculative_processing().unwrap();
    }

    #[test]
    fn processor_without_explicit_checkpoint_support_is_rejected() {
        struct ForgottenCheckpointSupport;

        impl PcmProcessor for ForgottenCheckpointSupport {
            fn name(&self) -> &'static str {
                "forgotten-checkpoint-support"
            }
            fn prepare(&mut self, _format: PcmFormat, _max_block_frames: usize) -> Result<()> {
                Ok(())
            }
            fn process(&mut self, _block: PcmBlock<'_>) -> Result<()> {
                Ok(())
            }
            fn reset(&mut self, _reason: ResetReason) {}
            fn latency_frames(&self) -> u32 {
                0
            }
            fn tail_frames(&self) -> u32 {
                0
            }
        }

        let prepared = PreparedProcessorChain::prepare(
            1,
            format(),
            1,
            vec![Box::new(ForgottenCheckpointSupport)],
        )
        .unwrap();
        let mut chain = ProcessorChain::from_prepared(prepared);

        assert!(chain.begin_speculative_processing().is_err());
        assert!(!chain.has_runtime_checkpoint);
    }

    #[test]
    fn checkpoint_save_failure_does_not_activate_speculative_processing() {
        struct SaveFailure;

        impl PcmProcessor for SaveFailure {
            fn name(&self) -> &'static str {
                "save-failure"
            }
            fn create_runtime_checkpoint(&self) -> Option<Box<dyn Any + Send>> {
                Some(Box::new(()))
            }
            fn runtime_checkpoint_compatible(&self, state: &(dyn Any + Send)) -> bool {
                state.is::<()>()
            }
            fn save_runtime_state(&self, _state: &mut (dyn Any + Send)) -> bool {
                false
            }
            fn prepare(&mut self, _format: PcmFormat, _max_block_frames: usize) -> Result<()> {
                Ok(())
            }
            fn process(&mut self, _block: PcmBlock<'_>) -> Result<()> {
                Ok(())
            }
            fn reset(&mut self, _reason: ResetReason) {}
            fn latency_frames(&self) -> u32 {
                0
            }
            fn tail_frames(&self) -> u32 {
                0
            }
        }

        let prepared =
            PreparedProcessorChain::prepare(1, format(), 1, vec![Box::new(SaveFailure)]).unwrap();
        let mut chain = ProcessorChain::from_prepared(prepared);

        assert!(chain.begin_speculative_processing().is_err());
        assert!(!chain.has_runtime_checkpoint);
        assert!(chain
            .queue_prepared(PreparedProcessorChain::bypass(2, format(), 1).unwrap())
            .is_ok());
    }

    #[test]
    fn restore_preflights_all_checkpoints_before_mutating_any_processor() {
        struct CheckpointProcessor {
            processor_name: &'static str,
            value: u32,
            reject_after_process: bool,
            checkpoint_rejected: bool,
        }

        impl PcmProcessor for CheckpointProcessor {
            fn name(&self) -> &'static str {
                self.processor_name
            }
            fn create_runtime_checkpoint(&self) -> Option<Box<dyn Any + Send>> {
                Some(Box::new(self.value))
            }
            fn runtime_checkpoint_compatible(&self, state: &(dyn Any + Send)) -> bool {
                !self.checkpoint_rejected && state.is::<u32>()
            }
            fn save_runtime_state(&self, state: &mut (dyn Any + Send)) -> bool {
                let Some(value) = state.downcast_mut::<u32>() else {
                    return false;
                };
                *value = self.value;
                true
            }
            fn restore_runtime_state(&mut self, state: &(dyn Any + Send)) -> bool {
                let Some(value) = state.downcast_ref::<u32>() else {
                    return false;
                };
                self.value = *value;
                true
            }
            fn prepare(&mut self, _format: PcmFormat, _max_block_frames: usize) -> Result<()> {
                Ok(())
            }
            fn process(&mut self, _block: PcmBlock<'_>) -> Result<()> {
                self.value += 1;
                self.checkpoint_rejected = self.reject_after_process;
                Ok(())
            }
            fn reset(&mut self, _reason: ResetReason) {}
            fn latency_frames(&self) -> u32 {
                0
            }
            fn tail_frames(&self) -> u32 {
                0
            }
        }

        let prepared = PreparedProcessorChain::prepare(
            1,
            format(),
            1,
            vec![
                Box::new(CheckpointProcessor {
                    processor_name: "earlier",
                    value: 10,
                    reject_after_process: false,
                    checkpoint_rejected: false,
                }),
                Box::new(CheckpointProcessor {
                    processor_name: "asymmetric-mismatch",
                    value: 20,
                    reject_after_process: true,
                    checkpoint_rejected: false,
                }),
            ],
        )
        .unwrap();
        let mut chain = ProcessorChain::from_prepared(prepared);
        chain.begin_speculative_processing().unwrap();
        chain.process_applied(format(), &mut [0.0, 0.0], 0).unwrap();

        assert!(chain.restore_speculative_processing().is_err());
        let earlier = chain.active.processors[0]
            .as_mut()
            .as_any_mut()
            .downcast_mut::<CheckpointProcessor>()
            .unwrap();
        assert_eq!(earlier.value, 11);
        assert!(chain.has_runtime_checkpoint);
    }

    #[test]
    fn speculative_fault_is_rolled_back_with_processor_state() {
        struct OneShotNonFinite {
            fail_next: bool,
        }
        impl PcmProcessor for OneShotNonFinite {
            fn name(&self) -> &'static str {
                "one-shot-non-finite"
            }
            fn create_runtime_checkpoint(&self) -> Option<Box<dyn Any + Send>> {
                Some(Box::new(self.fail_next))
            }
            fn runtime_checkpoint_compatible(&self, state: &(dyn Any + Send)) -> bool {
                state.is::<bool>()
            }
            fn save_runtime_state(&self, state: &mut (dyn Any + Send)) -> bool {
                let Some(value) = state.downcast_mut::<bool>() else {
                    return false;
                };
                *value = self.fail_next;
                true
            }
            fn restore_runtime_state(&mut self, state: &(dyn Any + Send)) -> bool {
                let Some(value) = state.downcast_ref::<bool>() else {
                    return false;
                };
                self.fail_next = *value;
                true
            }
            fn prepare(&mut self, _format: PcmFormat, _max_block_frames: usize) -> Result<()> {
                Ok(())
            }
            fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
                if self.fail_next {
                    block.interleaved[0] = f32::NAN;
                    self.fail_next = false;
                }
                Ok(())
            }
            fn reset(&mut self, _reason: ResetReason) {}
            fn latency_frames(&self) -> u32 {
                0
            }
            fn tail_frames(&self) -> u32 {
                0
            }
        }

        let prepared = PreparedProcessorChain::prepare(
            1,
            format(),
            1,
            vec![Box::new(OneShotNonFinite { fail_next: true })],
        )
        .unwrap();
        let mut chain = ProcessorChain::from_prepared(prepared);
        chain.begin_speculative_processing().unwrap();
        let mut speculative = [0.25_f32, -0.25];
        chain
            .process_applied(format(), &mut speculative, 37)
            .unwrap();
        assert!(chain.speculative_processing_fault().is_some());
        assert!(chain.snapshot().fault.is_some());
        assert_eq!(chain.snapshot().fault_stream_frame, Some(37));
        assert!(chain.snapshot().safe_bypass_active);
        assert!(chain.take_unreported_fault().is_some());

        chain.restore_speculative_processing().unwrap();
        assert!(chain.snapshot().fault.is_none());
        assert_eq!(chain.snapshot().fault_stream_frame, None);
        assert!(!chain.snapshot().safe_bypass_active);
        assert!(chain.take_unreported_fault().is_none());
        let mut replay = [0.25_f32, -0.25];
        chain.process_applied(format(), &mut replay, 41).unwrap();
        assert!(chain.snapshot().fault.is_some());
        assert_eq!(chain.snapshot().fault_stream_frame, Some(41));
    }

    #[test]
    fn speculative_fault_can_restore_state_and_latch_safe_bypass() {
        struct OneShotNonFinite {
            fail_next: bool,
        }
        impl PcmProcessor for OneShotNonFinite {
            fn name(&self) -> &'static str {
                "one-shot-non-finite"
            }
            fn create_runtime_checkpoint(&self) -> Option<Box<dyn Any + Send>> {
                Some(Box::new(self.fail_next))
            }
            fn runtime_checkpoint_compatible(&self, state: &(dyn Any + Send)) -> bool {
                state.is::<bool>()
            }
            fn save_runtime_state(&self, state: &mut (dyn Any + Send)) -> bool {
                let Some(value) = state.downcast_mut::<bool>() else {
                    return false;
                };
                *value = self.fail_next;
                true
            }
            fn restore_runtime_state(&mut self, state: &(dyn Any + Send)) -> bool {
                let Some(value) = state.downcast_ref::<bool>() else {
                    return false;
                };
                self.fail_next = *value;
                true
            }
            fn prepare(&mut self, _format: PcmFormat, _max_block_frames: usize) -> Result<()> {
                Ok(())
            }
            fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
                if self.fail_next {
                    block.interleaved[0] = f32::NAN;
                    self.fail_next = false;
                }
                Ok(())
            }
            fn reset(&mut self, _reason: ResetReason) {}
            fn latency_frames(&self) -> u32 {
                3
            }
            fn tail_frames(&self) -> u32 {
                5
            }
        }

        let prepared = PreparedProcessorChain::prepare(
            9,
            format(),
            1,
            vec![Box::new(OneShotNonFinite { fail_next: true })],
        )
        .unwrap();
        let mut chain = ProcessorChain::from_prepared(prepared);
        chain.begin_speculative_processing().unwrap();
        let mut speculative = [0.25_f32, -0.25];
        chain
            .process_applied(format(), &mut speculative, 37)
            .unwrap();

        assert!(chain
            .restore_speculative_processing_to_safe_bypass()
            .unwrap());
        let snapshot = chain.snapshot();
        assert_eq!(snapshot.revision, 9);
        assert!(snapshot.safe_bypass_active);
        assert_eq!(snapshot.latency_frames, 0);
        assert_eq!(snapshot.tail_frames, 0);
        assert_eq!(snapshot.fault_stream_frame, Some(37));
        let reported = chain.take_unreported_fault().unwrap();
        assert_eq!(reported.0, 9);
        assert_eq!(reported.1.processor_name, "one-shot-non-finite");
        assert_eq!(reported.2, 37);

        let mut bypassed = [0.5_f32, -0.5];
        chain.process_applied(format(), &mut bypassed, 41).unwrap();
        assert_eq!(bypassed, [0.5, -0.5]);
    }

    #[test]
    fn processor_failure_restores_input_and_latches_bypass() {
        let prepared = PreparedProcessorChain::prepare(
            7,
            format(),
            2,
            vec![Box::new(FaultingProcessor { non_finite: false })],
        )
        .unwrap();
        let mut chain = ProcessorChain::from_prepared(prepared);
        let mut first = vec![1.0, 2.0, 3.0, 4.0];
        chain.process(format(), &mut first, 0).unwrap();
        assert_eq!(first, vec![1.0, 2.0, 3.0, 4.0]);
        let reported = chain.take_unreported_fault().unwrap();
        assert_eq!(reported.0, 7);
        assert_eq!(reported.1.kind, ProcessorFaultKind::ProcessingFailed);
        assert_eq!(reported.2, 0);
        assert!(chain.take_unreported_fault().is_none());
        assert_eq!(
            chain.snapshot(),
            ProcessorChainSnapshot {
                revision: 7,
                pending_revision: None,
                applied_at_frame: 0,
                latency_frames: 0,
                tail_frames: 0,
                fault: Some(ProcessorFault {
                    processor_index: 0,
                    processor_name: "faulting",
                    kind: ProcessorFaultKind::ProcessingFailed,
                }),
                fault_stream_frame: Some(0),
                safe_bypass_active: true,
            }
        );
        let mut second = vec![5.0, 6.0];
        chain.process(format(), &mut second, 2).unwrap();
        assert_eq!(second, vec![5.0, 6.0]);

        chain.reset(ResetReason::Seek);
        assert!(chain.snapshot().safe_bypass_active);
        assert!(chain.snapshot().fault.is_some());
        let mut after_reset = vec![7.0, 8.0];
        chain.process(format(), &mut after_reset, 3).unwrap();
        assert_eq!(after_reset, vec![7.0, 8.0]);
    }

    #[test]
    fn newer_revision_exits_bypass_without_adopting_faulted_runtime_state() {
        struct StateProcessor {
            value: f32,
            fault: bool,
        }

        impl PcmProcessor for StateProcessor {
            fn name(&self) -> &'static str {
                "state"
            }
            fn adopt_runtime_state_from(&mut self, previous: &mut dyn PcmProcessor) -> bool {
                let Some(previous) = previous.as_any_mut().downcast_mut::<Self>() else {
                    return false;
                };
                self.value = previous.value;
                true
            }
            fn prepare(&mut self, _format: PcmFormat, _max_block_frames: usize) -> Result<()> {
                Ok(())
            }
            fn process(&mut self, block: PcmBlock<'_>) -> Result<()> {
                if self.fault {
                    self.value = 99.0;
                    return Err(EngineError::AudioBackend("test processor failed".into()));
                }
                block.interleaved.fill(self.value);
                Ok(())
            }
            fn reset(&mut self, _reason: ResetReason) {}
            fn latency_frames(&self) -> u32 {
                4
            }
            fn tail_frames(&self) -> u32 {
                6
            }
        }

        let active = PreparedProcessorChain::prepare(
            3,
            format(),
            1,
            vec![Box::new(StateProcessor {
                value: 1.0,
                fault: true,
            })],
        )
        .unwrap();
        let mut chain = ProcessorChain::from_prepared(active);
        let mut faulting = [0.25, -0.25];
        chain.process(format(), &mut faulting, 10).unwrap();
        assert!(chain.snapshot().safe_bypass_active);

        let next = PreparedProcessorChain::prepare(
            4,
            format(),
            1,
            vec![Box::new(StateProcessor {
                value: 2.0,
                fault: false,
            })],
        )
        .unwrap();
        chain.queue_prepared(next).unwrap();
        let mut recovered = [0.0, 0.0];
        chain.process(format(), &mut recovered, 11).unwrap();

        assert_eq!(recovered, [2.0, 2.0]);
        assert_eq!(chain.snapshot().revision, 4);
        assert_eq!(chain.snapshot().latency_frames, 4);
        assert_eq!(chain.snapshot().tail_frames, 6);
        assert!(chain.snapshot().fault.is_none());
        assert!(!chain.snapshot().safe_bypass_active);
    }

    #[test]
    fn non_finite_output_is_restored_and_reported() {
        let prepared = PreparedProcessorChain::prepare(
            8,
            format(),
            1,
            vec![Box::new(FaultingProcessor { non_finite: true })],
        )
        .unwrap();
        let mut chain = ProcessorChain::from_prepared(prepared);
        let mut samples = vec![-0.0_f32, 1.0];
        let bits = samples
            .iter()
            .map(|sample| sample.to_bits())
            .collect::<Vec<_>>();
        chain.process(format(), &mut samples, 0).unwrap();
        assert_eq!(
            samples
                .iter()
                .map(|sample| sample.to_bits())
                .collect::<Vec<_>>(),
            bits
        );
        assert_eq!(
            chain.snapshot().fault.unwrap().kind,
            ProcessorFaultKind::NonFiniteOutput
        );
    }

    #[test]
    fn active_chain_destruction_is_deferred_until_non_realtime_reclamation() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        struct DropProbe(Arc<AtomicUsize>);
        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        impl PcmProcessor for DropProbe {
            fn name(&self) -> &'static str {
                "drop_probe"
            }
            fn prepare(&mut self, _format: PcmFormat, _max_block_frames: usize) -> Result<()> {
                Ok(())
            }
            fn process(&mut self, _block: PcmBlock<'_>) -> Result<()> {
                Ok(())
            }
            fn reset(&mut self, _reason: ResetReason) {}
            fn latency_frames(&self) -> u32 {
                0
            }
            fn tail_frames(&self) -> u32 {
                0
            }
        }

        let drops = Arc::new(AtomicUsize::new(0));
        let active = PreparedProcessorChain::prepare(
            1,
            format(),
            1,
            vec![Box::new(DropProbe(Arc::clone(&drops)))],
        )
        .unwrap();
        let mut chain = ProcessorChain::from_prepared(active);
        let next = PreparedProcessorChain::prepare(2, format(), 1, Vec::new()).unwrap();
        chain.queue_prepared(next).unwrap();

        chain.process(format(), &mut [0.0, 0.0], 9).unwrap();
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        let retired = chain.reclaim_retired().unwrap();
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        drop(retired);
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn newest_prepared_revision_replaces_older_pending_before_one_boundary_swap() {
        let mut chain = ProcessorChain::bypass_only(format(), 1).unwrap();
        for revision in 1..=3 {
            let next = PreparedProcessorChain::prepare(revision, format(), 1, Vec::new()).unwrap();
            let superseded = chain.queue_prepared(next).unwrap();
            assert_eq!(
                superseded.map(|item| item.revision),
                (revision > 1).then_some(revision - 1)
            );
        }
        assert_eq!(chain.snapshot().revision, 0);
        assert_eq!(chain.snapshot().pending_revision, Some(3));

        chain.process(format(), &mut [], 17).unwrap();
        assert_eq!(chain.snapshot().revision, 0);
        chain.process(format(), &mut [0.0, 0.0], 17).unwrap();
        assert_eq!(chain.snapshot().revision, 3);
        assert_eq!(chain.snapshot().pending_revision, None);
        assert_eq!(chain.snapshot().applied_at_frame, 17);
    }

    #[test]
    fn standby_style_processing_never_consumes_pending_revision() {
        let mut chain = ProcessorChain::bypass_only(format(), 1).unwrap();
        let next = PreparedProcessorChain::prepare(4, format(), 1, Vec::new()).unwrap();
        chain.queue_prepared(next).unwrap();
        chain.process_applied(format(), &mut [0.0, 0.0], 0).unwrap();
        assert_eq!(chain.snapshot().revision, 0);
        assert_eq!(chain.snapshot().pending_revision, Some(4));
    }

    #[test]
    fn prepared_revision_activates_only_when_the_next_block_begins() {
        let mut chain = ProcessorChain::bypass_only(format(), 1).unwrap();
        let next = PreparedProcessorChain::prepare(9, format(), 1, Vec::new()).unwrap();
        assert!(chain.queue_prepared(next).unwrap().is_none());
        chain.process(format(), &mut [], 12).unwrap();
        assert_eq!(chain.snapshot().revision, 0);
        assert_eq!(chain.snapshot().pending_revision, Some(9));
        chain.process(format(), &mut [0.0, 0.0], 12).unwrap();
        assert_eq!(chain.snapshot().revision, 9);
        assert_eq!(chain.snapshot().pending_revision, None);
        assert_eq!(chain.snapshot().applied_at_frame, 12);
        assert!(chain.reclaim_retired().is_some());
        let stale = PreparedProcessorChain::prepare(9, format(), 1, Vec::new()).unwrap();
        assert!(chain.queue_prepared(stale).is_err());
        let older = PreparedProcessorChain::prepare(8, format(), 1, Vec::new()).unwrap();
        assert!(chain.queue_prepared(older).is_err());
    }
}
