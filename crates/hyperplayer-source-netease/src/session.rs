use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use md5::{Digest, Md5};
use rand::{CryptoRng, RngCore};
use std::collections::BTreeMap;

use crate::{Error, Result};

const ID_XOR_KEY: &[u8] = b"3go8&$8*3*3h0k(2)2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XeapiKeyState {
    pub public_key: [u8; 32],
    pub sk: String,
    pub version: String,
}
#[derive(Debug, Clone)]
pub struct Session {
    device_id: String,
    /// 稳定设备画像：nuid（32 位 hex）与 WNMCID 一次生成、跨请求复用（对齐 oracle 的
    /// `base._ntes_nuid || randomHex(32)` 语义——oracle 每次调用会重建，但 Rust 会话
    /// 是有状态的，保持稳定更接近「同一设备」画像）。
    nuid: String,
    wnmcid: String,
    xeapi_key: Option<XeapiKeyState>,
    xeapi_session_id: String,
    xeapi_session_key: String,
    anonymous_token: Option<String>,
    user_cookie: BTreeMap<String, String>,
}
impl Session {
    pub fn new<R: RngCore + CryptoRng>(rng: &mut R) -> Self {
        let mut bytes = [0u8; 26];
        rng.fill_bytes(&mut bytes);
        let device_id = bytes.iter().map(|b| format!("{b:02X}")).collect();
        let nuid = random_hex(rng, 32);
        let wnmcid = format!("{}.{}.01.0", random_hex(rng, 6), now_ms());
        Self {
            device_id,
            nuid,
            wnmcid,
            xeapi_key: None,
            xeapi_session_id: String::new(),
            xeapi_session_key: String::new(),
            anonymous_token: None,
            user_cookie: BTreeMap::new(),
        }
    }
    pub fn device_id(&self) -> &str {
        &self.device_id
    }
    pub fn set_xeapi_key(&mut self, key: XeapiKeyState) {
        self.xeapi_key = Some(key)
    }
    pub fn xeapi_key(&self) -> Result<&XeapiKeyState> {
        self.xeapi_key
            .as_ref()
            .ok_or_else(|| Error::Crypto("xeapi 公钥未初始化".into()))
    }
    pub fn update_xeapi_session(&mut self, id: &str, key: &str) {
        if !id.is_empty() {
            self.xeapi_session_id = id.into()
        }
        if !key.is_empty() {
            self.xeapi_session_key = key.into()
        }
    }
    pub fn xeapi_session(&self) -> Option<(&str, &str)> {
        (!self.xeapi_session_key.is_empty()).then_some((
            self.xeapi_session_key.as_str(),
            self.xeapi_session_id.as_str(),
        ))
    }
    pub fn set_anonymous_token(&mut self, token: impl Into<String>) {
        let token = token.into();
        if !token.is_empty() {
            self.anonymous_token = Some(token)
        }
    }
    pub fn set_user_cookie(&mut self, cookie: &str) {
        self.user_cookie = parse_cookie(cookie)
    }
    pub fn clear_user_cookie(&mut self) {
        self.user_cookie.clear()
    }
    pub fn current_request_cookie(&self) -> Option<String> {
        let cookies = self.request_cookies();
        (!cookies.is_empty()).then(|| serialize_cookie(&cookies))
    }

    pub fn current_user_cookie(&self) -> Option<String> {
        if self.user_cookie.is_empty() {
            None
        } else {
            Some(serialize_cookie(&self.user_cookie))
        }
    }
    pub(crate) fn anonymous_token_present(&self) -> bool {
        self.anonymous_token
            .as_deref()
            .is_some_and(|token| !token.is_empty())
    }

