use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::Duration,
};

use crate::{
    crypto,
    dto::*,
    mapping::{array, lyric, map_play_info, map_playlist_detail, map_track},
    route::{base_url, Channel},
    session::{serialize_cookie, Session},
    transport::{HttpRequest, Method, ReqwestTransport, Transport, TransportConfig},
    Error, Result,
};

#[async_trait]
pub trait Sleeper: Send + Sync {
    async fn sleep(&self, duration: Duration);
}
pub struct StdSleeper;
#[async_trait]
impl Sleeper for StdSleeper {
    async fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration)
    }
}

pub struct NeteaseService<T: Transport, S: Sleeper = StdSleeper> {
    transport: Arc<T>,
    sleeper: Arc<S>,
    session: Mutex<Session>,
    enabled: AtomicBool,
    anti_cheat_token: Mutex<Option<String>>,
}
impl<T: Transport> NeteaseService<T, StdSleeper> {
    pub fn new(transport: T, session: Session) -> Self {
        Self::with_sleeper(transport, session, StdSleeper)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProductionConfig {
    pub enabled: bool,
    pub transport: TransportConfig,
}
impl Default for ProductionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            transport: TransportConfig::default(),
        }
    }
}
impl NeteaseService<ReqwestTransport, StdSleeper> {
    pub fn production(config: ProductionConfig, session: Session) -> Result<Self> {
        let service = Self::new(ReqwestTransport::new(config.transport)?, session);
        service.set_enabled(config.enabled);
        Ok(service)
    }
}
impl<T: Transport, S: Sleeper> NeteaseService<T, S> {
    pub fn with_sleeper(transport: T, session: Session, sleeper: S) -> Self {
        Self {
            transport: Arc::new(transport),
            sleeper: Arc::new(sleeper),
            session: Mutex::new(session),
            enabled: AtomicBool::new(true),
            anti_cheat_token: Mutex::new(None),
        }
    }
    fn session(&self) -> MutexGuard<'_, Session> {
        self.session.lock().unwrap()
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release)
    }
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }
    pub fn update_session(&self, session: Session) {
        *self.session() = session
    }
    pub fn set_user_cookie(&self, cookie: &str) {
        self.session().set_user_cookie(cookie)
    }
    pub fn clear_user_cookie(&self) {
        self.session().clear_user_cookie()
    }
    pub fn qr_image_url(key: &str) -> Result<String> {
        if key.trim().is_empty() {
            return Err(Error::Validation("二维码 key 不能为空".into()));
        }
        Ok(format!(
            "https://music.163.com/login?codekey={}",
            percent_encode(key)
        ))
    }
    pub fn quality_candidates(preference: QualityPreference, is_vip: bool) -> Vec<QualityLevel> {
        use QualityLevel::*;
        if !is_vip {
            return match preference {
                QualityPreference::Standard => vec![Standard],
                _ => vec![Exhigh, Standard],
            };
        }
        match preference {
            QualityPreference::Standard => vec![Standard],
            QualityPreference::High => vec![Exhigh, Standard],
            QualityPreference::VeryHigh | QualityPreference::Lossless => {
                vec![Lossless, Exhigh, Standard]
            }
            QualityPreference::HiRes => vec![Hires, Lossless, Exhigh, Standard],
            QualityPreference::Auto => vec![Jymaster, Hires, Lossless, Exhigh, Standard],
        }
    }
    pub fn validate_create_playlist(name: &str) -> Result<()> {
        if name.trim().is_empty() {
            return Err(Error::Validation("歌单名称不能为空".into()));
        }
        if name.trim().chars().count() > 40 {
            return Err(Error::Validation("歌单名称过长".into()));
        }
        Ok(())
    }
    pub fn validate_update_playlist(name: Option<&str>, description: &str) -> Result<()> {
        if name.is_some_and(|n| n.trim().chars().count() > 40) {
            return Err(Error::Validation("歌单名称过长".into()));
        }
        if description.chars().count() > 980 {
            return Err(Error::Validation("歌单简介过长".into()));
        }
        Ok(())
    }
    pub fn validate_cover(size: usize) -> Result<()> {
        if size == 0 || size > 10 * 1024 * 1024 {
            Err(Error::Validation("封面图片无效或体积过大".into()))
        } else {
            Ok(())
        }
    }
    pub fn qr_state(value: &Value) -> LoginQrState {
        match value.get("code").and_then(Value::as_i64) {
            Some(800) => LoginQrState::Expired,
            Some(802) => LoginQrState::Scanned,
            Some(803) => LoginQrState::Authorized,
            _ => LoginQrState::Waiting,
        }
    }
    pub async fn create_login_qr_key(&self) -> Result<String> {
        let body = self
            .retry(3, Duration::from_millis(500), || {
                self.eapi_raw(
                    "/api/login/qrcode/unikey",
                    json!({"type": 3}),
                    Duration::from_secs(12),
                )
            })
            .await?;
        if body.get("code").and_then(Value::as_i64) != Some(200) {
            return assert_api_ok(body).map(|_| String::new());
        }
        body.pointer("/data/unikey")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| Error::InvalidResponse("二维码 key 缺失".into()))
    }
    pub async fn check_login_qr_state(&self, key: &str) -> Result<LoginQrState> {
        if key.trim().is_empty() {
            return Err(Error::Validation("二维码 key 不能为空".into()));
        }
        let body = self
            .eapi_raw(
                "/api/login/qrcode/client/login",
                json!({"key": key, "type": 3}),
                Duration::from_secs(12),
            )
            .await?;
        let state = match body.get("code").and_then(Value::as_i64) {
            Some(800..=803) => Self::qr_state(&body),
            _ => return assert_api_ok(body).map(|_| LoginQrState::Waiting),
        };
        if state == LoginQrState::Authorized {
            let cookie = body
                .get("cookie")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(";");
            if cookie.is_empty() {
                return Err(Error::InvalidResponse("授权响应缺少 Cookie".into()));
            }
            self.session().set_user_cookie(&cookie);
        }
        Ok(state)
    }
    pub(crate) async fn eapi(
        &self,
        path: &str,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value> {
        self.eapi_raw(path, payload, timeout)
            .await
            .and_then(assert_api_ok)
    }
    async fn eapi_raw(&self, path: &str, payload: Value, timeout: Duration) -> Result<Value> {
        self.ensure_enabled()?;
        self.eapi_on(
            path,
            payload,
            timeout,
            "https://interfacepc.music.163.com",
            None,
        )
        .await
    }
    async fn eapi_on(
        &self,
        path: &str,
        mut payload: Value,
        timeout: Duration,
        domain: &str,
        anti_cheat_token: Option<&str>,
    ) -> Result<Value> {
        let (cookies, device) = {
            let s = self.session();
            (s.request_cookies(), s.device_id().to_owned())
        };
        let header = json!({"osver":"Microsoft-Windows-10-Professional-build-19045-64bit","deviceId":device,"os":"pc","appver":"3.1.17.204416","versioncode":"140","mobilename":"","resolution":"1920x1080","channel":"netease","MUSIC_U":cookies.get("MUSIC_U").cloned().unwrap_or_default(),"MUSIC_A":cookies.get("MUSIC_A").cloned().unwrap_or_default()});
        payload
            .as_object_mut()
            .ok_or_else(|| Error::Validation("payload 必须是对象".into()))?
            .insert("header".into(), header);
        let params = crypto::encrypt_eapi(path, &payload.to_string())?;
        let body = format!("params={}", percent_encode(&params)).into_bytes();
        let mut headers = BTreeMap::new();
        headers.insert(
            "Content-Type".into(),
            "application/x-www-form-urlencoded".into(),
        );
        headers.insert(
            "User-Agent".into(),
            "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)".into(),
        );
        headers.insert("Cookie".into(), serialize_cookie(&cookies));
        if let Some(token) = anti_cheat_token {
            headers.insert("X-antiCheatToken".into(), token.to_owned());
        }
        let outer = path.strip_prefix("/api").unwrap_or(path);
        let response = self
            .transport
            .execute(HttpRequest {
                method: Method::Post,
                url: format!("{domain}/eapi{outer}"),
                headers,
                body,
                timeout,
            })
            .await?;
        self.decode_json_raw(response.status, &response.body)
    }
    pub(crate) async fn xeapi(
        &self,
        path: &str,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value> {
        self.ensure_enabled()?;
        let map = payload
            .as_object()
            .ok_or_else(|| Error::Validation("payload 必须是对象".into()))?;
        let (mut rng, key, session, device, cookie) = {
            let s = self.session();
            (
                OsRng,
                s.xeapi_key()?.clone(),
                s.xeapi_session().map(|(a, b)| (a.to_owned(), b.to_owned())),
                s.device_id().to_owned(),
                s.current_user_cookie(),
            )
        };
        let fields = crypto::encrypt_xeapi(
            map,
            key.public_key,
            &key.sk,
            &key.version,
            session.as_ref().map(|(a, b)| (a.as_str(), b.as_str())),
            &mut rng,
        )?;
        let body = format!(
            "B={}&S={}&R={}",
            percent_encode(&fields.b),
            percent_encode(&fields.s),
            percent_encode(&fields.r)
        )
        .into_bytes();
        let mut headers = BTreeMap::new();
        headers.insert(
            "Content-Type".into(),
            "application/x-www-form-urlencoded;charset=utf-8".into(),
        );
        headers.insert("X-Client-Enc-State".into(), "ENCRYPTED".into());
        headers.insert("x-deviceid".into(), device);
        if let Some(c) = cookie {
            headers.insert("Cookie".into(), c);
        };
        let outer = path.strip_prefix("/api").unwrap_or(path);
        let response = self
            .transport
            .execute(HttpRequest {
                method: Method::Post,
                url: format!("{}/xeapi{outer}", base_url(Channel::Xeapi).unwrap()),
                headers,
                body,
                timeout,
            })
            .await?;
        {
            let mut s = self.session();
            let id = header_first(&response.headers, "x-encr-ssid");
            let key = header_first(&response.headers, "x-encr-sskey");
            s.update_xeapi_session(id, key)
        }
        let value = crypto::decrypt_xeapi_response(&response.body).and_then(assert_api_ok)?;
        if path == "/api/register/anonimous" {
            let cookie = response
                .headers
                .iter()
                .filter(|(name, _)| name.eq_ignore_ascii_case("set-cookie"))
                .flat_map(|(_, values)| values)
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join(";");
            if let Some(token) = anonymous_token_from_cookie(&cookie) {
                self.session().set_anonymous_token(token);
            }
        }
        Ok(value)
    }
    fn decode_json_raw(&self, status: u16, body: &[u8]) -> Result<Value> {
        if !(200..300).contains(&status) {
            return Err(Error::Transport(format!("HTTP {status}")));
        }
        serde_json::from_slice(body).map_err(|e| Error::InvalidResponse(e.to_string()))
    }

    /// 初始化 xeapi 公钥，并尽力注册匿名会话。匿名注册失败不影响公开读取接口。
    pub async fn bootstrap_network(&self) -> Result<()> {
        self.ensure_enabled()?;
        let mut nonce_bytes = [0u8; 16];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = nonce_bytes
            .iter()
            .map(|byte| char::from(b'0' + byte % 10))
            .collect::<String>();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Error::InvalidResponse("系统时间早于 Unix epoch".into()))?
            .as_millis()
            .to_string();
        self.fetch_xeapi_public_key(&timestamp, &nonce).await?;
        let _ = self.register_anonymous().await;
        Ok(())
    }

    async fn fetch_xeapi_public_key(&self, timestamp: &str, nonce: &str) -> Result<()> {
        let (device_id, current_version) = {
            let session = self.session();
            (
                session.device_id().to_owned(),
                session
                    .xeapi_key()
                    .map(|key| key.version.clone())
                    .unwrap_or_default(),
            )
        };
        let fields = [
            ("appVersion", "9.1.65".to_owned()),
            ("currentKeyVersion", current_version),
            ("deviceId", device_id.clone()),
            ("nonce", nonce.to_owned()),
            ("os", "android".to_owned()),
            ("requestType", "active".to_owned()),
            ("signature", crypto::xeapi_sign(timestamp, nonce)),
            ("t1", String::new()),
            ("t2", String::new()),
            ("timestamp", timestamp.to_owned()),
            ("uid", String::new()),
        ];
        let body = fields
            .iter()
            .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
            .collect::<Vec<_>>()
            .join("&")
            .into_bytes();
        let mut headers = BTreeMap::new();
        headers.insert(
            "Content-Type".into(),
            "application/x-www-form-urlencoded;charset=utf-8".into(),
        );
        headers.insert(
            "Cookie".into(),
            format!("deviceId={}", percent_encode(&device_id)),
        );
        headers.insert("User-Agent".into(), "NeteaseMusic/9.1.65.240927161425(9001065);Dalvik/2.1.0 (Linux; U; Android 14; 23013RK75C Build/UKQ1.230804.001)".into());
        let response = self
            .transport
            .execute(HttpRequest {
                method: Method::Post,
                url: "https://interface.music.163.com/api/gorilla/anti/crawler/security/key/get"
                    .into(),
                headers,
                body,
                timeout: Duration::from_secs(10),
            })
            .await?;
        let value = self.decode_json_raw(response.status, &response.body)?;
        assert_api_ok(value.clone())?;
        let data = value.get("data").unwrap_or(&Value::Null);
        let response_timestamp = data
            .get("timestamp")
            .and_then(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| value.as_u64().map(|value| value.to_string()))
            })
            .unwrap_or_default();
        let signature = data
            .get("signature")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if signature != crypto::xeapi_sign(&response_timestamp, nonce) {
            return Err(Error::Crypto("xeapi 公钥响应签名不匹配".into()));
        }
        let encrypted = data
            .get("encryptedData")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::InvalidResponse("xeapi 公钥密文缺失".into()))?;
        let key = crypto::decrypt_xeapi_public_key(encrypted)?;
        let public_key = key
            .get("publicKey")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::InvalidResponse("xeapi publicKey 缺失".into()))?;
        let decoded = BASE64
            .decode(public_key)
            .map_err(|error| Error::Crypto(error.to_string()))?;
        let public_key: [u8; 32] = decoded
            .try_into()
            .map_err(|_| Error::InvalidResponse("xeapi publicKey 长度无效".into()))?;
        let sk = key.get("sk").and_then(Value::as_str).unwrap_or_default();
        if sk.is_empty() {
            return Err(Error::InvalidResponse("xeapi sk 缺失".into()));
        }
        let version = key
            .get("version")
            .and_then(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| value.as_u64().map(|value| value.to_string()))
            })
            .unwrap_or_default();
        self.session
            .lock()
            .unwrap()
            .set_xeapi_key(crate::XeapiKeyState {
                public_key,
                sk: sk.to_owned(),
                version,
            });
        Ok(())
    }

    async fn register_anonymous(&self) -> Result<bool> {
        let username = self.session().encoded_anonymous_username();
        let value = self
            .xeapi(
                "/api/register/anonimous",
                json!({"username":username}),
                Duration::from_secs(12),
            )
            .await?;
        let cookie = value
            .get("cookie")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(";");
        let token = anonymous_token_from_cookie(&cookie);
        if let Some(token) = token {
            self.session().set_anonymous_token(token);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub(crate) async fn protected_write(
        &self,
        path: &str,
        mut payload: Value,
        require_anti_cheat: bool,
    ) -> Result<Value> {
        self.ensure_write_authorized()?;
        let token = if require_anti_cheat {
            Some(self.anti_cheat_token().await?)
        } else {
            None
        };
        if let Some(token) = &token {
            payload
                .as_object_mut()
                .ok_or_else(|| Error::Validation("payload 必须是对象".into()))?
                .insert("checkToken".into(), Value::String(token.clone()));
        }
        self.eapi_on(
            path,
            payload,
            Duration::from_secs(12),
            "https://interfacepc.music.163.com",
            token.as_deref(),
        )
        .await
        .and_then(assert_api_ok)
    }

    fn ensure_write_authorized(&self) -> Result<()> {
        if !self.session().is_logged_in() {
            return Err(Error::LoginRequired);
        }
        Ok(())
    }

    async fn anti_cheat_token(&self) -> Result<String> {
        if let Some(token) = self.anti_cheat_token.lock().unwrap().clone() {
            return Ok(token);
        }
        let response = self
            .transport
            .execute(HttpRequest {
                method: Method::Get,
                url: "https://dun.163.com/v2/config/js?pn=YD00000558929251".into(),
                headers: BTreeMap::new(),
                body: Vec::new(),
                timeout: Duration::from_secs(10),
            })
            .await?;
        let value = self.decode_json_raw(response.status, &response.body)?;
        let token = value
            .pointer("/result/conf")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| Error::InvalidResponse("防作弊 token 获取失败".into()))?
            .to_owned();
        *self.anti_cheat_token.lock().unwrap() = Some(token.clone());
        Ok(token)
    }
    fn ensure_enabled(&self) -> Result<()> {
        if self.is_enabled() {
            Ok(())
        } else {
            Err(Error::Transport("网易云音源已禁用".into()))
        }
    }
    pub async fn search_songs(&self, keywords: &str, page: PageRequest) -> Result<Vec<Track>> {
        if keywords.trim().is_empty() {
            return Err(Error::Validation("搜索词不能为空".into()));
        }
        let p = page.bounded(100);
        let body = self
            .eapi(
                "/api/search/get",
                json!({"s":keywords,"type":1,"limit":p.limit,"offset":p.offset}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(body
            .pointer("/result/songs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(map_track)
            .collect())
    }
    pub async fn song_detail(&self, ids: &[u64]) -> Result<Vec<Track>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        if ids.len() > 1000 {
            return Err(Error::Validation("单次歌曲详情最多 1000 首".into()));
        }
        let c = ids.iter().map(|id| json!({"id":id})).collect::<Vec<_>>();
        let body = self
            .eapi(
                "/api/v3/song/detail",
                json!({"c":serde_json::to_string(&c).unwrap()}),
                Duration::from_secs(12),
            )
            .await?;
        Ok(array(&body, "songs").map(map_track).collect())
    }
    pub async fn playlist_detail(&self, id: u64) -> Result<PlaylistDetail> {
        let body = self
            .retry(3, Duration::from_millis(500), || {
                self.eapi(
                    "/api/v6/playlist/detail",
                    json!({"id":id,"n":100000,"s":8}),
                    Duration::from_secs(12),
                )
            })
            .await?;
        map_playlist_detail(body.get("playlist").unwrap_or(&Value::Null), id)
    }
    pub async fn playlist_tracks(&self, id: u64, page: PageRequest) -> Result<Vec<Track>> {
        let detail = self.playlist_detail(id).await?;
        let end = (page.offset + page.limit).min(detail.track_ids.len());
        if page.offset >= end {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        for chunk in detail.track_ids[page.offset..end].chunks(500) {
            out.extend(self.song_detail(chunk).await?)
        }
        Ok(out)
    }
    pub async fn song_play_info(
        &self,
        id: u64,
        level: QualityLevel,
        timeout: Duration,
    ) -> Result<PlayInfo> {
        let mut payload =
            json!({"ids":format!("[{id}]"),"level":level.as_str(),"encodeType":"flac"});
        if level == QualityLevel::Sky {
            payload["immerseType"] = json!("c51")
        }
        let body = self
            .xeapi("/api/song/enhance/player/url/v1", payload, timeout)
            .await?;
        map_play_info(
            body.get("data")
                .and_then(Value::as_array)
                .and_then(|v| v.first())
                .unwrap_or(&Value::Null),
            id,
            level,
        )
    }
    pub async fn song_url(
        &self,
        id: u64,
        preference: QualityPreference,
        is_vip: bool,
        total_budget: Duration,
    ) -> Result<PlayInfo> {
        let started = std::time::Instant::now();
        let mut last = Error::InvalidResponse("获取播放地址失败".into());
        for (index, level) in Self::quality_candidates(preference, is_vip)
            .into_iter()
            .enumerate()
        {
            for attempt in 0..if index == 0 { 2 } else { 1 } {
                let remaining = total_budget.saturating_sub(started.elapsed());
                if remaining <= Duration::from_millis(300) {
                    break;
                }
                match self
                    .song_play_info(
                        id,
                        level,
                        remaining.clamp(Duration::from_millis(300), Duration::from_millis(4500)),
                    )
                    .await
                {
                    Ok(info) if info.url.is_some() => return Ok(info),
                    Ok(_) => {
                        last = Error::InvalidResponse(format!(
                            "等级 {} 未返回播放地址",
                            level.as_str()
                        ));
                        break;
                    }
                    Err(e) => {
                        last = e;
                        if attempt == 0 && index == 0 && remaining > Duration::from_millis(500) {
                            self.sleeper.sleep(Duration::from_millis(150)).await
                        }
                    }
                }
            }
        }
        if let Ok(Some(t)) = self.song_detail(&[id]).await.map(|mut v| v.pop()) {
            if t.fee == 1 || t.fee == 4 {
                return Ok(PlayInfo {
                    id,
                    url: None,
                    level: QualityLevel::Standard,
                    bitrate: 0,
                    size_bytes: 0,
                    md5: String::new(),
                    container_type: String::new(),
                    fee: t.fee,
                    free_trial_info: None,
                    is_paid_content: true,
                });
            }
        }
        Err(last)
    }
    pub async fn lyrics(&self, id: u64) -> Result<Lyrics> {
        let result = self
            .retry(5, Duration::from_millis(300), || {
                self.eapi(
                    "/api/song/lyric/v1",
                    json!({"id":id,"cp":false,"tv":0,"lv":0,"rv":0,"kv":0,"yv":0,"ytv":0,"yrv":0}),
                    Duration::from_secs(10),
                )
            })
            .await;
        Ok(match result {
            Ok(v) => Lyrics {
                original: lyric(&v, "lrc"),
                translation: lyric(&v, "tlyric"),
                romanization: lyric(&v, "romalrc"),
                word_synced: lyric(&v, "yrc"),
                word_synced_translation: lyric(&v, "ytlrc"),
                ttml: lyric(&v, "ttml"),
            },
            Err(_) => Lyrics::empty(),
        })
    }
    pub async fn manipulate_playlist_tracks(
        &self,
        op: &str,
        pid: u64,
        ids: &[u64],
    ) -> Result<MutationResult> {
        if !matches!(op, "add" | "del") {
            return Err(Error::Validation("歌单操作仅支持 add/del".into()));
        }
        if pid == 0 {
            return Err(Error::Validation("歌单 id 必须大于 0".into()));
        }
        if ids.is_empty() || ids.contains(&0) {
            return Err(Error::Validation("曲目列表不能为空且 id 必须有效".into()));
        }
        let make = |v: &[u64]| json!({"op":op,"pid":pid,"trackIds":serde_json::to_string(v).unwrap(),"imme":"true"});
        match self
            .protected_write("/api/playlist/manipulate/tracks", make(ids), false)
            .await
        {
            Err(Error::Api { code: 512, .. }) => {
                let duplicated = ids.iter().chain(ids).copied().collect::<Vec<_>>();
                self.protected_write("/api/playlist/manipulate/tracks", make(&duplicated), false)
                    .await?;
            }
            Err(error) => return Err(error),
            Ok(_) => {}
        }
        Ok(MutationResult { succeeded: true })
    }
    async fn retry<F, Fut, R>(&self, count: usize, step: Duration, mut task: F) -> Result<R>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<R>>,
    {
        let mut last = None;
        for attempt in 0..count {
            match task().await {
                Ok(v) => return Ok(v),
                Err(e) => last = Some(e),
            }
            if attempt + 1 < count {
                self.sleeper.sleep(step * (attempt as u32 + 1)).await
            }
        }
        Err(last.unwrap_or_else(|| Error::InvalidResponse("无重试次数".into())))
    }
}
fn anonymous_token_from_cookie(cookie: &str) -> Option<String> {
    cookie.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == "MUSIC_A" && !value.is_empty()).then(|| value.to_owned())
    })
}

