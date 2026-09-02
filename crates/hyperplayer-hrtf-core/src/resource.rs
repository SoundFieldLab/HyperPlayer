//! 外部 HRTF 资源注入 API（非实时控制路径）。
//!
//! # 状态说明（重要）
//!
//! **HRTF/SOFA 资源的合规审计尚未完成**：仓库当前没有任何可再分发、已审计
//! 的产品级 HRTF 资产，HIR/SOFA 数据只能由用户通过本 API 显式注入（提供
//! 文件路径 + 期望 SHA-256 + 来源声明），产品资产待审计后另行引入。因此
//! Stage 22 Spatial/HRTF 的产品接线（engine/Tauri/前端）处于**受阻**状态，
//! 本模块只提供受限范围内的加载、验证、失败回退与 identity 记录能力，
//! **不得据此宣称产品完成**。
//!
//! # 设计
//!
//! 完整的注入流程（全部在非实时控制路径上执行）：
//!
//! 1. 调用方构造 [`HrtfResourceDescriptor`]（路径 + 期望 SHA-256 + 采样率 +
//!    声明来源元数据 + 网格选项）；
//! 2. [`load_verified_resource`] 读取文件 → 计算 SHA-256 并与期望值比对 →
//!    SOFA 解析（SimpleFreeFieldHRIR）→ Kaiser-sinc 重采样到目标采样率 →
//!    构建渲染就绪的 [`HrtfGrid`]；
//! 3. 任何一步失败都会返回显式 [`ResourceError`]，绝不静默使用错误数据；
//! 4. [`HrtfResourceManager`] 持有当前已验证资源：安装新资源失败时保留
//!    上一个已验证资源（回退），没有任何已验证资源时进入「不可用」状态，
//!    由宿主侧退回旁路（不渲染空间场）。
//!
//! 加载完成后可通过 [`HrtfResourceIdentity`] 查询资源的 hash/来源/版本/
//! 采样率/网格规模，供后续 provenance 记录使用（provenance 归档本身属于
//! 资产门禁范围，本轮未接线）。

use std::{error::Error, fmt, path::PathBuf};

use crate::{sha256, sofa, HrtfGrid, SofaError};

/// 采样率容差：与 `sofa` 模块保持一致的整数 Hz 比较。
const SUPPORTED_SAMPLE_RATES: [u32; 3] = [44_100, 48_000, 96_000];

/// 资源描述符中的来源与许可声明元数据。
///
/// 这些字段是资产门禁（数据来源、版本、许可证、分发义务）的最小记录，
/// 加载成功后原样进入 [`HrtfResourceIdentity`]，供 provenance 归档。
/// 当前所有产品级资产均未通过审计，调用方必须如实填写。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HrtfResourceProvenance {
    /// 资源的人类可读名称（例如数据集名称）。
    pub name: String,
    /// 资源版本标识（例如数据集发布版本）。
    pub version: String,
    /// 来源描述（发布方或 URL）。
    pub origin: String,
    /// 许可证标识（例如 `CC-BY-4.0`；未审计前不应出现可再分发声明）。
    pub license: String,
    /// 分发义务备注（署名要求、禁止再分发说明等；可为空字符串）。
    pub distribution_notes: String,
}

impl HrtfResourceProvenance {
    /// 构造来源声明元数据。
    pub fn new(
        name: impl Into<String>,
        version: impl Into<String>,
        origin: impl Into<String>,
        license: impl Into<String>,
        distribution_notes: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            version: version.into(),
            origin: origin.into(),
            license: license.into(),
            distribution_notes: distribution_notes.into(),
        }
    }
}

/// 外部 HRTF 资源描述符：注入一条 SOFA 资源所需的全部信息。
///
/// `expected_sha256_hex` 是 64 位十六进制（大小写不敏感）的期望摘要；
/// 加载时逐字节校验，不匹配即拒绝。`sample_rate` 是渲染目标采样率，
/// 必须与 `grid.sample_rate` 一致且受支持（44100/48000/96000 Hz）。
#[derive(Debug, Clone, PartialEq)]
pub struct HrtfResourceDescriptor {
    /// SOFA 文件路径（由用户提供，不随产品分发）。
    pub path: PathBuf,
    /// 期望的 SHA-256（64 个十六进制字符，大小写不敏感）。
    pub expected_sha256_hex: String,
    /// 渲染目标采样率（Hz），必须受支持。
    pub sample_rate: u32,
    /// 来源与许可声明。
    pub provenance: HrtfResourceProvenance,
    /// SOFA 网格抽取选项（含与 `sample_rate` 一致的采样率）。
    pub grid: sofa::SofaGridOptions,
}

