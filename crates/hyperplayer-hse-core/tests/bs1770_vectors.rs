//! BS.1770-5 解析向量认证（±0.1 LU）——`MeterMode::ItuBs1770_5` 标准路径认证测试。
//!
//! 合规表述边界：本文件只宣称「BS.1770-5 解析向量认证（±0.1 LU）」。**未使用、未分发
//! 官方 EBU Tech 3341/3342 测试文件**（有版权限制，不得随仓库分发）；官方测试集验证
//! 仍开放，任何场合不得写「已通过 EBU 认证」。
//!
//! 所有测试信号为解析参考向量（analytic reference vectors）：由确定性公式生成的
//! 997 Hz 正弦 / LCG 伪噪声，参考值按 ITU-R BS.1770-5 的定义逐步推导（见各常量与
//! 测试内注释），非拍脑袋锚点，非实现输出回填。
//!
//! ## 参考值推导总纲
//!
//! BS.1770-5 单值响度：`L = -0.691 + 10·log10(Σ_i G_i·z_i)`，z_i 为通道 i 经 K 加权后
//! 的平均功率（均方值），2.0 声道权重 G_L = G_R = 1.0。K 加权 = RLB 高通
//! （f0 = 38.135822 Hz, Q = 0.5）级联高频搁架（f0 ≈ 1681.974 Hz, +3.9998 dB,
//! Q ≈ 0.7072）。峰值 A 的正弦平均功率 = A²/2，故稳态同相立体声正弦：
//!
//! ```text
//! L(A) = -0.691 + 10·log10(2 · G997² · A²/2) = -0.691 + 20·log10(G997·A)
//! ```
//!
//! G997 由标准双二阶的解析频响数值求出（复刻本 crate 系数公式，w = 2πf/fs 代入
//! |H(e^jw)|），并与既有 TS golden（`src/lufs_meter.rs` golden A：-20 dBFS 同相
//! 997 Hz 稳态 -17.032996 = 锚点 + 10·log10(2)，见 V6）交叉验证一致：
//!
//! - 48 kHz：G997 = 1.07742037588（+0.6477036909 dB）→ 净偏置 -0.691 + 0.6477 = **-0.0432963 LU**
//! - 44.1 kHz：G997 = 1.07728893224（+0.6466439610 dB）→ 净偏置 **-0.0443560 LU**
//!
//! 因此每声道 A dBFS 的同相立体声正弦读数 ≈ A - 0.0433 LU（997 Hz 的 K 权重增益
//! +0.6477 dB 被标准校准常数 -0.691 基本抵消）：每声道 0 dBFS → **-0.0433 LUFS**，
//! 每声道 -20 dBFS → **-20.0433 LUFS**，每声道 -23 dBFS → **-23.0433 LUFS**
//! （落在 EBU R128 官方锚点「-23.0 ± 0.1 LU」内）。
//!
//! 注意 folk 锚点「满刻度立体声正弦 = -3.01 LUFS」按标准推导不成立：-3.01 量级只
//! 出现在**单声道馈入**（仅 L 有信号，Σ = G997²·A²/2，比双声道低 10·log10(2)），
//! 见 V2。

use hse_core::lufs_meter::{LufsMeter, MeterMode};
use std::f64::consts::PI;

// ---------------- 解析参考常量（推导见模块注释） ----------------

/// 标准 K 加权在 997 Hz / 48 kHz 的解析增益（线性）。
const G997_48K: f64 = 1.077_420_375_88;
/// 标准 K 加权在 997 Hz / 44.1 kHz 的解析增益（线性）。
const G997_44K1: f64 = 1.077_288_932_24;
/// 标准校准常数（BS.1770 §单值响度）。
const CAL_OFFSET_DB: f64 = -0.691;
/// 10·log10(2) = 3.0102999566：双同相通道（功率加倍）相对单声道馈入的响度差，
/// 也是 HseV151 波形和相对标准功率和在完全相关内容上的偏差。
const POWER_OF_TWO_DB: f64 = 3.010_299_956_6;

