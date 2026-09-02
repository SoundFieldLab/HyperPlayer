//! HSE Stage 13 Reverb 冻结向量对拍（reverb-simple / fdn-reverb / convolver）。
//!
//! 冻结向量来源：HSE v1.5.1（commit `f7017621b7d84005fbfed8a3c42a119487a17326`）
//! `specs/dsp/vectors`，已 stamp 溯源后落盘 `tests/fixtures/dsp-reverb/`（与
//! `tests/fixtures/dsp` 的共享向量同一出处）。本文件独立于共享的 `dsp_parity.rs`
//! ——reverb 尚未注册进共享测试时在此先行对拍；注册后共享侧可直接复用这些文件。
//!
//! `.f32` 布局（与 dsp_parity 一致）：`[输入L | 输入R | 期望L | 期望R]` 四段、
//! 每段 `frames` 个 f32 LE。驱动方式：按 `blockSize` 分块喂入核心 stage。
//!
//! 集成后向量已并入共享根目录 `tests/fixtures/dsp/`（reverb-simple / fdn-reverb /
//! convolver 模块名平铺，不与既有模块冲突）；本文件保留为独立对拍，共享
//! `dsp_parity.rs` 通过适配器复用同一批向量。

use hse_core::convolver::{build_ir_recipe, ConvolverOptions, ConvolverStage, IrRecipe};
use hse_core::fdn_reverb::{FdnReverbParams, FdnReverbStage};
use hse_core::reverb_simple::{ReverbSimpleParams, ReverbSimpleStage};
use hse_core::Stage as HseStage;
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

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

fn read_segments(path: &Path, frames: usize) -> [Vec<f32>; 4] {
    let bytes = fs::read(path).unwrap();
    assert_eq!(bytes.len(), frames * 4 * std::mem::size_of::<f32>());
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

fn algorithmic_params(params: &Value) -> ReverbSimpleParams {
    ReverbSimpleParams {
        room_size: number(params, "roomSize"),
        damping: number(params, "damping"),
        wet: number(params, "wet"),
        dry: number(params, "dry"),
        pre_delay_ms: number(params, "preDelayMs"),
        width: number(params, "width"),
        reverb_type: params["type"].as_str().expect("type").to_string(),
    }
}

fn fdn_params(params: &Value) -> FdnReverbParams {
    let shared = algorithmic_params(params);
    FdnReverbParams {
        room_size: shared.room_size,
        damping: shared.damping,
        wet: shared.wet,
        dry: shared.dry,
        pre_delay_ms: shared.pre_delay_ms,
        width: shared.width,
        reverb_type: shared.reverb_type,
        lines: Some(number(params, "lines")),
    }
}

fn convolver_recipe(ir: &Value) -> IrRecipe {
    match ir["kind"].as_str().expect("ir.kind") {
        "delta" => IrRecipe::Delta {
            delay: number(ir, "delay"),
        },
        "expNoise" => IrRecipe::ExpNoise {
            length: number(ir, "length"),
            seed: ir["seed"].as_u64().expect("ir.seed") as u32,
            decay: number(ir, "decay"),
            amp: number(ir, "amp"),
        },
        other => panic!("unsupported ir recipe kind {other}"),
    }
}

#[test]
fn hse_stage_13_reverb_matches_frozen_vectors() {
    let root = fixture_root();
    let mut json_paths = fs::read_dir(&root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .is_some_and(|stem| {
                    stem.starts_with("reverb-simple.")
                        || stem.starts_with("fdn-reverb.")
                        || stem.starts_with("convolver.")
                })
                && path.extension().and_then(|value| value.to_str()) == Some("json")
        })
        .collect::<Vec<_>>();
    json_paths.sort();
    assert_eq!(
        json_paths.len(),
        11,
        "reverb-simple(3) + fdn-reverb(4) + convolver(4) = 11 frozen vectors"
    );

    for json_path in json_paths {
        let meta: VectorMeta = serde_json::from_slice(&fs::read(&json_path).unwrap()).unwrap();
        assert_eq!(meta.schema_version, 1);
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

        let segments = read_segments(&json_path.with_extension("f32"), meta.frames);
        let [input_left, input_right, expected_left, expected_right] = segments;
        let mut interleaved = input_left
            .iter()
            .zip(&input_right)
            .flat_map(|(&left, &right)| [left, right])
            .collect::<Vec<_>>();
        let sample_rate = f64::from(meta.sample_rate);
        match meta.module.as_str() {
            "reverb-simple" => {
                let mut stage =
                    ReverbSimpleStage::from_params(sample_rate, algorithmic_params(&meta.params))
                        .unwrap();
                drive(&mut stage, &mut interleaved, &meta);
            }
            "fdn-reverb" => {
                let mut stage =
                    FdnReverbStage::from_params(sample_rate, fdn_params(&meta.params)).unwrap();
                drive(&mut stage, &mut interleaved, &meta);
            }
            "convolver" => {
                let mut stage = ConvolverStage::new(
                    sample_rate,
                    ConvolverOptions {
                        partition_size: number(&meta.params, "partitionSize"),
                        long_partition_size: number(&meta.params, "longPartitionSize"),
                        short_region_ms: number(&meta.params, "shortRegionMs"),
                        de_periodize: meta.params["dePeriodize"].as_bool().unwrap(),
                    },
                )
                .unwrap();
                let ir = build_ir_recipe(&convolver_recipe(&meta.params["ir"])).unwrap();
                stage.load_ir(&ir, None).unwrap();
                stage.set_mix(number(&meta.params, "mix"));
                stage.set_pre_delay_ms(number(&meta.params, "preDelayMs"));
                drive(&mut stage, &mut interleaved, &meta);
            }
            other => panic!("unsupported reverb vector module {other}"),
        }

        let actual_left = interleaved.iter().step_by(2).copied().collect::<Vec<_>>();
        let actual_right = interleaved
            .iter()
            .skip(1)
            .step_by(2)
            .copied()
            .collect::<Vec<_>>();
        assert_close(&label, "L", &actual_left, &expected_left, &meta.tolerance);
        assert_close(&label, "R", &actual_right, &expected_right, &meta.tolerance);
    }
}

fn drive(stage: &mut dyn HseStage, interleaved: &mut [f32], meta: &VectorMeta) {
    stage.prepare(meta.block_size);
    let frames = interleaved.len() / 2;
    // HseStage 是平面 L/R 契约：先解交错，按 blockSize 分块处理，再交错回写。
    let mut left: Vec<f32> = interleaved.iter().step_by(2).copied().collect();
    let mut right: Vec<f32> = interleaved.iter().skip(1).step_by(2).copied().collect();
    for start in (0..frames).step_by(meta.block_size) {
        let end = (start + meta.block_size).min(frames);
        stage.process(&mut left[start..end], &mut right[start..end]);
    }
    for (index, value) in left.into_iter().enumerate() {
        interleaved[index * 2] = value;
    }
    for (index, value) in right.into_iter().enumerate() {
        interleaved[index * 2 + 1] = value;
    }
}
