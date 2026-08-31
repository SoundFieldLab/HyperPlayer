use aes::{Aes128, Aes256};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use cipher::KeyInit;
use hmac::{Hmac, Mac};
use md5::{Digest as _, Md5};
use rand::{CryptoRng, RngCore};
use sha2::Sha256;
use std::io::Read;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::{Error, Result};

type HmacSha256 = Hmac<Sha256>;

pub const EAPI_KEY: &[u8; 16] = b"e82ckenh8dichen8";
pub const XEAPI_STATIC_KEY: [u8; 32] = [
    0xab, 0x1d, 0x5a, 0x43, 0x0f, 0x6b, 0xb0, 0x4a, 0x3f, 0x01, 0xe8, 0x1d, 0xdd, 0x72, 0xbd, 0x91,
    0x6d, 0x5c, 0xe5, 0x91, 0x24, 0x8a, 0xc1, 0x28, 0x71, 0x48, 0x06, 0xd7, 0xf8, 0xfb, 0x1b, 0x84,
];
pub const XEAPI_SIGN_KEY: &str =
    "mUHCwVNWJbunMqAHf5MImuirT6plvs6VSFW62MGHstFQxhBGdEoIhLItH3djc4+FB/OKty3+lL2rGeoFBpVe5g==";

fn aes128_ecb_encrypt(key: &[u8; 16], plaintext: &[u8]) -> Result<Vec<u8>> {
    use cipher::BlockEncrypt;
    let cipher = Aes128::new_from_slice(key).map_err(|e| Error::Crypto(e.to_string()))?;
    let pad = 16 - (plaintext.len() % 16);
    let mut buf = plaintext.to_vec();
    buf.extend(std::iter::repeat_n(pad as u8, pad));
    for chunk in buf.chunks_exact_mut(16) {
        cipher.encrypt_block(chunk.into());
    }
    Ok(buf)
}
fn aes256_ecb_encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>> {
    use cipher::BlockEncrypt;
    let cipher = Aes256::new_from_slice(key).map_err(|e| Error::Crypto(e.to_string()))?;
    let pad = 16 - (plaintext.len() % 16);
    let mut buf = plaintext.to_vec();
    buf.extend(std::iter::repeat_n(pad as u8, pad));
    for chunk in buf.chunks_exact_mut(16) {
        cipher.encrypt_block(chunk.into());
    }
    Ok(buf)
}
fn aes128_ecb_decrypt(key: &[u8; 16], ciphertext: &[u8]) -> Result<Vec<u8>> {
    use cipher::BlockDecrypt;
    if ciphertext.is_empty() || !ciphertext.len().is_multiple_of(16) {
        return Err(Error::Crypto("ECB 密文长度无效".into()));
    }
    let cipher = Aes128::new_from_slice(key).map_err(|e| Error::Crypto(e.to_string()))?;
    let mut out = ciphertext.to_vec();
    for chunk in out.chunks_exact_mut(16) {
        cipher.decrypt_block(chunk.into());
    }
    let pad = *out.last().unwrap() as usize;
    if pad == 0
        || pad > 16
        || out.len() < pad
        || !out[out.len() - pad..].iter().all(|v| *v as usize == pad)
    {
        return Err(Error::Crypto("PKCS#7 填充无效".into()));
    }
    out.truncate(out.len() - pad);
    Ok(out)
}

pub fn encrypt_eapi(path: &str, payload_json: &str) -> Result<String> {
    let digest = format!(
        "{:x}",
        Md5::digest(format!("nobody{path}use{payload_json}md5forencrypt").as_bytes())
    );
    let plain = format!("{path}-36cd479b6b5-{payload_json}-36cd479b6b5-{digest}");
    Ok(hex_upper(&aes128_ecb_encrypt(EAPI_KEY, plain.as_bytes())?))
}

pub fn xeapi_sign(timestamp: &str, nonce: &str) -> String {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(XEAPI_SIGN_KEY.as_bytes()).expect("HMAC key");
    mac.update(format!("{timestamp}{nonce}").as_bytes());
    BASE64.encode(mac.finalize().into_bytes())
}

pub fn xeapi_mid_transform(ciphertext: &[u8], random: [u8; 16]) -> Vec<u8> {
    let xored: Vec<u8> = ciphertext
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ random[i & 0x0f])
        .collect();
    let encoded = BASE64.encode(xored).into_bytes();
    let rotation = if encoded.is_empty() {
        0
    } else {
        (random[0] & 0x0f) as usize % encoded.len()
    };
    let mut out = random.to_vec();
    out.extend_from_slice(&encoded[rotation..]);
    out.extend_from_slice(&encoded[..rotation]);
    out
}