/// 净偏置 = -0.691 + 20·log10(G997)：48 kHz 下 = -0.0432963 LU，
/// 44.1 kHz 下 = -0.0443560 LU（K 权重 997 Hz 增益被校准常数基本抵消）。
fn net_offset(g997: f64) -> f64 {
    CAL_OFFSET_DB + 20.0 * g997.log10()
}

/// 同相立体声正弦（每声道 `dbfs` dBFS 峰值）的稳态期望（LUFS）。
fn stereo_anchor(dbfs: f64, g997: f64) -> f64 {
    net_offset(g997) + dbfs
}

/// 48 kHz 锚点便捷封装。
fn stereo_anchor_48k(dbfs: f64) -> f64 {
    stereo_anchor(dbfs, G997_48K)
}

// ---------------- 确定性信号生成 ----------------

/// 纯正弦（f64 双精度计算后一次 f32 落盘，与既有 golden 信号同族）。
fn sine(frames: usize, sample_rate: f64, freq: f64, amp: f64, phase: f64) -> Vec<f32> {
    (0..frames)
        .map(|i| (amp * ((2.0 * PI * freq * i as f64) / sample_rate + phase).sin()) as f32)
        .collect()
}

/// 固定种子 LCG 伪噪声（与既有单元测试同族，整数运算跨平台逐位一致）。
fn lcg_noise(frames: usize, seed: u32, amp: f64) -> Vec<f32> {
    let mut s = seed;
    (0..frames)
        .map(|_| {
            s = s.wrapping_mul(1664525).wrapping_add(1013904223);
            (((f64::from(s) / 4_294_967_296.0) * 2.0 - 1.0) * amp) as f32
        })
        .collect()
}

/// 按 blockSize 分块馈入（末块可短）。
fn feed(meter: &mut LufsMeter, l: &[f32], r: &[f32], block_size: usize) {
    let mut offset = 0;
    while offset < l.len() {
        let len = (l.len() - offset).min(block_size);
        meter.process_stereo(&l[offset..offset + len], &r[offset..offset + len]);
        offset += len;
    }
}

/// 解析期望断言（有限值绝对容差；容差与偏差预算写在各断言处）。
fn assert_within(got: f64, want: f64, tol: f64, label: &str) {
    assert!(
        (got - want).abs() <= tol,
        "{label}：got {got}，want {want}，|dev| = {} 超出容差 {tol}",
        (got - want).abs()
    );
}

/// 构造标准模式仪表（48 kHz）。
fn std_meter_48k() -> LufsMeter {
    LufsMeter::with_mode(48_000.0, MeterMode::ItuBs1770_5).expect("合法采样率")
}

// ---------------- V1：电平锚点 ----------------

/// 电平锚点：同相立体声 997 Hz 正弦，每声道 0 / -20 / -23 dBFS。
///
/// 期望 = 净偏置 + 每声道 dBFS（推导见模块注释）；功率随幅度平方缩放，
/// 三个电平依次严格相差 20 LU 亦为断言项。2 s 稳态信号的滤波暂态偏差
/// 由既有 golden A 实测 ≈ 0.00003 LU，容差 0.02 LU 覆盖充分。
/// -23 dBFS 用例同时核对 EBU R128 官方锚点带（-23.0 ± 0.1 LU）。
#[test]
fn v1_电平锚点_立体声同相997hz_三电平() {
    let fs = 48_000.0;
    for dbfs in [0.0, -20.0, -23.0] {
        let expected = stereo_anchor_48k(dbfs);
        let amp = 10.0_f64.powf(dbfs / 20.0);
        let l = sine(96_000, fs, 997.0, amp, 0.0);
        let r = sine(96_000, fs, 997.0, amp, 0.0);
        let mut meter = std_meter_48k();
        feed(&mut meter, &l, &r, 777);
        let integrated = meter.get_integrated_lufs();
        assert_within(integrated, expected, 0.02, &format!("V1 {dbfs} dBFS integrated"));
        // momentary 为最后一个完整 400ms 块，稳态下与 integrated 同值。
        assert_within(
            meter.get_momentary_lufs(),
            expected,
            0.02,
            &format!("V1 {dbfs} dBFS momentary"),
        );
        if dbfs == -23.0 {
            // 官方锚点带：EBU R128 对齐电平（解析值 -23.0433，必须落在 -23.0 ± 0.1 内）。
            assert_within(integrated, -23.0, 0.1, "V1 官方锚点带 -23.0 ± 0.1 LU");
        }
    }
    // 功率随幅度平方缩放：任意两电平读数严格差 20 LU。
    let at = |dbfs: f64| {
        let amp = 10.0_f64.powf(dbfs / 20.0);
        let l = sine(96_000, fs, 997.0, amp, 0.0);
        let mut meter = std_meter_48k();
        feed(&mut meter, &l, &l, 777);
        meter.get_integrated_lufs()
    };
    assert_within(at(-20.0) - at(0.0), -20.0, 0.02, "V1 幅度平方缩放 -20 LU");
    assert_within(at(-23.0) - at(-20.0), -3.0, 0.02, "V1 幅度平方缩放 -3 LU");
}

