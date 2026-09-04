/// 本地曲库扫描收录的可播放扩展名（D34 Q9：WebView2 原生格式集）。
/// APE/DSF/DFF 等 WebView2 不支持的格式不收录。
pub const PLAYABLE_LOCAL_EXTENSIONS: &[&str] = &["mp3", "flac", "aac", "ogg", "wav", "m4a", "oga"];

use crate::error::{EngineError, Result};
use crate::model::{MediaId, MediaSource, Track};
use crate::repository::{LibraryTrack, ScanRepository};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, ItemKey};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScanReport {
    pub discovered: usize,
    pub tracks: Vec<LibraryTrack>,
    pub failures: Vec<ScanFailure>,
    pub cancelled: bool,
    pub removed_missing: usize,
}

#[derive(Default)]
pub struct ScanCancellation {
    cancelled: AtomicBool,
}

impl ScanCancellation {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanFailure {
    pub path: PathBuf,
    pub message: String,
}

pub trait MetadataReader: Send + Sync {
    fn read(&self, path: &Path) -> Result<LibraryTrack>;
}

#[derive(Default)]
pub struct LoftyMetadataReader;

impl MetadataReader for LoftyMetadataReader {
    fn read(&self, path: &Path) -> Result<LibraryTrack> {
        let metadata = fs::metadata(path)?;
        let tagged_file = lofty::read_from_path(path)?;
        let properties = tagged_file.properties();
        let tag = tagged_file
            .primary_tag()
            .or_else(|| tagged_file.first_tag());
        let fallback_title = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Unknown track")
            .to_owned();
        let title = tag
            .and_then(|value| value.title())
            .map(|value| value.into_owned())
            .unwrap_or(fallback_title);
        let artists = tag
            .and_then(|value| value.artist())
            .map(|value| split_artists(&value))
            .unwrap_or_default();
        let album = tag
            .and_then(|value| value.album())
            .map(|value| value.into_owned());
        let album_artist = tag
            .and_then(|value| value.get_string(ItemKey::AlbumArtist))
            .map(str::to_owned)
            .or_else(|| artists.first().cloned());
        let album_id = album.as_deref().map(|title| {
            stable_entity_id("album", &[title, album_artist.as_deref().unwrap_or("")])
        });
        let artist_ids = artists
            .iter()
            .map(|artist| stable_entity_id("artist", &[artist]))
            .collect();
        let (artwork_hash, artwork_mime) = tag
            .and_then(|value| value.pictures().first())
            .filter(|picture| !picture.data().is_empty())
            .map(|picture| {
                (
                    Some(format!("{:x}", Sha256::digest(picture.data()))),
                    picture.mime_type().map(ToString::to_string),
                )
            })
            .unwrap_or_default();
        let duration_ms = u64::try_from(properties.duration().as_millis()).unwrap_or(u64::MAX);
        let modified_unix_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| u64::try_from(duration.as_millis()).ok())
            .unwrap_or(0);