impl HrtfResourceDescriptor {
    /// 构造并校验资源描述符。
    ///
    /// 校验内容：hash 十六进制格式、采样率非零且受支持、描述符采样率与
    /// 网格选项采样率一致。不通过时返回 [`ResourceError`]。
    pub fn new(
        path: impl Into<PathBuf>,
        expected_sha256_hex: impl Into<String>,
        sample_rate: u32,
        provenance: HrtfResourceProvenance,
        grid: sofa::SofaGridOptions,
    ) -> Result<Self, ResourceError> {
        let expected_sha256_hex = expected_sha256_hex.into();
        if !is_sha256_hex(&expected_sha256_hex) {
            return Err(ResourceError::InvalidSha256Format {
                actual: expected_sha256_hex,
            });
        }
        if sample_rate == 0 {
            return Err(ResourceError::InvalidSampleRate { rate: 0 });
        }
        validate_supported_sample_rate(sample_rate)?;
        if grid.sample_rate != sample_rate {
            return Err(ResourceError::DescriptorSampleRateMismatch {
                descriptor: sample_rate,
                grid: grid.sample_rate,
            });
        }
        Ok(Self {
            path: path.into(),
            expected_sha256_hex: expected_sha256_hex.to_ascii_lowercase(),
            sample_rate,
            provenance,
            grid,
        })
    }
}

/// 资源身份记录：加载成功后对「到底是哪份数据进入渲染」的唯一回答。
///
/// 供后续 provenance 记录与审计对账使用；同一份文件（相同 hash）在相同
/// 网格选项下产生的 identity 应当完全一致。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HrtfResourceIdentity {
    /// 实际文件内容的 SHA-256（小写十六进制）。
    pub sha256_hex: String,
    /// 文件字节数。
    pub file_size_bytes: u64,
    /// 渲染采样率（Hz）。
    pub sample_rate: u32,
    /// 网格方位角数量。
    pub azimuth_count: usize,
    /// 网格仰角数量。
    pub elevation_count: usize,
    /// 单个方向 HRIR 的采样点数。
    pub hrir_length: usize,
    /// 加载时声明的来源与许可元数据。
    pub provenance: HrtfResourceProvenance,
}

/// 已通过全部校验的 HRTF 资源：渲染就绪的网格 + 资源身份。
#[derive(Debug, Clone)]
pub struct VerifiedHrtfResource {
    grid: HrtfGrid,
    identity: HrtfResourceIdentity,
}

impl VerifiedHrtfResource {
    /// 渲染就绪的 HRTF 网格。
    pub fn grid(&self) -> &HrtfGrid {
        &self.grid
    }

    /// 资源身份记录。
    pub fn identity(&self) -> &HrtfResourceIdentity {
        &self.identity
    }

    /// 拆出网格与身份（供宿主侧接管所有权）。
    pub fn into_parts(self) -> (HrtfGrid, HrtfResourceIdentity) {
        (self.grid, self.identity)
    }
}

/// 资源注入流程的显式错误类型。
///
/// 每种失败都要求调用方可见：hash 不匹配、文件缺失、解析失败、采样率
/// 不支持等一律显式返回，绝不静默使用错误数据。
#[derive(Debug)]
pub enum ResourceError {
    /// 描述符中的期望 hash 不是 64 个十六进制字符。
    InvalidSha256Format {
        /// 实际收到的字符串。
        actual: String,
    },
    /// 描述符采样率为 0。
    InvalidSampleRate {
        /// 非法的采样率。
        rate: u32,
    },
    /// 描述符采样率不受支持（仅接受 44100/48000/96000 Hz）。
    UnsupportedSampleRate {
        /// 不受支持的采样率。
        rate: u32,
    },
    /// 描述符采样率与网格选项采样率不一致。
    DescriptorSampleRateMismatch {
        /// 描述符声明的采样率。
        descriptor: u32,
        /// 网格选项中的采样率。
        grid: u32,
    },
    /// 资源文件不存在。
    FileMissing {
        /// 文件路径。
        path: String,
    },
    /// 其他文件读取错误。
    Io(String),
    /// 文件内容与期望 SHA-256 不匹配：拒绝加载。
    HashMismatch {
        /// 期望摘要（小写十六进制）。
        expected: String,
        /// 实际摘要（小写十六进制）。
        actual: String,
    },
    /// SOFA 解析/校验失败（格式、约定、采样率、网格等）。
    Sofa(SofaError),
}

