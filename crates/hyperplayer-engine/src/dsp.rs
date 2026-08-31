use crate::error::Result;
use serde::{Deserialize, Serialize};

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

pub trait PcmProcessor: Send {
    fn name(&self) -> &'static str;
    fn process(&mut self, block: PcmBlock<'_>) -> Result<()>;
    fn reset(&mut self);
    fn latency_frames(&self) -> u32;
}

#[derive(Default)]
pub struct BypassProcessor;

impl PcmProcessor for BypassProcessor {
    fn name(&self) -> &'static str {
        "bypass"
    }

    fn process(&mut self, _block: PcmBlock<'_>) -> Result<()> {
        Ok(())
    }

    fn reset(&mut self) {}

    fn latency_frames(&self) -> u32 {
        0
    }
}

pub struct ProcessorChain {
    processors: Vec<Box<dyn PcmProcessor>>,
}

impl Default for ProcessorChain {
    fn default() -> Self {
        Self::bypass_only()
    }
}

impl ProcessorChain {
    pub fn bypass_only() -> Self {
        Self {
            processors: vec![Box::new(BypassProcessor)],
        }
    }

    pub fn process(&mut self, format: PcmFormat, samples: &mut [f32]) -> Result<()> {
        for processor in &mut self.processors {
            processor.process(PcmBlock {
                format,
                interleaved: samples,
            })?;
        }
        Ok(())
    }

    pub fn total_latency_frames(&self) -> u32 {
        self.processors
            .iter()
            .map(|processor| processor.latency_frames())
            .sum()
    }

    pub fn reset(&mut self) {
        for processor in &mut self.processors {
            processor.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bypass_is_bit_transparent_and_has_no_latency() {
        let original = vec![-1.0, -0.25, 0.0, 0.75, 1.0];
        let mut samples = original.clone();
        let mut chain = ProcessorChain::bypass_only();
        chain
            .process(
                PcmFormat {
                    sample_rate: 48_000,
                    channels: 2,
                    sample_format: PcmSampleFormat::F32,
                },
                &mut samples,
            )
            .unwrap();
        assert_eq!(samples, original);
        assert_eq!(chain.total_latency_frames(), 0);
    }
}