        Ok(LibraryTrack {
            track: Track {
                id: MediaId::new(local_media_id(path)),
                source: MediaSource::Local {
                    path: path.to_path_buf(),
                },
                title,
                artists,
                album,
                album_id,
                artist_ids,
                artwork_hash,
                artwork_mime,
                duration_ms: Some(duration_ms),
            },
            path: path.to_path_buf(),
            file_size: metadata.len(),
            modified_unix_ms,
            sample_rate: properties.sample_rate(),
            channels: properties.channels(),
            bitrate_kbps: properties.audio_bitrate(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtworkObject {
    pub content_hash: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct ContentAddressedArtwork {
    root: PathBuf,
}

impl ContentAddressedArtwork {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(&root)?;
        Ok(Self { root })
    }

    pub fn store(&self, object: &ArtworkObject) -> Result<PathBuf> {
        validate_artwork_hash(&object.content_hash)?;
        if object.bytes.is_empty() {
            return Err(EngineError::InvalidInput("artwork bytes are empty".into()));
        }
        if format!("{:x}", Sha256::digest(&object.bytes)) != object.content_hash {
            return Err(EngineError::InvalidInput(
                "artwork content hash mismatch".into(),
            ));
        }
        let final_path = self.root.join(&object.content_hash);
        if final_path.exists() {
            return Ok(final_path);
        }
        let partial = self.root.join(format!("{}.part", object.content_hash));
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&partial)?;
        file.write_all(&object.bytes)?;
        file.sync_all()?;
        drop(file);
        match fs::rename(&partial, &final_path) {
            Ok(()) => Ok(final_path),
            Err(_error) if final_path.exists() => {
                let _ = fs::remove_file(partial);
                Ok(final_path)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn read(&self, content_hash: &str) -> Result<Vec<u8>> {
        validate_artwork_hash(content_hash)?;
        Ok(fs::read(self.root.join(content_hash))?)
    }
}

pub fn read_embedded_lyrics(path: &Path) -> Result<Option<String>> {
    const MAX_EMBEDDED_LYRICS_BYTES: usize = 1024 * 1024;

    let tagged_file = lofty::read_from_path(path)?;
    let Some(tag) = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag())
    else {
        return Ok(None);
    };
    for key in [ItemKey::Lyrics, ItemKey::UnsyncLyrics] {
        if let Some(value) = tag.get_string(key) {
            if value.len() > MAX_EMBEDDED_LYRICS_BYTES {
                return Err(EngineError::InvalidInput(
                    "embedded lyrics exceed the size limit".into(),
                ));
            }
            if !value.trim().is_empty() {
                return Ok(Some(value.to_owned()));
            }
        }
    }
    Ok(None)
}

pub fn read_embedded_artwork(path: &Path) -> Result<Option<ArtworkObject>> {
    let tagged_file = lofty::read_from_path(path)?;
    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());
    let Some(picture) = tag.and_then(|value| value.pictures().first()) else {
        return Ok(None);
    };
    if picture.data().is_empty() {
        return Ok(None);
    }
    let bytes = picture.data().to_vec();
    Ok(Some(ArtworkObject {
        content_hash: format!("{:x}", Sha256::digest(&bytes)),
        mime_type: picture
            .mime_type()
            .map(ToString::to_string)
            .unwrap_or_else(|| "application/octet-stream".into()),
        bytes,
    }))
}

fn validate_artwork_hash(content_hash: &str) -> Result<()> {
    if content_hash.len() != 64
        || !content_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(EngineError::InvalidInput(
            "artwork hash must be a lowercase SHA-256 hex digest".into(),
        ));
    }
    Ok(())
}

pub struct LibraryScanner<R = LoftyMetadataReader> {
    reader: R,
}

impl Default for LibraryScanner<LoftyMetadataReader> {
    fn default() -> Self {
        Self {
            reader: LoftyMetadataReader,
        }
    }
}

impl<R: MetadataReader> LibraryScanner<R> {
    pub fn new(reader: R) -> Self {
        Self { reader }
    }

    pub fn scan(&self, roots: &[PathBuf]) -> Result<ScanReport> {
        self.scan_with_cancel(roots, &ScanCancellation::default())
    }

    pub fn scan_with_cancel(
        &self,
        roots: &[PathBuf],
        cancellation: &ScanCancellation,
    ) -> Result<ScanReport> {
        if roots.is_empty() {
            return Err(EngineError::InvalidInput(
                "at least one scan root is required".into(),
            ));
        }
        let mut report = ScanReport::default();
        let mut pending: VecDeque<PathBuf> = roots.iter().cloned().collect();

        while let Some(path) = pending.pop_front() {
            if cancellation.is_cancelled() {
                report.cancelled = true;
                break;
            }
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    report.failures.push(ScanFailure {
                        path,
                        message: error.to_string(),
                    });
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                match fs::read_dir(&path) {
                    Ok(entries) => {
                        for entry in entries {
                            match entry {
                                Ok(entry) => pending.push_back(entry.path()),
                                Err(error) => report.failures.push(ScanFailure {
                                    path: path.clone(),
                                    message: error.to_string(),
                                }),
                            }
                        }
                    }
                    Err(error) => report.failures.push(ScanFailure {
                        path,
                        message: error.to_string(),
                    }),
                }
            } else if metadata.is_file() && is_supported_audio(&path) {
                report.discovered += 1;
                match self.reader.read(&path) {
                    Ok(track) => report.tracks.push(track),
                    Err(error) => report.failures.push(ScanFailure {
                        path,
                        message: error.to_string(),
                    }),
                }
            }
        }
        report
            .tracks
            .sort_by(|left, right| left.path.cmp(&right.path));
        Ok(report)
    }

    pub fn scan_incremental<P: ScanRepository>(
        &self,
        root: &Path,
        repository: &mut P,
        cancellation: &ScanCancellation,
    ) -> Result<ScanReport> {
        let mut report = self.scan_with_cancel(&[root.to_path_buf()], cancellation)?;
        let mut found = Vec::with_capacity(report.tracks.len());
        for track in &report.tracks {
            repository.upsert_scanned_track(track)?;
            found.push(track.path.clone());
        }
        if !report.cancelled {
            report.removed_missing = repository.finish_scan(root, &found)?;
        }
        Ok(report)
    }
}

pub fn is_supported_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| {
            PLAYABLE_LOCAL_EXTENSIONS
                .iter()
                .any(|extension| value.eq_ignore_ascii_case(extension))
        })
        .unwrap_or(false)
}

fn split_artists(value: &str) -> Vec<String> {
    value
        .split([';', '/', '\u{1f}'])
        .map(str::trim)
        .filter(|artist| !artist.is_empty())
        .map(str::to_owned)
        .collect()
}

pub fn stable_entity_id(kind: &str, components: &[&str]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(kind.as_bytes());
    for component in components {
        hasher.update([0]);
        hasher.update(component.trim().to_lowercase().as_bytes());
    }
    format!("{kind}:{:x}", hasher.finalize())
}

fn local_media_id(path: &Path) -> String {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    stable_entity_id("local", &[&canonical.to_string_lossy().replace('\\', "/")])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::tempdir;

    struct FakeReader {
        paths: Mutex<Vec<PathBuf>>,
    }

    impl MetadataReader for FakeReader {
        fn read(&self, path: &Path) -> Result<LibraryTrack> {
            self.paths.lock().unwrap().push(path.to_path_buf());
            Ok(LibraryTrack {
                track: Track {
                    id: MediaId::new(local_media_id(path)),
                    source: MediaSource::Local {
                        path: path.to_path_buf(),
                    },
                    title: "test".into(),
                    artists: vec![],
                    album: None,
                    album_id: None,
                    artist_ids: vec![],
                    artwork_hash: None,
                    artwork_mime: None,
                    duration_ms: None,
                },
                path: path.to_path_buf(),
                file_size: 0,
                modified_unix_ms: 0,
                sample_rate: None,
                channels: None,
                bitrate_kbps: None,
            })
        }
    }

    #[test]
    fn recursively_scans_supported_files_only() {
        let root = tempdir().unwrap();
        let nested = root.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(root.path().join("one.MP3"), []).unwrap();
        fs::write(nested.join("two.flac"), []).unwrap();
        fs::write(nested.join("three.WaV"), []).unwrap();
        fs::write(nested.join("notes.txt"), []).unwrap();
        let scanner = LibraryScanner::new(FakeReader {
            paths: Mutex::new(vec![]),
        });

        let report = scanner.scan(&[root.path().to_path_buf()]).unwrap();
        assert_eq!(report.discovered, 3);
        assert_eq!(report.tracks.len(), 3);
        assert!(report.failures.is_empty());
    }

    #[test]
    fn lofty_reads_real_wav_properties_and_falls_back_to_file_name() {
        let root = tempdir().unwrap();
        let path = root.path().join("plain.wav");
        fs::write(&path, minimal_wav()).unwrap();

        let track = LoftyMetadataReader.read(&path).unwrap();
        assert_eq!(track.track.title, "plain");
        assert_eq!(track.sample_rate, Some(8_000));
        assert_eq!(track.channels, Some(1));
        assert_eq!(track.track.duration_ms, Some(1));
    }

    fn minimal_wav() -> Vec<u8> {
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
        for sample in samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        wav
    }

    #[test]
    fn scanner_uses_the_decoder_playable_extension_set() {
        // D34 Q9：本地格式集 = WebView2 原生支持集
        assert_eq!(
            PLAYABLE_LOCAL_EXTENSIONS,
            &["mp3", "flac", "aac", "ogg", "wav", "m4a", "oga"]
        );
        for extension in PLAYABLE_LOCAL_EXTENSIONS {
            assert!(is_supported_audio(Path::new(&format!(
                "song.{}",
                extension.to_ascii_uppercase()
            ))));
        }
        for extension in ["ape", "dsf", "dff", "aif", "aiff", "wv", "mp4", "opus"] {
            assert!(!is_supported_audio(Path::new(&format!("song.{extension}"))));
        }
        assert!(!is_supported_audio(Path::new("cover.jpg")));
    }

    #[test]
    fn malformed_playable_files_fail_metadata_while_unsupported_files_are_ignored() {
        let root = tempdir().unwrap();
        for extension in PLAYABLE_LOCAL_EXTENSIONS {
            fs::write(root.path().join(format!("broken.{extension}")), b"broken").unwrap();
        }
        for extension in ["ape", "dsf", "dff", "aif", "aiff", "wv", "mp4", "opus"] {
            fs::write(root.path().join(format!("ignored.{extension}")), b"broken").unwrap();
        }

        let report = LibraryScanner::default()
            .scan(&[root.path().to_path_buf()])
            .unwrap();

        assert_eq!(report.discovered, PLAYABLE_LOCAL_EXTENSIONS.len());
        assert!(report.tracks.is_empty());
        assert_eq!(report.failures.len(), PLAYABLE_LOCAL_EXTENSIONS.len());
        assert!(report.failures.iter().all(|failure| {
            failure.path.extension().is_some_and(|extension| {
                PLAYABLE_LOCAL_EXTENSIONS
                    .iter()
                    .any(|playable| extension.eq_ignore_ascii_case(playable))
            })
        }));
    }

    struct CancellingRepository {
        finishes: usize,
    }

    impl ScanRepository for CancellingRepository {
        fn upsert_scanned_track(&self, _track: &LibraryTrack) -> Result<()> {
            Ok(())
        }

        fn finish_scan(&mut self, _root: &Path, _found: &[PathBuf]) -> Result<usize> {
            self.finishes += 1;
            Ok(4)
        }
    }

    #[test]
    fn cancelled_incremental_scan_never_removes_missing_rows() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("one.mp3"), []).unwrap();
        let scanner = LibraryScanner::new(FakeReader {
            paths: Mutex::new(vec![]),
        });
        let cancellation = ScanCancellation::default();
        cancellation.cancel();
        let mut repository = CancellingRepository { finishes: 0 };

        let report = scanner
            .scan_incremental(root.path(), &mut repository, &cancellation)
            .unwrap();
        assert!(report.cancelled);
        assert_eq!(report.removed_missing, 0);
        assert_eq!(repository.finishes, 0);
    }
}
