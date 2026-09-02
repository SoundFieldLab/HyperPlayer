//! 控制路径专用的最小 SHA-256 实现（FIPS 180-4）。
//!
//! 该实现只服务于「外部 HRTF 资源注入」的完整性校验：对用户提供的 SOFA
//! 文件计算 SHA-256 并与资源描述符中的期望值比对。选择内置实现是为了避免
//! 为一条非实时的控制路径引入新的第三方依赖；算法完全按 FIPS 180-4 规范
//! 编写，并通过标准测试向量验证。
//!
//! 用途边界：
//! - 仅在非实时控制路径上调用（资源加载/验证），禁止进入实时音频线程；
//! - 不是通用加密原语，不承担密钥协商、签名等用途。

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const INITIAL_STATE: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/// 计算输入数据的 SHA-256 摘要（32 字节）。
pub fn digest(data: &[u8]) -> [u8; 32] {
    let mut state = INITIAL_STATE;
    let bit_length = (data.len() as u64).wrapping_mul(8);

    // 主循环处理所有完整的 64 字节分组。
    let mut chunks = data.chunks_exact(64);
    for chunk in &mut chunks {
        compress(
            &mut state,
            chunk.try_into().expect("chunk is exactly 64 bytes"),
        );
    }
    let remainder = chunks.remainder();

    // 填充：0x80、零字节、再拼接 64 位大端消息长度。
    let mut tail = [0u8; 128];
    tail[..remainder.len()].copy_from_slice(remainder);
    tail[remainder.len()] = 0x80;
    let tail_length = if remainder.len() + 9 <= 64 { 64 } else { 128 };
    tail[tail_length - 8..tail_length].copy_from_slice(&bit_length.to_be_bytes());
    for chunk in tail[..tail_length].chunks_exact(64) {
        compress(
            &mut state,
            chunk.try_into().expect("chunk is exactly 64 bytes"),
        );
    }

    let mut output = [0u8; 32];
    for (word, slot) in state.iter().zip(output.chunks_exact_mut(4)) {
        slot.copy_from_slice(&word.to_be_bytes());
    }
    output
}

/// 计算输入数据的 SHA-256 摘要并输出为小写十六进制字符串。
pub fn digest_hex(data: &[u8]) -> String {
    let digest = digest(data);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push(char::from_digit(u32::from(byte >> 4), 16).expect("nibble digit"));
        hex.push(char::from_digit(u32::from(byte & 0x0f), 16).expect("nibble digit"));
    }
    hex
}

fn compress(state: &mut [u32; 8], block: &[u8; 64]) {
    let mut w = [0u32; 64];
    // SHA-256 的消息调度按大端序读取 32 位字。
    for (word, chunk) in w.iter_mut().zip(block.chunks_exact(4)) {
        *word = u32::from_be_bytes(chunk.try_into().expect("chunk is exactly 4 bytes"));
    }
    for index in 16..64 {
        let s0 =
            w[index - 15].rotate_right(7) ^ w[index - 15].rotate_right(18) ^ (w[index - 15] >> 3);
        let s1 =
            w[index - 2].rotate_right(17) ^ w[index - 2].rotate_right(19) ^ (w[index - 2] >> 10);
        w[index] = w[index - 16]
            .wrapping_add(s0)
            .wrapping_add(w[index - 7])
            .wrapping_add(s1);
    }

    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
    for index in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let choose = (e & f) ^ ((!e) & g);
        let temp1 = h
            .wrapping_add(s1)
            .wrapping_add(choose)
            .wrapping_add(K[index])
            .wrapping_add(w[index]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let majority = (a & b) ^ (a & c) ^ (b & c);
        let temp2 = s0.wrapping_add(majority);

        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(temp1);
        d = c;
        c = b;
        b = a;
        a = temp1.wrapping_add(temp2);
    }

    state[0] = state[0].wrapping_add(a);
    state[1] = state[1].wrapping_add(b);
    state[2] = state[2].wrapping_add(c);
    state[3] = state[3].wrapping_add(d);
    state[4] = state[4].wrapping_add(e);
    state[5] = state[5].wrapping_add(f);
    state[6] = state[6].wrapping_add(g);
    state[7] = state[7].wrapping_add(h);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_fips_180_4_vectors() {
        assert_eq!(
            digest_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            digest_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            digest_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn handles_multi_block_and_boundary_lengths() {
        // 跨越多个分块且长度逼近分组边界的输入（55/56/64/65 字节）。
        let base = vec![b'a'; 1_000];
        let reference = digest_hex(&base);
        assert_eq!(reference.len(), 64);
        assert_ne!(digest_hex(&base[..999]), reference);
        assert_ne!(digest_hex(&base[..64]), digest_hex(&base[..65]));

        // 56 字节需要额外的填充分组（尾部消息长度放不进当前分组）。
        assert_ne!(digest_hex(&base[..55]), digest_hex(&base[..56]));

        // 一百万个 'a' 的标准向量，验证多分组累积正确性。
        let long = vec![b'a'; 1_000_000];
        assert_eq!(
            digest_hex(&long),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }
}
