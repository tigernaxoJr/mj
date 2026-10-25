//! WP-1.1: 確定性洗牌、牌山游標（含鐵八墩/嶺上補牌）與承諾雜湊驗證
use crate::tile::{TileId, TOTAL_TILES};

pub const DEAD_WALL_SIZE: usize = 16; // 台灣麻將鐵八墩（海底留 16 張）

#[derive(Debug, Clone)]
pub struct Wall {
    pub tiles: [TileId; TOTAL_TILES],
    pub head_cursor: usize,
    pub tail_cursor: usize,
}

impl Wall {
    pub fn unshuffled() -> Self {
        let mut tiles = [0u8; TOTAL_TILES];
        for (i, slot) in tiles.iter_mut().enumerate() {
            *slot = i as u8;
        }
        Self {
            tiles,
            head_cursor: 0,
            tail_cursor: TOTAL_TILES,
        }
    }

    pub fn remaining_drawable(&self) -> usize {
        self.tail_cursor
            .saturating_sub(self.head_cursor)
            .saturating_sub(DEAD_WALL_SIZE)
    }
}