fn form_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => vec![b as char],
            b' ' => vec!['+'],
            _ => format!("%{b:02X}").chars().collect(),
        })
        .collect()
}

pub fn build_xeapi_plaintext(
    payload: &serde_json::Map<String, serde_json::Value>,
) -> Result<String> {
    let mut fields = Vec::new();
    for (key, value) in payload {
        if key == "e_r" {
            continue;
        }
        let text = value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        fields.push(format!("{}={}", form_encode(key), form_encode(&text)));
    }
    let body = BASE64.encode(fields.join("&"));
    Ok(serde_json::json!({"body":body,"queryString":"e_r=true"}).to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XeapiFields {
    pub b: String,
    pub s: String,
    pub r: String,
}

pub fn encrypt_xeapi<R: RngCore + CryptoRng>(
    payload: &serde_json::Map<String, serde_json::Value>,
    public_key: [u8; 32],
    sk: &str,
    version: &str,
    session: Option<(&str, &str)>,
    rng: &mut R,
) -> Result<XeapiFields> {
    let mut dynamic = [0u8; 16];
    if let Some((key, _)) = session {
        if key.len() != 16 {
            return Err(Error::Crypto("xeapi 会话密钥必须为 16 字节".into()));
        }
        dynamic.copy_from_slice(key.as_bytes())
    } else {
        rng.fill_bytes(&mut dynamic)
    }
    let first = aes256_ecb_encrypt(
        &XEAPI_STATIC_KEY,
        build_xeapi_plaintext(payload)?.as_bytes(),
    )?;
    let mut salt = [0u8; 16];
    rng.fill_bytes(&mut salt);
    let mid = xeapi_mid_transform(&first, salt);
    let b = aes128_ecb_encrypt(&dynamic, &mid)?;
    let secret = StaticSecret::random_from_rng(&mut *rng);
    let ephemeral = PublicKey::from(&secret);
    let peer = PublicKey::from(public_key);
    let shared = secret.diffie_hellman(&peer);
    let mut extract = <HmacSha256 as Mac>::new_from_slice(&[0u8; 32]).unwrap();
    extract.update(shared.as_bytes());
    let prk = extract.finalize().into_bytes();
    let mut expand = <HmacSha256 as Mac>::new_from_slice(&prk).unwrap();
    expand.update(ephemeral.as_bytes());
    expand.update(&[1]);
    let aes_key = expand.finalize().into_bytes();
    let envelope_plain = format!("{}|android|{}", BASE64.encode(dynamic), sk);
    let mut iv = [0u8; 12];
    rng.fill_bytes(&mut iv);
    // GCM is implemented explicitly to keep the dependency set small: CTR encryption plus GHASH.
    let (ciphertext, tag) = gcm_encrypt(&aes_key[..16], &iv, envelope_plain.as_bytes())?;
    let mut s = ephemeral.as_bytes().to_vec();
    s.extend_from_slice(&iv);
    s.extend(ciphertext);
    s.extend(tag);
    let session_id = session.map(|(_, id)| id).unwrap_or("");
    let r = aes256_ecb_encrypt(
        &XEAPI_STATIC_KEY,
        format!("{version}|{session_id}").as_bytes(),
    )?;
    Ok(XeapiFields {
        b: BASE64.encode(b),
        s: BASE64.encode(s),
        r: BASE64.encode(r),
    })
}

fn gcm_encrypt(key: &[u8], iv: &[u8; 12], plain: &[u8]) -> Result<(Vec<u8>, [u8; 16])> {
    use cipher::BlockEncrypt;
    let cipher = Aes128::new_from_slice(key).map_err(|e| Error::Crypto(e.to_string()))?;
    let mut h = [0u8; 16];
    cipher.encrypt_block((&mut h).into());
    let mut j0 = [0u8; 16];
    j0[..12].copy_from_slice(iv);
    j0[15] = 1;
    let mut out = Vec::with_capacity(plain.len());
    let mut ctr = j0;
    for chunk in plain.chunks(16) {
        inc32(&mut ctr);
        let mut stream = ctr;
        cipher.encrypt_block((&mut stream).into());
        out.extend(chunk.iter().zip(stream).map(|(a, b)| a ^ b));
    }
    let mut auth = out.clone();
    let rem = auth.len() % 16;
    if rem != 0 {
        auth.resize(auth.len() + 16 - rem, 0)
    };
    auth.extend_from_slice(&[0u8; 8]);
    auth.extend_from_slice(&((out.len() as u64) * 8).to_be_bytes());
    let mut y = 0u128;
    let h = u128::from_be_bytes(h);
    for block in auth.chunks_exact(16) {
        y = gf_mul(y ^ u128::from_be_bytes(block.try_into().unwrap()), h)
    }
    let mut mask = j0;
    cipher.encrypt_block((&mut mask).into());
    let tag = (u128::from_be_bytes(mask) ^ y).to_be_bytes();
    Ok((out, tag))
}
fn inc32(v: &mut [u8; 16]) {
    let n = u32::from_be_bytes(v[12..].try_into().unwrap()).wrapping_add(1);
    v[12..].copy_from_slice(&n.to_be_bytes())
}
fn gf_mul(mut x: u128, mut y: u128) -> u128 {
    let mut z = 0;
    for _ in 0..128 {
        if x & (1 << 127) != 0 {
            z ^= y
        }
        let lsb = y & 1;
        y >>= 1;
        if lsb != 0 {
            y ^= 0xe1000000000000000000000000000000
        }
        x <<= 1
    }
    z
}

pub fn decrypt_xeapi_response(body: &[u8]) -> Result<serde_json::Value> {
    let plain = aes128_ecb_decrypt(EAPI_KEY, body)?;
    let bytes = if plain.starts_with(&[0x1f, 0x8b]) {
        let mut decoder = flate2::read::GzDecoder::new(&plain[..]);
        let mut out = Vec::new();
        decoder
            .read_to_end(&mut out)
            .map_err(|e| Error::Crypto(e.to_string()))?;
        out
    } else {
        plain
    };
    serde_json::from_slice(&bytes).map_err(|e| Error::InvalidResponse(e.to_string()))
}
pub fn decrypt_xeapi_public_key(encoded: &str) -> Result<serde_json::Value> {
    let bytes = BASE64
        .decode(encoded)
        .map_err(|e| Error::Crypto(e.to_string()))?;
    let plain = aes256_ecb_decrypt(&XEAPI_STATIC_KEY, &bytes)?;
    serde_json::from_slice(&plain).map_err(|e| Error::InvalidResponse(e.to_string()))
}
#[cfg(test)]
pub(crate) fn encrypt_xeapi_public_key_fixture(value: &serde_json::Value) -> String {
    BASE64.encode(aes256_ecb_encrypt(&XEAPI_STATIC_KEY, value.to_string().as_bytes()).unwrap())
}
fn aes256_ecb_decrypt(key: &[u8; 32], ciphertext: &[u8]) -> Result<Vec<u8>> {
    use cipher::BlockDecrypt;
    if ciphertext.is_empty() || !ciphertext.len().is_multiple_of(16) {
        return Err(Error::Crypto("ECB 密文长度无效".into()));
    }
    let cipher = Aes256::new_from_slice(key).map_err(|e| Error::Crypto(e.to_string()))?;
    let mut out = ciphertext.to_vec();
    for c in out.chunks_exact_mut(16) {
        cipher.decrypt_block(c.into())
    }
    let p = *out.last().unwrap() as usize;
    if p == 0 || p > 16 || out.len() < p || !out[out.len() - p..].iter().all(|v| *v as usize == p) {
        return Err(Error::Crypto("PKCS#7 填充无效".into()));
    }
    out.truncate(out.len() - p);
    Ok(out)
}
fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn eapi_golden() {
        assert_eq!(encrypt_eapi("/api/search/hot",r#"{"type":1111}"#).unwrap(),"886AF8D09CBF98AE6DEE4A18C0124D90E49B69771D767F86360407771BFDD3C55346E7287388955BC8B0B309407E1FFDFE54C6A08056D241E25CAD7CC52D860B4A0E502BFDED864A32608E0C40FDFAA4FA97FA5C1B98A742926FD24BECCD6D53")
    }
    #[test]
    fn sign_golden() {
        assert_eq!(
            xeapi_sign("1700000000000", "1234567890123456"),
            "AfwKXk83sQ/wAKzoswSsn7/DgRvQ6zfI4O5eOSKnkIA="
        )
    }
    #[test]
    fn mid_uses_mod_16() {
        let data = (0..32).collect::<Vec<_>>();
        let random = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        let encoded = BASE64
            .encode(
                data.iter()
                    .enumerate()
                    .map(|(i, b)| b ^ random[i & 15])
                    .collect::<Vec<_>>(),
            )
            .into_bytes();
        let mut expected = random.to_vec();
        expected.extend_from_slice(&encoded[1..]);
        expected.push(encoded[0]);
        assert_eq!(xeapi_mid_transform(&data, random), expected)
    }
}
