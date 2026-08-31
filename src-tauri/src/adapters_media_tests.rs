use super::*;
use hyperplayer_engine::cache::{CacheEntry, EntitlementSnapshot};
use hyperplayer_engine::MediaHandleKind;
use std::sync::atomic::AtomicUsize;

struct FakePlaybackBackend {
    authorization: PlaybackAuthorization,
    bytes: Vec<u8>,
    streams: AtomicUsize,
}

#[async_trait]
impl PlaybackMediaBackend for FakePlaybackBackend {
    async fn resolve_official(&self, track: &TrackRefDto) -> AppResult<OfficialPlaybackResource> {
        let song_id = parse_netease_id(&track.id)?;
        Ok(OfficialPlaybackResource {
            track: Track {
                id: MediaId::new(&track.id),
                source: MediaSource::Netease { song_id },
                title: "Remote".into(),
                artists: vec![],
                album: None,
                album_id: None,
                artist_ids: vec![],
                artwork_hash: None,
                artwork_mime: None,
                duration_ms: None,
            },
            url: "https://m10.music.126.net/injected".into(),
            authorization: self.authorization.clone(),
        })
    }

    async fn refresh_authorization(&self, _entry: &CacheEntry) -> AppResult<PlaybackAuthorization> {
        Ok(self.authorization.clone())
    }

    async fn stream_official(&self, _url: &str, destination: &mut std::fs::File) -> AppResult<()> {
        self.streams.fetch_add(1, Ordering::SeqCst);
        destination.write_all(&self.bytes)?;
        Ok(())
    }
}

fn authorization(official: Verification) -> PlaybackAuthorization {
    PlaybackAuthorization {
        current_user_id: None,
        entitlement: Verification::Unknown,
        official_full_playback: official,
        validated_at: None,
    }
}

fn track_ref() -> TrackRefDto {
    TrackRefDto {
        id: "42".into(),
        source: TrackSourceDto::Netease,
    }
}

fn resolver(
    repository: Repository,
    backend: Arc<dyn PlaybackMediaBackend>,
    root: &Path,
) -> TrackResolver {
    TrackResolver::new(
        repository,
        Arc::new(LocationRegistry::in_memory().unwrap()),
        backend,
        root.join("cache"),
        root.join("temporary"),
    )
    .unwrap()
}

fn wav() -> Vec<u8> {
    let samples = [0_i16; 8];
    let data_size = u32::try_from(samples.len() * 2).unwrap();
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_size).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&8_000_u32.to_le_bytes());
    wav.extend_from_slice(&16_000_u32.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    wav.extend(samples.iter().flat_map(|sample| sample.to_le_bytes()));
    wav
}

#[test]
fn public_cache_is_used_only_after_official_authorization() {
    let root = tempfile::tempdir().unwrap();
    let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
    let store = ContentAddressedCache::new(root.path().join("cache")).unwrap();
    let bytes = wav();
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let mut partial = store.begin_partial(&hash).unwrap();
    partial.write_all(&bytes).unwrap();
    let object = partial.complete().unwrap();
    let entry = CacheEntry {
        content_id: MediaId::new("42"),
        quality: "standard".into(),
        content_hash: hash,
        access_class: CacheAccessClass::Public,
        entitlement_snapshot: None,
        last_validated_unix_ms: None,
        official_source: "netease".into(),
        state: CacheState::Available,
    };
    {
        let repository = repository.lock().unwrap();
        repository
            .record_cache_object(&object, unix_millis())
            .unwrap();
        repository.upsert_cache_entry(&entry).unwrap();
    }
    let backend = Arc::new(FakePlaybackBackend {
        authorization: authorization(Verification::Confirmed),
        bytes: vec![],
        streams: AtomicUsize::new(0),
    });
    let resolver = resolver(repository, backend.clone(), root.path());

    let media = tauri::async_runtime::block_on(resolver.resolve(&track_ref())).unwrap();
    assert_eq!(media.handle.kind(), MediaHandleKind::PrivateCache);
    assert_eq!(backend.streams.load(Ordering::SeqCst), 0);
}

#[test]
fn vip_cache_fails_closed_without_fresh_entitlement() {
    let root = tempfile::tempdir().unwrap();
    let repository = Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap()));
    repository
        .lock()
        .unwrap()
        .upsert_cache_entry(&CacheEntry {
            content_id: MediaId::new("42"),
            quality: "lossless".into(),
            content_hash: "a".repeat(64),
            access_class: CacheAccessClass::AccountEntitled { owner_user_id: 7 },
            entitlement_snapshot: Some(EntitlementSnapshot {
                product: "vip".into(),
                valid_until_unix_ms: Some(unix_millis() + 60_000),
                server_revision: Some("r1".into()),
            }),
            last_validated_unix_ms: Some(unix_millis()),
            official_source: "netease".into(),
            state: CacheState::Available,
        })
        .unwrap();
    let backend = Arc::new(FakePlaybackBackend {
        authorization: authorization(Verification::Confirmed),
        bytes: wav(),
        streams: AtomicUsize::new(0),
    });
    let resolver = resolver(repository, backend.clone(), root.path());

    assert!(matches!(
        tauri::async_runtime::block_on(resolver.resolve(&track_ref())),
        Err(AppError::Unavailable(_))
    ));
    assert_eq!(backend.streams.load(Ordering::SeqCst), 0);
}

#[test]
fn netease_url_streams_to_private_temporary_media_without_network() {
    let root = tempfile::tempdir().unwrap();
    let backend = Arc::new(FakePlaybackBackend {
        authorization: authorization(Verification::Confirmed),
        bytes: wav(),
        streams: AtomicUsize::new(0),
    });
    let resolver = resolver(
        Arc::new(Mutex::new(SqliteRepository::in_memory().unwrap())),
        backend.clone(),
        root.path(),
    );

    let media = tauri::async_runtime::block_on(resolver.resolve(&track_ref())).unwrap();
    assert_eq!(media.handle.kind(), MediaHandleKind::PrivateTemporary);
    let mut bytes = Vec::new();
    media
        .handle
        .try_clone_file()
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, wav());
    assert_eq!(backend.streams.load(Ordering::SeqCst), 1);
}
