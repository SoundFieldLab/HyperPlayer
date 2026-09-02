use crate::cache::{CacheAcquisitionClass, CacheState};
use crate::error::{EngineError, Result};
use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

pub const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DiskReservePolicy {
    pub minimum_bytes: u64,
    pub minimum_percent: u8,
    pub resume_bytes: u64,
    pub resume_percent: u8,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachePolicy {
    pub capacity_bytes: u64,
    pub trim_percent: u8,
    pub recent_track_limit: usize,
    pub partial_max_age: Duration,
    pub public_proof_max_age: Duration,
    pub disk_reserve: DiskReservePolicy,
}

impl Default for CachePolicy {
    fn default() -> Self {
        Self {
            capacity_bytes: 10 * GIB,
            trim_percent: 90,
            recent_track_limit: 100,
            partial_max_age: Duration::from_secs(24 * 60 * 60),
            public_proof_max_age: Duration::from_secs(7 * 24 * 60 * 60),
            disk_reserve: DiskReservePolicy {
                minimum_bytes: 10 * GIB,
                minimum_percent: 10,
                resume_bytes: 12 * GIB,
                resume_percent: 12,
            },
        }
    }
}

impl CachePolicy {
    pub fn with_capacity_bytes(capacity_bytes: u64) -> Result<Self> {
        let policy = Self {
            capacity_bytes,
            ..Self::default()
        };
        policy.validate()?;
        Ok(policy)
    }

    pub fn validate(&self) -> Result<()> {
        if !(2 * GIB..=100 * GIB).contains(&self.capacity_bytes) {
            return Err(EngineError::InvalidInput(
                "cache capacity must be between 2 GiB and 100 GiB".into(),
            ));
        }
        if self.trim_percent != 90
            || self.recent_track_limit != 100
            || self.partial_max_age.is_zero()
            || self.public_proof_max_age.is_zero()
            || self.disk_reserve.minimum_percent > 100
            || self.disk_reserve.resume_percent > 100
            || self.disk_reserve.resume_bytes < self.disk_reserve.minimum_bytes
            || self.disk_reserve.resume_percent < self.disk_reserve.minimum_percent
        {
            return Err(EngineError::InvalidInput("invalid cache policy".into()));
        }
        Ok(())
    }

    pub fn trim_target_bytes(&self) -> u64 {
        self.capacity_bytes
            .saturating_mul(u64::from(self.trim_percent))
            / 100
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvictionRecord {
    pub content_id: String,
    pub content_hash: String,
    pub logical_size_bytes: u64,
    pub state: CacheState,
    pub acquisition_class: CacheAcquisitionClass,
    pub last_accessed_unix_ms: u64,
    pub partial_created_unix_ms: Option<u64>,
    pub orphan: bool,
}

impl EvictionRecord {
    pub fn new(
        content_id: impl Into<String>,
        content_hash: impl Into<String>,
        logical_size_bytes: u64,
        state: CacheState,
        acquisition_class: CacheAcquisitionClass,
        last_accessed_unix_ms: u64,
    ) -> Self {
        Self {
            content_id: content_id.into(),
            content_hash: content_hash.into(),
            logical_size_bytes,
            state,
            acquisition_class,
            last_accessed_unix_ms,
            partial_created_unix_ms: None,
            orphan: false,
        }
    }

    pub fn partial(
        content_id: impl Into<String>,
        content_hash: impl Into<String>,
        logical_size_bytes: u64,
        partial_created_unix_ms: u64,
    ) -> Self {
        let mut record = Self::new(
            content_id,
            content_hash,
            logical_size_bytes,
            CacheState::Partial,
            CacheAcquisitionClass::Automatic,
            partial_created_unix_ms,
        );
        record.partial_created_unix_ms = Some(partial_created_unix_ms);
        record
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EvictionPlan {
    pub candidates: Vec<EvictionRecord>,
    pub projected_size_bytes: u64,
}

pub fn plan_eviction(
    policy: &CachePolicy,
    current_size_bytes: u64,
    now_unix_ms: u64,
    records: &[EvictionRecord],
    protected_hashes: &HashSet<String>,
    recent_distinct_tracks: &[String],
) -> EvictionPlan {
    if current_size_bytes < policy.capacity_bytes {
        return EvictionPlan {
            projected_size_bytes: current_size_bytes,
            ..EvictionPlan::default()
        };
    }
    let recent: HashSet<&str> = recent_distinct_tracks
        .iter()
        .take(policy.recent_track_limit)
        .map(String::as_str)
        .collect();
    let partial_max_age_ms = u64::try_from(policy.partial_max_age.as_millis()).unwrap_or(u64::MAX);
    let mut grouped: BTreeMap<&str, Vec<EvictionRecord>> = BTreeMap::new();
    for record in records {
        grouped
            .entry(record.content_hash.as_str())
            .or_default()
            .push(record.clone());
    }

    let mut groups = Vec::new();
    for (hash, mut entries) in grouped {
        if protected_hashes.contains(hash) {
            continue;
        }
        entries.sort_by(|left, right| left.content_id.cmp(&right.content_id));
        let blocked_by_recent = entries.iter().any(|entry| {
            eviction_rank(entry, now_unix_ms, partial_max_age_ms) != 0
                && recent.contains(entry.content_id.as_str())
        });
        if blocked_by_recent {
            continue;
        }
        let rank = entries
            .iter()
            .map(|entry| eviction_rank(entry, now_unix_ms, partial_max_age_ms))
            .max()
            .unwrap_or(5);
        let oldest = entries
            .iter()
            .map(|entry| entry.last_accessed_unix_ms)
            .min()
            .unwrap_or(0);
        let size = entries
            .iter()
            .map(|entry| entry.logical_size_bytes)
            .max()
            .unwrap_or(0);
        groups.push((rank, oldest, hash.to_owned(), size, entries));
    }
    groups.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });

    let target = policy.trim_target_bytes();
    let mut projected = current_size_bytes;
    let mut selected = Vec::new();
    for (_, _, _, size, entries) in groups {
        if projected <= target {
            break;
        }
        projected = projected.saturating_sub(size);
        selected.extend(entries);
    }
    EvictionPlan {
        candidates: selected,
        projected_size_bytes: projected,
    }
}

fn eviction_rank(record: &EvictionRecord, now_unix_ms: u64, partial_max_age_ms: u64) -> u8 {
    let expired_partial = record.state == CacheState::Partial
        && record
            .partial_created_unix_ms
            .is_some_and(|created| now_unix_ms.saturating_sub(created) > partial_max_age_ms);
    if expired_partial || record.orphan {
        return 0;
    }
    if record.state == CacheState::LockedEntitlement {
        return 1;
    }
    match record.acquisition_class {
        CacheAcquisitionClass::FrequentAlbumRemainder => 2,
        CacheAcquisitionClass::Automatic => 3,
        CacheAcquisitionClass::UserRequested => 4,
        CacheAcquisitionClass::RecentPlayback => 5,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DbCacheObject {
    pub content_hash: String,
    pub relative_path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredPartial {
    pub relative_path: PathBuf,
    pub created_unix_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReconciliationInput {
    pub cache_root: PathBuf,
    pub now_unix_ms: u64,
    pub db_objects: Vec<DbCacheObject>,
    pub object_paths: Vec<PathBuf>,
    pub partials: Vec<StoredPartial>,
    pub protected_hashes: HashSet<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReconciliationPlan {
    pub expired_partials: Vec<PathBuf>,
    pub missing_db_objects: Vec<String>,
    pub orphan_objects: Vec<PathBuf>,
}

pub fn plan_reconciliation(
    policy: &CachePolicy,
    input: ReconciliationInput,
) -> Result<ReconciliationPlan> {
    if !input.cache_root.is_absolute() {
        return Err(EngineError::InvalidInput(
            "cache root must be absolute".into(),
        ));
    }
    for object in &input.db_objects {
        validate_relative_cache_path(&object.relative_path)?;
    }
    for path in &input.object_paths {
        validate_relative_cache_path(path)?;
    }
    for partial in &input.partials {
        validate_relative_cache_path(&partial.relative_path)?;
    }

    let max_age_ms = u64::try_from(policy.partial_max_age.as_millis()).unwrap_or(u64::MAX);
    let observed: HashSet<&Path> = input.object_paths.iter().map(PathBuf::as_path).collect();
    let expected: HashSet<&Path> = input
        .db_objects
        .iter()
        .map(|object| object.relative_path.as_path())
        .collect();
    let mut expired_partials: Vec<_> = input
        .partials
        .iter()
        .filter(|partial| input.now_unix_ms.saturating_sub(partial.created_unix_ms) > max_age_ms)
        .map(|partial| partial.relative_path.clone())
        .collect();
    let mut missing_db_objects: Vec<_> = input
        .db_objects
        .iter()
        .filter(|object| {
            // The repository lowers a leased missing object to `partial` at apply time.
            // We therefore still include it in `missing_db_objects` so the apply step can
            // make that lease-safe decision; the protected-hash filter is intentionally
            // not applied to missing objects (it is reserved for the deletion paths).
            object
                .relative_path
                .file_name()
                .and_then(|value| value.to_str())
                != Some(object.content_hash.as_str())
                || !observed.contains(object.relative_path.as_path())
        })
        .map(|object| object.content_hash.clone())
        .collect();
    let mut orphan_objects: Vec<_> = input
        .object_paths
        .iter()
        .filter(|path| {
            !expected.contains(path.as_path())
                && !input.protected_hashes.contains(hash_from_object_path(path))
        })
        .cloned()
        .collect();
    expired_partials.sort();
    missing_db_objects.sort();
    orphan_objects.sort();
    Ok(ReconciliationPlan {
        expired_partials,
        missing_db_objects,
        orphan_objects,
    })
}

fn hash_from_object_path(path: &Path) -> &str {
    path.file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
}

fn validate_relative_cache_path(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(EngineError::InvalidInput(
            "cache path must be a normalized root-relative path".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_validate_and_trim_to_ninety_percent() {
        let policy = CachePolicy::default();
        assert!(policy.validate().is_ok());
        assert_eq!(policy.capacity_bytes, 10 * GIB);
        assert_eq!(policy.trim_target_bytes(), 9 * GIB);
        assert_eq!(policy.recent_track_limit, 100);
        assert_eq!(policy.disk_reserve.minimum_bytes, 10 * GIB);
        assert_eq!(policy.disk_reserve.resume_bytes, 12 * GIB);
        assert!(CachePolicy::with_capacity_bytes(2 * GIB - 1).is_err());
        assert!(CachePolicy::with_capacity_bytes(100 * GIB + 1).is_err());
    }

    #[test]
    fn planner_obeys_order_and_protects_leases_and_normal_recent_only() {
        let policy = CachePolicy::with_capacity_bytes(2 * GIB).unwrap();
        let size = 400 * 1024 * 1024;
        let records = vec![
            EvictionRecord::new(
                "recent",
                "01",
                size,
                CacheState::Available,
                CacheAcquisitionClass::RecentPlayback,
                1,
            ),
            EvictionRecord::new(
                "requested",
                "02",
                size,
                CacheState::Available,
                CacheAcquisitionClass::UserRequested,
                2,
            ),
            EvictionRecord::new(
                "automatic",
                "03",
                size,
                CacheState::Available,
                CacheAcquisitionClass::Automatic,
                3,
            ),
            EvictionRecord::new(
                "album",
                "04",
                size,
                CacheState::Available,
                CacheAcquisitionClass::FrequentAlbumRemainder,
                4,
            ),
            EvictionRecord::new(
                "locked",
                "05",
                size,
                CacheState::LockedEntitlement,
                CacheAcquisitionClass::UserRequested,
                5,
            ),
            EvictionRecord::partial("partial-recent", "06", size, 0),
            EvictionRecord::new(
                "leased",
                "07",
                size,
                CacheState::LockedEntitlement,
                CacheAcquisitionClass::Automatic,
                0,
            ),
            EvictionRecord::new(
                "protected-recent",
                "08",
                size,
                CacheState::Available,
                CacheAcquisitionClass::RecentPlayback,
                0,
            ),
        ];
        let plan = plan_eviction(
            &policy,
            records.len() as u64 * size,
            25 * 60 * 60 * 1_000,
            &records,
            &HashSet::from(["07".into()]),
            &["protected-recent".into(), "partial-recent".into()],
        );
        assert_eq!(
            plan.candidates
                .iter()
                .map(|item| item.content_hash.as_str())
                .collect::<Vec<_>>(),
            vec!["06", "05", "04", "03"]
        );
        assert!(plan.projected_size_bytes <= policy.trim_target_bytes());
    }

    #[test]
    fn shared_hash_is_selected_as_one_group_and_releases_bytes_once() {
        let policy = CachePolicy::with_capacity_bytes(2 * GIB).unwrap();
        let shared_size = 300 * 1024 * 1024;
        let records = vec![
            EvictionRecord::new(
                "a",
                "shared",
                shared_size,
                CacheState::Available,
                CacheAcquisitionClass::Automatic,
                1,
            ),
            EvictionRecord::new(
                "b",
                "shared",
                shared_size,
                CacheState::Available,
                CacheAcquisitionClass::Automatic,
                2,
            ),
        ];
        let plan = plan_eviction(
            &policy,
            policy.capacity_bytes,
            3,
            &records,
            &HashSet::new(),
            &[],
        );
        assert_eq!(plan.candidates.len(), 2);
        assert_eq!(
            plan.projected_size_bytes,
            policy.capacity_bytes - shared_size
        );
    }

    #[test]
    fn reconciliation_matches_hash_and_safe_relative_path() {
        let plan = plan_reconciliation(
            &CachePolicy::default(),
            ReconciliationInput {
                cache_root: PathBuf::from("C:/cache"),
                now_unix_ms: 25 * 60 * 60 * 1_000,
                db_objects: vec![
                    DbCacheObject {
                        content_hash: "present".into(),
                        relative_path: "objects/present".into(),
                    },
                    DbCacheObject {
                        content_hash: "missing".into(),
                        relative_path: "objects/wrong".into(),
                    },
                ],
                object_paths: vec!["objects/present".into(), "objects/orphan".into()],
                partials: vec![StoredPartial {
                    relative_path: "partial/old.part".into(),
                    created_unix_ms: 0,
                }],
                protected_hashes: HashSet::new(),
            },
        )
        .unwrap();
        assert_eq!(
            plan.expired_partials,
            vec![PathBuf::from("partial/old.part")]
        );
        assert_eq!(plan.missing_db_objects, vec!["missing"]);
        assert_eq!(plan.orphan_objects, vec![PathBuf::from("objects/orphan")]);
    }

    #[test]
    fn reconciliation_skips_lease_protected_orphans() {
        let plan = plan_reconciliation(
            &CachePolicy::default(),
            ReconciliationInput {
                cache_root: PathBuf::from("C:/cache"),
                now_unix_ms: 25 * 60 * 60 * 1_000,
                db_objects: vec![],
                object_paths: vec!["objects/leased-orphan".into(), "objects/free-orphan".into()],
                partials: vec![],
                protected_hashes: HashSet::from(["leased-orphan".into()]),
            },
        )
        .unwrap();
        assert_eq!(
            plan.orphan_objects,
            vec![PathBuf::from("objects/free-orphan")]
        );
    }

    #[test]
    fn reconciliation_rejects_traversal_and_absolute_paths() {
        for bad in [PathBuf::from("../escape"), PathBuf::from("C:/escape")] {
            let result = plan_reconciliation(
                &CachePolicy::default(),
                ReconciliationInput {
                    cache_root: PathBuf::from("C:/cache"),
                    now_unix_ms: 0,
                    db_objects: vec![],
                    object_paths: vec![bad],
                    partials: vec![],
                    protected_hashes: HashSet::new(),
                },
            );
            assert!(matches!(result, Err(EngineError::InvalidInput(_))));
        }
    }
}
