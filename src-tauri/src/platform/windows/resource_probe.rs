//! D30 Windows 资源探针（Stage 11）。
//!
//! 为低优先级后台任务（album-fill 等）提供 typed、可测试、fail-closed 的资源快照，
//! 作为「仅 AC、仅非计费网络、磁盘保留量满足」的门禁。本模块只负责探测与判定，
//! 不实现任何下载 / 调度 / 配额逻辑。
//!
//! 核心原则：**未知一律 blocked**（fail closed）。获取失败、WinRT 异常、平台不支持
//! 全部归入 `Unknown`，最终得到 `Eligibility::Blocked`。
//!
//! ## 关于 `dead_code`
//!
//! 本模块是 D30 探针的可独立测试单元，`AppServices` / `CacheRuntime` 的接线作为后续
//! stage 暂缓接入，因此当前尚未被产品代码引用。接入后此允许应移除。
#![allow(dead_code)]

use hyperplayer_engine::cache_policy::DiskReservePolicy;
use std::path::Path;

/// 电源状态。桌面机 / UPS 无法据此区分时归入 `Unknown`，一律 fail closed。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PowerState {
    /// 已接入交流电（`ACLineStatus == 1` 或系统明确为纯交流）。
    OnAc,
    /// 电池供电；UPS 等非纯 AC 或无法确认为纯 AC 的情况也归入此类（保守处理时可为 Unknown）。
    OnBattery,
    /// 无法判定（接口错误、值非法、平台不支持）。
    Unknown,
}

/// 网络计费状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkCostState {
    /// 非计费（Windows `NetworkCostType::Unrestricted` / `Fixed`）。
    Unmetered,
    /// 计费（Windows `NetworkCostType::Variable`）。
    Metered,
    /// 无法判定（无互联网连接、接口错误、未知取值）。
    Unknown,
}

/// 磁盘保留量状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiskReserveState {
    /// 当前剩余可用字节同时满足 `minimum_bytes` 与 `minimum_percent`。
    MeetsReserve,
    /// 不满足保留量。
    BelowReserve,
    /// 无法判定。
    Unknown,
}

/// 一次资源快照：三个维度共同组成门禁输入。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResourceSnapshot {
    pub power: PowerState,
    pub network_cost: NetworkCostState,
    pub disk_reserve: DiskReserveState,
}

/// 门禁判定结果。任何 `Unknown` 都会 fail closed。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Eligibility {
    Allowed,
    Blocked(EligibilityReason),
}

/// 被拦截的具体原因。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EligibilityReason {
    OnBattery,
    UnknownPower,
    MeteredNetwork,
    UnknownNetwork,
    BelowDiskReserve,
    UnknownDiskReserve,
}

impl Eligibility {
    /// 纯判定函数：给定三状态返回 `Eligibility`。**未知一律 blocked（fail closed）**。
    ///
    /// 优先级：先处理所有未知（fail closed），再处理明确的降级条件（电池 / 计费 / 磁盘不足）。
    pub fn classify(snapshot: ResourceSnapshot) -> Eligibility {
        let blocked = |reason| Eligibility::Blocked(reason);
        match snapshot.power {
            PowerState::Unknown => return blocked(EligibilityReason::UnknownPower),
            PowerState::OnBattery => return blocked(EligibilityReason::OnBattery),
            PowerState::OnAc => {}
        }
        match snapshot.network_cost {
            NetworkCostState::Unknown => return blocked(EligibilityReason::UnknownNetwork),
            NetworkCostState::Metered => return blocked(EligibilityReason::MeteredNetwork),
            NetworkCostState::Unmetered => {}
        }
        match snapshot.disk_reserve {
            DiskReserveState::Unknown => return blocked(EligibilityReason::UnknownDiskReserve),
            DiskReserveState::BelowReserve => return blocked(EligibilityReason::BelowDiskReserve),
            DiskReserveState::MeetsReserve => {}
        }
        Eligibility::Allowed
    }
}

/// 纯判定：由「剩余可用字节 + 卷总字节 + 保留策略」得出磁盘保留量状态。
///
/// 需要**同时**满足 `minimum_bytes` 与 `minimum_percent` 才视为 `MeetsReserve`；
/// `total_bytes == 0` 无法计算百分比时返回 `Unknown`。
pub fn classify_disk_reserve(
    free_bytes: u64,
    total_bytes: u64,
    reserve: &DiskReservePolicy,
) -> DiskReserveState {
    if total_bytes == 0 {
        return DiskReserveState::Unknown;
    }
    let percent_min_bytes =
        (u128::from(total_bytes) * u128::from(reserve.minimum_percent) / 100) as u64;
    let meets_bytes = free_bytes >= reserve.minimum_bytes;
    let meets_percent = free_bytes >= percent_min_bytes;
    if meets_bytes && meets_percent {
        DiskReserveState::MeetsReserve
    } else {
        DiskReserveState::BelowReserve
    }
}

