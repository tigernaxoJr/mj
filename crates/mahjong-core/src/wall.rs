//! WP-1.1: 確定性洗牌、牌山游標（含鐵八墩/嶺上補牌）與 SHA-256 承諾雜湊驗證
use crate::tile::{TileId, TOTAL_TILES};
use serde::{Deserialize, Serialize};

pub const DEAD_WALL_SIZE: usize = 16; // 台灣麻將鐵八墩（海底留 16 張）

/// SHA-256（RustCrypto `sha2`，Wasm 與原生輸出一致）
pub fn sha256_bytes(input: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(input).into()
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
        // 跨區塊（FIPS 180-4 兩區塊向量）
        assert_eq!(
            sha256_hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
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