/// 电平锚点（44.1 kHz 精确系数路径）：G997@44.1k = 1.07728893224
/// （+0.6466440 dB）→ 净偏置 -0.0443560；-20 dBFS/声道 → -20.0443560 LUFS。
#[test]
fn v1b_电平锚点_44k1精确系数路径() {
    let fs = 44_100.0;
    let expected = stereo_anchor(-20.0, G997_44K1);
    let amp = 10.0_f64.powf(-20.0 / 20.0);
    let l = sine(88_200, fs, 997.0, amp, 0.0);
    let r = sine(88_200, fs, 997.0, amp, 0.0);
    let mut meter = LufsMeter::with_mode(fs, MeterMode::ItuBs1770_5).expect("合法采样率");
    feed(&mut meter, &l, &r, 500);
    assert_within(meter.get_integrated_lufs(), expected, 0.02, "V1b 44.1kHz integrated");
}

// ---------------- V2：单声道 vs 立体声（通道权重与功率和语义） ----------------

/// 通道功率和语义：2.0 权重表 G_L = G_R = 1.0，无波形交叉项。
///
/// 推导（A = -20 dBFS 峰值/声道）：
/// - 双声道同相（dual-mono）：Σ = 2·(G997²·A²/2) = G997²·A² → -20.0433 LUFS；
/// - 单声道馈入（仅 L，R 静音）：Σ = G997²·A²/2 → -20.0433 - 3.0103 = -23.0536 LUFS；
/// - 两者严格差 10·log10(2) = 3.0103 LU（两条同相通道功率加倍），这同时验证
///   标准语义下「波形和」不会被采用（波形和对同相内容同样 +3.01 LU，见 V6）。
#[test]
fn v2_通道功率和语义_dual_mono与单声道馈入差3点01() {
    let fs = 48_000.0;
    let amp = 10.0_f64.powf(-20.0 / 20.0);
    let dual = sine(96_000, fs, 997.0, amp, 0.0);
    let silent = vec![0.0_f32; 96_000];

    let mut both = std_meter_48k();
    feed(&mut both, &dual, &dual, 777);
    let dual_loudness = both.get_integrated_lufs();
    assert_within(dual_loudness, stereo_anchor_48k(-20.0), 0.02, "V2 dual-mono");

    let mut single = std_meter_48k();
    feed(&mut single, &dual, &silent, 777);
    let single_loudness = single.get_integrated_lufs();
    assert_within(
        single_loudness,
        stereo_anchor_48k(-20.0) - POWER_OF_TWO_DB,
        0.02,
        "V2 单声道馈入（Σ 减半 → -3.0103 LU）",
    );

    assert_within(
        dual_loudness - single_loudness,
        POWER_OF_TWO_DB,
        0.02,
        "V2 dual-mono − 单声道 = 10·log10(2)",
    );
}

// ---------------- V3：gating ----------------