/// 资源探针抽象。实现方负责「获取」原始数据，判定逻辑由默认方法提供。
///
/// - `power_state`：电源状态。
/// - `network_cost_state`：网络计费状态。
/// - `free_space_bytes`：`cache_root` 所在卷的 `(剩余可用字节, 总字节)`；`None` 表示 unknown。
pub trait ResourceProbe: Send + Sync {
    fn power_state(&self) -> PowerState;
    fn network_cost_state(&self) -> NetworkCostState;
    fn free_space_bytes(&self, cache_root: &Path) -> Option<(u64, u64)>;

    /// 由剩余空间 + 保留策略得出磁盘保留量状态；获取失败 → `Unknown`。
    fn disk_reserve_state(
        &self,
        cache_root: &Path,
        reserve: &DiskReservePolicy,
    ) -> DiskReserveState {
        match self.free_space_bytes(cache_root) {
            Some((free_bytes, total_bytes)) => {
                classify_disk_reserve(free_bytes, total_bytes, reserve)
            }
            None => DiskReserveState::Unknown,
        }
    }

    /// 汇总三次探测为一张快照。
    fn snapshot(&self, cache_root: &Path, reserve: &DiskReservePolicy) -> ResourceSnapshot {
        ResourceSnapshot {
            power: self.power_state(),
            network_cost: self.network_cost_state(),
            disk_reserve: self.disk_reserve_state(cache_root, reserve),
        }
    }

    /// 门禁判定：fail closed。
    fn eligibility(&self, cache_root: &Path, reserve: &DiskReservePolicy) -> Eligibility {
        Eligibility::classify(self.snapshot(cache_root, reserve))
    }
}

/// 面向当前操作系统（Windows / macOS / Linux）的探针。
///
/// Windows 使用系统真实状态；在其它平台（当前只支持 Windows 分发）一律返回 `Unknown`，
/// 从而在跨平台构建时依然 fail closed。
///
/// 说明：`AppServices` / `CacheRuntime` 的接线暂缓接入，因此本探针当前尚未被产品代码引用；
/// 它是可独立测试的自包含单元，接入后即可移除模块顶部的 `allow(dead_code)`。
pub struct SystemResourceProbe {
    _private: (),
}

impl SystemResourceProbe {
    pub const fn new() -> Self {
        Self { _private: () }
    }
}

impl ResourceProbe for SystemResourceProbe {
    fn power_state(&self) -> PowerState {
        platform_power_state()
    }
    fn network_cost_state(&self) -> NetworkCostState {
        platform_network_cost_state()
    }
    fn free_space_bytes(&self, cache_root: &Path) -> Option<(u64, u64)> {
        platform_free_space_bytes(cache_root)
    }
}

/// `ACLineStatus` 到 `PowerState` 的纯映射。
///
/// Windows 约定：`1` = 交流电在线，`0` = 电池，`255` = 未知；其余取值一律视为未知。
#[cfg(windows)]
fn classify_ac_line_status(ac_line_status: u8) -> PowerState {
    match ac_line_status {
        1 => PowerState::OnAc,
        0 => PowerState::OnBattery,
        _ => PowerState::Unknown,
    }
}

#[cfg(windows)]
fn platform_power_state() -> PowerState {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    // SAFETY: `status` 是栈上的有效 `SYSTEM_POWER_STATUS` 写缓冲区。
    let mut status = SYSTEM_POWER_STATUS::default();
    if unsafe { GetSystemPowerStatus(&mut status) }.is_ok() {
        classify_ac_line_status(status.ACLineStatus)
    } else {
        PowerState::Unknown
    }
}

#[cfg(windows)]
fn platform_network_cost_state() -> NetworkCostState {
    use windows::{
        Networking::Connectivity::{NetworkCostType, NetworkInformation},
        Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
    };

    struct WinRtGuard(bool);
    impl Drop for WinRtGuard {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: 仅在 RoInitialize 成功时占用并在此配对释放。
                unsafe { RoUninitialize() };
            }
        }
    }

    // WinRT 静态方法需要在初始化了 WinRT 的线程上调用。若线程已初始化（含不同模式，
    // 如 RPC_E_CHANGED_MODE），RoInitialize 会返回错误——此时我们既不得反复释放，
    // 也不能 `uninit`，因此仅在 `is_ok()` 时配对 `RoUninitialize`。
    let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
    let _guard = WinRtGuard(initialized);

    let profile = match NetworkInformation::GetInternetConnectionProfile() {
        Ok(profile) => profile,
        Err(_) => return NetworkCostState::Unknown,
    };
    let cost = match profile.GetConnectionCost() {
        Ok(cost) => cost,
        Err(_) => return NetworkCostState::Unknown,
    };
    match cost.NetworkCostType() {
        Ok(NetworkCostType::Unrestricted) | Ok(NetworkCostType::Fixed) => {
            NetworkCostState::Unmetered
        }
        Ok(NetworkCostType::Variable) => NetworkCostState::Metered,
        _ => NetworkCostState::Unknown,
    }
}

