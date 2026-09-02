//! 测试专用合成 SOFA fixture 生成器（feature `test-fixtures`，仅测试用）。
//!
//! 本 crate 的**产品资产**为已审计入库的 `assets/hrtf/mit-kemar-normal-pinna.sofa`
//! （见 `provenance/hrtf-mit-kemar/README.md`）；本模块与产品分发无关，只为
//! 下游 crate（engine/Tauri 适配器测试）提供确定性的合成 SimpleFreeFieldHRIR
//! fixture，避免把 HDF5 字节流生成逻辑复制到多个仓库位置。生成器参照 HDF5
//! 规范中 `sofar` 解析器实际支持的最小子集，程序化构造 SimpleFreeFieldHRIR
//! 数据（单位脉冲、对称左右耳 HRIR、4 个水平方向测量），直接在内存中拼出
//! 完整字节流，供落盘或直接走 `load_sofa_bytes` 使用。
//!
//! 生成的文件结构（全部小端，offset/length 均为 8 字节）：
//!
//! - superblock v0（无校验和，`sofar` 不校验）
//! - 根组 OHDR v2：`Conventions`/`SOFAConventions`/`DataType` 字符串属性 +
//!   LinkInfo（dense 分形堆存储子节点）
//! - 分形堆 FRHP v0 + 根直接块 FHDB v0：全部子数据集的目录项
//! - 各子数据集 OHDR v2：f32 数据类型 + v1 数据空间 + v3 contiguous 布局
//! - contiguous 原始 f32 数据块
//!
//! 仅覆盖合成 happy-path 与损坏注入所需的格式面；真实 SOFA 资产的兼容性
//! 验收见 `sofa.rs` 中被 ignore 的资产测试（`HSE_TEST_SOFA` 环境变量）。

/// 合成 SOFA 的测量方向（sofar 笛卡尔坐标：x 前、y 左、z 上）。
const DIRECTIONS: [[f32; 3]; 4] = [
    [0.0, 1.0, 0.0],  // 左（HSE 方位角 +90°）
    [1.0, 0.0, 0.0],  // 正前（HSE 方位角 0°）
    [0.0, -1.0, 0.0], // 右（HSE 方位角 -90°）
    [-1.0, 0.0, 0.0], // 正后（HSE 方位角 180°）
];

/// 一个子数据集的描述：名称、维度、原始小端 f32 载荷。
struct Dataset {
    name: String,
    dims: Vec<u64>,
    payload: Vec<u8>,
}

impl Dataset {
    fn f32s(name: &str, dims: &[u64], values: &[f32]) -> Self {
        let mut payload = Vec::with_capacity(values.len() * 4);
        for value in values {
            payload.extend_from_slice(&value.to_le_bytes());
        }
        Self {
            name: name.to_string(),
            dims: dims.to_vec(),
            payload,
        }
    }

    /// OHDR v2 对象头大小：7 字节固定头 + 消息区（含 4 字节校验和）。
    fn header_size(&self) -> usize {
        let dimensionality = self.dims.len();
        7 + 62 + 8 * dimensionality
    }
}

