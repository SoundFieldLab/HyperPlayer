//! HSE Stage 20 Modulation / Master Targets 冻结向量对拍：共享根目录
//! `tests/fixtures/dsp/` 下的 4 条 modulation-matrix v1.5.1 官方向量
//! （commit f7017621b7d84005fbfed8a3c42a119487a17326）。
//!
//! 两条对拍线：
//! 1. **核心模块逐字回放**（全部 4 条）：冻结向量是 TS `ModulationMatrix`
//!    的语义（推进矩阵 + masterGain 逐样本乘；stereoWidth 产物不入向量，
//!    specs/dsp/modulation-matrix.md §4.4）——用核心参数直接构造
//!    `ModulationMatrixStage`（含 `offset` 路由，case2），与
//!    `dsp_parity_limiter.rs` 同范式；
//! 2. **适配器冻结对拍**（case1）：case1 路由（lfo→masterGain amount 0.5、
//!    无 offset）可经受限 typed schema 表达且 stereoWidth 恒 1（宽度路径
//!    跳过），因此 `ModulationProcessor` 必须与冻结期望一致。case2 携带
//!    schema 不暴露的 `offset`、case3/case4 含 stereoWidth 路由（适配器的
//!    HyperPlayer 宽度应用扩展），不在适配器对拍域内——适配器行为由
//!    `dsp_algorithms/modulation.rs` 内嵌的组合逐位测试覆盖。
//!
//! 注意：`dsp_parity.rs` 的共享目录计数断言（76）需在中央集成时同步上调
//! （+4 条 modulation-matrix 向量）；本文件按文件名前缀独立过滤，不依赖该计数。

use hse_core::modulation_matrix::{ModSource, ModTarget, ModulationMatrixStage, ModulationRoute};
use hse_core::Stage as HseStage;
use hyperplayer_engine::dsp::{PcmBlock, PcmFormat, PcmProcessor, PcmSampleFormat};
use hyperplayer_engine::dsp_algorithms::modulation::{
    ModLfoShape, ModRouteSettings, ModRouteSource, ModRouteTarget, ModulationProcessor,
    ModulationSettings,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorMeta {
    schema_version: u32,
    module: String,
    case: String,
    sample_rate: u32,
    block_size: usize,
    channels: u16,
    frames: usize,
    params: Value,
    tolerance: Tolerance,
    source: VectorSource,
}

#[derive(Deserialize)]
struct VectorSource {
    project: String,
    version: String,
    commit: String,
}

#[derive(Deserialize)]
struct Tolerance {
    kind: String,
    value: f64,
    floor: f64,
}

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("tests/fixtures/dsp")
}

fn number(params: &Value, field: &str) -> f64 {
    params[field]
        .as_f64()
        .unwrap_or_else(|| panic!("{field} must be numeric"))
}

fn core_route(value: &Value) -> ModulationRoute {
    ModulationRoute {
        source: match value["source"].as_str().expect("route.source") {
            "lfo" => ModSource::Lfo,
            "envelope" => ModSource::Envelope,
            other => panic!("unsupported route source {other}"),
        },
        target: match value["target"].as_str().expect("route.target") {
            "masterGain" => ModTarget::MasterGain,
            "stereoWidth" => ModTarget::StereoWidth,
            other => panic!("unsupported route target {other}"),
        },
        amount: number(value, "amount"),
        offset: value.get("offset").and_then(Value::as_f64).unwrap_or(0.0),
    }
}

/// 核心 TS 语义驱动器：推进矩阵 + masterGain 逐样本乘（stereoWidth 不入
/// 音频路径，与冻结向量导出驱动器一致）。
struct VectorModulationMatrix {
    inner: ModulationMatrixStage,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl PcmProcessor for VectorModulationMatrix {
    fn name(&self) -> &'static str {
        "modulation-matrix-vector-driver"
    }

    fn prepare(
        &mut self,
        format: PcmFormat,
        max_block_frames: usize,
    ) -> hyperplayer_engine::Result<()> {
        if format.channels != 2 {
            return Err(hyperplayer_engine::EngineError::Unsupported(
                "modulation vectors require stereo".into(),
            ));
        }
        self.left.resize(max_block_frames, 0.0);
        self.right.resize(max_block_frames, 0.0);
        Ok(())
    }