#[cfg(windows)]
fn platform_free_space_bytes(cache_root: &Path) -> Option<(u64, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut wide: Vec<u16> = cache_root.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return None;
    }
    wide.push(0);
    let mut free_bytes = 0u64;
    let mut total_bytes = 0u64;
    // SAFETY: `wide` 是 NUL 结尾的活缓冲区；`free_bytes` / `total_bytes` 是合法 u64 出参。
    unsafe {
        GetDiskFreeSpaceExW(
            windows::core::PCWSTR(wide.as_ptr()),
            Some(&mut free_bytes),
            None,
            Some(&mut total_bytes),
        )
        .ok()?;
    }
    Some((free_bytes, total_bytes))
}

#[cfg(not(windows))]
fn platform_power_state() -> PowerState {
    PowerState::Unknown
}

#[cfg(not(windows))]
fn platform_network_cost_state() -> NetworkCostState {
    NetworkCostState::Unknown
}

#[cfg(not(windows))]
fn platform_free_space_bytes(_cache_root: &Path) -> Option<(u64, u64)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reserve(minimum_bytes: u64, minimum_percent: u8) -> DiskReservePolicy {
        DiskReservePolicy {
            minimum_bytes,
            minimum_percent,
            resume_bytes: minimum_bytes + 1,
            resume_percent: minimum_percent + 1,
        }
    }

    /// 覆盖 3×3×3 = 27 种组合：只有唯一「最佳」组合允许，其余全部 blocked，
    /// 且所有含 Unknown 的组合均 fail closed。
    #[test]
    fn eligibility_is_allowed_only_for_ideal_snapshot() {
        let powers = [PowerState::OnAc, PowerState::OnBattery, PowerState::Unknown];
        let networks = [
            NetworkCostState::Unmetered,
            NetworkCostState::Metered,
            NetworkCostState::Unknown,
        ];
        let disks = [
            DiskReserveState::MeetsReserve,
            DiskReserveState::BelowReserve,
            DiskReserveState::Unknown,
        ];

        for power in powers {
            for network in networks {
                for disk in disks {
                    let snapshot = ResourceSnapshot {
                        power,
                        network_cost: network,
                        disk_reserve: disk,
                    };
                    let eligibility = Eligibility::classify(snapshot);
                    let ideal = power == PowerState::OnAc
                        && network == NetworkCostState::Unmetered
                        && disk == DiskReserveState::MeetsReserve;
                    if ideal {
                        assert_eq!(eligibility, Eligibility::Allowed);
                    } else {
                        assert!(matches!(eligibility, Eligibility::Blocked(_)));
                    }
                }
            }
        }
    }

    #[test]
    fn eligibility_fails_closed_on_any_unknown() {
        // 即便其它维度都是理想值，单独一个 Unknown 也必须 blocked。
        let unknowns = [
            Eligibility::classify(ResourceSnapshot {
                power: PowerState::Unknown,
                network_cost: NetworkCostState::Unmetered,
                disk_reserve: DiskReserveState::MeetsReserve,
            }),
            Eligibility::classify(ResourceSnapshot {
                power: PowerState::OnAc,
                network_cost: NetworkCostState::Unknown,
                disk_reserve: DiskReserveState::MeetsReserve,
            }),
            Eligibility::classify(ResourceSnapshot {
                power: PowerState::OnAc,
                network_cost: NetworkCostState::Unmetered,
                disk_reserve: DiskReserveState::Unknown,
            }),
        ];
        for eligibility in unknowns {
            assert!(matches!(eligibility, Eligibility::Blocked(_)));
        }
        // 未知原因精确到位。
        assert_eq!(
            Eligibility::classify(ResourceSnapshot {
                power: PowerState::Unknown,
                network_cost: NetworkCostState::Unmetered,
                disk_reserve: DiskReserveState::MeetsReserve,
            }),
            Eligibility::Blocked(EligibilityReason::UnknownPower)
        );
    }

    #[test]
    fn eligibility_reports_specific_known_conditions() {
        assert_eq!(
            Eligibility::classify(ResourceSnapshot {
                power: PowerState::OnBattery,
                network_cost: NetworkCostState::Unmetered,
                disk_reserve: DiskReserveState::MeetsReserve,
            }),
            Eligibility::Blocked(EligibilityReason::OnBattery)
        );
        assert_eq!(
            Eligibility::classify(ResourceSnapshot {
                power: PowerState::OnAc,
                network_cost: NetworkCostState::Metered,
                disk_reserve: DiskReserveState::MeetsReserve,
            }),
            Eligibility::Blocked(EligibilityReason::MeteredNetwork)
        );
        assert_eq!(
            Eligibility::classify(ResourceSnapshot {
                power: PowerState::OnAc,
                network_cost: NetworkCostState::Unmetered,
                disk_reserve: DiskReserveState::BelowReserve,
            }),
            Eligibility::Blocked(EligibilityReason::BelowDiskReserve)
        );
    }

    #[test]
    fn disk_reserve_requires_both_bytes_and_percent() {
        let policy = reserve(10 * 1024 * 1024, 10);
        // 卷总字节 100 MiB → 10% 保留 = 10 MiB。
        let total = 100 * 1024 * 1024;
        assert_eq!(
            classify_disk_reserve(5 * 1024 * 1024, total, &policy),
            DiskReserveState::BelowReserve
        );
        assert_eq!(
            classify_disk_reserve(12 * 1024 * 1024, total, &policy),
            DiskReserveState::MeetsReserve
        );
        // 满足字节（15 MiB >= 10 MiB）但不满足百分比（10% of 200 MiB = 20 MiB）→ Below。
        assert_eq!(
            classify_disk_reserve(15 * 1024 * 1024, 200 * 1024 * 1024, &policy),
            DiskReserveState::BelowReserve
        );
        // 满足百分比（10 MiB >= 5 MiB）但不满足字节（< 20 MiB）→ Below。
        let big_byte_reserve = reserve(20 * 1024 * 1024, 5);
        assert_eq!(
            classify_disk_reserve(10 * 1024 * 1024, total, &big_byte_reserve),
            DiskReserveState::BelowReserve
        );
    }

    #[test]
    fn disk_reserve_unknown_when_total_is_zero() {
        let policy = reserve(10 * 1024 * 1024, 10);
        assert_eq!(
            classify_disk_reserve(100, 0, &policy),
            DiskReserveState::Unknown
        );
    }

    /// 用一个 fake 探针驱动 trait 默认方法（snapshot / eligibility / disk_reserve_state）。
    struct FakeProbe {
        power: PowerState,
        network: NetworkCostState,
        free: Option<(u64, u64)>,
    }

    impl ResourceProbe for FakeProbe {
        fn power_state(&self) -> PowerState {
            self.power
        }
        fn network_cost_state(&self) -> NetworkCostState {
            self.network
        }
        fn free_space_bytes(&self, _cache_root: &Path) -> Option<(u64, u64)> {
            self.free
        }
    }

    #[test]
    fn fake_probe_returns_snapshot_and_eligibility() {
        let path = Path::new("C:/cache");
        let policy = reserve(10 * 1024 * 1024, 10);

        let probe = FakeProbe {
            power: PowerState::OnAc,
            network: NetworkCostState::Unmetered,
            free: Some((50 * 1024 * 1024, 100 * 1024 * 1024)),
        };
        assert_eq!(
            probe.snapshot(path, &policy),
            ResourceSnapshot {
                power: PowerState::OnAc,
                network_cost: NetworkCostState::Unmetered,
                disk_reserve: DiskReserveState::MeetsReserve,
            }
        );
        assert_eq!(probe.eligibility(path, &policy), Eligibility::Allowed);
    }

    #[test]
    fn fake_probe_with_unknown_free_space_fails_closed() {
        let path = Path::new("C:/cache");
        let policy = reserve(10 * 1024 * 1024, 10);
        let probe = FakeProbe {
            power: PowerState::OnAc,
            network: NetworkCostState::Unmetered,
            free: None, // 磁盘探测失败 → Unknown → blocked
        };
        assert_eq!(
            probe.eligibility(path, &policy),
            Eligibility::Blocked(EligibilityReason::UnknownDiskReserve)
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn system_probe_fails_closed_on_non_windows() {
        let probe = SystemResourceProbe::new();
        let path = Path::new("/tmp/cache");
        let policy = reserve(10 * 1024 * 1024, 10);
        assert!(matches!(
            probe.eligibility(path, &policy),
            Eligibility::Blocked(_)
        ));
    }
}