/// 构造合成 SimpleFreeFieldHRIR SOFA 文件字节流。
///
/// - 4 个水平方向测量（左/前/右/后），单位脉冲 HRIR；
/// - 左耳脉冲幅度 `left_peak`、右耳脉冲幅度 `right_peak`（默认均为 1.0），
///   用于测试中区分左右声道与方向；
/// - `sample_rate` 直接写入 `Data.SamplingRate`，用于采样率不支持用例；
/// - `delay_samples` 写入全部 `Data.Delay`（默认 0）。
pub fn synthetic_hrir_sofa(
    sample_rate: f32,
    filter_len: usize,
    left_peak: f32,
    right_peak: f32,
    delay_samples: f32,
) -> Vec<u8> {
    let m = DIRECTIONS.len();
    assert!(filter_len > 0, "filter length must be positive");

    let mut datasets = vec![
        // 维度数据集：只要名字存在即可（sofar 从 Data.IR 推断维度）。
        Dataset::f32s("I", &[], &[1.0]),
        Dataset::f32s("C", &[], &[3.0]),
        Dataset::f32s("R", &[], &[2.0]),
        Dataset::f32s("E", &[], &[1.0]),
        Dataset::f32s("N", &[], &[filter_len as f32]),
        Dataset::f32s("M", &[], &[m as f32]),
        // SOFA 位置数组（cartesian）。
        Dataset::f32s("ListenerPosition", &[1, 3], &[0.0; 3]),
        Dataset::f32s("ListenerView", &[1, 3], &[1.0, 0.0, 0.0]),
        Dataset::f32s("ListenerUp", &[1, 3], &[0.0, 0.0, 1.0]),
        Dataset::f32s(
            "ReceiverPosition",
            &[2, 3, 1],
            &[-0.09, 0.0, 0.0, 0.09, 0.0, 0.0],
        ),
        Dataset::f32s(
            "SourcePosition",
            &[m as u64, 3],
            &DIRECTIONS
                .iter()
                .flat_map(|d| d.iter().copied())
                .collect::<Vec<_>>(),
        ),
        Dataset::f32s("EmitterPosition", &[1, 3, 1], &[0.0; 3]),
        // 核心数据。
        Dataset::f32s("Data.SamplingRate", &[1], &[sample_rate]),
        Dataset::f32s("Data.Delay", &[m as u64, 2], &vec![delay_samples; m * 2]),
    ];
    let mut ir = Vec::with_capacity(m * 2 * filter_len);
    for _ in 0..m {
        for (index, peak) in [left_peak, right_peak].into_iter().enumerate() {
            for tap in 0..filter_len {
                // 左耳在 tap 0、右耳在 tap 1 打脉冲，保证左右可区分。
                let impulse = if tap == index { peak } else { 0.0 };
                ir.push(impulse);
            }
        }
    }
    datasets.push(Dataset::f32s(
        "Data.IR",
        &[m as u64, 2, filter_len as u64],
        &ir,
    ));

    write_hdf5_subset(&datasets)
}

/// 按预布局把 superblock、根组、分形堆、子数据集与数据块拼成完整文件。
fn write_hdf5_subset(datasets: &[Dataset]) -> Vec<u8> {
    // ---- 第一遍：计算布局与全部地址。 ----
    const ROOT_ADDR: usize = 80; // superblock 占 0..76，填充到 80
    let root_header_size = root_header_size();
    let frhp_addr = ROOT_ADDR + root_header_size;
    let fhdb_addr = frhp_addr + FRHP_HEADER_SIZE;
    let fhdb_size = fhdb_size(datasets);

    let mut cursor = fhdb_addr + fhdb_size;
    let mut header_addrs = Vec::with_capacity(datasets.len());
    for dataset in datasets {
        header_addrs.push(cursor);
        cursor += dataset.header_size();
    }
    let mut data_addrs = Vec::with_capacity(datasets.len());
    for dataset in datasets {
        data_addrs.push(cursor);
        cursor += dataset.payload.len();
    }
    let eof = cursor;

    let mut out = vec![0u8; eof];

    // ---- superblock v0。 ----
    out[0..8].copy_from_slice(&[0x89, b'H', b'D', b'F', 0x0d, 0x0a, 0x1a, 0x0a]);
    out[8] = 0; // version
    out[9..13].fill(0); // version ext
    out[13] = 8; // size of offsets
    out[14] = 8; // size of lengths
    out[15] = 0; // reserved
    out[16..18].copy_from_slice(&4u16.to_le_bytes()); // group leaf node k
    out[18..20].copy_from_slice(&16u16.to_le_bytes()); // group internal node k
    out[20..24].copy_from_slice(&0u32.to_le_bytes()); // file consistency flags
    out[24..32].copy_from_slice(&0u64.to_le_bytes()); // base address
    out[32..40].copy_from_slice(&0u64.to_le_bytes()); // free space (undefined)
    out[40..48].copy_from_slice(&(eof as u64).to_le_bytes()); // end of file
    out[48..56].copy_from_slice(&0u64.to_le_bytes()); // driver info (undefined)
    out[56..64].copy_from_slice(&0u64.to_le_bytes()); // link name offset
    out[64..72].copy_from_slice(&(ROOT_ADDR as u64).to_le_bytes()); // root object
    out[72..76].copy_from_slice(&0u32.to_le_bytes()); // cache type: none

    // ---- 根组 OHDR v2。 ----
    write_object_header(&mut out, ROOT_ADDR, &root_messages(frhp_addr));

    // ---- 分形堆头 FRHP v0。 ----
    write_frhp_header(&mut out, frhp_addr, fhdb_addr);

    // ---- 分形堆根直接块 FHDB v0（dense 目录项）。 ----
    write_fhdb(&mut out, fhdb_addr, frhp_addr, datasets, &header_addrs);

    // ---- 子数据集对象头与数据。 ----
    for ((dataset, &header_addr), &data_addr) in datasets.iter().zip(&header_addrs).zip(&data_addrs)
    {
        write_object_header(&mut out, header_addr, &dataset_messages(dataset, data_addr));
        let start = data_addr;
        out[start..start + dataset.payload.len()].copy_from_slice(&dataset.payload);
    }

    out
}