fn assert_api_ok(value: Value) -> Result<Value> {
    let code = value
        .get("code")
        .and_then(|value| value.as_i64().or_else(|| value.as_str()?.parse().ok()))
        .ok_or_else(|| Error::InvalidResponse("响应缺少 code".into()))?;
    if code == 200 {
        Ok(value)
    } else {
        Err(Error::Api {
            code,
            message: value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("接口失败")
                .into(),
        })
    }
}
fn percent_encode(s: &str) -> String {
    s.bytes()
        .flat_map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => vec![b as char],
            _ => format!("%{b:02X}").chars().collect(),
        })
        .collect()
}
fn header_first<'a>(h: &'a BTreeMap<String, Vec<String>>, k: &str) -> &'a str {
    h.iter()
        .find(|(x, _)| x.eq_ignore_ascii_case(k))
        .and_then(|(_, v)| v.first())
        .map(String::as_str)
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use futures::executor::block_on;
    use rand::{rngs::StdRng, SeedableRng};
    use std::collections::VecDeque;
    struct Fake {
        responses: Mutex<VecDeque<Result<crate::HttpResponse>>>,
        requests: Mutex<Vec<HttpRequest>>,
    }
    #[async_trait]
    impl Transport for Fake {
        async fn execute(&self, r: HttpRequest) -> Result<crate::HttpResponse> {
            self.requests.lock().unwrap().push(r);
            self.responses.lock().unwrap().pop_front().unwrap()
        }
    }
    struct NoSleep;
    #[async_trait]
    impl Sleeper for NoSleep {
        async fn sleep(&self, _: Duration) {}
    }
    fn response(v: Value) -> Result<crate::HttpResponse> {
        Ok(crate::HttpResponse {
            status: 200,
            headers: BTreeMap::new(),
            body: v.to_string().into_bytes(),
        })
    }
    fn encrypted_xeapi_response(v: Value) -> Result<crate::HttpResponse> {
        use aes::Aes128;
        use cipher::{BlockEncrypt, KeyInit};
        let cipher = Aes128::new_from_slice(crypto::EAPI_KEY).unwrap();
        let mut body = v.to_string().into_bytes();
        let padding = 16 - body.len() % 16;
        body.extend(std::iter::repeat_n(padding as u8, padding));
        for chunk in body.as_chunks_mut::<16>().0 {
            cipher.encrypt_block(chunk.into());
        }
        Ok(crate::HttpResponse {
            status: 200,
            headers: BTreeMap::new(),
            body,
        })
    }
    fn service(rs: Vec<Result<crate::HttpResponse>>) -> NeteaseService<Fake, NoSleep> {
        let mut rng = StdRng::seed_from_u64(1);
        let mut session = Session::new(&mut rng);
        session.set_xeapi_key(crate::XeapiKeyState {
            public_key: [9; 32],
            sk: "sk".into(),
            version: "1".into(),
        });
        NeteaseService::with_sleeper(
            Fake {
                responses: Mutex::new(rs.into()),
                requests: Mutex::new(vec![]),
            },
            session,
            NoSleep,
        )
    }
    #[test]
    fn quality_ladder_matches_spec() {
        use QualityLevel::*;
        assert_eq!(
            NeteaseService::<Fake, NoSleep>::quality_candidates(QualityPreference::Auto, true),
            vec![Jymaster, Hires, Lossless, Exhigh, Standard]
        );
        assert_eq!(
            NeteaseService::<Fake, NoSleep>::quality_candidates(QualityPreference::HiRes, false),
            vec![Exhigh, Standard]
        )
    }
    #[test]
    fn qr_mapping_is_total() {
        assert_eq!(
            NeteaseService::<Fake, NoSleep>::qr_state(&json!({"code":800})),
            LoginQrState::Expired
        );
        assert_eq!(
            NeteaseService::<Fake, NoSleep>::qr_state(&json!({"code":803,"cookie":["secret"]})),
            LoginQrState::Authorized
        )
    }
    #[test]
    fn authorized_qr_cookie_stays_in_session() {
        let svc = service(vec![response(
            json!({"code":803,"cookie":["MUSIC_U=secret","__csrf=x"]}),
        )]);
        let state = block_on(svc.check_login_qr_state("key")).unwrap();
        assert_eq!(state, LoginQrState::Authorized);
        assert_eq!(
            svc.session.lock().unwrap().current_user_cookie().as_deref(),
            Some("MUSIC_U=secret; __csrf=x")
        );
        assert_eq!(
            serde_json::to_string(&state).unwrap(),
            r#"{"state":"authorized"}"#
        );
    }
    #[test]
    fn validators_enforce_limits() {
        assert!(
            NeteaseService::<Fake, NoSleep>::validate_create_playlist(&"x".repeat(41)).is_err()
        );
        assert!(
            NeteaseService::<Fake, NoSleep>::validate_update_playlist(None, &"x".repeat(981))
                .is_err()
        );
        assert!(NeteaseService::<Fake, NoSleep>::validate_cover(0).is_err())
    }
    #[test]
    fn search_maps_product_dto() {
        let svc = service(vec![response(
            json!({"code":200,"result":{"songs":[{"id":1,"name":"n","ar":[{"id":2,"name":"a"}],"al":{"id":3,"name":"b"},"dt":9,"fee":1}]}}),
        )]);
        let tracks = block_on(svc.search_songs(
            "x",
            PageRequest {
                limit: 30,
                offset: 0,
            },
        ))
        .unwrap();
        assert_eq!(tracks[0].album.id, 3);
        assert!(tracks[0].is_vip)
    }
    #[test]
    fn playlist_paginates_details_in_500_chunks() {
        let ids = (1..=501).map(|id| json!({"id":id})).collect::<Vec<_>>();
        let songs1 = (1..=500).map(|id| json!({"id":id})).collect::<Vec<_>>();
        let svc = service(vec![
            response(json!({"code":200,"playlist":{"id":9,"name":"p","trackIds":ids,"tracks":[]}})),
            response(json!({"code":200,"songs":songs1})),
            response(json!({"code":200,"songs":[{"id":501}]})),
        ]);
        let got = block_on(svc.playlist_tracks(
            9,
            PageRequest {
                limit: 501,
                offset: 0,
            },
        ))
        .unwrap();
        assert_eq!(got.len(), 501);
        assert_eq!(svc.transport.requests.lock().unwrap().len(), 3);
    }
    #[test]
    fn paid_content_never_falls_back() {
        let mut rs = Vec::new();
        for _ in 0..3 {
            rs.push(Err(Error::Timeout))
        }
        rs.push(response(json!({"code":200,"songs":[{"id":7,"fee":1}]})));
        let svc = service(rs);
        let got =
            block_on(svc.song_url(7, QualityPreference::Auto, false, Duration::from_secs(16)))
                .unwrap();
        assert!(got.url.is_none() && got.is_paid_content)
    }
    #[test]
    fn entitlement_fails_closed() {
        let e = Entitlement::AccountEntitled {
            user_id: 1,
            verified_at_ms: 10,
            expires_at_ms: Some(20),
        };
        assert!(e.authorize_cached_vip(Some(1), 1, 15).is_ok());
        assert_eq!(
            e.authorize_cached_vip(Some(2), 1, 15),
            Err(Error::EntitlementDenied)
        );
        assert_eq!(
            e.authorize_cached_vip(Some(1), 1, 20),
            Err(Error::EntitlementDenied)
        );
    }
    #[test]
    fn ordinary_api_rejects_400_and_502_but_qr_handles_local_codes() {
        for code in [400, 502] {
            let svc = service(vec![response(json!({"code":code,"message":"failed"}))]);
            assert_eq!(
                block_on(svc.search_songs(
                    "x",
                    PageRequest {
                        limit: 1,
                        offset: 0
                    }
                )),
                Err(Error::Api {
                    code,
                    message: "failed".into()
                })
            );
        }
        let svc = service(vec![response(json!({"code":802}))]);
        assert_eq!(
            block_on(svc.check_login_qr_state("key")).unwrap(),
            LoginQrState::Scanned
        );
    }

    #[test]
    fn writes_fail_closed_and_anti_cheat_is_internal() {
        let svc = service(vec![
            response(json!({"code":200,"result":{}})),
            response(json!({"code":200,"result":{"conf":"internal-token"}})),
            response(json!({"code":200})),
        ]);
        assert_eq!(block_on(svc.like_song(7, true)), Err(Error::LoginRequired));
        svc.set_user_cookie("MUSIC_U=user; __csrf=x");
        assert!(matches!(
            block_on(svc.subscribe_playlist(9, true)),
            Err(Error::InvalidResponse(_))
        ));
        assert!(block_on(svc.subscribe_playlist(9, true)).unwrap().succeeded);
        let requests = svc.transport.requests.lock().unwrap();
        assert_eq!(requests[0].method, Method::Get);
        assert_eq!(requests[1].method, Method::Get);
        assert_eq!(
            requests[2]
                .headers
                .get("X-antiCheatToken")
                .map(String::as_str),
            Some("internal-token")
        );
        assert!(!serde_json::to_string(&MutationResult { succeeded: true })
            .unwrap()
            .contains("token"));
    }

    #[test]
    fn startup_verifies_public_key_and_tolerates_anonymous_failure() {
        let encrypted = crypto::encrypt_xeapi_public_key_fixture(&json!({
            "publicKey": BASE64.encode([7u8; 32]),
            "sk": "fixture-sk",
            "version": "3"
        }));
        struct BootstrapFake {
            encrypted: String,
            requests: Mutex<Vec<HttpRequest>>,
        }
        #[async_trait]
        impl Transport for BootstrapFake {
            async fn execute(&self, request: HttpRequest) -> Result<crate::HttpResponse> {
                self.requests.lock().unwrap().push(request.clone());
                if request.url.contains("security/key/get") {
                    let form = String::from_utf8(request.body).unwrap();
                    let nonce = form
                        .split('&')
                        .find_map(|part| part.strip_prefix("nonce="))
                        .unwrap();
                    let timestamp = "1700000000000";
                    return response(json!({
                        "code":200,
                        "data":{
                            "encryptedData":self.encrypted,
                            "timestamp":1700000000000u64,
                            "signature":crypto::xeapi_sign(timestamp, nonce)
                        }
                    }));
                }
                Err(Error::Transport("匿名注册离线失败".into()))
            }
        }
        let mut rng = StdRng::seed_from_u64(4);
        let svc = NeteaseService::with_sleeper(
            BootstrapFake {
                encrypted,
                requests: Mutex::new(vec![]),
            },
            Session::new(&mut rng),
            NoSleep,
        );
        block_on(svc.bootstrap_network()).unwrap();
        assert_eq!(
            svc.session.lock().unwrap().xeapi_key().unwrap().version,
            "3"
        );
        assert_eq!(svc.transport.requests.lock().unwrap().len(), 2);
    }

    #[test]
    fn startup_rejects_bad_public_key_signature() {
        let encrypted = crypto::encrypt_xeapi_public_key_fixture(&json!({
            "publicKey": BASE64.encode([7u8; 32]), "sk":"x", "version":"1"
        }));
        let svc = service(vec![response(json!({
            "code":200,"data":{"encryptedData":encrypted,"timestamp":"1","signature":"bad"}
        }))]);
        assert!(matches!(
            block_on(svc.bootstrap_network()),
            Err(Error::Crypto(_))
        ));
    }

    #[test]
    fn domain_fixtures_map_to_product_dtos() {
        let svc = service(vec![
            response(
                json!({"code":200,"album":{"id":2,"name":"Album","picUrl":"cover","artist":{"id":3,"name":"Artist"}},"songs":[{"id":1,"name":"Song","ar":[{"id":3,"name":"Artist"}],"al":{"id":2,"name":"Album"}}]}),
            ),
            response(
                json!({"code":200,"data":{"comments":[{"commentId":8,"content":"text","user":{"userId":4,"nickname":"User"}}],"totalCount":1,"hasMore":false,"cursor":"1"}}),
            ),
            response(
                json!({"code":200,"data":[{"songId":11,"fileName":"a.flac","fileSize":99,"simpleSong":{"id":11,"name":"Cloud","ar":[],"al":{"id":0,"name":""}}}],"count":1,"hasMore":false}),
            ),
        ]);
        let album = block_on(svc.album_detail(2)).unwrap();
        assert_eq!(album.tracks[0].album.id, 2);
        let comments = block_on(svc.comments(
            CommentResource::Song,
            1,
            PageRequest {
                limit: 20,
                offset: 0,
            },
        ))
        .unwrap();
        assert_eq!(comments.comments[0].user.as_ref().unwrap().user_id, 4);
        let cloud = block_on(svc.cloud_songs(PageRequest {
            limit: 30,
            offset: 0,
        }))
        .unwrap();
        assert_eq!(cloud.songs[0].file_name.as_deref(), Some("a.flac"));
    }

    #[test]
    fn anonymous_registration_cookie_stays_private() {
        let svc = service(vec![encrypted_xeapi_response(json!({
            "code":200,"cookie":["MUSIC_A=anonymous-secret; Path=/"]
        }))]);
        assert!(block_on(svc.register_anonymous()).unwrap());
        assert_eq!(
            svc.session
                .lock()
                .unwrap()
                .request_cookies()
                .get("MUSIC_A")
                .map(String::as_str),
            Some("anonymous-secret")
        );
    }

    #[test]
    fn production_entry_applies_disabled_config_without_network() {
        let mut rng = StdRng::seed_from_u64(99);
        let service = NeteaseService::production(
            ProductionConfig {
                enabled: false,
                ..ProductionConfig::default()
            },
            Session::new(&mut rng),
        )
        .unwrap();

        assert!(!service.is_enabled());
        assert_eq!(
            block_on(service.eapi("/api/test", json!({}), Duration::from_secs(1))),
            Err(Error::Transport("网易云音源已禁用".into()))
        );
    }
    #[test]
    fn service_can_replace_session_and_fail_closed_when_disabled() {
        let svc = service(vec![]);
        let mut rng = StdRng::seed_from_u64(42);
        let mut replacement = Session::new(&mut rng);
        replacement.set_user_cookie("MUSIC_U=replacement");
        svc.update_session(replacement);
        assert_eq!(
            svc.session.lock().unwrap().current_user_cookie().as_deref(),
            Some("MUSIC_U=replacement")
        );

        svc.set_enabled(false);
        assert!(!svc.is_enabled());
        assert_eq!(
            block_on(svc.eapi("/api/test", json!({}), Duration::from_secs(1))),
            Err(Error::Transport("网易云音源已禁用".into()))
        );
        assert!(svc.transport.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn search_entity_fixtures_map_without_transport_details() {
        let svc = service(vec![
            response(
                json!({"code":200,"result":{"albums":[{"id":2,"name":"Album","picUrl":"cover"}]}}),
            ),
            response(
                json!({"code":200,"result":{"artists":[{"id":3,"name":"Artist","alias":["Alias"]}]}}),
            ),
            response(
                json!({"code":200,"result":{"playlists":[{"id":4,"name":"List","trackCount":5,"creator":{"userId":6,"nickname":"Owner"}}]}}),
            ),
        ]);
        let page = PageRequest {
            limit: 20,
            offset: 0,
        };
        let albums = block_on(svc.search("album", SearchKind::Album, page)).unwrap();
        let artists = block_on(svc.search("artist", SearchKind::Artist, page)).unwrap();
        let playlists = block_on(svc.search("list", SearchKind::Playlist, page)).unwrap();
        assert_eq!(albums.albums[0].id, 2);
        assert_eq!(artists.artists[0].aliases, vec!["Alias"]);
        assert_eq!(playlists.playlists[0].owner_id, 6);
        let encoded = serde_json::to_string(&(albums, artists, playlists)).unwrap();
        for forbidden in ["cookie", "RawBody", "/api/", "interfacepc"] {
            assert!(!encoded.contains(forbidden));
        }
    }

    #[test]
    fn mv_and_dj_fixtures_map_to_use_case_dtos() {
        let svc = service(vec![
            response(
                json!({"code":200,"data":[{"id":7,"name":"MV","cover":"mv-cover","duration":9,"artists":[{"id":8,"name":"Singer"}]}]}),
            ),
            response(
                json!({"code":200,"data":{"id":7,"name":"MV","desc":"detail","publishTime":"2026-01-01","subCount":2}}),
            ),
            response(
                json!({"code":200,"djRadios":[{"id":10,"name":"Radio","picUrl":"radio-cover","programCount":3}]}),
            ),
            response(
                json!({"code":200,"programs":[{"id":11,"name":"Episode","radio":{"id":10,"name":"Radio"},"mainSong":{"id":12,"name":"Song","ar":[],"al":{"id":0,"name":""}}}]}),
            ),
        ]);
        let page = PageRequest {
            limit: 20,
            offset: 0,
        };
        assert_eq!(
            block_on(svc.mvs("全部", "全部", "最新", page)).unwrap()[0].id,
            7
        );
        assert_eq!(
            block_on(svc.mv_detail(7)).unwrap().description.as_deref(),
            Some("detail")
        );
        assert_eq!(
            block_on(svc.dj_radios(page)).unwrap()[0].program_count,
            Some(3)
        );
        assert_eq!(
            block_on(svc.dj_programs(10, false, page)).unwrap()[0]
                .main_track
                .as_ref()
                .unwrap()
                .id,
            12
        );
    }

    #[test]
    fn chart_and_new_song_fixtures_are_normalized() {
        let svc = service(vec![
            response(
                json!({"code":200,"list":[{"id":20,"name":"Chart","updateFrequency":"daily","tracks":[{"id":21,"name":"Preview","ar":[],"al":{"id":0,"name":""}}]}]}),
            ),
            response(
                json!({"code":200,"data":[{"id":22,"name":"New","ar":[],"al":{"id":0,"name":""}}]}),
            ),
        ]);
        assert_eq!(block_on(svc.charts()).unwrap()[0].preview_tracks[0].id, 21);
        assert_eq!(block_on(svc.new_songs(96)).unwrap()[0].id, 22);
        assert!(block_on(svc.new_songs(999)).is_err());
    }

    #[test]
    fn listen_footprint_fixtures_map_reports_and_rankings() {
        let svc = service(vec![
            response(json!({"code":200,"data":{"listenTime":7200,"playCount":31}})),
            response(
                json!({"code":200,"data":{"totalMinutes":45,"playCount":12,"songs":[{"id":30,"name":"Report Song","ar":[],"al":{"id":0,"name":""}}]}}),
            ),
            response(
                json!({"code":200,"data":{"songPlayRank":[{"song":{"id":31,"name":"Ranked","ar":[],"al":{"id":0,"name":""}}}]}}),
            ),
        ]);
        let total = block_on(svc.listen_total()).unwrap();
        assert_eq!((total.total_minutes, total.total_plays), (120, 31));
        let report = block_on(svc.listen_report("month", Some("2026-08-01"))).unwrap();
        assert_eq!(report.stats.songs[0].id, 30);
        assert_eq!(
            block_on(svc.listen_song_rank("week", None)).unwrap()[0].id,
            31
        );
    }

    #[test]
    fn event_and_message_fixtures_map_cursor_pages() {
        let svc = service(vec![
            response(
                json!({"code":200,"event":[{"id":40,"type":"share","eventTime":5,"user":{"userId":2,"nickname":"User"},"msg":"hello"}],"more":true,"lasttime":4}),
            ),
            response(
                json!({"code":200,"events":[{"eventId":41,"showTime":6,"text":"mine"}],"hasMore":false}),
            ),
            response(
                json!({"code":200,"notices":[{"noticeId":42,"time":7,"title":"Notice","notice":"text"}],"more":false}),
            ),
        ]);
        let followed = block_on(svc.followed_events(None, 20)).unwrap();
        assert_eq!(followed.items[0].user.as_ref().unwrap().user_id, 2);
        assert_eq!(followed.next_cursor, Some(4));
        assert_eq!(
            block_on(svc.user_events(2, None, 20)).unwrap().items[0].id,
            41
        );
        assert_eq!(
            block_on(svc.notices(None, 20)).unwrap().items[0].text,
            "text"
        );
    }

    #[test]
    fn cloud_and_catalog_writes_require_login_and_keep_tokens_private() {
        let svc = service(vec![
            response(json!({"code":200})),
            response(json!({"code":200})),
        ]);
        assert_eq!(
            block_on(svc.delete_cloud_song(50)),
            Err(Error::LoginRequired)
        );
        assert_eq!(
            block_on(svc.subscribe_mv(7, true)),
            Err(Error::LoginRequired)
        );
        assert_eq!(
            block_on(svc.subscribe_dj_radio(8, true)),
            Err(Error::LoginRequired)
        );
        svc.set_user_cookie("MUSIC_U=user");
        assert!(block_on(svc.delete_cloud_song(50)).unwrap().succeeded);
        assert!(block_on(svc.subscribe_mv(7, true)).unwrap().succeeded);
        let encoded = serde_json::to_string(&MutationResult { succeeded: true }).unwrap();
        assert!(!encoded.contains("token"));
        assert!(!encoded.contains("cookie"));
    }
}