impl fmt::Display for ResourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSha256Format { actual } => {
                write!(f, "期望 SHA-256 不是 64 个十六进制字符: {actual}")
            }
            Self::InvalidSampleRate { rate } => write!(f, "采样率 {rate} Hz 非法"),
            Self::UnsupportedSampleRate { rate } => write!(
                f,
                "采样率 {rate} Hz 不受支持；仅接受 44100、48000 或 96000 Hz"
            ),
            Self::DescriptorSampleRateMismatch { descriptor, grid } => {
                write!(
                    f,
                    "描述符采样率 {descriptor} Hz 与网格选项采样率 {grid} Hz 不一致"
                )
            }
            Self::FileMissing { path } => write!(f, "资源文件不存在: {path}"),
            Self::Io(message) => write!(f, "资源文件读取失败: {message}"),
            Self::HashMismatch { expected, actual } => write!(
                f,
                "资源 SHA-256 校验失败：期望 {expected}，实际 {actual}；已拒绝加载"
            ),
            Self::Sofa(error) => write!(f, "SOFA 资源解析失败: {error}"),
        }
    }
}

impl Error for ResourceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Sofa(error) => Some(error),
            _ => None,
        }
    }
}

impl From<SofaError> for ResourceError {
    fn from(value: SofaError) -> Self {
        Self::Sofa(value)
    }
}

/// 按描述符加载并验证一条外部 HRTF 资源（完整非实时流程）。
///
/// 流程：读取文件 → SHA-256 校验 → SOFA 解析（SimpleFreeFieldHRIR）→
/// 重采样到目标采样率 → 构建 [`HrtfGrid`]。任何一步失败都会返回显式
/// [`ResourceError`]，不会产出「部分可用」的网格。
///
/// 注意：资源合规审计未完成，本函数只应使用用户自备的文件；产品接线
/// （engine asset loader/adapter、Tauri capability/DTO 等）待资产就绪后实施。
pub fn load_verified_resource(
    descriptor: &HrtfResourceDescriptor,
) -> Result<VerifiedHrtfResource, ResourceError> {
    // 再校验一次描述符不变量（构造时已校验，防御绕过构造器直接构造的情况）。
    if !is_sha256_hex(&descriptor.expected_sha256_hex) {
        return Err(ResourceError::InvalidSha256Format {
            actual: descriptor.expected_sha256_hex.clone(),
        });
    }
    if descriptor.sample_rate == 0 {
        return Err(ResourceError::InvalidSampleRate {
            rate: descriptor.sample_rate,
        });
    }
    validate_supported_sample_rate(descriptor.sample_rate)?;
    if descriptor.grid.sample_rate != descriptor.sample_rate {
        return Err(ResourceError::DescriptorSampleRateMismatch {
            descriptor: descriptor.sample_rate,
            grid: descriptor.grid.sample_rate,
        });
    }

    let bytes = std::fs::read(&descriptor.path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ResourceError::FileMissing {
                path: descriptor.path.display().to_string(),
            }
        } else {
            ResourceError::Io(error.to_string())
        }
    })?;

    let actual_hex = sha256::digest_hex(&bytes);
    if actual_hex != descriptor.expected_sha256_hex.to_ascii_lowercase() {
        return Err(ResourceError::HashMismatch {
            expected: descriptor.expected_sha256_hex.to_ascii_lowercase(),
            actual: actual_hex,
        });
    }

    let grid = sofa::load_sofa_bytes(&bytes, &descriptor.grid)?;
    let identity = HrtfResourceIdentity {
        sha256_hex: actual_hex,
        file_size_bytes: bytes.len() as u64,
        sample_rate: grid.sample_rate(),
        azimuth_count: grid.azimuths().len(),
        elevation_count: grid.elevations().len(),
        hrir_length: grid.hrir_length(),
        provenance: descriptor.provenance.clone(),
    };
    Ok(VerifiedHrtfResource { grid, identity })
}