/// 绝对门 -70 LUFS：响段 + 纯静音段，静音块（p ≤ 1e-30 → NaN）不进门限统计。
///
/// 推导：响段 -20 dBFS 997 Hz 12 s（117 个全响窗）+ 数字静音 2 s。剪切点落在
/// 100ms 步进网格上，跨越边界的 4 个 400ms 窗功率为 0.75/0.5/0.25/0 倍稳态功率
/// （正弦周期 ≈ 1.003 ms，窗内均值对时间分数的偏离 < 0.1%）；纯静音窗记 NaN，
/// 剪切后的 K 加权拖尾窗（响度 ≈ -43 LU 量级）被相对门剔除。故 gated 功率均值 =
/// (117 + 1.5)·P / 120，期望 integrated ≈ 锚点 - 0.055 LU。容差 0.1 LU。
#[test]
fn v3a_gating_绝对门_响段加纯静音段() {
    let fs = 48_000.0;
    let amp = 10.0_f64.powf(-20.0 / 20.0);
    let loud = sine(576_000, fs, 997.0, amp, 0.0); // 12 s
    let silence = vec![0.0_f32; 96_000]; // 2 s
    let mut l = loud;
    let mut r = l.clone();
    l.extend_from_slice(&silence);
    r.extend_from_slice(&silence);

    let mut meter = std_meter_48k();
    feed(&mut meter, &l, &r, 1024);
    let integrated = meter.get_integrated_lufs();
    assert_within(integrated, stereo_anchor_48k(-20.0), 0.1, "V3a integrated 贴响段电平");
    // 方向性对照：若无绝对门剔除（把静音功率并入），读数会显著低于响段电平。
    assert!(integrated > -20.5, "V3a 静音段必须被门限剔除：{integrated}");
}

/// 相对门（gated mean -10 LU）：低电平段低于门 → 剔除；高于门 → 纳入。
///
/// 推导（响段 -20 dBFS 12 s + 低电平段 -45 dBFS 3 s）：过绝对门块的响度均值
/// = [117·(-20.0433) 加 3 个边界部分窗（-21.29/-23.05/-26.05）加 27·(-45.046)]
/// 除以 147 ≈ -24.71 → 相对门 ≈ -34.71；-45.05 低出门 10 LU（余量远大于块间
/// 波纹）→ 低电平段被第二道门剔除，integrated ≈ 锚点 - 0.055（边界窗修正，
/// 同 V3a），容差 0.1 LU。若不剔除，方向性对照断言排除该情形。
///
/// 对照组（响段 12 s + -25 dBFS 段 3 s）：块功率 P = G997²·A²（注意由响度反推
/// 功率须补偿 +0.691 常数：P = 10^((L+0.691)/10)）。P20 = G997²·10^-2、
/// P25 = G997²·10^-2.5。门下全部 147 块纳入（-25.05 > 门 -31.03），gated 功率
/// 均值 = [(117 加 1.5)·P20 加 27·P25]/147（1.5 = 三个 0.75/0.5/0.25 边界部分窗）
/// → 期望 ≈ -20.677 LUFS，容差 0.05 LU。读数必须明显低于纯响段（≈ -20.10）
/// 以证明低电平段被纳入。
#[test]
fn v3b_gating_相对门_低电平段剔除与纳入对照() {
    let fs = 48_000.0;
    let loud_amp = 10.0_f64.powf(-20.0 / 20.0);
    let loud = sine(576_000, fs, 997.0, loud_amp, 0.0); // 12 s

    // (a) -45 dBFS（低于相对门 10 LU）→ 剔除
    let quiet_amp = 10.0_f64.powf(-45.0 / 20.0);
    let quiet = sine(144_000, fs, 997.0, quiet_amp, 0.0); // 3 s
    let mut l = loud.clone();
    let mut r = l.clone();
    l.extend_from_slice(&quiet);
    r.extend_from_slice(&quiet);
    let mut meter = std_meter_48k();
    feed(&mut meter, &l, &r, 1024);
    let integrated = meter.get_integrated_lufs();
    assert_within(integrated, stereo_anchor_48k(-20.0), 0.1, "V3b(a) 低电平段被剔除");
    // 方向性对照：若低电平段未被剔除，读数 ≈ -25.3，远低于该界。
    assert!(integrated > -20.6, "V3b(a) 相对门必须剔除 -45 dBFS 段：{integrated}");

    // (b) -25 dBFS（高于相对门）→ 纳入，读数为两段功率均值
    let quiet_amp = 10.0_f64.powf(-25.0 / 20.0);
    let quiet = sine(144_000, fs, 997.0, quiet_amp, 0.0);
    let mut l = loud.clone();
    let mut r = l.clone();
    l.extend_from_slice(&quiet);
    r.extend_from_slice(&quiet);
    let mut meter = std_meter_48k();
    feed(&mut meter, &l, &r, 1024);
    // 块功率 P = G997²·A²；117 全响块 + 1.5 等效响块（三个边界部分窗）+ 27 全低电平块。
    let p20 = G997_48K * G997_48K * 10.0_f64.powf(-2.0);
    let p25 = G997_48K * G997_48K * 10.0_f64.powf(-2.5);
    let expected = -0.691 + 10.0 * (((117.0 + 1.5) * p20 + 27.0 * p25) / 147.0).log10();
    let integrated = meter.get_integrated_lufs();
    assert_within(integrated, expected, 0.05, "V3b(b) -25 dBFS 段纳入后的功率均值");
    // 方向性对照：读数必须低于纯响段读数（V3a ≈ -20.10），证明低电平段进了均值。
    assert!(integrated < -20.3, "V3b(b) 低电平段必须被纳入：{integrated}");
    assert!(integrated > -21.0, "V3b(b) 读数不应被拖到功率均值以下：{integrated}");
}

