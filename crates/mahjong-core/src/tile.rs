use serde::{Deserialize, Serialize};

/// 實體牌 ID：`0..=143`（共 144 張）
pub type TileId = u8;

/// 牌面種類 ID：`0..=41`（共 42 種）
/// - `0..=8`: 一萬 ~ 九萬
/// - `9..=17`: 一筒 ~ 九筒
/// - `18..=26`: 一條 ~ 九條
/// - `27..=30`: 東、南、西、北
/// - `31..=33`: 中、發、白
/// - `34..=41`: 春、夏、秋、冬、梅、蘭、竹、菊
pub type TileKind = u8;

pub const TOTAL_TILES: usize = 144;
pub const TOTAL_KINDS: usize = 42;
pub const NON_FLOWER_KINDS: usize = 34;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Suit {
    Character,
    Dot,
    Bamboo,
    Wind,
    Dragon,
    Flower,
}

#[inline]
pub const fn kind_of(tile_id: TileId) -> TileKind {
    if tile_id < 136 {
        tile_id / 4
    } else {
        34 + (tile_id - 136)
    }
}

#[inline]
pub const fn is_flower(kind: TileKind) -> bool {
    kind >= 34
}

#[inline]
pub const fn is_honor(kind: TileKind) -> bool {
    kind >= 27 && kind <= 33
}

#[inline]
pub const fn is_suited(kind: TileKind) -> bool {
    kind < 27
}

#[inline]
pub const fn suit_of(kind: TileKind) -> Suit {
    match kind {
        0..=8 => Suit::Character,
        9..=17 => Suit::Dot,
        18..=26 => Suit::Bamboo,
        27..=30 => Suit::Wind,
        31..=33 => Suit::Dragon,
        _ => Suit::Flower,
    }
}

/// 序數牌點數 `1..=9`，非序數牌回傳 `None`
#[inline]
pub const fn rank_of(kind: TileKind) -> Option<u8> {
    if kind < 27 {
        Some((kind % 9) + 1)
    } else {
        None
    }
}

/// 花牌對應門風編號 `0..=3`（東=0, 南=1, 西=2, 北=3）
#[inline]
pub const fn flower_seat(kind: TileKind) -> Option<u8> {
    if kind >= 34 && kind <= 41 {
        Some((kind - 34) % 4)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_encoding_invariants() {
        assert_eq!(kind_of(0), 0);
        assert_eq!(kind_of(3), 0);
        assert_eq!(kind_of(4), 1);
        assert_eq!(kind_of(135), 33);
        assert_eq!(kind_of(136), 34);
        assert_eq!(kind_of(143), 41);

        let mut counts = [0usize; TOTAL_KINDS];
        for id in 0..TOTAL_TILES as u8 {
            counts[kind_of(id) as usize] += 1;
        }
        for k in 0..NON_FLOWER_KINDS {
            assert_eq!(counts[k], 4);
        }
        for k in NON_FLOWER_KINDS..TOTAL_KINDS {
            assert_eq!(counts[k], 1);
            assert!(is_flower(k as u8));
        }
    }
}
