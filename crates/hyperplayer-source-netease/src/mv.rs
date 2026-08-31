use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

use crate::{
    dto::{Artist, MvSummary, PageRequest},
    service::{NeteaseService, Sleeper},
    transport::Transport,
    Error, Result,
};

const MV_RESOLUTIONS: [u16; 4] = [240, 480, 720, 1080];
const MV_AREAS: [&str; 6] = ["", "内地", "港台", "欧美", "日本", "韩国"];

/// 可直接交给播放器的 MV 播放信息，不包含上游响应或会话字段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MvPlayback {
    pub id: u64,
    pub url: String,
    pub resolution: u16,
    pub size_bytes: Option<u64>,
    pub duration_ms: Option<u64>,
}

impl<T: Transport, S: Sleeper> NeteaseService<T, S> {
    pub async fn mv_play_url(&self, id: u64, resolution: u16) -> Result<MvPlayback> {
        positive_id(id)?;
        if !MV_RESOLUTIONS.contains(&resolution) {
            return Err(Error::Validation(
                "MV 分辨率必须是 240、480、720 或 1080".into(),
            ));
        }

        let body = self
            .eapi(
                "/api/song/enhance/play/mv/url",
                json!({"id": id, "r": resolution}),
                Duration::from_secs(12),
            )
            .await?;
        let data = body.get("data").unwrap_or(&Value::Null);
        let url =
            text(data, "url").ok_or_else(|| Error::InvalidResponse("缺少 MV 播放地址".into()))?;

        Ok(MvPlayback {
            id: number(data, "id").unwrap_or(id),
            url: normalize_https(url),
            resolution: number(data, "r")
                .and_then(|value| u16::try_from(value).ok())
                .unwrap_or(resolution),
            size_bytes: number(data, "size"),
            duration_ms: number(data, "duration"),
        })
    }

    pub async fn similar_mvs(&self, id: u64) -> Result<Vec<MvSummary>> {
        positive_id(id)?;
        let body = self
            .eapi(
                "/api/discovery/simiMV",
                json!({"mvid": id}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "mvs").map(map_mv).collect())
    }

    pub async fn top_mvs(&self, area: &str, page: PageRequest) -> Result<Vec<MvSummary>> {
        let area = area.trim();
        if !MV_AREAS.contains(&area) {
            return Err(Error::Validation(
                "MV 地区必须是全部、内地、港台、欧美、日本或韩国".into(),
            ));
        }
        let body = self
            .eapi(
                "/api/mv/toplist",
                top_mvs_payload(area, page),
                Duration::from_secs(12),
            )
            .await?;
        Ok(values(&body, "data").map(map_mv).collect())
    }
}

fn top_mvs_payload(area: &str, page: PageRequest) -> Value {
    let page = page.bounded(100);
    json!({"area": area, "limit": page.limit, "offset": page.offset, "total": true})
}

fn positive_id(id: u64) -> Result<()> {
    if id == 0 {
        Err(Error::Validation("资源 id 必须大于 0".into()))
    } else {
        Ok(())
    }
}

fn normalize_https(url: String) -> String {
    url.strip_prefix("http://")
        .map(|rest| format!("https://{rest}"))
        .unwrap_or(url)
}

fn values<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn number(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_i64().and_then(|value| u64::try_from(value).ok()))
            .or_else(|| value.as_str()?.parse().ok())
    })
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn map_mv(value: &Value) -> MvSummary {
    let artists = values(value, "artists").map(map_artist).collect::<Vec<_>>();
    let artists = if artists.is_empty() {
        text(value, "artistName")
            .map(|name| {
                vec![Artist {
                    id: number(value, "artistId").unwrap_or(0),
                    name,
                }]
            })
            .unwrap_or_default()
    } else {
        artists
    };

    MvSummary {
        id: number(value, "id")
            .or_else(|| number(value, "vid"))
            .unwrap_or(0),
        name: text(value, "name")
            .or_else(|| text(value, "title"))
            .unwrap_or_default(),
        cover_url: text(value, "cover")
            .or_else(|| text(value, "coverUrl"))
            .or_else(|| text(value, "imgurl")),
        duration_ms: number(value, "duration"),
        artists,
        play_count: number(value, "playCount"),
    }
}