    pub(crate) fn is_logged_in(&self) -> bool {
        self.user_cookie
            .get("MUSIC_U")
            .is_some_and(|value| !value.is_empty())
    }
    pub fn encoded_anonymous_username(&self) -> String {
        let xored: Vec<u8> = self
            .device_id
            .as_bytes()
            .iter()
            .enumerate()
            .map(|(i, b)| b ^ ID_XOR_KEY[i % ID_XOR_KEY.len()])
            .collect();
        let fingerprint = BASE64.encode(Md5::digest(xored));
        BASE64.encode(format!("{} {}", self.device_id, fingerprint))
    }
    pub(crate) fn request_cookies(&self) -> BTreeMap<String, String> {
        let now = now_ms();
        let mut out = self.user_cookie.clone();
        out.insert("os".into(), "pc".into());
        out.insert("osver".into(), DEVICE_OSVER.into());
        out.insert("channel".into(), DEVICE_CHANNEL.into());
        out.insert("appver".into(), DEVICE_APPVER.into());
        out.insert("__remember_me".into(), "true".into());
        out.insert("ntes_kaola_ad".into(), "1".into());
        out.insert("_ntes_nuid".into(), self.nuid.clone());
        out.insert("_ntes_nnid".into(), format!("{},{}", self.nuid, now));
        out.insert("WNMCID".into(), self.wnmcid.clone());
        out.insert("WEVNSM".into(), "1.0.0".into());
        out.insert("deviceId".into(), self.device_id.clone());
        if !out.contains_key("MUSIC_U") {
            if let Some(v) = &self.anonymous_token {
                out.insert("MUSIC_A".into(), v.clone());
            }
        }
        out
    }
    /// xeapi 通道专用设备画像：不注入匿名 token（避免鸡生蛋），登录态显式携带。
    pub(crate) fn xeapi_cookie(&self) -> String {
        let now = now_ms();
        let mut out = BTreeMap::new();
        out.insert("os".into(), XEAPI_OS.into());
        out.insert("osver".into(), XEAPI_OSVER.into());
        out.insert("appver".into(), XEAPI_APP_VERSION.into());
        out.insert("buildver".into(), now.to_string());
        out.insert("deviceId".into(), self.device_id.clone());
        out.insert("sDeviceId".into(), self.device_id.clone());
        out.insert("__remember_me".into(), "true".into());
        out.insert("ntes_kaola_ad".into(), "1".into());
        out.insert("_ntes_nuid".into(), self.nuid.clone());
        out.insert("_ntes_nnid".into(), format!("{},{}", self.nuid, now));
        out.insert("WNMCID".into(), self.wnmcid.clone());
        out.insert("WEVNSM".into(), "1.0.0".into());
        if let Some(value) = self.user_cookie.get("MUSIC_U") {
            out.insert("MUSIC_U".into(), value.clone());
        }
        serialize_cookie(&out)
    }
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
fn random_hex<R: RngCore>(rng: &mut R, length: usize) -> String {
    let mut bytes = vec![0u8; length];
    rng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
const DEVICE_OSVER: &str = "Microsoft-Windows-10-Professional-build-19045-64bit";
const DEVICE_APPVER: &str = "3.1.17.204416";
const DEVICE_CHANNEL: &str = "netease";
const XEAPI_OS: &str = "android";
const XEAPI_OSVER: &str = "16";
const XEAPI_APP_VERSION: &str = "9.1.65";
fn parse_cookie(value: &str) -> BTreeMap<String, String> {
    value
        .split(';')
        .filter_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (!key.is_empty()).then(|| (key.to_owned(), value.to_owned()))
        })
        .collect()
}
pub(crate) fn serialize_cookie(value: &BTreeMap<String, String>) -> String {
    value
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{rngs::StdRng, SeedableRng};
    #[test]
    fn device_id_and_username_are_stable() {
        let mut rng = StdRng::seed_from_u64(7);
        let s = Session::new(&mut rng);
        assert_eq!(s.device_id().len(), 52);
        assert!(s
            .device_id()
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_lowercase()));
        assert!(!s.encoded_anonymous_username().is_empty())
    }
    #[test]
    fn cookie_is_private_and_login_wins() {
        let mut rng = StdRng::seed_from_u64(1);
        let mut s = Session::new(&mut rng);
        s.set_anonymous_token("anon");
        assert_eq!(s.request_cookies().get("MUSIC_A").unwrap(), "anon");
        assert!(s.current_request_cookie().unwrap().contains("MUSIC_A=anon"));
        s.set_user_cookie("MUSIC_U=user; __csrf=x");
        let c = s.request_cookies();
        assert_eq!(c.get("MUSIC_U").unwrap(), "user");
        assert!(!c.contains_key("MUSIC_A"));
    }
}