    fn process(&mut self, block: PcmBlock<'_>) -> hyperplayer_engine::Result<()> {
        let frames = block.interleaved.len() / 2;
        for (index, frame) in block.interleaved.as_chunks::<2>().0.iter().enumerate() {
            self.left[index] = frame[0];
            self.right[index] = frame[1];
        }
        let targets = self
            .inner
            .process_block(&self.left[..frames], &self.right[..frames]);
        let gain = targets.master_gain;
        if gain != 1.0 {
            for i in 0..frames {
                self.left[i] = (f64::from(self.left[i]) * gain) as f32;
                self.right[i] = (f64::from(self.right[i]) * gain) as f32;
            }
        }
        for (index, frame) in block
            .interleaved
            .as_chunks_mut::<2>()
            .0
            .iter_mut()
            .enumerate()
        {
            frame[0] = self.left[index];
            frame[1] = self.right[index];
        }
        Ok(())
    }

    fn reset(&mut self, _reason: hyperplayer_engine::dsp::ResetReason) {
        self.inner.reset();
    }

    fn latency_frames(&self) -> u32 {
        0
    }

    fn tail_frames(&self) -> u32 {
        0
    }
}

fn core_driver(meta: &VectorMeta) -> VectorModulationMatrix {
    let routes = meta.params["routes"]
        .as_array()
        .expect("routes must be an array")
        .iter()
        .map(core_route)
        .collect::<Vec<_>>();
    let lfo = &meta.params["lfo"];
    let envelope = &meta.params["envelope"];
    let mut inner = ModulationMatrixStage::new(f64::from(meta.sample_rate)).unwrap();
    inner.set_routes(routes);
    inner.set_lfo_params(hse_core::modulation_matrix::LfoParams {
        shape: hse_core::modulation_matrix::LfoShape::parse(
            lfo["shape"].as_str().unwrap_or("sine"),
        ),
        rate_hz: number(lfo, "rateHz"),
        depth: number(lfo, "depth"),
    });
    inner.set_envelope_params(hse_core::modulation_matrix::EnvelopeParams {
        attack_ms: number(envelope, "attackMs"),
        release_ms: number(envelope, "releaseMs"),
        amount: number(envelope, "amount"),
    });
    VectorModulationMatrix {
        inner,
        left: Vec::new(),
        right: Vec::new(),
    }
}

/// 适配器对拍（仅限可经受限 schema 表达且宽度路径不激活的向量）。
fn adapter_driver(meta: &VectorMeta) -> Option<ModulationProcessor> {
    let mut routes = Vec::new();
    for value in meta.params["routes"].as_array()?.iter() {
        let has_offset = value.get("offset").and_then(Value::as_f64).unwrap_or(0.0) != 0.0;
        let target = match value["target"].as_str().expect("route.target") {
            "masterGain" => ModRouteTarget::MasterGain,
            "stereoWidth" => ModRouteTarget::StereoWidth,
            other => panic!("unsupported route target {other}"),
        };
        if has_offset || target == ModRouteTarget::StereoWidth {
            // offset 不在受限 schema 内；stereoWidth 路由激活适配器的
            // HyperPlayer 宽度应用扩展——两者都超出冻结向量语义域。
            return None;
        }
        routes.push(ModRouteSettings {
            source: ModRouteSource::parse_str(value["source"].as_str().expect("route.source"))
                .expect("frozen vectors only carry whitelisted sources"),
            target,
            depth: number(value, "amount"),
            polarity: 1.0,
            smoothing_ms: 0.0,
        });
    }
    let lfo = &meta.params["lfo"];
    let envelope = &meta.params["envelope"];
    Some(
        ModulationProcessor::new(
            f64::from(meta.sample_rate),
            ModulationSettings {
                enabled: true,
                lfo_shape: ModLfoShape::parse_str(lfo["shape"].as_str().unwrap_or("sine"))
                    .expect("frozen vectors only carry whitelisted shapes"),
                lfo_rate_hz: number(lfo, "rateHz"),
                lfo_depth: number(lfo, "depth"),
                envelope_attack_ms: number(envelope, "attackMs"),
                envelope_release_ms: number(envelope, "releaseMs"),
                envelope_amount: number(envelope, "amount"),
                routes,
            },
        )
        .unwrap(),
    )
}

