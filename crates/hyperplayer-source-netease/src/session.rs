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
        Self {
            device_id: bytes.iter().map(|b| format!("{b:02X}")).collect(),
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
    pub fn current_user_cookie(&self) -> Option<String> {
        if self.user_cookie.is_empty() {
            None
        } else {
            Some(serialize_cookie(&self.user_cookie))
        }
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
        let mut out = self.user_cookie.clone();
        out.insert("os".into(), "pc".into());
        out.insert("deviceId".into(), self.device_id.clone());
        if !out.contains_key("MUSIC_U") {
            if let Some(v) = &self.anonymous_token {
                out.insert("MUSIC_A".into(), v.clone());
            }
        }
        out
    }
}
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
        s.set_user_cookie("MUSIC_U=user; __csrf=x");
        let c = s.request_cookies();
        assert_eq!(c.get("MUSIC_U").unwrap(), "user");
        assert!(!c.contains_key("MUSIC_A"));
    }
}
