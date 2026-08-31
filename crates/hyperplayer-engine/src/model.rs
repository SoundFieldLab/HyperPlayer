use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::PathBuf;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MediaId(pub String);

impl MediaId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
}

impl fmt::Display for MediaId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MediaSource {
    Local { path: PathBuf },
    Netease { song_id: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Track {
    pub id: MediaId,
    pub source: MediaSource,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub album_id: Option<String>,
    pub artist_ids: Vec<String>,
    pub artwork_hash: Option<String>,
    pub artwork_mime: Option<String>,
    pub duration_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlbumSummary {
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub track_count: u64,
    pub artwork_hash: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtistSummary {
    pub id: String,
    pub name: String,
    pub track_count: u64,
    pub album_count: u64,
    pub artwork_hash: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderSummary {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub track_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaylistSummary {
    pub id: String,
    pub name: String,
    pub track_count: u64,
    pub updated_unix_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueItem {
    pub queue_id: u64,
    pub track: Track,
}

impl QueueItem {
    pub fn new(queue_id: u64, track: Track) -> Self {
        Self { queue_id, track }
    }
}

#[cfg(test)]
pub(crate) fn test_item(queue_id: u64) -> QueueItem {
    QueueItem::new(
        queue_id,
        Track {
            id: MediaId::new(format!("track-{queue_id}")),
            source: MediaSource::Netease { song_id: queue_id },
            title: format!("Track {queue_id}"),
            artists: vec!["Artist".into()],
            album: Some("Album".into()),
            album_id: Some("album-1".into()),
            artist_ids: vec!["artist-1".into()],
            artwork_hash: None,
            artwork_mime: None,
            duration_ms: Some(180_000),
        },
    )
}