fn read_segments(path: &Path, frames: usize) -> [Vec<f32>; 4] {
    let bytes = fs::read(path).unwrap();
    assert_eq!(bytes.len(), frames * 4 * size_of::<f32>());
    let samples = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect::<Vec<_>>();
    std::array::from_fn(|segment| {
        let start = segment * frames;
        samples[start..start + frames].to_vec()
    })
}

fn assert_close(
    label: &str,
    channel: &str,
    actual: &[f32],
    expected: &[f32],
    tolerance: &Tolerance,
) {
    for (index, (&actual, &expected)) in actual.iter().zip(expected).enumerate() {
        assert!(
            actual.is_finite(),
            "{label} {channel}[{index}] is not finite"
        );
        let bound = tolerance.value * f64::from(expected).abs().max(tolerance.floor);
        let difference = (f64::from(actual) - f64::from(expected)).abs();
        assert!(
            difference <= bound,
            "{label} {channel}[{index}]: got {actual}, want {expected}, diff {difference}, bound {bound}"
        );
    }
}

fn replay(
    meta: &VectorMeta,
    mut processor: Box<dyn PcmProcessor>,
    label: &str,
    tolerance: &Tolerance,
) {
    let format = PcmFormat {
        sample_rate: meta.sample_rate,
        channels: meta.channels,
        sample_format: PcmSampleFormat::F32,
    };
    processor.prepare(format, meta.block_size).unwrap();
    let segments = read_segments(
        &fixture_root().join(format!("{}.{}.f32", meta.module, meta.case)),
        meta.frames,
    );
    let [input_left, input_right, expected_left, expected_right] = segments;
    let mut interleaved = input_left
        .iter()
        .zip(&input_right)
        .flat_map(|(&left, &right)| [left, right])
        .collect::<Vec<_>>();
    for chunk in interleaved.chunks_mut(meta.block_size * 2) {
        processor
            .process(PcmBlock {
                format,
                interleaved: chunk,
            })
            .unwrap();
    }
    let actual_left = interleaved.iter().step_by(2).copied().collect::<Vec<_>>();
    let actual_right = interleaved
        .iter()
        .skip(1)
        .step_by(2)
        .copied()
        .collect::<Vec<_>>();
    assert_close(label, "L", &actual_left, &expected_left, tolerance);
    assert_close(label, "R", &actual_right, &expected_right, tolerance);
}

#[test]
fn modulation_matrix_matches_frozen_stage20_vectors() {
    let root = fixture_root();
    let mut json_paths = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|stem| stem.starts_with("modulation-matrix."))
                && path.extension().and_then(|value| value.to_str()) == Some("json")
        })
        .collect::<Vec<_>>();
    json_paths.sort();
    assert_eq!(
        json_paths
            .iter()
            .map(|path| path.file_stem().unwrap().to_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        [
            "modulation-matrix.case1",
            "modulation-matrix.case2",
            "modulation-matrix.case3",
            "modulation-matrix.case4",
        ]
    );

    for json_path in json_paths {
        let meta: VectorMeta = serde_json::from_slice(&fs::read(&json_path).unwrap()).unwrap();
        assert_eq!(meta.schema_version, 1);
        assert_eq!(meta.module, "modulation-matrix");
        assert_eq!(meta.channels, 2);
        assert!(meta.frames > 0 && meta.block_size > 0);
        assert_eq!(meta.tolerance.kind, "relative");
        assert_eq!(meta.source.project, "HyperSoundEngine");
        assert_eq!(meta.source.version, "1.5.1");
        assert_eq!(
            meta.source.commit,
            "f7017621b7d84005fbfed8a3c42a119487a17326"
        );
        let label = format!("{}.{}", meta.module, meta.case);
        assert_eq!(
            json_path.file_stem().and_then(|value| value.to_str()),
            Some(label.as_str())
        );

        // 线 1：核心模块逐字回放（全部 4 条，含 offset 路由）。
        replay(&meta, Box::new(core_driver(&meta)), &label, &meta.tolerance);

        // 线 2：适配器对拍（仅 case1 在语义域内；其余跳过）。
        if let Some(adapter) = adapter_driver(&meta) {
            replay(
                &meta,
                Box::new(adapter),
                &format!("{label} [adapter]"),
                &meta.tolerance,
            );
        }
    }
}