// ---------------- V4：momentary / short-term 块尺寸与时域收敛 ----------------

/// 块尺寸与时间常数：400ms 块 + 100ms 步进 + 3s 短时窗（30 块）。
///
/// 信号：0.5 s 静音 + 4.5 s -20 dBFS 正弦（阶跃于 t = 0.5 s），块 321 非整除馈入。
/// - 馈入至 1.2 s：完成块 9 < 30 → short-term 必须 NaN（3 s 窗未满）；
///   此时最新完整块 [0.8, 1.2) 完全落在阶跃后且 K 加权已稳定（0.3 s >> 滤波
///   建立时间 ~50 ms）→ momentary 命中锚点（容差 0.02）。
/// - 馈入至 5.0 s：短时窗 = 最近 30 块 = 覆盖 [1.7, 5.0) 全稳态 → short-term
///   命中锚点（容差 0.02），momentary 同。
#[test]
fn v4_momentary与short_term_块尺寸与时域收敛() {
    let fs = 48_000.0;
    let amp = 10.0_f64.powf(-20.0 / 20.0);
    let silence = vec![0.0_f32; 24_000]; // 0.5 s
    let tone = sine(216_000, fs, 997.0, amp, 0.0); // 4.5 s
    let mut l = silence;
    let mut r = l.clone();
    l.extend_from_slice(&tone);
    r.extend_from_slice(&tone);

    let anchor = stereo_anchor_48k(-20.0);
    let mut meter = std_meter_48k();
    // 先馈入 1.2 s（57,600 样本，321 非整除分块）。
    feed(&mut meter, &l[..57_600], &r[..57_600], 321);
    assert!(
        meter.get_short_term_lufs().is_nan(),
        "V4 完成 9 块 < 30，short-term 必须为 NaN（3s 窗未满）"
    );
    assert_within(
        meter.get_momentary_lufs(),
        anchor,
        0.02,
        "V4 阶跃后 0.7s 的 momentary 已按 400ms 块收敛",
    );
    // 继续馈入至 5.0 s。
    feed(&mut meter, &l[57_600..], &r[57_600..], 321);
    assert_within(
        meter.get_short_term_lufs(),
        anchor,
        0.02,
        "V4 短时窗（3s）内全稳态 → short-term 命中锚点",
    );
    assert_within(meter.get_momentary_lufs(), anchor, 0.02, "V4 稳态 momentary");
}

// ---------------- V5：true peak（4× 过采样的采样间峰值） ----------------