fn map_artist(value: &Value) -> Artist {
    Artist {
        id: number(value, "id").unwrap_or(0),
        name: text(value, "name").unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use futures::executor::block_on;
    use rand::{rngs::StdRng, SeedableRng};
    use std::{
        collections::{BTreeMap, VecDeque},
        sync::{Arc, Mutex},
    };

    use crate::{HttpRequest, HttpResponse, Session};

    struct Fake {
        responses: Mutex<VecDeque<Result<HttpResponse>>>,
        requests: Arc<Mutex<Vec<HttpRequest>>>,
    }

    #[async_trait]
    impl Transport for Fake {
        async fn execute(&self, request: HttpRequest) -> Result<HttpResponse> {
            self.requests.lock().unwrap().push(request);
            self.responses.lock().unwrap().pop_front().unwrap()
        }
    }

    struct NoSleep;

    #[async_trait]
    impl Sleeper for NoSleep {
        async fn sleep(&self, _: Duration) {}
    }

    fn response(value: Value) -> Result<HttpResponse> {
        Ok(HttpResponse {
            status: 200,
            headers: BTreeMap::new(),
            body: value.to_string().into_bytes(),
        })
    }

    fn service(
        responses: Vec<Result<HttpResponse>>,
    ) -> (NeteaseService<Fake, NoSleep>, Arc<Mutex<Vec<HttpRequest>>>) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let mut rng = StdRng::seed_from_u64(31);
        let service = NeteaseService::with_sleeper(
            Fake {
                responses: Mutex::new(responses.into()),
                requests: Arc::clone(&requests),
            },
            Session::new(&mut rng),
            NoSleep,
        );
        (service, requests)
    }

    #[test]
    fn playback_fixture_maps_and_normalizes_url() {
        let (service, _) = service(vec![response(json!({
            "code": 200,
            "data": {
                "id": 7,
                "url": "http://cdn.example/video.mp4",
                "r": 1080,
                "size": 4096,
                "duration": 12345,
                "cookie": "transport-secret"
            }
        }))]);

        let playback = block_on(service.mv_play_url(7, 1080)).unwrap();

        assert_eq!(playback.id, 7);
        assert_eq!(playback.url, "https://cdn.example/video.mp4");
        assert_eq!(playback.resolution, 1080);
        assert_eq!(playback.size_bytes, Some(4096));
        assert_eq!(playback.duration_ms, Some(12345));
    }

    #[test]
    fn playback_fixture_rejects_missing_url() {
        let (service, _) = service(vec![response(json!({
            "code": 200,
            "data": {"id": 7, "url": null, "r": 720}
        }))]);

        assert_eq!(
            block_on(service.mv_play_url(7, 720)),
            Err(Error::InvalidResponse("缺少 MV 播放地址".into()))
        );
    }

    #[test]
    fn invalid_inputs_do_not_reach_transport() {
        let (service, requests) = service(vec![]);
        let page = PageRequest {
            limit: 30,
            offset: 0,
        };

        assert!(matches!(
            block_on(service.mv_play_url(0, 1080)),
            Err(Error::Validation(_))
        ));
        assert!(matches!(
            block_on(service.mv_play_url(7, 360)),
            Err(Error::Validation(_))
        ));
        assert!(matches!(
            block_on(service.similar_mvs(0)),
            Err(Error::Validation(_))
        ));
        assert!(matches!(
            block_on(service.top_mvs("火星", page)),
            Err(Error::Validation(_))
        ));
        assert!(requests.lock().unwrap().is_empty());
    }

    #[test]
    fn top_mvs_payload_bounds_pagination() {
        assert_eq!(
            top_mvs_payload(
                "欧美",
                PageRequest {
                    limit: 0,
                    offset: 45
                }
            ),
            json!({"area":"欧美","limit":1,"offset":45,"total":true})
        );
        assert_eq!(
            top_mvs_payload(
                "",
                PageRequest {
                    limit: usize::MAX,
                    offset: 60
                }
            ),
            json!({"area":"","limit":100,"offset":60,"total":true})
        );
    }

    #[test]
    fn list_fixtures_map_product_fields() {
        let (service, _) = service(vec![
            response(json!({
                "code": 200,
                "mvs": [{
                    "id": 8,
                    "name": "Similar",
                    "cover": "similar-cover",
                    "duration": 1000,
                    "artists": [{"id": 9, "name": "Singer"}],
                    "playCount": 10
                }]
            })),
            response(json!({
                "code": 200,
                "data": [{
                    "id": 10,
                    "name": "Top",
                    "coverUrl": "top-cover",
                    "artistId": 11,
                    "artistName": "Top Singer",
                    "playCount": "12"
                }]
            })),
        ]);

        let similar = block_on(service.similar_mvs(7)).unwrap();
        let top = block_on(service.top_mvs(
            "内地",
            PageRequest {
                limit: 30,
                offset: 0,
            },
        ))
        .unwrap();

        assert_eq!(similar[0].cover_url.as_deref(), Some("similar-cover"));
        assert_eq!(similar[0].artists[0].id, 9);
        assert_eq!(similar[0].duration_ms, Some(1000));
        assert_eq!(top[0].cover_url.as_deref(), Some("top-cover"));
        assert_eq!(top[0].artists[0].name, "Top Singer");
        assert_eq!(top[0].play_count, Some(12));
    }

    #[test]
    fn playback_serialization_does_not_leak_transport_or_session_data() {
        let playback = MvPlayback {
            id: 7,
            url: "https://cdn.example/video.mp4".into(),
            resolution: 720,
            size_bytes: Some(1024),
            duration_ms: Some(3000),
        };

        let serialized = serde_json::to_string(&playback).unwrap();
        for forbidden in [
            "cookie",
            "header",
            "session",
            "transport",
            "/api/",
            "MUSIC_U",
        ] {
            assert!(!serialized.contains(forbidden));
        }
        assert_eq!(
            serialized,
            r#"{"id":7,"url":"https://cdn.example/video.mp4","resolution":720,"sizeBytes":1024,"durationMs":3000}"#
        );
    }
}