fn u8_at(out: &mut [u8], offset: usize, value: u8) {
    out[offset] = value;
}

fn u16_at(out: &mut [u8], offset: usize, value: u16) {
    out[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn u32_at(out: &mut [u8], offset: usize, value: u32) {
    out[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn u64_at(out: &mut [u8], offset: usize, value: u64) {
    out[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

/// 写入一个 OHDR v2 对象头（消息 + 4 字节占位校验和）。
fn write_object_header(out: &mut [u8], address: usize, messages: &[Vec<u8>]) {
    let body: Vec<u8> = messages.iter().flat_map(|m| m.iter().copied()).collect();
    let chunk_size = body.len() + 4; // 消息区含末尾 4 字节校验和
    assert!(
        chunk_size <= u8::MAX as usize,
        "object header chunk overflow"
    );

    u8_at(out, address, b'O');
    u8_at(out, address + 1, b'H');
    u8_at(out, address + 2, b'D');
    u8_at(out, address + 3, b'R');
    u8_at(out, address + 4, 2); // version
    u8_at(out, address + 5, 0); // flags
    u8_at(out, address + 6, chunk_size as u8); // 1 字节 chunk size 字段
    out[address + 7..address + 7 + body.len()].copy_from_slice(&body);
    // 末尾 4 字节校验和保持 0（sofar 不校验）。
}

fn message_header(kind: u8, size: usize) -> [u8; 4] {
    [kind, size as u8, (size >> 8) as u8, 0]
}

/// 根组消息：LinkInfo（dense 分形堆）+ 三个 SOFA 字符串属性。
fn root_messages(frhp_addr: usize) -> Vec<Vec<u8>> {
    let mut messages = Vec::new();

    // LinkInfo：version 0 + flags 0 + 分形堆地址 + B 树地址（undefined）。
    let mut link_info = Vec::new();
    link_info.extend_from_slice(&message_header(2, 18));
    link_info.push(0); // version
    link_info.push(0); // flags
    link_info.extend_from_slice(&(frhp_addr as u64).to_le_bytes());
    link_info.extend_from_slice(&0u64.to_le_bytes()); // b-tree: undefined
    messages.push(link_info);

    messages.push(string_attribute("Conventions", "SOFA"));
    messages.push(string_attribute("SOFAConventions", "SimpleFreeFieldHRIR"));
    messages.push(string_attribute("DataType", "FIR"));
    messages
}

/// 字符串属性消息（OHDR v1 属性头 + class 3 固定长度字符串）。
fn string_attribute(name: &str, value: &str) -> Vec<u8> {
    let name_size = name.len() + 1; // 含 null 终止符
    let padding = (8usize.saturating_sub(name_size)) & 7; // 与 sofar 的 v1 填充规则一致
    let mut message = Vec::new();
    let body_size = 8 + name_size + padding + 8 + 8 + value.len();
    message.extend_from_slice(&message_header(12, body_size));
    message.push(1); // attribute version
    message.push(0); // flags
    u16_into(&mut message, name_size as u16);
    u16_into(&mut message, 8); // datatype 消息尺寸
    u16_into(&mut message, 8); // dataspace 消息尺寸
    message.extend_from_slice(name.as_bytes());
    message.push(0); // name null 终止符
    message.resize(message.len() + padding, 0);
    // datatype：version 1 + class 3（固定长度字符串），size = 值字节数。
    message.push(0x13);
    message.extend_from_slice(&[0, 0, 0]); // class bit field
    u32_into(&mut message, value.len() as u32);
    // dataspace：version 1 + 标量（dimensionality 0）。
    message.push(1); // version
    message.push(0); // dimensionality
    message.push(0); // flags
    message.extend_from_slice(&[0; 5]); // reserved
    message.extend_from_slice(value.as_bytes());
    message
}

fn u16_into(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn u32_into(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn u64_into(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// 根组对象头总大小（消息尺寸固定，可静态计算）。
fn root_header_size() -> usize {
    // LinkInfo 22 + 三个字符串属性（按 string_attribute 的 body 规则）。
    let attributes = [("Conventions", 4), ("SOFAConventions", 19), ("DataType", 3)];
    let attribute_bytes: usize = attributes
        .iter()
        .map(|(name, value_len)| {
            let name_size = name.len() + 1;
            let padding = (8usize.saturating_sub(name_size)) & 7;
            4 + 8 + name_size + padding + 8 + 8 + value_len
        })
        .sum();
    let messages = 22 + attribute_bytes;
    7 + messages + 4
}

/// 分形堆头 FRHP v0。
fn write_frhp_header(out: &mut [u8], address: usize, fhdb_addr: usize) {
    let mut at = address;
    for byte in b"FRHP" {
        u8_at(out, at, *byte);
        at += 1;
    }
    u8_at(out, at, 0);
    at += 1; // version
    u16_at(out, at, 16);
    at += 2; // heap ID length
    u16_at(out, at, 0);
    at += 2; // filter encoded length（0 = 无滤波信息）
    u8_at(out, at, 0);
    at += 1; // flags
    u32_at(out, at, 4096);
    at += 4; // maximum size（决定 FHDB 内 length 字段宽度）
    let varints: [u64; 12] = [
        0,  // next huge object ID
        0,  // huge objects B-tree（undefined）
        0,  // free space
        0,  // free space address
        0,  // managed space in use
        0,  // allocated managed space
        0,  // managed space offset
        15, // number of managed objects（仅记录用）
        0,  // huge object size
        0,  // number of huge objects（必须为 0）
        0,  // tiny object size
        0,  // number of tiny objects（必须为 0）
    ];
    for value in varints {
        u64_at(out, at, value);
        at += 8;
    }
    u16_at(out, at, 1);
    at += 2; // table width
    u64_at(out, at, 256);
    at += 8; // starting block size
    u64_at(out, at, 4096);
    at += 8; // maximum direct block size
    u16_at(out, at, 64);
    at += 2; // maximum heap size（决定 FHDB block offset 字段宽度 = 8 字节）
    u16_at(out, at, 0);
    at += 2; // starting rows（0 = 根块是直接块）
    u64_at(out, at, fhdb_addr as u64);
    at += 8; // root block address
    u16_at(out, at, 0);
    at += 2; // current rows（0 = 直接块）
    assert_eq!(at - address, FRHP_EFFECTIVE_SIZE);
    // 末尾 4 字节校验和保持 0（sofar 不校验）。
}

/// FRHP 头有效字节数（不含尾部填充/校验和）。
const FRHP_EFFECTIVE_SIZE: usize = 142;
/// FRHP 头占用空间（填充到 8 字节对齐）。
const FRHP_HEADER_SIZE: usize = 144;

/// FHDB v0 直接块大小：固定头 + 全部目录项 + 终止字节。
fn fhdb_size(datasets: &[Dataset]) -> usize {
    // 固定头：签名 4 + version 1 + 堆头地址 8 + block offset 8（64 位，
    // maximum_heap_size=64 → 64/8；sofar 的 varint 读取器最多接受 8 字节）。
    let fixed = 21;
    let entries: usize = datasets
        .iter()
        .map(|dataset| 1 + 1 + 2 + 15 + dataset.name.len())
        .sum();
    fixed + entries + 1
}

/// FHDB v0 直接块：全部子数据集的 type-1 目录项。
fn write_fhdb(
    out: &mut [u8],
    address: usize,
    frhp_addr: usize,
    datasets: &[Dataset],
    header_addrs: &[usize],
) {
    let mut at = address;
    for byte in b"FHDB" {
        u8_at(out, at, *byte);
        at += 1;
    }
    u8_at(out, at, 0);
    at += 1; // version
    u64_at(out, at, frhp_addr as u64);
    at += 8; // heap header address
    out[at..at + 8].fill(0); // block offset（maximum_heap_size/8 = 8 字节）
    at += 8;

    for (dataset, &header_addr) in datasets.iter().zip(header_addrs) {
        let entry_len = 15 + dataset.name.len();
        u8_at(out, at, 1); // type-and-version: 目录项
        at += 1;
        u8_at(out, at, 0);
        at += 1; // heap offset（1 字节）
        u16_at(out, at, entry_len as u16);
        at += 2; // entry length（2 字节）
        u32_at(out, at, 0);
        at += 4; // unknown2：0 = 目录项
        u16_at(out, at, 0);
        at += 2; // unknown3
        u8_at(out, at, dataset.name.len() as u8);
        at += 1; // name length
        out[at..at + dataset.name.len()].copy_from_slice(dataset.name.as_bytes());
        at += dataset.name.len();
        u64_at(out, at, header_addr as u64);
        at += 8; // 子对象头地址
    }
    u8_at(out, at, 0); // 终止字节
}

/// 子数据集消息：f32 数据类型 + v1 数据空间 + v3 contiguous 布局。
fn dataset_messages(dataset: &Dataset, data_addr: usize) -> Vec<Vec<u8>> {
    let dimensionality = dataset.dims.len();
    let mut messages = Vec::new();

    // DataType：version 1 + class 1（IEEE f32）。
    let mut data_type = Vec::new();
    data_type.extend_from_slice(&message_header(3, 20));
    data_type.push(0x11); // version 1, class 1 (float)
    data_type.extend_from_slice(&[0, 0, 0]); // class bit field
    u32_into(&mut data_type, 4); // 元素大小
    u16_into(&mut data_type, 0); // bit offset
    u16_into(&mut data_type, 32); // bit precision
    data_type.push(23); // exponent location
    data_type.push(8); // exponent size
    data_type.push(0); // mantissa location
    data_type.push(23); // mantissa size
    u32_into(&mut data_type, 127); // exponent bias
    messages.push(data_type);

    // DataSpace：version 1 + 常规维度。
    let mut data_space = Vec::new();
    let space_size = 8 + 8 * dimensionality;
    data_space.extend_from_slice(&message_header(1, space_size));
    data_space.push(1); // version
    data_space.push(dimensionality as u8);
    data_space.push(0); // flags：无最大维度
    data_space.extend_from_slice(&[0; 5]); // reserved
    for dim in &dataset.dims {
        u64_into(&mut data_space, *dim);
    }
    messages.push(data_space);

    // DataLayout：version 3 + class 1（contiguous）。
    let mut layout = Vec::new();
    layout.extend_from_slice(&message_header(8, 18));
    layout.push(3); // version
    layout.push(1); // class: contiguous
    layout.extend_from_slice(&(data_addr as u64).to_le_bytes());
    layout.extend_from_slice(&(dataset.payload.len() as u64).to_le_bytes());
    messages.push(layout);

    messages
}

/// 把合成 SOFA 写入临时目录并返回路径。
pub fn write_synthetic_sofa(
    dir: &std::path::Path,
    file_name: &str,
    bytes: &[u8],
) -> std::path::PathBuf {
    std::fs::create_dir_all(dir).expect("create temp fixture dir");
    let path = dir.join(file_name);
    std::fs::write(&path, bytes).expect("write synthetic sofa fixture");
    path
}

/// 每个测试独立的临时目录，避免并行测试互相覆盖。
pub fn temp_dir(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "hyperplayer-hrtf-core-{}-{}-{}",
        std::process::id(),
        label,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos()
    ))
}
