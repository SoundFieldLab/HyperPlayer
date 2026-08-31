use crate::error::{EngineError, Result};
use crate::model::MediaId;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CacheAccessClass {
    Public,
    AccountEntitled { owner_user_id: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntitlementSnapshot {
    pub product: String,
    pub valid_until_unix_ms: Option<u64>,
    pub server_revision: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CacheEntry {
    pub content_id: MediaId,
    pub quality: String,
    pub content_hash: String,
    pub access_class: CacheAccessClass,
    pub entitlement_snapshot: Option<EntitlementSnapshot>,
    pub last_validated_unix_ms: Option<u64>,
    pub official_source: String,
    pub state: CacheState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheState {
    Available,
    LockedEntitlement,
    Partial,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verification {
    Confirmed,
    Denied,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybackAuthorization {
    pub current_user_id: Option<u64>,
    pub entitlement: Verification,
    pub official_full_playback: Verification,
    pub validated_at: Option<SystemTime>,
}

pub const DEFAULT_ENTITLEMENT_MAX_AGE: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CacheGateDenial {
    CacheUnavailable,
    NotLoggedIn,
    AccountMismatch,
    EntitlementNotConfirmed,
    OfficialPlaybackNotConfirmed,
    ValidationMissing,
}

pub fn authorize_cache(
    entry: &CacheEntry,
    authorization: &PlaybackAuthorization,
) -> std::result::Result<(), CacheGateDenial> {
    authorize_cache_at(
        entry,
        authorization,
        SystemTime::now(),
        DEFAULT_ENTITLEMENT_MAX_AGE,
    )
}

pub fn authorize_cache_at(
    entry: &CacheEntry,
    authorization: &PlaybackAuthorization,
    now: SystemTime,
    max_validation_age: Duration,
) -> std::result::Result<(), CacheGateDenial> {
    if entry.state != CacheState::Available {
        return Err(CacheGateDenial::CacheUnavailable);
    }
    if authorization.official_full_playback != Verification::Confirmed {
        return Err(CacheGateDenial::OfficialPlaybackNotConfirmed);
    }
    match entry.access_class {
        CacheAccessClass::Public => Ok(()),
        CacheAccessClass::AccountEntitled { owner_user_id } => {
            let current_user_id = authorization
                .current_user_id
                .ok_or(CacheGateDenial::NotLoggedIn)?;
            if current_user_id != owner_user_id {
                return Err(CacheGateDenial::AccountMismatch);
            }
            if authorization.entitlement != Verification::Confirmed {
                return Err(CacheGateDenial::EntitlementNotConfirmed);
            }
            let validated_at = authorization
                .validated_at
                .ok_or(CacheGateDenial::ValidationMissing)?;
            let age = now
                .duration_since(validated_at)
                .map_err(|_| CacheGateDenial::ValidationMissing)?;
            if age > max_validation_age {
                return Err(CacheGateDenial::ValidationMissing);
            }
            let now_unix_ms = system_time_unix_ms(now).ok_or(CacheGateDenial::ValidationMissing)?;
            let entry_validated_at = entry
                .last_validated_unix_ms
                .ok_or(CacheGateDenial::ValidationMissing)?;
            let max_age_ms = u64::try_from(max_validation_age.as_millis()).unwrap_or(u64::MAX);
            if entry_validated_at > now_unix_ms
                || now_unix_ms.saturating_sub(entry_validated_at) > max_age_ms
            {
                return Err(CacheGateDenial::ValidationMissing);
            }
            let snapshot = entry
                .entitlement_snapshot
                .as_ref()
                .ok_or(CacheGateDenial::ValidationMissing)?;
            snapshot
                .server_revision
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or(CacheGateDenial::ValidationMissing)?;
            let expires_at = snapshot
                .valid_until_unix_ms
                .ok_or(CacheGateDenial::EntitlementNotConfirmed)?;
            if now_unix_ms >= expires_at {
                return Err(CacheGateDenial::EntitlementNotConfirmed);
            }
            Ok(())
        }
    }
}

fn system_time_unix_ms(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CacheLease {
    NextTrackPrefetch,
    AlbumPrefetch { album_id: String },
    RecentHistory,
}

impl CacheLease {
    pub fn stable_key(&self) -> String {
        match self {
            Self::NextTrackPrefetch => "next_track_prefetch".into(),
            Self::AlbumPrefetch { album_id } => format!("album_prefetch:{album_id}"),
            Self::RecentHistory => "recent_history".into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheObject {
    pub content_hash: String,
    pub size_bytes: u64,
    pub path: PathBuf,
}

pub struct PartialCacheObject {
    content_hash: String,
    final_path: PathBuf,
    partial_path: PathBuf,
    file: File,
}

impl PartialCacheObject {
    pub fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        self.file.write_all(bytes)?;
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.partial_path
    }

    pub fn complete(mut self) -> Result<CacheObject> {
        self.file.flush()?;
        self.file.sync_all()?;
        drop(self.file);
        let actual_hash = sha256_file(&self.partial_path)?;
        if actual_hash != self.content_hash {
            let _ = fs::remove_file(&self.partial_path);
            return Err(EngineError::InvalidInput(
                "cache content hash mismatch".into(),
            ));
        }
        let size_bytes = fs::metadata(&self.partial_path)?.len();
        match fs::rename(&self.partial_path, &self.final_path) {
            Ok(()) => {}
            Err(error) if self.final_path.exists() => {
                fs::remove_file(&self.partial_path)?;
                if sha256_file(&self.final_path)? != self.content_hash {
                    return Err(EngineError::Io(error));
                }
            }
            Err(error) => return Err(error.into()),
        }
        Ok(CacheObject {
            content_hash: self.content_hash,
            size_bytes,
            path: self.final_path,
        })
    }

    pub fn discard(self) -> Result<()> {
        drop(self.file);
        if self.partial_path.exists() {
            fs::remove_file(self.partial_path)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct ContentAddressedCache {
    root: PathBuf,
}

impl ContentAddressedCache {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(root.join("objects"))?;
        fs::create_dir_all(root.join("partial"))?;
        Ok(Self { root })
    }

    pub fn object_path(&self, content_hash: &str) -> Result<PathBuf> {
        validate_content_hash(content_hash)?;
        Ok(self.root.join("objects").join(content_hash))
    }

    pub fn begin_partial(&self, content_hash: &str) -> Result<PartialCacheObject> {
        let final_path = self.object_path(content_hash)?;
        let partial_path = self
            .root
            .join("partial")
            .join(format!("{content_hash}.part"));
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&partial_path)?;
        Ok(PartialCacheObject {
            content_hash: content_hash.to_owned(),
            final_path,
            partial_path,
            file,
        })
    }

    pub fn open(&self, content_hash: &str) -> Result<File> {
        Ok(File::open(self.object_path(content_hash)?)?)
    }
}

fn validate_content_hash(content_hash: &str) -> Result<()> {
    if content_hash.len() != 64
        || !content_hash
            .bytes()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
    {
        return Err(EngineError::InvalidInput(
            "content hash must be a lowercase SHA-256 hex digest".into(),
        ));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const NOW_MS: u64 = 2_000_000;

    fn vip_entry() -> CacheEntry {
        CacheEntry {
            content_id: MediaId::new("song-1"),
            quality: "lossless".into(),
            content_hash: "a".repeat(64),
            access_class: CacheAccessClass::AccountEntitled { owner_user_id: 42 },
            entitlement_snapshot: Some(EntitlementSnapshot {
                product: "vip".into(),
                valid_until_unix_ms: Some(NOW_MS + 10_000),
                server_revision: Some("rev-1".into()),
            }),
            last_validated_unix_ms: Some(NOW_MS),
            official_source: "netease".into(),
            state: CacheState::Available,
        }
    }

    fn allowed() -> PlaybackAuthorization {
        PlaybackAuthorization {
            current_user_id: Some(42),
            entitlement: Verification::Confirmed,
            official_full_playback: Verification::Confirmed,
            validated_at: Some(UNIX_EPOCH + Duration::from_millis(NOW_MS)),
        }
    }

    #[test]
    fn vip_gate_requires_fresh_unexpired_revisioned_proof() {
        let now = UNIX_EPOCH + Duration::from_millis(NOW_MS);
        assert_eq!(
            authorize_cache_at(&vip_entry(), &allowed(), now, Duration::from_secs(1)),
            Ok(())
        );

        let mut stale = allowed();
        stale.validated_at = Some(now - Duration::from_secs(2));
        assert_eq!(
            authorize_cache_at(&vip_entry(), &stale, now, Duration::from_secs(1)),
            Err(CacheGateDenial::ValidationMissing)
        );
        let mut stale_entry = vip_entry();
        stale_entry.last_validated_unix_ms = Some(NOW_MS - 2_000);
        assert_eq!(
            authorize_cache_at(&stale_entry, &allowed(), now, Duration::from_secs(1)),
            Err(CacheGateDenial::ValidationMissing)
        );
        let mut expired = vip_entry();
        expired
            .entitlement_snapshot
            .as_mut()
            .unwrap()
            .valid_until_unix_ms = Some(NOW_MS);
        assert_eq!(
            authorize_cache_at(&expired, &allowed(), now, Duration::from_secs(1)),
            Err(CacheGateDenial::EntitlementNotConfirmed)
        );
        let mut no_revision = vip_entry();
        no_revision
            .entitlement_snapshot
            .as_mut()
            .unwrap()
            .server_revision = None;
        assert_eq!(
            authorize_cache_at(&no_revision, &allowed(), now, Duration::from_secs(1)),
            Err(CacheGateDenial::ValidationMissing)
        );
    }

    #[test]
    fn account_and_service_failures_are_closed() {
        let now = UNIX_EPOCH + Duration::from_millis(NOW_MS);
        let mut cases = Vec::new();
        let mut value = allowed();
        value.current_user_id = None;
        cases.push(value);
        let mut value = allowed();
        value.current_user_id = Some(7);
        cases.push(value);
        let mut value = allowed();
        value.entitlement = Verification::Unknown;
        cases.push(value);
        let mut value = allowed();
        value.official_full_playback = Verification::Denied;
        cases.push(value);
        assert!(cases.iter().all(|authorization| authorize_cache_at(
            &vip_entry(),
            authorization,
            now,
            Duration::from_secs(1)
        )
        .is_err()));
    }

    #[test]
    fn partial_completion_is_hash_checked_and_atomic() {
        let root = tempdir().unwrap();
        let cache = ContentAddressedCache::new(root.path()).unwrap();
        let hash = format!("{:x}", Sha256::digest(b"payload"));
        let mut partial = cache.begin_partial(&hash).unwrap();
        partial.write_all(b"payload").unwrap();
        let partial_path = partial.path().to_path_buf();
        let object = partial.complete().unwrap();

        assert!(!partial_path.exists());
        assert_eq!(object.path, cache.object_path(&hash).unwrap());
        assert_eq!(object.size_bytes, 7);
        let mut bytes = Vec::new();
        cache.open(&hash).unwrap().read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"payload");
    }

    #[test]
    fn hash_mismatch_removes_partial() {
        let root = tempdir().unwrap();
        let cache = ContentAddressedCache::new(root.path()).unwrap();
        let mut partial = cache.begin_partial(&"0".repeat(64)).unwrap();
        partial.write_all(b"wrong").unwrap();
        let partial_path = partial.path().to_path_buf();
        assert!(partial.complete().is_err());
        assert!(!partial_path.exists());
    }
}
