use aes::{Aes128, Aes256};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use cipher::KeyInit;
use hmac::{Hmac, Mac};
use md5::{Digest as _, Md5};
use num_bigint::BigUint;
use rand::{CryptoRng, RngCore};
use sha2::Sha256;
use std::io::Read;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::{Error, Result};

type HmacSha256 = Hmac<Sha256>;

pub const EAPI_KEY: &[u8; 16] = b"e82ckenh8dichen8";
/// weapi 备用算法（规范：「weapi ⛔ 已绕行 eapi，算法保留备用」）。
const WEAPI_PRESET_KEY: &[u8; 16] = b"0CoJUm6Qyw8W8jud";
const WEAPI_IV: &[u8; 16] = b"0102030405060708";
const WEAPI_SECRET_POOL: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/// oracle `RSA_WEAPI_PUBLIC_KEY_PEM` 的 base64 主体（SubjectPublicKeyInfo DER）。
const WEAPI_PUBLIC_KEY_DER_B64: &str = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB";
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
    for chunk in buf.as_chunks_mut::<16>().0 {
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
    for chunk in buf.as_chunks_mut::<16>().0 {
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
    for chunk in out.as_chunks_mut::<16>().0 {
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

/// weapi 备用算法（规范：「weapi ⛔ 已绕行 eapi，算法保留备用」；oracle `encryptWeapi`
/// 语义）：随机 16 字符 secret → 双层 AES-128-CBC（固定预设密钥 + 随机 secret）→
/// reversed secret 做 raw RSA（无填充，指数 65537）→ hex 大写。仅备用，不进主链路。
pub fn encrypt_weapi<R: RngCore + CryptoRng>(
    payload_json: &str,
    rng: &mut R,
) -> Result<(String, String)> {
    let mut secret = [0u8; 16];
    for slot in &mut secret {
        *slot = WEAPI_SECRET_POOL[(rng.next_u32() as usize) % WEAPI_SECRET_POOL.len()];
    }
    // oracle `encryptWeapi` 语义：第一层输出经 base64 字符串作为第二层明文（oracle
    // 的 aesCbcBase64 返回字符串再作为入参），最终结果再 base64。
    let inner = aes128_cbc_encrypt(WEAPI_PRESET_KEY, WEAPI_IV, payload_json.as_bytes())?;
    let inner_b64 = BASE64.encode(inner);
    let params = aes128_cbc_encrypt(&secret, WEAPI_IV, inner_b64.as_bytes())?;
    let enc_sec_key = rsa_no_pad_weapi(&secret)?;
    Ok((BASE64.encode(params), enc_sec_key))
}

/// AES-128-CBC（PKCS#7 填充）：前一块密文作为下一块 IV（首块用显式 IV）。
fn aes128_cbc_encrypt(key: &[u8; 16], iv: &[u8; 16], plaintext: &[u8]) -> Result<Vec<u8>> {
    use cipher::BlockEncrypt;
    let cipher = Aes128::new_from_slice(key).map_err(|e| Error::Crypto(e.to_string()))?;
    let pad = 16 - (plaintext.len() % 16);
    let mut buf = plaintext.to_vec();
    buf.extend(std::iter::repeat_n(pad as u8, pad));
    let mut previous = *iv;
    for chunk in buf.as_chunks_mut::<16>().0 {
        for (byte, prev) in chunk.iter_mut().zip(previous.iter()) {
            *byte ^= prev;
        }
        cipher.encrypt_block(chunk.into());
        previous.copy_from_slice(chunk);
    }
    Ok(buf)
}

/// raw RSA（无填充）：secret（原序）右对齐到 128 字节（高位补零 = 大端整数），
/// `m^65537 mod n`，输出 128 字节 hex 大写。与 oracle `rsaNoPad` 逐字节语义一致
/// （oracle 调用方反转 + rsaNoPad 内部再反转，净效果为原序右对齐）。
fn rsa_no_pad_weapi(secret: &[u8; 16]) -> Result<String> {
    let der = BASE64
        .decode(WEAPI_PUBLIC_KEY_DER_B64)
        .map_err(|e| Error::Crypto(e.to_string()))?;
    // SubjectPublicKeyInfo（162B，1024 位密钥）：SEQUENCE(3) + OID(15) + BIT STRING 头(4)
    // + SEQUENCE(3) + INTEGER 头(4，含前导 0x00) = 偏移 29，其后 128 字节即模数。
    let modulus = der
        .get(29..29 + 128)
        .ok_or_else(|| Error::Crypto("weapi 公钥长度无效".into()))?;
    let n = BigUint::from_bytes_be(modulus);
    let mut block = [0u8; 128];
    block[128 - secret.len()..].copy_from_slice(secret);
    let m = BigUint::from_bytes_be(&block);
    let c = m.modpow(&BigUint::from(65_537_u32), &n);
    let mut bytes = c.to_bytes_be();
    if bytes.len() < 128 {
        let mut padded = vec![0u8; 128 - bytes.len()];
        padded.append(&mut bytes);
        bytes = padded;
    }
    Ok(hex_upper(&bytes))
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
    for block in auth.as_chunks::<16>().0 {
        y = gf_mul(y ^ u128::from_be_bytes(*block), h)
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
    let value = encoded.trim();
    if value.is_empty() {
        return Err(Error::Crypto("xeapi 公钥密文为空".into()));
    }
    let mut candidates = Vec::new();
    if value.len().is_multiple_of(2) && value.bytes().all(|b| b.is_ascii_hexdigit()) {
        candidates.push(
            (0..value.len())
                .step_by(2)
                .map(|i| {
                    u8::from_str_radix(&value[i..i + 2], 16)
                        .map_err(|e| Error::Crypto(e.to_string()))
                })
                .collect::<Result<Vec<_>>>()?,
        );
    }
    if let Ok(decoded) = BASE64.decode(value) {
        if decoded.len().is_multiple_of(2) && decoded.iter().all(|b| b.is_ascii_hexdigit()) {
            candidates.push(
                (0..decoded.len())
                    .step_by(2)
                    .map(|i| {
                        u8::from_str_radix(std::str::from_utf8(&decoded[i..i + 2]).unwrap(), 16)
                            .map_err(|e| Error::Crypto(e.to_string()))
                    })
                    .collect::<Result<Vec<_>>>()?,
            );
        }
        candidates.push(decoded);
    }
    let mut last_error = None;
    for bytes in candidates {
        match aes256_ecb_decrypt(&XEAPI_STATIC_KEY, &bytes).and_then(|plain| {
            serde_json::from_slice(&plain).map_err(|e| Error::InvalidResponse(e.to_string()))
        }) {
            Ok(value) => return Ok(value),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| Error::Crypto("xeapi 公钥密文编码无效".into())))
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
    for c in out.as_chunks_mut::<16>().0 {
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
    use rand::{rngs::StdRng, SeedableRng};
    use serde_json::json;
    #[test]
    fn weapi_golden_enc_sec_key_matches_node_rsa_no_padding() {
        // Node crypto RSA_NO_PADDING 权威向量（secret 原序右对齐 128B，指数 65537）。
        let enc = rsa_no_pad_weapi(b"0123456789abcdef").unwrap();
        assert_eq!(
            enc,
            "AC744CAAB466F1FD5A75228365D15DF7ADD288E8982A2C8F80DA5F8F22D54834B5E1EAB04DDE9DAC7341851A98DE37463D8BA01D9E9C4D2C546C0F948E3163C667785A1B9C4F160305B0FB1EC3B698DE0C704719B2FBC469582654B9C2595317DC40C3ECEE32BAA6D9753970B66667C01BDE9AD34048FA8B2B0F628E56A5BF49"
        );
    }

    #[test]
    fn weapi_golden_params_matches_node_aes_cbc_chain() {
        // Node createCipheriv aes-128-cbc 权威向量：第一层预设密钥、第二层固定 secret。
        let payload = r#"{"type":1111}"#;
        let preset = aes128_cbc_encrypt(WEAPI_PRESET_KEY, WEAPI_IV, payload.as_bytes()).unwrap();
        assert_eq!(BASE64.encode(&preset), "lX/DZ30PR36d7gwhVQM3sg==");
        // oracle 语义：第二层明文是第一层结果的 base64 字符串。
        let params = aes128_cbc_encrypt(
            b"0123456789abcdef",
            WEAPI_IV,
            BASE64.encode(&preset).as_bytes(),
        )
        .unwrap();
        assert_eq!(
            BASE64.encode(&params),
            "r2Yt5tGUKF2WXM5ONk7ybjWZxa0Vygl0TM3s3UXfIPI="
        );
    }

    #[test]
    fn weapi_round_trip_with_fixed_secret_is_deterministic() {
        // 随机性只来自 secret：固定 secret 时两次调用产物一致（raw RSA 无随机填充）。
        let payload = r#"{"a":1}"#;
        let (p1, k1) = encrypt_weapi(payload, &mut StdRng::seed_from_u64(3)).unwrap();
        let (p2, k2) = encrypt_weapi(payload, &mut StdRng::seed_from_u64(3)).unwrap();
        assert_eq!(p1, p2);
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 256);
        assert_eq!(p1.len(), 44);
    }

    #[test]
    fn eapi_golden() {
        assert_eq!(encrypt_eapi("/api/search/hot",r#"{"type":1111}"#).unwrap(),"886AF8D09CBF98AE6DEE4A18C0124D90E49B69771D767F86360407771BFDD3C55346E7287388955BC8B0B309407E1FFDFE54C6A08056D241E25CAD7CC52D860B4A0E502BFDED864A32608E0C40FDFAA4FA97FA5C1B98A742926FD24BECCD6D53")
    }
    #[test]
    fn public_key_decoder_accepts_hex_ciphertext() {
        let value =
            json!({ "publicKey": BASE64.encode([7u8; 32]), "sk": "fixture-sk", "version": "3" });
        let ciphertext =
            aes256_ecb_encrypt(&XEAPI_STATIC_KEY, value.to_string().as_bytes()).unwrap();
        let decoded = decrypt_xeapi_public_key(&hex_upper(&ciphertext)).unwrap();
        assert_eq!(decoded["version"], "3");
    }

    #[test]
    fn public_key_decoder_rejects_empty_and_odd_hex() {
        assert!(decrypt_xeapi_public_key("").is_err());
        assert!(decrypt_xeapi_public_key("ABC").is_err());
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
