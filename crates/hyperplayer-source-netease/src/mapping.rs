use serde_json::Value;

use crate::{
    dto::{
        Album, Artist, FreeTrialInfo, PlayInfo, PlaylistDetail, PlaylistSummary, QualityLevel,
        Track,
    },
    Error, Result,
};

pub(crate) fn array<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

pub(crate) fn map_track(value: &Value) -> Track {
    let artists = value
        .get("ar")
        .or_else(|| value.get("artists"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|artist| Artist {
            id: unsigned(artist, "id"),
            name: string(artist, "name"),
        })
        .collect();
    let album = value
        .get("al")
        .or_else(|| value.get("album"))
        .unwrap_or(&Value::Null);
    let fee = unsigned(value, "fee") as u8;
    let privilege = value.get("privilege").unwrap_or(&Value::Null);

    Track {
        id: unsigned(value, "id"),
        name: string(value, "name"),
        artists,
        album: Album {
            id: unsigned(album, "id"),
            name: string(album, "name"),
            pic_url: optional_string(album, "picUrl"),
        },
        duration_ms: value
            .get("dt")
            .or_else(|| value.get("duration"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        fee,
        mv_id: value
            .get("mv")
            .or_else(|| value.get("mvid"))
            .and_then(Value::as_u64),
        is_vip: matches!(fee, 1 | 4),
        no_copyright: privilege
            .get("st")
            .and_then(Value::as_i64)
            .is_some_and(|status| status < 0)
            || privilege.get("playMaxbr").and_then(Value::as_u64) == Some(0),
    }
}

pub(crate) fn map_playlist_detail(value: &Value, fallback_id: u64) -> Result<PlaylistDetail> {
    if !value.is_object() {
        return Err(Error::InvalidResponse("缺少 playlist".into()));
    }

    Ok(PlaylistDetail {
        summary: PlaylistSummary {
            id: unsigned(value, "id").max(fallback_id),
            name: string(value, "name"),
            cover_url: optional_string(value, "coverImgUrl"),
            track_count: unsigned(value, "trackCount"),
            play_count: value.get("playCount").and_then(Value::as_u64),
            owner_id: value
                .pointer("/creator/userId")
                .and_then(Value::as_u64)
                .or_else(|| value.get("userId").and_then(Value::as_u64))
                .unwrap_or(0),
            owner_name: value
                .pointer("/creator/nickname")
                .and_then(Value::as_str)
                .map(str::to_owned),
            description: optional_string(value, "description"),
        },
        tracks: array(value, "tracks").map(map_track).collect(),
        track_ids: array(value, "trackIds")
            .filter_map(|track| track.get("id").and_then(Value::as_u64))
            .collect(),
    })
}

pub(crate) fn map_play_info(
    value: &Value,
    fallback_id: u64,
    fallback_level: QualityLevel,
) -> Result<PlayInfo> {
    if !value.is_object() {
        return Err(Error::InvalidResponse("缺少播放数据".into()));
    }

    let level = match string(value, "level").as_str() {
        "higher" => QualityLevel::Higher,
        "exhigh" => QualityLevel::Exhigh,
        "lossless" => QualityLevel::Lossless,
        "hires" => QualityLevel::Hires,
        "jyeffect" => QualityLevel::Jyeffect,
        "sky" => QualityLevel::Sky,
        "jymaster" => QualityLevel::Jymaster,
        "standard" => QualityLevel::Standard,
        _ => fallback_level,
    };
    let fee = unsigned(value, "fee") as u8;
    let free_trial_info = value
        .get("freeTrialInfo")
        .filter(|trial| trial.is_object())
        .map(|trial| FreeTrialInfo {
            start: unsigned(trial, "start"),
            end: unsigned(trial, "end"),
        });
    let url = optional_string(value, "url")
        .filter(|url| !url.is_empty())
        .filter(|_| free_trial_info.is_none());
    let is_paid_content = matches!(fee, 1 | 4) || free_trial_info.is_some();

    Ok(PlayInfo {
        id: unsigned(value, "id").max(fallback_id),
        url,
        level,
        bitrate: unsigned(value, "br"),
        size_bytes: unsigned(value, "size"),
        md5: string(value, "md5"),
        container_type: string(value, "type"),
        fee,
        free_trial_info,
        is_paid_content,
    })
}

pub(crate) fn lyric(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|lyrics| lyrics.get("lyric"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .into()
}

pub(crate) fn unsigned(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

pub(crate) fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|field| {
            field
                .as_str()
                .map(str::to_owned)
                .or_else(|| field.as_u64().map(|number| number.to_string()))
        })
        .unwrap_or_default()
}

pub(crate) fn optional_string(value: &Value, key: &str) -> Option<String> {
    let value = string(value, key);
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn play_info_preserves_paid_content_metadata_with_entitled_url() {
        let info = map_play_info(
            &json!({"id": 7, "url": "https://cdn.example/full.flac", "fee": 1}),
            7,
            QualityLevel::Lossless,
        )
        .unwrap();

        assert_eq!(info.url.as_deref(), Some("https://cdn.example/full.flac"));
        assert!(info.is_paid_content);
    }

    #[test]
    fn play_info_rejects_trial_url_as_incomplete_playback() {
        let info = map_play_info(
            &json!({
                "id": 8,
                "url": "https://cdn.example/trial.mp3",
                "fee": 0,
                "freeTrialInfo": {"start": 0, "end": 30_000}
            }),
            8,
            QualityLevel::Standard,
        )
        .unwrap();

        assert_eq!(info.url, None);
        assert!(info.is_paid_content);
        assert_eq!(info.free_trial_info.unwrap().end, 30_000);
    }
}