/// 采样间峰值：所有样本低于满刻度，但 4× 过采样后的真峰值超过满刻度。
///
/// 构造：x[n] = 1.03·sin(2π·(fs/12)·n/fs + 75°)（f = 4 kHz，相位锁定在样本网格上）。
/// 样本相位 = 75° + k·30°，距正弦峰最近 15° → 样本最大值 = 1.03·cos(15°) = 0.9949
/// （-0.0445 dBFS，全部样本 < 1.0）；连续波形峰 = 1.03（+0.2565 dBFS）→ 采样间峰
/// 超出满刻度 0.26 dB。4× 过采样网格步进 7.5°，恰好命中 90° 峰值相位。
///
/// 冻结核边界说明：共享 4× 多相核（Blackman 窗 sinc，TS oracle 逐行冻结、golden
/// 锁死）的有效截止在 fs/8 ≈ 6 kHz @48 kHz（sinc(π·u/4) 的解析截止，实测 8 kHz
/// 衰减 ≈ -39 dB、4.8 kHz ≈ -0.9 dB）。因此「样本 ≤ 0.9 且真峰 > 1.0」的理想构造
/// （需 fs/6 相位锁定，8 kHz）在该核下不可行，本向量取带内 4 kHz：核在 4 kHz 的
/// 解析衰减 ≈ 0.1 dB，实测真峰值 +0.162 dB，仍严格高于样本峰值与满刻度。
/// 参考值容差按解析连续峰值 +0.2565 dB ± 核衰减余量取 0.2 dB。
#[test]
fn v5_真峰值_采样间峰值超满刻度而样本峰值低于满刻度() {
    let fs = 48_000.0;
    let l = sine(48_000, fs, 4_000.0, 1.03, 75.0 * PI / 180.0); // 1 s
    let r = l.clone();
    let mut meter = std_meter_48k();
    feed(&mut meter, &l, &r, 777);

    let sample_peak_db = meter.get_peak_db();
    assert_within(
        sample_peak_db,
        20.0 * (1.03 * (15.0_f64 * PI / 180.0).cos()).log10(),
        0.02,
        "V5 样本峰值（全部样本 < 1.0）",
    );
    let true_peak_db = meter.get_true_peak_db();
    assert!(
        true_peak_db > sample_peak_db,
        "V5 true peak（{true_peak_db}）必须高于样本峰值（{sample_peak_db}）"
    );
    assert!(
        true_peak_db > 0.0,
        "V5 采样间峰必须超满刻度（解析连续峰 +0.2565 dBFS）：{true_peak_db}"
    );
    assert_within(true_peak_db, 20.0 * 1.03_f64.log10(), 0.2, "V5 true peak 解析近似");
}

// ---------------- V6：两模式分离性 ----------------