/// 已验证 HRTF 资源的管理器（非实时控制路径）。
///
/// 负责安装/查询/卸载当前资源，并实现失败回退语义：
///
/// - [`install`](Self::install) 成功：新资源整体替换当前资源；
/// - [`install`](Self::install) 失败：**保留上一个已验证资源不动**，
///   通过返回值显式报告 [`ResourceError`]——绝不进入「半安装」状态，
///   也绝不静默使用错误数据；失败细节由调用方持有（本管理器不缓存）。
/// - 没有任何已验证资源时 [`is_available`](Self::is_available) 为
///   `false`，宿主侧应退回旁路（不渲染空间场）。
///
/// 实时音频线程不得直接持有本管理器；宿主应在控制线程完成资源切换后，
/// 将新 [`HrtfGrid`] 交给渲染器重建（属于后续产品接线范围，本轮未实施）。
#[derive(Debug, Default)]
pub struct HrtfResourceManager {
    current: Option<VerifiedHrtfResource>,
}

impl HrtfResourceManager {
    /// 创建一个没有任何已验证资源的管理器（不可用状态）。
    pub fn new() -> Self {
        Self::default()
    }

    /// 安装（或替换）当前资源。
    ///
    /// 加载与验证成功时，新资源整体替换当前资源（旧资源随之释放）；
    /// 失败时保留当前资源作为回退，并将 [`ResourceError`] 显式返回给
    /// 调用方。
    pub fn install(
        &mut self,
        descriptor: &HrtfResourceDescriptor,
    ) -> Result<HrtfResourceIdentity, ResourceError> {
        // 先完整加载与验证，成功后才替换当前资源；失败路径不影响现状。
        let resource = load_verified_resource(descriptor)?;
        let identity = resource.identity().clone();
        self.current = Some(resource);
        Ok(identity)
    }

    /// 当前是否存在已验证、可用的资源。
    pub fn is_available(&self) -> bool {
        self.current.is_some()
    }

    /// 当前已验证资源。
    pub fn current(&self) -> Option<&VerifiedHrtfResource> {
        self.current.as_ref()
    }

    /// 当前资源的身份查询（供 provenance 记录/审计对账）。
    pub fn identity(&self) -> Option<&HrtfResourceIdentity> {
        self.current.as_ref().map(|resource| resource.identity())
    }

    /// 当前资源的渲染就绪网格。
    pub fn grid(&self) -> Option<&HrtfGrid> {
        self.current.as_ref().map(|resource| resource.grid())
    }

    /// 显式卸载当前资源，进入不可用状态（宿主侧应退回旁路）。
    pub fn unload(&mut self) -> Option<HrtfResourceIdentity> {
        self.current.take().map(|resource| resource.into_parts().1)
    }
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f' | b'A'..=b'F'))
}

fn validate_supported_sample_rate(rate: u32) -> Result<(), ResourceError> {
    if SUPPORTED_SAMPLE_RATES.contains(&rate) {
        Ok(())
    } else {
        Err(ResourceError::UnsupportedSampleRate { rate })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_rejects_bad_hash_and_rate() {
        let provenance = HrtfResourceProvenance::new("n", "1", "o", "l", "");
        let grid = sofa::SofaGridOptions::default();
        let error = HrtfResourceDescriptor::new("a.sofa", "zz", 48_000, provenance.clone(), grid)
            .expect_err("bad hash must fail");
        assert!(matches!(error, ResourceError::InvalidSha256Format { .. }));

        let error = HrtfResourceDescriptor::new(
            "a.sofa",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            88_200,
            provenance.clone(),
            grid,
        )
        .expect_err("unsupported rate must fail");
        assert!(matches!(
            error,
            ResourceError::UnsupportedSampleRate { rate: 88_200 }
        ));

        let error = HrtfResourceDescriptor::new(
            "a.sofa",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            48_000,
            provenance,
            sofa::SofaGridOptions {
                sample_rate: 44_100,
                ..sofa::SofaGridOptions::default()
            },
        )
        .expect_err("rate mismatch must fail");
        assert!(matches!(
            error,
            ResourceError::DescriptorSampleRateMismatch {
                descriptor: 48_000,
                grid: 44_100
            }
        ));
    }

    #[test]
    fn display_is_explicit_for_each_failure() {
        assert!(ResourceError::HashMismatch {
            expected: "aa".into(),
            actual: "bb".into(),
        }
        .to_string()
        .contains("已拒绝加载"));
        assert!(ResourceError::FileMissing {
            path: "x.sofa".into()
        }
        .to_string()
        .contains("x.sofa"));
    }
}
