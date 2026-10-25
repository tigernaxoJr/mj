//! WP-1.1: 確定性洗牌、牌山游標（含鐵八墩/嶺上補牌）與 SHA-256 承諾雜湊驗證
use crate::tile::{TileId, TOTAL_TILES};
use serde::{Deserialize, Serialize};

pub const DEAD_WALL_SIZE: usize = 16; // 台灣麻將鐵八墩（海底留 16 張）

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// 標準 FIPS 180-4 SHA-256 實作（零外部依賴，Wasm 與原生 100% 一致）
pub fn sha256_bytes(input: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    let bit_len = (input.len() as u64) * 8;
    let mut padded = input.to_vec();
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0x00);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

pub fn sha256_hex(input: &str) -> String {
    let bytes = sha256_bytes(input.as_bytes());
    let mut s = String::with_capacity(64);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for &b in &bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// SplitMix64 確定性亂數產生器
#[derive(Debug, Clone)]
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    pub fn from_seed_str(seed: &str) -> Self {
        let digest = sha256_bytes(seed.as_bytes());
        let state = u64::from_be_bytes([
            digest[0], digest[1], digest[2], digest[3],
            digest[4], digest[5], digest[6], digest[7],
        ]);
        Self { state }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }

    pub fn gen_range(&mut self, upper_exclusive: usize) -> usize {
        if upper_exclusive <= 1 {
            return 0;
        }
        (self.next_u64() as usize) % upper_exclusive
    }
}

/// 計算單張牌山位置的承諾雜湊：`SHA256("{index}|{tile_id}|{salt}")`
pub fn compute_tile_leaf_hash(wall_index: usize, tile_id: TileId, salt: &str) -> String {
    let payload = format!("{wall_index}|{tile_id}|{salt}");
    sha256_hex(&payload)
}

/// 驗證收到的私密摸牌是否符合開局鎖定的葉子雜湊
pub fn verify_tile_leaf(
    wall_index: usize,
    tile_id: TileId,
    salt: &str,
    expected_leaf_hash: &str,
) -> bool {
    compute_tile_leaf_hash(wall_index, tile_id, salt) == expected_leaf_hash
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Wall {
    pub tiles: Vec<TileId>,
    pub head_cursor: usize,
    pub tail_cursor: usize,
}

impl Wall {
    pub fn unshuffled() -> Self {
        let tiles = (0..TOTAL_TILES as u8).collect();
        Self {
            tiles,
            head_cursor: 0,
            tail_cursor: TOTAL_TILES,
        }
    }

    /// 以種子確定性洗出 144 張牌山（Fisher-Yates）
    pub fn from_seed(seed: &str) -> Self {
        let mut wall = Self::unshuffled();
        let mut rng = SplitMix64::from_seed_str(seed);
        for i in (1..TOTAL_TILES).rev() {
            let j = rng.gen_range(i + 1);
            wall.tiles.swap(i, j);
        }
        wall
    }

    /// 依 `round_seed` 與 `host_secret` 派生整座牌山與 144 組鹽值與葉子雜湊
    pub fn create_committed_wall(
        round_seed: &str,
        host_secret: &str,
    ) -> (Self, Vec<String>, Vec<String>) {
        let combined_seed = sha256_hex(&format!("{round_seed}|{host_secret}"));
        let wall = Self::from_seed(&combined_seed);
        let mut salts = Vec::with_capacity(TOTAL_TILES);
        let mut leaves = Vec::with_capacity(TOTAL_TILES);
        for (idx, &tile_id) in wall.tiles.iter().enumerate() {
            let salt = sha256_hex(&format!("{combined_seed}|salt|{idx}"))[..32].to_string();
            let leaf = compute_tile_leaf_hash(idx, tile_id, &salt);
            salts.push(salt);
            leaves.push(leaf);
        }
        (wall, salts, leaves)
    }

    /// 扣除鐵八墩（16 張）後尚可摸牌的張數
    pub fn remaining_drawable(&self) -> usize {
        self.tail_cursor
            .saturating_sub(self.head_cursor)
            .saturating_sub(DEAD_WALL_SIZE)
    }

    /// 牌山實體剩餘總張數（含鐵八墩 16 張）
    pub fn remaining_total(&self) -> usize {
        self.tail_cursor.saturating_sub(self.head_cursor)
    }

    /// 從牌山正面摸一張牌（回傳 `(wall_index, tile_id)`）
    pub fn draw_head(&mut self) -> Option<(usize, TileId)> {
        if self.remaining_drawable() == 0 {
            return None;
        }
        let idx = self.head_cursor;
        let tile = self.tiles[idx];
        self.head_cursor += 1;
        Some((idx, tile))
    }

    /// 從牌山嶺上（尾部）補一張牌（用於補花與槓上補牌，回傳 `(wall_index, tile_id)`）
    pub fn draw_tail(&mut self) -> Option<(usize, TileId)> {
        if self.remaining_drawable() == 0 {
            return None;
        }
        self.tail_cursor -= 1;
        let idx = self.tail_cursor;
        let tile = self.tiles[idx];
        Some((idx, tile))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_standard_vector() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn deterministic_wall_and_dead_wall_limit() {
        let (mut w1, salts, leaves) = Wall::create_committed_wall("seed-123", "host-xyz");
        let (w2, _, _) = Wall::create_committed_wall("seed-123", "host-xyz");
        assert_eq!(w1.tiles, w2.tiles);
        assert_eq!(w1.remaining_total(), 144);
        assert_eq!(w1.remaining_drawable(), 128);

        for idx in 0..144 {
            assert!(verify_tile_leaf(idx, w1.tiles[idx], &salts[idx], &leaves[idx]));
            assert!(!verify_tile_leaf(idx, w1.tiles[idx] ^ 1, &salts[idx], &leaves[idx]));
        }

        // 摸光 128 張後應觸發鐵八墩（剩 16 張不可再摸）
        for i in 0..128 {
            let drawn = w1.draw_head();
            assert!(drawn.is_some(), "draw {i} should succeed");
        }
        assert_eq!(w1.remaining_drawable(), 0);
        assert_eq!(w1.remaining_total(), 16);
        assert_eq!(w1.draw_head(), None);
        assert_eq!(w1.draw_tail(), None);
    }
}