/// HseV151（波形和 z = yL + yR）与 ItuBs1770_5（标准功率和 Σ G_i·z_i）的关系被
/// 明确断言。BS.1770-5 相对 -4 的测量语义等价（差异在条文：-5 将 RLB 高通定为固定
/// 组件）；但 HseV151 兼容路径采用**波形和**而非标准的通道功率和，两模式因此可分：
///
/// - 同相立体声：波形和 mean((yL+yR)²) = 2·Σ G_i·z_i → HseV151 恒高
///   10·log10(2) = 3.0103 LU。HseV151 期望 = 锚点 + 3.0103 = -17.0330，
///   与既有 TS golden A（-17.03296）交叉验证一致。
/// - 反相立体声：波形和恒为零（各块 p ≤ 1e-30 → NaN），功率和不受相关符号影响
///   （仍命中锚点）——标准语义对反相节目必须照常出数。
/// - 去相关内容：互项期望为零，两模式读数一致（有限样本残差经确定性 LCG 向量
///   实测 ≪ 0.15 LU 上界）。
#[test]
fn v6_两模式分离性_同相偏移_反相判别_去相关一致() {
    let fs = 48_000.0;
    let amp = 10.0_f64.powf(-20.0 / 20.0);
    let anchor = stereo_anchor_48k(-20.0);

    // (a) 同相：HseV151 = 标准功率和 + 3.0103 LU
    let l = sine(96_000, fs, 997.0, amp, 0.0);
    let r = sine(96_000, fs, 997.0, amp, 0.0);
    let mut hse = LufsMeter::new(fs).expect("合法采样率");
    feed(&mut hse, &l, &r, 777);
    let mut std = std_meter_48k();
    feed(&mut std, &l, &r, 777);
    let hse_loudness = hse.get_integrated_lufs();
    let std_loudness = std.get_integrated_lufs();
    assert_within(hse_loudness, anchor + POWER_OF_TWO_DB, 0.05, "V6(a) HseV151 同相读数");
    assert_within(std_loudness, anchor, 0.05, "V6(a) 标准模式同相读数");
    assert!(
        hse_loudness > std_loudness,
        "V6(a) 方向：波形和对同相内容读数偏高"
    );
    assert_within(
        hse_loudness - std_loudness,
        POWER_OF_TWO_DB,
        0.05,
        "V6(a) 两模式差 = 10·log10(2)",
    );

    // (b) 反相：标准模式照常出数；兼容模式波形和恒零 → NaN
    let l = sine(96_000, fs, 997.0, amp, 0.0);
    let r = sine(96_000, fs, 997.0, amp, PI);
    let mut hse = LufsMeter::new(fs).expect("合法采样率");
    feed(&mut hse, &l, &r, 777);
    let mut std = std_meter_48k();
    feed(&mut std, &l, &r, 777);
    assert!(
        hse.get_integrated_lufs().is_nan(),
        "V6(b) HseV151 反相波形和恒零，integrated 必须为 NaN"
    );
    assert_within(
        std.get_integrated_lufs(),
        anchor,
        0.05,
        "V6(b) 标准功率和对相关符号不变",
    );

    // (c) 去相关：左右独立 LCG 噪声，两模式读数一致（互项期望 0）
    let l = lcg_noise(192_000, 53_001, 0.1); // 4 s
    let r = lcg_noise(192_000, 53_002, 0.1);
    let mut hse = LufsMeter::new(fs).expect("合法采样率");
    feed(&mut hse, &l, &r, 777);
    let mut std = std_meter_48k();
    feed(&mut std, &l, &r, 777);
    let hse_loudness = hse.get_integrated_lufs();
    let std_loudness = std.get_integrated_lufs();
    assert_within(
        hse_loudness - std_loudness,
        0.0,
        0.15,
        "V6(c) 去相关内容两模式一致（上界 0.15 LU）",
    );
}

// ---------------- V7：标准路径与运行时状态复制的模式门控 ----------------

/// 跨模式运行时状态复制必须拒绝（左右双环形与单环形缓冲形态不同，且语义不同）；
/// 同模式复制保持透传（复用既有 checkpoint 契约）。BS.1770-5 与 -4 的测量等价性
/// 由 V6(a) 的差值断言（恰为条文差异 10·log10(2)，源于兼容路径的波形和简化）承载，
/// 此处不再重复数值断言。
#[test]
fn v7_运行时状态复制_跨模式拒绝_同模式透传() {
    let fs = 48_000.0;
    let l = sine(48_000, fs, 997.0, 0.1, 0.0);
    let r = sine(48_000, fs, 997.0, 0.1, 0.0);

    let mut source = std_meter_48k();
    feed(&mut source, &l, &r, 733);

    // 同模式：复制后继续馈入读数与源逐位一致。
    let checkpoint = source.clone();
    feed(&mut source, &l, &r, 997);
    let expected = source.get_integrated_lufs();
    let mut restored = std_meter_48k();
    restored
        .copy_runtime_state_from(&checkpoint)
        .expect("同模式同配置必须兼容");
    feed(&mut restored, &l, &r, 997);
    assert_eq!(
        restored.get_integrated_lufs().to_bits(),
        expected.to_bits(),
        "V7 同模式复制后继续测量必须逐位复现"
    );

    // 跨模式：拒绝。
    let mut hse_target = LufsMeter::new(fs).expect("合法采样率");
    assert!(
        hse_target.copy_runtime_state_from(&source).is_err(),
        "V7 跨模式复制必须拒绝"
    );
}
